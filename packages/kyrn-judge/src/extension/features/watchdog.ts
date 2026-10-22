import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

export const WATCHDOG_MESSAGE = "kyrn.watchdog";

/** How much of the cut reasoning goes back with the retry: where it had got to, not the whole way there. */
const TAIL_CHARS = 2000;

function minutes(ms: number): string {
	const total = Math.round(ms / 60_000);
	return total === 1 ? "1 minute" : `${total} minutes`;
}

/**
 * A reply that does nothing but think for `thinkingMs` (10 minutes by default) is cut and asked again, at the same
 * reasoning effort. Some models write 30,000 to 70,000 reasoning tokens in a single reply, which can take most of a
 * run's time budget before anything is done. The retry is told where the cut reasoning had got to and asked to act
 * on it rather than think it all through again.
 *
 * - Only a reply that has written nothing yet is cut. Text or a tool call means the model is acting.
 * - The retry itself is never cut: a reply that really needs longer gets all the time it needs the second time.
 * - At most `maxCuts` cuts between two messages of the user.
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
	let cuts = 0;
	/** The next reply is the retry of a cut one. */
	let spare = false;
	let cut: { ms: number; tail: string } | undefined;

	const stopTimer = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const watch = (ctx: ExtensionContext, about: number, startedAt: number): void => {
		timer = setTimeout(() => {
			timer = undefined;
			if (message !== about || acted || cut !== undefined) return;
			cuts++;
			cut = { ms: Date.now() - startedAt, tail: thought.slice(-TAIL_CHARS) };
			runtime.harnessAbort = true;
			runtime.present("watchdog.cut", { thinkingMs: cut.ms, thoughtChars: thought.length });
			ctx.abort();
		}, options.thinkingMs);
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
		failOpen((event) => {
			if (event.message.role === "assistant") stopTimer();
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
