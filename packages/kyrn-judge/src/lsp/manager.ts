/**
 * The language servers of one session. Nothing runs until the agent edits a
 * file that an installed server handles, or asks about one (`lsp`); then one
 * process per (server, workspace root) is started and kept for the session.
 *
 * A server that dies is started once more, on its next use. After a second
 * death it stays down for the session: a crashing server must not turn every
 * edit into a process spawn.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { type ClientState, LspClient } from "./client.ts";
import type { Diagnostic } from "./diagnostics.ts";
import {
	type DetectedServer,
	detectServers,
	findOnPath,
	findRoot,
	languageIdFor,
	type ServerSpec,
	serversFor,
	spawnPlan,
} from "./servers.ts";
import { uriStyleFor } from "./uri.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface LspManagerOptions {
	readonly platform?: string;
	readonly env?: Env;
	readonly quietMs: number;
	readonly baselineMs: number;
	/** At most this many server processes; the least recently used one is stopped to make room. */
	readonly maxServers: number;
	/** The text a server has for a file moved. Reported once per file and change, however many servers serve it. */
	readonly onTextChange: (path: string, oldText: string, newText: string) => void;
}

const MAX_STARTS = 2;

interface Instance {
	readonly spec: ServerSpec;
	readonly root: string;
	client: LspClient;
	starts: number;
	lastUsed: number;
	lastError: string | undefined;
}

export interface ServerStatus {
	readonly id: string;
	readonly origin: ServerSpec["origin"];
	readonly extensions: readonly string[];
	readonly executable: string | undefined;
	/** `alternative`: installed, but another server of its group is used. `untrusted`: named by the project, which is not trusted. */
	readonly use: "used" | "alternative" | "missing" | "untrusted";
	readonly running: readonly {
		readonly root: string;
		readonly state: ClientState;
		readonly documents: number;
		readonly starts: number;
		readonly lastError: string | undefined;
	}[];
}

/** A server that runs and has the file the agent asked about. */
export interface ReadyServer {
	readonly id: string;
	readonly client: LspClient;
}

/** A server that should have answered and cannot: not started, or stopped for the session. */
export interface FailedServer {
	readonly id: string;
	readonly reason: string;
}

export function isExecutableFile(path: string, platform: string = process.platform): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export class LspManager {
	private readonly options: LspManagerOptions;
	private readonly platform: string;
	private readonly env: Env;
	private readonly instances = new Map<string, Instance>();
	private detected: DetectedServer[] = [];
	private specsKey = "";
	private readonly textOf = new Map<string, string>();

	constructor(options: LspManagerOptions) {
		this.options = options;
		this.platform = options.platform ?? process.platform;
		this.env = options.env ?? process.env;
	}

	/** Looks the servers up on PATH. Cached until the table or PATH changes. */
	detect(specs: readonly ServerSpec[]): readonly DetectedServer[] {
		const key = JSON.stringify([specs, this.env.PATH ?? this.env.Path]);
		if (key !== this.specsKey) {
			this.specsKey = key;
			this.detected = detectServers(specs, (command) =>
				findOnPath(command, {
					env: this.env,
					platform: this.platform,
					isExecutable: (path) => isExecutableFile(path, this.platform),
				}),
			);
		}
		return this.detected;
	}

	/** The installed servers that handle this file. A project's own servers only count when the project is trusted. */
	serving(file: string, specs: readonly ServerSpec[], projectTrusted: boolean): DetectedServer[] {
		return serversFor(file, this.detect(specs)).filter(
			(server) => server.spec.origin !== "project" || projectTrusted,
		);
	}

	/**
	 * The agent is about to change `file`, whose text is `text` right now
	 * (undefined: it does not exist). Starts what is needed without waiting for
	 * it, and returns what was new until this moment, per file.
	 */
	beforeEdit(
		file: string,
		text: string | undefined,
		servers: readonly DetectedServer[],
		cwd: string,
	): { path: string; diagnostics: Diagnostic[] }[] {
		const fresh: { path: string; diagnostics: Diagnostic[] }[] = [];
		for (const server of servers) {
			const instance = this.instanceFor(server, file, cwd);
			if (!instance) continue;
			fresh.push(...instance.client.checkpoint());
			instance.client.setText(file, text, true);
		}
		return fresh;
	}

	/**
	 * The agent asks about `file`, whose text is `text`: opens it on each of the servers given, starting them if
	 * needed, and waits until each one runs or has failed. Unlike an edit, a question cannot be answered before then.
	 */
	async prepare(
		file: string,
		text: string,
		servers: readonly DetectedServer[],
		cwd: string,
	): Promise<{ running: ReadyServer[]; failed: FailedServer[] }> {
		const outcomes = await Promise.all(
			servers.map(async (server): Promise<ReadyServer | FailedServer> => {
				const id = server.spec.id;
				const instance = this.instanceFor(server, file, cwd);
				if (!instance) {
					const known = [...this.instances.values()].find((each) => each.spec.id === id);
					return { id, reason: known?.lastError ?? "it stopped twice in this session" };
				}
				instance.client.setText(file, text, true);
				try {
					await instance.client.start();
					return { id, client: instance.client };
				} catch {
					return { id, reason: instance.client.lastError ?? "it could not be started" };
				}
			}),
		);
		return {
			running: outcomes.filter((outcome): outcome is ReadyServer => "client" in outcome),
			failed: outcomes.filter((outcome): outcome is FailedServer => "reason" in outcome),
		};
	}

	/** The edit is done (or failed): this is the file now. */
	afterEdit(file: string, text: string | undefined): void {
		for (const instance of this.alive()) {
			if (instance.client.openPaths().includes(file)) instance.client.setText(file, text);
		}
		if (text === undefined) this.textOf.delete(file);
	}

	/** Something other than the agent's edit tools may have changed the open files: read them again. */
	syncFromDisk(read: (path: string) => string | undefined): void {
		for (const instance of this.alive()) {
			for (const path of instance.client.openPaths()) instance.client.setText(path, read(path), true);
		}
	}

	async waitSettled(budgetMs: number, files?: readonly string[]): Promise<void> {
		await Promise.all(this.alive().map((instance) => instance.client.waitSettled(budgetMs, files)));
	}

	fresh(): { path: string; diagnostics: Diagnostic[] }[] {
		return this.alive().flatMap((instance) => instance.client.fresh());
	}

	/** Every server's current word on a file, or undefined while one of them has not settled or none knows the file. */
	current(path: string): Diagnostic[] | undefined {
		const holders = this.alive().filter((instance) => instance.client.openPaths().includes(path));
		if (holders.length === 0) return undefined;
		const all: Diagnostic[] = [];
		for (const instance of holders) {
			const now = instance.client.current(path);
			if (!now) return undefined;
			all.push(...now);
		}
		return all;
	}

	status(specs: readonly ServerSpec[], projectTrusted: boolean): ServerStatus[] {
		return this.detect(specs).map(({ spec, executable, chosen }) => ({
			id: spec.id,
			origin: spec.origin,
			extensions: spec.extensions,
			executable,
			use:
				executable === undefined
					? "missing"
					: spec.origin === "project" && !projectTrusted
						? "untrusted"
						: chosen
							? "used"
							: "alternative",
			running: [...this.instances.values()]
				.filter((instance) => instance.spec.id === spec.id)
				.map((instance) => ({
					root: instance.root,
					state: instance.client.state,
					documents: instance.client.openDocuments,
					starts: instance.starts,
					lastError: instance.lastError ?? instance.client.lastError,
				})),
		}));
	}

	async stopAll(): Promise<void> {
		const instances = [...this.instances.values()];
		this.instances.clear();
		await Promise.all(instances.map((instance) => instance.client.stop()));
	}

	private alive(): Instance[] {
		return [...this.instances.values()].filter(
			(instance) => instance.client.state === "running" || instance.client.state === "starting",
		);
	}

	private instanceFor(server: DetectedServer, file: string, cwd: string): Instance | undefined {
		if (!server.executable) return undefined;
		const root = findRoot(file, server.spec.rootMarkers, cwd, existsSync, this.platform);
		const key = `${server.spec.id}\n${root}`;
		let instance = this.instances.get(key);
		const dead = instance && (instance.client.state === "failed" || instance.client.state === "stopped");
		if (instance && dead) {
			instance.lastError = instance.client.lastError ?? instance.lastError;
			if (instance.starts >= MAX_STARTS) return undefined;
			instance.client = this.createClient(server, root);
			instance.starts++;
			this.launch(instance);
		}
		if (!instance) {
			instance = {
				spec: server.spec,
				root,
				client: this.createClient(server, root),
				starts: 1,
				lastUsed: 0,
				lastError: undefined,
			};
			this.instances.set(key, instance);
			this.launch(instance);
			this.evict(key);
		}
		instance.lastUsed = Date.now();
		return instance;
	}

	private launch(instance: Instance): void {
		const client = instance.client;
		client.start().catch(() => {
			instance.lastError = client.lastError ?? instance.lastError;
		});
	}

	private createClient(server: DetectedServer, root: string): LspClient {
		const executable = server.executable as string;
		const env = { ...this.env, ...server.spec.env } as NodeJS.ProcessEnv;
		const plan = spawnPlan(executable, server.spec.args, this.platform, this.env);
		return new LspClient({
			command: plan.command,
			args: plan.args,
			windowsVerbatimArguments: plan.windowsVerbatimArguments,
			root,
			env,
			platform: this.platform,
			uriStyle: uriStyleFor({ platform: this.platform, env: this.env, executable }),
			languageId: languageIdFor,
			initializationOptions: server.spec.initializationOptions,
			settings: server.spec.settings,
			quietMs: this.options.quietMs,
			baselineMs: this.options.baselineMs,
			onTextChange: (path, oldText, newText) => {
				// Two servers on one file report the same move twice; line numbers must only move once.
				if (this.textOf.get(path) === newText) return;
				const known = this.textOf.get(path);
				this.textOf.set(path, newText);
				this.options.onTextChange(path, known ?? oldText, newText);
			},
		});
	}

	private evict(keep: string): void {
		const running = [...this.instances.entries()].filter(
			([key, instance]) => key !== keep && this.alive().includes(instance),
		);
		if (running.length < this.options.maxServers) return;
		running.sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
		for (const [key, instance] of running.slice(0, running.length - this.options.maxServers + 1)) {
			this.instances.delete(key);
			void instance.client.stop();
		}
	}
}
