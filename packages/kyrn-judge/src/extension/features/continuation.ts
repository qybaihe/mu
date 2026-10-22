import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { type ContinueOutcome, turnContinue } from "../../decisions/turn-continue.ts";
import { askWithin, clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";

export const CONTINUE_MESSAGE = "kyrn.nudge";

const SAID: Readonly<Record<Exclude<ContinueOutcome, "end">, string>> = {
	promised:
		"Your last message said what you would do next, and the run ended before you did it. Do it now. If something stops you, say what it is.",
	go_ahead:
		"The user already asked for this work: carry it out without asking for a go-ahead. Where there is a choice, take the one the request most plainly means and say which. Pause only before a step that is hard to undo or reaches beyond this machine.",
};

const EMPTY =
	"Your last reply had no message and no tool call, so the run ended with nothing to show for it. Carry on with the task: take the next step, or, if the work is done, say what you did and what came of it.";

/** The text of the message a run ended on, when it ended plainly and without a call; "" when that message has no text. */
function plainEnd(event: AgentEndEvent): string | undefined {
	const last = [...event.messages].reverse().find((message) => message.role === "assistant") as
		| { content?: unknown; stopReason?: unknown }
		| undefined;
	if (!last || last.stopReason !== "stop") return undefined;
	const parts = Array.isArray(last.content) ? last.content : [];
	if (parts.some((part) => (part as { type?: unknown } | null)?.type === "toolCall")) return undefined;
	return textOf(last.content).trim();
}

/** The message a run ended on, when it is one that could have stopped short: a plain end, no call, some text. */
export function stoppedOn(event: AgentEndEvent): string | undefined {
	return plainEnd(event) || undefined;
}

/** A run that ended on a message with nothing in it but thinking, or nothing at all: it stopped without a word. */
export function endedEmpty(event: AgentEndEvent): boolean {
	return plainEnd(event) === "";
}

/**
 * turn.continue: a run that ends on "Let me run the tests next." and no call, or on asking for a go-ahead on work the
 * user asked for, is sent back to it (see decisions/turn-continue.ts). Registered after the completion check and the
 * language servers' end-of-run report: when one of them already sent the agent back, this says nothing. At most
 * `maxNudges` times per message of the user, so a model that keeps stopping does not loop. With a goal running, its
 * own check sends the agent back.
 *
 * A run that ends on a message with no text and no call (the model thought, then stopped) is sent back by rule, with
 * no judge to ask: there is nothing in it to judge, and nobody would notice the silence in an unattended run.
 */
export function registerContinuation(runtime: KyrnRuntime): void {
	const options = runtime.options("continuation", { enabled: true, waitMs: 3000, maxNudges: 2 });
	if (!options.enabled) return;
	const { pi } = runtime;

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>(async (event, ctx) => {
			runtime.touch(ctx);
			if (runtime.goalActive || runtime.harnessAbort || runtime.nudgedEnds.has(event)) return undefined;
			const turn = runtime.turn;
			if (turn.continued >= options.maxNudges) return undefined;
			if (endedEmpty(event)) {
				turn.continued += 1;
				runtime.nudgedEnds.add(event);
				pi.sendMessage({ customType: CONTINUE_MESSAGE, content: EMPTY, display: true }, { triggerTurn: true });
				return undefined;
			}
			const finalMessage = stoppedOn(event);
			if (!finalMessage) return undefined;
			// Where a message stops short is its end, so the end is what the judge reads.
			const flat = finalMessage.replace(/\s+/g, " ");
			const input = {
				userMessage: clip(turn.userMessage, 400),
				finalMessage: flat.length <= 600 ? flat : `…${flat.slice(-599)}`,
			};
			// A verdict later than the wait is not worth having, in shadow either: the call is aborted then, so it does
			// not keep a one-shot run from exiting.
			const ask = () =>
				askWithin((signal) => runtime.engine.decide(turnContinue, input, { signal }), options.waitMs);
			if (runtime.mode(turnContinue.id) !== "active") {
				void ask().catch(() => {});
				return undefined;
			}
			const decision = await ask();
			if (decision?.source !== "judge" || decision.outcome === "end") return undefined;
			// The user may have stopped it, or another check sent it back, while the verdict was on its way.
			if (runtime.harnessAbort || runtime.nudgedEnds.has(event)) return undefined;
			turn.continued += 1;
			runtime.nudgedEnds.add(event);
			pi.sendMessage(
				{ customType: CONTINUE_MESSAGE, content: SAID[decision.outcome], display: true },
				{ triggerTurn: true },
			);
			return undefined;
		}),
	);
}
