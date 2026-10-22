/**
 * Codex rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`. Two shapes, both still on disk:
 * - since mid 2025, `{timestamp, type, payload}` lines: `session_meta` (the thread), `turn_context` (the model and
 *   folder of a turn), `response_item` (what the model saw and said, as OpenAI Responses items), `compacted`, and
 *   events for the app (`event_msg`, `world_state`, ...), which repeat the items and are left out;
 * - before that, a header line `{id, timestamp, instructions}`, then bare response items and `{record_type: "state"}`.
 * A forked or sub-agent thread starts with its own `session_meta` and then copies its parent's history, the parent's
 * `session_meta` included. The whole file is what that thread's model saw, so all of it is imported.
 */
import { statSync } from "node:fs";
import { basename } from "node:path";
import { list, readJsonLines, record, str } from "./jsonl.ts";
import {
	type AssistantBlock,
	absolute,
	type ContentBlock,
	type ConvertedTranscript,
	classifyUserText,
	clip,
	commandText,
	complete,
	fileStamp,
	firstLine,
	imageFromUrl,
	type ReadOptions,
	SessionBuilder,
	shellText,
	toolArguments,
	unknownBlockText,
} from "./session.ts";

/** Lines for the app, not for the model: what they say is in the response items too. */
const APP_RECORDS: ReadonlySet<string> = new Set([
	"event_msg",
	"world_state",
	"token_usage_record",
	"inter_agent_communication_metadata",
]);

/** The folder in Codex's `<environment_context>`, the only place the older shape names it. */
export function environmentCwd(text: string): string | undefined {
	return /<cwd>([\s\S]*?)<\/cwd>/.exec(text)?.[1]?.trim() || undefined;
}

/** A call's output: a string (often JSON with `output` and an exit code), a list of blocks, or an object. */
function outputOf(output: unknown, counts: { asText: number }): { content: ContentBlock[] | string; isError: boolean } {
	if (typeof output === "string") {
		if (output.startsWith("{")) {
			try {
				const parsed = record(JSON.parse(output) as unknown);
				const text = str(parsed?.output);
				if (parsed && text !== undefined) {
					const exit = record(parsed.metadata)?.exit_code;
					return { content: text, isError: typeof exit === "number" && exit !== 0 };
				}
			} catch {}
		}
		return { content: output, isError: false };
	}
	const object = record(output);
	if (object) {
		const text = str(object.content);
		return { content: text ?? unknownBlockText(object), isError: object.success === false };
	}
	const blocks: ContentBlock[] = [];
	for (const block of list(output).map(record)) {
		if (!block) continue;
		if (block.type === "input_text" || block.type === "output_text" || block.type === "text")
			blocks.push({ type: "text", text: str(block.text) ?? "" });
		else if (block.type === "input_image") blocks.push(imageFromUrl(block.image_url));
		else {
			counts.asText++;
			blocks.push({ type: "text", text: unknownBlockText(block) });
		}
	}
	return { content: blocks, isError: false };
}

/** What a compaction left the model: its summary and the messages of the person it kept word for word. */
function compactionText(summary: string, kept: readonly string[]): string {
	const parts = [summary || "Codex compacted the conversation here. Its summary cannot be read outside Codex."];
	if (kept.length > 0) {
		const messages = clip(kept.map((text) => clip(text, 4000).text).join("\n\n---\n\n"), 40_000).text;
		parts.push(`The user's messages that Codex kept after compacting:\n\n${messages}`);
	}
	return parts.join("\n\n");
}

export async function readCodex(path: string, options: ReadOptions = {}): Promise<ConvertedTranscript> {
	const source = absolute(path);
	const stamp = fileStamp(source);
	const builder = new SessionBuilder("codex");
	const { counts } = builder;
	let sourceId = "";
	let sawMeta = false;
	let cwd: string | undefined;
	let started: string | undefined;
	let model: string | undefined;
	let lastModel: string | undefined;
	let at = 0;
	let tokens = 0;
	let name: string | undefined;
	let firstCommand: string | undefined;
	let open: { blocks: AssistantBlock[]; at: number; model: string } | undefined;

	const flush = () => {
		if (!open) return;
		const { blocks, at: when, model: used } = open;
		open = undefined;
		builder.assistant({ blocks, model: used, at: when });
	};
	const answer = () => {
		open ??= { blocks: [], at, model: model ?? "unknown" };
		if (model) lastModel = model;
		return open;
	};

	const userMessage = (blocks: Record<string, unknown>[]) => {
		flush();
		const words: ContentBlock[] = [];
		const say = () => {
			if (words.length > 0) builder.user(words.splice(0), at);
		};
		for (const block of blocks) {
			if (block.type === "input_image") {
				words.push(imageFromUrl(block.image_url));
				continue;
			}
			if (block.type !== "input_text" && block.type !== "text") {
				counts.asText++;
				words.push({ type: "text", text: unknownBlockText(block) });
				continue;
			}
			const text = str(block.text) ?? "";
			const kind = classifyUserText(text);
			if (kind === "setup") {
				cwd ??= environmentCwd(text);
				builder.drop("Codex setup");
				continue;
			}
			if (kind === "context") {
				say();
				builder.context(text, at);
				continue;
			}
			const shell = shellText(text);
			if (shell) {
				words.push({ type: "text", text: `! ${shell.command}` });
				say();
				builder.context(shell.output, at);
				continue;
			}
			const command = commandText(text);
			if (command !== undefined) {
				firstCommand ??= command;
				words.push({ type: "text", text: command });
				continue;
			}
			if (name === undefined && text.trim()) name = firstLine(text);
			words.push({ type: "text", text });
		}
		say();
	};

	const item = (payload: Record<string, unknown>) => {
		const callId = str(payload.call_id) ?? str(payload.id) ?? "";
		switch (payload.type) {
			case "message": {
				const blocks = list(payload.content)
					.map(record)
					.filter((block): block is Record<string, unknown> => block !== undefined);
				if (payload.role === "assistant") {
					const target = answer();
					for (const block of blocks) {
						if (block.type === "output_text" || block.type === "text" || block.type === "input_text")
							target.blocks.push({ type: "text", text: str(block.text) ?? "" });
						else if (block.type === "refusal")
							target.blocks.push({ type: "text", text: str(block.refusal) ?? "" });
						else {
							counts.asText++;
							target.blocks.push({ type: "text", text: unknownBlockText(block) });
						}
					}
				} else if (payload.role === "user") userMessage(blocks);
				else builder.drop("Codex instructions");
				return;
			}
			case "reasoning": {
				// What can be read of it: its summary, or its text when the model gave it. Encrypted content is the
				// model's own, and never imported.
				const read = (blocks: unknown) =>
					list(blocks)
						.map((block) => str(record(block)?.text)?.trim())
						.filter((text): text is string => Boolean(text));
				const content = read(payload.content);
				const text = content.length > 0 ? content : read(payload.summary);
				if (text.length === 0) builder.drop("thinking that cannot be read");
				else answer().blocks.push({ type: "thinking", thinking: text.join("\n\n") });
				return;
			}
			case "function_call":
			case "tool_search_call":
				answer().blocks.push({
					type: "toolCall",
					id: callId,
					name: str(payload.name) ?? (payload.type === "tool_search_call" ? "tool_search" : "unknown"),
					arguments: toolArguments(payload.arguments),
				});
				return;
			case "custom_tool_call":
				answer().blocks.push({
					type: "toolCall",
					id: callId,
					name: str(payload.name) ?? "unknown",
					arguments: { input: str(payload.input) ?? "" },
				});
				return;
			case "local_shell_call":
				answer().blocks.push({
					type: "toolCall",
					id: callId,
					name: "local_shell",
					arguments: toolArguments(payload.action),
				});
				return;
			case "web_search_call": {
				const query = str(record(payload.action)?.query);
				counts.asText++;
				answer().blocks.push({ type: "text", text: query ? `(Searched the web: ${query})` : "(Searched the web)" });
				return;
			}
			case "function_call_output":
			case "custom_tool_call_output":
			case "local_shell_call_output": {
				flush();
				const output = outputOf(payload.output, counts);
				builder.toolResult({ id: callId, content: output.content, isError: output.isError, at });
				return;
			}
			case "tool_search_output": {
				flush();
				const found = list(payload.tools)
					.map((tool) => str(record(tool)?.name))
					.filter((toolName): toolName is string => toolName !== undefined);
				builder.toolResult({
					id: callId,
					content: found.length > 0 ? `Tools found: ${found.join(", ")}` : "No tools found.",
					isError: false,
					at,
				});
				return;
			}
			case "agent_message": {
				flush();
				const text = list(payload.content)
					.map((block) => str(record(block)?.text) ?? "")
					.join("\n");
				const from = str(payload.author) ?? "an agent";
				const to = str(payload.recipient) ?? "an agent";
				builder.context(`[Message from ${from} to ${to}]\n${text}`, at);
				return;
			}
			default:
				builder.drop("records not understood");
		}
	};

	const compacted = (payload: Record<string, unknown>) => {
		flush();
		const summary = (str(payload.message) ?? "").trim();
		const kept: string[] = [];
		for (const entry of list(payload.replacement_history).map(record)) {
			if (entry?.type !== "message" || entry.role !== "user") continue;
			for (const block of list(entry.content)) {
				const text = str(record(block)?.text)?.trim();
				if (!text || classifyUserText(text) !== "user") continue;
				// The summary itself comes back as a user message with a preamble.
				if (summary && text.includes(summary.slice(0, 200))) continue;
				kept.push(text);
			}
		}
		builder.compaction(compactionText(summary, kept), tokens, at);
	};

	for await (const line of readJsonLines(source)) {
		counts.records++;
		if (!("value" in line)) {
			builder.drop(line.problem === "oversized" ? "lines too long to read" : "unreadable lines");
			continue;
		}
		const data = record(line.value);
		if (!data) {
			builder.drop("records not understood");
			continue;
		}
		const payload = record(data.payload);
		const type = str(data.type);
		if (payload && type) {
			const time = Date.parse(str(data.timestamp) ?? "");
			if (!Number.isNaN(time)) at = time;
			if (type === "session_meta") {
				// Only the first is this thread's: later ones came with a parent's history.
				if (!sawMeta) {
					sawMeta = true;
					sourceId = str(payload.id) ?? "";
					cwd = str(payload.cwd) ?? cwd;
					started = str(payload.timestamp) ?? str(data.timestamp);
				}
			} else if (type === "turn_context") {
				model = str(payload.model) ?? model;
				cwd ??= str(payload.cwd);
			} else if (type === "response_item") item(payload);
			else if (type === "compacted") compacted(payload);
			else if (APP_RECORDS.has(type)) {
				if (type === "event_msg" && payload.type === "token_count") {
					const input = record(record(payload.info)?.last_token_usage)?.input_tokens;
					if (typeof input === "number") tokens = input;
				}
				builder.drop("Codex events and state");
			} else builder.drop("records not understood");
			continue;
		}
		// The older shape.
		if (data.record_type === "state") {
			builder.drop("Codex events and state");
			continue;
		}
		if (type) {
			item(data);
			continue;
		}
		const id = str(data.id);
		const stamp = str(data.timestamp);
		if (id && stamp) {
			if (!sourceId) sourceId = id;
			started ??= stamp;
			const time = Date.parse(stamp);
			if (!Number.isNaN(time)) at = time;
			continue;
		}
		builder.drop("records not understood");
	}
	flush();

	let startedIso =
		started && !Number.isNaN(Date.parse(started)) ? new Date(Date.parse(started)).toISOString() : undefined;
	if (!startedIso) {
		try {
			startedIso = statSync(source).mtime.toISOString();
		} catch {
			startedIso = new Date().toISOString();
		}
	}
	const fromName = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(source)?.[1];
	return complete(builder, {
		source,
		sourceId: sourceId || fromName || basename(source, ".jsonl"),
		cwd: cwd ?? options.cwd ?? process.cwd(),
		started: startedIso,
		name: name ?? firstCommand,
		model: lastModel ?? model,
		stamp,
		options,
	});
}
