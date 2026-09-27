import { redactSecrets } from "../redact.ts";
import type { SetupLanguage } from "./language.ts";
import type { CheckKind } from "./services.ts";

/**
 * Whether a key works, from one request that lists the service's models, and when it does not, why, in a sentence a
 * person can act on. The key goes only into the request's headers: never into a URL, a message or an error.
 */

/** How long the check waits for an answer. */
export const CHECK_TIMEOUT_MS = 10_000;

export interface CheckRequest {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
}

/** The request for a check, with the key in its headers. `baseUrl` is the service's, as pi or models.json writes it. */
export function checkRequest(kind: CheckKind, baseUrl: string, key: string | undefined): CheckRequest {
	const base = baseUrl.replace(/\/+$/, "");
	const headers: Record<string, string> = { accept: "application/json" };
	switch (kind) {
		case "anthropic-models":
			headers["anthropic-version"] = "2023-06-01";
			if (key?.includes("sk-ant-oat")) {
				// A Claude subscription token (`claude setup-token`): pi sends it as a bearer token, and so does the check.
				headers.authorization = `Bearer ${key}`;
				headers["anthropic-beta"] = "oauth-2025-04-20";
			} else if (key) headers["x-api-key"] = key;
			return { url: `${base}/v1/models?limit=1000`, headers };
		case "google-models":
			if (key) headers["x-goog-api-key"] = key;
			return { url: `${base}/models?pageSize=1000`, headers };
		case "openrouter-key":
			if (key) headers.authorization = `Bearer ${key}`;
			return { url: `${base}/key`, headers };
		default:
			if (key) headers.authorization = `Bearer ${key}`;
			return { url: `${base}/models`, headers };
	}
}

/**
 * What went wrong, as something a person can do about it:
 * - `key`: the service does not accept the key
 * - `refused`: it answered 403 without saying why: a wrong key, or one without access
 * - `permission`: the key works but may not list models (an OpenAI key restricted to some endpoints)
 * - `balance`: no balance, credit or quota left
 * - `region`: the service does not serve the place the request came from
 * - `rate`: too many requests just now
 * - `address`: nothing at that address (404)
 * - `server`: the service's own error (5xx)
 * - `response`: an answer, but not a list of models: the address or the API type is wrong
 * - `timeout`, `dns`, `connection`, `tls`: the request never got an answer
 * - `other`: any other refusal
 */
export type ProblemKind =
	| "key"
	| "refused"
	| "permission"
	| "balance"
	| "region"
	| "rate"
	| "address"
	| "server"
	| "response"
	| "timeout"
	| "dns"
	| "connection"
	| "tls"
	| "other";

export interface Problem {
	readonly kind: ProblemKind;
	/** The address that was asked, without the key (a key never goes into a URL). */
	readonly url: string;
	readonly status?: number;
	/** What the service said, with anything that could be a credential taken out, cut short. */
	readonly said?: string;
}

export type CheckResult =
	| { readonly ok: true; readonly url: string; readonly models?: readonly string[] }
	| { readonly ok: false; readonly problem: Problem };

const BALANCE =
	/insufficient[\s_-]*(?:balance|quota|credit|funds)|arrear|balance|quota|credit|billing|payment|recharge|top[\s-]?up|余额|欠费|充值|额度/i;
const REGION =
	/unsupported_country|country|region|territory|location is not supported|user location|request not allowed|不支持.*地区|地区.*不支持/i;
const WRONG_KEY =
	/api[\s_-]?key[\s_-]*(?:not valid|invalid)|invalid[\s_-]*api[\s_-]*key|incorrect api key|invalid authentication|authentication fails|unauthori[sz]ed|token is invalid|令牌.*(?:过期|不正确)|invalid[\s_-]*(?:token|x-api-key)/i;
const PERMISSION = /scope|permission|not allowed to|insufficient permissions/i;

/** The service's own message, from the usual JSON shapes, else the text itself; nothing from a page of HTML. */
function messageOf(body: string): string {
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const error = parsed.error;
		const candidates = [
			typeof error === "object" && error !== null ? (error as Record<string, unknown>).message : undefined,
			typeof error === "string" ? error : undefined,
			parsed.message,
			typeof error === "object" && error !== null ? (error as Record<string, unknown>).code : undefined,
			parsed.code,
		];
		const found = candidates.find((value) => typeof value === "string" && value.trim());
		if (typeof found === "string") return found;
	} catch {
		// Not JSON: the text is the message.
	}
	return body.trimStart().startsWith("<") ? "" : body;
}

/**
 * A service's message, safe to show: the key and anything shaped like a credential out, and the masked tails some
 * services echo (DeepSeek: "Your api key: ****abcd is invalid") too.
 */
export function safeMessage(text: string, key: string | undefined): string {
	const known = key ? [key] : [];
	const clean = redactSecrets(text, known)
		.replace(/\*{2,}[A-Za-z0-9_-]{0,12}/g, "…")
		.replace(/\s+/g, " ")
		.trim();
	return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
}

/** Why an answer that is not a success is one, from its status and what it says. */
export function classifyAnswer(status: number, body: string): ProblemKind {
	const text = `${messageOf(body)} ${body}`;
	if (status === 401) return "key";
	if (status === 402) return "balance";
	if (status === 404) return "address";
	if (status >= 500) return "server";
	if (status === 400 || status === 403 || status === 429) {
		if (BALANCE.test(text)) return "balance";
		if (REGION.test(text)) return "region";
		if (WRONG_KEY.test(text)) return "key";
		if (status === 429) return "rate";
		if (status === 403) return PERMISSION.test(text) ? "permission" : "refused";
	}
	return "other";
}

/** The system's error code behind a failed fetch: on its cause, or on the first of several attempts (IPv4 and IPv6). */
function errorCode(error: unknown, depth = 0): string {
	if (typeof error !== "object" || error === null || depth > 4) return "";
	const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown };
	if (typeof code === "string" && code) return code;
	if (Array.isArray(errors) && errors.length > 0) return errorCode(errors[0], depth + 1);
	return errorCode(cause, depth + 1);
}

/** What kept a request from getting any answer, from the error fetch threw. */
export function classifyFailure(error: unknown): ProblemKind {
	const name = error instanceof Error ? error.name : "";
	if (name === "TimeoutError" || name === "AbortError") return "timeout";
	const code = errorCode(error);
	if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT")
		return "timeout";
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
	if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return "tls";
	return "connection";
}

/** Model ids from a listing: OpenAI's `data`, Google's `models` (named `models/<id>`), Ollama's and the rest alike. */
export function listedModels(kind: CheckKind, body: unknown): string[] | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as Record<string, unknown>;
	const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : undefined;
	if (!list) return undefined;
	const ids: string[] = [];
	for (const entry of list) {
		if (typeof entry === "string") {
			ids.push(entry);
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const model = entry as Record<string, unknown>;
		if (kind === "google-models") {
			const methods = model.supportedGenerationMethods;
			if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
		}
		const id = typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : undefined;
		if (id) ids.push(kind === "google-models" ? id.replace(/^models\//, "") : id);
	}
	return [...new Set(ids)];
}

export interface CheckOptions {
	readonly kind: CheckKind;
	readonly baseUrl: string;
	readonly key: string | undefined;
	readonly fetch: typeof fetch;
	readonly timeoutMs?: number;
}

/** One request to the service. Nothing but the answer's status and shape is kept of it. */
export async function checkKey({
	kind,
	baseUrl,
	key,
	fetch,
	timeoutMs = CHECK_TIMEOUT_MS,
}: CheckOptions): Promise<CheckResult> {
	const request = checkRequest(kind, baseUrl, key);
	// Never the URL with a query in a message: none carries a key here, but the address is what a person compares.
	const url = request.url.split("?")[0];
	let response: Response;
	try {
		response = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		return { ok: false, problem: { kind: classifyFailure(error), url } };
	}
	let text = "";
	try {
		text = await response.text();
	} catch {
		// The status still says enough.
	}
	if (!response.ok) {
		return {
			ok: false,
			problem: {
				kind: classifyAnswer(response.status, text),
				url,
				status: response.status,
				said: safeMessage(messageOf(text), key) || undefined,
			},
		};
	}
	if (kind === "openrouter-key") return { ok: true, url };
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return { ok: false, problem: { kind: "response", url, status: response.status } };
	}
	const models = listedModels(kind, body);
	if (!models) return { ok: false, problem: { kind: "response", url, status: response.status } };
	return { ok: true, url, models };
}

export interface ExplainContext {
	readonly service: string;
	/** Where a proxy was taken from, when one is set ("HTTPS_PROXY", "settings.json"): the network sentences name it. */
	readonly proxy?: string;
	readonly timeoutMs?: number;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** A problem as one or two plain sentences. Nothing in them comes from the key. */
export function explainProblem(problem: Problem, context: ExplainContext, language: SetupLanguage): string {
	const { service } = context;
	const host = hostOf(problem.url);
	const seconds = Math.round((context.timeoutMs ?? CHECK_TIMEOUT_MS) / 1000);
	const local = /^(localhost|127\.|\[::1\])/.test(host);
	const proxyHint =
		language === "zh"
			? context.proxy
				? `这次请求走了代理（${context.proxy}），确认代理正在运行。`
				: "如果需要代理：设置 HTTPS_PROXY，或在 ~/.mu/agent/settings.json 里写 httpProxy，然后重新运行 mu setup。"
			: context.proxy
				? `The request went through your proxy (${context.proxy}): check that it is running.`
				: "If you need a proxy, set HTTPS_PROXY (or httpProxy in ~/.mu/agent/settings.json) and run mu setup again.";
	const said = problem.said
		? language === "zh"
			? `（服务的原话：${problem.said}）`
			: ` (The service said: ${problem.said})`
		: "";
	const zh = language === "zh";
	switch (problem.kind) {
		case "key":
			return zh
				? `${service} 不接受这个密钥。检查是否完整复制，以及它确实是 ${service} 的密钥。`
				: `${service} does not accept this key. Check that you copied all of it, and that it is a ${service} key.`;
		case "refused":
			return zh
				? `${service} 拒绝了这个密钥（HTTP 403）：可能是密钥不对，或它没有访问权限。${said}`
				: `${service} refused this key (HTTP 403): it may be wrong, or not allowed access.${said}`;
		case "permission":
			return zh
				? "这个密钥有效，但没有读取模型列表的权限（受限密钥）。给它读取模型的权限，或换一个密钥。"
				: "The key works, but may not read the list of models (a restricted key). Allow it to read models, or use another key.";
		case "balance":
			return zh
				? `${service} 的账户没有余额或额度了。充值后重新运行 mu setup。`
				: `The ${service} account has no balance or quota left. Top it up, then run mu setup again.`;
		case "region":
			return zh
				? `${service} 不向你所在的地区提供服务。需要一个位于支持地区的代理或 VPN。${proxyHint}`
				: `${service} does not serve the region this request came from. A proxy or VPN in a supported region is needed. ${proxyHint}`;
		case "rate":
			return zh
				? `${service} 说请求太频繁。等一分钟再试。`
				: `${service} says there were too many requests. Wait a minute and try again.`;
		case "address":
			return zh
				? `${problem.url} 这个地址不存在（HTTP 404）：地址填错了。`
				: `Nothing answers at ${problem.url} (HTTP 404): the address is wrong.`;
		case "server":
			return zh
				? `${service} 自己出错了（HTTP ${problem.status}）。过一会儿再试。`
				: `${service} had an error of its own (HTTP ${problem.status}). Try again in a while.`;
		case "response":
			return zh
				? `${problem.url} 有回应，但不是模型列表：检查地址和接口类型。`
				: `${problem.url} answered, but not with a list of models: check the address and the API type.`;
		case "timeout":
			return zh
				? `${seconds} 秒内 ${host} 没有回应。网络可能不通：有些地区要用代理或 VPN 才能访问。${proxyHint}`
				: `No answer from ${host} within ${seconds} s. The network may block it: in some regions a proxy or VPN is needed. ${proxyHint}`;
		case "dns":
			return zh
				? `找不到 ${host}：没有联网，或这里解析不了这个域名。${proxyHint}`
				: `Could not find ${host}: there is no internet connection, or the name cannot be resolved here. ${proxyHint}`;
		case "connection":
			if (local) {
				return zh
					? `${host} 上没有服务在监听：它启动了吗？`
					: `Nothing is listening at ${host}: is the service running?`;
			}
			return zh ? `连不上 ${host}。${proxyHint}` : `Could not connect to ${host}. ${proxyHint}`;
		case "tls":
			return zh
				? `和 ${host} 的安全连接失败了：可能有代理或防火墙在拦截 HTTPS。`
				: `The secure connection to ${host} failed: a proxy or firewall may be intercepting HTTPS.`;
		default:
			return zh
				? `${service} 拒绝了这次检查（HTTP ${problem.status ?? "?"}）。${said}`
				: `${service} refused the check (HTTP ${problem.status ?? "?"}).${said}`;
	}
}
