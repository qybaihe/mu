import { JudgeError } from "./errors.ts";
import type {
	Answer,
	AnswersFor,
	Capability,
	JudgeInput,
	JudgeProvider,
	JudgeUsage,
	JudgeWarning,
	Question,
	Questions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 4000;
/** Per-request question limit reported for the judge API; larger sets are fanned out. */
const DEFAULT_MAX_QUESTIONS_PER_REQUEST = 32;

export interface JudgeOptions {
	provider: JudgeProvider;
	timeoutMs?: number;
	maxQuestionsPerRequest?: number;
}

/** Per-tier accounting when the judge is a cascade. Declared here to keep `JudgeResult` self-contained. */
export interface JudgeTierReport {
	readonly judgeId: string;
	readonly asked: number;
	readonly kept: number;
	readonly latencyMs?: number;
	readonly error?: string;
}

/** Anything that answers typed questions: one model behind a timeout, or a cascade of them. */
export interface JudgeCall<Qs extends Questions> {
	state: JudgeInput;
	questions: Qs;
	signal?: AbortSignal;
	/** What each question takes to answer. A cascade routes on it; a single judge ignores it. */
	capabilities?: Readonly<Record<string, Capability>>;
}

export interface JudgeLike {
	readonly id: string;
	evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>>;
}

export interface JudgeResult<Qs extends Questions> {
	readonly answers: AnswersFor<Qs>;
	readonly usage: JudgeUsage;
	readonly latencyMs: number;
	readonly requests: number;
	readonly providerId: string;
	/** The model the provider says it used, when it reports one. */
	readonly modelId?: string;
	/** What the provider cut or ignored. Empty when it reported nothing. */
	readonly warnings: readonly JudgeWarning[];
	/** Present when a cascade answered. */
	readonly tiers?: readonly JudgeTierReport[];
}

export function validateQuestions(questions: Questions): void {
	const ids = Object.keys(questions);
	if (ids.length === 0) throw new TypeError("A judge request needs at least one question");
	for (const id of ids) {
		const question = questions[id];
		if (question.type === "choice" && Object.keys(question.criteria).length === 0) {
			throw new TypeError(`Choice question "${id}" has no options`);
		}
		if (question.type === "score" && question.criteria.length < 2) {
			throw new TypeError(`Score question "${id}" needs at least two levels`);
		}
	}
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function answerProblem(question: Question, answer: Answer | undefined): string | undefined {
	if (!answer) return "is missing";
	if (answer.type !== question.type) return `has type "${answer.type}", expected "${question.type}"`;
	if (answer.type === "boolean") return isProbability(answer.probability) ? undefined : "has an invalid probability";
	if (answer.type === "choice" && question.type === "choice") {
		if (!Object.hasOwn(question.criteria, answer.choice)) return `picked unknown option "${answer.choice}"`;
		if (answer.probabilities !== undefined) {
			for (const [option, probability] of Object.entries(answer.probabilities)) {
				if (!Object.hasOwn(question.criteria, option)) return `reported unknown probability option "${option}"`;
				if (!isProbability(probability)) return `reported invalid probability for "${option}"`;
			}
		}
		return undefined;
	}
	if (answer.type === "score" && question.type === "score") {
		const max = question.criteria.length - 1;
		const inRange = Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= max;
		return inRange ? undefined : `has score ${answer.score} outside [0, ${max}]`;
	}
	return undefined;
}

/**
 * One judge model behind a timeout, with request fan-out and answer validation.
 *
 * Throws `JudgeError`; `DecisionEngine` turns those into fallbacks.
 */
export class Judge implements JudgeLike {
	readonly provider: JudgeProvider;
	private readonly timeoutMs: number;
	private readonly maxQuestionsPerRequest: number;

	get id(): string {
		return this.provider.id;
	}

	constructor(options: JudgeOptions) {
		this.provider = options.provider;
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const maxQuestionsPerRequest = options.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS_PER_REQUEST;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
			throw new TypeError("Judge timeoutMs must be a finite positive number");
		if (!Number.isInteger(maxQuestionsPerRequest) || maxQuestionsPerRequest < 1) {
			throw new TypeError("Judge maxQuestionsPerRequest must be a positive integer");
		}
		this.timeoutMs = timeoutMs;
		this.maxQuestionsPerRequest = maxQuestionsPerRequest;
	}

	async evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>> {
		validateQuestions(request.questions);

		const ids = Object.keys(request.questions);
		const chunks: Questions[] = [];
		for (let start = 0; start < ids.length; start += this.maxQuestionsPerRequest) {
			const chunkIds = ids.slice(start, start + this.maxQuestionsPerRequest);
			chunks.push(Object.fromEntries(chunkIds.map((id) => [id, request.questions[id]])));
		}

		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
		const startedAt = performance.now();

		let responses: Awaited<ReturnType<JudgeProvider["evaluate"]>>[];
		try {
			// Questions are answered in isolation, so chunks can run concurrently over the same state.
			responses = await Promise.all(
				chunks.map((questions) => this.provider.evaluate({ state: request.state, questions, signal })),
			);
		} catch (error) {
			if (request.signal?.aborted) throw new JudgeError("aborted", "Judge call was aborted", { cause: error });
			if (timeout.aborted) {
				throw new JudgeError("timeout", `Judge call exceeded ${this.timeoutMs} ms`, { cause: error });
			}
			if (error instanceof JudgeError) throw error;
			throw new JudgeError("unreachable", "Judge provider failed", { cause: error });
		}

		const answers: Record<string, Answer> = {};
		const usage: JudgeUsage = { inputTokens: 0, outputTokens: 0 };
		const warnings: JudgeWarning[] = [];
		for (const response of responses) {
			Object.assign(answers, response.answers);
			if (response.warnings) warnings.push(...response.warnings);
			usage.inputTokens = (usage.inputTokens ?? 0) + (response.usage?.inputTokens ?? 0);
			usage.outputTokens = (usage.outputTokens ?? 0) + (response.usage?.outputTokens ?? 0);
		}
		for (const id of ids) {
			const problem = answerProblem(request.questions[id], answers[id]);
			if (problem) throw new JudgeError("invalid_response", `Answer for "${id}" ${problem}`);
		}

		return {
			answers: answers as AnswersFor<Qs>,
			usage,
			latencyMs: Math.round(performance.now() - startedAt),
			requests: chunks.length,
			providerId: this.provider.id,
			modelId: responses.find((response) => response.modelId)?.modelId,
			warnings,
		};
	}
}
