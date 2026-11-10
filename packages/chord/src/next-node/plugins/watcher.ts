// The watcher and its marks (slice 7c §5): `fs.watch` on every directory of the plugin roots and the app's base code,
// `node_modules` and `.git` never watched (a directory appearing later gets its watch), marks what changed and never
// applies it. A changed file dirties every plugin whose facets used it (a copied contract every user) or whose directory
// contains it; a changed `package.json` asks for an install (and for its metadata to be read again); a plugin directory
// or facet file added or removed asks for discovery again; a file of base code asks the app to restart its hosts. The
// marks are a JSON watchable; each mark records the generation of its latest change (generations only increase), so a
// change during a build keeps its mark, however late an older build's rollout clears.

import { type BigIntStats, type Dirent, type FSWatcher, lstatSync, readdirSync, realpathSync, watch } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import { type Batch, Source } from "../../next/state/internal.ts";
import { type BuiltFacet, inside } from "./build.ts";
import { type Discovery, FACET_EXTENSIONS } from "./discover.ts";

/** The marks: plugins to rebuild, plugins to install, whether to discover again, whether base code changed. */
export type PluginsState = {
	readonly dirty: readonly string[];
	readonly install: readonly string[];
	readonly set: boolean;
	readonly base: boolean;
};

/** The generation of each dirty plugin's latest change when a build started: what its rollout may clear. */
export type MarkSnapshot = { readonly plugins: ReadonlyMap<string, number> };

/** The generations of the latest change of the plugin set and of a `package.json` when a discovery started. */
export type DiscoverySnapshot = { readonly set: number; readonly manifest: number };

/** What the watcher watches and how it reports: the roots, the base code, the facet kinds, a failure to watch. */
export type WatcherOptions = {
	readonly roots: readonly string[];
	readonly base: readonly string[];
	readonly kinds: readonly string[];
	/** The watcher cannot watch (the system's limit): reported once, after which the app builds on demand. */
	readonly failed: (error: unknown) => void;
};

/** Directories never watched, and changes under them never marked. */
const IGNORED = new Set(["node_modules", ".git"]);

/**
 * mu: whether a tree's watches settle. On macOS a watch is not exact around its start (Node watches a directory there
 * through FSEvents). It also reports what changed in the moments before: events still on their way (some 10 ms of
 * them) reach the new watch, the directory's own creation among them, named like the directory. And it can miss what
 * changes in the moments after: every watch added makes the process's one event stream anew, and an event delivered to
 * the stream it replaces is lost. So there, while a tree settles, an event counts only when its entry shows otherwise
 * than when last seen, and after `SETTLE_MS` the tree is read once more for what no event told.
 */
const SETTLES = process.platform === "darwin";

/** mu: how long a tree settles before it is read once more, and how long again until what was seen is forgotten: 1 s. */
const SETTLE_MS = 1_000;

/**
 * The watcher and the marks (`state`), a JSON watchable published at most once per microtask turn with changes. It
 * marks for the plugins of the last discovery (`know`) and the files their last builds read (`used`).
 */
export class PluginWatcher extends Source {
	readonly #options: WatcherOptions;
	readonly #roots: readonly string[];
	readonly #baseDirs: readonly string[];
	/** The trees it watches: the roots, the base code, and plugin directories linked from outside the roots. */
	readonly #trees = new Set<string>();
	/** Its watches, one per directory of its trees. */
	readonly #watchers = new Map<string, FSWatcher>();
	/**
	 * mu: while a tree settles (`SETTLES`), what the entries of each of its directories showed when last seen (when the
	 * watch started, at their last event), by directory and name (`"."`: the directory itself).
	 */
	readonly #seen = new Map<string, Map<string, string>>();
	/** mu: the trees still settling, each with the timer of its next step. */
	readonly #settling = new Map<string, NodeJS.Timeout>();
	/** A failure to watch was reported (once). */
	#reported = false;
	/** The generation the next change gets: every mark records a newer one than any before it. */
	#generation = 1;
	/** Each dirty plugin's latest change, by generation. */
	readonly #dirty = new Map<string, number>();
	readonly #install = new Set<string>();
	/** The latest change of the plugin set since the last discovery (0: none). */
	#set = 0;
	/** The latest change of a known plugin's `package.json` since the last discovery (0: none). */
	#manifest = 0;
	#baseChanged = false;
	#discovery: Discovery = { plugins: [], problems: [] };
	/** The files each built facet read (its inputs and copies), by plugin and kind. */
	readonly #used = new Map<string, { readonly plugin: string; readonly files: ReadonlySet<string> }>();
	#value: JsonValue | undefined;
	#scheduled = false;

	constructor(options: WatcherOptions, batch: Batch) {
		super(batch);
		this.#options = options;
		// Events name paths under the directories as watched: by their real paths, as discovery names plugins.
		this.#roots = options.roots.map(real);
		this.#baseDirs = options.base.map(real);
		for (const dir of [...this.#roots, ...this.#baseDirs]) this.#watchTree(dir);
	}

	get value(): JsonValue {
		this.#value ??= {
			dirty: [...this.#dirty.keys()].sort(),
			install: [...this.#install].sort(),
			set: this.#set > 0,
			base: this.#baseChanged,
		};
		return this.#value;
	}

	deliver(context: Context): void {
		const value = this.value;
		this.publish(value, [["r", value]], false, context);
	}

	/** Whether the next build discovers again: the plugin set or a plugin's `package.json` changed. */
	get needsDiscovery(): boolean {
		return this.#set > 0 || this.#manifest > 0;
	}

	/** What a discovery that starts now has seen. */
	discoverySnapshot(): DiscoverySnapshot {
		return { set: this.#set, manifest: this.#manifest };
	}

	/** The plugins discovery found: marks are for them (a removed one's install clears); the changes it had seen clear. */
	know(discovery: Discovery, seen: DiscoverySnapshot): void {
		this.#discovery = discovery;
		if (this.#set === seen.set) this.#set = 0;
		if (this.#manifest === seen.manifest) this.#manifest = 0;
		// A removed plugin has nothing to install (its directory went, its package.json with it).
		for (const name of this.#install)
			if (!discovery.plugins.some((plugin) => plugin.name === name)) this.#install.delete(name);
		// A plugin directory linked from outside the roots: a tree of its own (a symlink is not followed).
		const linked = discovery.plugins.filter(({ dir }) => !this.#roots.some((root) => inside(root, dir)));
		for (const { dir } of linked) this.#watchTree(dir);
		for (const tree of this.#trees) {
			const kept =
				this.#roots.includes(tree) || this.#baseDirs.includes(tree) || linked.some((each) => each.dir === tree);
			if (!kept) this.#unwatchTree(tree);
		}
		this.#changed();
	}

	/** What `built` facets read: a later change of one of these files dirties their plugins. */
	used(built: readonly BuiltFacet[]): void {
		for (const facet of built) {
			if (facet.kind !== "script") continue;
			const files = new Set([...facet.inputs.map(({ file }) => file), ...facet.copied]);
			this.#used.set(`${facet.plugin}\u0000${facet.facet}`, { plugin: facet.plugin, files });
		}
	}

	/** The marks a build of `names` starts from: each one's latest change. */
	snapshot(names: Iterable<string>): MarkSnapshot {
		const plugins = new Map<string, number>();
		for (const name of names) plugins.set(name, this.#dirty.get(name) ?? 0);
		return { plugins };
	}

	/** `names` were applied everywhere: their marks clear unless a change came after `snapshot`. */
	applied(names: Iterable<string>, snapshot: MarkSnapshot): void {
		for (const name of names) {
			const latest = this.#dirty.get(name);
			if (latest !== undefined && latest <= (snapshot.plugins.get(name) ?? 0)) this.#dirty.delete(name);
		}
		this.#changed();
	}

	/** Plugin `name`'s dependencies were installed: its install mark clears and it is dirty (its packages changed). */
	installed(name: string): void {
		this.#install.delete(name);
		this.#dirty.set(name, this.#generation++);
		this.#changed();
	}

	/** Marks what a change of the file or directory at `path` (absolute) asks for. */
	mark(path: string): void {
		if (path.split(sep).some((part) => IGNORED.has(part))) return;
		if (this.#baseDirs.some((dir) => inside(dir, path))) {
			this.#baseChanged = true;
		} else {
			this.#markPlugin(path, this.#generation++);
		}
		this.#changed();
	}

	/** Stops watching. */
	close(): void {
		for (const watcher of this.#watchers.values()) watcher.close();
		this.#watchers.clear();
		for (const timer of this.#settling.values()) clearTimeout(timer);
		this.#settling.clear();
		this.#seen.clear();
		this.#trees.clear();
	}

	/**
	 * A change under a root, at `generation`: in a plugin's directory, it dirties that plugin (and asks for an install
	 * and a new reading of its metadata for its `package.json`, for discovery for a facet file at its top); elsewhere
	 * under a root (a directory added or removed, a directory that is no plugin yet), discovery; every plugin whose
	 * facets read the file is dirty too.
	 */
	#markPlugin(path: string, generation: number): void {
		const plugin = this.#discovery.plugins.find((each) => each.dir === path || inside(each.dir, path));
		if (plugin === undefined) {
			if (this.#roots.some((root) => inside(root, path))) this.#set = generation;
		} else if (path === join(plugin.dir, "package.json")) {
			this.#install.add(plugin.name);
			this.#manifest = generation;
		} else {
			if (path === plugin.dir || (dirname(path) === plugin.dir && this.#isFacetFile(basename(path)))) {
				this.#set = generation;
			}
			this.#dirty.set(plugin.name, generation);
		}
		for (const { plugin: user, files } of this.#used.values()) if (files.has(path)) this.#dirty.set(user, generation);
	}

	/** Whether `file` (at a plugin's top) is named as a facet file of one of the app's kinds. */
	#isFacetFile(file: string): boolean {
		return this.#options.kinds.some((kind) => FACET_EXTENSIONS.some((extension) => file === `${kind}${extension}`));
	}

	/** Watches the tree at `dir` (once): it and every directory under it but ignored ones; a missing one is skipped. */
	#watchTree(dir: string): void {
		if (this.#trees.has(dir)) return;
		this.#trees.add(dir);
		this.#watchDirs(dir, true);
		if (SETTLES && this.#watchers.has(dir)) this.#settle(dir, true);
	}

	/** Stops watching the tree at `dir`. */
	#unwatchTree(dir: string): void {
		this.#trees.delete(dir);
		clearTimeout(this.#settling.get(dir));
		this.#settling.delete(dir);
		this.#unwatchDirs(dir);
	}

	/**
	 * mu: the next step of `tree`'s settling, `SETTLE_MS` from now. `again`: its directories are read once more, and an
	 * entry that shows otherwise than when last seen had no event and gets one. Then, as long again later (the events of
	 * what the reading found may still be on their way), what was seen is forgotten: from then on every event marks.
	 */
	#settle(tree: string, again: boolean): void {
		const timer = setTimeout(() => {
			if (again) {
				for (const [dir, seen] of this.#seen) if (dir === tree || inside(tree, dir)) this.#readAgain(dir, seen);
				this.#settle(tree, false);
			} else {
				this.#settling.delete(tree);
				for (const dir of this.#seen.keys()) if (dir === tree || inside(tree, dir)) this.#seen.delete(dir);
			}
		}, SETTLE_MS);
		timer.unref();
		this.#settling.set(tree, timer);
	}

	/** mu: reads `dir` once more: an entry that shows otherwise than when last `seen` had no event, and gets one. */
	#readAgain(dir: string, seen: ReadonlyMap<string, string>): void {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			// Removed meanwhile: its parent's reading says so.
			return;
		}
		for (const name of new Set([...names, ...seen.keys()])) {
			if (name === "." || IGNORED.has(name)) continue;
			if (shown(join(dir, name)) !== seen.get(name)) this.#changedIn(dir, name);
		}
	}

	/**
	 * Watches `dir` and, walking down, every directory under it but ignored ones (each not watched yet). `tree`: the walk
	 * starts a tree's watches (where they settle, what it finds is what the next build reads: seen, no change), not those
	 * of a directory that appeared (what is in it is new).
	 */
	#watchDirs(dir: string, tree: boolean): void {
		if (this.#watchers.has(dir) || this.#reported) return;
		let watcher: FSWatcher;
		try {
			watcher = watch(dir, (_event, file) => {
				if (file !== null) this.#changedIn(dir, file);
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#failed(error);
			return;
		}
		watcher.on("error", (error) => this.#failed(error));
		this.#watchers.set(dir, watcher);
		// mu: seen after its watch started, so a change from now on shows against it.
		const seen = tree && SETTLES ? new Map<string, string>() : undefined;
		if (seen !== undefined) {
			this.#seen.set(dir, seen);
			remember(seen, ".", dir);
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			// Removed meanwhile: its parent's event says so.
			return;
		}
		for (const entry of entries) {
			if (IGNORED.has(entry.name)) continue;
			const path = join(dir, entry.name);
			if (seen !== undefined) remember(seen, entry.name, path);
			if (entry.isDirectory()) this.#watchDirs(path, tree);
		}
	}

	/**
	 * An event for `file` in the watched directory `dir`: a new directory gets its watches, a removed one loses them;
	 * marked, unless it tells nothing new while `dir`'s tree settles.
	 */
	#changedIn(dir: string, file: string): void {
		const path = join(dir, file);
		const name = basename(path);
		if (!IGNORED.has(name)) {
			if (this.#asSeen(dir, name, path)) return;
			if (isDirectory(path)) this.#watchDirs(path, false);
			else if (this.#watchers.has(path)) this.#unwatchDirs(path);
		}
		this.mark(path);
	}

	/**
	 * mu: whether an event for the entry `name` of `dir` (at `path`) tells nothing new while `dir`'s tree settles: the
	 * entry is there and shows what it did when last seen (on a file system keeping exact times). An event named like
	 * `dir` for no entry of it is about `dir` itself. An entry that is gone always counts: created and removed again
	 * between two events, it shows nothing either time. What the entry shows now is kept as seen.
	 */
	#asSeen(dir: string, name: string, path: string): boolean {
		const seen = this.#seen.get(dir);
		if (seen === undefined) return false;
		let key = name;
		let now = shown(path);
		if (now === undefined && name === basename(dir) && !seen.has(name)) {
			key = ".";
			now = shown(dir);
		}
		const was = seen.get(key);
		if (now === undefined) seen.delete(key);
		else seen.set(key, now);
		return now !== undefined && now === was && !now.startsWith(COARSE);
	}

	/** Stops watching `dir` and the directories under it (it was removed, or its tree is not watched any more). */
	#unwatchDirs(dir: string): void {
		for (const [watched, watcher] of this.#watchers) {
			if (watched !== dir && !inside(dir, watched)) continue;
			watcher.close();
			this.#watchers.delete(watched);
			this.#seen.delete(watched);
		}
	}

	/** Watching failed: reported once; every watch stops (the app builds on demand). */
	#failed(error: unknown): void {
		this.close();
		if (this.#reported) return;
		this.#reported = true;
		this.#options.failed(error);
	}

	/** The marks changed: one publication per microtask turn while someone watches or derives from them. */
	#changed(): void {
		this.#value = undefined;
		if (this.#scheduled || (!this.watched && this.dependents.size === 0)) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.batch.within(() => this.changed(), BACKGROUND_CONTEXT);
		});
	}
}

/**
 * Whether `path` is a directory, never following a link (as the scan of a tree does not); one that cannot be read (gone,
 * a link loop, no access) is none: a watch callback must not throw.
 */
function isDirectory(path: string): boolean {
	try {
		return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
	} catch {
		return false;
	}
}

/** mu: how `shown` starts for an entry of a file system keeping coarse times. */
const COARSE = "coarse ";

/**
 * mu: what `lstat` (never following a link) shows of the entry at `path`, as far as a change of it shows there: a
 * directory's identity and mode (its times change with its entries, which have their own events), anything else's
 * identity, size and times, marked coarse when its change time has no fraction of a millisecond (a file system keeping
 * coarse times shows two changes within one of its ticks alike). `undefined` for no entry or one that cannot be read.
 */
function shown(path: string): string | undefined {
	let stats: BigIntStats | undefined;
	try {
		stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	} catch {
		return undefined;
	}
	if (stats === undefined) return undefined;
	if (stats.isDirectory()) return `directory ${stats.ino} ${stats.mode}`;
	const file = `${stats.ino} ${stats.size} ${stats.mtimeNs} ${stats.ctimeNs}`;
	return stats.ctimeNs % 1_000_000n === 0n ? `${COARSE}${file}` : file;
}

/** mu: keeps in `seen`, as `key`, what the entry at `path` shows now. */
function remember(seen: Map<string, string>, key: string, path: string): void {
	const now = shown(path);
	if (now !== undefined) seen.set(key, now);
}

/** `dir` absolute and by its real path; as given (absolute) when it does not exist. */
function real(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return resolve(dir);
	}
}
