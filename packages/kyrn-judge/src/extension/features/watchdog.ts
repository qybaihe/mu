import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateReasoningTokens, USAGE_ENTRY, type UsageEntry } from "../../usage.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

export const WATCHDOG_MESSAGE = "kyrn.watchdog";

/** How much of the cut reasoning goes back with the retry: where it had got to, not the whole way there. */
const TAIL_CHARS = 2000;

/** With a deadline, a reply still gets at least this long to think before it is cut. */
const MIN_CUT_MS = 60_000;

function minutes(ms: number): string {
	const total = Math.round(ms / 60_000);
	return total === 1 ? "1 minute" : `${total} minutes`;
}

/**
 * How long a reply may only think before it is cut. Without a deadline (`remainingMs` undefined), `thinkingMs`. With
 * one, at most half the time that was left when the reply started, and never under a minute: on Terminal-Bench a reply
 * that began thinking 3 to 5 minutes into a 15-minute task was cut 13 to 15 minutes in, too late for its retry to finish.
 */
export function cutAfterMs(thinkingMs: number, remainingMs: number | undefined): number {
	if (remainingMs === undefined) return thinkingMs;
	return Math.min(thinkingMs, Math.max(MIN_CUT_MS, remainingMs / 2));
}

/**
 * What a cut reply cost beyond what its message reports. The aborted request usually reports no usage at all (an
 * OpenAI-compatible stream sends it in its last chunk, which never comes), so the reasoning that had streamed is
 * estimated (`REASONING_CHARS_PER_TOKEN`); whatever output the provider did report is subtracted, so nothing is counted
 * twice. The request's prompt is not estimated: it is mostly a cache read. Undefined when there is nothing to add.
 */
export function cutUsage(
	message: AssistantMessage,
	streamedChars: number,
	thinkingMs: number,
	model: Model<Api> | undefined,
): UsageEntry | undefined {
	const kept = message.content.reduce(
		(sum, block) => sum + (block.type === "thinking" ? block.thinking.length : 0),
		0,
	);
	const chars = Math.max(streamedChars, kept);
	const output = Math.max(0, estimateReasoningTokens(chars) - (message.usage?.output ?? 0));
	if (output === 0) return undefined;
	const priced = model?.provider === message.provider && model.id === message.model ? model : undefined;
	return {
		source: "watchdog-cut",
		model: `${message.provider}/${message.model}`,
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		...(priced ? { cost: (priced.cost.output / 1_000_000) * output } : {}),
		estimated: true,
		estimatedOutput: output,
		thoughtChars: chars,
		thinkingMs,
	};
}

/**
 * A reply that does nothing but think for `thinkingMs` (10 minutes by default) is cut and asked again, at the same
 * reasoning effort. Some models write 30,000 to 70,000 reasoning tokens in a single reply, which can take most of a
 * run's time budget before anything is done. The retry is told where the cut reasoning had got to and asked to act
 * on it rather than think it all through again.
 *
 * - Only a reply that has written nothing yet is cut. Text or a tool call means the model is acting.
 * - When the run has a deadline (`runtime.deadlineAt`, see deadline.ts), the cut can come sooner: see `cutAfterMs`.
 * - The retry itself is never cut: a reply that really needs longer gets all the time it needs the second time.
 * - At most `maxCuts` cuts between two messages of the user.
 * - What the cut reply spent is recorded as a `kyrn.usage` entry (`cutUsage`): no message of the session carries it.
 */
export function registerWatchdog(runtime: KyrnRuntime): void {
	const options = runtime.options("watchdog", { enabled: true, thinkingMs: 600_000, maxCuts: 3 });
	if (!options.enabled || !(options.thinkingMs > 0)) return;
	const { pi } = runtime;

	/** Counts assistant messages, so a timer knows whether the reply it watches is still the one being written. */
	let message = 0;
	let timer: NodeJS.Timeout | undefined;
	let acted = false;
	let thought = "";
	/** All of the reasoning streamed in the reply being written; `thought` keeps only its end. */
	let thoughtChars = 0;
	let cuts = 0;
	/** The next reply is the retry of a cut one. */
	let spare = false;
	let cut: { about: number; ms: number; tail: string; usage?: UsageEntry } | undefined;

	const stopTimer = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const watch = (ctx: ExtensionContext, about: number, startedAt: number): void => {
		const after = cutAfterMs(
			options.thinkingMs,
			runtime.deadlineAt === undefined ? undefined : runtime.deadlineAt - startedAt,
		);
		timer = setTimeout(() => {
			timer = undefined;
			if (message !== about || acted || cut !== undefined) return;
			cuts++;
			cut = { about, ms: Date.now() - startedAt, tail: thought.slice(-TAIL_CHARS) };
			runtime.harnessAbort = true;
			runtime.present("watchdog.cut", { thinkingMs: cut.ms, thoughtChars });
			ctx.abort();
		}, after);
		// A watchdog never keeps the process alive.
		timer.unref();
	};

	pi.on(
		"input",
		failOpen((event) => {
			if (event.source !== "extension" && event.text.trim() && !event.streamingBehavior) cuts = 0;
			return undefined;
		}),
	);
	pi.on(
		"agent_start",
		failOpen(() => {
			runtime.harnessAbort = false;
			return undefined;
		}),
	);
	pi.on(
		"message_start",
		failOpen((event, ctx) => {
			if (event.message.role !== "assistant") return undefined;
			message++;
			stopTimer();
			acted = false;
			thought = "";
			thoughtChars = 0;
			if (spare) {
				spare = false;
				return undefined;
			}
			if (cuts < options.maxCuts) watch(ctx, message, Date.now());
			return undefined;
		}),
	);
	pi.on(
		"message_update",
		failOpen((event) => {
			const update = event.assistantMessageEvent;
			if (update.type === "thinking_delta") {
				thought += update.delta;
				thoughtChars += update.delta.length;
				// Only the end is ever sent back.
				if (thought.length > 4 * TAIL_CHARS) thought = thought.slice(-TAIL_CHARS);
			} else if (update.type === "text_delta" || update.type === "toolcall_start") {
				acted = true;
				stopTimer();
			}
			return undefined;
		}),
	);
	pi.on(
		"message_end",
		failOpen((event, ctx) => {
			if (event.message.role !== "assistant") return undefined;
			stopTimer();
			if (cut?.about === message && cut.usage === undefined) {
				cut.usage = cutUsage(event.message, thoughtChars, cut.ms, ctx.model);
			}
			return undefined;
		}),
	);
	// As with the mid-stream correction: once the cut run has settled, the message starts the next run by itself.
	pi.on(
		"agent_settled",
		failOpen(() => {
			const was = cut;
			cut = undefined;
			stopTimer();
			if (was === undefined) return undefined;
			spare = true;
			if (was.usage) pi.appendEntry<UsageEntry>(USAGE_ENTRY, was.usage);
			const tail = was.tail.trim();
			pi.sendMessage(
				{
					customType: WATCHDOG_MESSAGE,
					content: [
						`Your last reply was stopped after ${minutes(was.ms)} of thinking without a message or a tool call.`,
						...(tail ? ["Its reasoning had gotten this far:", `"""\n…${tail}\n"""`] : []),
						"Do not start that reasoning over. Act on what it found: take the next concrete step now (run a command, write the file, test one idea), then reason further on what the result shows.",
					].join("\n"),
					display: true,
					details: { thinkingMs: was.ms },
				},
				{ triggerTurn: true },
			);
			return undefined;
		}),
	);
}
