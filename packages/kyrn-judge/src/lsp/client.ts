/**
 * A minimal Language Server Protocol client: one child process, JSON-RPC over
 * its stdio, and the documents the agent has edited or asked about.
 *
 * It mostly exists to answer one question: what did this change introduce? So every
 * document keeps a `base` (its text and diagnostics before the agent's latest
 * edit) next to what the server says now, and `fresh()` is the difference.
 *
 * Two things make that reliable:
 * - A document is opened with the text it had BEFORE the edit, and the edit is
 *   only sent once the server has said what was wrong with that text. A cold
 *   server therefore still yields a baseline; nothing blocks while it warms up.
 * - Servers that publish give no "done" signal and publish in stages. A
 *   snapshot only counts once nothing more has arrived for `quietMs`.
 *
 * The agent's questions about the code (where is this defined, who uses it)
 * go through `ask`, on documents opened the same way: a file opened for a
 * question has its first diagnostics as its base, as one opened for an edit.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { basename } from "node:path";
import { type Diagnostic, IDENTITY, lineMap, readDiagnostics, subtract } from "./diagnostics.ts";
import { encodeMessage, MessageDecoder } from "./framing.ts";
import { pathKey, pathToUri, type UriStyle, uriToPath } from "./uri.ts";

export interface LspClientOptions {
	/** The executable and arguments, already resolved for the platform (see `spawnPlan`). */
	readonly command: string;
	readonly args: readonly string[];
	readonly windowsVerbatimArguments?: boolean;
	/** The workspace root. */
	readonly root: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly uriStyle: UriStyle;
	readonly platform?: string;
	readonly languageId: (path: string) => string;
	readonly initializationOptions?: unknown;
	/** Answers `workspace/configuration`, by section. */
	readonly settings?: Readonly<Record<string, unknown>>;
	/** A snapshot counts once the server has been silent about the document for this long. */
	readonly quietMs?: number;
	/** How long a newly opened document waits for its first diagnostics before the edit is sent anyway. */
	readonly baselineMs?: number;
	readonly requestTimeoutMs?: number;
	readonly startTimeoutMs?: number;
	readonly maxOpenDocs?: number;
	/** The text the server has for a file moved: whoever tracks line numbers must move with it. */
	readonly onTextChange?: (path: string, oldText: string, newText: string) => void;
	/** The process ended without being asked to. */
	readonly onExit?: (reason: string) => void;
}

export type ClientState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

interface Doc {
	readonly path: string;
	readonly uri: string;
	/** Reported by the server without us opening it (a workspace-wide checker). Its text is unknown. */
	readonly foreign: boolean;
	opened: boolean;
	version: number;
	/** What the server has. */
	text: string;
	/** Newer content, held back until the first baseline is in. */
	wanted: string | undefined;
	base: { text: string; diagnostics: readonly Diagnostic[] } | undefined;
	pushed: readonly Diagnostic[] | undefined;
	pulled: readonly Diagnostic[] | undefined;
	resultId: string | undefined;
	/** True once `pushed`/`pulled` describe `text` and the server went quiet. */
	confirmed: boolean;
	pulling: number;
	quietTimer: NodeJS.Timeout | undefined;
	baselineTimer: NodeJS.Timeout | undefined;
	openedAt: number;
	lastUsed: number;
}

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

const STDERR_CHARS = 8192;
const SERVER_CANCELLED = -32802;

/** Children that must not outlive this process, whatever path it exits by. */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function killTree(child: ChildProcess, platform: string): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		// A .cmd shim runs the server as a grandchild: killing cmd.exe alone would orphan it.
		if (platform === "win32" && child.pid) {
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
				"error",
				() => child.kill(),
			);
		} else child.kill();
	} catch {
		/* It is gone already. */
	}
}

export class LspClient {
	state: ClientState = "idle";
	/** Why it is not running, for `/lsp`. */
	lastError: string | undefined;
	private readonly options: LspClientOptions;
	private readonly quietMs: number;
	private readonly baselineMs: number;
	private readonly platform: string;
	private child: ChildProcess | undefined;
	private starting: Promise<void> | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly docs = new Map<string, Doc>();
	private readonly waiters = new Set<() => void>();
	private readonly progress = new Set<string>();
	private progressSeen = false;
	private stderr = "";
	/** What the server said it can do, in its answer to `initialize`. */
	private capabilities: Readonly<Record<string, unknown>> = {};
	private pull = false;
	private wantsSave = false;
	private saveWithText = false;

	constructor(options: LspClientOptions) {
		this.options = options;
		this.quietMs = options.quietMs ?? 250;
		this.baselineMs = options.baselineMs ?? 5000;
		this.platform = options.platform ?? process.platform;
	}

	get stderrTail(): string {
		return this.stderr;
	}

	get openDocuments(): number {
		return [...this.docs.values()].filter((doc) => doc.opened).length;
	}

	get usesPull(): boolean {
		return this.pull;
	}

	/** The server reported work in progress (indexing, loading the project) that has not ended yet. */
	get busy(): boolean {
		return this.progress.size > 0;
	}

	/** Whether the server said it answers a request of this kind, by its capability name (`definitionProvider`). */
	supports(capability: string): boolean {
		const value = this.capabilities[capability];
		return value !== undefined && value !== null && value !== false;
	}

	/** A request about the code (`textDocument/definition`), sent once the server runs. Rejects when it is not running. */
	ask(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		if (this.state !== "running") return Promise.reject(new Error("the language server is not running"));
		return this.request(method, params, timeoutMs);
	}

	/** The URI the server knows a file by. */
	uriOf(path: string): string {
		return pathToUri(path, this.options.uriStyle);
	}

	/** The file a URI the server sent names, or undefined when it names no file on this machine. */
	pathOf(uri: string): string | undefined {
		return uriToPath(uri, this.options.uriStyle);
	}

	/** Spawns the server and shakes hands. Resolves once it takes documents; rejects when it cannot be started. */
	start(): Promise<void> {
		this.starting ??= this.launch().catch((error: unknown) => {
			this.fail(error instanceof Error ? error.message : String(error));
			throw error;
		});
		return this.starting;
	}

	private async launch(): Promise<void> {
		this.state = "starting";
		const { command, args, root, env } = this.options;
		const child = spawn(command, [...args], {
			cwd: root,
			env: env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			windowsVerbatimArguments: this.options.windowsVerbatimArguments,
		});
		this.child = child;
		live.add(child);
		if (!exitHookInstalled) {
			exitHookInstalled = true;
			process.once("exit", () => {
				for (const orphan of live) killTree(orphan, process.platform);
			});
		}

		const decoder = new MessageDecoder();
		child.stdout?.on("data", (chunk: Buffer) => {
			try {
				for (const message of decoder.push(chunk)) this.receive(message);
			} catch (error) {
				this.fail(`unreadable output: ${error instanceof Error ? error.message : String(error)}`);
				killTree(child, this.platform);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_CHARS);
		});
		// A write to a server that died must not take the agent down with it.
		child.stdin?.on("error", () => {});
		const exited = new Promise<never>((_, reject) => {
			child.once("error", (error) => reject(new Error(`could not be started: ${error.message}`)));
			child.once("exit", (code, signal) => {
				live.delete(child);
				const reason = `exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
				if (this.state !== "stopping" && this.state !== "stopped") this.fail(reason);
				reject(new Error(reason));
			});
		});
		// Nobody may be listening any more when the process ends after a successful start.
		exited.catch(() => {});

		const rootUri = pathToUri(root, this.options.uriStyle);
		const handshake = this.request(
			"initialize",
			{
				processId: process.pid,
				clientInfo: { name: "mu" },
				rootPath: root,
				rootUri,
				workspaceFolders: [{ uri: rootUri, name: basename(root) || root }],
				initializationOptions: this.options.initializationOptions,
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: true },
						publishDiagnostics: {
							relatedInformation: true,
							versionSupport: true,
							codeDescriptionSupport: true,
							tagSupport: { valueSet: [1, 2] },
						},
						diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
						definition: { dynamicRegistration: false, linkSupport: true },
						implementation: { dynamicRegistration: false, linkSupport: true },
						references: { dynamicRegistration: false },
						hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
					},
					workspace: { workspaceFolders: true, configuration: true, diagnostics: { refreshSupport: true } },
					window: { workDoneProgress: true },
				},
			},
			this.options.startTimeoutMs ?? 20000,
		);
		const result = (await Promise.race([handshake, exited])) as { capabilities?: Record<string, unknown> } | null;
		const capabilities = result?.capabilities ?? {};
		this.capabilities = capabilities;
		this.pull = capabilities.diagnosticProvider !== undefined && capabilities.diagnosticProvider !== null;
		const sync = capabilities.textDocumentSync;
		const save = typeof sync === "object" && sync !== null ? (sync as { save?: unknown }).save : undefined;
		this.wantsSave = Boolean(save);
		this.saveWithText =
			typeof save === "object" && save !== null && (save as { includeText?: unknown }).includeText === true;
		if (this.state !== "starting") throw new Error("stopped while starting");
		this.notify("initialized", {});
		this.state = "running";
		// Documents that were registered while the server was starting.
		for (const doc of this.docs.values()) {
			if (!doc.opened && !doc.foreign && (doc.base === undefined || doc.wanted !== undefined)) this.open(doc);
		}
	}

	/** Asks the server to leave, and makes sure it has. Never rejects. */
	async stop(): Promise<void> {
		const child = this.child;
		const wasRunning = this.state === "running";
		this.state = "stopping";
		this.clearTimers();
		if (child && child.exitCode === null && child.signalCode === null) {
			const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			if (wasRunning) {
				await this.request("shutdown", undefined, 2000).catch(() => undefined);
				this.notify("exit", undefined);
			}
			await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, wasRunning ? 1000 : 0))]);
			killTree(child, this.platform);
		}
		this.state = "stopped";
		this.settle();
	}

	// ------------------------------------------------------------------ documents

	/**
	 * The content of a file as it is now on disk. `undefined` means the file does not exist.
	 *
	 * With `rebase` the text is a state the agent did not produce (the file before an
	 * edit, or after a shell command touched it): if the server has something else, its
	 * diagnostics for this text become the new base and nothing in them counts as new.
	 */
	setText(path: string, text: string | undefined, rebase = false): void {
		const key = pathKey(path, this.options.uriStyle);
		let doc = this.docs.get(key);
		if (doc?.foreign) {
			// The agent now edits a file the server had only reported on: from here on it is ours.
			this.clearDocTimers(doc);
			this.docs.delete(key);
			doc = undefined;
		}
		if (!doc) {
			doc = this.createDoc(path, false);
			this.docs.set(key, doc);
			// A file that does not exist yet has no problems: everything the server finds in it later is new.
			if (text === undefined) doc.base = { text: "", diagnostics: [] };
			else {
				doc.text = text;
				if (this.state === "running") this.open(doc);
			}
			this.evict();
			return;
		}
		doc.lastUsed = Date.now();
		if (text === undefined) {
			this.close(doc);
			return;
		}
		if (!doc.opened) {
			// Registered while the server was starting, or a file that did not exist: the first text stays what is opened.
			doc.wanted = doc.base === undefined && text === doc.text ? undefined : text;
			if (this.state === "running") this.open(doc);
			return;
		}
		if (text === (doc.wanted ?? doc.text)) return;
		if (rebase) {
			doc.base = undefined;
			this.change(doc, text);
			doc.openedAt = Date.now();
			doc.baselineTimer = setTimeout(() => this.baselineExpired(doc), this.baselineMs);
		}
		// Still waiting for what was wrong before the edit: the server keeps the old text until it has said so.
		else if (doc.base === undefined && doc.baselineTimer) doc.wanted = text;
		else this.change(doc, text);
	}

	/** What the server reports now and did not report for the base text, per document. Only settled documents count. */
	fresh(): { path: string; diagnostics: Diagnostic[] }[] {
		const result: { path: string; diagnostics: Diagnostic[] }[] = [];
		for (const doc of this.docs.values()) {
			if (!doc.confirmed || !doc.base || doc.wanted !== undefined) continue;
			const diagnostics = subtract(
				this.latest(doc),
				doc.base.diagnostics,
				doc.foreign ? IDENTITY : lineMap(doc.base.text, doc.text),
			);
			if (diagnostics.length > 0) result.push({ path: doc.path, diagnostics });
		}
		return result;
	}

	/**
	 * Called before an agent edit: what is settled now becomes the base that the
	 * edit is measured against. A document still being analysed keeps its older
	 * base, which is safe: the comparison then simply spans two edits. Returns
	 * what was new until now, because after this call it no longer is.
	 */
	checkpoint(): { path: string; diagnostics: Diagnostic[] }[] {
		const fresh = this.fresh();
		for (const doc of this.docs.values()) {
			if (doc.confirmed && doc.wanted === undefined) doc.base = { text: doc.text, diagnostics: this.latest(doc) };
		}
		return fresh;
	}

	/** The server's current word on a file, or undefined while it has not settled (or the file is unknown). */
	current(path: string): readonly Diagnostic[] | undefined {
		const doc = this.docs.get(pathKey(path, this.options.uriStyle));
		return doc?.confirmed && doc.wanted === undefined ? this.latest(doc) : undefined;
	}

	/** Paths of the documents opened here, for re-reading them from disk. */
	openPaths(): string[] {
		return [...this.docs.values()].filter((doc) => !doc.foreign).map((doc) => doc.path);
	}

	/**
	 * Resolves true once the given documents (all of them by default) have
	 * settled and nothing else is in flight, false when `budgetMs` ran out first.
	 */
	waitSettled(budgetMs: number, paths?: readonly string[]): Promise<boolean> {
		const keys = paths?.map((path) => pathKey(path, this.options.uriStyle));
		const settled = (): boolean => {
			if (this.state !== "running" && this.state !== "starting") return true;
			for (const [key, doc] of this.docs) {
				if (doc.quietTimer || doc.pulling > 0) return false;
				const asked = keys ? keys.includes(key) : !doc.foreign;
				if (asked && doc.base !== undefined && !doc.opened && doc.wanted === undefined) continue;
				if (asked && (!doc.confirmed || doc.wanted !== undefined)) return false;
			}
			return true;
		};
		if (settled()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const check = () => {
				if (!settled()) return;
				clearTimeout(timer);
				this.waiters.delete(check);
				resolve(true);
			};
			const timer = setTimeout(() => {
				this.waiters.delete(check);
				resolve(false);
			}, budgetMs);
			this.waiters.add(check);
		});
	}

	private createDoc(path: string, foreign: boolean): Doc {
		return {
			path,
			uri: pathToUri(path, this.options.uriStyle),
			foreign,
			opened: false,
			version: 0,
			text: "",
			wanted: undefined,
			base: undefined,
			pushed: undefined,
			pulled: undefined,
			resultId: undefined,
			confirmed: false,
			pulling: 0,
			quietTimer: undefined,
			baselineTimer: undefined,
			openedAt: 0,
			lastUsed: Date.now(),
		};
	}

	private latest(doc: Doc): Diagnostic[] {
		const merged = [...(doc.pushed ?? [])];
		// A server that both publishes and answers pulls says some things twice.
		for (const diagnostic of doc.pulled ?? []) {
			const twice = merged.some(
				(other) =>
					other.line === diagnostic.line &&
					other.character === diagnostic.character &&
					other.message === diagnostic.message,
			);
			if (!twice) merged.push(diagnostic);
		}
		return merged;
	}

	private open(doc: Doc): void {
		// A file that did not exist before the edit is opened with its new content; its base is the empty file.
		if (doc.base !== undefined && doc.wanted !== undefined) {
			doc.text = doc.wanted;
			doc.wanted = undefined;
		}
		doc.opened = true;
		doc.version = 1;
		doc.openedAt = Date.now();
		this.notify("textDocument/didOpen", {
			textDocument: {
				uri: doc.uri,
				languageId: this.options.languageId(doc.path),
				version: doc.version,
				text: doc.text,
			},
		});
		if (doc.base !== undefined) this.options.onTextChange?.(doc.path, doc.base.text, doc.text);
		else doc.baselineTimer = setTimeout(() => this.baselineExpired(doc), this.baselineMs);
		this.afterContent(doc);
	}

	private change(doc: Doc, text: string): void {
		const old = doc.text;
		doc.text = text;
		doc.wanted = undefined;
		doc.version++;
		doc.pushed = undefined;
		doc.pulled = undefined;
		doc.resultId = undefined;
		doc.confirmed = false;
		this.notify("textDocument/didChange", {
			textDocument: { uri: doc.uri, version: doc.version },
			contentChanges: [{ text }],
		});
		// The agent's tools write to disk, which is a save: checkers that only run on save (cargo check) need to hear it.
		if (this.wantsSave) {
			this.notify("textDocument/didSave", {
				textDocument: { uri: doc.uri },
				...(this.saveWithText ? { text } : {}),
			});
		}
		this.options.onTextChange?.(doc.path, old, text);
		this.afterContent(doc);
	}

	/** New content is with the server: ask for its diagnostics, and for those of every other open document it may affect. */
	private afterContent(doc: Doc): void {
		if (!this.pull) return;
		for (const other of this.docs.values())
			if (other.opened && (other === doc || other.confirmed)) this.requestPull(other, true);
	}

	private close(doc: Doc): void {
		if (doc.opened && this.state === "running") {
			this.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
		}
		this.clearDocTimers(doc);
		this.docs.delete(pathKey(doc.path, this.options.uriStyle));
		this.settle();
	}

	private evict(): void {
		const limit = this.options.maxOpenDocs ?? 32;
		const ours = [...this.docs.values()].filter((doc) => !doc.foreign);
		if (ours.length <= limit) return;
		ours.sort((a, b) => a.lastUsed - b.lastUsed);
		for (const doc of ours.slice(0, ours.length - limit)) this.close(doc);
	}

	private requestPull(doc: Doc, retry: boolean): void {
		const version = doc.version;
		doc.pulling++;
		doc.confirmed = false;
		this.request("textDocument/diagnostic", {
			textDocument: { uri: doc.uri },
			previousResultId: doc.resultId,
		})
			.then((report) => {
				if (doc.version !== version) return;
				this.readReport(doc, report);
				const related = (report as { relatedDocuments?: Record<string, unknown> } | null)?.relatedDocuments;
				for (const [uri, other] of Object.entries(related ?? {})) {
					const relatedDoc = this.docFor(uri);
					if (relatedDoc) this.readReport(relatedDoc, other);
				}
			})
			.catch((error: unknown) => {
				// The server was busy with something newer and asks to be asked again.
				const again = (error as { code?: unknown; data?: { retriggerRequest?: unknown } } | undefined) ?? {};
				if (retry && again.code === SERVER_CANCELLED && again.data?.retriggerRequest !== false) {
					setTimeout(() => doc.opened && doc.version === version && this.requestPull(doc, false), 200);
				}
			})
			.finally(() => {
				doc.pulling--;
				if (doc.pulling === 0 && !doc.quietTimer && doc.version === version && doc.pulled !== undefined) {
					this.confirm(doc);
				}
				this.settle();
			});
	}

	private readReport(doc: Doc, report: unknown): void {
		const { kind, items, resultId } = (report ?? {}) as { kind?: unknown; items?: unknown; resultId?: unknown };
		if (kind === "full") doc.pulled = readDiagnostics(items);
		else if (kind === "unchanged") doc.pulled ??= [];
		else return;
		doc.resultId = typeof resultId === "string" ? resultId : undefined;
	}

	private docFor(uri: string): Doc | undefined {
		const path = uriToPath(uri, this.options.uriStyle);
		if (path === undefined) return undefined;
		const key = pathKey(path, this.options.uriStyle);
		let doc = this.docs.get(key);
		if (!doc) {
			doc = this.createDoc(path, true);
			this.docs.set(key, doc);
		}
		return doc;
	}

	private published(params: { uri?: unknown; version?: unknown; diagnostics?: unknown }): void {
		if (typeof params.uri !== "string") return;
		const doc = this.docFor(params.uri);
		if (!doc) return;
		// An answer about a version that has been replaced since says nothing about the text the server has now.
		if (typeof params.version === "number" && !doc.foreign && params.version < doc.version) return;
		doc.pushed = readDiagnostics(params.diagnostics);
		doc.confirmed = false;
		if (doc.quietTimer) clearTimeout(doc.quietTimer);
		doc.quietTimer = setTimeout(() => {
			doc.quietTimer = undefined;
			if (doc.pulling === 0) this.confirm(doc);
			this.settle();
		}, this.quietMs);
	}

	/** The server has said what it has to say about the document's current text. */
	private confirm(doc: Doc): void {
		doc.confirmed = true;
		if (doc.baselineTimer) clearTimeout(doc.baselineTimer);
		doc.baselineTimer = undefined;
		// The first word on a document is its baseline; so is the first word after a baseline was given up on.
		doc.base ??= { text: doc.text, diagnostics: this.latest(doc) };
		if (doc.wanted !== undefined) this.change(doc, doc.wanted);
		this.settle();
	}

	/** Nothing was said about a newly opened document. */
	private baselineExpired(doc: Doc): void {
		doc.baselineTimer = undefined;
		if (doc.base !== undefined || !doc.opened) return;
		if (this.progress.size > 0 && Date.now() - doc.openedAt < this.baselineMs * 4) {
			doc.baselineTimer = setTimeout(() => this.baselineExpired(doc), this.baselineMs);
			return;
		}
		// A server that reports its work and is idle now has nothing to say: the file is clean. One that never
		// reports work may just be slow, so its first word will be taken as the baseline, without calling any of it new.
		if (this.progressSeen && this.progress.size === 0) {
			doc.pushed ??= [];
			this.confirm(doc);
		} else if (doc.wanted !== undefined) this.change(doc, doc.wanted);
	}

	// ------------------------------------------------------------------ JSON-RPC

	private send(message: Record<string, unknown>): void {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) return;
		stdin.write(encodeMessage({ jsonrpc: "2.0", ...message }));
	}

	private notify(method: string, params: unknown): void {
		this.send({ method, params });
	}

	private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => {
					this.pending.delete(id);
					this.notify("$/cancelRequest", { id });
					reject(new Error(`${method} was not answered in time`));
				},
				timeoutMs ?? this.options.requestTimeoutMs ?? 10000,
			);
			this.pending.set(id, { resolve, reject, timer });
			this.send({ id, method, params });
		});
	}

	private receive(message: unknown): void {
		if (typeof message !== "object" || message === null) return;
		const { id, method, params, result, error } = message as Record<string, unknown>;
		if (typeof method !== "string") {
			const waiting = typeof id === "number" ? this.pending.get(id) : undefined;
			if (!waiting || typeof id !== "number") return;
			this.pending.delete(id);
			clearTimeout(waiting.timer);
			if (error) {
				const failure = Object.assign(
					new Error(String((error as { message?: unknown }).message ?? "failed")),
					error,
				);
				waiting.reject(failure);
			} else waiting.resolve(result);
			return;
		}
		if (id === undefined || id === null) {
			this.notified(method, params);
			return;
		}
		// A request from the server. Some of them block it until they are answered.
		const answer = this.answer(method, params);
		this.send(
			answer === NOT_FOUND
				? { id, error: { code: -32601, message: `Unhandled: ${method}` } }
				: { id, result: answer },
		);
	}

	private notified(method: string, params: unknown): void {
		if (method === "textDocument/publishDiagnostics") this.published((params ?? {}) as Record<string, unknown>);
		else if (method === "$/progress") {
			const { token, value } = (params ?? {}) as { token?: unknown; value?: { kind?: unknown } };
			this.progressSeen = true;
			if (value?.kind === "begin") this.progress.add(String(token));
			else if (value?.kind === "end") this.progress.delete(String(token));
		}
	}

	private answer(method: string, params: unknown): unknown {
		switch (method) {
			case "workspace/configuration": {
				const items = (params as { items?: { section?: unknown }[] } | undefined)?.items ?? [];
				return items.map((item) =>
					typeof item.section === "string" ? (this.options.settings?.[item.section] ?? null) : null,
				);
			}
			case "workspace/workspaceFolders": {
				const uri = pathToUri(this.options.root, this.options.uriStyle);
				return [{ uri, name: basename(this.options.root) || this.options.root }];
			}
			case "workspace/diagnostic/refresh":
				for (const doc of this.docs.values()) if (doc.opened && this.pull) this.requestPull(doc, true);
				return null;
			case "workspace/applyEdit":
				return { applied: false };
			case "client/registerCapability":
			case "client/unregisterCapability":
			case "window/workDoneProgress/create":
			case "window/showMessageRequest":
			case "window/showDocument":
				return null;
			default:
				return NOT_FOUND;
		}
	}

	// ------------------------------------------------------------------ endings

	private settle(): void {
		for (const check of [...this.waiters]) check();
	}

	private clearDocTimers(doc: Doc): void {
		if (doc.quietTimer) clearTimeout(doc.quietTimer);
		if (doc.baselineTimer) clearTimeout(doc.baselineTimer);
		doc.quietTimer = undefined;
		doc.baselineTimer = undefined;
	}

	private clearTimers(): void {
		for (const doc of this.docs.values()) this.clearDocTimers(doc);
		for (const [id, waiting] of this.pending) {
			clearTimeout(waiting.timer);
			waiting.reject(new Error("the language server is stopping"));
			this.pending.delete(id);
		}
	}

	private fail(reason: string): void {
		if (this.state === "failed" || this.state === "stopped") return;
		this.state = "failed";
		const tail = this.stderr.trim().split("\n").slice(-3).join(" | ");
		this.lastError = tail ? `${reason} (${tail.slice(0, 300)})` : reason;
		this.clearTimers();
		const child = this.child;
		if (child) killTree(child, this.platform);
		this.settle();
		try {
			this.options.onExit?.(this.lastError);
		} catch {
			/* Whoever listens does not own the client. */
		}
	}
}

const NOT_FOUND: unique symbol = Symbol("lsp.method-not-found");
