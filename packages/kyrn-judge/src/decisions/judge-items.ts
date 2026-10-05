import { defineDecision } from "../decision.ts";
import type { Questions } from "../types.ts";

/**
 * The model's own question, put to the judge for many items at once (`judge_items`): "Is this test about login?" for
 * each of 300 test names, "Does this log line come from the payment service?" for each of 500 lines. Each item gets
 * the probability of yes. After oh-my-pi's `judge_batch` and the `jev_ask` tools of the pi-jev extensions: sorting
 * many items by a plain criterion is the judge's work, not the big model's.
 */
export interface ItemsInput {
	readonly question: string;
	/** What every item needs to be read by, said once. */
	readonly context: string;
	readonly items: readonly string[];
}

/** The probability of yes for each item, in order; null where the judge gave none. */
export type ItemsOutcome = readonly (number | null)[];

export function itemField(index: number): string {
	return `i${index + 1}`;
}

function itemQuestionId(index: number): string {
	return `q${index + 1}`;
}

export const judgeItems = defineDecision({
	id: "judge.items",
	version: 1,
	cacheImpact: "none",
	latency: "inline",
	questions: {} as Questions,
	questionsFor(input: ItemsInput): Questions {
		return Object.fromEntries(
			input.items.map((_, index) => [
				itemQuestionId(index),
				{ type: "boolean", instructions: `About \`${itemField(index)}\`: ${input.question}` },
			]),
		);
	},
	buildState(input: ItemsInput) {
		const state: Record<string, string> = input.context ? { context: input.context } : {};
		input.items.forEach((item, index) => {
			state[itemField(index)] = item;
		});
		return state;
	},
	policy(answers, input): ItemsOutcome {
		return input.items.map((_, index) => {
			const answer = answers[itemQuestionId(index)];
			return answer?.type === "boolean" ? answer.probability : null;
		});
	},
	fallback(input): ItemsOutcome {
		return input.items.map(() => null);
	},
});
