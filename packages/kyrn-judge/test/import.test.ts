import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildSessionContext,
	type FileEntry,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir } from "../../coding-agent/src/core/session-manager.ts";
import { type ImportContext, importChat, storeOf } from "../src/extension/features/import.ts";
import { readClaudeCode } from "../src/import/claude-code.ts";
import { readCodex } from "../src/import/codex.ts";
import { main as importCommand, parseArgs } from "../src/import/command.ts";
import { detectTool, importTranscripts, listConversations } from "../src/import/index.ts";
import {
	type ConvertedTranscript,
	classifyUserText,
	clip,
	defaultSessionDir,
	firstLine,
	IMPORT_CONTEXT,
	IMPORT_MARKER,
	MAX_IMAGE_CHARS,
	NO_RESULT,
	uuidv7,
} from "../src/import/session.ts";

// Every transcript here is made up: the shapes follow Claude Code 2.1 and Codex 0.15x files, the words do not
// come from any real conversation.

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../src/import/cli.ts");
const CWD = "/tmp/mu-import-fixture/project";
const CC_ID = "0b9c6f7e-1111-4222-8333-444455556666";
const CODEX_ID = "019a0000-aaaa-7bbb-8ccc-ddddeeeeffff";
const T0 = Date.parse("2026-01-02T03:04:05.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "mu-import-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function writeLines(path: string, lines: readonly unknown[]): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`);
	return path;
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code records
// ---------------------------------------------------------------------------------------------------------------

type Extra = Record<string, unknown>;

function ccRecord(type: string, uuid: string, parent: string | null, time: number, extra: Extra = {}): Extra {
	return {
		parentUuid: parent,
		isSidechain: false,
		userType: "external",
		entrypoint: "cli",
		cwd: CWD,
		sessionId: CC_ID,
		version: "2.1.0",
		gitBranch: "main",
		type,
		uuid,
		timestamp: at(time),
		...extra,
	};
}

const user = (uuid: string, parent: string | null, time: number, content: unknown, extra: Extra = {}) =>
	ccRecord("user", uuid, parent, time, { message: { role: "user", content }, ...extra });

const assistant = (
	uuid: string,
	parent: string | null,
	time: number,
	messageId: string,
	content: unknown[],
	extra: Extra = {},
) =>
	ccRecord("assistant", uuid, parent, time, {
		message: {
			id: messageId,
			type: "message",
			role: "assistant",
			model: "claude-test-1",
			content,
			stop_reason: null,
			usage: { input_tokens: 10, output_tokens: 5 },
		},
		requestId: `req_${messageId}`,
		...extra,
	});

const result = (uuid: string, parent: string, time: number, toolUseId: string, content: unknown, isError = false) =>
	user(uuid, parent, time, [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }], {
		toolUseResult: { stdout: "a second copy that is never imported" },
		sourceToolAssistantUUID: parent,
	});

/** Two branches (a rewind), and an answer with two tool calls whose second half hangs off the chain. */
function branchingSession(): unknown[] {
	return [
		{ type: "queue-operation", operation: "enqueue", timestamp: at(0), sessionId: CC_ID, content: "hello" },
		user("u1", null, 1, "Write a hello script in shell\nwith a comment on top"),
		assistant("a1", "u1", 2, "m1", [{ type: "thinking", thinking: "plan it", signature: "sig" }]),
		assistant("a2", "a1", 2, "m1", [{ type: "text", text: "I will write it." }]),
		assistant("a3", "a2", 3, "m1", [
			{
				type: "tool_use",
				id: "toolu_1",
				name: "Write",
				input: { file_path: "/tmp/x/hello.sh", content: "echo hi" },
			},
		]),
		result("r1", "a3", 4, "toolu_1", "File created"),
		assistant("a4", "r1", 5, "m2", [{ type: "text", text: "Done: hello.sh prints hi." }]),
		// The branch given up by a rewind.
		user("u2a", "a4", 6, "Now add a test"),
		assistant("a5", "u2a", 7, "m3", [{ type: "text", text: "Added a test." }]),
		// The branch that was kept: one answer, two calls, written as two records.
		user("u2b", "a4", 8, "Add a README instead"),
		assistant("a6", "u2b", 9, "m4", [
			{ type: "tool_use", id: "toolu_2", name: "Write", input: { file_path: "/tmp/x/README.md", content: "# x" } },
		]),
		assistant("a7", "a6", 9, "m4", [{ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "ls" } }]),
		result("r3", "a7", 10, "toolu_3", [{ type: "text", text: "README.md\nhello.sh" }]),
		result("r2", "a6", 10, "toolu_2", "File created"),
		assistant("a8", "r2", 11, "m5", [{ type: "text", text: "README written." }]),
		{ type: "custom-title", customTitle: "hello", sessionId: CC_ID },
		{ type: "last-prompt", lastPrompt: "Add a README instead", leafUuid: "a8", sessionId: CC_ID },
	];
}

/** A subagent run inside the main transcript, the way older versions wrote it. */
function sidechainSession(): unknown[] {
	const side = { isSidechain: true, agentId: "side1" };
	return [
		user("u1", null, 1, "Find where the config is loaded"),
		assistant("a1", "u1", 2, "m1", [
			{
				type: "tool_use",
				id: "toolu_task",
				name: "Task",
				input: { description: "find", prompt: "Search for config" },
			},
		]),
		user("s1", null, 3, "Search for config", side),
		assistant("s2", "s1", 4, "ms1", [{ type: "text", text: "It is in src/config.ts" }], side),
		result("r1", "a1", 5, "toolu_task", "The config is loaded in src/config.ts"),
		assistant("a2", "r1", 6, "m2", [{ type: "text", text: "It is loaded in src/config.ts." }]),
	];
}

/** A subagent's own transcript: every record a sidechain. */
function subAgentTranscript(): unknown[] {
	const side = { isSidechain: true, agentId: "abc123" };
	return [
		user("s1", null, 1, "List the test files", side),
		assistant("s2", "s1", 2, "ms1", [{ type: "text", text: "There are three." }], side),
	];
}

/** Compacted halfway: the boundary starts a new root, and the last two messages were kept word for word. */
function compactedSession(): unknown[] {
	return [
		user("u1", null, 1, "Start the refactor"),
		assistant("a1", "u1", 2, "m1", [
			{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git status" } },
		]),
		result("r1", "a1", 3, "toolu_1", "clean"),
		assistant("a2", "r1", 4, "m2", [{ type: "text", text: "Tree is clean. Starting." }]),
		user("u2", "a2", 5, "Rename the module"),
		assistant("a3", "u2", 6, "m3", [{ type: "text", text: "Renamed." }]),
		ccRecord("system", "b1", null, 7, {
			subtype: "compact_boundary",
			content: "Conversation compacted",
			level: "info",
			logicalParentUuid: "a3",
			compactMetadata: {
				trigger: "auto",
				preTokens: 12345,
				preservedSegment: { headUuid: "u2", anchorUuid: "s1", tailUuid: "a3" },
			},
		}),
		user(
			"s1",
			"b1",
			7,
			"This session is being continued. Summary: the refactor started and the module was renamed.",
			{
				isCompactSummary: true,
				isVisibleInTranscriptOnly: true,
			},
		),
		user("u3", "s1", 8, "Now update the imports"),
		assistant("a4", "u3", 9, "m4", [{ type: "text", text: "Imports updated." }]),
	];
}

/** Lines no importer knows, between the ones it does. */
function sessionWithUnknownRecords(): unknown[] {
	return [
		"this is not json",
		[1, 2, 3],
		{ hello: "world" },
		{ type: "future-record", uuid: "f1", parentUuid: null, sessionId: CC_ID },
		user("u1", null, 1, "Check the build"),
		'{"type":"user","uuid":"u9"',
		assistant("a1", "u1", 2, "m1", [
			{ type: "text", text: "Checking." },
			{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "build" } },
		]),
		ccRecord("attachment", "t1", "a1", 3, { attachment: { type: "total_tokens_reminder", text: "tokens" } }),
		ccRecord("attachment", "t2", "t1", 3, {
			attachment: { type: "queued_command", prompt: "Also check the lint", commandMode: "prompt" },
		}),
		assistant("a2", "t2", 4, "m2", [{ type: "text", text: "Both pass." }]),
	];
}

// ---------------------------------------------------------------------------------------------------------------
// Codex rollouts
// ---------------------------------------------------------------------------------------------------------------

const item = (time: number, payload: Extra) => ({ timestamp: at(time), type: "response_item", payload });
const text = (role: string, value: string, kind = role === "assistant" ? "output_text" : "input_text") => ({
	type: "message",
	role,
	content: [{ type: kind, text: value }],
});

function newCodexRollout(source: unknown = "exec"): unknown[] {
	return [
		{
			timestamp: at(0),
			type: "session_meta",
			payload: {
				id: CODEX_ID,
				session_id: CODEX_ID,
				timestamp: at(0),
				cwd: CWD,
				originator: "codex_exec",
				cli_version: "0.155.0",
				source,
				model_provider: "openai",
				base_instructions: { text: "You are a coding agent." },
				history_mode: "full",
			},
		},
		{ timestamp: at(0), type: "turn_context", payload: { turn_id: "t1", cwd: CWD, model: "gpt-test-5" } },
		item(1, text("developer", "<permissions instructions>sandboxed</permissions instructions>")),
		item(1, text("user", "<environment_context>\n  <cwd>/somewhere/else</cwd>\n</environment_context>")),
		{ timestamp: at(1), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
		item(2, {
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "Fix the failing test" },
				{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
			],
		}),
		item(3, { type: "reasoning", summary: [], encrypted_content: "opaque" }),
		item(4, { ...text("assistant", "Looking at the test."), phase: "commentary" }),
		item(5, { type: "function_call", name: "shell", arguments: '{"command":["npm","test"]}', call_id: "call_1" }),
		item(6, {
			type: "function_call_output",
			call_id: "call_1",
			output: '{"output":"1 failing","metadata":{"exit_code":1}}',
		}),
		item(7, {
			type: "custom_tool_call",
			status: "completed",
			call_id: "call_2",
			name: "apply_patch",
			input: "*** Begin Patch\n*** End Patch",
		}),
		item(8, {
			type: "custom_tool_call_output",
			call_id: "call_2",
			output: [{ type: "input_text", text: "Success" }],
		}),
		{
			timestamp: at(8),
			type: "event_msg",
			payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5000, total_tokens: 5100 } } },
		},
		{
			timestamp: at(9),
			type: "compacted",
			payload: {
				message: "The test was fixed with a patch.",
				replacement_history: [
					text("user", "Fix the failing test"),
					text("user", "Another model wrote this summary: The test was fixed with a patch."),
				],
			},
		},
		{ timestamp: at(9), type: "world_state", payload: { full: true, state: {} } },
		item(10, text("user", "Run the tests again")),
		item(11, { ...text("assistant", "All tests pass."), phase: "final_answer" }),
		{ timestamp: at(12), type: "mystery_record", payload: { x: 1 } },
	];
}

function oldCodexRollout(): unknown[] {
	return [
		{ id: "7d3c0000-1111-4222-8333-000000000001", timestamp: "2025-05-01T10:00:00.000Z", instructions: "be helpful" },
		{ record_type: "state" },
		text("user", "<environment_context>\n<cwd>/tmp/mu-import-fixture/old-project</cwd>\n</environment_context>"),
		text("user", "Add a README"),
		{ type: "reasoning", id: "rs_1", summary: [], content: null, encrypted_content: "opaque" },
		{
			type: "function_call",
			id: "fc_1",
			name: "shell",
			arguments: '{"command":["bash","-lc","echo hi"]}',
			call_id: "call_a",
		},
		{ type: "function_call_output", call_id: "call_a", output: '{"output":"","metadata":{"exit_code":0}}' },
		text("assistant", "README added."),
		{ type: "function_call", name: "shell", arguments: "not json", call_id: "call_b" },
		{ record_type: "state" },
		text("user", "Thanks"),
	];
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the result
// ---------------------------------------------------------------------------------------------------------------

type ContextMessage = ReturnType<typeof buildSessionContext>["messages"][number];

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type: string; text?: string; mimeType?: string }) =>
			block.type === "text" ? block.text : block.type === "image" ? `[${block.mimeType}]` : "",
		)
		.join(" ");
}

/** One short line per message the model would read. */
function shape(messages: readonly ContextMessage[]): string[] {
	return messages.map((message) => {
		switch (message.role) {
			case "user":
				return `user: ${textOf(message.content)}`;
			case "assistant":
				return `assistant: ${message.content
					.map((block) =>
						block.type === "text"
							? block.text
							: block.type === "toolCall"
								? `[${block.name} ${block.id}]`
								: `(thinking: ${block.type === "thinking" ? block.thinking : ""})`,
					)
					.join(" ")}${message.stopReason === "error" ? ` (error: ${message.errorMessage})` : ""}`;
			case "toolResult":
				return `result ${message.toolCallId}${message.isError ? " (error)" : ""}: ${textOf(message.content)}`;
			case "custom":
				return `custom ${message.customType}`;
			case "compactionSummary":
				return `summary (${message.tokensBefore}): ${message.summary.split("\n")[0]}`;
			default:
				return message.role;
		}
	});
}

function sessionEntries(converted: ConvertedTranscript): SessionEntry[] {
	return converted.entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

function contextOf(converted: ConvertedTranscript): string[] {
	return shape(buildSessionContext(sessionEntries(converted)).messages);
}

function readFile(file: string): FileEntry[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FileEntry);
}

// ---------------------------------------------------------------------------------------------------------------

describe("Claude Code transcripts", () => {
	it("follows the latest branch, puts parallel calls back together, keeps thinking and takes the given title", async () => {
		const file = writeLines(join(temp(), `${CC_ID}.jsonl`), branchingSession());
		const converted = await readClaudeCode(file);

		expect(contextOf(converted)).toEqual([
			`custom ${IMPORT_MARKER}`,
			"user: Write a hello script in shell\nwith a comment on top",
			"assistant: (thinking: plan it) I will write it. [Write toolu_1]",
			"result toolu_1: File created",
			"assistant: Done: hello.sh prints hi.",
			"user: Add a README instead",
			"assistant: [Write toolu_2] [Bash toolu_3]",
			"result toolu_3: README.md\nhello.sh",
			"result toolu_2: File created",
			"assistant: README written.",
		]);
		expect(converted).toMatchObject({
			tool: "claude-code",
			sourceId: CC_ID,
			cwd: CWD,
			// The title given with /rename, as Claude Code lists it.
			name: "hello",
			model: "claude-test-1",
			started: at(1),
		});
		expect(converted.counts).toMatchObject({
			user: 2,
			assistant: 4,
			toolCalls: 3,
			toolResults: 3,
			thinking: 1,
			missingResults: 0,
		});
		expect(converted.counts.dropped).toMatchObject({
			"records off the latest branch": 2,
			"Claude Code bookkeeping (titles, queue, file history)": 3,
		});
		// Tool calls keep Claude Code's names and inputs; the first entry says where the conversation came from.
		const call = sessionEntries(converted).find(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		expect(JSON.stringify(call)).toContain('"file_path":"/tmp/x/hello.sh"');
		const [header, marker, info] = converted.entries;
		expect(header).toMatchObject({ type: "session", version: 3, cwd: CWD, id: converted.sessionId });
		expect(marker).toMatchObject({
			type: "custom_message",
			customType: IMPORT_MARKER,
			display: true,
			details: { version: 1, tool: "claude-code", source: file, sourceId: CC_ID },
		});
		expect(info).toMatchObject({ type: "session_info", name: "hello" });
		// The signature belongs to the model that wrote the thinking: it is not carried.
		expect(JSON.stringify(converted.entries)).not.toContain('"sig"');
		expect(JSON.stringify(converted.entries)).not.toContain("a second copy");
		expect(JSON.stringify(converted.entries)).not.toContain("Now add a test");
	});

	it("leaves a subagent's records out of the main conversation, and imports a subagent's own transcript", async () => {
		const main = await readClaudeCode(writeLines(join(temp(), "main.jsonl"), sidechainSession()));
		expect(contextOf(main)).toEqual([
			`custom ${IMPORT_MARKER}`,
			"user: Find where the config is loaded",
			"assistant: [Task toolu_task]",
			"result toolu_task: The config is loaded in src/config.ts",
			"assistant: It is loaded in src/config.ts.",
		]);
		expect(main.counts.dropped["subagent records"]).toBe(2);

		const own = await readClaudeCode(writeLines(join(temp(), "agent-abc123.jsonl"), subAgentTranscript()));
		expect(own).toMatchObject({ sourceId: "agent-abc123", name: "List the test files" });
		expect(contextOf(own).slice(1)).toEqual(["user: List the test files", "assistant: There are three."]);
	});

	it("turns a compaction into pi's, keeping what Claude Code kept word for word", async () => {
		const converted = await readClaudeCode(writeLines(join(temp(), "c.jsonl"), compactedSession()));
		expect(contextOf(converted)).toEqual([
			"summary (12345): This session is being continued. Summary: the refactor started and the module was renamed.",
			"user: Rename the module",
			"assistant: Renamed.",
			// Where the conversation came from, said again for whoever reads from the compaction on.
			`custom ${IMPORT_MARKER}`,
			"user: Now update the imports",
			"assistant: Imports updated.",
		]);
		const entries = sessionEntries(converted);
		const compaction = entries.find((entry) => entry.type === "compaction");
		const kept = entries.find(
			(entry) =>
				entry.type === "message" &&
				textOf(entry.message.role === "user" ? entry.message.content : "") === "Rename the module",
		);
		expect(compaction).toMatchObject({ tokensBefore: 12345, firstKeptEntryId: kept?.id });
		// Everything before is still in the file, for the transcript: eight messages, and the summary as pi's compaction.
		expect(entries.filter((entry) => entry.type === "message")).toHaveLength(8);
		expect(converted.counts.compactions).toBe(1);
	});

	it("keeps an answer whole when results were written between its records", async () => {
		// Tools start while the answer streams: the result of the second call is written before the third call.
		const converted = await readClaudeCode(
			writeLines(join(temp(), "s.jsonl"), [
				user("u1", null, 1, "Check three files"),
				assistant("a1", "u1", 2, "m1", [
					{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } },
				]),
				assistant("a2", "a1", 2, "m1", [
					{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/b" } },
				]),
				result("r2", "a2", 3, "toolu_2", "b"),
				assistant("a3", "r2", 3, "m1", [
					{ type: "tool_use", id: "toolu_3", name: "Read", input: { file_path: "/c" } },
				]),
				user("r13", "a1", 4, [
					{ type: "tool_result", tool_use_id: "toolu_1", content: "a" },
					{ type: "tool_result", tool_use_id: "toolu_3", content: "c" },
				]),
				assistant("a4", "r13", 5, "m2", [{ type: "text", text: "All three read." }]),
			]),
		);
		expect(contextOf(converted).slice(1)).toEqual([
			"user: Check three files",
			"assistant: [Read toolu_1] [Read toolu_2] [Read toolu_3]",
			"result toolu_2: b",
			"result toolu_1: a",
			"result toolu_3: c",
			"assistant: All three read.",
		]);
		expect(converted.counts).toMatchObject({ missingResults: 0, toolResults: 3 });
		expect(converted.counts.dropped["repeated tool results"]).toBeUndefined();
	});

	it("does not take an id for an answer: some providers use one id for every answer", async () => {
		const converted = await readClaudeCode(
			writeLines(join(temp(), "r.jsonl"), [
				user("u1", null, 1, "List the files"),
				assistant("a1", "u1", 2, "same", [
					{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
				]),
				result("r1", "a1", 3, "toolu_1", "a b"),
				assistant("a2", "r1", 4, "same", [{ type: "text", text: "Two files." }]),
				user("u2", "a2", 5, "Thanks"),
				assistant("a3", "u2", 6, "same", [{ type: "text", text: "You are welcome." }]),
			]),
		);
		expect(contextOf(converted).slice(1)).toEqual([
			"user: List the files",
			"assistant: [Bash toolu_1]",
			"result toolu_1: a b",
			"assistant: Two files.",
			"user: Thanks",
			"assistant: You are welcome.",
		]);
	});

	it("joins a compaction whose compacted part is not linked to the message written before it", async () => {
		const records = compactedSession().map((line) =>
			(line as Extra).uuid === "b1" ? { ...(line as Extra), logicalParentUuid: "not-in-this-file" } : line,
		);
		const converted = await readClaudeCode(writeLines(join(temp(), "j.jsonl"), records));
		// The whole conversation is still in the file, and the model reads the same as before.
		expect(sessionEntries(converted).filter((entry) => entry.type === "message")).toHaveLength(8);
		expect(contextOf(converted)[1]).toBe("user: Rename the module");
		expect(converted.counts.dropped["links to records that are not in the file"]).toBeUndefined();
	});

	it("reads past lines it does not understand and keeps unknown blocks as text", async () => {
		const converted = await readClaudeCode(writeLines(join(temp(), "u.jsonl"), sessionWithUnknownRecords()));
		expect(contextOf(converted)).toEqual([
			`custom ${IMPORT_MARKER}`,
			"user: Check the build",
			'assistant: Checking. [server_tool_use] {"id":"srv_1","name":"web_search","input":{"query":"build"}}',
			"user: Also check the lint",
			"assistant: Both pass.",
		]);
		expect(converted.counts.dropped).toMatchObject({
			"unreadable lines": 2,
			"records not understood": 3,
			"Claude Code reminders and state": 1,
		});
		expect(converted.counts.asText).toBe(1);
	});
});

describe("what Claude Code transcripts keep", () => {
	const messagesOf = (converted: ConvertedTranscript) =>
		shape(sessionEntries(converted).flatMap((entry) => (entry.type === "message" ? [entry.message] : [])));

	it("keeps what came before a compaction whose named record Claude Code wrote again behind its summary", async () => {
		// Claude Code 2.1 names the reminder written last before compacting, then writes that record after the summary.
		const lines = [
			user("u1", null, 1, "Start the refactor"),
			assistant("a1", "u1", 2, "m1", [{ type: "text", text: "Started." }]),
			user("u2", "a1", 3, "Rename the module"),
			assistant("a2", "u2", 4, "m2", [{ type: "text", text: "Renamed." }]),
			ccRecord("system", "b1", null, 5, {
				subtype: "compact_boundary",
				logicalParentUuid: "t1",
				compactMetadata: { trigger: "auto", preTokens: 900 },
			}),
			user("s1", "b1", 5, "Summary: the module was renamed.", { isCompactSummary: true }),
			ccRecord("attachment", "t1", "s1", 4, { attachment: { type: "total_tokens_reminder", text: "tokens" } }),
			user("u3", "t1", 6, "Now update the imports"),
			assistant("a3", "u3", 7, "m3", [{ type: "text", text: "Imports updated." }]),
		];
		const converted = await readClaudeCode(writeLines(join(temp(), `${CC_ID}.jsonl`), lines));
		expect(messagesOf(converted)).toEqual([
			"user: Start the refactor",
			"assistant: Started.",
			"user: Rename the module",
			"assistant: Renamed.",
			"user: Now update the imports",
			"assistant: Imports updated.",
		]);
		expect(converted.counts.compactions).toBe(1);
		expect(converted.counts.dropped["records off the latest branch"]).toBeUndefined();
		expect(contextOf(converted)).toEqual([
			"summary (900): Summary: the module was renamed.",
			`custom ${IMPORT_MARKER}`,
			"user: Now update the imports",
			"assistant: Imports updated.",
		]);
	});

	it("keeps the images a person pasted and tools gave back, and says so for one no model takes", async () => {
		const image = (mediaType: string, data: string) => ({
			type: "image",
			source: { type: "base64", media_type: mediaType, data },
		});
		const lines = [
			user("u1", null, 1, [
				image("image/png", "iVBORw0KGgo="),
				{ type: "text", text: "What is wrong in this screenshot?" },
				image("image/svg+xml", "PHN2Zz4="),
			]),
			assistant("a1", "u1", 2, "m1", [
				{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/x/shot.jpg" } },
			]),
			result("r1", "a1", 3, "toolu_1", [
				image("image/jpeg", "/9j/4AAQ"),
				image("image/png", "A".repeat(MAX_IMAGE_CHARS + 1)),
			]),
			assistant("a2", "r1", 4, "m2", [{ type: "text", text: "The button is cut off." }]),
		];
		const converted = await readClaudeCode(writeLines(join(temp(), `${CC_ID}.jsonl`), lines));
		expect(messagesOf(converted)).toEqual([
			"user: [image/png] What is wrong in this screenshot? (image not imported)",
			"assistant: [Read toolu_1]",
			"result toolu_1: [image/jpeg] (image not imported)",
			"assistant: The button is cut off.",
		]);
		expect(converted.counts.images).toBe(2);
		expect(converted.counts.dropped.images).toBe(2);
		const pasted = sessionEntries(converted).find(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		expect(pasted).toMatchObject({
			message: {
				content: [
					{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
					{ type: "text" },
					{ type: "text", text: "(image not imported)" },
				],
			},
		});
	});

	it("is named as Claude Code lists it: the title it was given, else the one it made up, else the first message", async () => {
		const dir = temp();
		const base = [
			user("u1", null, 1, "Fix the login bug"),
			assistant("a1", "u1", 2, "m1", [{ type: "text", text: "Fixed." }]),
		];
		const made = [...base, { type: "ai-title", aiTitle: "Login bug fix", sessionId: CC_ID }];
		const given = [{ type: "custom-title", customTitle: "Auth work", sessionId: CC_ID }, ...made];
		expect((await readClaudeCode(writeLines(join(dir, "a.jsonl"), base))).name).toBe("Fix the login bug");
		expect((await readClaudeCode(writeLines(join(dir, "b.jsonl"), made))).name).toBe("Login bug fix");
		expect((await readClaudeCode(writeLines(join(dir, "c.jsonl"), given))).name).toBe("Auth work");

		// The list names it the same, from the start and the end of the transcript.
		const projects = join(dir, "projects");
		const filler = Array.from({ length: 400 }, (_, index) =>
			ccRecord("attachment", `f${index}`, index === 0 ? "a1" : `f${index - 1}`, 3, {
				attachment: { type: "hook_additional_context", content: ["x".repeat(4000)] },
			}),
		);
		writeLines(join(projects, "p", `${CC_ID}.jsonl`), [
			...base,
			...filler,
			{ type: "ai-title", aiTitle: "Login bug fix", sessionId: CC_ID },
		]);
		const none = join(dir, "none");
		const listed = listConversations({ claudeProjects: projects, codexSessions: none, zcodeDatabase: none });
		expect(listed.map((one) => one.title)).toEqual(["Login bug fix"]);
	});
});

describe("Codex rollouts", () => {
	it("imports the current shape: calls, results with their exit codes, a compaction, the model", async () => {
		const converted = await readCodex(
			writeLines(join(temp(), `rollout-2026-01-02T03-04-05-${CODEX_ID}.jsonl`), newCodexRollout()),
		);
		expect(contextOf(converted)).toEqual([
			expect.stringMatching(/^summary \(5000\): The test was fixed with a patch\.$/),
			`custom ${IMPORT_MARKER}`,
			"user: Run the tests again",
			"assistant: All tests pass.",
		]);
		const all = shape(
			sessionEntries(converted).flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
		);
		expect(all).toEqual([
			"user: Fix the failing test [image/png]",
			"assistant: Looking at the test. [shell call_1]",
			"result call_1 (error): 1 failing",
			"assistant: [apply_patch call_2]",
			"result call_2: Success",
			"user: Run the tests again",
			"assistant: All tests pass.",
		]);
		const compaction = sessionEntries(converted).find((entry) => entry.type === "compaction");
		expect(compaction?.type === "compaction" && compaction.summary).toContain("The user's messages that Codex kept");
		expect(compaction?.type === "compaction" && compaction.summary).toContain("Fix the failing test");
		expect(compaction?.type === "compaction" && compaction.summary).not.toContain("Another model wrote");
		expect(converted).toMatchObject({
			sourceId: CODEX_ID,
			cwd: CWD,
			model: "gpt-test-5",
			name: "Fix the failing test",
			started: at(0),
		});
		expect(converted.counts.dropped).toMatchObject({
			"Codex instructions": 1,
			"Codex setup": 1,
			"thinking that cannot be read": 1,
			"Codex events and state": 3,
			"records not understood": 1,
		});
		expect(converted.counts).toMatchObject({ images: 1, thinking: 0 });
		const assistantMessage = sessionEntries(converted).find(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		expect(assistantMessage).toMatchObject({
			message: {
				provider: "codex",
				model: "gpt-test-5",
				content: [{}, { arguments: { command: ["npm", "test"] } }],
			},
		});
	});

	it("keeps the thinking Codex shows: its summary, or its text when it has one", async () => {
		const rollout = newCodexRollout().map((line) =>
			((line as Extra).payload as Extra | undefined)?.type === "reasoning"
				? item(3, {
						type: "reasoning",
						summary: [{ type: "summary_text", text: "**Reading the test**" }],
						encrypted_content: "opaque",
					})
				: line,
		);
		const converted = await readCodex(writeLines(join(temp(), `rollout-x-${CODEX_ID}.jsonl`), rollout));
		const answer = sessionEntries(converted).find(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		expect(answer).toMatchObject({
			message: {
				content: [{ type: "thinking", thinking: "**Reading the test**" }, { type: "text" }, { type: "toolCall" }],
			},
		});
		expect(converted.counts.thinking).toBe(1);
	});

	it("imports the older shape: the folder from the environment, a call that never got its result", async () => {
		const converted = await readCodex(writeLines(join(temp(), "rollout-old.jsonl"), oldCodexRollout()));
		expect(contextOf(converted)).toEqual([
			`custom ${IMPORT_MARKER}`,
			"user: Add a README",
			"assistant: [shell call_a]",
			"result call_a: ",
			"assistant: README added. [shell call_b]",
			`result call_b (error): ${NO_RESULT}`,
			"user: Thanks",
		]);
		expect(converted).toMatchObject({
			sourceId: "7d3c0000-1111-4222-8333-000000000001",
			cwd: "/tmp/mu-import-fixture/old-project",
			started: "2025-05-01T10:00:00.000Z",
		});
		expect(converted.counts).toMatchObject({ missingResults: 1, toolCalls: 2 });
		expect(JSON.stringify(converted.entries)).toContain('"arguments":{"input":"not json"}');
	});
});

describe("importing into mu's sessions", () => {
	function stores() {
		const dir = temp();
		const claudeProjects = join(dir, "claude", "projects");
		const codexSessions = join(dir, "codex", "sessions");
		const cc = writeLines(
			join(claudeProjects, "-tmp-mu-import-fixture-project", `${CC_ID}.jsonl`),
			branchingSession(),
		);
		// A subagent's transcript lives in a folder below and is not a conversation of its own in the list.
		writeLines(
			join(claudeProjects, "-tmp-mu-import-fixture-project", CC_ID, "subagents", "agent-abc123.jsonl"),
			subAgentTranscript(),
		);
		const codex = writeLines(
			join(codexSessions, "2026", "01", "02", `rollout-2026-01-02T03-04-05-${CODEX_ID}.jsonl`),
			newCodexRollout(),
		);
		const old = writeLines(
			join(codexSessions, "2025", "05", "01", "rollout-2025-05-01T10-00-00-old.jsonl"),
			oldCodexRollout(),
		);
		const sub = writeLines(
			join(
				codexSessions,
				"2026",
				"01",
				"03",
				"rollout-2026-01-03T00-00-00-019a0000-aaaa-7bbb-8ccc-000000000009.jsonl",
			),
			newCodexRollout({ subagent: { thread_spawn: { parent_thread_id: CODEX_ID } } }).map((line, index) =>
				index === 0
					? {
							...(line as Extra),
							payload: { ...((line as Extra).payload as Extra), id: "019a0000-aaaa-7bbb-8ccc-000000000009" },
						}
					: line,
			),
		);
		// Newest first: the Codex one, then Claude Code, then the old rollout.
		utimesSync(old, new Date(T0 - 3600_000), new Date(T0 - 3600_000));
		utimesSync(cc, new Date(T0), new Date(T0));
		utimesSync(codex, new Date(T0 + 60_000), new Date(T0 + 60_000));
		utimesSync(sub, new Date(T0 + 120_000), new Date(T0 + 120_000));
		return { dir, claudeProjects, codexSessions, cc, codex, old, sub, agentDir: join(dir, "mu", "agent") };
	}

	it("tells the two tools apart from the first lines", () => {
		const s = stores();
		expect(detectTool(s.cc)).toBe("claude-code");
		expect(detectTool(s.codex)).toBe("codex");
		expect(detectTool(s.old)).toBe("codex");
		expect(detectTool(writeLines(join(s.dir, "other.jsonl"), [{ a: 1 }, { b: 2 }]))).toBeUndefined();
		expect(detectTool(writeLines(join(s.dir, "empty.jsonl"), []))).toBeUndefined();
	});

	it("writes a session pi opens and lists, where pi keeps the project's sessions", async () => {
		const s = stores();
		const [imported] = await importTranscripts([s.cc], { agentDir: s.agentDir });
		expect(imported.status).toBe("imported");
		if (imported.status !== "imported") return;
		expect(dirname(imported.sessionFile)).toBe(getDefaultSessionDir(CWD, s.agentDir));
		expect(dirname(imported.sessionFile)).toBe(defaultSessionDir(CWD, s.agentDir));

		const manager = SessionManager.open(imported.sessionFile);
		expect(manager.getSessionName()).toBe("hello");
		// pi keeps the folder as this machine spells it: <drive>:\tmp\... on Windows.
		expect(manager.getCwd()).toBe(resolve(CWD));
		expect(shape(buildSessionContext(manager.getEntries()).messages)).toHaveLength(10);
		expect(readFile(imported.sessionFile)[0]).toMatchObject({ type: "session", id: imported.sessionId });

		vi.stubEnv("PI_CODING_AGENT_DIR", s.agentDir);
		const listed = await SessionManager.list(CWD);
		expect(listed).toEqual([
			expect.objectContaining({
				id: imported.sessionId,
				name: "hello",
				firstMessage: expect.stringContaining("Write a hello script"),
			}),
		]);
	});

	it("refuses the same conversation twice, by its file or by its id", async () => {
		const s = stores();
		const [first] = await importTranscripts([s.cc], { agentDir: s.agentDir });
		const copy = join(s.dir, "copy.jsonl");
		copyFileSync(s.cc, copy);
		const again = await importTranscripts([s.cc, copy], { agentDir: s.agentDir });
		expect(first.status).toBe("imported");
		expect(again).toEqual([
			expect.objectContaining({
				status: "already-imported",
				sessionFile: first.status === "imported" ? first.sessionFile : "",
			}),
			expect.objectContaining({ status: "already-imported", source: copy }),
		]);
		// Twice in one call is caught too.
		const both = await importTranscripts([s.codex, s.codex], { agentDir: s.agentDir });
		expect(both.map((one) => one.status)).toEqual(["imported", "already-imported"]);
	});

	it("brings an import up to date when the conversation went on, keeping its session and the name given in mu", async () => {
		const s = stores();
		const options = { agentDir: s.agentDir };
		const [first] = await importTranscripts([s.cc], options);
		if (first.status !== "imported") throw new Error(first.status);
		// Renamed in mu: a setting, not the conversation going on.
		const leaf = readFile(first.sessionFile).at(-1) as { id: string };
		appendFileSync(
			first.sessionFile,
			`${JSON.stringify({ type: "session_info", id: "rename1", parentId: leaf.id, timestamp: at(20), name: "My hello" })}\n`,
		);
		const list = {
			claudeProjects: s.claudeProjects,
			codexSessions: s.codexSessions,
			zcodeDatabase: join(s.dir, "z"),
			store: options,
		};
		expect(listConversations(list).find((one) => one.tool === "claude-code")?.changed).toBeUndefined();
		// Went on in Claude Code.
		appendFileSync(
			s.cc,
			`${[
				user("u9", "a8", 30, "Also add a license"),
				assistant("a9", "u9", 31, "m9", [{ type: "text", text: "License added." }]),
			]
				.map((line) => JSON.stringify(line))
				.join("\n")}\n`,
		);
		expect(listConversations(list).find((one) => one.tool === "claude-code")?.changed).toBe(true);

		const [updated] = await importTranscripts([s.cc], options);
		expect(updated).toMatchObject({
			status: "updated",
			sessionFile: first.sessionFile,
			sessionId: first.sessionId,
			before: { user: 2, assistant: 4 },
			counts: { user: 3, assistant: 5 },
		});
		const manager = SessionManager.open(first.sessionFile);
		expect(manager.getSessionName()).toBe("My hello");
		expect(shape(buildSessionContext(manager.getEntries()).messages).slice(-2)).toEqual([
			"user: Also add a license",
			"assistant: License added.",
		]);
		// The entries the first import wrote keep their ids.
		const ids = (file: string) => new Set(readFile(file).map((entry) => (entry as { id?: string }).id));
		expect(ids(first.sessionFile).has(leaf.id)).toBe(true);
		expect(listConversations(list).find((one) => one.tool === "claude-code")?.changed).toBeUndefined();

		const [same] = await importTranscripts([s.cc], options);
		expect(same).toMatchObject({ status: "already-imported", sessionFile: first.sessionFile });
	});

	it("imports a conversation that went on in mu and in the other tool as a new session beside the first", async () => {
		const s = stores();
		const options = { agentDir: s.agentDir };
		const [first] = await importTranscripts([s.cc], options);
		if (first.status !== "imported") throw new Error(first.status);
		const leaf = readFile(first.sessionFile).at(-1) as { id: string };
		const said = { role: "user", content: "Continue here in mu", timestamp: T0 + 40_000 };
		appendFileSync(
			first.sessionFile,
			`${JSON.stringify({ type: "message", id: "mu1", parentId: leaf.id, timestamp: at(40), message: said })}\n`,
		);
		appendFileSync(s.cc, `${JSON.stringify(user("u9", "a8", 30, "Also add a license"))}\n`);
		const [second] = await importTranscripts([s.cc], options);
		expect(second).toMatchObject({ status: "imported", earlier: first.sessionFile });
		if (second.status !== "imported") return;
		expect(second.sessionFile).not.toBe(first.sessionFile);
		expect(second.sessionId).not.toBe(first.sessionId);
		expect(readFileSync(first.sessionFile, "utf8")).toContain("Continue here in mu");
		expect(readFileSync(second.sessionFile, "utf8")).toContain("Also add a license");
	});

	it("says why a file was not imported", async () => {
		const s = stores();
		const titlesOnly = writeLines(join(s.dir, "titles.jsonl"), [
			{ type: "custom-title", customTitle: "x", sessionId: "s" },
		]);
		const results = await importTranscripts(
			[join(s.dir, "missing.jsonl"), writeLines(join(s.dir, "x.jsonl"), [{ a: 1 }]), titlesOnly],
			{
				agentDir: s.agentDir,
			},
		);
		expect(results.map((one) => (one.status === "failed" ? one.error : one.status))).toEqual([
			"no such file",
			"not a Claude Code, Codex or ZCode transcript",
			"no messages in this transcript",
		]);
	});

	it("uses a custom session folder the way pi does", async () => {
		const s = stores();
		const sessionDir = join(s.dir, "all-sessions");
		const [imported] = await importTranscripts([s.old], { agentDir: s.agentDir, sessionDir });
		expect(imported.status === "imported" && dirname(imported.sessionFile)).toBe(sessionDir);
		const [again] = await importTranscripts([s.old], { agentDir: s.agentDir, sessionDir });
		expect(again.status).toBe("already-imported");
	});

	it("lists both tools' conversations, newest first, per project, and marks what was imported", async () => {
		const s = stores();
		const options = {
			claudeProjects: s.claudeProjects,
			codexSessions: s.codexSessions,
			zcodeDatabase: join(s.dir, "zcode", "db.sqlite"),
			store: { agentDir: s.agentDir },
		};
		const all = listConversations(options);
		expect(all.map((one) => [one.tool, one.title, one.cwd])).toEqual([
			["codex", "Fix the failing test", CWD],
			["claude-code", "hello", CWD],
			["codex", "Add a README", "/tmp/mu-import-fixture/old-project"],
		]);
		expect(all[1]).toMatchObject({ id: CC_ID, subAgent: false, started: at(1) });
		expect(listConversations({ ...options, cwd: CWD })).toHaveLength(2);
		expect(listConversations({ ...options, subAgents: true })).toHaveLength(4);

		await importTranscripts([s.cc], { agentDir: s.agentDir });
		const marked = listConversations(options);
		expect(marked[1].importedAs).toContain(defaultSessionDir(CWD, s.agentDir));
		expect(marked[0].importedAs).toBeUndefined();
	});
});

describe("mu import on the command line", () => {
	it("runs on a bare Node: lists as JSON, imports, and refuses a second import", () => {
		const dir = temp();
		const claudeHome = join(dir, "claude");
		const codexHome = join(dir, "codex");
		writeLines(join(claudeHome, "projects", "p", `${CC_ID}.jsonl`), branchingSession());
		const rollout = writeLines(
			join(codexHome, "sessions", "2026", "01", "02", `rollout-x-${CODEX_ID}.jsonl`),
			newCodexRollout(),
		);
		const agentDir = join(dir, "agent");
		const run = (args: string[]) => {
			const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", HOME: dir, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
				timeout: 60_000,
			});
			return { code: child.status, out: child.stdout, err: child.stderr };
		};

		const listed = run(["--list", "--json", "--agent-dir", agentDir]);
		expect(listed.err).toBe("");
		expect(listed.code).toBe(0);
		expect(
			(JSON.parse(listed.out) as { conversations: { tool: string }[] }).conversations.map((one) => one.tool).sort(),
		).toEqual(["claude-code", "codex"]);

		const imported = run(["--json", "--agent-dir", agentDir, rollout]);
		expect(imported.code).toBe(0);
		const [first] = (JSON.parse(imported.out) as { results: { status: string; sessionFile: string }[] }).results;
		expect(first.status).toBe("imported");
		expect(readFile(first.sessionFile)[1]).toMatchObject({ customType: IMPORT_MARKER });

		const again = run(["--agent-dir", agentDir, rollout]);
		expect(again.code).toBe(0);
		expect(again.out).toContain("Already imported");

		const text = run(["--list", "--agent-dir", agentDir]);
		expect(text.out).toContain("Fix the failing test  (imported)");
		expect(run(["--nope"]).code).toBe(2);
	});

	it("reads its arguments", () => {
		expect(parseArgs(["--list", "--json", "--cwd", "/x"])).toMatchObject({
			list: true,
			json: true,
			cwd: "/x",
			files: [],
		});
		expect(parseArgs(["a.jsonl", "b.jsonl", "--agent-dir", "/m"])).toMatchObject({
			files: ["a.jsonl", "b.jsonl"],
			agentDir: "/m",
		});
		expect(parseArgs(["--cwd"])).toEqual({ error: "--cwd needs a folder" });
		expect(parseArgs(["--list", "a.jsonl"])).toEqual({ error: "--list doesn't take files" });
	});

	it("puts sessions where MU_CODING_AGENT_DIR and the settings say", async () => {
		const dir = temp();
		const agentDir = join(dir, "agent");
		const file = writeLines(join(dir, "t.jsonl"), sidechainSession());
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: join(dir, "flat") }));
		const out: string[] = [];
		const code = await importCommand(["--json", file], {
			out: (line) => out.push(line),
			err: (line) => out.push(line),
			env: { MU_CODING_AGENT_DIR: agentDir },
			cwd: dir,
			home: dir,
		});
		expect(code).toBe(0);
		const [imported] = (JSON.parse(out.join("\n")) as { results: { sessionFile: string }[] }).results;
		expect(dirname(imported.sessionFile)).toBe(join(dir, "flat"));
	});
});

describe("/import-chat", () => {
	function setup() {
		const dir = temp();
		const claudeProjects = join(dir, "claude", "projects");
		const codexSessions = join(dir, "codex", "sessions");
		writeLines(join(claudeProjects, "p", `${CC_ID}.jsonl`), branchingSession());
		const agentDir = join(dir, "agent");
		const switched: string[] = [];
		const notes: string[] = [];
		const ctx: ImportContext = {
			cwd: CWD,
			hasUI: true,
			isIdle: () => true,
			switchSession: async (path) => {
				switched.push(path);
				return { cancelled: false };
			},
			ui: {
				select: vi.fn(async (_title: string, options: string[]) => options[0]),
				confirm: vi.fn(async () => true),
				notify: (message: string) => {
					notes.push(message);
				},
			},
			sessionManager: { getSessionDir: () => defaultSessionDir(CWD, agentDir) },
		};
		const zcodeDatabase = join(dir, "zcode", "db.sqlite");
		return {
			ctx,
			switched,
			notes,
			deps: { agentDir, sources: { claudeProjects, codexSessions, zcodeDatabase } },
			dir,
		};
	}

	it("lists this project's conversations, imports the one picked and switches to it", async () => {
		const { ctx, switched, notes, deps } = setup();
		await importChat("", ctx, deps);
		expect(ctx.ui.select).toHaveBeenCalledWith(expect.any(String), [expect.stringContaining("Claude Code")]);
		expect(notes[0]).toContain('Imported "hello" from Claude Code');
		expect(switched).toHaveLength(1);
		expect(dirname(switched[0])).toBe(defaultSessionDir(CWD, deps.agentDir));

		// Picked again: it is not imported twice, the earlier session is offered instead.
		await importChat("", ctx, deps);
		expect(notes[1]).toContain("already imported");
		expect(switched[1]).toBe(switched[0]);
	});

	it("says so when this project has none, and lists without a dialog where there is no UI", async () => {
		const { ctx, notes, deps } = setup();
		await importChat("", { ...ctx, cwd: "/tmp/mu-import-fixture/nothing-here" }, deps);
		expect(notes[0]).toContain("No Claude Code, Codex or ZCode conversations");
		await importChat("", { ...ctx, hasUI: false }, deps);
		expect(notes[1]).toContain(`${CC_ID}.jsonl`);
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("keeps a custom session folder", () => {
		const { deps } = setup();
		expect(
			storeOf(
				{ cwd: CWD, sessionManager: { getSessionDir: () => defaultSessionDir(CWD, deps.agentDir) } },
				deps.agentDir,
			),
		).toEqual({
			agentDir: deps.agentDir,
		});
		expect(storeOf({ cwd: CWD, sessionManager: { getSessionDir: () => "/tmp/flat" } }, deps.agentDir)).toEqual({
			agentDir: deps.agentDir,
			sessionDir: "/tmp/flat",
		});
	});
});

describe("the pieces", () => {
	it("makes version 7 ids from the conversation's start", () => {
		const id = uuidv7(T0);
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(T0);
	});

	it("names the session folder exactly as pi does", () => {
		const agentDir = join(temp(), "agent");
		for (const cwd of ["/tmp/a b/c", "/tmp/x:y/z", "/tmp/trailing/"]) {
			expect(defaultSessionDir(cwd, agentDir)).toBe(getDefaultSessionDir(cwd, agentDir));
		}
	});

	it("sorts user-role text into the person's words, notices and setup", () => {
		expect(classifyUserText("Please fix it")).toBe("user");
		expect(classifyUserText("<task-notification>done</task-notification>")).toBe("context");
		expect(classifyUserText("[Request interrupted by user]")).toBe("context");
		expect(classifyUserText("<environment_context><cwd>/x</cwd></environment_context>")).toBe("setup");
		expect(classifyUserText("<command-name>/model</command-name>")).toBe("user");
	});

	it("shortens long text from the middle, and names from the first line", () => {
		const long = "a".repeat(300);
		const cut = clip(long, 100);
		expect(cut.cut).toBe(true);
		expect(cut.text).toContain("200 characters not imported");
		expect(firstLine("\n\n  first   line \nsecond")).toBe("first line");
		expect(firstLine("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
	});

	it("keeps hidden context out of the transcript but in front of the model", async () => {
		const converted = await readClaudeCode(
			writeLines(join(temp(), "n.jsonl"), [
				user("u1", null, 1, "Start"),
				user("u2", "u1", 2, "<task-notification><summary>job done</summary></task-notification>"),
				assistant("a1", "u2", 3, "m1", [{ type: "text", text: "Seen." }]),
			]),
		);
		const hidden = sessionEntries(converted).find(
			(entry) => entry.type === "custom_message" && entry.customType === IMPORT_CONTEXT,
		);
		expect(hidden).toMatchObject({ display: false, content: expect.stringContaining("job done") });
		expect(contextOf(converted)).toContain(`custom ${IMPORT_CONTEXT}`);
	});
});
