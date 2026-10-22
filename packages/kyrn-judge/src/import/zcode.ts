/**
 * ZCode conversations (Z.ai's coding agent): one SQLite database, `~/.zcode/cli/db/db.sqlite`, with a row per
 * conversation (`session`: its folder, title and kind), per message (`message`, its fields as JSON in `data`) and per
 * piece of a message (`part`: text, reasoning, a tool call with its input, state and output, an attached file, a
 * compaction, a line for the app's timeline). Each message says who may see it (`semantics`): the person, the model,
 * or both. What only the model saw is kept as hidden context, what neither saw is left out.
 *
 * A conversation goes by `<database>#<session id>` (zcodeSource) where the other tools' go by their transcript's path.
 *
 * Messages are read in their order (`sequence`), the parts of one by the time each began: ZCode numbers a tool call
 * before the text that came ahead of it. A rewind (`session.revert`) keeps the messages it names and those written
 * after the cut; a compaction is a summary message (`compact_summary`) after the messages it summed up, which pi keeps
 * before its own compaction entry. A sub-agent's thread and a fork are conversations of their own (a fork holds a copy
 * of what it was forked from).
 *
 * Read with node:sqlite where this Node has it, else with the sqlite3 command. Only node: built-ins at run time.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { list, record, str } from "./jsonl.ts";
import {
	type AssistantBlock,
	absolute,
	type ContentBlock,
	type ConvertedTranscript,
	commandText,
	complete,
	firstLine,
	imageFromUrl,
	type ReadOptions,
	SessionBuilder,
	toolArguments,
} from "./session.ts";

/** Where ZCode keeps its conversations. */
export function zcodeDatabase(home = homedir()): string {
	return join(home, ".zcode", "cli", "db", "db.sqlite");
}

/** A ZCode conversation as a source to import: its database and its id. */
export function zcodeSource(database: string, id: string): string {
	return `${database}#${id}`;
}

export function parseZcodeSource(source: string): { database: string; id: string } | undefined {
	const match = /^(.+\.(?:sqlite3?|db))#([\w.:-]+)$/.exec(source);
	return match ? { database: absolute(match[1]), id: match[2] } : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the database
// ---------------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface Rows {
	all(sql: string, ...params: string[]): Row[];
	close(): void;
}

interface NodeSqlite {
	DatabaseSync: new (
		path: string,
		options?: { readOnly?: boolean; timeout?: number },
	) => { prepare(sql: string): { all(...params: string[]): unknown[] }; close(): void };
}

const load = createRequire(import.meta.url);
let nodeSqlite: NodeSqlite | null | undefined;

/** node:sqlite, without the warning Node prints the first time it loads (it would land in the middle of a terminal UI). */
function sqliteModule(): NodeSqlite | undefined {
	if (nodeSqlite === undefined) {
		const emit = process.emitWarning;
		process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
			if (/sqlite/i.test(typeof warning === "string" ? warning : warning.message)) return;
			(emit as (...args: unknown[]) => void).call(process, warning, ...rest);
		}) as typeof process.emitWarning;
		try {
			nodeSqlite = load("node:sqlite") as NodeSqlite;
		} catch {
			nodeSqlite = null;
		} finally {
			process.emitWarning = emit;
		}
	}
	return nodeSqlite ?? undefined;
}

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** The database, read only. ZCode may be writing it meanwhile: SQLite lets a reader in beside a writer. */
export function openZcode(database: string): Rows {
	statSync(database);
	const sqlite = sqliteModule();
	if (sqlite) {
		const db = new sqlite.DatabaseSync(database, { readOnly: true, timeout: 2000 });
		return {
			all: (sql, ...params) => db.prepare(sql).all(...params) as Row[],
			close: () => db.close(),
		};
	}
	return {
		all: (sql, ...params) => {
			const bound = sql.replace(/\?/g, () => quote(params.shift() ?? ""));
			const out = execFileSync("sqlite3", ["-readonly", "-json", database, bound], {
				encoding: "utf8",
				maxBuffer: 2 * 1024 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			});
			return out.trim() ? (JSON.parse(out) as Row[]) : [];
		},
		close: () => {},
	};
}

function columns(db: Rows, table: string): Set<string> {
	return new Set(db.all(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
}

const json = (value: unknown): Record<string, unknown> => {
	if (typeof value !== "string") return {};
	try {
		return record(JSON.parse(value)) ?? {};
	} catch {
		return {};
	}
};

const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const SESSION_COLUMNS = [
	"id",
	"parent_id",
	"task_type",
	"directory",
	"title",
	"title_source",
	"revert",
	"time_created",
	"time_updated",
	"time_archived",
];

function sessionsSql(db: Rows, where = ""): string {
	const have = columns(db, "session");
	const pick = SESSION_COLUMNS.map((name) => (have.has(name) ? name : `NULL AS ${name}`)).join(", ");
	return `SELECT ${pick} FROM session${where}`;
}

/** Rows in ZCode's order: by `sequence` where the table has it (older databases do not), then by time. */
const order = (db: Rows, table: string, tail: string, prefix = ""): string =>
	columns(db, table).has("sequence")
		? `${prefix}sequence IS NULL, ${prefix}sequence, ${prefix}time_created, ${tail}`
		: `${prefix}time_created, ${tail}`;

/** Threads ZCode started itself: a sub-agent's, or a side chat about a selection. */
const SIDE_THREADS: ReadonlySet<string> = new Set(["subagent_child", "selection_side_chat"]);

// ---------------------------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------------------------

export interface ZcodeConversation {
	id: string;
	source: string;
	cwd?: string;
	title: string;
	started?: string;
	modified: string;
	/** The conversation's rows, in bytes. */
	size: number;
	subAgent: boolean;
	/** Changes when the conversation does (sourceStamp). */
	stamp: string;
}

const iso = (ms: number | undefined): string | undefined => (ms && ms > 0 ? new Date(ms).toISOString() : undefined);

/**
 * ZCode's name for a conversation: one it was given or made up. Its placeholder, and the first message it cut to sixty
 * characters, give way to the first message as mu shows one.
 */
const titleOf = (session: Row): string =>
	session.title_source === "default" || session.title_source === "first_input"
		? ""
		: firstLine(str(session.title) ?? "");

function firstPrompt(db: Rows, id: string): string {
	const rows = db.all(
		`SELECT p.data AS data FROM message m JOIN part p ON p.message_id = m.id
		 WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
		   AND coalesce(json_extract(m.data, '$.semantics.kind'), 'user_prompt') = 'user_prompt'
		   AND json_extract(p.data, '$.type') = 'text'
		 ORDER BY ${order(db, "message", "m.rowid", "m.")} LIMIT 1`,
		id,
	);
	return firstLine(str(json(rows[0]?.data).text) ?? "");
}

/** The conversations in a ZCode database, archived ones left out (as ZCode's list leaves them out). */
export function listZcode(database: string, options: { subAgents?: boolean } = {}): ZcodeConversation[] {
	let db: Rows;
	try {
		db = openZcode(database);
	} catch {
		return [];
	}
	try {
		const sessions = db.all(sessionsSql(db));
		const sizes = new Map<string, { messages: number; bytes: number }>();
		for (const table of ["message", "part"]) {
			for (const row of db.all(
				`SELECT session_id AS id, COUNT(*) AS rows, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM ${table} GROUP BY session_id`,
			)) {
				const id = String(row.id);
				const size = sizes.get(id) ?? { messages: 0, bytes: 0 };
				if (table === "message") size.messages = num(row.rows) ?? 0;
				size.bytes += num(row.bytes) ?? 0;
				sizes.set(id, size);
			}
		}
		const found: ZcodeConversation[] = [];
		for (const session of sessions) {
			const id = str(session.id);
			if (!id || session.time_archived !== null) continue;
			const subAgent = SIDE_THREADS.has(str(session.task_type) ?? "");
			if (subAgent && !options.subAgents) continue;
			const size = sizes.get(id) ?? { messages: 0, bytes: 0 };
			if (size.messages === 0) continue;
			const updated = num(session.time_updated);
			found.push({
				id,
				source: zcodeSource(database, id),
				...(str(session.directory) ? { cwd: str(session.directory) } : {}),
				title: titleOf(session) || firstPrompt(db, id),
				...(iso(num(session.time_created)) ? { started: iso(num(session.time_created)) } : {}),
				modified: iso(updated) ?? new Date(0).toISOString(),
				size: size.bytes,
				subAgent,
				stamp: `${updated ?? 0}:${size.messages}:${size.bytes}`,
			});
		}
		return found;
	} catch {
		return [];
	} finally {
		db.close();
	}
}

// ---------------------------------------------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------------------------------------------

interface Message {
	id: string;
	at: number;
	data: Record<string, unknown>;
	parts: Record<string, unknown>[];
}

/** The messages a rewind left in the conversation: those it kept, and those written after the cut. */
function afterRewind(messages: Message[], revert: Record<string, unknown>): Message[] {
	const target = str(revert.targetMessageID);
	if (!target) return messages;
	const index = (id: unknown) => (typeof id === "string" ? messages.findIndex((message) => message.id === id) : -1);
	const keptIds = list(revert.keptMessageIDs).filter((id): id is string => typeof id === "string");
	const kept = Array.isArray(revert.keptMessageIDs)
		? messages.filter((message) => keptIds.includes(message.id))
		: messages.slice(0, Math.max(0, index(target)));
	const cut = index(revert.branchCutAfterMessageID);
	if (cut >= 0) return [...kept, ...messages.slice(cut + 1)];
	const created = index(revert.createdMessageID);
	if (created >= 0) return [...kept, ...messages.slice(created)];
	return Array.isArray(revert.keptMessageIDs) || index(target) >= 0 ? kept : messages;
}

const textOf = (parts: Record<string, unknown>[]): string =>
	parts
		.filter((part) => part.type === "text")
		.map((part) => str(part.text) ?? "")
		.join("\n")
		.trim();

/** When a part began: its own time, a tool's run, else the message's. */
const startOf = (part: Record<string, unknown>, fallback: number): number =>
	num(record(part.time)?.start) ?? num(record(record(part.state)?.time)?.start) ?? fallback;

/** A tool's output: its text, or its error; images it attached come along. */
function toolOutput(state: Record<string, unknown>): { content: ContentBlock[]; isError: boolean } {
	const isError = state.status === "error";
	const value = isError ? state.error : state.output;
	const text = typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
	const content: ContentBlock[] = [{ type: "text", text }];
	for (const attachment of list(state.attachments).map(record)) {
		if (attachment && String(attachment.mime ?? "").startsWith("image/")) content.push(imageFromUrl(attachment.url));
	}
	return { content, isError };
}

export async function readZcode(sourcePath: string, options: ReadOptions = {}): Promise<ConvertedTranscript> {
	const where = parseZcodeSource(sourcePath);
	if (!where) throw new Error("not a ZCode conversation");
	const source = zcodeSource(where.database, where.id);
	const db = openZcode(where.database);
	let session: Row | undefined;
	let messages: Message[];
	let stamp: string;
	try {
		session = db.all(sessionsSql(db, " WHERE id = ?"), where.id)[0];
		if (!session) throw new Error("no such ZCode conversation");
		const parts = new Map<string, Record<string, unknown>[]>();
		const partRows = db.all(
			`SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY ${order(db, "part", "id")}`,
			where.id,
		);
		const starts = new Map<Record<string, unknown>, number>();
		let bytes = 0;
		for (const row of partRows) {
			const data = json(row.data);
			bytes += String(row.data ?? "").length;
			starts.set(data, startOf(data, num(row.time_created) ?? 0));
			const id = String(row.message_id);
			const own = parts.get(id) ?? [];
			own.push(data);
			parts.set(id, own);
		}
		const messageRows = db.all(
			`SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY ${order(db, "message", "rowid")}`,
			where.id,
		);
		messages = messageRows.map((row) => {
			const data = json(row.data);
			bytes += String(row.data ?? "").length;
			const id = String(row.id);
			const own = parts.get(id) ?? [];
			// Stable: parts that began together keep their numbered order.
			const sorted = own.map((part, index) => ({ part, index }));
			sorted.sort((a, b) => (starts.get(a.part) ?? 0) - (starts.get(b.part) ?? 0) || a.index - b.index);
			return {
				id,
				at: num(record(data.time)?.created) ?? num(row.time_created) ?? 0,
				data,
				parts: sorted.map((each) => each.part),
			};
		});
		stamp = `${num(session.time_updated) ?? 0}:${messageRows.length}:${bytes}`;
	} finally {
		db.close();
	}

	const builder = new SessionBuilder("zcode");
	const { counts } = builder;
	counts.records = messages.length;
	const active = afterRewind(messages, json(session.revert));
	builder.drop("messages a rewind took back", messages.length - active.length);

	let cwd = str(session.directory);
	let model: string | undefined;
	let name: string | undefined;
	let firstCommand: string | undefined;

	for (const message of active) {
		const { data, parts, at } = message;
		const semantics = record(data.semantics) ?? {};
		const kind = str(semantics.kind);
		const shown = semantics.uiVisibility !== "hidden";
		const sent = semantics.providerVisibility !== "hidden";
		if (kind === "timeline_event") {
			builder.drop("ZCode timeline lines (model changes, compactions)");
			continue;
		}
		if (kind === "compact_summary") {
			const boundary = record(parts.find((part) => part.type === "compaction")?.compactBoundary) ?? {};
			const summary = str(record(data.summary)?.body)?.trim() || textOf(parts);
			const segment = record(boundary.preservedSegment);
			const head = active.findIndex((each) => each.id === segment?.headMessageId);
			const tail = active.findIndex((each) => each.id === segment?.tailMessageId);
			const keep = head >= 0 && tail >= head ? active.slice(head, tail + 1).map((each) => each.id) : [];
			builder.compaction(summary, num(boundary.preCompactTokenCount) ?? 0, at, keep);
			continue;
		}
		if (data.role === "user") {
			if (!sent) {
				builder.drop("ZCode notes for the app only");
				continue;
			}
			if (!shown) {
				builder.context(textOf(parts), at, message.id);
				continue;
			}
			const words: ContentBlock[] = [];
			for (const part of parts) {
				if (part.type === "text") {
					const text = str(part.text) ?? "";
					if (part.synthetic === true) {
						builder.context(text, at, message.id);
						continue;
					}
					const command = commandText(text);
					if (command !== undefined) firstCommand ??= command;
					else if (name === undefined && text.trim()) name = firstLine(text);
					words.push({ type: "text", text: command ?? text });
				} else if (part.type === "file") {
					const mime = String(part.mime ?? "");
					const file = str(part.filename) ?? str(record(part.source)?.path) ?? str(part.url) ?? "a file";
					if (mime.startsWith("image/")) {
						words.push(imageFromUrl(part.url));
						continue;
					}
					words.push({ type: "text", text: `[${file}]` });
					const preview = str(record(record(part.metadata)?.preview)?.text);
					if (preview) builder.context(`Contents of ${file}:\n${preview}`, at, message.id);
				} else builder.drop("ZCode bookkeeping parts");
			}
			builder.user(words, at, message.id);
			continue;
		}
		if (data.role !== "assistant") {
			builder.drop("unrecognized records");
			continue;
		}
		const used = str(data.modelId) ?? str(data.modelID) ?? "";
		if (used) model = used;
		cwd ??= str(record(data.path)?.cwd);
		const blocks: AssistantBlock[] = [];
		const tools: Record<string, unknown>[] = [];
		for (const part of parts) {
			if (part.type === "text") blocks.push({ type: "text", text: str(part.text) ?? "" });
			else if (part.type === "reasoning") blocks.push({ type: "thinking", thinking: str(part.text) ?? "" });
			else if (part.type === "tool") {
				const id = str(part.callID);
				if (!id) continue;
				const state = record(part.state) ?? {};
				blocks.push({
					type: "toolCall",
					id,
					name: str(part.tool) ?? "unknown",
					arguments: toolArguments(state.input),
				});
				tools.push(part);
			} else if (!["step-start", "step-finish", "snapshot", "patch", "retry", "agent"].includes(String(part.type)))
				builder.drop("ZCode bookkeeping parts");
		}
		const error = record(data.error);
		const failed = error && !blocks.some((block) => block.type !== "thinking");
		builder.assistant({
			blocks: failed ? [] : blocks,
			model: used,
			at,
			key: message.id,
			...(failed
				? {
						error:
							str(record(error.data)?.message) ?? str(error.message) ?? str(error.name) ?? "The request failed.",
					}
				: {}),
			...(data.finish === "length" ? { stopReason: "length" as const } : {}),
		});
		for (const part of tools) {
			const state = record(part.state) ?? {};
			if (state.status !== "completed" && state.status !== "error") continue;
			const output = toolOutput(state);
			builder.toolResult({
				id: str(part.callID) ?? "",
				name: str(part.tool),
				content: output.content,
				isError: output.isError,
				at: num(record(state.time)?.end) ?? at,
				key: message.id,
			});
		}
	}

	const started = iso(num(session.time_created)) ?? iso(messages[0]?.at) ?? new Date().toISOString();
	return complete(builder, {
		source,
		sourceId: where.id,
		cwd: cwd ?? options.cwd ?? process.cwd(),
		started,
		name: titleOf(session) || name || firstCommand,
		model,
		stamp,
		options,
	});
}
