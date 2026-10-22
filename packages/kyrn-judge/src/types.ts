/**
 * Wire-level contract of a System One judge model.
 *
 * Mirrors the AI Gateway `evaluation-model` contract (specification v4) so a
 * request can be forwarded without translation. Verified against
 * `@ai-sdk/gateway@4.0.87`.
 */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Shared state or structured instructions. */
export type JudgeInput = string | { readonly [key: string]: JsonValue } | readonly JsonValue[];

/** Yes/no judgment. The community calls this primitive "Noul". */
export interface BooleanQuestion {
	readonly type: "boolean";
	readonly instructions: JudgeInput;
	readonly criteria?: { readonly true?: JudgeInput | null; readonly false?: JudgeInput | null };
}

/** Pick one option from a closed set. */
export interface ChoiceQuestion {
	readonly type: "choice";
	readonly instructions: JudgeInput;
	/** Option name to description. Null means no description. Must not be empty. */
	readonly criteria: Readonly<Record<string, JudgeInput | null>>;
}

/** Place the state on an ordered rubric. */
export interface ScoreQuestion {
	readonly type: "score";
	readonly instructions: JudgeInput;
	/** At least two ordered levels, indexed from zero. */
	readonly criteria: readonly (JudgeInput | null)[];
}

export type Question = BooleanQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Readonly<Record<string, Question>>;

/** Optional self-assessment some providers attach to an answer. Jev through the AI Gateway sends none. */
export interface AnswerSignals {
	/** Provider-reported confidence in [0, 1]. */
	readonly confidence?: number;
	/** Estimated probability that acting on this answer beats escalating (Laya's action head). */
	readonly actProbability?: number;
	/** Which judge produced this answer, when several are chained. */
	readonly judge?: string;
}

export interface BooleanAnswer extends AnswerSignals {
	readonly type: "boolean";
	/** Model-estimated P(true) in [0, 1]. Not confidence in either outcome. */
	readonly probability: number;
}

export interface ChoiceAnswer<Option extends string = string> extends AnswerSignals {
	readonly type: "choice";
	readonly choice: Option;
	/** Complete distribution over the options, when the provider supplies one. */
	readonly probabilities?: Readonly<Partial<Record<Option, number>>>;
}

export interface ScoreAnswer extends AnswerSignals {
	readonly type: "score";
	/** Fractional position in [0, levels - 1]. */
	readonly score: number;
	/** Distribution keyed by zero-based level index as a string. */
	readonly probabilities?: Readonly<Record<string, number>>;
}

export type Answer = BooleanAnswer | ChoiceAnswer | ScoreAnswer;

export type AnswerFor<Q extends Question> = Q extends { readonly type: "choice"; readonly criteria: infer Criteria }
	? ChoiceAnswer<Extract<keyof Criteria, string>>
	: Q extends { readonly type: "score" }
		? ScoreAnswer
		: BooleanAnswer;

export type AnswersFor<Qs extends Questions> = { readonly [Id in keyof Qs]: AnswerFor<Qs[Id]> };

export interface JudgeUsage {
	inputTokens?: number;
	outputTokens?: number;
}

/**
 * What answering a question takes, which is what separates judges in practice
 * (measured in kyrn/docs/03-local-judge.md):
 * - `classify`: say what one piece of text is or asks for.
 * - `relate`:   say how two pieces of text relate (is this skill relevant to that message?).
 * - `rate`:     place the state on an ordinal rubric.
 * - `meta`:     judge a property of the request itself (vague? decomposable?).
 * - `screen`:   read raw text from a tool (a fetched page, a listing, a build log) for what is buried in it: an
 *               instruction aimed at an AI, noise to leave out. The verdict decides what the model gets to read.
 */
export type Capability = "classify" | "relate" | "rate" | "meta" | "screen";

/** Something the provider did that the caller did not ask for, such as truncating the state. */
export interface JudgeWarning {
	readonly type: string;
	readonly message?: string;
	readonly questionId?: string;
}

export interface JudgeRequest {
	readonly state: JudgeInput;
	readonly questions: Questions;
	readonly signal?: AbortSignal;
}

export interface ProviderResponse {
	readonly answers: Readonly<Record<string, Answer>>;
	readonly usage?: JudgeUsage;
	readonly modelId?: string;
	readonly warnings?: readonly JudgeWarning[];
}

/**
 * A backend that answers typed questions about one shared state.
 *
 * Implementations throw `JudgeError`. They must not retry: the kernel owns
 * timeouts and the fail-open policy.
 */
export interface JudgeProvider {
	readonly id: string;
	evaluate(request: JudgeRequest): Promise<ProviderResponse>;
}
