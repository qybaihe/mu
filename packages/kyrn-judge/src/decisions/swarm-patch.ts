import { defineDecision } from "../decision.ts";
import { DEFAULT_THRESHOLDS, type Thresholds, threeZone } from "../policy.ts";
import type { Questions } from "../types.ts";

/**
 * C5, the way back from an isolated sub-agent. In the hive the judge gates
 * what passes between bees; here it looks at what a worker wants to bring
 * into the user's working tree: does the change stay within the task, and
 * which files have nothing to do with it (a lockfile, a reformatted module).
 *
 * It sees the task, the changed paths and the line counts, never the diff.
 * The verdict is a line of text next to the patch for the parent model to
 * weigh. It never blocks: applying a patch is the parent's call.
 */
export interface PatchReviewFile {
	readonly path: string;
	/** "modified +10 -2", "added +30 -0", "deleted", "binary". */
	readonly change: string;
}

export interface PatchReviewInput {
	readonly task: string;
	readonly files: readonly PatchReviewFile[];
}

export type PatchReviewOutcome = {
	/** Whether the change as a whole stays within the task. Null when the judge is not sure. */
	readonly withinTask: boolean | null;
	/** Paths the judge is sure the task did not call for. */
	readonly unrelated: readonly string[];
	/** How many files were asked about: a long patch is only judged up to a cap. */
	readonly judged: number;
};

/**
 * Where a file counts as unrelated. A small judge often stops between 0.2 and 0.3 on a file the task never needs (a
 * lockfile, a scratch script, an editor's settings), so on held-out sessions a "no" here starts at 0.3. At 0.5 the
 * judge has no opinion and nothing is said.
 */
export const UNRELATED_FILE: Thresholds = { no: 0.3, yes: DEFAULT_THRESHOLDS.yes };

/** One question per file costs tokens per file; beyond this the overall question has to do. */
export const MAX_JUDGED_FILES = 12;

export function patchFileQuestionId(index: number): string {
	return `file_${index}`;
}

export const swarmPatch = defineDecision({
	id: "swarm.patch",
	// v2: a file is unrelated from p <= 0.3 (was 0.2).
	version: 2,
	// One line appended to a tool result.
	cacheImpact: "append-only",
	latency: "inline",
	capabilities: "relate",
	questions: {} as Questions,
	questionsFor(input: PatchReviewInput): Questions {
		return {
			within_task: { type: "boolean", instructions: "Does `change` stay within what `task` asks for?" },
			...Object.fromEntries(
				input.files.slice(0, MAX_JUDGED_FILES).map((file, index) => [
					patchFileQuestionId(index),
					{
						type: "boolean" as const,
						instructions: `Does \`task\` call for changing this file? ${file.path} (${file.change})`,
					},
				]),
			),
		};
	},
	buildState(input: PatchReviewInput) {
		// The task first: a small judge keeps the head of the state and cuts the tail.
		return { task: input.task, change: input.files.map((file) => `${file.path} (${file.change})`).join("\n") };
	},
	policy(answers, input): PatchReviewOutcome {
		const overall = answers.within_task;
		const verdict = overall?.type === "boolean" ? threeZone(overall) : "unsure";
		const judged = input.files.slice(0, MAX_JUDGED_FILES);
		const unrelated = judged
			.filter((_, index) => {
				const answer = answers[patchFileQuestionId(index)];
				// Only a "no": a file the judge merely hesitates about is not worth the parent's attention.
				return answer?.type === "boolean" && threeZone(answer, UNRELATED_FILE) === "no";
			})
			.map((file) => file.path);
		return { withinTask: verdict === "unsure" ? null : verdict === "yes", unrelated, judged: judged.length };
	},
	fallback(): PatchReviewOutcome {
		return { withinTask: null, unrelated: [], judged: 0 };
	},
});

/** "3 files in scope, 1 looks unrelated to the task: package-lock.json". Undefined when there is nothing to say. */
export function describePatchReview(outcome: PatchReviewOutcome, totalFiles: number): string | undefined {
	const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`;
	const unchecked =
		totalFiles > outcome.judged && outcome.judged > 0 ? ` (${totalFiles - outcome.judged} not checked)` : "";
	if (outcome.unrelated.length > 0) {
		const inScope = outcome.judged - outcome.unrelated.length;
		const verb = outcome.unrelated.length === 1 ? "looks" : "look";
		return `${files(inScope)} in scope, ${outcome.unrelated.length} ${verb} unrelated to the task: ${outcome.unrelated.join(", ")}${unchecked}`;
	}
	if (outcome.withinTask === false) return `the change as a whole looks wider than the task${unchecked}`;
	if (outcome.withinTask === true && outcome.judged > 0) return `${files(outcome.judged)} in scope${unchecked}`;
	return undefined;
}
