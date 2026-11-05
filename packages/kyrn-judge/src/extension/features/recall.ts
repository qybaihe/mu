import { readFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FULL_OUTPUT_ENTRY, type FullOutputRecord, recallCall } from "../full-output.ts";
import { type KyrnRuntime, textOf } from "../runtime.ts";
import { describeCall } from "./admission.ts";
import { UNTRUSTED as BACKGROUND_UNTRUSTED } from "./background.ts";
import { UNTRUSTED } from "./browser.ts";
import { MCP_LABEL } from "./mcp.ts";
import { UNTRUSTED as DEBUGGER_UNTRUSTED } from "./packs/debugger.ts";
import { SEARCH_UNTRUSTED } from "./web.ts";

/** Where the text came from: the file admission archived, the page web_fetch kept, or the result as the session has it. */
export type RecallSource = "archive" | "page" | "session";

export interface RecallDetails {
	readonly id: string;
	/** The tool whose result this is. */
	readonly tool: string;
	readonly source: RecallSource;
	readonly offset: number;
	readonly end: number;
	readonly total: number;
	/** Text from outside this machine that no screening has read yet: the injection screen reads it now. */
	readonly unscreened: boolean;
}

/** A tool result of this conversation, the call that produced it, and the file that has its full text, if one does. */
export interface StoredResult {
	readonly tool: string;
	readonly call: string;
	readonly text: string;
	readonly record?: FullOutputRecord;
}

/**
 * The latest result with this id on the branch. A provider may give calls of different turns the same id; the result
 * read is then the latest, with the call and the file recorded for it, not those of an earlier one.
 */
export function storedResult(branch: readonly SessionEntry[], id: string): StoredResult | undefined {
	let call: string | undefined;
	let record: FullOutputRecord | undefined;
	let found: StoredResult | undefined;
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === FULL_OUTPUT_ENTRY) {
			const data = entry.data as Partial<FullOutputRecord> | undefined;
			if (data?.toolCallId === id && typeof data.path === "string") record = data as FullOutputRecord;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall" && block.id === id) {
					call = describeCall(block.name, (block.arguments ?? {}) as Record<string, unknown>);
					record = undefined;
				}
			}
		} else if (message.role === "toolResult" && message.toolCallId === id) {
			found = { tool: message.toolName, call: call ?? message.toolName, text: textOf(message.content), record };
		}
	}
	return found;
}

/** mu's labels in front of outside text. The MCP one names its server, so it is matched rather than compared. */
const LABELS: readonly string[] = [UNTRUSTED, SEARCH_UNTRUSTED, BACKGROUND_UNTRUSTED, DEBUGGER_UNTRUSTED];

/** The first label in a result and where it stands; a piece read back from past it gets the label in front. */
export function labelIn(text: string): { label: string; at: number } | undefined {
	let first: { label: string; at: number } | undefined;
	const consider = (label: string, at: number) => {
		if (at >= 0 && (first === undefined || at < first.at)) first = { label, at };
	};
	for (const label of LABELS) consider(label, text.indexOf(label));
	const mcp = MCP_LABEL.exec(text);
	if (mcp) consider(mcp[0], mcp.index);
	return first;
}

const lineAt = (text: string, offset: number): number => {
	let line = 1;
	for (let at = text.indexOf("\n"); at !== -1 && at < offset; at = text.indexOf("\n", at + 1)) line++;
	return line;
};

/**
 * `recall`: reads back an earlier tool result of this conversation that mu shortened for the model, a piece at a
 * time. Forgetting shrinks old results in the request only, so the session still has them; admission archives what it
 * leaves out; web_fetch keeps the page it cuts. Each of them points here, and reading the text back is cheaper and
 * surer than running the call again, which may be slow or give something else (a test run, a page that changed).
 *
 * Only this conversation, read-only, and never anything the model was not given a result for. A piece taken from past
 * a label of mu's (a page, an MCP server, a command's output) gets that label in front of it again. The part of a page
 * the model was never shown was never screened: the injection feature screens it when it comes back here.
 */
export function registerRecall(runtime: KyrnRuntime): void {
	const options = runtime.options("recall", {
		enabled: true,
		maxChars: 20_000,
	});
	if (!options.enabled) return;
	const { pi } = runtime;

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description: `Read back an earlier tool result in full where mu left part of it out; mu's note names the call id. Returns up to ${options.maxChars} characters from offset.`,
		parameters: Type.Object({
			id: Type.String({ description: "Tool call id from mu's note" }),
			offset: Type.Optional(Type.Number({ description: "Character to start at, default 0" })),
			limit: Type.Optional(Type.Number({ description: "Most characters to return" })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			runtime.touch(ctx);
			const found = storedResult(ctx.sessionManager.getBranch(), params.id);
			if (!found) {
				throw new Error(`No tool result with id ${JSON.stringify(params.id)} in this conversation.`);
			}
			let text = found.text;
			let source: RecallSource = "session";
			let gone = "";
			if (found.record) {
				try {
					text = readFileSync(found.record.path, "utf8");
					source = found.record.kind;
				} catch {
					gone = ` The full text mu kept is gone (${found.record.path}); this is the result as the conversation has it. If you need what it left out, run the call again.`;
				}
			}
			const total = text.length;
			const offset = Math.max(0, Math.floor(params.offset ?? 0));
			if (total > 0 && offset >= total) {
				throw new Error(`The result of ${found.call} has ${total} characters; offset ${offset} is past its end.`);
			}
			const limit = Math.max(1, Math.min(Math.floor(params.limit ?? options.maxChars), options.maxChars));
			const end = Math.min(total, offset + limit);
			const piece = text.slice(offset, end);
			const where =
				source === "archive"
					? "the full output mu archived"
					: source === "page"
						? "the full page web_fetch kept"
						: "the result as the conversation has it";
			const rest =
				end < total
					? ` ${total - end} more: ${recallCall(params.id, end)}.`
					: total === 0
						? ""
						: " That is the end.";
			const span =
				total === 0
					? "it has no text."
					: `characters ${offset}-${end} of ${total} (lines ${lineAt(text, offset)}-${lineAt(text, Math.max(offset, end - 1))} of ${lineAt(text, total)}).`;
			const head = `[mu: ${found.call}, ${where}: ${span}${rest}${gone}]`;
			// The page file holds the page alone, and all of it is outside text. A piece of a result from past the label
			// at its top would otherwise come back without one.
			const label = source === "page" ? UNTRUSTED : labelIn(text);
			const before = typeof label === "string" ? label : label && label.at < offset ? label.label : undefined;
			const details: RecallDetails = {
				id: params.id,
				tool: found.tool,
				source,
				offset,
				end,
				total,
				unscreened: source === "page",
			};
			return {
				content: [{ type: "text", text: before ? `${head}\n${before}\n\n${piece}` : `${head}\n\n${piece}` }],
				details,
			};
		},
	});

	runtime.catalog.register({
		id: "tool:recall",
		kind: "tool",
		title: "Read back shortened output",
		description:
			"Reads back, a piece at a time, a tool result of this conversation that mu shortened: old output it left out of the request, noise it archived, the rest of a page web_fetch cut.",
		tools: ["recall"],
		exposure: "always",
	});
}
