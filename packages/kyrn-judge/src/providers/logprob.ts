import { JudgeError, type JudgeErrorKind } from "../errors.ts";
import type {
	Answer,
	JsonValue,
	JudgeInput,
	JudgeProvider,
	JudgeRequest,
	JudgeWarning,
	ProviderResponse,
	Question,
} from "../types.ts";
import type { ApiKeyResolver } from "./gateway.ts";
import { MAX_ERROR_MESSAGE_LENGTH, messageFromErrorBody } from "./http.ts";

/** The most alternatives OpenAI-compatible servers return per token: vLLM and Nebius Token Factory stop at 20. */
const TOP_LOGPROBS = 20;
/** Below this share of the first token's probability on the labels, the answer is reported as off-format. */
const MIN_LABEL_MASS = 0.5;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const LOGPROB_SYSTEM_PROMPT =
	"You are a judgment function inside a coding agent harness. Read STATE and answer QUESTION about it. Reply with exactly one label from LABELS and nothing else.";

export interface ChatMessage {
	readonly role: "system" | "user";
	readonly content: string;
}

/** One question as the model sees it, and the label each answer is read from. */
export interface LabeledPrompt {
	readonly messages: readonly ChatMessage[];
	/** The answer each label stands for: "yes"/"no", an option name, or a level index. */
	readonly labels: Readonly<Record<string, string>>;
}

const text = (value: JudgeInput | null | undefined): string =>
	value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);

/**
 * The prompt for one question. Every label is a single token, so the first generated token's
 * log-probabilities are the answer distribution. Training data for a distilled judge is rendered
 * with this same function, which keeps what the model learned and what it is asked identical.
 */
export function renderLabeledPrompt(state: JudgeInput, question: Question): LabeledPrompt {
	const lines: string[] = [];
	const labels: Record<string, string> = {};
	if (question.type === "boolean") {
		labels.yes = "yes";
		labels.no = "no";
		if (question.criteria?.true) lines.push(`yes: ${text(question.criteria.true)}`);
		if (question.criteria?.false) lines.push(`no: ${text(question.criteria.false)}`);
	} else if (question.type === "choice") {
		const options = Object.entries(question.criteria);
		if (options.length > LETTERS.length) {
			throw new JudgeError("bad_request", `A labeled prompt holds at most ${LETTERS.length} options`);
		}
		for (const [index, [option, description]] of options.entries()) {
			labels[LETTERS[index]] = option;
			lines.push(
				description ? `${LETTERS[index]}: ${option} - ${text(description)}` : `${LETTERS[index]}: ${option}`,
			);
		}
	} else {
		if (question.criteria.length > 10)
			throw new JudgeError("bad_request", "A labeled prompt holds at most 10 levels");
		for (const [index, level] of question.criteria.entries()) {
			labels[String(index)] = String(index);
			lines.push(`${index}: ${text(level)}`);
		}
	}
	const stateText = typeof state === "string" ? state : JSON.stringify(state, null, 1);
	const user = [
		`STATE:\n${stateText}`,
		`QUESTION:\n${text(question.instructions)}${lines.length > 0 ? `\n${lines.join("\n")}` : ""}`,
		`LABELS: ${Object.keys(labels).join(", ")}`,
	].join("\n\n");
	return {
		messages: [
			{ role: "system", content: LOGPROB_SYSTEM_PROMPT },
			{ role: "user", content: user },
		],
		labels,
	};
}

interface TopLogprob {
	token?: unknown;
	logprob?: unknown;
}

interface ChatCompletionBody {
	model?: unknown;
	choices?: { logprobs?: { content?: { top_logprobs?: TopLogprob[] }[] } }[];
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/**
 * Probability per label from the first token's alternatives, normalized over the labels, and the share
 * of the token's probability the labels held. "yes" also matches " Yes"; letters and digits match exactly.
 */
export function labelDistribution(
	topLogprobs: readonly TopLogprob[],
	labels: readonly string[],
): { probabilities: Record<string, number>; mass: number } {
	const sums: Record<string, number> = Object.fromEntries(labels.map((label) => [label, 0]));
	for (const entry of topLogprobs) {
		if (typeof entry.token !== "string" || typeof entry.logprob !== "number") continue;
		const token = entry.token.trim();
		const label = labels.find((candidate) =>
			candidate === "yes" || candidate === "no" ? candidate === token.toLowerCase() : candidate === token,
		);
		if (label !== undefined) sums[label] += Math.exp(entry.logprob);
	}
	const mass = Object.values(sums).reduce((sum, value) => sum + value, 0);
	const probabilities = Object.fromEntries(labels.map((label) => [label, mass > 0 ? sums[label] / mass : 0]));
	return { probabilities, mass };
}

function toAnswer(question: Question, labels: Readonly<Record<string, string>>, probabilities: Record<string, number>) {
	if (question.type === "boolean") {
		return { type: "boolean", probability: probabilities.yes } satisfies Answer;
	}
	if (question.type === "score") {
		const distribution = Object.fromEntries(Object.entries(probabilities).map(([label, p]) => [labels[label], p]));
		const score = Object.entries(distribution).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
		return { type: "score", score, probabilities: distribution } satisfies Answer;
	}
	const byOption = Object.fromEntries(Object.entries(probabilities).map(([label, p]) => [labels[label], p]));
	const choice = Object.entries(byOption).reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
	return { type: "choice", choice, probabilities: byOption } satisfies Answer;
}

function errorKindForStatus(status: number, message: string): JudgeErrorKind {
	if (status === 401) return "auth";
	if (status === 402) return "payment_required";
	if (status === 403) return /credit|payment|billing|quota/i.test(message) ? "payment_required" : "auth";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "server";
	return "bad_request";
}

const numberOr = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

export interface LogprobJudgeProviderOptions {
	/** An OpenAI-compatible API, e.g. https://api.tokenfactory.nebius.com/v1; `/chat/completions` is appended. */
	baseUrl: string;
	model: string;
	apiKey: ApiKeyResolver;
	/** The variable the key is read from, named when it is missing. */
	keyName: string;
	/** Extra request fields, e.g. `{"chat_template_kwargs": {"enable_thinking": false}}` for a reasoning model. */
	body?: Readonly<Record<string, JsonValue>>;
	fetch?: typeof fetch;
}

/**
 * Any chat model behind an OpenAI-compatible API as a judge whose probabilities are read off the
 * model's first token rather than written out by it: a generated "p": 0.9 is a guess at a number,
 * a log-probability is what the model would actually answer. One request per question, all sent at
 * once; the state leads every prompt, so a server with prefix caching reads it once.
 */
export class LogprobJudgeProvider implements JudgeProvider {
	readonly id: string;
	private readonly endpoint: string;
	private readonly service: string;
	private readonly model: string;
	private readonly apiKey: ApiKeyResolver;
	private readonly keyName: string;
	private readonly body: Readonly<Record<string, JsonValue>>;
	private readonly fetchImpl: typeof fetch;

	constructor(options: LogprobJudgeProviderOptions) {
		const baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.endpoint = `${baseUrl}/chat/completions`;
		this.service = URL.canParse(baseUrl) ? new URL(baseUrl).host : baseUrl;
		this.model = options.model;
		this.id = `${this.service}:${options.model}`;
		this.apiKey = options.apiKey;
		this.keyName = options.keyName;
		this.body = options.body ?? {};
		this.fetchImpl = options.fetch ?? fetch;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		const apiKey = await this.apiKey();
		if (!apiKey) throw new JudgeError("auth", `No API key is configured for ${this.service} (${this.keyName})`);
		const entries = Object.entries(request.questions);
		const results = await Promise.all(
			entries.map(([id, question]) => this.ask(id, question, request.state, apiKey, request.signal)),
		);
		const answers: Record<string, Answer> = {};
		const warnings: JudgeWarning[] = [];
		let inputTokens = 0;
		let outputTokens = 0;
		for (const [index, [id]] of entries.entries()) {
			const result = results[index];
			answers[id] = result.answer;
			if (result.warning) warnings.push(result.warning);
			inputTokens += result.inputTokens ?? 0;
			outputTokens += result.outputTokens ?? 0;
		}
		return {
			answers,
			usage: { inputTokens, outputTokens },
			modelId: this.model,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	}

	private async ask(
		id: string,
		question: Question,
		state: JudgeInput,
		apiKey: string,
		signal: AbortSignal | undefined,
	): Promise<{ answer: Answer; warning?: JudgeWarning; inputTokens?: number; outputTokens?: number }> {
		const prompt = renderLabeledPrompt(state, question);
		let response: Response;
		try {
			response = await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					...this.body,
					model: this.model,
					messages: prompt.messages,
					max_tokens: 1,
					temperature: 0,
					logprobs: true,
					top_logprobs: TOP_LOGPROBS,
				}),
				signal,
			});
		} catch (error) {
			// Aborts are classified by the kernel, which knows whether its timeout or the caller fired.
			if (error instanceof Error && error.name === "AbortError") throw error;
			throw new JudgeError("unreachable", `Could not reach ${this.service}`, { cause: error });
		}

		if (!response.ok) {
			const body: unknown = await response.json().catch(() => undefined);
			const message = messageFromErrorBody(body).slice(0, MAX_ERROR_MESSAGE_LENGTH);
			throw new JudgeError(
				errorKindForStatus(response.status, message),
				message || `${this.service} responded with HTTP ${response.status}`,
				{ status: response.status },
			);
		}

		const body = (await response.json().catch(() => undefined)) as ChatCompletionBody | undefined;
		const top = body?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
		if (!Array.isArray(top)) {
			throw new JudgeError("invalid_response", `${this.service} returned no log-probabilities for "${id}"`);
		}
		const { probabilities, mass } = labelDistribution(top, Object.keys(prompt.labels));
		if (mass === 0) {
			const first = typeof top[0]?.token === "string" ? JSON.stringify(top[0].token) : "nothing";
			throw new JudgeError("invalid_response", `${this.model} answered "${id}" with ${first}, not a label`);
		}
		return {
			answer: toAnswer(question, prompt.labels, probabilities),
			warning:
				mass < MIN_LABEL_MASS
					? {
							type: "label_mass",
							questionId: id,
							message: `The labels held ${mass.toFixed(2)} of the first token`,
						}
					: undefined,
			inputTokens: numberOr(body?.usage?.prompt_tokens),
			outputTokens: numberOr(body?.usage?.completion_tokens),
		};
	}
}
