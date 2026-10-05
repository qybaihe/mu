import { JudgeError, type JudgeErrorKind } from "../errors.ts";
import type { Answer, JudgeInput, JudgeProvider, JudgeRequest, ProviderResponse, Question } from "../types.ts";

/**
 * The questions and answers of a classifier model in the host's model catalog, as pi-ai's `classify()` takes and
 * gives them, written out here so the kernel does not depend on pi-ai. A yes/no question is `bool` there.
 */
export type ClassifierWireQuestion =
	| { type: "bool"; instructions: string; criteria?: { true: string; false: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] };

export type ClassifierWireAnswer =
	| { type: "bool"; probability: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; confidence: number };

/** One classification, as the host reports it. Like pi-ai's `ClassifierResult`, it never rejects: failures are in it. */
export interface ClassifierOutcome {
	readonly answers: Readonly<Record<string, ClassifierWireAnswer>>;
	readonly usage?: { readonly input: number; readonly output: number };
	readonly stopReason: "stop" | "error" | "aborted";
	readonly errorMessage?: string;
}

/** A classifier model of the host, bound to "provider/model-id". Throws a JudgeError when the model is not there. */
export type ClassifierCall = (request: {
	readonly state: JudgeInput;
	readonly questions: Readonly<Record<string, ClassifierWireQuestion>>;
	readonly signal?: AbortSignal;
}) => Promise<ClassifierOutcome>;

const text = (value: JudgeInput | null | undefined): string =>
	value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);

function toWire(question: Question): ClassifierWireQuestion {
	const instructions = text(question.instructions);
	if (question.type === "choice") {
		return {
			type: "choice",
			instructions,
			criteria: Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, text(value)])),
		};
	}
	if (question.type === "score") return { type: "score", instructions, criteria: question.criteria.map(text) };
	// A yes/no question without criteria is sent without them, as Jev is asked directly: empty ones change its answers.
	return question.criteria
		? {
				type: "bool",
				instructions,
				criteria: { true: text(question.criteria.true), false: text(question.criteria.false) },
			}
		: { type: "bool", instructions };
}

function fromWire(question: Question, answer: ClassifierWireAnswer | undefined): Answer | undefined {
	if (!answer) return undefined;
	if (question.type === "boolean") {
		return answer.type === "bool" ? { type: "boolean", probability: answer.probability } : undefined;
	}
	if (question.type === "score") {
		return answer.type === "score"
			? { type: "score", score: answer.score, confidence: answer.confidence }
			: undefined;
	}
	if (answer.type !== "choice" || !(answer.choice in question.criteria)) return undefined;
	return {
		type: "choice",
		choice: answer.choice,
		probabilities: answer.probabilities,
		confidence: answer.confidence,
	};
}

/** pi-ai puts a failure into words ("… returned 401: …"); the kernel needs its kind. */
function kindOf(message: string): JudgeErrorKind {
	if (/no api key|no credentials|not configured/i.test(message)) return "auth";
	if (/\b402\b/.test(message)) return "payment_required";
	if (/\b403\b/.test(message)) return /credit|payment|billing|quota/i.test(message) ? "payment_required" : "auth";
	if (/\b401\b|unauthori[sz]ed/i.test(message)) return "auth";
	if (/\b429\b|rate.?limit/i.test(message)) return "rate_limited";
	if (/\b5\d\d\b/.test(message)) return "server";
	if (/\b4\d\d\b/.test(message)) return "bad_request";
	if (/timed out/i.test(message)) return "timeout";
	if (/did not return|invalid|unexpected response/i.test(message)) return "invalid_response";
	if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(message)) return "unreachable";
	return "server";
}

/**
 * A classifier model from the host's catalog as a judge: Jev on OpenCode Zen or Cloudflare Workers AI, Cloudflare's
 * Clef, the System One models on OpenRouter and the Vercel AI Gateway, a llama.cpp server's classifier, one of the
 * user's models.json. The host reaches it with its own credentials (`mu auth`, /login, the provider's variable).
 */
export class ClassifierJudgeProvider implements JudgeProvider {
	readonly id: string;
	private readonly call: ClassifierCall;

	constructor(options: { model: string; call: ClassifierCall }) {
		this.id = `classifier:${options.model}`;
		this.call = options.call;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		const questions = Object.fromEntries(
			Object.entries(request.questions).map(([id, question]) => [id, toWire(question)]),
		);
		const outcome = await this.call({ state: request.state, questions, signal: request.signal });
		if (outcome.stopReason === "aborted") {
			// Aborts are classified by the kernel, which knows whether its timeout or the caller fired.
			const aborted = new Error("The classification was aborted");
			aborted.name = "AbortError";
			throw aborted;
		}
		if (outcome.stopReason === "error") {
			const message = (outcome.errorMessage ?? "The classifier call failed").slice(0, 300);
			throw new JudgeError(kindOf(message), message);
		}
		const answers: Record<string, Answer> = {};
		for (const [id, question] of Object.entries(request.questions)) {
			const answer = fromWire(question, outcome.answers[id]);
			if (!answer) throw new JudgeError("invalid_response", `${this.id} gave no usable answer for "${id}"`);
			answers[id] = answer;
		}
		return {
			answers,
			usage: outcome.usage ? { inputTokens: outcome.usage.input, outputTokens: outcome.usage.output } : undefined,
			modelId: this.id.slice("classifier:".length),
		};
	}
}
