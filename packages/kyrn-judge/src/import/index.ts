/**
 * Bringing Claude Code, Codex and ZCode conversations into mu: finding them on this machine, and turning one into one
 * pi session in mu's session folder, where `/resume`, `mu --session` and the desktop app find it like any other.
 *
 * An imported session starts with a marker entry (IMPORT_MARKER) that names the tool, the transcript and the tool's
 * own id for the conversation. A conversation imported before is brought up to date instead: when it went on in the
 * other tool, its session is written again with what is new (same file, same id), as long as nobody went on with it in
 * mu; one that went on in mu as well is imported as a new session beside it. One that did not change is left as it is.
 *
 * Only node: built-ins at run time, so that `mu import` runs on a bare Node (cli.ts).
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { readClaudeCode } from "./claude-code.ts";
import { environmentCwd, readCodex } from "./codex.ts";
import { readHead, readTail, record, str } from "./jsonl.ts";
import {
	absolute,
	type ConvertedTranscript,
	classifyUserText,
	commandText,
	fileStamp,
	findImport,
	findImports,
	firstLine,
	type ImportCounts,
	type ImportedSession,
	type ImportOrigin,
	type ImportTool,
	type ReadOptions,
	replaceSessionFile,
	type SessionStore,
	sessionDirFor,
	sessionFileName,
	writeSessionFile,
} from "./session.ts";
import { listZcode, parseZcodeSource, readZcode, zcodeDatabase, zcodeSource } from "./zcode.ts";

export { readClaudeCode } from "./claude-code.ts";
export { readCodex } from "./codex.ts";
export {
	type ConvertedTranscript,
	findImports,
	IMPORT_CONTEXT,
	IMPORT_MARKER,
	type ImportCounts,
	type ImportOrigin,
	type ImportTool,
	isImportTool,
	type SessionStore,
	TOOL_NAMES,
} from "./session.ts";
export { readZcode, zcodeDatabase, zcodeSource } from "./zcode.ts";

// ---------------------------------------------------------------------------------------------------------------
// Which tool wrote a file
// ---------------------------------------------------------------------------------------------------------------

const CODEX_ITEMS: ReadonlySet<string> = new Set([
	"message",
	"function_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
	"local_shell_call",
	"reasoning",
]);

/** Claude Code or Codex, from the first lines of the file, or ZCode from its `<database>#<id>`; undefined for anything else. */
export function detectTool(path: string): ImportTool | undefined {
	if (parseZcodeSource(path)) return "zcode";
	let tool: ImportTool | undefined;
	let lines = 0;
	readHead(
		path,
		(value) => {
			lines++;
			const data = record(value);
			if (data) {
				if (record(data.payload) && typeof data.type === "string") tool = "codex";
				else if (
					typeof data.sessionId === "string" ||
					typeof data.uuid === "string" ||
					typeof data.leafUuid === "string"
				)
					tool = "claude-code";
				else if (data.record_type === "state") tool = "codex";
				else if (typeof data.id === "string" && typeof data.timestamp === "string" && data.type === undefined)
					tool = "codex";
				else if (typeof data.type === "string" && CODEX_ITEMS.has(data.type)) tool = "codex";
			}
			return tool !== undefined || lines >= 50;
		},
		4 * 1024 * 1024,
	);
	return tool;
}

// ---------------------------------------------------------------------------------------------------------------
// Finding conversations
// ---------------------------------------------------------------------------------------------------------------

export interface FoundConversation {
	tool: ImportTool;
	/** The transcript; for ZCode, `<database>#<id>`. */
	path: string;
	/** The tool's id for the conversation (what an import is recognised by). */
	id: string;
	/** The project folder it was held in. */
	cwd?: string;
	/** The first line the person wrote; empty when none was found near the start of the file. */
	title: string;
	started?: string;
	/** When the transcript last changed. */
	modified: string;
	/** Bytes. */
	size: number;
	/** A thread a sub-agent ran, not a conversation someone had. */
	subAgent: boolean;
	/** The mu session it was already imported as. */
	importedAs?: string;
	/** It changed after it was imported: importing it again brings what is new. */
	changed?: true;
}

type Described = Pick<FoundConversation, "id" | "cwd" | "title" | "started" | "subAgent">;

/** A name given to a conversation wins over one Claude Code made up for it. */
const CLAUDE_TITLES: readonly (readonly [string, string])[] = [
	["custom-title", "customTitle"],
	["ai-title", "aiTitle"],
	["summary", "summary"],
];

/** The title Claude Code shows for a conversation: it writes it again near the end now and then, so the end has it. */
function claudeTitle(path: string, head: readonly Record<string, unknown>[]): string | undefined {
	let tail: unknown[] = [];
	try {
		tail = readTail(path);
	} catch {}
	const found = new Map<string, string>();
	for (const value of [...head, ...tail]) {
		const data = record(value);
		const type = str(data?.type);
		const field = CLAUDE_TITLES.find(([name]) => name === type)?.[1];
		const title = field ? str(data?.[field])?.trim() : undefined;
		if (type && title) found.set(type, firstLine(title));
	}
	return CLAUDE_TITLES.map(([type]) => found.get(type)).find((title) => title !== undefined);
}

const TREE_TYPES: ReadonlySet<string> = new Set(["user", "assistant", "system", "attachment"]);

/** Who a text is from, for a title: the person's first line, or the first command they typed. */
function titleParts(text: string): { title?: string; command?: string } {
	if (classifyUserText(text) !== "user") return {};
	const command = commandText(text);
	if (command !== undefined) return { command };
	if (/^\s*<bash-input>/.test(text)) return {};
	const line = firstLine(text);
	return line ? { title: line } : {};
}

function describeClaudeCode(path: string): Described {
	let id: string | undefined;
	let agentId: string | undefined;
	let cwd: string | undefined;
	let started: string | undefined;
	let title: string | undefined;
	let command: string | undefined;
	let first: boolean | undefined;
	const titles: Record<string, unknown>[] = [];
	readHead(path, (value) => {
		const data = record(value);
		if (!data) return false;
		id ??= str(data.sessionId);
		const type = str(data.type);
		if (CLAUDE_TITLES.some(([name]) => name === type)) titles.push(data);
		if (!type || !TREE_TYPES.has(type)) return false;
		// The first message says whose transcript this is: a sub-agent's has nothing but sidechain records.
		first ??= data.isSidechain === true;
		if (first) agentId ??= str(data.agentId);
		cwd ??= str(data.cwd);
		started ??= str(data.timestamp);
		const own = first || data.isSidechain !== true;
		if (type === "user" && own && data.isMeta !== true && data.isCompactSummary !== true) {
			const message = record(data.message);
			const content = message?.content;
			const texts =
				typeof content === "string"
					? [content]
					: (Array.isArray(content) ? content : [])
							.map((block) => record(block))
							.filter((block) => block?.type === "text")
							.map((block) => str(block?.text) ?? "");
			for (const text of texts) {
				const parts = titleParts(text);
				title ??= parts.title;
				command ??= parts.command;
			}
		}
		return title !== undefined && cwd !== undefined && id !== undefined;
	});
	return {
		id: first && agentId ? `agent-${agentId}` : (id ?? ""),
		cwd,
		title: claudeTitle(path, titles) ?? title ?? command ?? "",
		started,
		subAgent: first === true,
	};
}

function describeCodex(path: string): Described {
	let id: string | undefined;
	let cwd: string | undefined;
	let started: string | undefined;
	let title: string | undefined;
	let command: string | undefined;
	let subAgent = false;
	let sawMeta = false;
	const visit = (item: Record<string, unknown>) => {
		if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) return;
		for (const block of item.content) {
			const text = str(record(block)?.text);
			if (text === undefined) continue;
			if (classifyUserText(text) === "setup") cwd ??= environmentCwd(text);
			const parts = titleParts(text);
			title ??= parts.title;
			command ??= parts.command;
		}
	};
	readHead(path, (value) => {
		const data = record(value);
		if (!data) return false;
		const payload = record(data.payload);
		const type = str(data.type);
		if (payload && type) {
			if (type === "session_meta" && !sawMeta) {
				sawMeta = true;
				id = str(payload.id) ?? id;
				cwd = str(payload.cwd) ?? cwd;
				started = str(payload.timestamp) ?? str(data.timestamp);
				subAgent = record(payload.source) !== undefined || payload.thread_source === "subagent";
			} else if (type === "turn_context") cwd ??= str(payload.cwd);
			else if (type === "response_item") visit(payload);
		} else if (type) visit(data);
		else if (str(data.id) && str(data.timestamp)) {
			id ??= str(data.id);
			started ??= str(data.timestamp);
		}
		return title !== undefined && cwd !== undefined && id !== undefined;
	});
	const fromName = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1];
	return { id: id ?? fromName ?? "", cwd, title: title ?? command ?? "", started, subAgent };
}

/** Claude Code keeps its home in CLAUDE_CONFIG_DIR when that is set, else in ~/.claude. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.CLAUDE_CONFIG_DIR ? absolute(env.CLAUDE_CONFIG_DIR) : join(home, ".claude"), "projects");
}

/** Codex keeps its home in CODEX_HOME when that is set, else in ~/.codex. Archived threads are not listed. */
export function codexSessionsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.CODEX_HOME ? absolute(env.CODEX_HOME) : join(home, ".codex"), "sessions");
}

/** The same folder however it is written (a link, a trailing slash, /tmp and /private/tmp). */
export function sameFolder(a: string, b: string): boolean {
	const canonical = (dir: string) => {
		const path = absolute(dir);
		try {
			return realpathSync.native(path);
		} catch {
			return path;
		}
	};
	return canonical(a) === canonical(b);
}

function jsonlFiles(dir: string, depth: number): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const name of names.sort()) {
		const path = join(dir, name);
		if (name.endsWith(".jsonl")) files.push(path);
		else if (depth > 0 && !name.startsWith(".")) {
			try {
				if (statSync(path).isDirectory()) files.push(...jsonlFiles(path, depth - 1));
			} catch {}
		}
	}
	return files;
}

export interface ListOptions {
	/** Only this project's conversations. */
	cwd?: string;
	/** Claude Code's `projects` folder. Default: claudeProjectsDir(). */
	claudeProjects?: string;
	/** Codex's `sessions` folder. Default: codexSessionsDir(). */
	codexSessions?: string;
	/** ZCode's database. Default: zcodeDatabase(). */
	zcodeDatabase?: string;
	/** mu's sessions, to mark what was imported already. */
	store?: SessionStore;
	/** Also list the threads sub-agents ran. */
	subAgents?: boolean;
}

/**
 * How each transcript looked when an import last found nothing new in it, by its source: a tool writes bookkeeping into
 * a transcript too (Claude Code its titles), and a transcript checked once in that state is not offered again as changed.
 */
type Checks = Record<string, string>;

const checksFile = (store: SessionStore): string => join(absolute(store.agentDir), "import-checks.json");

function readChecks(store: SessionStore): Checks {
	try {
		const checks = record(JSON.parse(readFileSync(checksFile(store), "utf8")) as unknown) ?? {};
		return Object.fromEntries(
			Object.entries(checks).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
	} catch {
		return {};
	}
}

function writeChecks(store: SessionStore, checks: Checks): void {
	const file = checksFile(store);
	try {
		mkdirSync(absolute(store.agentDir), { recursive: true });
		writeFileSync(`${file}.tmp`, `${JSON.stringify(checks, null, 1)}\n`, { mode: 0o600 });
		renameSync(`${file}.tmp`, file);
	} catch {
		// Only a hint for the list: without it, a conversation may be offered as changed once more.
	}
}

/** Whether a conversation changed after it was imported, from what it looks like now. */
function changedSince(origin: ImportOrigin, stamp: string | undefined, modified: string, checked?: string): boolean {
	if (stamp !== undefined && stamp === checked) return false;
	if (origin.stamp !== undefined) return stamp !== undefined && stamp !== origin.stamp;
	// Imported before stamps were kept: written to after the import.
	return modified > origin.importedAt;
}

/** The conversations Claude Code, Codex and ZCode keep on this machine, the most recently changed first. */
export function listConversations(options: ListOptions = {}): FoundConversation[] {
	const claudeProjects = options.claudeProjects ?? claudeProjectsDir();
	const codexSessions = options.codexSessions ?? codexSessionsDir();
	const candidates: { tool: ImportTool; path: string }[] = [];
	// Claude Code: one folder per project, transcripts at its top (sub-agents are in folders below).
	let projects: string[] = [];
	try {
		projects = readdirSync(claudeProjects).sort();
	} catch {}
	for (const project of projects) {
		for (const path of jsonlFiles(join(claudeProjects, project), 0)) candidates.push({ tool: "claude-code", path });
	}
	for (const path of jsonlFiles(codexSessions, 4)) candidates.push({ tool: "codex", path });

	const imports = options.store ? findImports(options.store) : [];
	const checks = options.store ? readChecks(options.store) : {};
	const earlier = (tool: ImportTool, id: string, path: string) => findImport(imports, tool, id, path);
	const mark = (found: ImportedSession | undefined, stamp: string | undefined, modified: string) =>
		found
			? {
					importedAs: found.sessionFile,
					...(changedSince(found.origin, stamp, modified, checks[found.origin.source])
						? { changed: true as const }
						: {}),
				}
			: {};

	const conversations: FoundConversation[] = [];
	for (const { tool, path } of candidates) {
		let size: number;
		let modified: string;
		try {
			const stats = statSync(path);
			size = stats.size;
			modified = stats.mtime.toISOString();
		} catch {
			continue;
		}
		let described: Described;
		try {
			described = tool === "codex" ? describeCodex(path) : describeClaudeCode(path);
		} catch {
			continue;
		}
		if (described.subAgent && !options.subAgents) continue;
		if (options.cwd && !(described.cwd && sameFolder(described.cwd, options.cwd))) continue;
		const found = earlier(tool, described.id, path);
		conversations.push({ tool, path, ...described, modified, size, ...mark(found, fileStamp(path), modified) });
	}
	for (const zcode of listZcode(options.zcodeDatabase ?? zcodeDatabase(), { subAgents: options.subAgents })) {
		if (options.cwd && !(zcode.cwd && sameFolder(zcode.cwd, options.cwd))) continue;
		const { source, stamp, ...described } = zcode;
		const found = earlier("zcode", zcode.id, source);
		conversations.push({ tool: "zcode", path: source, ...described, ...mark(found, stamp, zcode.modified) });
	}
	return conversations.sort((a, b) => b.modified.localeCompare(a.modified));
}

// ---------------------------------------------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------------------------------------------

export interface ImportOptions extends SessionStore, Omit<ReadOptions, "sessionId"> {}

type Written = {
	source: string;
	tool: ImportTool;
	sessionFile: string;
	sessionId: string;
	name: string;
	cwd: string;
	counts: ImportCounts;
};

export type ImportResult =
	| ({
			status: "imported" /** The earlier import of it, which went on in mu and was left as it was. */;
			earlier?: string;
	  } & Written)
	| ({ status: "updated" /** What the session held before. */; before: ImportCounts } & Written)
	| { status: "already-imported"; source: string; tool: ImportTool; sessionFile: string; sessionId: string }
	| { status: "failed"; source: string; error: string };

export const NOT_A_TRANSCRIPT = "not a Claude Code, Codex or ZCode transcript";

function read(tool: ImportTool, source: string, options: ReadOptions): Promise<ConvertedTranscript> {
	if (tool === "zcode") return readZcode(source, options);
	return tool === "codex" ? readCodex(source, options) : readClaudeCode(source, options);
}

/** One transcript as a pi session, without writing anything. */
export async function convertTranscript(path: string, options: ReadOptions = {}): Promise<ConvertedTranscript> {
	const zcode = parseZcodeSource(path);
	const source = zcode ? zcodeSource(zcode.database, zcode.id) : absolute(path);
	const tool = detectTool(source);
	if (!tool) throw new Error(NOT_A_TRANSCRIPT);
	return read(tool, source, options);
}

/** The entries of a session file after the ones the import wrote: what happened to it in mu since. */
function laterEntries(file: string, origin: ImportOrigin): Record<string, unknown>[] | undefined {
	const written = origin.counts?.entries;
	if (!written) return undefined;
	let lines: string[];
	try {
		lines = readFileSync(file, "utf8").split("\n");
	} catch {
		return undefined;
	}
	const later: Record<string, unknown>[] = [];
	for (const line of lines.slice(written + 1)) {
		if (!line.trim()) continue;
		try {
			const entry = record(JSON.parse(line) as unknown);
			if (entry) later.push(entry);
		} catch {}
	}
	return later;
}

/** What only changes how mu runs the session (its name, model, thinking level, a mode), not the conversation. */
const SETTINGS_ENTRIES: ReadonlySet<string> = new Set([
	"session_info",
	"model_change",
	"thinking_level_change",
	"custom",
	"label",
]);

/**
 * The session's entries brought up to date, when nobody went on with it in mu: the new import, then what mu wrote
 * after the earlier one that is only settings (a new name, a model), hung after the new import's last entry.
 * Undefined when the session went on in mu.
 */
function updatedEntries(earlier: ImportedSession, converted: ConvertedTranscript): FileEntry[] | undefined {
	const later = laterEntries(earlier.sessionFile, earlier.origin);
	if (!later || later.some((entry) => !SETTINGS_ENTRIES.has(String(entry.type)))) return undefined;
	const entries = [...converted.entries];
	const ids = new Set(later.map((entry) => entry.id));
	let leaf = (entries.at(-1) as { id?: string }).id ?? null;
	for (const entry of later) {
		const parentId = typeof entry.parentId === "string" && ids.has(entry.parentId) ? entry.parentId : leaf;
		entries.push({ ...entry, parentId } as unknown as FileEntry);
		leaf = String(entry.id);
	}
	return entries;
}

/** Whether a new import says what the earlier one said: the same conversation, nothing new in it. */
function sameAs(earlier: ImportOrigin, converted: ConvertedTranscript): boolean {
	const digest = record(record(converted.entries[1])?.details)?.digest;
	if (earlier.digest !== undefined) return earlier.digest === digest;
	// An import from before digests were kept: as many messages either way.
	const before = earlier.counts;
	const after = converted.counts;
	return before?.user === after.user && before.assistant === after.assistant && before.toolCalls === after.toolCalls;
}

async function importOne(
	path: string,
	options: ImportOptions,
	imports: ImportedSession[],
	checks: Checks,
): Promise<ImportResult> {
	const zcode = parseZcodeSource(path);
	const source = zcode ? zcodeSource(zcode.database, zcode.id) : absolute(path);
	const failed = (error: string): ImportResult => ({ status: "failed", source, error });
	try {
		if (!statSync(zcode ? zcode.database : source).isFile()) return failed("not a file");
	} catch {
		return failed("no such file");
	}
	const already = (tool: ImportTool, earlier: ImportedSession): ImportResult => ({
		status: "already-imported",
		source,
		tool,
		sessionFile: earlier.sessionFile,
		sessionId: earlier.sessionId,
	});
	try {
		const tool = detectTool(source);
		if (!tool) return failed(NOT_A_TRANSCRIPT);
		// Recognised from the first lines when possible: a Codex rollout can be gigabytes.
		const quick = zcode ? zcode.id : (tool === "codex" ? describeCodex(source) : describeClaudeCode(source)).id;
		let earlier = findImport(imports, tool, quick, source);
		if (earlier?.origin.stamp !== undefined && earlier.origin.stamp === (zcode ? undefined : fileStamp(source)))
			return already(tool, earlier);
		const readOptions = (keep?: ImportedSession): ReadOptions => ({
			cwd: options.cwd,
			now: options.now,
			...(options.model ? { model: options.model } : {}),
			...(keep ? { sessionId: keep.sessionId } : {}),
		});
		let converted = await read(tool, source, readOptions(earlier));
		if (!earlier) {
			earlier = findImport(imports, tool, converted.sourceId, source);
			if (earlier) converted = await read(tool, source, readOptions(earlier));
		}
		if (earlier && sameAs(earlier.origin, converted)) {
			const stamp = record(record(converted.entries[1])?.details)?.stamp;
			if (typeof stamp === "string") checks[source] = stamp;
			return already(tool, earlier);
		}
		if (!converted.hasConversation) return failed("no messages in this transcript");
		const written: Written = {
			source,
			tool,
			sessionFile: "",
			sessionId: converted.sessionId,
			name: converted.name,
			cwd: converted.cwd,
			counts: converted.counts,
		};
		const update = earlier ? updatedEntries(earlier, converted) : undefined;
		const origin = record(converted.entries[1])?.details as unknown as ImportOrigin;
		if (earlier && update) {
			replaceSessionFile(earlier.sessionFile, update);
			const before = earlier.origin.counts;
			imports.splice(imports.indexOf(earlier), 1, { ...earlier, origin });
			return { status: "updated", ...written, sessionFile: earlier.sessionFile, before };
		}
		// Went on in mu as well: a session of its own, with an id of its own.
		if (earlier) converted = await read(tool, source, readOptions());
		const dir = sessionDirFor(converted.cwd, options);
		mkdirSync(dir, { recursive: true });
		const sessionFile = join(dir, sessionFileName(converted.started, converted.sessionId));
		writeSessionFile(sessionFile, converted.entries);
		imports.push({
			sessionFile,
			sessionId: converted.sessionId,
			origin: record(converted.entries[1])?.details as unknown as ImportOrigin,
		});
		return {
			status: "imported",
			...written,
			sessionId: converted.sessionId,
			sessionFile,
			...(earlier ? { earlier: earlier.sessionFile } : {}),
		};
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Imports each transcript into the store. One imported before is brought up to date, or left as it is when nothing
 * changed; one that cannot be read is said so and skipped.
 */
export async function importTranscripts(paths: readonly string[], options: ImportOptions): Promise<ImportResult[]> {
	const imports = findImports(options);
	const checks = readChecks(options);
	const before = JSON.stringify(checks);
	const results: ImportResult[] = [];
	for (const path of paths) results.push(await importOne(path, options, imports, checks));
	if (JSON.stringify(checks) !== before) writeChecks(options, checks);
	return results;
}
