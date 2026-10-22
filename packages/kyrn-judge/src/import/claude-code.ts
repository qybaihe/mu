/**
 * Claude Code transcripts: `~/.claude/projects/<project>/<session id>.jsonl`, one record per line.
 *
 * The conversation is a tree: every record names its parent (`parentUuid`), a rewind starts a branch from an earlier
 * record, and the conversation as it was last seen is the path from the latest record back to the root. That path
 * misses two things, and both are put back:
 * - one answer of the model is written as several records, one per content block, all with the same `message.id`.
 *   With parallel tool calls the later blocks and their results hang off the side of the chain (the next turn goes on
 *   from the first result), so every record of an answer on the path is taken, with the results of all its calls.
 *   Tools start while the answer is still streaming, so results can be written between the records of one answer:
 *   an answer is put together from all its records and written where it began, its results after it. (An id alone
 *   does not make an answer: some providers reuse ids. A record continues the answer before it when nothing came
 *   between them, or while that answer still has calls waiting for their results.)
 * - a compaction starts a new root (`compact_boundary`, no parent); its `logicalParentUuid` leads on to what was
 *   compacted, which pi keeps before its own compaction entry. When that record is not in the file, or is not before
 *   the compaction (Claude Code 2.1 moves the record it names behind its summary), the message written just before
 *   the compaction is where the conversation stood.
 * Sub-agent records (`isSidechain`) are left out of a main transcript. A sub-agent's own transcript, where every
 * record is a sidechain, is imported as a conversation of its own.
 *
 * The session is named as Claude Code names it: the title it was given (`/rename`), else the one Claude Code wrote
 * for it, else the person's first message.
 */
import { statSync } from "node:fs";
import { basename } from "node:path";
import type { StopReason } from "@earendil-works/pi-ai";
import { list, readJsonLines, record, str } from "./jsonl.ts";
import {
	type AssistantBlock,
	absolute,
	type ContentBlock,
	type ConvertedTranscript,
	classifyUserText,
	commandText,
	complete,
	fileStamp,
	firstLine,
	IMAGE_MARKER,
	imageOf,
	type ReadOptions,
	SessionBuilder,
	shellText,
	toolArguments,
	unknownBlockText,
} from "./session.ts";

type TreeType = "user" | "assistant" | "system" | "attachment";

const TREE_TYPES: ReadonlySet<string> = new Set(["user", "assistant", "system", "attachment"]);

interface TreeRecord {
	uuid: string;
	parent?: string;
	logicalParent?: string;
	type: TreeType;
	sidechain: boolean;
	data: Record<string, unknown>;
}

type Block = Record<string, unknown>;

/** Claude Code's second copy of every tool result, and of an attached file, is never imported: dropped as soon as a line is read. */
function slim(data: Record<string, unknown>): void {
	delete data.toolUseResult;
	const file = record(record(record(data.attachment)?.content)?.file);
	if (file) delete file.base64;
}

/** An image block as Claude Code writes it (`source: {type: "base64", media_type, data}`). */
function imageBlock(block: Block): ContentBlock {
	const source = record(block.source);
	return source?.type === "base64" ? imageOf(source.media_type, source.data) : imageOf(undefined, undefined);
}

/** A title record: what Claude Code calls the conversation. A name given to it wins over one Claude Code made up. */
const TITLES: Readonly<Record<string, string>> = {
	"custom-title": "customTitle",
	"ai-title": "aiTitle",
	summary: "summary",
};

function blocksOf(message: Record<string, unknown> | undefined): Block[] {
	const content = message?.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return list(content)
		.map(record)
		.filter((block): block is Block => block !== undefined);
}

function messageOf(item: TreeRecord): Record<string, unknown> {
	return record(item.data.message) ?? {};
}

function resultContent(content: unknown, counts: { asText: number }): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	const blocks: ContentBlock[] = [];
	for (const block of list(content).map(record)) {
		if (!block) continue;
		if (block.type === "text") blocks.push({ type: "text", text: str(block.text) ?? "" });
		else if (block.type === "image") blocks.push(imageBlock(block));
		else if (block.type === "tool_reference")
			blocks.push({ type: "text", text: `[tool reference: ${str(block.tool_name) ?? "unknown"}]` });
		else {
			counts.asText++;
			blocks.push({ type: "text", text: unknownBlockText(block) });
		}
	}
	return blocks;
}

/** What an attachment put in front of the model, when it is something worth keeping; undefined for Claude Code's own state. */
function attachmentText(attachment: Record<string, unknown>): string | undefined {
	const where = (...names: unknown[]) => names.map(str).find((name) => name !== undefined);
	switch (attachment.type) {
		case "file": {
			const file = record(record(attachment.content)?.file);
			const text = str(file?.content);
			if (text === undefined) return undefined;
			return `Contents of ${where(attachment.displayPath, attachment.filename, file?.filePath) ?? "a file"}:\n${text}`;
		}
		case "edited_text_file":
			return `${where(attachment.displayPath, attachment.filename) ?? "A file"} was changed:\n${str(attachment.snippet) ?? ""}`;
		case "directory":
			return `Contents of ${where(attachment.displayPath, attachment.path) ?? "a folder"}:\n${str(attachment.content) ?? ""}`;
		case "nested_memory": {
			const memory = record(attachment.content);
			return `Contents of ${where(attachment.displayPath, memory?.path) ?? "a memory file"}:\n${str(memory?.content) ?? ""}`;
		}
		case "plan_file_reference":
			return `The plan in ${where(attachment.planFilePath) ?? "a plan file"}:\n${str(attachment.planContent) ?? ""}`;
		case "hook_additional_context":
			return list(attachment.content)
				.map(str)
				.filter((text): text is string => text !== undefined)
				.join("\n");
		default:
			return undefined;
	}
}

export async function readClaudeCode(path: string, options: ReadOptions = {}): Promise<ConvertedTranscript> {
	const source = absolute(path);
	const builder = new SessionBuilder("claude-code");
	const { counts } = builder;
	const records: TreeRecord[] = [];
	const byUuid = new Map<string, TreeRecord>();
	let sessionId: string | undefined;
	const titles = new Map<string, string>();
	const stamp = fileStamp(source);

	for await (const line of readJsonLines(source)) {
		counts.records++;
		if (!("value" in line)) {
			builder.drop(line.problem === "oversized" ? "lines too long to read" : "unreadable lines");
			continue;
		}
		const data = record(line.value);
		const type = str(data?.type);
		if (!data || !type) {
			builder.drop("records not understood");
			continue;
		}
		sessionId ??= str(data.sessionId);
		const title = Object.hasOwn(TITLES, type) ? str(data[TITLES[type]])?.trim() : undefined;
		if (title) titles.set(type, title);
		const uuid = str(data.uuid);
		if (!TREE_TYPES.has(type) || !uuid) {
			builder.drop(uuid ? "records not understood" : "Claude Code bookkeeping (titles, queue, file history)");
			continue;
		}
		if (byUuid.has(uuid)) {
			builder.drop("repeated records");
			continue;
		}
		slim(data);
		const item: TreeRecord = {
			uuid,
			parent: str(data.parentUuid),
			logicalParent: str(data.logicalParentUuid),
			type: type as TreeType,
			sidechain: data.isSidechain === true,
			data,
		};
		records.push(item);
		byUuid.set(uuid, item);
	}

	// A main transcript leaves its sub-agents out; a sub-agent's own transcript is all sidechain.
	const hasMain = records.some((item) => !item.sidechain);
	const inScope = (item: TreeRecord) => !hasMain || !item.sidechain;

	// The latest message is where the conversation stood when it was last seen.
	let leaf: TreeRecord | undefined;
	for (let index = records.length - 1; index >= 0 && !leaf; index--) {
		const item = records[index];
		if (inScope(item) && (item.type === "user" || item.type === "assistant")) leaf = item;
	}
	const chosen = new Set<string>();
	const position = new Map(records.map((item, index) => [item.uuid, index]));
	const messageBefore = (item: TreeRecord): TreeRecord | undefined => {
		for (let index = (position.get(item.uuid) ?? 0) - 1; index >= 0; index--) {
			const earlier = records[index];
			if (inScope(earlier) && (earlier.type === "user" || earlier.type === "assistant")) return earlier;
		}
		return undefined;
	};
	for (let current = leaf; current && !chosen.has(current.uuid); ) {
		chosen.add(current.uuid);
		// A compaction boundary has no parent; what it compacted is its logical parent.
		const next = current.parent ?? current.logicalParent;
		let found = next ? byUuid.get(next) : undefined;
		if (!current.parent && found) {
			// Claude Code 2.1 writes the record a compaction names again behind its summary: then the compacted part
			// ends with the message before the compaction.
			const before = (position.get(found.uuid) ?? 0) < (position.get(current.uuid) ?? 0);
			if (!before || chosen.has(found.uuid)) found = messageBefore(current);
		}
		if (next && !found) {
			if (!current.parent) found = messageBefore(current);
			if (!found) builder.drop("links to records that are not in the file");
		}
		current = found;
	}
	// Every record of an answer on the path, and the results of every call in those answers.
	const answers = new Set<string>();
	for (const item of records) {
		const id = str(messageOf(item).id);
		if (chosen.has(item.uuid) && item.type === "assistant" && id) answers.add(id);
	}
	for (const item of records) {
		const id = str(messageOf(item).id);
		if (!chosen.has(item.uuid) && item.type === "assistant" && inScope(item) && id && answers.has(id))
			chosen.add(item.uuid);
	}
	const calls = new Set<string>();
	for (const item of records) {
		if (!chosen.has(item.uuid) || item.type !== "assistant") continue;
		for (const block of blocksOf(messageOf(item))) {
			const id = str(block.id);
			if (block.type === "tool_use" && id) calls.add(id);
		}
	}
	for (const item of records) {
		if (chosen.has(item.uuid) || item.type !== "user" || !inScope(item)) continue;
		const answersCall = blocksOf(messageOf(item)).some(
			(block) => block.type === "tool_result" && calls.has(str(block.tool_use_id) ?? ""),
		);
		if (answersCall) chosen.add(item.uuid);
	}
	let subAgent = 0;
	let offBranch = 0;
	for (const item of records) {
		if (chosen.has(item.uuid)) continue;
		if (inScope(item)) offBranch++;
		else subAgent++;
	}
	builder.drop("subagent records", subAgent);
	builder.drop("records off the latest branch", offBranch);

	// The file is written as things happen, so its order is the conversation's order.
	const ordered = records.filter((item) => chosen.has(item.uuid));
	const orderedIds = ordered.map((item) => item.uuid);

	let at = 0;
	let started: number | undefined;
	let cwd: string | undefined;
	let model: string | undefined;
	let name: string | undefined;
	let firstCommand: string | undefined;
	let boundary: { tokens: number; at: number; keep: string[] } | undefined;
	// The records of each answer, under the answer's first record.
	const answerParts = new Map<string, TreeRecord[]>();
	const partOf = new Map<string, string>();
	let current: { id: string; first: string; waiting: Set<string>; interrupted: boolean } | undefined;
	for (const item of ordered) {
		const message = messageOf(item);
		if (item.type === "assistant") {
			if (item.data.isApiErrorMessage === true || message.model === "<synthetic>") {
				current = undefined;
				continue;
			}
			const id = str(message.id) ?? item.uuid;
			const continues =
				current !== undefined && current.id === id && (!current.interrupted || current.waiting.size > 0);
			if (!current || !continues) {
				current = { id, first: item.uuid, waiting: new Set(), interrupted: false };
				answerParts.set(item.uuid, []);
			}
			answerParts.get(current.first)?.push(item);
			partOf.set(item.uuid, current.first);
			for (const block of blocksOf(message)) {
				const callId = str(block.id);
				if (block.type === "tool_use" && callId) current.waiting.add(callId);
			}
		} else if (item.type === "user" && current) {
			const blocks = blocksOf(message);
			for (const block of blocks)
				if (block.type === "tool_result") current.waiting.delete(str(block.tool_use_id) ?? "");
			current.interrupted = true;
			// Something the person said ends the answer before it.
			if (item.data.isMeta !== true && blocks.some((block) => block.type !== "tool_result")) current = undefined;
		}
	}

	const assistantRecord = (item: TreeRecord) => {
		const message = messageOf(item);
		const used = str(message.model) ?? "";
		if (item.data.isApiErrorMessage === true) {
			const text = blocksOf(message)
				.map((block) => str(block.text) ?? "")
				.join("\n")
				.trim();
			builder.assistant({ blocks: [], error: text || "The request failed.", model: used, at, key: item.uuid });
			return;
		}
		if (used === "<synthetic>") {
			builder.drop("Claude Code's own placeholder answers");
			return;
		}
		// A later record of an answer was written with its first one.
		if (partOf.get(item.uuid) !== item.uuid) return;
		if (used) model = used;
		const blocks: AssistantBlock[] = [];
		const callIds = new Set<string>();
		let stop: StopReason | undefined;
		for (const part of answerParts.get(item.uuid) ?? [item]) {
			const partMessage = messageOf(part);
			if (partMessage.stop_reason === "max_tokens") stop = "length";
			for (const block of blocksOf(partMessage)) {
				if (block.type === "text") blocks.push({ type: "text", text: str(block.text) ?? "" });
				else if (block.type === "thinking") blocks.push({ type: "thinking", thinking: str(block.thinking) ?? "" });
				else if (block.type === "redacted_thinking") builder.drop("redacted thinking");
				else if (block.type === "tool_use") {
					const callId = str(block.id) ?? part.uuid;
					if (callIds.has(callId)) {
						builder.drop("repeated tool calls");
						continue;
					}
					callIds.add(callId);
					blocks.push({
						type: "toolCall",
						id: callId,
						name: str(block.name) ?? "unknown",
						arguments: toolArguments(block.input),
					});
				} else if (block.type === "image") {
					builder.drop("images");
					blocks.push({ type: "text", text: IMAGE_MARKER });
				} else {
					counts.asText++;
					blocks.push({ type: "text", text: unknownBlockText(block) });
				}
			}
		}
		builder.assistant({ blocks, model: used, at, key: item.uuid, stopReason: stop });
	};

	const userRecord = (item: TreeRecord) => {
		const blocks = blocksOf(messageOf(item));
		if (item.data.isCompactSummary === true) {
			const summary = blocks.map((block) => str(block.text) ?? "").join("\n");
			builder.compaction(summary, boundary?.tokens ?? 0, boundary?.at ?? at, boundary?.keep);
			boundary = undefined;
			return;
		}
		const meta = item.data.isMeta === true;
		const words: ContentBlock[] = [];
		const say = () => {
			if (words.length === 0) return;
			builder.user(words.splice(0), at, item.uuid);
		};
		for (const block of blocks) {
			if (block.type === "tool_result") {
				say();
				builder.toolResult({
					id: str(block.tool_use_id) ?? "",
					content: resultContent(block.content, counts),
					isError: block.is_error === true,
					at,
					key: item.uuid,
				});
				continue;
			}
			if (block.type === "image") {
				if (meta) builder.drop("images");
				else words.push(imageBlock(block));
				continue;
			}
			if (block.type !== "text") {
				counts.asText++;
				words.push({ type: "text", text: unknownBlockText(block) });
				continue;
			}
			const text = str(block.text) ?? "";
			const kind = meta ? "context" : classifyUserText(text);
			if (kind === "setup") {
				builder.drop("Claude Code setup");
				continue;
			}
			if (kind === "context") {
				say();
				builder.context(text, at, item.uuid);
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

	const systemRecord = (item: TreeRecord, index: number) => {
		const subtype = str(item.data.subtype);
		if (subtype === "compact_boundary") {
			const metadata = record(item.data.compactMetadata);
			const head = str(record(metadata?.preservedSegment)?.headUuid);
			const start = head ? orderedIds.indexOf(head) : -1;
			const tokens = metadata?.preTokens;
			boundary = {
				tokens: typeof tokens === "number" ? tokens : 0,
				at,
				keep: start >= 0 && start < index ? orderedIds.slice(start, index) : [],
			};
			return;
		}
		if (subtype === "local_command") {
			builder.context(str(item.data.content) ?? "", at, item.uuid);
			return;
		}
		builder.drop("Claude Code status records");
	};

	const attachmentRecord = (item: TreeRecord) => {
		const attachment = record(item.data.attachment) ?? {};
		if (attachment.type === "queued_command") {
			// A message typed while the model was working: the person's own words unless Claude Code wrote it.
			const prompt = attachment.prompt;
			const words: ContentBlock[] =
				typeof prompt === "string"
					? [{ type: "text", text: prompt }]
					: list(prompt)
							.map(record)
							.filter((block): block is Block => block !== undefined)
							.map((block) =>
								block.type === "text"
									? { type: "text" as const, text: str(block.text) ?? "" }
									: imageBlock(block),
							);
			const typed = attachment.commandMode === "prompt" && attachment.isMeta !== true;
			if (typed) {
				const text = words.map((block) => (block.type === "text" ? block.text : "")).join("\n");
				if (name === undefined && text.trim()) name = firstLine(text);
				builder.user(words, at, item.uuid);
			} else {
				const text = words.map((block) => (block.type === "text" ? block.text : IMAGE_MARKER)).join("\n");
				builder.context(text, at, item.uuid);
			}
			return;
		}
		if (attachment.type === "file" && record(attachment.content)?.type === "image") {
			builder.drop("images");
			return;
		}
		const text = attachmentText(attachment);
		if (text === undefined) builder.drop("Claude Code reminders and state");
		else builder.context(text, at, item.uuid);
	};

	ordered.forEach((item, index) => {
		const time = Date.parse(str(item.data.timestamp) ?? "");
		if (!Number.isNaN(time)) at = time;
		if (started === undefined && at > 0) started = at;
		cwd ??= str(item.data.cwd);
		if (item.type === "assistant") assistantRecord(item);
		else if (item.type === "user") userRecord(item);
		else if (item.type === "system") systemRecord(item, index);
		else attachmentRecord(item);
	});
	if (boundary) builder.drop("compactions without their summary");

	cwd ??= records.map((item) => str(item.data.cwd)).find((dir) => dir !== undefined);
	let startedIso = started === undefined ? undefined : new Date(started).toISOString();
	if (!startedIso) {
		try {
			startedIso = statSync(source).mtime.toISOString();
		} catch {
			startedIso = new Date().toISOString();
		}
	}
	const agentId = hasMain ? undefined : records.map((item) => str(item.data.agentId)).find((id) => id !== undefined);
	return complete(builder, {
		source,
		sourceId: agentId ? `agent-${agentId}` : (sessionId ?? basename(source, ".jsonl")),
		cwd: cwd ?? options.cwd ?? process.cwd(),
		started: startedIso,
		name: titles.get("custom-title") ?? titles.get("ai-title") ?? titles.get("summary") ?? name ?? firstCommand,
		model,
		stamp,
		options,
	});
}
