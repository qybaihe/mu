import { defineDecision } from "../decision.ts";
import { pickChoice } from "../policy.ts";

/**
 * B8: something happened outside the conversation (context is filling up, a
 * file changed on disk, a background task finished). Should the model hear
 * about it, and when? Every interruption costs tokens and attention.
 */
export interface NotifyInput {
	readonly event: string;
	readonly goal: string;
	readonly currentAction: string;
}

export type NotifyOutcome = "now" | "next_turn" | "drop";

export interface NoticeOptions {
	/** What the model reads when the notice is delivered. The judge only sees the one-line event. */
	readonly content?: string;
	/**
	 * Delivery without a verdict (the decision is off or in shadow, as it is by default; the judge is
	 * unreachable). The default is `drop`: a notice that exists only because of the judge must not appear
	 * without it. A source whose events the model has to hear of anyway (a background job that ended) passes
	 * `now`: a `next_turn` notice is only read when another run starts, which a one-shot run never does.
	 */
	readonly unjudged?: NotifyOutcome;
	/** Let a `now` verdict start a turn when the agent is idle. */
	readonly wake?: boolean;
}

/** The router of `features/notify.ts`, as other features see it. Resolves to what was done with the event. */
export type NotifyFn = (event: string, options?: NoticeOptions) => Promise<NotifyOutcome>;

export const notifyRouting = defineDecision({
	id: "notify.routing",
	version: 1,
	cacheImpact: "append-only",
	latency: "background",
	capabilities: "relate",
	questions: {
		urgency: {
			type: "choice",
			instructions: "When does the agent working on `goal` need to hear about `event`?",
			criteria: {
				now: "Immediately: continuing without it would waste work or cause harm",
				next_turn: "Soon, but it can wait until the current step is finished",
				drop: "Never: it does not affect the work",
				other: "Cannot tell",
			},
		},
	},
	buildState(input: NotifyInput) {
		return { event: input.event, goal: input.goal, current_action: input.currentAction };
	},
	policy(answers): NotifyOutcome {
		return pickChoice(answers.urgency) ?? "next_turn";
	},
	fallback(): NotifyOutcome {
		return "next_turn";
	},
});
