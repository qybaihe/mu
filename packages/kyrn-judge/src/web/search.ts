import type { Coded } from "../language.ts";
import { decodeEntities, type ElementNode, elementText, findElements, parseHtml } from "./html.ts";

/**
 * Web search without a key, from where Google and DuckDuckGo do not answer.
 *
 * A source is a URL plus a parser for what comes back. Measured from a machine in
 * mainland China on 2026-09-22 (kyrn/docs/features/background-and-web.md):
 * 360 (`so`) and Sogou answered scripted requests with results for the query,
 * Baidu with a verification page, and Bing (`cn.bing.com`, with and without
 * `ensearch=1`, HTML and RSS) with results for something else entirely. So the
 * default is `so`, and because any engine can start doing what Bing does, the
 * results are checked against the query: a page of results that share no word
 * with it is treated like a robot page, and the next source is tried.
 *
 * An API that wants more than one GET (Tavily, `tavily.ts`) brings its own
 * `request`. Its results are not checked for decoys: a keyed API does not
 * answer robots with them, and its results may share no word with the query
 * (English pages for a Chinese query) and still be the right ones.
 */
export interface SearchResult {
	readonly title: string;
	readonly url: string;
	readonly snippet: string;
}

export interface SearchSource {
	readonly id: string;
	/** True for a source the user configured: it may live on this machine or the local network. */
	readonly own?: boolean;
	url(query: string, count: number): string;
	parse(body: string): SearchResult[];
	/** Asks the source itself instead of a GET of `url`, and answers like that GET would: the body is read with `parse`. */
	request?(query: string, count: number, signal: AbortSignal | undefined): Promise<SearchPage>;
}

const hasClass = (node: ElementNode, name: string): boolean => (node.attrs.class ?? "").split(/\s+/).includes(name);

function firstLink(item: ElementNode, headings: readonly string[]): ElementNode | undefined {
	for (const heading of findElements(item, (node) => headings.includes(node.tag))) {
		const link = findElements(heading, (node) => node.tag === "a" && Boolean(node.attrs.href))[0];
		if (link) return link;
	}
	return undefined;
}

/** Bing wraps results as `/ck/a?...&u=a1<base64url of the address>`. */
export function unwrapBing(href: string): string {
	try {
		const url = new URL(href);
		const wrapped = url.pathname === "/ck/a" ? url.searchParams.get("u") : null;
		if (!wrapped?.startsWith("a1")) return href;
		const decoded = Buffer.from(wrapped.slice(2), "base64url").toString("utf8");
		return /^https?:\/\//.test(decoded) ? decoded : href;
	} catch {
		return href;
	}
}

function tidy(results: readonly SearchResult[], base: string): SearchResult[] {
	const seen = new Set<string>();
	const out: SearchResult[] = [];
	for (const result of results) {
		let url: string;
		// An empty address would resolve to the result page itself.
		if (!result.url.trim()) continue;
		try {
			url = new URL(result.url.trim(), base).href;
		} catch {
			continue;
		}
		if (!/^https?:/.test(url) || !result.title || seen.has(url)) continue;
		seen.add(url);
		const snippet = result.snippet.length > 300 ? `${result.snippet.slice(0, 299)}…` : result.snippet;
		out.push({ title: result.title.slice(0, 200), url, snippet });
	}
	return out;
}

/** The text of an item without its title, for engines whose snippet markup changes often. */
function restText(item: ElementNode, title: string): string {
	const text = elementText(item);
	return (text.startsWith(title) ? text.slice(title.length) : text).trim();
}

function parseRss(body: string): SearchResult[] {
	const field = (item: string, tag: string): string => {
		const raw = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(item)?.[1] ?? "";
		return decodeEntities(raw.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "")).trim();
	};
	return [...body.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => ({
		title: field(match[1], "title"),
		url: field(match[1], "link"),
		snippet: field(match[1], "description"),
	}));
}

export function parseBing(body: string): SearchResult[] {
	// The RSS form of the same results (`&format=rss`) needs no knowledge of the page's markup.
	if (/^\s*<\?xml|<rss[\s>]/i.test(body.slice(0, 300))) return tidy(parseRss(body), "https://cn.bing.com/");
	const items = findElements(parseHtml(body), (node) => node.tag === "li" && hasClass(node, "b_algo"));
	return tidy(
		items.flatMap((item) => {
			const link = firstLink(item, ["h2"]);
			if (!link) return [];
			const title = elementText(link);
			const paragraph = findElements(item, (node) => node.tag === "p")[0];
			return [
				{
					title,
					url: unwrapBing(link.attrs.href),
					snippet: paragraph ? elementText(paragraph) : restText(item, title),
				},
			];
		}),
		"https://cn.bing.com/",
	);
}

export function parseSo(body: string): SearchResult[] {
	const items = findElements(parseHtml(body), (node) => node.tag === "li" && hasClass(node, "res-list"));
	return tidy(
		items.flatMap((item) => {
			const link = firstLink(item, ["h3"]);
			if (!link) return [];
			const title = elementText(link);
			const described =
				findElements(item, (node) => hasClass(node, "res-desc"))[0] ??
				findElements(item, (node) => hasClass(node, "res-comm-con"))[0];
			// The address behind 360's click tracking is carried next to it.
			const url = link.attrs["data-mdurl"] || link.attrs["data-url"] || link.attrs.href;
			// 360's own widgets (translation, images, maps) sit in the list like results. They are not.
			if (/^https?:\/\/(?!www\.)[\w-]+\.so\.com\//.test(url)) return [];
			return [{ title, url, snippet: described ? elementText(described) : restText(item, title) }];
		}),
		"https://www.so.com/",
	);
}

export function parseSogou(body: string): SearchResult[] {
	const items = findElements(
		parseHtml(body),
		(node) => node.tag === "div" && (hasClass(node, "vrwrap") || hasClass(node, "rb")),
	);
	return tidy(
		items.flatMap((item) => {
			// A card can wrap another card: the inner one is an item of its own.
			if (findElements(item, (node) => node !== item && hasClass(node, "vrwrap")).length > 0) return [];
			const link = firstLink(item, ["h3"]);
			if (!link) return [];
			const title = elementText(link);
			const real = findElements(item, (node) => /^https?:\/\//.test(node.attrs["data-url"] ?? ""))[0];
			const described = findElements(item, (node) => hasClass(node, "space-txt") || hasClass(node, "str-text"))[0];
			return [
				{
					title,
					url: real?.attrs["data-url"] ?? link.attrs.href,
					snippet: described ? elementText(described) : restText(item, title),
				},
			];
		}),
		"https://www.sogou.com/",
	);
}

/** `{"results": [{title, url, content}]}`, which SearXNG and Tavily both answer with. Undefined for anything else. */
export function parseResultsJson(body: string, base: string): SearchResult[] | undefined {
	try {
		const data = JSON.parse(body) as { results?: { title?: unknown; url?: unknown; content?: unknown }[] } | null;
		if (Array.isArray(data?.results)) {
			return tidy(
				data.results.map((entry) => ({
					title: String(entry.title ?? ""),
					url: String(entry.url ?? ""),
					snippet: String(entry.content ?? ""),
				})),
				base,
			);
		}
	} catch {
		/* Not JSON. */
	}
	return undefined;
}

/** SearXNG's JSON, or for an unknown engine every heading that is a link, with the text that follows it. */
export function parseGeneric(body: string, base: string): SearchResult[] {
	const json = parseResultsJson(body, base);
	if (json) return json;
	const root = parseHtml(body);
	const holders = findElements(
		root,
		(node) => findElements(node, (child) => child.tag === "h2" || child.tag === "h3").length === 1,
	);
	const results: SearchResult[] = [];
	for (const heading of findElements(root, (node) => node.tag === "h2" || node.tag === "h3")) {
		const link = findElements(heading, (node) => node.tag === "a" && Boolean(node.attrs.href))[0];
		if (!link) continue;
		const title = elementText(link);
		// The smallest element that holds this heading and no other is the result's own box.
		const box = holders.filter((node) => findElements(node, (child) => child === heading).length > 0).at(-1);
		results.push({ title, url: link.attrs.href, snippet: box ? restText(box, title) : "" });
	}
	return tidy(results, base);
}

export const SOURCES: Readonly<Record<string, SearchSource>> = {
	so: {
		id: "so",
		url: (query) => `https://www.so.com/s?q=${encodeURIComponent(query)}`,
		parse: parseSo,
	},
	sogou: {
		id: "sogou",
		url: (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
		parse: parseSogou,
	},
	"bing-cn": {
		id: "bing-cn",
		// `ensearch=1` asks for the international index, which is what an English technical query wants.
		url: (query) =>
			`https://cn.bing.com/search?q=${encodeURIComponent(query)}${/[㐀-鿿]/.test(query) ? "" : "&ensearch=1"}`,
		parse: parseBing,
	},
};

/**
 * `so`, `sogou`, `bing-cn`; `searxng:<base url>` for one's own instance; or any URL
 * with `{query}` in it, whose answer is read as SearXNG JSON or as a generic result page.
 */
export function resolveSource(setting: string): SearchSource | undefined {
	const value = setting.trim();
	if (value in SOURCES) return SOURCES[value];
	const searx = /^searxng:(https?:\/\/.+)$/i.exec(value);
	const template = searx ? `${searx[1].replace(/\/+$/, "")}/search?q={query}&format=json` : value;
	if (!/^https?:\/\/.+\{query\}/.test(template)) return undefined;
	return {
		id: searx ? "searxng" : new URL(template.replace("{query}", "q")).host,
		own: true,
		url: (query, count) => template.replace("{query}", encodeURIComponent(query)).replace("{count}", String(count)),
		parse: (body) => parseGeneric(body, template),
	};
}

const ROBOT_URL = /captcha|antispider|wappass|\/verify|sorry\/index|challenge/i;
const ROBOT_TEXT =
	/百度安全验证|安全验证|请输入验证码|验证码|异常访问|访问过于频繁|unusual traffic|are you a robot|not a robot|verify you are (?:a )?human|captcha/i;

/** A verification page instead of results. Only asked when no result was found: the word "captcha" can be a search result. */
export function looksLikeRobotPage(finalUrl: string, body: string): boolean {
	return ROBOT_URL.test(finalUrl) || ROBOT_TEXT.test(body.slice(0, 20_000));
}

const STOPWORDS = new Set(
	"a an and are as at be by for from how in is it of on or that the this to was what when where which who why with 的 了 和 是 在 怎么 如何 什么".split(
		" ",
	),
);

export function queryTerms(query: string): string[] {
	const terms = new Set<string>();
	for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}_.#+-]+/u)) {
		// "c++" and "c#" end in what is punctuation elsewhere.
		const word = raw.replace(/^[.#+-]+|[.-]+$/g, "");
		if (!word || STOPWORDS.has(word)) continue;
		if (/[㐀-鿿]/.test(word)) {
			// Chinese has no spaces: two characters in a row are the smallest unit worth matching.
			const run = [...word];
			if (run.length === 1) terms.add(word);
			for (let index = 0; index + 1 < run.length; index++) terms.add(run[index] + run[index + 1]);
		} else if (word.length >= 2) terms.add(word);
	}
	return [...terms];
}

/**
 * Do the results have anything to do with the query? An engine that takes the client for a robot may
 * answer with decoy results instead of a verification page; nothing on such a page says so.
 */
export function related(query: string, results: readonly SearchResult[]): boolean {
	const terms = queryTerms(query);
	if (terms.length === 0 || results.length === 0) return true;
	const text = results.map((result) => `${result.title} ${result.snippet} ${result.url}`.toLowerCase()).join("\n");
	const matched = terms.filter((term) => text.includes(term)).length;
	// One shared word is what "results for the first word only" looks like, so two are asked for when the query has them.
	return matched >= Math.min(2, terms.length);
}

export interface SearchPage {
	readonly url: string;
	readonly status: number;
	readonly body: string;
}

export interface SearchOutcome {
	/** The source that answered, or undefined when none did. */
	readonly source: string | undefined;
	readonly results: readonly SearchResult[];
	/** Why each earlier source was passed over. */
	readonly problems: readonly string[];
	/**
	 * The same, one code each, for a client that translates: source_failed {source, message}, source_robot_page,
	 * source_http_error {source, status}, source_no_results, source_unrelated (all with {source}).
	 */
	readonly problemCodes: readonly Coded[];
}

/** Tries the sources in order until one answers with results that belong to the query. */
export async function searchWeb(
	query: string,
	options: {
		sources: readonly SearchSource[];
		count: number;
		get: (url: string, source: SearchSource) => Promise<SearchPage>;
		/** Passed to a source's own `request`; `get` brings its own. */
		signal?: AbortSignal;
	},
): Promise<SearchOutcome> {
	const problems: string[] = [];
	const problemCodes: Coded[] = [];
	const passOver = (text: string, code: string, params: Record<string, string | number> = {}) => {
		problems.push(text);
		problemCodes.push({ code, params });
	};
	for (const source of options.sources) {
		let page: SearchPage;
		try {
			page = source.request
				? await source.request(query, options.count, options.signal)
				: await options.get(source.url(query, options.count), source);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			passOver(`${source.id}: ${message}`, "source_failed", { source: source.id, message });
			continue;
		}
		let results: SearchResult[] = [];
		try {
			results = source.parse(page.body);
		} catch {
			/* A parser that chokes has found nothing. */
		}
		if (results.length === 0) {
			// An API's error body is JSON that may echo the query, and the query may say "captcha".
			if (!source.request && looksLikeRobotPage(page.url, page.body))
				passOver(
					`${source.id} answered with a verification page: it takes this client for a robot`,
					"source_robot_page",
					{ source: source.id },
				);
			else if (page.status >= 400)
				passOver(`${source.id} answered with HTTP ${page.status}`, "source_http_error", {
					source: source.id,
					status: page.status,
				});
			else
				passOver(
					`${source.id} returned a page without results (none found, or its markup changed)`,
					"source_no_results",
					{ source: source.id },
				);
			continue;
		}
		if (!source.request && !related(query, results)) {
			passOver(
				`${source.id} returned results that have nothing to do with the query, as engines do for clients they take for robots`,
				"source_unrelated",
				{ source: source.id },
			);
			continue;
		}
		return { source: source.id, results: results.slice(0, options.count), problems, problemCodes };
	}
	return { source: undefined, results: [], problems, problemCodes };
}
