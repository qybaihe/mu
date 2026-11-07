import {
	type Api,
	createProvider,
	type FetchFunction,
	lazyApi,
	type Model,
	type ModelCost,
	type Provider,
	type RefreshModelsContext,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import {
	ANTIGRAVITY_ENDPOINTS,
	ANTIGRAVITY_PROVIDER,
	antigravityUserAgent,
	CLOUD_CODE_API,
	CLOUD_CODE_ENDPOINT,
	GEMINI_CLI_PROVIDER,
} from "./endpoints.ts";
import { antigravityOAuth, geminiCliOAuth } from "./oauth.ts";

/**
 * The two Google providers behind a Google sign-in: Gemini CLI's (the Gemini
 * models, on the free tier or a Code Assist licence) and Antigravity's (Gemini,
 * Claude and GPT-OSS). Both stream through Cloud Code Assist.
 */

const cloudCode = () => lazyApi(() => import("./cloud-code.ts"));

const FREE: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** What in Google's catalog is not a chat model: images, live audio, computer use, research agents, and the aliases. */
const NOT_CHAT = /image|live|computer-use|customtools|latest|deep-research|tts|embedding/;

/** Google's own Gemini catalog, the one its API keys see, which is the one Gemini CLI serves. */
export function geminiCliModels(): Model<Api>[] {
	return (Object.values(GOOGLE_MODELS) as Model<Api>[])
		.filter((model) => model.id.startsWith("gemini-") && !NOT_CHAT.test(model.id))
		.map((model) => ({
			...model,
			api: CLOUD_CODE_API,
			provider: GEMINI_CLI_PROVIDER,
			baseUrl: CLOUD_CODE_ENDPOINT,
			cost: FREE,
		}));
}

export function geminiCliProvider(): Provider {
	return createProvider({
		id: GEMINI_CLI_PROVIDER,
		name: "Google Gemini CLI (experimental)",
		baseUrl: CLOUD_CODE_ENDPOINT,
		auth: { oauth: geminiCliOAuth },
		models: geminiCliModels(),
		api: cloudCode(),
	});
}

// ---------------------------------------------------------------------------
// Antigravity

/** Gemini 3 thinks at a level, never not at all; Pro has no "minimal", nor has Gemini 4. As Google's catalog has them. */
const FLASH_LEVELS: ThinkingLevelMap = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};
const PRO_LEVELS: ThinkingLevelMap = { ...FLASH_LEVELS, minimal: null };

const levelsOf = (id: string): ThinkingLevelMap | undefined =>
	/^gemini-3(?:\.\d+)?-pro|^gemini-4/.test(id)
		? PRO_LEVELS
		: /^gemini-3(?:\.\d+)?-flash/.test(id)
			? FLASH_LEVELS
			: undefined;

const OPUS: ModelCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const SONNET: ModelCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const GEMINI_PRO: ModelCost = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.375 };
const GEMINI_FLASH: ModelCost = { input: 0.5, output: 3, cacheRead: 0.5, cacheWrite: 0 };
const GPT_OSS: ModelCost = { input: 0.09, output: 0.36, cacheRead: 0, cacheWrite: 0 };

function antigravityModel(
	id: string,
	name: string,
	fields: Pick<Model<Api>, "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens">,
): Model<Api> {
	const levels = levelsOf(id);
	return {
		id,
		name: `${name} (Antigravity)`,
		api: CLOUD_CODE_API,
		provider: ANTIGRAVITY_PROVIDER,
		baseUrl: ANTIGRAVITY_ENDPOINTS[0],
		...fields,
		...(levels ? { thinkingLevelMap: levels } : {}),
	};
}

const TEXT_AND_IMAGE: Model<Api>["input"] = ["text", "image"];

/**
 * What Antigravity served when pi dropped it (costs are the same models' API
 * prices, for reference: Antigravity itself is a subscription). Signing in
 * adds what it serves now.
 */
export function antigravityBaseline(): Model<Api>[] {
	const claude = (maxTokens: number, reasoning: boolean, cost: ModelCost) =>
		({ reasoning, input: TEXT_AND_IMAGE, cost, contextWindow: 200000, maxTokens }) as const;
	const gemini = (cost: ModelCost) =>
		({ reasoning: true, input: TEXT_AND_IMAGE, cost, contextWindow: 1048576, maxTokens: 65535 }) as const;
	return [
		antigravityModel("claude-opus-4-5-thinking", "Claude Opus 4.5 Thinking", claude(64000, true, OPUS)),
		antigravityModel("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking", claude(128000, true, OPUS)),
		antigravityModel("claude-sonnet-4-5", "Claude Sonnet 4.5", claude(64000, false, SONNET)),
		antigravityModel("claude-sonnet-4-5-thinking", "Claude Sonnet 4.5 Thinking", claude(64000, true, SONNET)),
		antigravityModel("claude-sonnet-4-6", "Claude Sonnet 4.6", claude(64000, true, SONNET)),
		antigravityModel("gemini-3-flash", "Gemini 3 Flash", gemini(GEMINI_FLASH)),
		antigravityModel("gemini-3.1-pro-high", "Gemini 3.1 Pro High", gemini(GEMINI_PRO)),
		antigravityModel("gemini-3.1-pro-low", "Gemini 3.1 Pro Low", gemini(GEMINI_PRO)),
		antigravityModel("gpt-oss-120b-medium", "GPT-OSS 120B Medium", {
			reasoning: false,
			input: ["text"],
			cost: GPT_OSS,
			contextWindow: 131072,
			maxTokens: 32768,
		}),
	];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const positive = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

/** The families this API can carry for us; the rest of the list (tab completion, image models, internal ids) is not chat. */
const SERVED = /^(?:gemini|claude|gpt-oss)-/;

/**
 * The models in a `fetchAvailableModels` answer: `{ models: { <id>: {...} } }`,
 * or a list of `{ id }` just in case. What it says about a model it knows is
 * used (its name, context, output limit, images, thinking); the rest comes from
 * the model's family. A model the baseline has keeps the baseline's entry. A
 * placeholder for a model the account may not use (`disabled`, or an id such as
 * `gemini-4-argon-disabled`) is left out: asking it fails.
 */
export function antigravityModelsFrom(body: unknown): Model<Api>[] {
	const listed = isRecord(body) ? body.models : undefined;
	const entries: [string, Record<string, unknown>][] = Array.isArray(listed)
		? listed.flatMap((item): [string, Record<string, unknown>][] =>
				isRecord(item) && typeof item.id === "string" ? [[item.id, item]] : [],
			)
		: isRecord(listed)
			? Object.entries(listed).map(([id, info]) => [id, isRecord(info) ? info : {}])
			: [];
	const baseline = new Map(antigravityBaseline().map((model) => [model.id, model]));
	const models = new Map<string, Model<Api>>();
	for (const [raw, info] of entries) {
		const id = raw.trim();
		if (!SERVED.test(id) || /image/.test(id) || /-disabled$/.test(id) || info.disabled === true || models.has(id))
			continue;
		const known = baseline.get(id);
		if (known) {
			models.set(id, known);
			continue;
		}
		const family = id.startsWith("claude-") ? "claude" : id.startsWith("gpt-oss-") ? "gpt-oss" : "gemini";
		const name = typeof info.displayName === "string" && info.displayName.trim() ? info.displayName.trim() : id;
		const images = typeof info.supportsImages === "boolean" ? info.supportsImages : family !== "gpt-oss";
		// Gemini 3 always thinks; for the others only a model that says so, or is named so, is asked to.
		const reasoning =
			family === "gemini"
				? true
				: typeof info.supportsThinking === "boolean"
					? info.supportsThinking
					: /thinking/.test(id);
		models.set(
			id,
			antigravityModel(id, name, {
				reasoning,
				input: images ? TEXT_AND_IMAGE : ["text"],
				cost: FREE,
				contextWindow:
					positive(info.maxTokens) ?? (family === "gemini" ? 1048576 : family === "claude" ? 200000 : 131072),
				maxTokens:
					positive(info.maxOutputTokens) ?? (family === "gemini" ? 65535 : family === "claude" ? 64000 : 32768),
			}),
		);
	}
	return [...models.values()];
}

/** What Antigravity serves this account now. Without a sign-in there is nothing to ask. */
export async function fetchAntigravityModels(
	context: RefreshModelsContext,
	fetcher: FetchFunction = globalThis.fetch,
): Promise<Model<Api>[]> {
	const credential = context.credential;
	if (credential?.type !== "oauth") return [];
	let failure = "no endpoint answered";
	for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
		const response = await fetcher(`${endpoint}/v1internal:fetchAvailableModels`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credential.access}`,
				"Content-Type": "application/json",
				"User-Agent": antigravityUserAgent(),
			},
			body: "{}",
			signal: context.signal,
		});
		if (response.ok) return antigravityModelsFrom(await response.json());
		failure = `${endpoint} answered ${response.status}`;
	}
	throw new Error(`Antigravity did not list its models: ${failure}`);
}

export function antigravityProvider(fetcher?: FetchFunction): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Google Antigravity (experimental)",
		baseUrl: ANTIGRAVITY_ENDPOINTS[0],
		auth: { oauth: antigravityOAuth },
		models: antigravityBaseline(),
		fetchModels: (context) => fetchAntigravityModels(context, fetcher),
		api: cloudCode(),
	});
}
