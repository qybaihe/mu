import { JudgeError } from "./errors.ts";
import type { JudgeQueue, LatencyClass } from "./queue.ts";
import type {
	Answer,
	AnswersFor,
	Capability,
	JudgeInput,
	JudgeProvider,
	JudgeUsage,
	JudgeWarning,
	ProviderResponse,
	Question,
	Questions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 4000;
/** Per-request question limit reported for the judge API; larger sets are fanned out. */
const DEFAULT_MAX_QUESTIONS_PER_REQUEST = 32;

export interface JudgeOptions {
	provider: JudgeProvider;
	/**
	 * How long the judge has for one request, counted from when it is sent. A request that stands in a line (`queue`)
	 * may wait there as long again first, so a call can take up to twice this.
	 */
	timeoutMs?: number;
	maxQuestionsPerRequest?: number;
	/**
	 * The line its requests stand in, for a judge that answers only a few at a time (`JudgeConfig.concurrency`). One
	 * line per server: every `Judge` that asks the same one shares it. Without one, each request is sent at once.
	 */
	queue?: JudgeQueue;
}

/** Per-tier accounting when the judge is a cascade. Declared here to keep `JudgeResult` self-contained. */
export interface JudgeTierReport {
	readonly judgeId: string;
	readonly asked: number;
	/**
	 * How many of them it answered: all, or none when it failed. In records up to mu 0.3.12 it can be fewer: a judge
	 * then passed the questions it was unsure of on to the next.
	 */
	readonly kept: number;
	readonly latencyMs?: number;
	/** How long its request stood in this judge's line first (`JudgeResult.queuedMs`). */
	readonly queuedMs?: number;
	readonly error?: string;
}

/** Anything that answers typed questions: one model behind a timeout, or a cascade of them. */
export interface JudgeCall<Qs extends Questions> {
	state: JudgeInput;
	questions: Qs;
	signal?: AbortSignal;
	/** What each question takes to answer. A cascade routes on it; a single judge ignores it. */
	capabilities?: Readonly<Record<string, Capability>>;
	/** The decision point that asks, by its id. A cascade reads each judge's answers by it; a single judge ignores it. */
	decision?: string;
	/**
	 * How soon the asker needs the answer. A judge that keeps a line orders its requests by it (`JudgeQueue`); any
	 * other ignores it. Not set: as for `inline`, the asker is held up.
	 */
	latency?: LatencyClass;
	/** When the asker stops waiting for the answer (`Date.now()`'s scale), read like `latency`. Not set: it waits. */
	neededBy?: number;
}

export interface JudgeLike {
	readonly id: string;
	evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>>;
}

export interface JudgeResult<Qs extends Questions> {
	readonly answers: AnswersFor<Qs>;
	readonly usage: JudgeUsage;
	/** From the ask to the answer, the wait in line included. */
	readonly latencyMs: number;
	/**
	 * How long the request stood in the judge's line before the first of it was sent (`JudgeQueue`). Not set when it
	 * went at once.
	 */
	readonly queuedMs?: number;
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

/** One request as the provider answered it, and how long it stood in line first. */
interface Sent {
	readonly response: ProviderResponse;
	readonly queuedMs: number;
}

/** What a request gives the judge to read, in characters. */
const sizeOf = (part: JudgeInput | Questions): number => JSON.stringify(part).length;

/**
 * One judge model behind a timeout, with request fan-out and answer validation.
 *
 * Throws `JudgeError`; `DecisionEngine` turns those into fallbacks.
 */
export class Judge implements JudgeLike {
	readonly provider: JudgeProvider;
	private readonly timeoutMs: number;
	private readonly maxQuestionsPerRequest: number;
	private readonly queue: JudgeQueue | undefined;

	get id(): string {
		return this.provider.id;
	}

	constructor(options: JudgeOptions) {
		this.provider = options.provider;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxQuestionsPerRequest = options.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS_PER_REQUEST;
		this.queue = options.queue;
	}

	async evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>> {
		validateQuestions(request.questions);

		const ids = Object.keys(request.questions);
		const chunks: Questions[] = [];
		for (let start = 0; start < ids.length; start += this.maxQuestionsPerRequest) {
			const chunkIds = ids.slice(start, start + this.maxQuestionsPerRequest);
			chunks.push(Object.fromEntries(chunkIds.map((id) => [id, request.questions[id]])));
		}

		const startedAt = performance.now();
		// One request that fails fails the call: the others are then worth neither the judge's time nor a place in line.
		const rest = new AbortController();
		let failure: unknown;
		const fail = (error: unknown) => {
			failure ??= error;
			rest.abort();
		};
		const signal = request.signal ? AbortSignal.any([request.signal, rest.signal]) : rest.signal;

		let sent: Sent[];
		try {
			// Questions are answered in isolation, so chunks can run concurrently over the same state.
			sent = await Promise.all(chunks.map((questions) => this.send(request, questions, signal, fail)));
		} catch (error) {
			// The requests dropped for a failure fail as aborted: the call reports what failed first.
			fail(error);
			if (request.signal?.aborted) throw new JudgeError("aborted", "Judge call was aborted", { cause: failure });
			if (failure instanceof JudgeError) throw failure;
			throw new JudgeError("unreachable", "Judge provider failed", { cause: failure });
		}

		const responses = sent.map((one) => one.response);
		const queuedMs = Math.min(...sent.map((one) => one.queuedMs));
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
			...(queuedMs > 0 ? { queuedMs } : {}),
		};
	}

	/**
	 * One request to the provider: its wait in line, when the judge keeps one, then the answer within the time limit.
	 * `fail` hears of a failure at once, while the request still has its place: the rest of the call must not get it.
	 */
	private async send(
		request: JudgeCall<Questions>,
		questions: Questions,
		signal: AbortSignal,
		fail: (error: unknown) => void,
	): Promise<Sent> {
		const ask = () =>
			this.ask(request.state, questions, signal).catch((error: unknown) => {
				fail(error);
				throw error;
			});
		if (!this.queue) return { response: await ask(), queuedMs: 0 };
		const place = {
			latency: request.latency ?? "inline",
			neededBy: request.neededBy,
			// Its size only tells it from others that wait: a request that goes at once is not measured.
			size: this.queue.busy ? sizeOf(request.state) + sizeOf(questions) : 0,
			signal,
		};
		// It may wait for as long as the judge would have had to answer it: after that the answer would come too late.
		const { value, queuedMs } = await this.queue.run(place, this.timeoutMs, ask);
		return { response: value, queuedMs };
	}

	/** The provider's answer within the time limit, which counts from now. */
	private async ask(state: JudgeInput, questions: Questions, signal: AbortSignal): Promise<ProviderResponse> {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const work = this.provider.evaluate({ state, questions, signal: AbortSignal.any([timeout, signal]) });
		// An external provider is expected to honor AbortSignal, but a broken or third-party implementation may not.
		// Race the provider work itself so the judge still fails open at the time limit instead of hanging.
		const limit = new Promise<never>((_, reject) => {
			const timer = setTimeout(
				() => reject(new JudgeError("timeout", `Judge call exceeded ${this.timeoutMs} ms`)),
				this.timeoutMs,
			);
			work.finally(() => clearTimeout(timer)).catch(() => undefined);
		});
		try {
			return await Promise.race([work, limit]);
		} catch (error) {
			// Whatever a provider makes of its signal going off, a call that ran out of time is a timeout.
			if (timeout.aborted && !signal.aborted) {
				throw new JudgeError("timeout", `Judge call exceeded ${this.timeoutMs} ms`, { cause: error });
			}
			throw error;
		}
	}
}
