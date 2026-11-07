import type {
	Answer,
	AnswerSignals,
	BooleanAnswer,
	ChoiceAnswer,
	ChoiceQuestion,
	Question,
	ScoreAnswer,
} from "./types.ts";

/**
 * Policies turn probabilities into actions. The middle zone exists so a
 * wrong-but-confident reading is the only way the judge can cause harm:
 * anything the model is unsure about falls through to the caller's default.
 */
export type Verdict = "yes" | "no" | "unsure";

export interface Thresholds {
	/** P(true) at or below this reads as "no". */
	readonly no: number;
	/** P(true) at or above this reads as "yes". */
	readonly yes: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { no: 0.2, yes: 0.8 };

export function threeZone(answer: BooleanAnswer, thresholds: Thresholds = DEFAULT_THRESHOLDS): Verdict {
	if (thresholds.no >= thresholds.yes) throw new RangeError("Thresholds need no < yes");
	if (answer.probability >= thresholds.yes) return "yes";
	if (answer.probability <= thresholds.no) return "no";
	return "unsure";
}

/**
 * Option names that mean "nothing fits". A choice question without one is
 * forced to pick a real option even for off-topic input, and does so at full
 * confidence, so specs must include one unless the option set is truly closed.
 */
export type EscapeOption = "none" | "other" | "unclear" | "unknown";

export const ESCAPE_OPTIONS: readonly EscapeOption[] = ["none", "other", "unclear", "unknown"];

const ESCAPE_OPTION_SET: ReadonlySet<string> = new Set(ESCAPE_OPTIONS);

export function isEscapeOption(option: string): option is EscapeOption {
	return ESCAPE_OPTION_SET.has(option);
}

export function hasEscapeOption(question: ChoiceQuestion): boolean {
	return Object.keys(question.criteria).some(isEscapeOption);
}

export interface PickChoiceOptions {
	/** Minimum probability of the picked option. Ignored when the provider sends no distribution. */
	readonly minProbability?: number;
}

/** The picked option, or undefined when it is an escape option or not probable enough. */
export function pickChoice<Option extends string>(
	answer: ChoiceAnswer<Option>,
	options: PickChoiceOptions = {},
): Exclude<Option, EscapeOption> | undefined {
	if (isEscapeOption(answer.choice)) return undefined;
	const probability = answer.probabilities?.[answer.choice];
	if (probability !== undefined && probability < (options.minProbability ?? 0.6)) return undefined;
	// The guard above cannot narrow a generic, so state what it established.
	return answer.choice as Exclude<Option, EscapeOption>;
}

/** Nearest rubric level, zero-based. */
export function scoreLevel(answer: ScoreAnswer): number {
	return Math.round(answer.score);
}

/**
 * Whether an answer is the neutral stand-in a cascade puts where no judge answered: none is trusted with the question
 * (`untrusted`), or the ones that are failed (`unavailable`). It looks like a verdict of 0.5 but nobody gave it.
 */
export function isStandIn(answer: AnswerSignals | undefined): boolean {
	return answer?.judge === "untrusted" || answer?.judge === "unavailable";
}

/** A maximally uncertain answer: every three-zone policy reads it as "unsure" and every choice as "nothing fits". */
export function neutralAnswer(question: Question): Answer {
	if (question.type === "boolean") return { type: "boolean", probability: 0.5 };
	if (question.type === "score") return { type: "score", score: (question.criteria.length - 1) / 2 };
	const options = Object.keys(question.criteria);
	return { type: "choice", choice: options.find(isEscapeOption) ?? options[0] };
}
