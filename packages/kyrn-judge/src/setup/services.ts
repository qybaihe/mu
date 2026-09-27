/**
 * The services `mu setup` knows, with the shape of their keys: the one table the desktop app keeps a copy of
 * (desktop: its provider page). Plain data and pure functions, nothing imported from pi, so that the two copies
 * can be compared line by line.
 *
 * A key is only ever sent to the service it belongs to. When its shape fits more than one service (DeepSeek and
 * Qwen both issue `sk-` + 32 hex digits), the person is asked which one: trying the key on each would hand it to
 * a vendor it does not belong to, which may log it. Kimi's two addresses (.cn and .ai) are one vendor, so a Kimi
 * key may be tried on both.
 */

/** Written the way pi names its wire protocols (a models.json `api`). */
export type SetupApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

/**
 * The one request that shows a key works:
 * - `openai-models`: GET {baseUrl}/models, `Authorization: Bearer <key>`
 * - `anthropic-models`: GET {baseUrl}/v1/models, `x-api-key` and `anthropic-version: 2023-06-01`
 * - `google-models`: GET {baseUrl}/models, `x-goog-api-key`
 * - `openrouter-key`: GET {baseUrl}/key. OpenRouter lists its models to anyone, with or without a key, so its
 *   listing proves nothing; the key's own description answers only a key that works.
 */
export type CheckKind = "openai-models" | "anthropic-models" | "google-models" | "openrouter-key";

/** One address a service is reached at. */
export interface Reach {
	/**
	 * The provider id mu uses for it. With `builtIn`, it is one of pi's own providers (packages/ai/src/providers):
	 * pi's base URL, models and defaults apply, and only the key is stored. Without, mu writes it into models.json.
	 */
	readonly provider: string;
	readonly builtIn: boolean;
	/** pi's base URL for a built-in provider (tests keep the two equal), the one written to models.json otherwise. */
	readonly baseUrl: string;
	readonly api: SetupApi;
	/**
	 * For a provider of mu's: how its endpoint differs from OpenAI's, as models.json's `compat` says it. Only what pi
	 * itself knows of the endpoint, since pi asks that compat describe verified differences only (docs/models.md).
	 */
	readonly compat?: Readonly<Record<string, boolean | string>>;
}

/**
 * How the model to start with is found, step by step; the first step that names a model the service lists wins.
 * When the service lists no models (OpenRouter's check), pi's default is taken as it is.
 * - `piDefault`: pi's defaultModelPerProvider for the provider the key was confirmed on
 * - `piDefaultOf`: pi's default of another provider (a custom provider serving the same models)
 * - `id`: this model
 * - `newest`: the listed model that matches this pattern (case ignored) with the highest version numbers
 * - `firstListed`: whatever the service lists first
 */
export type ModelStep =
	| { readonly piDefault: true }
	| { readonly piDefaultOf: string }
	| { readonly id: string }
	| { readonly newest: string }
	| { readonly firstListed: true };

export interface SetupService {
	/** Stable: scripts pass it as `--service`, and the desktop app stores it. */
	readonly id: string;
	readonly name: { readonly zh: string; readonly en: string };
	/** Where the key is tried, in order. Empty for `other`, whose address the person types. */
	readonly reach: readonly Reach[];
	readonly check: CheckKind;
	/** `none`: no key at all (Ollama). `optional`: a service of one's own may take none. */
	readonly key: "required" | "optional" | "none";
	/** Key shapes that name this service. None: the service is only ever chosen from the list. */
	readonly shapes: readonly RegExp[];
	readonly model: readonly ModelStep[];
	/** Where a key is made. */
	readonly keyPage?: string;
}

/** DeepSeek and Qwen (DashScope) both issue `sk-` followed by 32 lowercase hex digits. */
const SK_HEX32 = /^sk-[0-9a-f]{32}$/;
/** Zhipu's keys, for both its pay-as-you-go API and its Coding Plan: 32 hex digits, a dot, 16 letters or digits. */
const ZHIPU = /^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/;

export const SETUP_SERVICES: readonly SetupService[] = [
	{
		id: "deepseek",
		name: { zh: "DeepSeek 深度求索", en: "DeepSeek" },
		reach: [{ provider: "deepseek", builtIn: true, baseUrl: "https://api.deepseek.com", api: "openai-completions" }],
		check: "openai-models",
		key: "required",
		shapes: [SK_HEX32],
		model: [{ piDefault: true }, { id: "deepseek-chat" }],
		keyPage: "https://platform.deepseek.com/api_keys",
	},
	{
		id: "qwen",
		name: { zh: "通义千问 Qwen（阿里云百炼）", en: "Qwen (Alibaba Cloud Model Studio)" },
		reach: [
			{
				provider: "qwen",
				builtIn: false,
				baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				api: "openai-completions",
				// As pi's own catalog has Alibaba's compatible mode (its qwen-token-plan providers): no developer role, no `store`.
				compat: { supportsDeveloperRole: false, supportsStore: false },
			},
		],
		check: "openai-models",
		key: "required",
		shapes: [SK_HEX32],
		model: [{ id: "qwen3-coder-plus" }, { id: "qwen3-max" }, { id: "qwen-plus" }],
		keyPage: "https://bailian.console.aliyun.com/",
	},
	{
		id: "kimi",
		name: { zh: "Kimi 月之暗面", en: "Kimi (Moonshot AI)" },
		// The same vendor at two addresses: platform.moonshot.cn issues keys for the first, platform.moonshot.ai for the second.
		reach: [
			{ provider: "moonshotai-cn", builtIn: true, baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions" },
			{ provider: "moonshotai", builtIn: true, baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions" },
		],
		check: "openai-models",
		key: "required",
		// 48 letters and digits. All lowercase letters is SiliconFlow's shape, and T3BlbkFJ marks an OpenAI key.
		shapes: [/^sk-(?![a-z]{48}$)(?!.*T3BlbkFJ)[A-Za-z0-9]{48}$/],
		model: [{ piDefault: true }],
		keyPage: "https://platform.moonshot.cn/console/api-keys",
	},
	{
		id: "glm",
		name: { zh: "智谱 GLM（bigmodel.cn，按量付费）", en: "Zhipu GLM (bigmodel.cn, pay as you go)" },
		// pi's provider on open.bigmodel.cn (zai-coding-cn) is the Coding Plan's address, which only a subscription
		// may use; a key of the pay-as-you-go API goes to this one, as a provider of mu's.
		reach: [
			{
				provider: "glm",
				builtIn: false,
				baseUrl: "https://open.bigmodel.cn/api/paas/v4",
				api: "openai-completions",
			},
		],
		check: "openai-models",
		key: "required",
		shapes: [ZHIPU],
		model: [{ piDefaultOf: "zai-coding-cn" }, { newest: "^glm-\\d" }],
		keyPage: "https://open.bigmodel.cn/",
	},
	{
		id: "glm-coding",
		name: { zh: "智谱 GLM Coding Plan（包月套餐）", en: "Zhipu GLM Coding Plan (subscription)" },
		reach: [
			{
				provider: "zai-coding-cn",
				builtIn: true,
				baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
				api: "openai-completions",
			},
		],
		check: "openai-models",
		key: "required",
		shapes: [ZHIPU],
		model: [{ piDefault: true }, { newest: "^glm-\\d" }],
		keyPage: "https://open.bigmodel.cn/",
	},
	{
		id: "siliconflow",
		name: { zh: "硅基流动 SiliconFlow", en: "SiliconFlow" },
		reach: [
			{
				provider: "siliconflow",
				builtIn: false,
				baseUrl: "https://api.siliconflow.cn/v1",
				api: "openai-completions",
			},
		],
		check: "openai-models",
		key: "required",
		shapes: [/^sk-[a-z]{48}$/],
		model: [{ newest: "deepseek-v[3-9]" }, { newest: "kimi-k2" }, { newest: "qwen3-coder" }],
		keyPage: "https://cloud.siliconflow.cn/account/ak",
	},
	{
		id: "stepfun",
		name: { zh: "阶跃星辰 StepFun", en: "StepFun" },
		reach: [
			{ provider: "stepfun", builtIn: false, baseUrl: "https://api.stepfun.com/v1", api: "openai-completions" },
		],
		check: "openai-models",
		key: "required",
		shapes: [],
		model: [{ newest: "^step-\\d" }],
		keyPage: "https://platform.stepfun.com/",
	},
	{
		id: "openrouter",
		name: { zh: "OpenRouter", en: "OpenRouter" },
		reach: [
			{ provider: "openrouter", builtIn: true, baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
		],
		check: "openrouter-key",
		key: "required",
		shapes: [/^sk-or-/],
		model: [{ piDefault: true }],
		keyPage: "https://openrouter.ai/keys",
	},
	{
		id: "openai",
		name: { zh: "OpenAI", en: "OpenAI" },
		reach: [{ provider: "openai", builtIn: true, baseUrl: "https://api.openai.com/v1", api: "openai-responses" }],
		check: "openai-models",
		key: "required",
		shapes: [/^sk-(?:proj|svcacct|admin)-/, /^sk-[A-Za-z0-9_-]*T3BlbkFJ/],
		model: [{ piDefault: true }],
		keyPage: "https://platform.openai.com/api-keys",
	},
	{
		id: "anthropic",
		name: { zh: "Anthropic（Claude API）", en: "Anthropic (Claude API)" },
		reach: [
			{ provider: "anthropic", builtIn: true, baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
		],
		check: "anthropic-models",
		key: "required",
		shapes: [/^sk-ant-/],
		model: [{ piDefault: true }],
		keyPage: "https://console.anthropic.com/settings/keys",
	},
	{
		id: "google",
		name: { zh: "Google Gemini", en: "Google Gemini" },
		reach: [
			{
				provider: "google",
				builtIn: true,
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				api: "google-generative-ai",
			},
		],
		check: "google-models",
		key: "required",
		shapes: [/^AIza[0-9A-Za-z_-]{35}$/],
		model: [{ piDefault: true }],
		keyPage: "https://aistudio.google.com/apikey",
	},
	{
		id: "xai",
		name: { zh: "xAI Grok", en: "xAI Grok" },
		reach: [{ provider: "xai", builtIn: true, baseUrl: "https://api.x.ai/v1", api: "openai-responses" }],
		check: "openai-models",
		key: "required",
		shapes: [/^xai-/],
		model: [{ piDefault: true }],
		keyPage: "https://console.x.ai",
	},
	{
		id: "ollama",
		name: { zh: "Ollama（本机）", en: "Ollama (this computer)" },
		reach: [{ provider: "ollama", builtIn: false, baseUrl: "http://localhost:11434/v1", api: "openai-completions" }],
		check: "openai-models",
		key: "none",
		shapes: [],
		model: [{ firstListed: true }],
		keyPage: "https://ollama.com",
	},
	{
		id: "other",
		name: {
			zh: "其他 OpenAI 或 Anthropic 兼容的服务",
			en: "Another OpenAI- or Anthropic-compatible service",
		},
		reach: [],
		check: "openai-models",
		key: "optional",
		shapes: [],
		model: [{ firstListed: true }],
	},
];

export function serviceById(id: string): SetupService | undefined {
	return SETUP_SERVICES.find((service) => service.id === id);
}

/**
 * A pasted key as it was meant: without the spaces, line breaks and quotes that come along when it is copied out
 * of a page or a `.env` line.
 */
export function cleanKey(raw: string): string {
	let key = raw.trim();
	if (key.length >= 2 && (key[0] === '"' || key[0] === "'") && key.at(-1) === key[0]) key = key.slice(1, -1).trim();
	return key;
}

/**
 * The services whose key has this shape, in the table's order. Several: the person says which (never tried on each).
 * None: the shape is not known, and the person picks the service.
 */
export function servicesForKey(key: string): SetupService[] {
	const clean = cleanKey(key);
	return SETUP_SERVICES.filter((service) => service.shapes.some((shape) => shape.test(clean)));
}
