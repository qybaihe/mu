import { defineDecision } from "../decision.ts";
import { threeZone } from "../policy.ts";
import type { Answer } from "../types.ts";

/**
 * Judged rewind. The monitor knows THAT the agent goes in circles (a rule) or has drifted; whether the
 * approach itself is a dead end is a judgment. Only a confident dead end with no progress proposes
 * going back to the turn's checkpoint, and proposing is all it does: the user confirms, never the judge.
 * The dead end has to be confident; "no progress" only has to be the likelier reading (p < 0.5): on the
 * steps that set this question off, a small judge seldom calls progress clearly absent, and a proposal
 * changes nothing by itself.
 *
 * The cheapest recovery from a dead end is the state before it, plus one line about what was learned,
 * instead of more fixes on a broken path and the whole failed attempt carried in the context.
 */
export type RewindInput = {
	readonly goal: string;
	/** One line per recent tool call with its outcome, oldest first. */
	readonly recentSteps: readonly string[];
	/** Why the question is asked now, e.g. "the same failing command ran 3 times". */
	readonly trigger: string;
	readonly editsSinceCheckpoint: number;
	/** Whether the latest test, build or lint run failed; undefined when none ran. */
	readonly lastCheckFailed?: boolean;
};

export type RewindOutcome = "continue" | "propose";

/**
 * `progress` reads as none below this: the likelier reading, not a confident one. At exactly 0.5 the judge has no
 * opinion (or none answered and a cascade stood in), and that changes nothing.
 */
export const NO_PROGRESS_BELOW = 0.5;

const noProgress = (answer: Answer | undefined) => answer?.type === "boolean" && answer.probability < NO_PROGRESS_BELOW;

export const turnRewind = defineDecision({
	id: "turn.rewind",
	// v2: no progress below p 0.5 (was at or below 0.2).
	version: 2,
	// A proposal is a dialog or one steering line; going back itself is the user's act.
	cacheImpact: "append-only",
	latency: "inline",
	capabilities: { dead_end: "classify", progress: "relate" },
	questions: {
		dead_end: {
			type: "boolean",
			instructions: "Does `recent_steps` show the same approach failing again and again?",
		},
		progress: { type: "boolean", instructions: "Does `recent_steps` show progress towards `goal`?" },
	},
	buildState(input: RewindInput) {
		return {
			recent_steps: input.recentSteps,
			goal: input.goal,
			trigger: input.trigger,
			edits_since_checkpoint: input.editsSinceCheckpoint,
			last_check_failed: input.lastCheckFailed ?? null,
		};
	},
	policy(answers): RewindOutcome {
		return threeZone(answers.dead_end) === "yes" && noProgress(answers.progress) ? "propose" : "continue";
	},
	fallback(): RewindOutcome {
		return "continue";
	},
});
