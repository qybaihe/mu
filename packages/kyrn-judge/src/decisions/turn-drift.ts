import { defineDecision } from "../decision.ts";
import { pickChoice } from "../policy.ts";

/**
 * B5, drift monitor: is the run still moving toward the goal?
 *
 * Version 1 saw the goal and the last 8 calls as `tool: <command> -> ok|error`: no output, no time, nothing that
 * says whether anything got better. On Terminal-Bench 2.1 Jev never read drift in 298 calls, also not in runs stuck
 * for 40 minutes, and about 9 in 10 of another judge's drift steers were wrong. Version 2 sees what shows whether a
 * run moves: exit codes, times, the last line of output, how long since the last sign of progress, and how often one
 * call came back the same.
 */
export interface DriftInput {
	readonly goal: string;
	/** What the latest message asked for, when it is not the goal itself. */
	readonly subgoal?: string;
	/** The first acceptance item of the task frame that is not done yet. */
	readonly openItem?: string;
	/** One line per recent action, newest last: `bash: make -> exit 2 in 14s; last line: <line>`. */
	readonly recentActions: readonly string[];
	/**
	 * Since the last sign of progress: a new file written, more tests passing, a different error, a long command
	 * finishing, an item ticked.
	 */
	readonly minutesSinceProgress: number;
	readonly elapsedMinutes: number;
	/** The most times one call ran in the window with the same outcome. 1 means nothing came back the same. */
	readonly repeats: number;
}

export type DriftOutcome = "on_track" | "detour" | "drift" | "loop" | "unknown";

/**
 * How sure the judge has to be for each reading. A drift reading is acted on only twice in a row and after a stretch
 * with no progress (the monitor's rule); a loop reading is acted on like the loop rule, once per call.
 */
const MIN_PROBABILITY: Readonly<Record<string, number>> = { drift: 0.9, loop: 0.8 };

export const turnDrift = defineDecision({
	id: "turn.drift",
	version: 2,
	cacheImpact: "append-only",
	latency: "background",
	capabilities: "relate",
	questions: {
		course: {
			type: "choice",
			instructions:
				"Are `recent_actions` still moving toward `goal` (and `open_item`, when given)? `minutes_since_progress` counts from the last sign of progress: a new file written, more tests passing, a different error, a long command finishing, an item ticked. `repeats_in_window` is the most times one call came back the same.",
			criteria: {
				on_track: "They work on the goal, and what comes back changes from one action to the next",
				detour: "A necessary side step that leads back to the goal",
				drift: "They have moved to something the goal does not need",
				loop: "The same actions come back the same, with no progress",
				other: "Cannot tell",
			},
		},
	},
	buildState(input: DriftInput) {
		return {
			goal: input.goal,
			...(input.subgoal ? { current_subgoal: input.subgoal } : {}),
			...(input.openItem ? { open_item: input.openItem } : {}),
			recent_actions: input.recentActions,
			minutes_since_progress: input.minutesSinceProgress,
			elapsed_minutes: input.elapsedMinutes,
			repeats_in_window: input.repeats,
		};
	},
	policy(answers): DriftOutcome {
		const minProbability = MIN_PROBABILITY[answers.course.choice] ?? 0.7;
		return pickChoice(answers.course, { minProbability }) ?? "unknown";
	},
	fallback(): DriftOutcome {
		return "unknown";
	},
});
