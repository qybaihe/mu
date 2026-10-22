import { ABSTAIN, defineDecision } from "../decision.ts";
import { isStandIn, pickChoice } from "../policy.ts";
import type { Answer, Question, Questions } from "../types.ts";

/**
 * B1, admission control for tool output: tokens that never enter the context
 * are the cheapest ones, and keeping them out costs no prompt cache. One
 * judgment per chunk, so a judge with a small window can do it too.
 *
 * The question asks what a chunk IS, not whether it is relevant to the agent's
 * intent. Measured on the local judge (kyrn/docs/03-local-judge.md): the
 * relational form called every chunk relevant, noise included, while this
 * classification put 4 of 4 noise chunks and 3 of 3 errors in the right class.
 *
 * Only a confident noise class drops a chunk. The caller archives whatever it
 * drops and leaves a one-line pointer, which keeps a wrong verdict recoverable.
 *
 * The capability is `screen`: a judge that is not trusted to screen tool output
 * (the local Laya) leaves the chunks to the next tier, and with none left, the
 * output goes in whole.
 */
export interface AdmissionInput {
	/** The call that produced the output, e.g. the shell command. */
	readonly call: string;
	readonly chunk: string;
}

export type AdmissionKind = "error" | "result" | "progress" | "warning" | "passing";

export type AdmissionOutcome = {
	readonly kind: AdmissionKind | "unknown";
	readonly drop: boolean;
};

const KINDS: readonly AdmissionKind[] = ["error", "result", "progress", "warning", "passing"];
const NOISE: readonly AdmissionKind[] = ["progress", "warning", "passing"];

/** The one question, about the chunk held in `field` of the state. */
function kindQuestion(field: string): Question {
	return {
		type: "choice",
		instructions: `What kind of output is \`${field}\`?`,
		criteria: {
			error: "An error, a failure or a stack trace",
			result: "Search results, file contents or data",
			progress: "Progress, downloads or build status",
			warning: "Repeated warnings or deprecation notices",
			passing: "Tests or checks that passed",
			other: "Something else",
		},
	};
}

/** What a chunk is, or undefined where no judge said: the cascade's stand-in for a question nobody capable answered. */
function outcomeOf(answer: Answer | undefined): AdmissionOutcome | undefined {
	if (isStandIn(answer)) return undefined;
	if (answer?.type !== "choice") return { kind: "unknown", drop: false };
	const picked = pickChoice(answer);
	const kind = KINDS.find((known) => known === picked) ?? "unknown";
	return { kind, drop: kind !== "unknown" && NOISE.includes(kind) };
}

export const toolAdmission = defineDecision({
	id: "tool.admission",
	version: 2,
	cacheImpact: "none",
	latency: "inline",
	capabilities: "screen",
	questions: { kind: kindQuestion("chunk") },
	// The chunk is the long field, so it goes last: a bounded-window judge cuts the tail.
	buildState(input: AdmissionInput) {
		return { call: input.call, chunk: input.chunk };
	},
	policy(answers): AdmissionOutcome | typeof ABSTAIN {
		return outcomeOf(answers.kind) ?? ABSTAIN;
	},
	fallback(): AdmissionOutcome {
		return { kind: "unknown", drop: false };
	},
});

/**
 * The same classification for many chunks of one output in a single request:
 * the chunks sit in the state as `c1`, `c2`, … and each has its own question.
 * The state is billed once, and the verdicts come back together. Measured on
 * jev (2026-09-23): 16 chunks in 0.44 s and 7.6k tokens, against 1.4 s and
 * 11.6k tokens as 16 requests, with the same verdicts. Only for a judge whose
 * window holds the chunks; the local sidecar takes them one at a time.
 */
export interface AdmissionBatchInput {
	readonly call: string;
	readonly chunks: readonly string[];
}

export function chunkField(index: number): string {
	return `c${index + 1}`;
}

function chunkQuestionId(index: number): string {
	return `k${index + 1}`;
}

export const toolAdmissionBatch = defineDecision({
	id: "tool.admission",
	version: 3,
	cacheImpact: "none",
	latency: "inline",
	capabilities: "screen",
	questions: {} as Questions,
	questionsFor(input: AdmissionBatchInput): Questions {
		return Object.fromEntries(
			input.chunks.map((_, index) => [chunkQuestionId(index), kindQuestion(chunkField(index))]),
		);
	},
	buildState(input: AdmissionBatchInput) {
		const state: Record<string, string> = { call: input.call };
		input.chunks.forEach((chunk, index) => {
			state[chunkField(index)] = chunk;
		});
		return state;
	},
	policy(answers, input): readonly AdmissionOutcome[] | typeof ABSTAIN {
		const outcomes = input.chunks.map((_, index) => outcomeOf(answers[chunkQuestionId(index)]));
		if (outcomes.every((outcome) => outcome === undefined)) return ABSTAIN;
		return outcomes.map((outcome) => outcome ?? { kind: "unknown", drop: false });
	},
	fallback(input): readonly AdmissionOutcome[] {
		return input.chunks.map(() => ({ kind: "unknown", drop: false }));
	},
});
