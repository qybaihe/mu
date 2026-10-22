import { spawn } from "node:child_process";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { createTar, type TarEntry } from "./tar.ts";

const gzipAsync = promisify(gzip);

export interface CommandResult {
	readonly code: number;
	readonly stdout: Buffer;
	readonly stderr: string;
}

/** Runs git without a shell. A git that cannot start is exit code 127, as a shell would say. */
export function runGit(args: readonly string[], cwd: string, input?: Uint8Array): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn("git", args, {
			cwd,
			stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
			env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error) => resolve({ code: 127, stdout: Buffer.alloc(0), stderr: error.message }));
		child.on("close", (code) =>
			resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }),
		);
		if (input) {
			child.stdin?.on("error", () => undefined);
			child.stdin?.end(input);
		}
	});
}

/** Folders a walk of a folder that is not a git repository leaves out. */
const WALK_SKIP: ReadonlySet<string> = new Set([".git", "node_modules"]);

async function walk(root: string, dir: string, found: string[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!WALK_SKIP.has(entry.name)) await walk(root, join(dir, entry.name), found);
		} else if (entry.isFile() || entry.isSymbolicLink()) {
			found.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
		}
	}
}

/**
 * The files that make up the project: in a git repository what git tracks plus the untracked files it
 * does not ignore (`git ls-files -co --exclude-standard`), elsewhere every file below `cwd` except
 * `.git` and `node_modules`.
 */
export async function projectFiles(cwd: string): Promise<{ files: string[]; fromGit: boolean }> {
	const listed = await runGit(["ls-files", "-co", "--exclude-standard", "-z"], cwd);
	if (listed.code === 0) {
		const files = [...new Set(listed.stdout.toString("utf8").split("\0").filter(Boolean))];
		return { files, fromGit: true };
	}
	const files: string[] = [];
	await walk(cwd, cwd, files);
	return { files, fromGit: false };
}

export class ProjectTooLarge extends Error {
	constructor(bytes: number, maxBytes: number) {
		const mb = (value: number) => (value / 1024 / 1024).toFixed(1);
		super(
			`The project holds more than ${mb(maxBytes)} MB of files (at least ${mb(bytes)} MB), over the sandbox seeding limit (features.sandbox.maxSeedMB).`,
		);
		this.name = "ProjectTooLarge";
	}
}

export interface SeedArchive {
	/** A gzipped tar of the project, paths relative to its root. */
	readonly archive: Buffer;
	readonly files: number;
	readonly bytes: number;
	readonly fromGit: boolean;
}

/** The project as a gzipped tar. Files that vanished since they were listed, and submodules, are left out. */
export async function seedArchive(cwd: string, maxBytes: number): Promise<SeedArchive> {
	const { files, fromGit } = await projectFiles(cwd);
	const entries: TarEntry[] = [];
	let bytes = 0;
	for (const path of files) {
		const absolute = join(cwd, path);
		const stat = await lstat(absolute).catch(() => undefined);
		if (!stat) continue;
		const mtime = Math.floor(stat.mtimeMs / 1000);
		if (stat.isSymbolicLink()) {
			// Windows hands back a link's target with its own separator; the sandbox is Linux.
			const target = await readlink(absolute);
			entries.push({ path, mode: 0o777, mtime, linkTarget: sep === "\\" ? target.split(sep).join("/") : target });
		} else if (stat.isFile()) {
			bytes += stat.size;
			if (bytes > maxBytes) throw new ProjectTooLarge(bytes, maxBytes);
			entries.push({ path, mode: stat.mode & 0o111 ? 0o755 : 0o644, mtime, data: await readFile(absolute) });
		}
	}
	return { archive: await gzipAsync(createTar(entries)), files: entries.length, bytes, fromGit };
}

export interface FileStat {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	readonly binary: boolean;
}

/** What a git patch changes, file by file, read from the patch itself. */
export function diffstat(patch: string): FileStat[] {
	const stats: { path: string; added: number; removed: number; binary: boolean }[] = [];
	let current: (typeof stats)[number] | undefined;
	let inHunk = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const paths = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
			current = { path: paths?.[2] ?? line.slice(11), added: 0, removed: 0, binary: false };
			stats.push(current);
			inHunk = false;
			continue;
		}
		if (!current) continue;
		if (line.startsWith("GIT binary patch") || /^Binary files .* differ$/.test(line)) {
			current.binary = true;
		} else if (line.startsWith("@@")) {
			inHunk = true;
		} else if (inHunk && line.startsWith("+")) {
			current.added++;
		} else if (inHunk && line.startsWith("-")) {
			current.removed++;
		}
	}
	return stats;
}

/** `git diff --stat` as a person reads it. */
export function formatDiffstat(stats: readonly FileStat[]): string {
	if (stats.length === 0) return "No changes.";
	const width = Math.min(60, Math.max(...stats.map((stat) => stat.path.length)));
	const lines = stats.map((stat) => {
		const counts = stat.binary
			? "Bin"
			: `${stat.added + stat.removed} ${"+".repeat(Math.min(stat.added, 30))}${"-".repeat(Math.min(stat.removed, 30))}`;
		return ` ${stat.path.padEnd(width)} | ${counts}`;
	});
	const added = stats.reduce((sum, stat) => sum + stat.added, 0);
	const removed = stats.reduce((sum, stat) => sum + stat.removed, 0);
	const files = `${stats.length} file${stats.length === 1 ? "" : "s"} changed`;
	return [
		...lines,
		` ${files}, ${added} insertion${added === 1 ? "" : "s"}(+), ${removed} deletion${removed === 1 ? "" : "s"}(-)`,
	].join("\n");
}

export type ApplyOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Applies a git patch whose paths are relative to `cwd`, all or nothing: `git apply --check` first, so a
 * patch that does not fit (a file changed here since the sandbox was seeded) changes no file at all. The
 * index is never touched. Works outside a git repository too, where git acts as `patch`.
 */
export async function applyPatchLocally(cwd: string, patch: Uint8Array): Promise<ApplyOutcome> {
	// Inside a repository git reads patch paths from the top of the working tree; the patch's are from `cwd`.
	const prefix = await runGit(["rev-parse", "--show-prefix"], cwd);
	const directory = prefix.code === 0 ? prefix.stdout.toString("utf8").trim() : "";
	const shape = ["--whitespace=nowarn", ...(directory ? [`--directory=${directory}`] : []), "-"];
	const check = await runGit(["apply", "--check", ...shape], cwd, patch);
	if (check.code !== 0) return { ok: false, reason: check.stderr.trim().split("\n").slice(0, 10).join("\n") };
	const applied = await runGit(["apply", ...shape], cwd, patch);
	if (applied.code !== 0) return { ok: false, reason: applied.stderr.trim().split("\n").slice(0, 10).join("\n") };
	return { ok: true };
}
