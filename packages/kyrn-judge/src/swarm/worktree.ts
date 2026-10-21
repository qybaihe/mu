import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type GitProbe,
	type GitUnusable,
	type GitUnusableReason,
	heldByLicense,
	hostProbe,
	stubProblem,
	UNUSABLE_TEXT,
} from "../checkpoint/git.ts";

/**
 * An isolated checkout for one sub-agent that edits files.
 *
 * Problem: a worker edits in the parent's working directory, so two workers
 * collide with each other and with the parent, and a bad one leaves a mess.
 * Here a worker gets `git worktree add -b mu/agent-<id> <temp dir> HEAD` with
 * the parent's uncommitted state carried over, and what it changed comes back
 * as ONE patch against that starting point. The checkout and its branch are
 * removed afterwards, always; what a crash leaves behind is found by a marker
 * file next to the checkout and swept at the next session start.
 *
 * Nothing here touches the user's index, stash or branches other than the
 * `mu/agent-*` one it made. Git runs through an injected function, without a
 * shell, and its output is handled as bytes: a patch may hold any encoding.
 */

export interface GitResult {
	/** Exit code; -1 when git could not be started at all. */
	code: number;
	stdout: Buffer;
	stderr: string;
	/** The `git` executable was not found, or cannot run (`unusable`). */
	missing?: boolean;
	/** git is there and cannot run on this Mac: it was never started, or the Xcode license held it back. */
	unusable?: GitUnusableReason;
}

export interface GitRunOptions {
	cwd: string;
	input?: Buffer;
	/** Added to the environment of this call, e.g. `GIT_INDEX_FILE`. */
	env?: Readonly<Record<string, string>>;
	signal?: AbortSignal;
}

export type GitRun = (args: readonly string[], options: GitRunOptions) => Promise<GitResult>;

/**
 * Settings every call needs, whatever the user configured:
 * - `core.safecrlf=false`: with `true`, hashing a CRLF file is FATAL under autocrlf, which would break
 *   `add -A` and the scratch index. `core.autocrlf` itself is left alone on purpose: both ends of a patch
 *   run in the same repository, so its own conversion is applied consistently, and forcing it off on one
 *   side is what would corrupt line endings.
 * - `core.quotepath=false`: paths come back as they are, not as octal escapes.
 * - `core.hooksPath`: the user's post-checkout hook must not run for a checkout they did not make.
 * - `core.longpaths` on Windows: a temp checkout sits deeper than the 260 characters of MAX_PATH allow.
 */
export function gitArgs(args: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
	return [
		"-c",
		"core.safecrlf=false",
		"-c",
		"core.quotepath=false",
		"-c",
		"core.hooksPath=.mu-no-hooks",
		...(platform === "win32" ? ["-c", "core.longpaths=true"] : []),
		...args,
	];
}

/** Variables that would point git at another repository or index than the one in `cwd`. */
const INHERITED = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

const spawnGit: GitRun = (args, options) =>
	new Promise((resolve) => {
		const env: Record<string, string | undefined> = { ...process.env };
		for (const name of INHERITED) delete env[name];
		// Messages are shown to a model and compared in tests: never localized, never a prompt.
		Object.assign(env, { LC_ALL: "C", LANGUAGE: "C", GIT_TERMINAL_PROMPT: "0" }, options.env);
		const out: Buffer[] = [];
		let stderr = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("git", gitArgs(args), {
				cwd: options.cwd,
				env,
				shell: false,
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
				signal: options.signal,
			});
		} catch (error) {
			resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(error), missing: true });
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-8000);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			resolve({ code: -1, stdout: Buffer.concat(out), stderr: error.message, missing: error.code === "ENOENT" });
		});
		child.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr }));
		// A closed stdin is not an error worth a crash: git may exit before it has read everything.
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(options.input);
	});

/**
 * Runs git without a shell. On a Mac whose git is the system's stub with no developer tools behind it, git is never
 * started, since each start opens their install dialog; that answer, and one held back by the Xcode license, say so.
 */
export function gitRunner(probe: GitProbe = hostProbe): GitRun {
	let stub: Promise<GitUnusable | undefined> | undefined;
	return async (args, options) => {
		stub ??= stubProblem("git", options.env?.PATH ?? process.env.PATH, probe);
		const problem = await stub;
		if (problem)
			return { code: -1, stdout: Buffer.alloc(0), stderr: problem.message, missing: true, unusable: problem.reason };
		const result = await spawnGit(args, options);
		return heldByLicense(result.code, () => `${result.stderr}\n${result.stdout.toString("utf8")}`)
			? { ...result, missing: true, unusable: "xcode_license" }
			: result;
	};
}

export const runGit: GitRun = gitRunner();

const text = (result: GitResult): string => result.stdout.toString("utf8");
const lastLine = (stderr: string): string => stderr.trim().split("\n").pop()?.trim() ?? "";

export type RepoProblem = "no-git" | "not-a-repo" | "bare" | "no-commit" | "busy";

export interface Repo {
	/** Top of the working tree that `cwd` is in. */
	root: string;
	/** `cwd` relative to `root`, with a trailing slash, or "". */
	prefix: string;
	/** This working tree's own git directory (a linked worktree has its own). */
	gitDir: string;
	head: string;
}

export type RepoCheck = { ok: true; repo: Repo } | { ok: false; problem: RepoProblem; message: string };

/** Operations that leave the working tree half way somewhere: a patch made or applied then would mislead everyone. */
const BUSY: readonly (readonly [string, string])[] = [
	["rebase-merge", "a rebase"],
	["rebase-apply", "a rebase or git am"],
	["MERGE_HEAD", "a merge"],
	["CHERRY_PICK_HEAD", "a cherry-pick"],
	["REVERT_HEAD", "a revert"],
	["BISECT_LOG", "a bisect"],
];

/** Whether `cwd` is somewhere a worktree can be made from, and if not, why, in words for the model. */
export async function checkRepo(run: GitRun, cwd: string): Promise<RepoCheck> {
	const probe = await run(["rev-parse", "--is-bare-repository", "--is-inside-work-tree"], { cwd });
	if (probe.unusable) return { ok: false, problem: "no-git", message: UNUSABLE_TEXT[probe.unusable] };
	if (probe.missing) return { ok: false, problem: "no-git", message: "git is not installed or not on PATH" };
	if (probe.code !== 0)
		return { ok: false, problem: "not-a-repo", message: "this directory is not in a git repository" };
	const [bare, inside] = text(probe).trim().split("\n");
	if (bare === "true") return { ok: false, problem: "bare", message: "this is a bare repository" };
	if (inside !== "true") return { ok: false, problem: "not-a-repo", message: "this directory is inside .git" };

	const where = await run(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--show-prefix"], { cwd });
	const head = await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd });
	if (where.code !== 0) return { ok: false, problem: "not-a-repo", message: lastLine(where.stderr) };
	if (head.code !== 0) return { ok: false, problem: "no-commit", message: "the repository has no commits yet" };
	const [root, gitDir, prefix = ""] = text(where).replace(/\n$/, "").split("\n");
	const busy = BUSY.find(([name]) => existsSync(join(gitDir, name)));
	if (busy) return { ok: false, problem: "busy", message: `${busy[1]} is in progress in this repository` };
	return { ok: true, repo: { root, gitDir, prefix, head: text(head).trim() } };
}

/** Everything needed to take a worktree down again. Plain data: it is also what the marker file holds. */
export interface Worktree {
	repoRoot: string;
	dir: string;
	branch: string;
	/** Tree id of the starting point: HEAD plus what was carried over. The patch is taken against it. */
	base: string;
	/** Where the sub-agent starts: `dir` plus the parent's position inside the repository. */
	cwd: string;
}

export interface CarryReport {
	/** The parent had uncommitted changes to tracked files, and the worktree has them too. */
	tracked: boolean;
	untracked: number;
	/** Untracked files left behind because of their size. */
	skipped: string[];
}

export interface CreateOptions {
	repo: Repo;
	/** Must not exist yet, and must be outside the repository. */
	dir: string;
	branch: string;
	/** Bring the parent's uncommitted state along. */
	carry: boolean;
	/** Untracked files above this many bytes stay behind. */
	maxUntrackedBytes?: number;
	signal?: AbortSignal;
}

export type CreateResult = { ok: true; worktree: Worktree; carried: CarryReport } | { ok: false; message: string };

const DIFF_SHAPE = [
	"--binary",
	"--full-index",
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--src-prefix=a/",
	"--dst-prefix=b/",
	"--ignore-submodules=all",
];
/** Line endings are data here: never "fixed", and not worth a warning each. */
const APPLY_SHAPE = ["--whitespace=nowarn"];

export function splitZ(buffer: Buffer): string[] {
	return buffer.toString("utf8").split("\0").filter(Boolean);
}

async function copyUntracked(
	from: string,
	to: string,
	paths: readonly string[],
	maxBytes: number,
): Promise<CarryReport> {
	const report: CarryReport = { tracked: false, untracked: 0, skipped: [] };
	for (const path of paths) {
		// A directory entry is a repository inside the repository: not ours to copy.
		if (path.endsWith("/")) continue;
		try {
			const stat = await lstat(join(from, path));
			await mkdir(dirname(join(to, path)), { recursive: true });
			if (stat.isSymbolicLink()) await symlink(await readlink(join(from, path)), join(to, path));
			else if (!stat.isFile()) continue;
			else if (stat.size > maxBytes) {
				report.skipped.push(path);
				continue;
			} else await copyFile(join(from, path), join(to, path));
			report.untracked++;
		} catch {
			report.skipped.push(path);
		}
	}
	return report;
}

export async function createWorktree(run: GitRun, options: CreateOptions): Promise<CreateResult> {
	const { repo, dir, branch, signal } = options;
	const added = await run(["worktree", "add", "-b", branch, dir, repo.head], { cwd: repo.root, signal });
	if (added.code !== 0) return { ok: false, message: `git worktree add failed: ${lastLine(added.stderr)}` };
	const worktree: Worktree = { repoRoot: repo.root, dir, branch, base: "", cwd: join(dir, repo.prefix) };
	const fail = async (message: string): Promise<CreateResult> => {
		await removeWorktree(run, worktree);
		return { ok: false, message };
	};

	let carried: CarryReport = { tracked: false, untracked: 0, skipped: [] };
	if (options.carry) {
		const changes = await run(["diff", ...DIFF_SHAPE, "HEAD"], { cwd: repo.root, signal });
		if (changes.code !== 0) return fail(`reading the uncommitted changes failed: ${lastLine(changes.stderr)}`);
		if (changes.stdout.length > 0) {
			const applied = await run(["apply", ...APPLY_SHAPE, "-"], { cwd: dir, input: changes.stdout, signal });
			if (applied.code !== 0)
				return fail(`carrying the uncommitted changes over failed: ${lastLine(applied.stderr)}`);
		}
		const others = await run(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repo.root, signal });
		if (others.code !== 0) return fail(`listing untracked files failed: ${lastLine(others.stderr)}`);
		carried = await copyUntracked(
			repo.root,
			dir,
			splitZ(others.stdout),
			options.maxUntrackedBytes ?? 10 * 1024 * 1024,
		);
		carried.tracked = changes.stdout.length > 0;
	}

	// The starting point as a tree, not a commit: no hooks, no identity, no signing. The index then goes back
	// to HEAD, so the sub-agent sees the parent's changes as uncommitted, the way the parent does.
	const staged = await run(["add", "-A"], { cwd: dir, signal });
	const tree = staged.code === 0 ? await run(["write-tree"], { cwd: dir, signal }) : staged;
	if (tree.code !== 0) return fail(`recording the starting point failed: ${lastLine(tree.stderr)}`);
	await run(["reset", "-q"], { cwd: dir, signal });
	worktree.base = text(tree).trim();
	await mkdir(worktree.cwd, { recursive: true });
	return { ok: true, worktree, carried };
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

export interface PatchFile {
	path: string;
	/** Set for a rename or a copy. */
	from?: string;
	status: FileStatus;
	insertions: number;
	deletions: number;
	binary: boolean;
}

export interface PatchSummary {
	files: PatchFile[];
	insertions: number;
	deletions: number;
}

const STATUS: Readonly<Record<string, FileStatus>> = {
	A: "added",
	M: "modified",
	D: "deleted",
	R: "renamed",
	C: "copied",
	T: "type-changed",
};

/** `--name-status -z`: "M\0path\0", and "R100\0old\0new\0" for a rename or copy. */
export function parseNameStatus(fields: readonly string[]): { path: string; from?: string; status: FileStatus }[] {
	const rows: { path: string; from?: string; status: FileStatus }[] = [];
	for (let index = 0; index < fields.length; ) {
		const status = STATUS[fields[index][0]] ?? "modified";
		const two = status === "renamed" || status === "copied";
		rows.push(
			two ? { status, from: fields[index + 1], path: fields[index + 2] } : { status, path: fields[index + 1] },
		);
		index += two ? 3 : 2;
	}
	return rows;
}

/** `--numstat -z`: "3\t1\tpath\0", "-\t-\tpath\0" for binary, and "0\t0\t\0old\0new\0" for a rename. */
export function parseNumstat(
	fields: readonly string[],
): Map<string, { insertions: number; deletions: number; binary: boolean }> {
	const counts = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
	for (let index = 0; index < fields.length; index++) {
		const [added, removed, path] = fields[index].split("\t");
		const renamed = path === "" || path === undefined;
		const target = renamed ? fields[index + 2] : path;
		if (renamed) index += 2;
		if (target === undefined) continue;
		counts.set(target, {
			insertions: Number.parseInt(added, 10) || 0,
			deletions: Number.parseInt(removed, 10) || 0,
			binary: added === "-",
		});
	}
	return counts;
}

export type CollectResult = { ok: true; patch: Buffer; summary: PatchSummary } | { ok: false; message: string };

/**
 * What the sub-agent changed, as one patch against the starting point: new, deleted, renamed and binary files
 * included, ignored files left out. Whether it committed on its branch or not makes no difference.
 */
export async function collectPatch(run: GitRun, worktree: Worktree, signal?: AbortSignal): Promise<CollectResult> {
	const cwd = worktree.dir;
	const staged = await run(["add", "-A"], { cwd, signal });
	if (staged.code !== 0) return { ok: false, message: `git add failed: ${lastLine(staged.stderr)}` };
	const diff = (shape: readonly string[]) => run(["diff", "--cached", "-M", ...shape, worktree.base], { cwd, signal });
	const [patch, names, counts] = await Promise.all([
		diff(DIFF_SHAPE),
		diff(["--name-status", "-z", "--ignore-submodules=all"]),
		diff(["--numstat", "-z", "--ignore-submodules=all"]),
	]);
	const failed = [patch, names, counts].find((result) => result.code !== 0);
	if (failed) return { ok: false, message: `git diff failed: ${lastLine(failed.stderr)}` };
	const numbers = parseNumstat(counts.stdout.toString("utf8").split("\0"));
	const files = parseNameStatus(splitZ(names.stdout)).map((row) => ({
		...row,
		insertions: numbers.get(row.path)?.insertions ?? 0,
		deletions: numbers.get(row.path)?.deletions ?? 0,
		binary: numbers.get(row.path)?.binary ?? false,
	}));
	return {
		ok: true,
		patch: patch.stdout,
		summary: {
			files,
			insertions: files.reduce((sum, file) => sum + file.insertions, 0),
			deletions: files.reduce((sum, file) => sum + file.deletions, 0),
		},
	};
}

/** "3 files changed, +40 -2" */
export function describeSummary(summary: PatchSummary): string {
	const count = summary.files.length;
	return `${count} file${count === 1 ? "" : "s"} changed, +${summary.insertions} -${summary.deletions}`;
}

/**
 * Takes the checkout and its branch away. Works on one that is half gone already (a directory somebody
 * deleted, a registration git forgot), because that is what a crash leaves. Returns what could not be undone.
 */
export async function removeWorktree(
	run: GitRun,
	worktree: Pick<Worktree, "repoRoot" | "dir" | "branch">,
): Promise<string[]> {
	const problems: string[] = [];
	const cwd = worktree.repoRoot;
	let removed = await run(["worktree", "remove", "--force", worktree.dir], { cwd });
	if (removed.code !== 0 || existsSync(worktree.dir)) {
		// A file held open (Windows), or a registration that is gone: take the directory, then let git forget it.
		await rm(worktree.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => undefined);
		removed = await run(["worktree", "remove", "--force", worktree.dir], { cwd });
		// Older gits refuse a directory that is gone; pruning is how they forget it.
		if (removed.code !== 0) await run(["worktree", "prune"], { cwd });
		if (existsSync(worktree.dir)) problems.push(`could not delete ${worktree.dir}`);
	}
	const listed = await run(["branch", "--list", worktree.branch], { cwd });
	if (text(listed).trim()) {
		const deleted = await run(["branch", "-D", worktree.branch], { cwd });
		if (deleted.code !== 0) problems.push(`could not delete branch ${worktree.branch}: ${lastLine(deleted.stderr)}`);
	}
	return problems;
}

/** Written next to a checkout before it is made, so that whoever finds it later knows whose it is. */
export interface Marker extends Pick<Worktree, "repoRoot" | "dir" | "branch"> {
	pid: number;
	createdAt: number;
	/** Its owner is done with it; only the removal failed. Anyone may finish the job. */
	released?: boolean;
}

export const markerPath = (dir: string): string => `${dir}.json`;

export async function writeMarker(marker: Marker): Promise<void> {
	await mkdir(dirname(marker.dir), { recursive: true });
	// Source code is about to be checked out below here: on a shared /tmp that is nobody else's business.
	await chmod(dirname(marker.dir), 0o700).catch(() => undefined);
	await writeFile(markerPath(marker.dir), JSON.stringify(marker), { mode: 0o600 });
}

export const RUN_DIR = /^kyrn-swarm-[\w-]+$/;
const MARKER = /^w\d+\.json$/;

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists and belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface SweepOptions {
	/** Where run directories live: the system temp directory. */
	area: string;
	isAlive?: (pid: number) => boolean;
	now?: number;
	/** A checkout older than this is stale even if its pid is in use: pids are recycled, above all by a reboot. */
	maxAgeMs?: number;
}

/**
 * Removes what dead sessions left behind: every marker under `area` whose owner is gone. It reads markers,
 * not `git worktree list`, so it only ever touches checkouts mu made, in whichever repository they are.
 */
export async function sweepStaleWorktrees(run: GitRun, options: SweepOptions): Promise<Marker[]> {
	const alive = options.isAlive ?? isAlive;
	const now = options.now ?? Date.now();
	const maxAge = options.maxAgeMs ?? 24 * 3600_000;
	const swept: Marker[] = [];
	const runs = await readdir(options.area).catch(() => [] as string[]);
	for (const name of runs.filter((entry) => RUN_DIR.test(entry))) {
		const entries = await readdir(join(options.area, name)).catch(() => [] as string[]);
		for (const file of entries.filter((entry) => MARKER.test(entry))) {
			const path = join(options.area, name, file);
			let marker: Marker;
			try {
				marker = JSON.parse(await readFile(path, "utf8")) as Marker;
			} catch {
				continue;
			}
			// Only what the marker sits next to: a marker cannot send the sweep anywhere else.
			if (markerPath(marker.dir) !== path || typeof marker.repoRoot !== "string") continue;
			const stale = marker.released || !alive(marker.pid) || now - marker.createdAt > maxAge;
			if (!stale) continue;
			if (existsSync(marker.repoRoot)) await removeWorktree(run, marker);
			else await rm(marker.dir, { recursive: true, force: true }).catch(() => undefined);
			if (!existsSync(marker.dir)) {
				await rm(path, { force: true }).catch(() => undefined);
				swept.push(marker);
			}
		}
	}
	return swept;
}
