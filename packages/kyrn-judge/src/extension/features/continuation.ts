import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { type ContinueOutcome, turnContinue } from "../../decisions/turn-continue.ts";
import { askWithin, clip, failOpen, type KyrnRuntime, type TurnState, textOf } from "../runtime.ts";
import { isUnattended } from "./unattended.ts";

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

/** Whether any reply of the run called a tool. */
function madeCall(event: AgentEndEvent): boolean {
	return event.messages.some(
		(message) =>
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some((part) => (part as { type?: unknown } | null)?.type === "toolCall"),
	);
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
 *
 * In an unattended run a "you said you would" verdict (`promised`) sends the agent back at most `unattendedPromised`
 * times per message, and not at all when the run that just ended was the agent's answer to a nudge and called no tool:
 * it answered by stopping. Terminal-Bench 2.1, constraints-scheduling: the judge read "Done. Created …" as a promise,
 * the agent answered the nudge "The work is already complete", the judge said the same again, and the second nudge sent
 * the agent searching / for test files (4 extra requests). A go-ahead and an ending with no message are not limited
 * this way. An interactive session is unchanged: someone is there to say "keep going".
 */
export function registerContinuation(runtime: KyrnRuntime): void {
	const options = runtime.options("continuation", {
		enabled: true,
		waitMs: 3000,
		maxNudges: 2,
		/** "You said you would" nudges per message of the user in an unattended run. `maxNudges` caps all of them together. */
		unattendedPromised: 1,
		/** In an unattended run, such a nudge after the agent answered a nudge without calling a tool. */
		promisedAfterToolless: false,
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	const spec = turnContinue;
	const declared = spec.capabilities;
	const trusted = (question: string): boolean =>
		runtime.trusts(spec.id, (typeof declared === "object" ? declared[question] : declared) ?? "classify");
	/**
	 * Whether a verdict could send the agent back: `promised` answered, or all three questions of a go-ahead, and
	 * `irreversible`, whose neutral answer ends the run. A judge trusted on neither `promised` (`intent`) nor a go-ahead
	 * (`meta`, `relate`) could only say "end", and asking it would only hold up the end of the run, by up to `waitMs`.
	 */
	const canSendBack = () =>
		trusted("irreversible") &&
		(trusted("promised") || (trusted("asks_go_ahead") && trusted("work_requested") && trusted("beyond_request")));
	/** The turn in which the last end was sent back to work, by this check or another: the next run answers that nudge. */
	let nudgedIn: TurnState | undefined;
	const promisedNudges = new WeakMap<TurnState, number>();

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>(async (event, ctx) => {
			runtime.touch(ctx);
			if (runtime.goalActive || runtime.harnessAbort) return undefined;
			const turn = runtime.turn;
			const answeredNudge = nudgedIn === turn;
			nudgedIn = undefined;
			if (runtime.nudgedEnds.has(event)) {
				nudgedIn = turn;
				return undefined;
			}
			if (turn.continued >= options.maxNudges) return undefined;
			if (endedEmpty(event)) {
				turn.continued += 1;
				runtime.nudgedEnds.add(event);
				nudgedIn = turn;
				pi.sendMessage({ customType: CONTINUE_MESSAGE, content: EMPTY, display: true }, { triggerTurn: true });
				return undefined;
			}
			const finalMessage = stoppedOn(event);
			if (!finalMessage || !canSendBack()) return undefined;
			// Where a message stops short is its end, so the end is what the judge reads.
			const flat = finalMessage.replace(/\s+/g, " ");
			const input = {
				userMessage: clip(turn.userMessage, 400),
				finalMessage: flat.length <= 600 ? flat : `…${flat.slice(-599)}`,
			};
			// A verdict later than the wait is not worth having, in shadow either: the call is aborted then, so it does
			// not keep a one-shot run from exiting.
			const ask = () => askWithin((signal) => runtime.engine.decide(spec, input, { signal }), options.waitMs);
			if (runtime.mode(spec.id) !== "active") {
				void ask().catch(() => {});
				return undefined;
			}
			const decision = await ask();
			if (decision?.source !== "judge" || decision.outcome === "end") return undefined;
			// The user may have stopped it, or another check sent it back, while the verdict was on its way.
			if (runtime.harnessAbort) return undefined;
			if (runtime.nudgedEnds.has(event)) {
				nudgedIn = turn;
				return undefined;
			}
			if (decision.outcome === "promised" && isUnattended(ctx)) {
				const promised = promisedNudges.get(turn) ?? 0;
				if (promised >= options.unattendedPromised) return undefined;
				if (answeredNudge && !options.promisedAfterToolless && !madeCall(event)) return undefined;
				promisedNudges.set(turn, promised + 1);
			}
			turn.continued += 1;
			runtime.nudgedEnds.add(event);
			nudgedIn = turn;
			pi.sendMessage(
				{ customType: CONTINUE_MESSAGE, content: SAID[decision.outcome], display: true },
				{ triggerTurn: true },
			);
			return undefined;
		}),
	);
}
