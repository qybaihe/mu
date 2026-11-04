import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isMutatingCall } from "../../checkpoint/mutating.ts";
import { clip, type KyrnRuntime } from "../runtime.ts";

/** Written just before a call that may change something runs: after it, an interruption leaves its outcome unknown. */
export const DISPATCH_ENTRY = "kyrn.tool-dispatch";
/** The note that tells the model, and the user, which calls an interruption left without a result. */
export const RECOVERY_MESSAGE = "kyrn.recovery";

export interface DispatchRecord {
	readonly toolCallId: string;
	readonly tool: string;
}

export interface InterruptedCall {
	readonly id: string;
	readonly tool: string;
	readonly input: Readonly<Record<string, unknown>>;
	/** Whether it may change something: not a read-only tool or command. */
	readonly mutating: boolean;
	/** For a call that may change something: whether it started, so its outcome is unknown. */
	readonly started: boolean;
}

/**
 * The calls of the conversation's last turn that have no result, because mu stopped (it was killed, the machine
 * slept, the app quit) while they ran or before they ran. None when the user has written since, when the last turn
 * was cut off before its calls were complete (pi drops such a turn from the model's context), or when the note was
 * already given.
 */
export function interruptedCalls(branch: readonly SessionEntry[], cwd?: string): InterruptedCall[] {
	let last = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			last = index;
			break;
		}
	}
	if (last === -1) return [];
	const message = (branch[last] as Extract<SessionEntry, { type: "message" }>).message as AssistantMessage;
	if (message.stopReason === "error" || message.stopReason === "aborted") return [];
	const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
	if (calls.length === 0) return [];

	const after = branch.slice(last + 1);
	const answered = new Set<string>();
	const started = new Set<string>();
	for (const entry of after) {
		if (entry.type === "message" && entry.message.role === "user") return [];
		if (entry.type === "custom_message" && entry.customType === RECOVERY_MESSAGE) return [];
		if (entry.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
		if (entry.type === "custom" && entry.customType === DISPATCH_ENTRY) {
			const id = (entry.data as Partial<DispatchRecord> | undefined)?.toolCallId;
			if (typeof id === "string") started.add(id);
		}
	}
	return calls
		.filter((call) => !answered.has(call.id))
		.map((call) => {
			const input = (call.arguments ?? {}) as Record<string, unknown>;
			const mutating = isMutatingCall(call.name, input, cwd);
			return { id: call.id, tool: call.name, input, mutating, started: mutating && started.has(call.id) };
		});
}

/** `bash \`git push\``: the call as the note names it, its command, path or address, on one line. */
function named(call: InterruptedCall): string {
	const { input } = call;
	const value = input.command ?? input.path ?? input.file_path ?? input.url ?? input.query ?? input.pattern;
	const text = typeof value === "string" ? value : JSON.stringify(input);
	return `${call.tool} \`${clip(text.replace(/\s+/g, " ").replaceAll("`", "'"), 200)}\``;
}

/** What the model is told about each call an interruption left without a result. */
export function recoveryNote(calls: readonly InterruptedCall[]): string {
	const lines = calls.map((call) => {
		if (!call.mutating) return `- ${named(call)}: it only reads. Run it again if you still need it.`;
		if (!call.started) return `- ${named(call)}: it never started. Run it again if it is still needed.`;
		return `- ${named(call)}: it started, and whether it took effect is unknown. Before running it again, check whether it did (read the file, git status or git log, the remote's state), or ask the user. Running it twice may do it twice.`;
	});
	return [
		"[mu] mu stopped while the last tool calls were running, so these have no result (they show as \"No result provided\"):",
		...lines,
	].join("\n");
}

/**
 * Interrupted tool calls (`features.recovery`, on by default). Just before a call that may change something runs,
 * after every check of mu's has let it through, mu writes a `kyrn.tool-dispatch` entry with its id. The session file
 * is appended to at once, so the entry survives mu being killed. When a session opens and its last turn has calls
 * without a result, a note tells the model which never started, which only read, and which started with an outcome
 * nobody knows, so it checks before it pushes, publishes or migrates a second time. The user sees the same note.
 */
export function registerRecovery(runtime: KyrnRuntime): void {
	const options = runtime.options("recovery", { enabled: true });
	if (!options.enabled) return;
	const { pi } = runtime;

	// Registered last of mu's tool_call handlers: a call one of them blocks never starts.
	pi.on(
		"tool_call",
		(event, ctx) => {
			if (!isMutatingCall(event.toolName, event.input as Record<string, unknown>, ctx.cwd)) return;
			pi.appendEntry<DispatchRecord>(DISPATCH_ENTRY, { toolCallId: event.toolCallId, tool: event.toolName });
		},
		{ final: true },
	);

	pi.on("session_start", async (event, ctx) => {
		runtime.touch(ctx);
		if (event.reason !== "startup" && event.reason !== "resume") return;
		const calls = interruptedCalls(ctx.sessionManager.getBranch(), ctx.cwd);
		if (calls.length === 0) return;
		pi.sendMessage({
			customType: RECOVERY_MESSAGE,
			content: recoveryNote(calls),
			display: true,
			details: { calls: calls.map(({ id, tool, mutating, started }) => ({ id, tool, mutating, started })) },
		});
	});
}
