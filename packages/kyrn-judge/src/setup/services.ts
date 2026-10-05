/**
 * The services `mu setup` knows and the shape of their keys. The desktop app keeps the same table for its first-run
 * guide (KYRN-desktop: packages/desktop/src/renderer/pages/welcome/services.ts): the fields both have mean the same
 * and hold the same values, so that the two can be compared line by line. What only mu needs (pi's provider for each
 * address, the check) comes after them. Plain data and pure functions: nothing here imports pi.
 *
 * A key is only ever sent to the service it belongs to. When its shape fits more than one service (DeepSeek and Qwen
 * both issue `sk-` and 32 hex digits), the person is asked which one: trying the key on each would hand it to a vendor
 * it does not belong to, which may log it. Kimi's two addresses (.cn and .ai) are one vendor, so a Kimi key may be
 * tried at both.
 */

/** Written the way pi names its wire protocols (a models.json `api`). */
export type SetupApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

/**
 * The one request that shows a key works:
 * - `openai-models`: GET {baseUrl}/models, `Authorization: Bearer <key>`
 * - `anthropic-models`: GET {baseUrl}/v1/models, `x-api-key` and `anthropic-version: 2023-06-01`
 * - `google-models`: GET {baseUrl}/models, `x-goog-api-key`
 * - `openrouter-key`: GET {baseUrl}/key, OpenRouter's "Get current API key" (its API reference). OpenRouter's model
 *   list answers any key, a wrong one too, so the list would say only that the service is there.
 * - `opencode-key`: OpenCode Zen's model list answers any key as well; its free Jev model (POST {baseUrl}/systemone,
 *   no charge) turns a wrong key down. Then GET {baseUrl}/models for the list.
 */
export type CheckKind = "openai-models" | "anthropic-models" | "google-models" | "openrouter-key" | "opencode-key";

export interface SetupService {
	// The fields of the app's table, with the same meaning.
	/** Stable: scripts pass it as `--service`. */
	readonly id: string;
	/** The name as the vendor writes it, the same in every language. */
	readonly name: string;
	/**
	 * Where the service answers. A vendor with a second region lists its address after the first: a key made in one
	 * region works only there, so a key the first address turns down is tried at the next one, of the same vendor.
	 * Empty for `other`, whose address the person types.
	 */
	readonly baseUrls: readonly string[];
	readonly api: SetupApi;
	/**
	 * The model to start with: the first of these the service lists, where `name*` is the newest listed id that starts
	 * with `name` (startModel). When none of them is listed, the service's first listed model. When the service lists
	 * nothing, its first model named in full (namedModel).
	 */
	readonly models: readonly string[];
	/** What its keys look like. Without one the service is only chosen by name. */
	readonly keyShape?: RegExp;
	/** Where a key is made: the vendor's console page. */
	readonly keyPage?: string;
	/** A service on this machine, which needs no key. */
	readonly keyless?: boolean;

	// mu's own.
	/**
	 * pi's provider at each address of `baseUrls`. `builtIn`: one of pi's own (packages/ai/src/providers), whose base
	 * URL, models and defaults apply; only the key is stored. Otherwise a provider mu writes into models.json.
	 */
	readonly providers: readonly string[];
	readonly builtIn: boolean;
	/** The check, when it is not the model list of `api` (OpenRouter's). */
	readonly check?: CheckKind;
	/** A service of one's own may take no key (`other`). */
	readonly keyOptional?: boolean;
	/**
	 * For a provider of mu's: how its endpoint differs from OpenAI's, as models.json's `compat` says it. Only what pi
	 * itself knows of the endpoint, since pi asks that compat describe verified differences only (docs/models.md).
	 */
	readonly compat?: Readonly<Record<string, boolean | string>>;
}

/** DeepSeek and Qwen (DashScope) both issue `sk-` and 32 lowercase hex digits. */
const SK_HEX32 = /^sk-[0-9a-f]{32}$/;
/** Zhipu's keys, for its pay-as-you-go API and its Coding Plan alike: 32 hex digits, a dot, 16 letters or digits. */
const ZHIPU = /^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/;

export const SETUP_SERVICES: readonly SetupService[] = [
	{
		id: "deepseek",
		name: "DeepSeek",
		baseUrls: ["https://api.deepseek.com"],
		api: "openai-completions",
		models: ["deepseek-v4-pro", "deepseek-chat"],
		keyShape: SK_HEX32,
		keyPage: "https://platform.deepseek.com/api_keys",
		providers: ["deepseek"],
		builtIn: true,
	},
	{
		id: "qwen",
		name: "Qwen",
		baseUrls: ["https://dashscope.aliyuncs.com/compatible-mode/v1"],
		api: "openai-completions",
		models: ["qwen3-coder-plus", "qwen3-max", "qwen-plus"],
		// The same shape as DeepSeek's: such a key is asked about, never tried on both.
		keyShape: SK_HEX32,
		keyPage: "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
		providers: ["qwen"],
		builtIn: false,
		// As pi's own catalog has Alibaba's compatible mode (its qwen-token-plan providers): no developer role, no `store`.
		compat: { supportsDeveloperRole: false, supportsStore: false },
	},
	{
		id: "kimi",
		name: "Kimi",
		// platform.moonshot.cn issues keys for the first address, platform.moonshot.ai for the second.
		baseUrls: ["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"],
		api: "openai-completions",
		models: ["kimi-k2.6"],
		// 48 letters and digits, but not SiliconFlow's 48 lowercase letters nor an OpenAI key (its T3BlbkFJ).
		keyShape: /^sk-(?![a-z]{48}$)(?![A-Za-z0-9]*T3BlbkFJ)[A-Za-z0-9]{48}$/,
		// platform.moonshot.cn/console/api-keys redirects here.
		keyPage: "https://platform.kimi.com/console/api-keys",
		providers: ["moonshotai-cn", "moonshotai"],
		builtIn: true,
	},
	{
		id: "glm",
		name: "GLM",
		// pi's provider on open.bigmodel.cn (zai-coding-cn) is the Coding Plan's address, below. A pay-as-you-go key
		// goes here, to a provider of mu's.
		baseUrls: ["https://open.bigmodel.cn/api/paas/v4"],
		api: "openai-completions",
		models: ["glm-*"],
		keyShape: ZHIPU,
		keyPage: "https://open.bigmodel.cn/usercenter/apikeys",
		providers: ["glm"],
		builtIn: false,
	},
	{
		// Not in the app's table: pi has a provider of its own for Zhipu's Coding Plan, which bills the subscription.
		id: "glm-coding",
		name: "GLM Coding Plan",
		baseUrls: ["https://open.bigmodel.cn/api/coding/paas/v4"],
		api: "openai-completions",
		models: ["glm-5.3", "glm-*"],
		keyShape: ZHIPU,
		keyPage: "https://open.bigmodel.cn/usercenter/apikeys",
		providers: ["zai-coding-cn"],
		builtIn: true,
	},
	{
		id: "siliconflow",
		name: "SiliconFlow",
		baseUrls: ["https://api.siliconflow.cn/v1"],
		api: "openai-completions",
		models: ["deepseek-ai/DeepSeek-V3*", "moonshotai/Kimi-K2*", "Qwen/Qwen3-Coder*"],
		keyShape: /^sk-[a-z]{48}$/,
		keyPage: "https://cloud.siliconflow.cn/account/ak",
		providers: ["siliconflow"],
		builtIn: false,
	},
	{
		id: "stepfun",
		name: "StepFun",
		baseUrls: ["https://api.stepfun.com/v1"],
		api: "openai-completions",
		models: ["step-*"],
		keyPage: "https://platform.stepfun.com/interface-key",
		providers: ["stepfun"],
		builtIn: false,
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		baseUrls: ["https://openrouter.ai/api/v1"],
		api: "openai-completions",
		models: ["moonshotai/kimi-k2.6"],
		keyShape: /^sk-or-/,
		keyPage: "https://openrouter.ai/keys",
		providers: ["openrouter"],
		builtIn: true,
		check: "openrouter-key",
	},
	{
		id: "opencode",
		name: "OpenCode Zen",
		baseUrls: ["https://opencode.ai/zen/v1"],
		api: "openai-completions",
		models: ["kimi-k2.6"],
		keyPage: "https://opencode.ai/auth",
		providers: ["opencode"],
		builtIn: true,
		check: "opencode-key",
	},
	{
		id: "openai",
		name: "OpenAI",
		baseUrls: ["https://api.openai.com/v1"],
		api: "openai-responses",
		models: ["gpt-5.5"],
		keyShape: /^sk-(?:proj-|svcacct-|admin-|(?!ant-|or-)[A-Za-z0-9_-]*T3BlbkFJ)/,
		keyPage: "https://platform.openai.com/api-keys",
		providers: ["openai"],
		builtIn: true,
	},
	{
		id: "anthropic",
		name: "Anthropic",
		baseUrls: ["https://api.anthropic.com"],
		api: "anthropic-messages",
		models: ["claude-opus-4-8"],
		keyShape: /^sk-ant-/,
		// console.anthropic.com/settings/keys redirects here.
		keyPage: "https://platform.claude.com/settings/keys",
		providers: ["anthropic"],
		builtIn: true,
	},
	{
		id: "google",
		name: "Google Gemini",
		baseUrls: ["https://generativelanguage.googleapis.com/v1beta"],
		api: "google-generative-ai",
		models: ["gemini-3.1-pro-preview"],
		keyShape: /^AIza[0-9A-Za-z_-]{35}$/,
		keyPage: "https://aistudio.google.com/apikey",
		providers: ["google"],
		builtIn: true,
	},
	{
		id: "xai",
		name: "xAI",
		baseUrls: ["https://api.x.ai/v1"],
		// pi's xai provider speaks the Responses API.
		api: "openai-responses",
		models: ["grok-4.7"],
		keyShape: /^xai-/,
		keyPage: "https://console.x.ai",
		providers: ["xai"],
		builtIn: true,
	},
	{
		id: "ollama",
		name: "Ollama",
		baseUrls: ["http://localhost:11434/v1"],
		api: "openai-completions",
		models: [],
		keyless: true,
		providers: ["ollama"],
		builtIn: false,
	},
	{
		// Not in the app's table: any address one types, with the API one names.
		id: "other",
		name: "Other",
		baseUrls: [],
		api: "openai-completions",
		models: [],
		providers: [],
		builtIn: false,
		keyOptional: true,
	},
];

export function serviceById(id: string): SetupService | undefined {
	return SETUP_SERVICES.find((service) => service.id === id);
}

/**
 * A pasted key as it was meant: without the spaces, line breaks and quotes that come along when it is copied out of a
 * page or a `.env` line.
 */
export function cleanKey(raw: string): string {
	let key = raw.trim();
	if (key.length >= 2 && (key[0] === '"' || key[0] === "'") && key.at(-1) === key[0]) key = key.slice(1, -1).trim();
	return key;
}

/**
 * The services whose keys have this shape, in the table's order. Several: the person says which (the key is never
 * tried on each). None: the shape is not known, and the person picks the service.
 */
export function servicesForKey(key: string): SetupService[] {
	const clean = cleanKey(key);
	return clean ? SETUP_SERVICES.filter((service) => service.keyShape?.test(clean)) : [];
}

/** The check of a service at an address that speaks `api`. */
export function checkKindOf(service: SetupService, api: SetupApi): CheckKind {
	if (service.check) return service.check;
	if (api === "anthropic-messages") return "anthropic-models";
	if (api === "google-generative-ai") return "google-models";
	return "openai-models";
}

/** Models a coding agent cannot talk to: embeddings, speech, images, moderation. Never started on by default. */
const NOT_CHAT =
	/embed|rerank|\btts\b|tts-|whisper|audio|speech|\basr\b|transcri|dall-e|image|moderation|\bocr\b|paraformer|cosyvoice|sambert|wanx|flux|stable-diffusion|kolors|video|realtime|davinci|babbage/i;

/** The listed models a coding agent can talk to; all of them when none looks like one. */
export function chatModels(listed: readonly string[]): string[] {
	const chat = listed.filter((id) => !NOT_CHAT.test(id));
	return chat.length > 0 ? chat : [...listed];
}

/** The version an id carries: its first run of digits and dots, `glm-4.6-air` -> [4, 6]; none: []. */
function versionOf(id: string): number[] {
	const found = /\d+(?:\.\d+)*/.exec(id);
	return found ? found[0].split(".").map(Number) : [];
}

/** Newer first: the higher version (4.6 before 4.5, 5 before 4.6, 4.5 before 4), then the plainer, shorter id. */
function newerFirst(a: string, b: string): number {
	const [x, y] = [versionOf(a), versionOf(b)];
	for (let part = 0; part < Math.max(x.length, y.length); part += 1) {
		if (x[part] === undefined) return 1;
		if (y[part] === undefined) return -1;
		if (x[part] !== y[part]) return y[part] - x[part];
	}
	return a.length - b.length;
}

/** The listed id `wanted` names: itself, or for `name*` the newest listed id that starts with `name`. */
function named(wanted: string, listed: readonly string[]): string | undefined {
	if (!wanted.endsWith("*")) return listed.includes(wanted) ? wanted : undefined;
	const prefix = wanted.slice(0, -1);
	return listed.filter((id) => id.startsWith(prefix)).sort(newerFirst)[0];
}

/**
 * The first of the service's models that it lists, where `name*` is the newest listed id that starts with `name`.
 * When there is none, the person picks from chatModels, the first one suggested (the app's startModel takes the first
 * listed model then; Ollama lists its embedding models too).
 */
export function tableModel(service: SetupService, listed: readonly string[]): string | undefined {
	for (const wanted of service.models) {
		const found = named(wanted, listed);
		if (found) return found;
	}
	return undefined;
}

/** The model a service is known to start with when it lists none: its first model named in full, or none. */
export function namedModel(service: SetupService): string | undefined {
	return service.models.find((wanted) => !wanted.endsWith("*"));
}
