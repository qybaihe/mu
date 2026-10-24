import { JudgeError } from "../errors.ts";
import type {
	Answer,
	JudgeInput,
	JudgeProvider,
	JudgeRequest,
	JudgeUsage,
	ProviderResponse,
	Question,
} from "../types.ts";
import type { ApiKeyResolver } from "./gateway.ts";
import { errorKindForStatus, MAX_ERROR_MESSAGE_LENGTH, messageFromErrorBody } from "./http.ts";

/**
 * OpenAI's Decisions API (developers.openai.com/api/docs/guides/decisions, generally available since 2026-10-22):
 * `POST /v1/decisions` with an OpenAI API key, and `gpt-6-luna`, the one model it serves.
 */
export const OPENAI_DECISIONS_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_DECISIONS_DEFAULT_MODEL = "gpt-6-luna";
/** The judge's own key, set in Settings → Judges or by `mu setup`. */
export const OPENAI_JUDGE_KEY = "MU_JUDGE_OPENAI_KEY";

/**
 * The Decisions endpoint at an address written as `https://host`, `https://host/v1` (OpenAI's, an Azure resource's
 * `…/openai/v1`, a relay's) or as the endpoint itself.
 */
export function decisionsEndpoint(baseUrl: string | undefined): string {
	const url = (baseUrl || OPENAI_DECISIONS_BASE_URL).replace(/\/+$/, "");
	if (!URL.canParse(url)) return url;
	const path = new URL(url).pathname;
	if (path === "/") return `${url}/v1/decisions`;
	return path.endsWith("/decisions") ? url : `${url}/decisions`;
}

/** Whether an address is OpenAI's own (empty is): the only one the key of mu's `openai` model provider goes to. */
export function isOpenAIAddress(baseUrl: string | undefined): boolean {
	if (!baseUrl) return true;
	if (!URL.canParse(baseUrl)) return false;
	const url = new URL(baseUrl);
	return url.protocol === "https:" && url.host === "api.openai.com";
}

export interface OpenAIDecisionsJudgeProviderOptions {
	/** A key, or a resolver called per request so the host owns credential storage. */
	apiKey: string | ApiKeyResolver;
	/** Where the key is read from, named when it is missing. */
	keyName?: string;
	model?: string;
	/** OpenAI's API unless set: an Azure resource or a relay that serves the same endpoint. */
	baseUrl?: string;
	fetch?: typeof fetch;
}

type WireQuestion =
	| { type: "predicate"; name: string; instructions: string }
	| { type: "choice"; name: string; instructions: string; choices: { value: string; description?: string }[] }
	| { type: "score"; name: string; instructions: string; levels: { label: string }[] };

interface DecisionsBody {
	model?: unknown;
	answers?: unknown;
	usage?: {
		input_tokens?: unknown;
		output_tokens?: unknown;
		input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
	};
}

const text = (value: JudgeInput | null | undefined): string =>
	value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);

/**
 * The kernel's question as the Decisions API asks it, in the shapes pi-ai's OpenAI Decisions classifier was checked
 * with against live gpt-6-luna requests (packages/ai/src/api/openai-decisions.ts). Yes/no is a predicate, which has no
 * criteria field: their meanings go into the instructions. A choice's options become choices, without a description
 * where they have none; a score's levels keep their order and are labeled with their own text.
 */
function toDecisionsQuestion(name: string, question: Question): WireQuestion {
	const instructions = text(question.instructions);
	if (question.type === "choice") {
		return {
			type: "choice",
			name,
			instructions,
			choices: Object.entries(question.criteria).map(([value, meaning]) => {
				const description = text(meaning);
				return description ? { value, description } : { value };
			}),
		};
	}
	if (question.type === "score") {
		return {
			type: "score",
			name,
			instructions,
			levels: question.criteria.map((level, index) => ({ label: text(level) || String(index) })),
		};
	}
	const meaning = [
		question.criteria?.true ? `True means: ${text(question.criteria.true)}` : "",
		question.criteria?.false ? `False means: ${text(question.criteria.false)}` : "",
	].filter(Boolean);
	return {
		type: "predicate",
		name,
		instructions: meaning.length > 0 ? `${instructions}\n\n${meaning.join("\n")}` : instructions,
	};
}

const numberOr = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `[{ value, probability }]` as the kernel keeps it, `{ value: probability }`, for the values `keep` names. */
function distribution(value: unknown, keep: (key: string) => boolean): Record<string, number> | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries: [string, number][] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const key = typeof item.value === "number" || typeof item.value === "string" ? String(item.value) : undefined;
		const probability = numberOr(item.probability);
		if (key !== undefined && probability !== undefined && keep(key)) entries.push([key, probability]);
	}
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The kernel's answer to `question`, or undefined for a refusal, a missing answer or one of another type. */
function fromDecisionsAnswer(question: Question, raw: Record<string, unknown> | undefined): Answer | undefined {
	if (!raw) return undefined;
	const confidence = numberOr(raw.confidence);
	if (question.type === "boolean") {
		const probability = numberOr(raw.probability);
		return raw.type === "predicate" && probability !== undefined ? { type: "boolean", probability } : undefined;
	}
	if (question.type === "score") {
		const score = numberOr(raw.score);
		if (raw.type !== "score" || score === undefined) return undefined;
		const levels = question.criteria.length;
		const probabilities = distribution(raw.probabilities, (key) => /^\d+$/.test(key) && Number(key) < levels);
		return { type: "score", score, probabilities, confidence };
	}
	if (raw.type !== "choice" || typeof raw.choice !== "string" || !(raw.choice in question.criteria)) return undefined;
	const probabilities = distribution(raw.probabilities, (key) => key in question.criteria);
	return { type: "choice", choice: raw.choice, probabilities, confidence };
}

function usageOf(body: DecisionsBody): JudgeUsage {
	const details = body.usage?.input_tokens_details;
	const usage: JudgeUsage = {
		inputTokens: numberOr(body.usage?.input_tokens),
		// Output tokens are not charged, and the API may leave them out.
		outputTokens: numberOr(body.usage?.output_tokens) ?? 0,
	};
	const cached = numberOr(details?.cached_tokens);
	const written = numberOr(details?.cache_write_tokens);
	if (cached !== undefined) usage.cachedInputTokens = cached;
	if (written !== undefined) usage.cacheWriteTokens = written;
	return usage;
}

/**
 * OpenAI's decision model, `gpt-6-luna`, through the Decisions API. Every question goes out in one request with the
 * state as its input; each answer comes back named by its question. A refusal or a missing answer fails the call as
 * TypeSafe's does, so the next judge or the decision's fallback answers. Uses `fetch` directly; error messages name
 * the service and the key's variable, never the key or the submitted state.
 *
 * pi-ai reaches the same model as a classifier (`classifier:openai/gpt-6-luna`), with the credentials of pi's `openai`
 * provider only. This judge has a key and an address of its own, as TypeSafe's does.
 */
export class OpenAIDecisionsJudgeProvider implements JudgeProvider {
	readonly id: string;
	private readonly apiKey: string | ApiKeyResolver;
	private readonly keyName: string;
	private readonly model: string;
	private readonly endpoint: string;
	/** "OpenAI" at OpenAI's own address, otherwise the host the requests go to. */
	private readonly service: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: OpenAIDecisionsJudgeProviderOptions) {
		this.apiKey = options.apiKey;
		this.keyName = options.keyName ?? OPENAI_JUDGE_KEY;
		this.model = options.model || OPENAI_DECISIONS_DEFAULT_MODEL;
		this.endpoint = decisionsEndpoint(options.baseUrl);
		this.fetchImpl = options.fetch ?? fetch;
		const host = URL.canParse(this.endpoint) ? new URL(this.endpoint).host : this.endpoint;
		this.service = isOpenAIAddress(options.baseUrl) ? "OpenAI" : host;
		this.id = `${this.service === "OpenAI" ? "openai" : host}:${this.model}`;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		const apiKey = typeof this.apiKey === "string" ? this.apiKey : await this.apiKey();
		if (!apiKey) throw new JudgeError("auth", `No API key is configured for ${this.service} (${this.keyName})`);

		const questions = Object.entries(request.questions).map(([id, question]) => toDecisionsQuestion(id, question));
		// Text as it is, structured state as its JSON text, as pi-ai's classifier sends it.
		const input = text(request.state);
		let response: Response;
		try {
			response = await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: this.model, input, questions }),
				signal: request.signal,
			});
		} catch (error) {
			// Aborts are classified by the kernel, which knows whether its timeout or the caller fired.
			if (error instanceof Error && error.name === "AbortError") throw error;
			throw new JudgeError("unreachable", `Could not reach ${this.service}`, { cause: error });
		}

		if (!response.ok) {
			const body: unknown = await response.json().catch(() => undefined);
			const message = messageFromErrorBody(body).replaceAll(apiKey, "…").slice(0, MAX_ERROR_MESSAGE_LENGTH);
			throw new JudgeError(
				errorKindForStatus(response.status, message),
				message || `${this.service} responded with HTTP ${response.status}`,
				{ status: response.status },
			);
		}

		const body = (await response.json().catch(() => undefined)) as DecisionsBody | undefined;
		if (!body || !Array.isArray(body.answers)) {
			throw new JudgeError("invalid_response", `${this.service} response has no answers`, {
				status: response.status,
			});
		}
		const byName = new Map<string, Record<string, unknown>>();
		for (const item of body.answers) {
			if (isRecord(item) && typeof item.name === "string") byName.set(item.name, item);
		}
		const answers: Record<string, Answer> = {};
		for (const [id, question] of Object.entries(request.questions)) {
			const raw = byName.get(id);
			const answer = fromDecisionsAnswer(question, raw);
			if (!answer) {
				const why = raw?.type === "refusal" ? "declined to answer" : "gave no usable answer for";
				throw new JudgeError("invalid_response", `${this.service} ${why} "${id}"`);
			}
			answers[id] = answer;
		}
		return {
			answers,
			usage: usageOf(body),
			modelId: typeof body.model === "string" ? body.model : this.model,
		};
	}
}
