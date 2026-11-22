import { defineDecision } from "../decision.ts";
import { pickChoice } from "../policy.ts";

/** The kinds of turn a teaching card is for. */
export type TeachingKind = "product_tradeoff" | "arch_weighing" | "counterintuitive_pitfall";

export interface TeachingInput {
	/** The turn: the request, its steps oldest first, and the closing message (`turnDigest`). */
	readonly turnDigest: string;
}

export type TeachingOutcome = TeachingKind | "routine";

/**
 * Was this turn worth a teaching card: a moment where a reader without this experience would have made
 * the worse call. Asked once per completed turn, in the background; `routine` (also the fallback and
 * what an unsure verdict comes to) changes nothing anywhere. The card itself is phrased by the writer
 * model and shown to the person, never given to the model.
 */
export const turnTeaching = defineDecision({
	id: "turn.teaching",
	version: 1,
	cacheImpact: "none",
	latency: "background",
	capabilities: "relate",
	questions: {
		pivot: {
			type: "choice",
			instructions:
				"Judging by `turn_digest`, what was the pivot of this turn: the point where a reader without this experience would have made the worse call?",
			criteria: {
				product_tradeoff:
					"The answer chose between product options the user could have wanted: scope, simplicity against completeness, breaking users, cost",
				arch_weighing:
					"The answer weighed ways to build it: a library against hand-rolled code, where a layer goes, coupling, what the codebase already has",
				counterintuitive_pitfall:
					"The work hit a trap whose safe path is the opposite of what it looks like: the fix that is not the fix, the flag that does the reverse",
				routine: "Ordinary work or an ordinary answer; nothing a reader would get wrong",
				other: "Cannot tell",
			},
		},
	},
	// The digest is the long field, so it goes last: a bounded-window judge cuts the tail.
	buildState(input: TeachingInput) {
		return { turn_digest: input.turnDigest };
	},
	// Choice distributions are sharp and carry their own probabilities: the picked option is trusted at
	// 0.7, a bar the shadow ledger is to check against real turns before this point is turned on.
	policy(answers): TeachingOutcome {
		return pickChoice(answers.pivot, { minProbability: 0.7 }) ?? "routine";
	},
	fallback(): TeachingOutcome {
		return "routine";
	},
});
