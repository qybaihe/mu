import { defineDecision } from "../decision.ts";
import { threeZone } from "../policy.ts";
import type { Questions } from "../types.ts";

/**
 * A conversation opens with the agent finding its way: it lists the folder, then reads the files the task is about,
 * one step each. Which files those are can often be told from the task and the paths alone. One yes/no per candidate
 * file asks whether the agent will have to read it for this task; the files the judge is sure of are given to the
 * model with the first message, so the steps that would have read them are not taken.
 *
 * A forecast, with its truth on the way: the files the opening steps then read say what the verdict was worth
 * (`PreloadRead` in features/preload.ts). The judge sees the task and the paths, never a file's contents.
 *
 * Only a confident yes brings a file in. A file that was not needed costs its length in every request after it, so
 * anything short of sure is left for the agent to read when it wants it.
 */
export interface PreloadInput {
	/** What the user asked for, in their words. */
	readonly task: string;
	/** Candidate files, relative to the project. */
	readonly paths: readonly string[];
}

export type PreloadOutcome = {
	/** The files the judge is sure the task needs, the surest first. */
	readonly read: readonly { readonly path: string; readonly probability: number }[];
};

const PATH_LENGTH = 200;

export function preloadQuestionId(index: number): string {
	return `file_${index}`;
}

export const contextPreload = defineDecision({
	id: "context.preload",
	version: 1,
	// What it brings in is a message beside the user's: nothing before it changes.
	cacheImpact: "append-only",
	latency: "parallel",
	capabilities: "relate",
	questions: {} as Questions,
	questionsFor(input: PreloadInput): Questions {
		return Object.fromEntries(
			input.paths.map((path, index) => [
				preloadQuestionId(index),
				{
					type: "boolean" as const,
					instructions: `Will the agent have to read this file to do \`task\`? ${path.slice(0, PATH_LENGTH)}`,
				},
			]),
		);
	},
	buildState(input: PreloadInput) {
		return { task: input.task };
	},
	policy(answers, input): PreloadOutcome {
		const read: { path: string; probability: number }[] = [];
		input.paths.forEach((path, index) => {
			const answer = answers[preloadQuestionId(index)];
			if (answer?.type === "boolean" && threeZone(answer) === "yes") {
				read.push({ path, probability: answer.probability });
			}
		});
		return { read: read.sort((a, b) => b.probability - a.probability) };
	},
	fallback(): PreloadOutcome {
		return { read: [] };
	},
});
