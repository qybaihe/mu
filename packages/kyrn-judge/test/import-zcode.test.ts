import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
	buildSessionContext,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { importTranscripts, listConversations } from "../src/import/index.ts";
import { type ConvertedTranscript, IMPORT_CONTEXT, IMPORT_MARKER, NO_RESULT } from "../src/import/session.ts";
import { readZcode, zcodeSource } from "../src/import/zcode.ts";

// A made-up ZCode database: the tables and the shapes of their JSON follow ZCode CLI 0.16 (migration 0022), the
// words do not come from any real conversation.

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../src/import/cli.ts");
const CWD = "/tmp/mu-import-fixture/zcode-project";
const T0 = Date.parse("2026-01-02T03:04:05.000Z");
const PNG = "iVBORw0KGgo=";

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "mu-import-zcode-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

const semantics = (kind: string, ui: string, provider: string) => ({
	origin: "agent_runtime",
	kind,
	uiVisibility: ui,
	providerVisibility: provider,
	transcriptVisibility: ui,
});
const prompt = semantics("user_prompt", "visible", "visible");
const answer = semantics("assistant_response", "visible", "visible");
const forModel = (kind: string) => semantics(kind, "hidden", "visible");
const timeline = semantics("timeline_event", "visible", "hidden");

interface Message {
	id: string;
	/** Seconds after T0. */
	at: number;
	data: Json;
	/** Each with its own start, in seconds, when it has one. */
	parts?: Json[];
}

const said = (id: string, at: number, text: string, extra: Json[] = []): Message => ({
	id,
	at,
	data: { role: "user", semantics: prompt },
	parts: [{ type: "text", text, time: { start: T0 + at * 1000 } }, ...extra],
});

const answered = (id: string, at: number, parts: Json[], extra: Json = {}): Message => ({
	id,
	at,
	data: { role: "assistant", modelId: "GLM-test", providerId: "account:test", semantics: answer, ...extra },
	parts: [{ type: "step-start" }, ...parts, { type: "step-finish", reason: "stop" }],
});

const text = (value: string, at: number) => ({ type: "text", text: value, time: { start: T0 + at * 1000 } });
const thought = (value: string, at: number) => ({ type: "reasoning", text: value, time: { start: T0 + at * 1000 } });
const tool = (callID: string, name: string, at: number, state: Json) => ({
	type: "tool",
	callID,
	tool: name,
	state: { time: { start: T0 + at * 1000, end: T0 + at * 1000 + 10 }, ...state },
});

function database(dir: string): { file: string; add: (session: Json, messages: Message[]) => void; close(): void } {
	const file = join(dir, ".zcode", "cli", "db", "db.sqlite");
	mkdirSync(dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec(`
		CREATE TABLE session (id text primary key, project_id text not null, parent_id text, slug text not null,
			directory text not null, title text not null, version text not null, summary_diffs text, revert text,
			time_created integer not null, time_updated integer not null, time_archived integer,
			task_type text not null default 'interactive', title_source text not null default 'first_input');
		CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null,
			time_updated integer not null, data text not null, sequence integer);
		CREATE TABLE part (id text primary key, message_id text not null, session_id text not null,
			time_created integer not null, time_updated integer not null, data text not null, sequence integer);
	`);
	const add = (session: Json, messages: Message[]) => {
		const last = Math.max(0, ...messages.map((message) => message.at));
		db.prepare(
			`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, revert, time_created,
			 time_updated, time_archived, task_type, title_source) VALUES (?, 'p', ?, 's', ?, ?, '0.16.9', ?, ?, ?, ?, ?, ?)`,
		).run(
			String(session.id),
			(session.parent_id as string | undefined) ?? null,
			(session.directory as string | undefined) ?? CWD,
			(session.title as string | undefined) ?? "",
			session.revert === undefined ? null : JSON.stringify(session.revert),
			T0,
			T0 + last * 1000,
			(session.time_archived as number | undefined) ?? null,
			(session.task_type as string | undefined) ?? "interactive",
			(session.title_source as string | undefined) ?? "first_input",
		);
		messages.forEach((message, sequence) => {
			const time = T0 + message.at * 1000;
			db.prepare(
				"INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)",
			).run(
				message.id,
				String(session.id),
				time,
				time,
				JSON.stringify({ ...message.data, time: { created: time } }),
				sequence,
			);
			(message.parts ?? []).forEach((part, index) => {
				db.prepare(
					"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
				).run(`${message.id}-p${index}`, message.id, String(session.id), time, time, JSON.stringify(part), index);
			});
		});
	};
	return { file, add, close: () => db.close() };
}

/** One conversation with most of what ZCode writes: a file, thinking, calls, a compaction, a reminder, a cancel. */
function mainConversation(): Message[] {
	return [
		said("m00", 1, "Count the entries in TODO.txt", [
			{ type: "file", mime: "image/png", filename: "shot.png", url: `data:image/png;base64,${PNG}` },
			{
				type: "file",
				mime: "text/plain",
				filename: "TODO.txt",
				url: `${CWD}/TODO.txt`,
				metadata: { preview: { text: "TODO: a\nTODO: b\n" } },
			},
		]),
		// ZCode numbers the call before the thinking and text that came ahead of it.
		answered("m01", 2, [
			tool("call_1", "Read", 4, { status: "error", input: { file_path: "/nope" }, error: "File does not exist." }),
			thought("Read it first.", 2),
			text("Reading the file.", 3),
		]),
		answered("m02", 5, [
			tool("call_2", "Read", 5, {
				status: "completed",
				input: { file_path: `${CWD}/TODO.txt` },
				output: "1\tTODO: a",
			}),
		]),
		answered("m03", 6, [text("TODO.txt has 2 entries.", 6)]),
		said("m04", 7, "Add a note"),
		answered("m05", 8, [text("Noted.", 8)]),
		{
			id: "m06",
			at: 9,
			data: { role: "assistant", semantics: timeline },
			parts: [
				{ type: "timeline", timelineType: "context_compaction" },
				{ type: "compaction", timelineStatus: "completed" },
			],
		},
		{
			id: "m07",
			at: 10,
			data: {
				role: "user",
				semantics: forModel("compact_summary"),
				summary: { body: "Summary: counted and noted." },
			},
			parts: [
				text("This session is being continued from a previous conversation.", 10),
				{
					type: "compaction",
					compactBoundary: {
						preCompactTokenCount: 4000,
						preservedSegment: { headMessageId: "m04", tailMessageId: "m05" },
					},
				},
			],
		},
		{
			id: "m08",
			at: 10,
			data: { role: "user", semantics: forModel("system_reminder"), synthetic: true },
			parts: [text("Called the Read tool with the following input: TODO.txt", 10)],
		},
		said("m09", 11, "One more question"),
		answered("m10", 12, [], {
			error: { name: "AiSdkModelAdapterError", data: { message: "Model request was cancelled." } },
		}),
		said("m11", 13, "Try again"),
		answered("m12", 14, [
			thought("Retrying.", 14),
			text("Done.", 14),
			tool("call_3", "Bash", 15, { status: "running", input: { command: "sleep 100" } }),
		]),
	];
}

function fixture() {
	const dir = temp();
	const db = database(dir);
	db.add({ id: "sess_main", title: "Count the entries in TODO..." }, mainConversation());
	db.add(
		{
			id: "sess_rewind",
			title: "Saying words",
			title_source: "generated",
			revert: {
				kind: "conversation_rewind",
				targetMessageID: "r4",
				keptMessageIDs: ["r0", "r1", "r2", "r3"],
				branchCutAfterMessageID: "r5",
			},
		},
		[
			said("r0", 20, "Say one"),
			answered("r1", 21, [text("one", 21)]),
			said("r2", 22, "Say two"),
			answered("r3", 23, [text("two", 23)]),
			said("r4", 24, "Say three"),
			answered("r5", 25, [text("three", 25)]),
			said("r6", 26, "Say two again"),
			answered("r7", 27, [text("two again", 27)]),
		],
	);
	db.add({ id: "sess_sub", parent_id: "sess_main", task_type: "subagent_child", title: "Search" }, [
		said("s0", 30, "Search for TODO markers"),
		answered("s1", 31, [text("Two markers.", 31)]),
	]);
	db.add({ id: "sess_old", time_archived: T0 }, [said("o0", 40, "Archived"), answered("o1", 41, [text("ok", 41)])]);
	return { dir, ...db, source: (id: string) => zcodeSource(db.file, id) };
}

function messagesOf(converted: ConvertedTranscript): string[] {
	return converted.entries
		.filter((entry): entry is SessionMessageEntry => entry.type === "message")
		.map(({ message }) => {
			if (message.role === "user" || message.role === "toolResult") {
				const content = typeof message.content === "string" ? message.content : message.content;
				const body = (Array.isArray(content) ? content : [{ type: "text" as const, text: content }])
					.map((block) => (block.type === "text" ? block.text : `[${block.mimeType}]`))
					.join(" ");
				return message.role === "user"
					? `user: ${body}`
					: `result ${message.toolCallId}${message.isError ? " (error)" : ""}: ${body}`;
			}
			if (message.role !== "assistant") return message.role;
			const blocks = message.content.map((block) =>
				block.type === "text"
					? block.text
					: block.type === "thinking"
						? `(thinking: ${block.thinking})`
						: `[${block.name} ${block.id}]`,
			);
			return `assistant: ${blocks.join(" ")}${message.stopReason === "error" ? `(error: ${message.errorMessage})` : ""}`;
		});
}

describe("ZCode conversations", () => {
	it("reads one: files, thinking in the order it came, calls and results, a compaction, a cancel", async () => {
		const z = fixture();
		const converted = await readZcode(z.source("sess_main"));
		z.close();
		expect(messagesOf(converted)).toEqual([
			"user: Count the entries in TODO.txt [image/png] [TODO.txt]",
			"assistant: (thinking: Read it first.) Reading the file. [Read call_1]",
			"result call_1 (error): File does not exist.",
			"assistant: [Read call_2]",
			"result call_2: 1\tTODO: a",
			"assistant: TODO.txt has 2 entries.",
			"user: Add a note",
			"assistant: Noted.",
			"user: One more question",
			"assistant: (error: Model request was cancelled.)",
			"user: Try again",
			"assistant: (thinking: Retrying.) Done. [Bash call_3]",
			`result call_3 (error): ${NO_RESULT}`,
		]);
		expect(converted).toMatchObject({
			tool: "zcode",
			sourceId: "sess_main",
			source: z.source("sess_main"),
			cwd: CWD,
			model: "GLM-test",
			// ZCode cut the first message to sixty characters for its title; mu shows the first line itself.
			name: "Count the entries in TODO.txt",
			started: new Date(T0).toISOString(),
		});
		expect(converted.counts).toMatchObject({ user: 4, images: 1, thinking: 2, compactions: 1, missingResults: 1 });

		const entries = converted.entries.filter((entry): entry is SessionEntry => entry.type !== "session");
		const hidden = entries.filter((entry) => entry.type === "custom_message" && entry.customType === IMPORT_CONTEXT);
		expect(hidden.map((entry) => (entry.type === "custom_message" ? entry.content : ""))).toEqual([
			"Contents of TODO.txt:\nTODO: a\nTODO: b\n",
			"Called the Read tool with the following input: TODO.txt",
		]);
		// pi's compaction keeps what ZCode kept after its summary.
		const context = buildSessionContext(entries).messages.map((message) =>
			message.role === "compactionSummary"
				? `summary (${message.tokensBefore}): ${message.summary}`
				: message.role === "custom"
					? `custom ${message.customType}`
					: message.role,
		);
		expect(context.slice(0, 4)).toEqual([
			"summary (4000): Summary: counted and noted.",
			"user",
			"assistant",
			`custom ${IMPORT_MARKER}`,
		]);
	});

	it("keeps what a rewind kept and what came after it", async () => {
		const z = fixture();
		const converted = await readZcode(z.source("sess_rewind"));
		z.close();
		expect(messagesOf(converted)).toEqual([
			"user: Say one",
			"assistant: one",
			"user: Say two",
			"assistant: two",
			"user: Say two again",
			"assistant: two again",
		]);
		expect(converted.name).toBe("Saying words");
		expect(converted.counts.dropped["messages a rewind took back"]).toBe(2);
	});

	it("lists the conversations ZCode lists, and imports one by its database and id, then brings it up to date", async () => {
		const z = fixture();
		const none = join(z.dir, "none");
		const options = { claudeProjects: none, codexSessions: none, zcodeDatabase: z.file };
		expect(listConversations(options).map((one) => [one.tool, one.id, one.title, one.cwd])).toEqual([
			["zcode", "sess_rewind", "Saying words", CWD],
			["zcode", "sess_main", "Count the entries in TODO.txt", CWD],
		]);
		expect(listConversations({ ...options, subAgents: true }).map((one) => one.id)).toContain("sess_sub");

		const agentDir = join(z.dir, "mu", "agent");
		const [first] = await importTranscripts([z.source("sess_main")], { agentDir });
		expect(first).toMatchObject({ status: "imported", tool: "zcode", source: z.source("sess_main") });
		if (first.status !== "imported") return;
		expect(SessionManager.open(first.sessionFile).getSessionName()).toBe("Count the entries in TODO.txt");
		expect(listConversations({ ...options, store: { agentDir } })[1]).toMatchObject({
			id: "sess_main",
			importedAs: first.sessionFile,
		});
		expect((await importTranscripts([z.source("sess_main")], { agentDir }))[0].status).toBe("already-imported");

		z.add({ id: "sess_more" }, []);
		const db = new DatabaseSync(z.file);
		db.prepare("UPDATE session SET time_updated = ? WHERE id = 'sess_main'").run(T0 + 60_000);
		db.prepare(
			"INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES ('m13', 'sess_main', ?, ?, ?, 13)",
		).run(T0 + 60_000, T0 + 60_000, JSON.stringify({ role: "user", semantics: prompt }));
		db.prepare(
			"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES ('m13-p0', 'm13', 'sess_main', ?, ?, ?, 0)",
		).run(T0 + 60_000, T0 + 60_000, JSON.stringify({ type: "text", text: "And one more thing" }));
		db.close();
		z.close();
		expect(listConversations({ ...options, store: { agentDir } })[0]).toMatchObject({
			id: "sess_main",
			changed: true,
		});
		const [updated] = await importTranscripts([z.source("sess_main")], { agentDir });
		expect(updated).toMatchObject({ status: "updated", sessionFile: first.sessionFile, counts: { user: 5 } });
	});

	it("is listed and imported by mu import on a bare Node, without a word about SQLite on stderr", () => {
		const z = fixture();
		z.close();
		const run = (args: string[]) => {
			const child = spawnSync(process.execPath, [CLI, ...args], {
				encoding: "utf8",
				// Node takes the home folder from USERPROFILE on Windows, and needs SystemRoot there.
				env: {
					PATH: process.env.PATH ?? "",
					HOME: z.dir,
					USERPROFILE: z.dir,
					...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
				},
				timeout: 60_000,
			});
			return { code: child.status, out: child.stdout, err: child.stderr };
		};
		const agentDir = join(z.dir, "agent");
		const listed = run(["--list", "--json", "--agent-dir", agentDir]);
		expect(listed.err).toBe("");
		const found = (JSON.parse(listed.out) as { conversations: { tool: string; path: string }[] }).conversations;
		expect(found.map((one) => one.path)).toEqual([z.source("sess_rewind"), z.source("sess_main")]);
		const imported = run(["--agent-dir", agentDir, z.source("sess_rewind")]);
		expect(imported.code).toBe(0);
		expect(imported.err).toBe("");
		expect(imported.out).toContain('Imported from ZCode: "Saying words"');
	});
});
