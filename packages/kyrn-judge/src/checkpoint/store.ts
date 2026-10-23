/**
 * Snapshots of a project's working tree that never touch the project's own repository.
 *
 * Each project gets a SHADOW git directory under the mu home. Every command runs with `GIT_DIR`,
 * `GIT_WORK_TREE` and `GIT_INDEX_FILE` pointing into it (see `shadowEnv`), so the user's `.git` (index,
 * HEAD, stash, hooks, refs) is never read for writing, and a folder that is no repository at all works
 * the same way. git never adds a path with a `.git` component, so the real repository is not copied either.
 *
 * What goes into a snapshot: everything the project's `.gitignore` does not ignore, minus a built-in
 * list of heavy folders and secret files, minus mu's own folders (the snapshots themselves among them)
 * and minus files over a size cap. What a restore may touch follows from that: only paths that are in
 * one of the two trees it compares. An ignored or oversized file is in neither, so it is never
 * overwritten and never deleted.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	accessSync,
	appendFileSync,
	chmodSync,
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { GitFailed, type GitRun, shadowEnv, TIMED_OUT } from "./git.ts";

/**
 * Ignored even when the project does not ignore them: folders that are practically never source and are
 * expensive to copy, and files that hold secrets. A snapshot is a second copy of every file it takes in,
 * kept for days, so a key file is not one of them; a restore leaves such a file as it finds it.
 */
export const BUILT_IN_IGNORES: readonly string[] = [
	"node_modules/",
	"bower_components/",
	".pnpm-store/",
	".yarn/cache/",
	".venv/",
	"venv/",
	"__pycache__/",
	".mypy_cache/",
	".pytest_cache/",
	".ruff_cache/",
	".tox/",
	"dist/",
	"build/",
	"out/",
	"target/",
	"coverage/",
	".next/",
	".nuxt/",
	".turbo/",
	".cache/",
	".parcel-cache/",
	".gradle/",
	".terraform/",
	"Pods/",
	"DerivedData/",
	".dart_tool/",
	".DS_Store",
	"Thumbs.db",
	"*.env",
	".env.*",
	"!.env.example",
	"!.env.sample",
	"!.env.template",
	".envrc",
	".netrc",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
];

const CONFIG_MARKER = "# mu checkpoint settings";
/**
 * Repository-level settings beat the user's global and system ones. Line endings and filters are
 * switched off so a restore is byte for byte what was there; no hook can ever run; nothing collects
 * garbage behind a running snapshot.
 */
const shadowConfig = (gitDir: string): string => `${CONFIG_MARKER}
[core]
	autocrlf = false
	safecrlf = false
	longpaths = true
	quotepath = false
	fsmonitor = false
	hooksPath = "${join(gitDir, "mu-no-hooks").replaceAll("\\", "/").replaceAll('"', '\\"')}"
[gc]
	auto = 0
[commit]
	gpgsign = false
`;
/** `info/attributes` outranks every `.gitattributes`: no text conversion, no clean/smudge filter (LFS), no re-encoding. */
const SHADOW_ATTRIBUTES = "* -text -filter -ident -working-tree-encoding\n";
const PROJECT_FILE = "mu-project.json";
const REF_PREFIX = "refs/mu/";
/** More ignored entries than this are not written down; such a checkpoint then never deletes a file. */
const MAX_EXCLUDED = 5000;
const STALE_LOCK_MS = 120_000;

export interface StoreOptions {
	/** Holds one shadow repository per project, e.g. `<agentDir>/mu/checkpoints`. */
	readonly baseDir: string;
	/** The project folder: the work tree that is snapshotted. */
	readonly root: string;
	readonly run: GitRun;
	/** The environment to derive the shadow environment from. Default: `process.env`. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Files larger than this are left out of snapshots, and left alone by restores. */
	readonly maxFileBytes?: number;
	/** gitignore-style patterns on top of the project's own ignore rules. Default: `BUILT_IN_IGNORES`. */
	readonly ignore?: readonly string[];
	/**
	 * Folders never snapshotted wherever they are, e.g. mu's home and pi's agent folder: they hold the
	 * snapshots, sessions and credentials. `baseDir` is always one of them.
	 */
	readonly ownFolders?: readonly string[];
}

/** What one scan may take in: files it would add or update, and their bytes. Past either, nothing is written. */
export interface ScanLimits {
	readonly maxFiles: number;
	readonly maxBytes: number;
}

/** A scan past its `ScanLimits`, or one whose listing outlived the git time limit (`slow`). Nothing was written. */
export class SnapshotTooLarge extends Error {
	readonly reason: "files" | "bytes" | "slow";
	constructor(reason: "files" | "bytes" | "slow", limits: ScanLimits) {
		super(
			reason === "files"
				? `more than ${limits.maxFiles} files to snapshot`
				: reason === "bytes"
					? `more than ${Math.round(limits.maxBytes / 1024 / 1024)} MB to snapshot`
					: "listing the files to snapshot took too long",
		);
		this.name = "SnapshotTooLarge";
		this.reason = reason;
	}
}

export interface Store {
	readonly gitDir: string;
	readonly root: string;
	readonly run: GitRun;
	readonly env: Record<string, string>;
	readonly maxFileBytes: number;
}

/** What existed at snapshot time but is not in the snapshot. A restore must not mistake these for files created since. */
interface SnapshotMeta {
	/** Ignored, too large, unreadable, or a nested repository. An entry ending in "/" stands for everything under it. */
	readonly excluded: readonly string[];
	readonly overflow?: boolean;
}

export interface Snapshot {
	readonly commit: string;
	readonly tree: string;
}

export type ChangeStatus = "added" | "deleted" | "modified";
export interface Change {
	readonly path: string;
	/** Relative to the direction asked for: `added` means present in `to` and absent in `from`. */
	readonly status: ChangeStatus;
}

export interface RestorePlan {
	readonly commit: string;
	/** Changed since the snapshot: their content goes back. */
	readonly restore: readonly string[];
	/** Created since the snapshot: they are removed. */
	readonly remove: readonly string[];
	/** Deleted since the snapshot: they come back. */
	readonly bringBack: readonly string[];
	/** Differences a restore will not act on, with the reason. */
	readonly leftAlone: readonly { readonly path: string; readonly why: string }[];
}

export interface RestoreResult {
	readonly restored: readonly string[];
	readonly removed: readonly string[];
	readonly broughtBack: readonly string[];
	readonly leftAlone: readonly { readonly path: string; readonly why: string }[];
}

/** Stable per project folder, whatever spelling it was opened with. */
export function projectKey(root: string): string {
	let real = root;
	try {
		real = realpathSync.native(root);
	} catch {
		// A folder that cannot be resolved is keyed by the path as given.
	}
	return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

function zList(text: string): string[] {
	return text.split("\0").filter((entry) => entry.length > 0);
}

async function git(store: Store, args: readonly string[], input?: string, env = store.env): Promise<string> {
	const result = await store.run(args, env, input);
	if (result.code !== 0) throw new GitFailed(args, result);
	return result.stdout;
}

/** Relative, inside the project, and never part of a repository's own folder. Git guarantees this; a restore checks anyway. */
export function isSafePath(path: string): boolean {
	if (!path || path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("\\")) return false;
	return path
		.split("/")
		.every((part) => part !== "" && part !== "." && part !== ".." && !/^\.git$|^git~\d+$/i.test(part));
}

const onDisk = (store: Store, path: string): string => join(store.root, ...path.split("/"));

/** The path with symlinks resolved as far as it exists; the part that does not exist yet stays as written. */
function realPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		const parent = dirname(absolute);
		return parent === absolute ? absolute : join(realPath(parent), basename(absolute));
	}
}

/** Like `realPath`, but never turns a permission or symlink-loop error into a missing path. */
function realPathForSecurity(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(absolute);
		return parent === absolute ? absolute : join(realPathForSecurity(parent), basename(absolute));
	}
}

/** `inner` relative to `outer`, or undefined when it is not inside it. "" when they are the same folder. */
function inside(outer: string, inner: string): string | undefined {
	const rel = relative(realPath(outer), realPath(inner));
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel;
}

/** Whether `inner` is `outer` or lies inside it, with symlinks resolved. */
export function isWithin(outer: string, inner: string): boolean {
	return inside(outer, inner) !== undefined;
}

/**
 * gitignore patterns for those of `folders` that lie inside `root`, anchored at it and written literally:
 * `/.agent/` for pi's agent folder kept at `<root>/.agent`, say. A folder that is the root itself gets
 * none; a caller must not snapshot such a root at all.
 */
export function ownFolderPatterns(root: string, folders: readonly string[]): string[] {
	const patterns = new Set<string>();
	for (const folder of folders) {
		const rel = inside(root, folder);
		if (!rel) continue;
		// A folder called "[draft]" or "a*b" is meant as it is, not as a pattern.
		patterns.add(
			`/${rel
				.split(sep)
				.map((part) => part.replace(/[\\*?[\]!#]/g, "\\$&"))
				.join("/")}/`,
		);
	}
	return [...patterns];
}

/**
 * Opens the project's shadow repository, creating it on first use. A lock left behind by a process
 * that died is cleared; a fresh one belongs to a live command of another session and is left alone.
 */
export async function openStore(options: StoreOptions): Promise<Store> {
	const gitDir = join(options.baseDir, projectKey(options.root));
	const store: Store = {
		gitDir,
		root: options.root,
		run: options.run,
		env: shadowEnv(options.env ?? process.env, gitDir, options.root),
		maxFileBytes: options.maxFileBytes ?? 5 * 1024 * 1024,
	};
	if (!existsSync(join(gitDir, "HEAD"))) {
		mkdirSync(gitDir, { recursive: true, mode: 0o700 });
		// Created without the work tree in the environment: `init --bare` refuses one.
		const { GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, GIT_DIR: _dir, ...bare } = store.env;
		const result = await options.run(["-c", "init.defaultBranch=mu", "init", "--bare", "--quiet", gitDir], bare);
		if (result.code !== 0) throw new GitFailed(["init"], result);
	}
	try {
		// A copy of the project is the user's alone, whoever else may look into the folders above it.
		chmodSync(gitDir, 0o700);
	} catch {
		// Not ours to change: the snapshots work all the same.
	}
	const config = join(gitDir, "config");
	if (!readFileSync(config, "utf8").includes(CONFIG_MARKER)) appendFileSync(config, `\n${shadowConfig(gitDir)}`);
	mkdirSync(join(gitDir, "info"), { recursive: true });
	const own = ownFolderPatterns(options.root, [options.baseDir, ...(options.ownFolders ?? [])]);
	writeFileSync(join(gitDir, "info", "exclude"), `${[...(options.ignore ?? BUILT_IN_IGNORES), ...own].join("\n")}\n`);
	writeFileSync(join(gitDir, "info", "attributes"), SHADOW_ATTRIBUTES);
	writeFileSync(join(gitDir, PROJECT_FILE), `${JSON.stringify({ root: options.root, lastUsed: Date.now() })}\n`);
	releaseLocks(store, STALE_LOCK_MS);
	// The index keeps what it once took in, ignored or not: a key file an older mu snapshotted, a folder the project
	// ignores since. Out of the index, it is out of every later snapshot, and a restore leaves it alone.
	const stale = zList(await git(store, ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]));
	if (stale.length > 0) await git(store, ["update-index", "-z", "--force-remove", "--stdin"], `${stale.join("\0")}\0`);
	return store;
}

/** Removes lock files older than `olderThanMs`. With 0, every lock goes: for shutdown, once our own commands have ended. */
export function releaseLocks(store: Store, olderThanMs: number): void {
	let names: string[] = [];
	try {
		names = readdirSync(store.gitDir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".lock") && !/^restore-.*\.index$/.test(name)) continue;
		const path = join(store.gitDir, name);
		try {
			if (Date.now() - statSync(path).mtimeMs >= olderThanMs) rmSync(path, { force: true });
		} catch {
			// Gone already.
		}
	}
}

const LIST_CHANGES = ["ls-files", "-z", "--others", "--modified", "--deleted", "--exclude-standard"] as const;

/**
 * Brings the shadow index up to date with the working tree and returns the tree. Only what changed
 * since the last scan is looked at, so after the first one this costs a directory walk, not a copy.
 *
 * With `limits`, a scan that would take in more than that throws `SnapshotTooLarge` before it writes
 * anything. The first scan takes in the whole folder: in a home folder or a data folder that is the
 * difference between a second and a copy of everything, so the listing itself stops at the limit.
 */
export async function scan(store: Store, limits?: ScanLimits): Promise<{ tree: string; leftOut: string[] }> {
	const listing = await store.run(
		LIST_CHANGES,
		store.env,
		undefined,
		limits ? { maxEntries: limits.maxFiles } : undefined,
	);
	if (limits && listing.truncated) throw new SnapshotTooLarge("files", limits);
	if (limits && listing.code === TIMED_OUT) throw new SnapshotTooLarge("slow", limits);
	if (listing.code !== 0) throw new GitFailed(LIST_CHANGES, listing);
	const listed = zList(listing.stdout);
	const update: string[] = [];
	const drop: string[] = [];
	const leftOut: string[] = [];
	let bytes = 0;
	for (const path of new Set(listed)) {
		// A nested repository shows up as "folder/": it is somebody else's history, never part of a snapshot.
		if (path.endsWith("/")) leftOut.push(path);
		if (path.endsWith("/") || !isSafePath(path)) continue;
		const file = onDisk(store, path);
		let stats: ReturnType<typeof lstatSync> | undefined;
		try {
			stats = lstatSync(file);
			// One unreadable file must not cost the whole snapshot: git would stop at it.
			if (stats.isFile()) accessSync(file, constants.R_OK);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				leftOut.push(path);
				drop.push(path);
				continue;
			}
			stats = undefined;
		}
		// A folder (or a socket, a pipe) where a file used to be: the file is gone as far as the index goes.
		if (stats && !stats.isFile() && !stats.isSymbolicLink()) drop.push(path);
		else if (stats && stats.size > store.maxFileBytes) {
			leftOut.push(path);
			drop.push(path);
		} else {
			update.push(path);
			bytes += stats?.size ?? 0;
		}
	}
	if (limits && bytes > limits.maxBytes) throw new SnapshotTooLarge("bytes", limits);
	if (update.length > 0)
		await git(store, ["update-index", "-z", "--add", "--remove", "--stdin"], `${update.join("\0")}\0`);
	// A file that grew past the cap leaves the index, so no later tree claims to know its content.
	if (drop.length > 0) await git(store, ["update-index", "-z", "--force-remove", "--stdin"], `${drop.join("\0")}\0`);
	return { tree: (await git(store, ["write-tree"])).trim(), leftOut };
}

/** A scan kept as a commit under `refs/mu/<name>`, with a note of what existed but was left out. */
export async function snapshot(store: Store, name: string, limits?: ScanLimits): Promise<Snapshot> {
	const { tree, leftOut } = await scan(store, limits);
	const ignored = zList(
		await git(store, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]),
	);
	const excluded = [...ignored, ...leftOut];
	const meta: SnapshotMeta = excluded.length > MAX_EXCLUDED ? { excluded: [], overflow: true } : { excluded };
	const commit = (
		await git(store, ["commit-tree", tree, "-m", `mu checkpoint ${name}\n\n${JSON.stringify(meta)}`])
	).trim();
	await git(store, ["update-ref", `${REF_PREFIX}${name}`, commit]);
	return { commit, tree };
}

export async function hasCommit(store: Store, commit: string): Promise<boolean> {
	if (!/^[0-9a-f]{7,64}$/.test(commit)) return false;
	return (await store.run(["cat-file", "-e", `${commit}^{commit}`], store.env)).code === 0;
}

async function readMeta(store: Store, commit: string): Promise<SnapshotMeta> {
	const raw = await git(store, ["cat-file", "commit", commit]);
	const line = raw
		.slice(raw.indexOf("\n\n") + 2)
		.split("\n")
		.find((entry) => entry.startsWith("{"));
	try {
		const parsed = JSON.parse(line ?? "") as Partial<SnapshotMeta>;
		return {
			excluded: Array.isArray(parsed.excluded) ? parsed.excluded : [],
			overflow: parsed.overflow === true || !Array.isArray(parsed.excluded),
		};
	} catch {
		// Without the note nothing proves a file is new, so nothing will be deleted.
		return { excluded: [], overflow: true };
	}
}

/** What changed from one tree (or commit) to another. Renames are reported as a deletion and an addition. */
export async function diff(store: Store, from: string, to: string): Promise<Change[]> {
	const fields = zList(await git(store, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]));
	const changes: Change[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const status: ChangeStatus = fields[index] === "A" ? "added" : fields[index] === "D" ? "deleted" : "modified";
		changes.push({ path: fields[index + 1], status });
	}
	return changes;
}

/**
 * What going back to `commit` would do to the working tree as it is now (`nowTree`, from a scan).
 * A file that is new since the snapshot is only removed when the snapshot can prove it was absent:
 * one that existed then but was ignored or too large looks new the moment that changes, and is kept.
 */
export async function planRestore(store: Store, commit: string, nowTree: string): Promise<RestorePlan> {
	const meta = await readMeta(store, commit);
	const existedThen = (path: string): boolean =>
		meta.excluded.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : entry === path));
	const restore: string[] = [];
	const remove: string[] = [];
	const bringBack: string[] = [];
	const leftAlone: { path: string; why: string }[] = [];
	for (const change of await diff(store, commit, nowTree)) {
		if (!isSafePath(change.path)) leftAlone.push({ path: change.path, why: "not a path inside the project" });
		else if (change.status === "modified") restore.push(change.path);
		else if (change.status === "deleted") bringBack.push(change.path);
		else if (meta.overflow)
			leftAlone.push({ path: change.path, why: "cannot prove it was created after the checkpoint" });
		else if (existedThen(change.path))
			leftAlone.push({ path: change.path, why: "it existed at the checkpoint but was ignored or too large then" });
		else remove.push(change.path);
	}
	return { commit, restore, remove, bringBack, leftAlone };
}

/** The first thing on disk that makes writing `path` unsafe, or undefined. git's forced checkout would delete it instead. */
function obstacle(store: Store, path: string, mustBeAbsent: boolean): string | undefined {
	const parts = path.split("/");
	for (let depth = 1; depth < parts.length; depth++) {
		try {
			if (!lstatSync(join(store.root, ...parts.slice(0, depth))).isDirectory())
				return "a file is where its folder should be";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
			throw error;
		}
	}
	try {
		const stats = lstatSync(onDisk(store, path));
		if (stats.isDirectory()) return "a folder is in the way";
		// In no tree yet on disk: ignored or over the size cap now, so not ours to overwrite.
		if (mustBeAbsent) return "a file that is ignored or too large is there now";
		if (stats.size > store.maxFileBytes) return "it is over the size cap now";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return undefined;
}

/**
 * Checks the path immediately before a destructive operation. `lstat` on the final path is not enough:
 * an ancestor symlink makes `unlink(path)` operate outside the project. The real-path check also covers
 * a symlink whose target does not exist yet.
 */
function destructivePathObstacle(store: Store, path: string): string | undefined {
	const parts = path.split("/");
	for (let depth = 1; depth < parts.length; depth++) {
		try {
			if (!lstatSync(join(store.root, ...parts.slice(0, depth))).isDirectory())
				return "a file or symlink is where its folder should be";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	// Do not resolve the final component: it may itself be a symlink, and unlinking that directory
	// entry is safe. Only the parent directory must remain inside the project.
	const parent = dirname(onDisk(store, path));
	if (!isWithin(store.root, realPathForSecurity(parent))) {
		return "an ancestor symlink points outside the project";
	}
	return undefined;
}

/** A descriptor for the parent directory keeps ancestor traversal stable until the unlink/rmdir. */
interface SecureParent {
	readonly fd: number;
	readonly path: string;
}

function fdRoot(): string | undefined {
	if (process.platform === "linux") return "/proc/self/fd";
	if (process.platform === "darwin" || process.platform === "freebsd") return "/dev/fd";
	return undefined;
}

function fdPath(fd: number): string | undefined {
	const root = fdRoot();
	return root ? join(root, String(fd)) : undefined;
}

function openSecureParent(store: Store, path: string): SecureParent | undefined {
	const prefix = fdRoot();
	if (!prefix) return undefined;
	const parts = path.split("/");
	const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
	let fd = openSync(store.root, flags);
	try {
		for (const part of parts.slice(0, -1)) {
			const next = openSync(join(fdPath(fd) as string, part), flags);
			closeSync(fd);
			fd = next;
		}
		return { fd, path: join(prefix, String(fd)) };
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

function unlinkSafe(store: Store, path: string): "removed" | "missing" | "directory" {
	let parent: SecureParent | undefined;
	try {
		parent = openSecureParent(store, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
	const target = parent ? join(parent.path, basename(path)) : onDisk(store, path);
	try {
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
			throw error;
		}
		if (stats.isDirectory()) return "directory";
		try {
			unlinkSync(target);
			return "removed";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
			throw error;
		}
	} finally {
		if (parent) closeSync(parent.fd);
	}
}

function removeDirectoryIfEmpty(store: Store, path: string): void {
	const parent = openSecureParent(store, path);
	if (!parent) {
		rmdirSync(onDisk(store, path));
		return;
	}
	try {
		rmdirSync(join(parent.path, basename(path)));
	} finally {
		closeSync(parent.fd);
	}
}

/**
 * Makes the working tree equal to the snapshot for the planned paths, except `keep` (files the user
 * chose to hold on to). Removals come first so a file that replaced a folder is out of the way, then
 * git writes the snapshot's files from a throwaway index: modes and symlinks come back as they were.
 */
export async function applyRestore(
	store: Store,
	plan: RestorePlan,
	keep: ReadonlySet<string> = new Set(),
): Promise<RestoreResult> {
	const leftAlone = [...plan.leftAlone];
	const kept = (path: string): boolean => {
		if (keep.has(path)) leftAlone.push({ path, why: "kept as it is, as asked" });
		return keep.has(path);
	};
	const removed: string[] = [];
	for (const path of plan.remove) {
		if (kept(path)) continue;
		const unsafe = destructivePathObstacle(store, path);
		if (unsafe) {
			leftAlone.push({ path, why: unsafe });
			continue;
		}
		const status = unlinkSafe(store, path);
		if (status === "directory") {
			leftAlone.push({ path, why: "a folder is in the way" });
			continue;
		}
		removed.push(path);
		// Folders the removed file leaves empty go too; rmdir refuses anything that still holds a file.
		const parts = path.split("/");
		for (let depth = parts.length - 1; depth >= 1; depth--) {
			try {
				const parent = parts.slice(0, depth).join("/");
				const unsafeParent = destructivePathObstacle(store, `${parent}/.mu-checkpoint-empty-dir`);
				if (unsafeParent) break;
				removeDirectoryIfEmpty(store, parent);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") break;
				throw error;
			}
		}
	}

	const write: string[] = [];
	const restored: string[] = [];
	const broughtBack: string[] = [];
	for (const [paths, done, mustBeAbsent] of [
		[plan.restore, restored, false],
		[plan.bringBack, broughtBack, true],
	] as const) {
		for (const path of paths) {
			if (kept(path)) continue;
			const why = obstacle(store, path, mustBeAbsent);
			if (why) leftAlone.push({ path, why });
			else {
				write.push(path);
				done.push(path);
			}
		}
	}
	if (write.length > 0) {
		const index = join(store.gitDir, `restore-${randomUUID()}.index`);
		const env = { ...store.env, GIT_INDEX_FILE: index };
		try {
			await git(store, ["read-tree", plan.commit], undefined, env);
			// The initial obstacle check happened before read-tree yielded. Recheck before checkout so an
			// ancestor that became a symlink while git prepared the throwaway index is not followed.
			const safeWrite: string[] = [];
			for (const path of write) {
				const unsafe = obstacle(store, path, plan.bringBack.includes(path));
				if (unsafe) {
					leftAlone.push({ path, why: unsafe });
					if (plan.restore.includes(path)) {
						const position = restored.indexOf(path);
						if (position >= 0) restored.splice(position, 1);
					} else {
						const position = broughtBack.indexOf(path);
						if (position >= 0) broughtBack.splice(position, 1);
					}
				} else safeWrite.push(path);
			}
			if (safeWrite.length > 0)
				await git(store, ["checkout-index", "--force", "-z", "--stdin"], `${safeWrite.join("\0")}\0`, env);
		} finally {
			rmSync(index, { force: true });
			rmSync(`${index}.lock`, { force: true });
		}
	}
	return { restored, removed, broughtBack, leftAlone };
}

export interface PruneOptions {
	/** Newest snapshots to keep for this project. */
	readonly keep: number;
	/** Snapshots older than this go, however few there are. */
	readonly maxAgeDays: number;
	readonly now?: number;
}

/** Drops this project's old snapshot refs. Returns how many went; their objects go with the next `collectGarbage`. */
export async function prune(store: Store, options: PruneOptions): Promise<number> {
	const listed = await git(store, [
		"for-each-ref",
		"--sort=-committerdate",
		"--format=%(refname) %(committerdate:unix)",
		REF_PREFIX,
	]);
	const oldest = (options.now ?? Date.now()) / 1000 - options.maxAgeDays * 86_400;
	let dropped = 0;
	for (const [index, line] of listed.split("\n").filter(Boolean).entries()) {
		const [ref, stamp] = line.split(" ");
		if (index < options.keep && Number(stamp) >= oldest) continue;
		await git(store, ["update-ref", "-d", ref]);
		dropped++;
	}
	return dropped;
}

/** Frees what pruned snapshots held. The grace period keeps objects that a running snapshot wrote a moment ago. */
export async function collectGarbage(store: Store): Promise<void> {
	await git(store, ["gc", "--quiet", "--prune=3.days.ago"]);
}

/**
 * Removes the shadow repositories of projects nobody has opened for `maxAgeDays`, and at once those of
 * folders that are `offLimits` now (a home folder snapshotted by an older mu). Only folders mu itself
 * marked are touched.
 */
export function sweepProjects(
	baseDir: string,
	maxAgeDays: number,
	now = Date.now(),
	offLimits: (root: string) => boolean = () => false,
): string[] {
	const removed: string[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(baseDir);
	} catch {
		return removed;
	}
	for (const name of names) {
		try {
			const project = JSON.parse(readFileSync(join(baseDir, name, PROJECT_FILE), "utf8")) as {
				lastUsed?: unknown;
				root?: unknown;
			};
			const unusable = typeof project.root === "string" && offLimits(project.root);
			const stale = typeof project.lastUsed === "number" && now - project.lastUsed >= maxAgeDays * 86_400_000;
			if (!unusable && !stale) continue;
			rmSync(join(baseDir, name), { recursive: true, force: true });
			removed.push(name);
		} catch {
			// Not one of ours, or unreadable: left alone.
		}
	}
	return removed;
}
