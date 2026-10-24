import { JudgeError } from "../errors.ts";
import type { Answer, JudgeProvider, JudgeRequest, JudgeUsage, ProviderResponse } from "../types.ts";
import { MAX_ERROR_MESSAGE_LENGTH, messageFromErrorBody, readWarnings } from "./http.ts";

export interface HttpJudgeProviderOptions {
	/** The server's address. */
	baseUrl: string;
	/** Request path, default "/evaluate". */
	path?: string;
	/** Ledger id, default "http:<baseUrl>". */
	id?: string;
	/** Extra request headers, resolved per request so tokens can come from the host. */
	headers?: () => Record<string, string> | Promise<Record<string, string>>;
	fetch?: typeof fetch;
}

interface HttpResponseBody {
	answers?: Record<string, Answer>;
	usage?: JudgeUsage;
	warnings?: unknown;
}

/**
 * Calls a judge server of one's own (`http` in mu.json) that takes the request and answer shapes of the AI Gateway:
 * `{state, questions}` in, `{answers}` out, with optional `usage` and `warnings`. Anything the server cut from the
 * state is reported through `warnings`.
 */
export class HttpJudgeProvider implements JudgeProvider {
	readonly id: string;
	private readonly baseUrl: string;
	private readonly path: string;
	private readonly headers: HttpJudgeProviderOptions["headers"];
	private readonly fetchImpl: typeof fetch;

	constructor(options: HttpJudgeProviderOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.id = options.id ?? `http:${this.baseUrl}`;
		this.path = options.path ?? "/evaluate";
		this.headers = options.headers;
		this.fetchImpl = options.fetch ?? fetch;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		let response: Response;
		try {
			const extraHeaders = this.headers ? await this.headers() : {};
			response = await this.fetchImpl(`${this.baseUrl}${this.path}`, {
				method: "POST",
				headers: { ...extraHeaders, "Content-Type": "application/json" },
				body: JSON.stringify({ state: request.state, questions: request.questions }),
				signal: request.signal,
			});
		} catch (error) {
			// Aborts are classified by the kernel, which knows whether its timeout or the caller fired.
			if (error instanceof Error && error.name === "AbortError") throw error;
			throw new JudgeError("unreachable", `Judge server is not reachable at ${this.baseUrl}`, { cause: error });
		}

		if (!response.ok) {
			const body: unknown = await response.json().catch(() => undefined);
			const message = messageFromErrorBody(body).slice(0, MAX_ERROR_MESSAGE_LENGTH);
			throw new JudgeError(
				response.status >= 500 ? "server" : "bad_request",
				message || `Judge server responded with HTTP ${response.status}`,
				{ status: response.status },
			);
		}

		const body = (await response.json().catch(() => undefined)) as HttpResponseBody | undefined;
		if (!body || typeof body.answers !== "object" || body.answers === null) {
			throw new JudgeError("invalid_response", "Judge server response has no answers", { status: response.status });
		}

		return { answers: { ...body.answers }, usage: body.usage, warnings: readWarnings(body.warnings) };
	}
}
