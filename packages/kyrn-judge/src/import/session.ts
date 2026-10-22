/**
 * Writing a pi session from another tool's transcript. The converters (claude-code.ts, codex.ts) read their format
 * and call the builder in the order things happened; the builder keeps pi's rules: tool results follow the assistant
 * message that asked for them, nothing else comes between a call and its result, and every call ends with a result.
 *
 * Only node: built-ins at run time (the pi imports are types), so that `mu import` runs on a bare Node.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
	AssistantMessage,
	ImageContent,
	JsonObject,
	JsonValue,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	CompactionEntry,
	CustomMessageEntry,
	FileEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionHeader,
	SessionInfoEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { readHead, record, str } from "./jsonl.ts";

export type ImportTool = "claude-code" | "codex" | "zcode";

export const TOOL_NAMES: Readonly<Record<ImportTool, string>> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	zcode: "ZCode",
};

export const isImportTool = (value: unknown): value is ImportTool =>
	typeof value === "string" && Object.hasOwn(TOOL_NAMES, value);

/** The first entry of every imported session: where it came from. Shown in the transcript, read by the model. */
export const IMPORT_MARKER = "mu.import";
/** What the other tool put in front of its model besides the conversation (notices, command output): kept, not shown. */
export const IMPORT_CONTEXT = "mu.import.context";

/** pi's session format version (CURRENT_SESSION_VERSION). */
const SESSION_VERSION = 3;

/** A tool result longer than this keeps its beginning and its end: one result must not fill a model's whole context. */
export const MAX_RESULT_CHARS = 100_000;

export const IMAGE_MARKER = "(image not imported)";
/** An image larger than this (base64 characters) is not imported: no model takes one that size. */
export const MAX_IMAGE_CHARS = 7 * 1024 * 1024;
/** The images of one conversation together, at most: the latest are kept, the earlier ones become IMAGE_MARKER. */
export const MAX_IMAGES_CHARS = 48 * 1024 * 1024;
/** The image types models take. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const NO_RESULT = "No result was recorded for this call.";

export interface ImportCounts {
	/** Lines read from the transcript, parsed or not. */
	records: number;
	/** Entries written, not counting the session header. */
	entries: number;
	user: number;
	assistant: number;
	toolCalls: number;
	toolResults: number;
	/** Thinking blocks, shown in the transcript and never sent to a model (pi drops another model's thinking). */
	thinking: number;
	/** Images imported with their data. */
	images: number;
	/** Hidden context messages (IMPORT_CONTEXT). */
	context: number;
	compactions: number;
	/** Calls that had no result in the transcript and got NO_RESULT. */
	missingResults: number;
	/** Tool results and context cut to MAX_RESULT_CHARS. */
	truncated: number;
	/** Blocks of a shape pi has no place for, kept as text (unknownBlockText). */
	asText: number;
	/** What was left out, by reason. */
	dropped: Record<string, number>;
}

/** The marker's details: enough to recognise the same transcript when it is offered again. */
export interface ImportOrigin {
	version: 1;
	tool: ImportTool;
	/** The transcript's absolute path. */
	source: string;
	/** The tool's own id for the conversation; empty when the transcript has none. */
	sourceId: string;
	importedAt: string;
	model?: string;
	/** What the transcript looked like on disk when it was imported (sourceStamp): a change means it may have grown. */
	stamp?: string;
	/** The imported conversation's fingerprint: an import of a grown transcript differs, one of the same does not. */
	digest?: string;
	counts: ImportCounts;
}

export function emptyCounts(): ImportCounts {
	return {
		records: 0,
		entries: 0,
		user: 0,
		assistant: 0,
		toolCalls: 0,
		toolResults: 0,
		thinking: 0,
		images: 0,
		context: 0,
		compactions: 0,
		missingResults: 0,
		truncated: 0,
		asText: 0,
		dropped: {},
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Ids and places
// ---------------------------------------------------------------------------------------------------------------

/** A version 7 UUID, as pi gives its sessions: time-ordered, here by the conversation's own start. */
export function uuidv7(ms: number = Date.now()): string {
	const bytes = randomBytes(16);
	let time = Math.max(0, Math.floor(ms));
	for (let index = 5; index >= 0; index--) {
		bytes[index] = time % 256;
		time = Math.floor(time / 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function expand(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** An absolute path, the way pi resolves the session paths it is given (`~` expanded). */
export function absolute(path: string, base: string = process.cwd()): string {
	const expanded = expand(path);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/** pi's folder for a project's sessions: `<agent dir>/sessions/--<cwd with / as ->--` (getDefaultSessionDir). */
export function defaultSessionDir(cwd: string, agentDir: string): string {
	const safe = `--${absolute(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(absolute(agentDir), "sessions", safe);
}

/** Where pi keeps sessions: one folder per project under `<agent dir>/sessions`, or all in one custom folder. */
export interface SessionStore {
	agentDir: string;
	/** pi's `sessionDir` setting or MU_CODING_AGENT_SESSION_DIR: every session in this one folder. */
	sessionDir?: string;
}

export function sessionDirFor(cwd: string, store: SessionStore): string {
	return store.sessionDir ? absolute(store.sessionDir) : defaultSessionDir(cwd, store.agentDir);
}

/** The folder whose sessions are searched for an earlier import of the same transcript. */
export function sessionsRoot(store: SessionStore): string {
	return store.sessionDir ? absolute(store.sessionDir) : join(absolute(store.agentDir), "sessions");
}

/** pi's file name: `<start time with : and . as ->_<id>.jsonl`. */
export function sessionFileName(started: string, id: string): string {
	return `${started.replace(/[:.]/g, "-")}_${id}.jsonl`;
}

// ---------------------------------------------------------------------------------------------------------------
// Earlier imports
// ---------------------------------------------------------------------------------------------------------------

export interface ImportedSession {
	sessionFile: string;
	sessionId: string;
	origin: ImportOrigin;
}

/** The origin of an imported session file, read from its first two lines; undefined for any other session. */
export function readOrigin(file: string): { sessionId: string; origin: ImportOrigin } | undefined {
	let header: Record<string, unknown> | undefined;
	let marker: Record<string, unknown> | undefined;
	try {
		readHead(
			file,
			(value) => {
				if (!header) {
					header = record(value);
					return header?.type !== "session";
				}
				marker = record(value);
				return true;
			},
			256 * 1024,
		);
	} catch {
		return undefined;
	}
	const details = record(marker?.details);
	if (marker?.type !== "custom_message" || marker.customType !== IMPORT_MARKER || !details) return undefined;
	if (!isImportTool(details.tool)) return undefined;
	if (typeof details.source !== "string") return undefined;
	return { sessionId: str(header?.id) ?? "", origin: details as unknown as ImportOrigin };
}

/** Every session under the store that was imported, found by the marker in its second line. */
export function findImports(store: SessionStore): ImportedSession[] {
	const files: string[] = [];
	const scan = (dir: string, depth: number) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(dir, name);
			if (name.endsWith(".jsonl")) files.push(path);
			else if (depth > 0) {
				try {
					if (statSync(path).isDirectory()) scan(path, depth - 1);
				} catch {}
			}
		}
	};
	scan(sessionsRoot(store), 1);
	const found: ImportedSession[] = [];
	for (const file of files) {
		const read = readOrigin(file);
		if (read) found.push({ sessionFile: file, sessionId: read.sessionId, origin: read.origin });
	}
	return found;
}

/** The latest import of this transcript: the same tool and conversation id, or the same file. */
export function findImport(
	imports: readonly ImportedSession[],
	tool: ImportTool,
	sourceId: string,
	source: string,
): ImportedSession | undefined {
	let latest: ImportedSession | undefined;
	for (const found of imports) {
		if (found.origin.tool !== tool) continue;
		if (!((sourceId !== "" && found.origin.sourceId === sourceId) || found.origin.source === source)) continue;
		if (!latest || String(found.origin.importedAt) > String(latest.origin.importedAt)) latest = found;
	}
	return latest;
}

// ---------------------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------------------

/** The first line a person wrote, for a session name or a listing: one line, at most `max` characters. */
export function firstLine(text: string, max = 80): string {
	const line =
		text
			.split(/\r?\n/)
			.map((part) => part.replace(/\s+/g, " ").trim())
			.find((part) => part.length > 0) ?? "";
	const chars = Array.from(line);
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
}

/** A long text keeps its beginning and its end, with the cut said in between. */
export function clip(text: string, max = MAX_RESULT_CHARS): { text: string; cut: boolean } {
	if (text.length <= max) return { text, cut: false };
	const head = Math.floor(max * 0.6);
	const tail = max - head;
	const left = text.length - head - tail;
	return {
		text: `${text.slice(0, head)}\n\n[… ${left} characters not imported …]\n\n${text.slice(text.length - tail)}`,
		cut: true,
	};
}

/** A slash command as the tool wrote it (`<command-name>` tags), as the person typed it; undefined for other text. */
export function commandText(text: string): string | undefined {
	const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
	if (!name) return undefined;
	const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
	const command = name.startsWith("/") ? name : `/${name}`;
	return args ? `${command} ${args}` : command;
}

/** A shell command typed with `!` (`<bash-input>`): the command, and what it printed for the model to read. */
export function shellText(text: string): { command: string; output: string } | undefined {
	const command = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)?.[1];
	if (command === undefined) return undefined;
	const output = text.replace(/<bash-input>[\s\S]*?<\/bash-input>/, "").trim();
	return { command: command.trim(), output };
}

/** Setup the other tool gave its model (its instructions, the environment): mu gives its own, so these are left out. */
const SETUP_TAGS = new Set([
	"environment_context",
	"user_instructions",
	"in-app-browser-context",
	"codex_internal_context",
	"recommended_plugins",
	"permissions instructions",
	"collaboration_mode",
	"multi_agent_mode",
	"multi_agent_role",
	"skills_instructions",
	"plugins_instructions",
	"apps_instructions",
	"app-context",
	"image_resize_notice",
	"model_switch",
	"INSTRUCTIONS",
]);

/** Notices the tool put in the conversation for its model (task results, reminders, command output): kept as context. */
const CONTEXT_TAGS = new Set([
	"task-notification",
	"subagent_notification",
	"system-reminder",
	"local-command-stdout",
	"local-command-stderr",
	"local-command-caveat",
	"bash-stdout",
	"bash-stderr",
	"turn_aborted",
	"heartbeat",
]);

export type UserTextKind = "user" | "context" | "setup";

/** Whether a user-role text is the person's own words, a notice for the model, or the tool's own setup. */
export function classifyUserText(text: string): UserTextKind {
	if (/^\s*\[Request interrupted by user/.test(text)) return "context";
	const tag = /^\s*<([A-Za-z][\w-]*(?: [\w-]+)?)>/.exec(text)?.[1];
	if (!tag) return "user";
	if (SETUP_TAGS.has(tag)) return "setup";
	if (CONTEXT_TAGS.has(tag)) return "context";
	return "user";
}

/** Tool-call arguments as pi keeps them: an object. A string that is not a JSON object is kept whole. */
export function toolArguments(raw: unknown): JsonObject {
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as unknown;
			const object = record(parsed);
			return object ? (object as JsonObject) : { value: parsed as JsonValue };
		} catch {
			return { input: raw };
		}
	}
	const object = record(raw);
	if (object) return object as JsonObject;
	return raw === undefined || raw === null ? {} : { value: raw as JsonValue };
}

/** A block this importer does not know, kept readable: its type and its fields as JSON, shortened. */
export function unknownBlockText(block: Record<string, unknown>): string {
	const { type, ...rest } = block;
	let json: string;
	try {
		json = JSON.stringify(rest);
	} catch {
		json = "";
	}
	return `[${typeof type === "string" ? type : "block"}] ${clip(json, 2000).text}`.trim();
}

// ---------------------------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------------------------

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Item =
	| { kind: "message"; message: SessionMessageEntry["message"]; at: number; key?: string }
	| { kind: "context"; text: string; at: number; key?: string }
	| { kind: "compaction"; summary: string; tokensBefore: number; at: number; keepFrom: readonly string[] };

export type AssistantBlock = TextContent | ThinkingContent | ToolCall;
/** What a person's message or a tool result holds. */
export type ContentBlock = TextContent | ImageContent;

/** An image whose data the transcript does not hold, or not in a form a model takes: imported as IMAGE_MARKER. */
export const IMAGE: ImageContent = { type: "image", data: "", mimeType: "image/png" };

/** An image from its type and base64 data; IMAGE when either is missing or the type is not one models take. */
export function imageOf(mimeType: unknown, data: unknown): ImageContent {
	if (typeof mimeType !== "string" || typeof data !== "string" || data.length === 0) return IMAGE;
	const type = mimeType.toLowerCase() === "image/jpg" ? "image/jpeg" : mimeType.toLowerCase();
	return IMAGE_TYPES.has(type) ? { type: "image", data, mimeType: type } : IMAGE;
}

/** An image given as a `data:` URL, as Codex and ZCode keep them; IMAGE for any other URL. */
export function imageFromUrl(url: unknown): ImageContent {
	if (typeof url !== "string") return IMAGE;
	const head = /^data:([^;,]+);base64,/i.exec(url.slice(0, 200));
	return head ? imageOf(head[1], url.slice(head[0].length)) : IMAGE;
}

export interface AssistantInput {
	blocks: AssistantBlock[];
	model: string;
	at: number;
	stopReason?: StopReason;
	/** A failed request the tool recorded as a message: kept as pi's error message, never replayed to a model. */
	error?: string;
	key?: string;
}

export interface ToolResultInput {
	id: string;
	/** The call's name when the format carries it; otherwise the name of the call with this id. */
	name?: string;
	content: ContentBlock[] | string;
	isError: boolean;
	at: number;
	key?: string;
}

/** An entry id that is the same each time the same transcript is imported: the hash of the session, a key and a count. */
function stableId(seed: string, taken: Set<string>): string {
	const hash = createHash("sha256").update(seed).digest("hex");
	for (let start = 0; start + 8 <= hash.length; start += 8) {
		const id = hash.slice(start, start + 8);
		if (!taken.has(id)) {
			taken.add(id);
			return id;
		}
	}
	const id = randomUUID();
	taken.add(id);
	return id;
}

export class SessionBuilder {
	readonly tool: ImportTool;
	readonly counts: ImportCounts = emptyCounts();
	private items: Item[] = [];
	/** Messages that arrived while calls were still waiting for their results. */
	private held: Item[] = [];
	/** Calls of the last assistant message without a result yet, by id. */
	private pending = new Map<string, string>();
	/** Every call seen, by id: a result may name its call only by the id. */
	private calls = new Map<string, string>();
	private answered = new Set<string>();

	constructor(tool: ImportTool) {
		this.tool = tool;
	}

	drop(reason: string, count = 1): void {
		if (count <= 0) return;
		this.counts.dropped[reason] = (this.counts.dropped[reason] ?? 0) + count;
	}

	/** Whether anything a person said or a model answered is in it: a transcript without either is not imported. */
	get hasConversation(): boolean {
		return this.counts.user + this.counts.assistant > 0;
	}

	/** Text and images as they were; an image without its data, or larger than any model takes, says so instead. */
	private blocksOf(content: ContentBlock[] | string): ContentBlock[] {
		if (typeof content === "string") return [{ type: "text", text: content }];
		const blocks: ContentBlock[] = [];
		for (const block of content) {
			if (block.type === "text") blocks.push({ type: "text", text: block.text });
			else if (block.data.length > 0 && block.data.length <= MAX_IMAGE_CHARS) blocks.push(block);
			else {
				this.drop("images");
				blocks.push({ type: "text", text: IMAGE_MARKER });
			}
		}
		return blocks;
	}

	private clipped(text: string): string {
		const cut = clip(text);
		if (cut.cut) this.counts.truncated++;
		return cut.text;
	}

	private push(item: Item): void {
		const waits = item.kind === "context" || (item.kind === "message" && item.message.role === "user");
		if (this.pending.size > 0 && waits) this.held.push(item);
		else this.items.push(item);
	}

	private lastTime(): number {
		return this.items.at(-1)?.at ?? 0;
	}

	/** Calls still without a result get one that says so, and whatever waited behind them follows. */
	private settle(): void {
		for (const [id, name] of this.pending) {
			this.counts.missingResults++;
			this.answered.add(id);
			const at = this.lastTime();
			this.items.push({
				kind: "message",
				at,
				message: {
					role: "toolResult",
					toolCallId: id,
					toolName: name,
					content: [{ type: "text", text: NO_RESULT }],
					isError: true,
					timestamp: at,
				},
			});
		}
		this.pending.clear();
		this.items.push(...this.held);
		this.held = [];
	}

	user(content: ContentBlock[] | string, at: number, key?: string): void {
		const blocks = this.blocksOf(content).filter((block) => block.type === "image" || block.text.length > 0);
		if (blocks.length === 0) return;
		this.counts.user++;
		this.push({
			kind: "message",
			at,
			key,
			message: { role: "user", content: typeof content === "string" ? content : blocks, timestamp: at },
		});
	}

	/** Something the other tool showed its model that nobody typed: kept for the model, hidden from the transcript. */
	context(text: string, at: number, key?: string): void {
		if (!text.trim()) return;
		this.counts.context++;
		this.push({ kind: "context", text: this.clipped(text), at, key });
	}

	assistant(input: AssistantInput): void {
		this.settle();
		const unread = input.blocks.filter((block) => block.type === "thinking" && !block.thinking.trim()).length;
		// Claude Code keeps only the signature of most thinking now: nothing there to read.
		this.drop("unreadable thinking", unread);
		let blocks = input.blocks.filter((block) =>
			block.type === "toolCall"
				? true
				: block.type === "text"
					? block.text.length > 0
					: block.thinking.trim().length > 0,
		);
		// Thinking alone is no answer: a model is never sent another model's thinking, so it would be an empty one.
		if (blocks.every((block) => block.type === "thinking")) {
			this.drop("thinking without an answer", blocks.length);
			blocks = [];
		}
		if (blocks.length === 0 && !input.error) return;
		const calls = blocks.filter((block): block is ToolCall => block.type === "toolCall");
		const message: AssistantMessage = {
			role: "assistant",
			content: input.error ? [] : blocks,
			api: this.tool,
			provider: this.tool,
			model: input.model || "unknown",
			usage: ZERO_USAGE,
			stopReason: input.error ? "error" : (input.stopReason ?? (calls.length > 0 ? "toolUse" : "stop")),
			...(input.error ? { errorMessage: input.error } : {}),
			timestamp: input.at,
		};
		this.counts.assistant++;
		this.items.push({ kind: "message", message, at: input.at, key: input.key });
		if (input.error) return;
		this.counts.thinking += blocks.filter((block) => block.type === "thinking").length;
		for (const call of calls) {
			this.counts.toolCalls++;
			this.calls.set(call.id, call.name);
			this.pending.set(call.id, call.name);
		}
	}

	toolResult(input: ToolResultInput): void {
		const name = input.name || this.calls.get(input.id) || "unknown";
		const blocks = this.blocksOf(input.content);
		if (!this.pending.has(input.id)) {
			if (this.answered.has(input.id)) {
				this.drop("repeated tool results");
				return;
			}
			// No call before it (the call was on a branch that was not taken, or before a cut): the result stays readable.
			this.drop("tool results without their call, kept as context");
			const text = blocks.map((block) => {
				if (block.type === "text") return block.text;
				this.drop("images");
				return IMAGE_MARKER;
			});
			this.context(`[Result of an earlier ${name} call]\n${text.join("\n")}`, input.at);
			return;
		}
		const content = blocks.map((block) =>
			block.type === "text" ? { type: "text" as const, text: this.clipped(block.text) } : block,
		);
		this.pending.delete(input.id);
		this.answered.add(input.id);
		this.counts.toolResults++;
		this.items.push({
			kind: "message",
			at: input.at,
			key: input.key,
			message: {
				role: "toolResult",
				toolCallId: input.id,
				toolName: name,
				content: content.length > 0 ? content : [{ type: "text", text: "" }],
				isError: input.isError,
				timestamp: input.at,
			},
		});
		if (this.pending.size === 0) {
			this.items.push(...this.held);
			this.held = [];
		}
	}

	/**
	 * The other tool compacted the conversation here: from now on its model saw the summary instead of what came
	 * before. `keepFrom` lists, in order, the items the tool kept word for word after its summary (Claude Code's
	 * preserved segment); the first of them that was imported is where pi's kept part starts.
	 */
	compaction(summary: string, tokensBefore: number, at: number, keepFrom: readonly string[] = []): void {
		if (!summary.trim()) return;
		this.settle();
		this.counts.compactions++;
		this.items.push({ kind: "compaction", summary, tokensBefore, at, keepFrom });
	}

	/**
	 * Images take MAX_IMAGES_CHARS at most, the latest first: they are what the conversation goes on from. An earlier
	 * one past that becomes IMAGE_MARKER.
	 */
	private budgetImages(): void {
		let left = MAX_IMAGES_CHARS;
		for (let index = this.items.length - 1; index >= 0; index--) {
			const item = this.items[index];
			if (item.kind !== "message") continue;
			const message = item.message;
			if (message.role !== "user" && message.role !== "toolResult") continue;
			if (typeof message.content === "string") continue;
			const content = message.content;
			if (!content.some((block) => block.type === "image")) continue;
			const kept: ContentBlock[] = [];
			for (let at = content.length - 1; at >= 0; at--) {
				const block = content[at];
				if (block.type !== "image") kept.unshift(block);
				else if (block.data.length <= left) {
					left -= block.data.length;
					this.counts.images++;
					kept.unshift(block);
				} else {
					this.drop("images");
					kept.unshift({ type: "text", text: IMAGE_MARKER });
				}
			}
			message.content = kept;
		}
	}

	/** The session file's lines: header, marker, name, then the conversation as one chain. */
	finish(input: {
		sessionId: string;
		cwd: string;
		started: string;
		name: string;
		origin: Omit<ImportOrigin, "counts">;
		note: string;
		model?: SessionModel;
	}): FileEntry[] {
		this.settle();
		this.budgetImages();
		// The same transcript gives the same ids, so that an import brought up to date (its session id kept) keeps them.
		const taken = new Set<string>();
		const seen = new Map<string, number>();
		const newId = (key: string): string => {
			const times = seen.get(key) ?? 0;
			seen.set(key, times + 1);
			return stableId(`${input.sessionId}\n${key}\n${times}`, taken);
		};
		const startedAt = Date.parse(input.started);
		const iso = (at: number): string => new Date(at > 0 ? at : startedAt).toISOString();
		const ids = this.items.map((item, index) =>
			newId(item.kind === "compaction" ? `compaction ${index}` : (item.key ?? `item ${index}`)),
		);
		const byKey = new Map<string, number>();
		this.items.forEach((item, index) => {
			if (item.kind !== "compaction" && item.key && !byKey.has(item.key)) byKey.set(item.key, index);
		});
		// Neither a model nor pi's transcript view shows what came before the last compaction, apart from its summary:
		// the marker is repeated after it.
		let lastCompaction = -1;
		this.items.forEach((item, index) => {
			if (item.kind === "compaction") lastCompaction = index;
		});
		this.counts.entries = this.items.length + 2 + (lastCompaction >= 0 ? 1 : 0) + (input.model ? 1 : 0);
		const digest = createHash("sha256").update(JSON.stringify(this.items)).digest("hex").slice(0, 32);

		const header: SessionHeader = {
			type: "session",
			version: SESSION_VERSION,
			id: input.sessionId,
			timestamp: input.started,
			cwd: input.cwd,
		};
		const marker: CustomMessageEntry<ImportOrigin> = {
			type: "custom_message",
			id: newId("marker"),
			parentId: null,
			timestamp: input.started,
			customType: IMPORT_MARKER,
			content: input.note,
			display: true,
			details: { ...input.origin, digest, counts: this.counts },
		};
		const info: SessionInfoEntry = {
			type: "session_info",
			id: newId("name"),
			parentId: marker.id,
			timestamp: input.started,
			name: input.name.replace(/[\r\n]+/g, " ").trim(),
		};
		const entries: SessionEntry[] = [marker, info];
		let parentId = info.id;
		this.items.forEach((item, index) => {
			const id = ids[index];
			const timestamp = iso(item.at);
			if (item.kind === "message") {
				entries.push({ type: "message", id, parentId, timestamp, message: item.message });
			} else if (item.kind === "context") {
				const context: CustomMessageEntry = {
					type: "custom_message",
					id,
					parentId,
					timestamp,
					customType: IMPORT_CONTEXT,
					content: item.text,
					display: false,
				};
				entries.push(context);
			} else {
				// pi keeps the entries from firstKeptEntryId up to the compaction; an id that is not before it keeps none.
				const kept = item.keepFrom.map((key) => byKey.get(key)).find((at) => at !== undefined);
				const firstKeptEntryId =
					kept !== undefined && kept < index
						? ids[kept]
						: index + 1 < ids.length
							? ids[index + 1]
							: newId("after the last compaction");
				const compaction: CompactionEntry = {
					type: "compaction",
					id,
					parentId,
					timestamp,
					summary: item.summary,
					firstKeptEntryId,
					tokensBefore: item.tokensBefore,
				};
				entries.push(compaction);
			}
			parentId = id;
			if (index === lastCompaction) {
				const again: CustomMessageEntry<ImportOrigin> = {
					...marker,
					id: newId("marker again"),
					parentId,
					timestamp,
				};
				entries.push(again);
				parentId = again.id;
			}
		});
		// pi resumes a session with the model of its last reply, here the other tool's: mu's own model is named after it.
		if (input.model) {
			const change: ModelChangeEntry = {
				type: "model_change",
				id: newId("model"),
				parentId,
				timestamp: input.origin.importedAt,
				provider: input.model.provider,
				modelId: input.model.modelId,
			};
			entries.push(change);
		}
		return [header, ...entries];
	}
}

// ---------------------------------------------------------------------------------------------------------------
// One transcript, converted
// ---------------------------------------------------------------------------------------------------------------

export interface ReadOptions {
	/** Used when the transcript names no working directory. Default: this process's. */
	cwd?: string;
	now?: Date;
	/** The session's id: an import brought up to date keeps the one it had. Default: a new one. */
	sessionId?: string;
	/**
	 * The model mu goes on with (its default, or the session's that imports): named after the imported replies, which
	 * name the other tool's. Without one, mu takes its default when the conversation goes on.
	 */
	model?: SessionModel;
}

/** A model as pi's `model_change` names it. */
export type SessionModel = { provider: string; modelId: string };

/** A file as it is on disk now, to tell later whether it changed: its size and when it was last written. */
export function fileStamp(path: string): string | undefined {
	try {
		const stats = statSync(path);
		return `${stats.size}:${Math.floor(stats.mtimeMs)}`;
	} catch {
		return undefined;
	}
}

export interface ConvertedTranscript {
	tool: ImportTool;
	source: string;
	sourceId: string;
	sessionId: string;
	cwd: string;
	started: string;
	name: string;
	model?: string;
	counts: ImportCounts;
	/** The session file's lines, header first. */
	entries: FileEntry[];
	/** False when the transcript holds no message at all: nothing is written for it. */
	hasConversation: boolean;
}

/** What the model reads first in an imported session. English, as the rest of what mu tells a model. */
export function importNote(tool: ImportTool, source: string): string {
	const name = TOOL_NAMES[tool];
	return [
		`This conversation was imported from ${name} (${source}) and continues here.`,
		`Its tool calls use ${name}'s tool names, which may differ from the tools available now.`,
	].join(" ");
}

export function complete(
	builder: SessionBuilder,
	input: {
		source: string;
		sourceId: string;
		cwd: string;
		started: string;
		name?: string;
		model?: string;
		/** The transcript as it was when reading began (fileStamp). */
		stamp?: string;
		options: ReadOptions;
	},
): ConvertedTranscript {
	const started = Number.isNaN(Date.parse(input.started)) ? new Date().toISOString() : input.started;
	const sessionId = input.options.sessionId ?? uuidv7(Date.parse(started));
	const name = input.name?.trim() || `${TOOL_NAMES[builder.tool]} conversation`;
	const entries = builder.finish({
		sessionId,
		cwd: input.cwd,
		started,
		name,
		note: importNote(builder.tool, input.source),
		...(input.options.model ? { model: input.options.model } : {}),
		origin: {
			version: 1,
			tool: builder.tool,
			source: input.source,
			sourceId: input.sourceId,
			importedAt: (input.options.now ?? new Date()).toISOString(),
			...(input.model ? { model: input.model } : {}),
			...(input.stamp ? { stamp: input.stamp } : {}),
		},
	});
	return {
		tool: builder.tool,
		source: input.source,
		sourceId: input.sourceId,
		sessionId,
		cwd: input.cwd,
		started,
		name,
		model: input.model,
		counts: builder.counts,
		entries,
		hasConversation: builder.hasConversation,
	};
}

/** Writes the lines to a new file; never replaces one (see replaceSessionFile). */
export function writeSessionFile(file: string, entries: readonly FileEntry[]): void {
	const fd = openSync(file, "wx", 0o600);
	try {
		for (const entry of entries) writeSync(fd, `${JSON.stringify(entry)}\n`);
	} finally {
		closeSync(fd);
	}
}

/** Writes the lines in place of a session file, all at once: a reader sees the old file or the new one. */
export function replaceSessionFile(file: string, entries: readonly FileEntry[]): void {
	const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeSessionFile(temp, entries);
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
