import { WITHHELD_NOTES } from "../decisions/tool-injection.ts";
import { type Coded, codedError, codeOf } from "../language.ts";
import { USAGE_ENTRY, type UsageEntry } from "../usage.ts";
import {
	CHECKPOINT,
	HIVE_MESSAGE,
	LAST_CALL,
	NO_CHANGE,
	NOTES_HEADER,
	SWARM_MESSAGE,
	TOOLS_CLOSED,
	WRAP_UP,
} from "./markers.ts";

/**
 * What one sub-agent is doing, derived from the JSON event stream of its pi
 * process. Pure: the same events always give the same state, so everything the
 * user sees about a bee can be tested without starting one.
 */

export type BeeStatus =
	| "queued"
	| "starting"
	| "thinking"
	| "tool"
	| "retrying"
	| "wrapping-up"
	| "done"
	| "failed"
	| "stopped"
	| "timed-out";

export const RUNNING: readonly BeeStatus[] = ["starting", "thinking", "tool", "retrying", "wrapping-up"];

export function isRunning(status: BeeStatus): boolean {
	return RUNNING.includes(status);
}

export function isOver(status: BeeStatus): boolean {
	return status === "done" || status === "failed" || status === "stopped" || status === "timed-out";
}

export { type Coded, codedError, codeOf };

export interface BeeActivity {
	at: number;
	text: string;
	/** `notes_received` {count}, `late_notes` {count}, `asked_findings`, `told_wrap_up`, `model_error` {message}, `tool_call` {tool, summary}, `tool_failed` {tool}, `retry` {attempt, maxAttempts, message}, `compacting`. */
	code?: string;
	params?: Readonly<Record<string, string | number>>;
}

/** What its requests used, as its own messages report it; `cost` in USD at its model's catalog price. */
export interface BeeUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Output its own session recorded as an estimate (a watchdog cut, see usage.ts), included in `output`. */
	estimatedOutput?: number;
}

export interface BeeState {
	name: string;
	role?: string;
	model?: string;
	thinking?: string;
	status: BeeStatus;
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	/** Last sign of life from the process: any event, including a streamed token. */
	lastEventAt: number;
	turns: number;
	toolCalls: number;
	toolErrors: number;
	/** The tool call in flight. */
	tool?: { name: string; summary: string; startedAt: number };
	/**
	 * The beginning of the latest thing it said in words, complete or still streaming. Every view shows a message
	 * from its start (a finished bee's row, "the first of what it reported"), so only the start is kept.
	 */
	said?: string;
	retry?: { attempt: number; maxAttempts: number; delayMs: number; message: string };
	usage: BeeUsage;
	/** Hive only: notes of its own that passed the judge, and notes of others the judge handed it. */
	published: number;
	received: number;
	/**
	 * Passages its own injection screen withheld from what it read: text aimed at an AI was in its tool results. Its
	 * report is then handed back with a warning, since what the screen missed may be repeated in it.
	 */
	withheld: number;
	/** Why it is over, when it did not simply finish. */
	error?: string;
	/** The same as a code: see `BEE_ERROR_CODES` in run.ts. */
	errorCode?: string;
	errorParams?: Readonly<Record<string, string | number>>;
	/** Set by the watchdog when nothing has come out of the process for a while. */
	quietMs?: number;
	/**
	 * A wrap-up was requested: stop investigating, report now. `heardAt` is when its own stream showed it had
	 * been told (a wrap-up message, or a tool call turned away), which is the end of the step it was in.
	 */
	wrapUp?: {
		at: number;
		reason: string;
		code?: string;
		params?: Readonly<Record<string, string | number>>;
		heardAt?: number;
	};
	/** The last few things it did, newest last. */
	recent: BeeActivity[];
	/** Messages that ended a run of work: an assistant message with no tool call in it. */
	finals: string[];
	/** Where the full event log of this bee is kept. */
	transcript?: string;
}

const MAX_RECENT = 8;
const MAX_SAID = 600;

export function newBee(name: string, now: number, details: Partial<BeeState> = {}): BeeState {
	return {
		name,
		status: "queued",
		queuedAt: now,
		lastEventAt: now,
		turns: 0,
		toolCalls: 0,
		toolErrors: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		published: 0,
		received: 0,
		withheld: 0,
		recent: [],
		finals: [],
		...details,
	};
}

function flat(text: string, length: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= length ? line : `${line.slice(0, length - 1)}…`;
}

/**
 * The start of a finished message, as `said` keeps it: cut after a word or a sentence (a space, or the punctuation
 * that ends a Chinese or Japanese clause) when one is near the end, and marked as cut.
 */
function opening(text: string): string {
	if (text.length <= MAX_SAID) return text;
	const head = text.slice(0, MAX_SAID - 1);
	let end = head.length;
	while (end > MAX_SAID * 0.75 && !/[\s，。；：！？、]/.test(head[end - 1])) end--;
	return `${(end > MAX_SAID * 0.75 ? head.slice(0, end) : head).trimEnd()}…`;
}

function note(state: BeeState, at: number, text: string, coded?: Coded): void {
	state.recent.push({
		at,
		text,
		...(coded ? { code: coded.code, ...(coded.params ? { params: coded.params } : {}) } : {}),
	});
	if (state.recent.length > MAX_RECENT) state.recent.splice(0, state.recent.length - MAX_RECENT);
}

function told(state: BeeState, now: number): void {
	if (state.wrapUp?.heardAt !== undefined) return;
	if (state.wrapUp) state.wrapUp.heardAt = now;
	note(state, now, "← told to wrap up and report", { code: "told_wrap_up" });
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Record<string, unknown>[]) {
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function hasToolCall(content: unknown): boolean {
	return Array.isArray(content) && (content as Record<string, unknown>[]).some((block) => block?.type === "toolCall");
}

/** "bash npm test", "read src/app.ts", 'browse https://… "find the pricing page"': what a person wants to see of a call. */
export function summarizeCall(name: string, args: unknown): string {
	const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) if (typeof input[key] === "string" && input[key]) return input[key] as string;
		return undefined;
	};
	let detail: string | undefined;
	if (name === "bash" || name === "powershell") detail = pick("command");
	else if (name === "browse") detail = [pick("url"), pick("goal") && `"${pick("goal")}"`].filter(Boolean).join(" ");
	else if (name === "grep") detail = [pick("pattern"), pick("path", "glob")].filter(Boolean).join(" in ");
	else detail = pick("path", "file_path", "query", "pattern", "url", "command");
	if (!detail) {
		const raw = JSON.stringify(input);
		detail = raw === "{}" ? "" : raw;
	}
	return flat(`${name} ${detail}`, 140);
}

/** One event of a pi process in `--mode json`. Only the fields read here are typed. */
export interface BeeEvent {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
		customType?: string;
		stopReason?: string;
		errorMessage?: string;
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
	};
	/** `entry_appended`: an entry its own (in-memory) session took. */
	entry?: { type?: string; customType?: string; data?: unknown };
	assistantMessageEvent?: { type?: string; delta?: string };
	toolName?: string;
	args?: unknown;
	isError?: boolean;
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	errorMessage?: string;
	success?: boolean;
	finalError?: string;
	reason?: string;
}

/**
 * Folds one event into the state. Returns true when the bee's own run is over
 * (`agent_settled`: everything after it is the process shutting down).
 */
export function applyEvent(state: BeeState, event: BeeEvent, now: number): boolean {
	state.lastEventAt = now;
	state.quietMs = undefined;
	const running = () => {
		if (isOver(state.status)) return;
		state.status = state.wrapUp ? "wrapping-up" : "thinking";
	};
	switch (event.type) {
		case "agent_start":
			state.startedAt ??= now;
			running();
			break;
		case "message_start":
			if (event.message?.role === "assistant") {
				state.said = undefined;
				running();
			} else if (event.message?.role === "custom") {
				// What the harness told it: shown as something that happened to the bee, never as its own words.
				const type = event.message.customType;
				const text = type === HIVE_MESSAGE || type === SWARM_MESSAGE ? textOf(event.message.content) : "";
				const notes = text.split("\n").filter((line) => line.startsWith("- ")).length;
				if (text.startsWith(NOTES_HEADER)) {
					note(state, now, `← ${notes} note${notes === 1 ? "" : "s"} from the others`, {
						code: "notes_received",
						params: { count: notes },
					});
					// A checkpoint due at the same step comes in the same message.
					if (text.endsWith(CHECKPOINT))
						note(state, now, "← asked what it has found so far", { code: "asked_findings" });
				} else if (text.startsWith(LAST_CALL))
					note(state, now, `← last call: ${notes} late note${notes === 1 ? "" : "s"}`, {
						code: "late_notes",
						params: { count: notes },
					});
				else if (text === CHECKPOINT)
					note(state, now, "← asked what it has found so far", { code: "asked_findings" });
				else if (text.startsWith(WRAP_UP)) told(state, now);
			} else if (event.message?.role === "toolResult" && textOf(event.message.content).startsWith(TOOLS_CLOSED)) {
				// A bee asked mid-step hears it from the first tool call it makes after.
				told(state, now);
			}
			break;
		case "message_update":
			if (
				event.assistantMessageEvent?.type === "text_delta" &&
				typeof event.assistantMessageEvent.delta === "string" &&
				(state.said?.length ?? 0) < MAX_SAID
			) {
				// Past the start, the rest of the message only reaches the draft (followDraft): no view reads it here.
				state.said = `${state.said ?? ""}${event.assistantMessageEvent.delta}`.slice(0, MAX_SAID);
			}
			break;
		case "message_end": {
			const message = event.message;
			if (message?.role === "toolResult") {
				state.withheld += textOf(message.content).match(WITHHELD_NOTES)?.length ?? 0;
				break;
			}
			if (message?.role !== "assistant") break;
			const usage = message.usage;
			if (usage) {
				state.usage.input += usage.input ?? 0;
				state.usage.output += usage.output ?? 0;
				state.usage.cacheRead += usage.cacheRead ?? 0;
				state.usage.cacheWrite += usage.cacheWrite ?? 0;
				state.usage.cost += usage.cost?.total ?? 0;
			}
			const text = textOf(message.content).trim();
			if (text) state.said = opening(text);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				state.error = message.errorMessage ?? `the model request was ${message.stopReason}`;
				state.errorCode = "model_error";
				state.errorParams = { message: flat(state.error, 120), stopReason: message.stopReason };
				note(state, now, `model error: ${flat(state.error, 120)}`, {
					code: "model_error",
					params: { message: flat(state.error, 120) },
				});
				break;
			}
			// A request that went through means an earlier failure was recovered from.
			state.error = undefined;
			state.errorCode = undefined;
			state.errorParams = undefined;
			if (text && !hasToolCall(message.content)) state.finals.push(text);
			break;
		}
		case "entry_appended": {
			// Spend its own messages do not carry, such as a reply its watchdog cut: counted with the rest.
			const entry = event.entry;
			if (entry?.type !== "custom" || entry.customType !== USAGE_ENTRY || !entry.data) break;
			const spent = entry.data as Partial<UsageEntry>;
			const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
			state.usage.input += number(spent.input);
			state.usage.output += number(spent.output);
			state.usage.cacheRead += number(spent.cacheRead);
			state.usage.cacheWrite += number(spent.cacheWrite);
			state.usage.cost += number(spent.cost);
			if (spent.estimated)
				state.usage.estimatedOutput = (state.usage.estimatedOutput ?? 0) + number(spent.estimatedOutput);
			break;
		}
		case "tool_execution_start": {
			const name = event.toolName ?? "tool";
			state.toolCalls++;
			state.tool = { name, summary: summarizeCall(name, event.args), startedAt: now };
			if (!isOver(state.status)) state.status = "tool";
			note(state, now, state.tool.summary, {
				code: "tool_call",
				params: { tool: name, summary: state.tool.summary },
			});
			break;
		}
		case "tool_execution_end":
			if (event.isError) {
				state.toolErrors++;
				note(state, now, `${event.toolName ?? "tool"} failed`, {
					code: "tool_failed",
					params: { tool: event.toolName ?? "tool" },
				});
			}
			state.tool = undefined;
			running();
			break;
		case "turn_end":
			state.turns++;
			break;
		case "auto_retry_start":
			state.retry = {
				attempt: event.attempt ?? 1,
				maxAttempts: event.maxAttempts ?? 1,
				delayMs: event.delayMs ?? 0,
				message: flat(event.errorMessage ?? "request failed", 120),
			};
			if (!isOver(state.status)) state.status = "retrying";
			note(state, now, `retry ${state.retry.attempt}/${state.retry.maxAttempts}: ${state.retry.message}`, {
				code: "retry",
				params: {
					attempt: state.retry.attempt,
					maxAttempts: state.retry.maxAttempts,
					message: state.retry.message,
				},
			});
			break;
		case "auto_retry_end":
			state.retry = undefined;
			if (event.success === false) {
				state.error = event.finalError ?? "the model request kept failing";
				state.errorCode = "retries_exhausted";
				state.errorParams = { message: flat(state.error, 120) };
			}
			running();
			break;
		case "compaction_start":
			note(state, now, "compacting its context", { code: "compacting" });
			break;
		case "agent_settled":
			return true;
		default:
			break;
	}
	return false;
}

/** The longest draft kept: a report is rarely a tenth of this. */
const MAX_DRAFT = 40_000;

/** A message a bee is writing, whole: `said` keeps only its start, for the view. */
export interface Draft {
	text: string;
	/** When the message began. */
	at: number;
}

/**
 * Follows the message a bee is writing, token by token, so that one cut off
 * halfway through its report still hands back what it had written.
 */
export function followDraft(draft: Draft | undefined, event: BeeEvent, now: number): Draft | undefined {
	if (event.type === "message_start" && event.message?.role === "assistant") return { text: "", at: now };
	if (
		draft &&
		event.type === "message_update" &&
		event.assistantMessageEvent?.type === "text_delta" &&
		typeof event.assistantMessageEvent.delta === "string" &&
		draft.text.length < MAX_DRAFT
	) {
		return { ...draft, text: draft.text + event.assistantMessageEvent.delta };
	}
	if (event.type === "message_end" && event.message?.role === "assistant") {
		const text = textOf(event.message.content).trim();
		return text ? { text: text.slice(0, MAX_DRAFT), at: draft?.at ?? now } : draft;
	}
	return draft;
}

/**
 * What the bee hands back. Normally its last message. A bee that was spoken to
 * after it had finished answers with a line or two ("Acknowledged."), and that
 * must not replace the report it gave before.
 */
export function reportOf(state: Pick<BeeState, "finals">): string {
	// "NO CHANGE" is the answer to a last call, not a report: the one before it stands.
	const unchanged = new RegExp(`^\\W*${NO_CHANGE}\\W*$`, "i");
	const finals = state.finals.filter((text) => !unchanged.test(text));
	if (finals.length === 0) return "";
	const last = finals[finals.length - 1];
	const longest = finals.reduce((best, text) => (text.length > best.length ? text : best), "");
	if (longest === last || longest.length < last.length * 3) return last;
	return `${longest}\n\nAdded afterwards:\n${last}`;
}
