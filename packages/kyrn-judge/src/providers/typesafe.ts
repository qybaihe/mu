import { JudgeError, type JudgeErrorKind } from "../errors.ts";
import type { Answer, JudgeProvider, JudgeRequest, ProviderResponse, Question } from "../types.ts";
import type { ApiKeyResolver } from "./gateway.ts";
import { MAX_ERROR_MESSAGE_LENGTH, messageFromErrorBody, readWarnings } from "./http.ts";

export const TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";
/** OpenRouter names Jev its own way: without a model, a judge that posts there asks for this one. */
export const OPENROUTER_DEFAULT_MODEL = "~typesafe/jev-latest";
/** Where `clm-serve` listens unless told otherwise, and the model it serves by default. */
export const CLM_BASE_URL = "http://127.0.0.1:8700";
export const CLM_DEFAULT_MODEL = "clm-latest";

/**
 * A CLM server's System One endpoint. The address may be written as `clm-serve` prints it
 * (`http://host:8700/v1/systemone`) or as CLM's own client takes it (`http://host:8700`, also `…/v1`).
 */
export function clmEndpoint(baseUrl: string | undefined): string {
	const url = (baseUrl || CLM_BASE_URL).replace(/\/+$/, "");
	if (!URL.canParse(url)) return url;
	const path = new URL(url).pathname;
	return path === "/" ? `${url}/v1/systemone` : path === "/v1" ? `${url}/systemone` : url;
}

export interface TypeSafeJudgeProviderOptions {
	/** A key, or a resolver called per request so the host owns credential storage. */
	apiKey: string | ApiKeyResolver;
	/** The variable the key is read from, named when it is missing. */
	keyName?: string;
	/** Call without a key when none is set, for a server that may not ask for one (CLM unless it sets CLM_API_KEY). */
	keyOptional?: boolean;
	/** The judge the service runs when it is not Jev, named in errors: "CLM" makes them say "CLM at <host>". */
	judgeName?: string;
	model?: string;
	/** Any service that speaks System One (TypeSafe, OpenRouter, a relay); empty is TypeSafe's own. */
	baseUrl?: string;
	fetch?: typeof fetch;
}

interface SystemOneBody {
	model?: unknown;
	answers?: Record<string, Record<string, unknown>>;
	usage?: { input_tokens?: unknown; output_tokens?: unknown };
	warnings?: unknown;
}

function errorKindForStatus(status: number, message: string): JudgeErrorKind {
	if (status === 401) return "auth";
	if (status === 402) return "payment_required";
	if (status === 403) return /credit|payment|billing|quota/i.test(message) ? "payment_required" : "auth";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "server";
	return "bad_request";
}

/** System One calls a yes/no question `noul`; everything else has the kernel's own shape. */
function toWire(question: Question): Record<string, unknown> {
	if (question.type !== "boolean") return { ...question };
	return question.criteria
		? { type: "noul", instructions: question.instructions, criteria: question.criteria }
		: { type: "noul", instructions: question.instructions };
}

const numberOr = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

function probabilitiesOf(value: unknown): Record<string, number> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number");
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function fromWire(question: Question, raw: Record<string, unknown> | undefined): Answer | undefined {
	if (!raw) return undefined;
	const confidence = numberOr(raw.confidence);
	if (question.type === "boolean") {
		const probability = numberOr(raw.noul);
		return probability === undefined ? undefined : { type: "boolean", probability, confidence };
	}
	if (question.type === "score") {
		const score = numberOr(raw.score);
		return score === undefined ? undefined : { type: "score", score, confidence };
	}
	if (typeof raw.choice !== "string" || !Object.hasOwn(question.criteria, raw.choice)) return undefined;
	return { type: "choice", choice: raw.choice, probabilities: probabilitiesOf(raw.probabilities), confidence };
}

/**
 * Jev over System One: TypeSafe's own endpoint, or another service that
 * serves it with the same protocol, such as OpenRouter. (`GatewayJudgeProvider`
 * reaches the same model through the Vercel AI Gateway.) CLM's server speaks
 * the protocol too, and is called the same way. Uses `fetch` directly; error
 * messages name the service and the key's variable, never the key or the
 * submitted state.
 */
export class TypeSafeJudgeProvider implements JudgeProvider {
	readonly id: string;
	private readonly apiKey: string | ApiKeyResolver;
	private readonly keyName: string;
	private readonly keyOptional: boolean;
	private readonly model: string;
	private readonly baseUrl: string;
	/**
	 * "TypeSafe" at TypeSafe's own address, otherwise the host the requests go to, e.g. "openrouter.ai";
	 * for a judge other than Jev, with its name: "CLM at 127.0.0.1:8700".
	 */
	private readonly service: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: TypeSafeJudgeProviderOptions) {
		this.apiKey = options.apiKey;
		this.keyName = options.keyName ?? "TYPESAFE_API_KEY";
		this.keyOptional = options.keyOptional ?? false;
		this.baseUrl = (options.baseUrl || TYPESAFE_BASE_URL).replace(/\/+$/, "");
		this.fetchImpl = options.fetch ?? fetch;
		const host = URL.canParse(this.baseUrl) ? new URL(this.baseUrl).host : this.baseUrl;
		const service = host === new URL(TYPESAFE_BASE_URL).host ? "TypeSafe" : host;
		this.service = options.judgeName ? `${options.judgeName} at ${service}` : service;
		this.model = options.model || (host === "openrouter.ai" ? OPENROUTER_DEFAULT_MODEL : TYPESAFE_DEFAULT_MODEL);
		this.id = `${service === "TypeSafe" ? "typesafe" : host}:${this.model}`;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		const apiKey = typeof this.apiKey === "string" ? this.apiKey : await this.apiKey();
		if (!apiKey && !this.keyOptional)
			throw new JudgeError("auth", `No API key is configured for Jev at ${this.service} (${this.keyName})`);

		const questions = Object.fromEntries(
			Object.entries(request.questions).map(([id, question]) => [id, toWire(question)]),
		);
		let response: Response;
		try {
			response = await this.fetchImpl(this.baseUrl, {
				method: "POST",
				headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), "Content-Type": "application/json" },
				body: JSON.stringify({ model: this.model, state: request.state, questions }),
				signal: request.signal,
			});
		} catch (error) {
			// Aborts are classified by the kernel, which knows whether its timeout or the caller fired.
			if (error instanceof Error && error.name === "AbortError") throw error;
			throw new JudgeError("unreachable", `Could not reach ${this.service}`, { cause: error });
		}

		if (!response.ok) {
			const body: unknown = await response.json().catch(() => undefined);
			const message = messageFromErrorBody(body).slice(0, MAX_ERROR_MESSAGE_LENGTH);
			// Called without a key, a server that has one turned the call away: say which variable would hold it.
			const unkeyed = response.status === 401 && !apiKey && `${this.service} asks for a key (${this.keyName})`;
			throw new JudgeError(
				errorKindForStatus(response.status, message),
				unkeyed || message || `${this.service} responded with HTTP ${response.status}`,
				{ status: response.status },
			);
		}

		const body = (await response.json().catch(() => undefined)) as SystemOneBody | undefined;
		if (!body || typeof body.answers !== "object" || body.answers === null) {
			throw new JudgeError("invalid_response", `${this.service} response has no answers`, {
				status: response.status,
			});
		}
		const answers: Record<string, Answer> = {};
		for (const [id, question] of Object.entries(request.questions)) {
			const answer = fromWire(question, body.answers[id]);
			if (!answer) throw new JudgeError("invalid_response", `${this.service} gave no usable answer for "${id}"`);
			answers[id] = answer;
		}
		return {
			answers,
			usage: { inputTokens: numberOr(body.usage?.input_tokens), outputTokens: numberOr(body.usage?.output_tokens) },
			modelId: typeof body.model === "string" ? body.model : this.model,
			warnings: readWarnings(body.warnings),
		};
	}
}
