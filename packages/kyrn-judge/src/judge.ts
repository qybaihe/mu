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

/** Adds `part` to `total`. The cache counts appear only once a provider reports them. */
export function addUsage(total: JudgeUsage, part: JudgeUsage | undefined): void {
	total.inputTokens = (total.inputTokens ?? 0) + (part?.inputTokens ?? 0);
	total.outputTokens = (total.outputTokens ?? 0) + (part?.outputTokens ?? 0);
	if (part?.cachedInputTokens !== undefined)
		total.cachedInputTokens = (total.cachedInputTokens ?? 0) + part.cachedInputTokens;
	if (part?.cacheWriteTokens !== undefined)
		total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + part.cacheWriteTokens;
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * A choice's probabilities for the question's own options, each between 0 and 1: what a model adds beyond them is
 * dropped rather than failing the whole answer, since its choice stands either way. None left: no probabilities.
 */
function withOwnProbabilities(question: Question, answer: Answer): Answer {
	if (answer.type !== "choice" || question.type !== "choice" || !answer.probabilities) return answer;
	const own = Object.entries(answer.probabilities).filter(
		([option, probability]) => Object.hasOwn(question.criteria, option) && isProbability(probability),
	);
	if (own.length === Object.keys(answer.probabilities).length) return answer;
	return { ...answer, probabilities: own.length > 0 ? Object.fromEntries(own) : undefined };
}

function answerProblem(question: Question, answer: Answer | undefined): string | undefined {
	if (!answer) return "is missing";
	if (answer.type !== question.type) return `has type "${answer.type}", expected "${question.type}"`;
	if (answer.type === "boolean") return isProbability(answer.probability) ? undefined : "has an invalid probability";
	if (answer.type === "choice" && question.type === "choice") {
		// The question's own options only: `in` also finds what every object has ("toString", "constructor").
		return Object.hasOwn(question.criteria, answer.choice) ? undefined : `picked unknown option "${answer.choice}"`;
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
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxQuestionsPerRequest = options.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS_PER_REQUEST;
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
			const requests = Promise.all(
				chunks.map((questions) => this.provider.evaluate({ state: request.state, questions, signal })),
			);
			// An external provider is expected to honor AbortSignal, but a broken or
			// third-party implementation may not. Race the provider work itself so the
			// judge still fails open at the configured deadline instead of hanging.
			const deadline = new Promise<never>((_, reject) => {
				const timer = setTimeout(
					() => reject(new JudgeError("timeout", `Judge call exceeded ${this.timeoutMs} ms`)),
					this.timeoutMs,
				);
				requests.finally(() => clearTimeout(timer)).catch(() => undefined);
			});
			// Questions are answered in isolation, so chunks can run concurrently over the same state.
			responses = await Promise.race([requests, deadline]);
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
			addUsage(usage, response.usage);
		}
		for (const id of ids) {
			const problem = answerProblem(request.questions[id], answers[id]);
			if (problem) throw new JudgeError("invalid_response", `Answer for "${id}" ${problem}`);
			answers[id] = withOwnProbabilities(request.questions[id], answers[id]);
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
