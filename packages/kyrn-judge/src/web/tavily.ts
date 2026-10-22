import { parseResultsJson, type SearchPage, type SearchSource } from "./search.ts";

/**
 * Tavily (tavily.com), a search API made for agents, asked when `TAVILY_API_KEY` is set.
 *
 * Unlike the engines in `search.ts` it wants a key and a POST, and it answers JSON
 * from its own network, so it also reaches what this machine cannot: from mainland
 * China, many sites time out or reset, and `/extract` reads them anyway.
 *
 * The key goes into the Authorization header and nowhere else. An error that
 * could carry it (a transport error quoting the request) has it replaced first.
 */
export const TAVILY_API = "https://api.tavily.com";
/** The most results one search may ask for. */
const MAX_RESULTS = 20;

export interface TavilyOptions {
	readonly timeoutMs?: number;
	/** For tests. */
	readonly fetch?: typeof fetch;
}

async function post(
	apiKey: string,
	path: string,
	payload: Readonly<Record<string, unknown>>,
	options: TavilyOptions,
	signal: AbortSignal | undefined,
): Promise<SearchPage> {
	const url = `${TAVILY_API}${path}`;
	const timeoutMs = options.timeoutMs ?? 20_000;
	const deadline = AbortSignal.timeout(timeoutMs);
	try {
		const response = await (options.fetch ?? fetch)(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
		});
		return { url, status: response.status, body: await response.text() };
	} catch (error) {
		if (deadline.aborted && !signal?.aborted) throw new Error(`Timed out after ${timeoutMs} ms`);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(apiKey ? message.replaceAll(apiKey, "[TAVILY_API_KEY]") : message);
	}
}

/**
 * Search through Tavily. An answer of 401 (bad key), 429 (rate limit), 432 (plan limit) or 5xx
 * has no results and a status of 400 or more, so `searchWeb` reports an HTTP error and asks the next source.
 */
export function tavilySource(apiKey: string, options: TavilyOptions = {}): SearchSource {
	const endpoint = `${TAVILY_API}/search`;
	return {
		id: "tavily",
		url: () => endpoint,
		parse: (body) => parseResultsJson(body, endpoint) ?? [],
		request: (query, count, signal) =>
			post(
				apiKey,
				"/search",
				{
					query,
					max_results: Math.max(1, Math.min(count, MAX_RESULTS)),
					search_depth: "basic",
					include_answer: false,
				},
				options,
				signal,
			),
	};
}

export interface Extracted {
	readonly url: string;
	/** Markdown, as Tavily read the page. Untrusted like any page text. */
	readonly text: string;
}

interface ExtractAnswer {
	results?: { url?: unknown; raw_content?: unknown }[];
	failed_results?: { error?: unknown }[];
}

/** One page as Tavily reads it from its own network. Throws with the reason, said without "Tavily", when it could not. */
export async function tavilyExtract(
	apiKey: string,
	pageUrl: string,
	options: TavilyOptions = {},
	signal?: AbortSignal,
): Promise<Extracted> {
	const answer = await post(
		apiKey,
		"/extract",
		{ urls: [pageUrl], extract_depth: "basic", format: "markdown" },
		options,
		signal,
	);
	if (answer.status >= 400) throw new Error(`HTTP ${answer.status}`);
	let data: ExtractAnswer | null;
	try {
		data = JSON.parse(answer.body) as ExtractAnswer | null;
	} catch {
		throw new Error("the answer is not JSON");
	}
	for (const result of data?.results ?? []) {
		const text = typeof result.raw_content === "string" ? result.raw_content.trim() : "";
		if (text) return { url: typeof result.url === "string" ? result.url : pageUrl, text };
	}
	const failed = data?.failed_results?.[0]?.error;
	throw new Error(failed ? String(failed).slice(0, 200) : "no text in the answer");
}
