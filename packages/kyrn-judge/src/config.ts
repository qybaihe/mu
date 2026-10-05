import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgeProfile } from "./cascade.ts";
import type { DecisionMode } from "./decision.ts";
import { CONFIG_FILE, LEGACY_CONFIG_FILE, muEnv } from "./naming.ts";

/**
 * How one judge is reached. The decision points never see this: they ask
 * typed questions, and whichever model is configured here answers them.
 *
 * - `gateway`: a judge model behind the Vercel AI Gateway (Jev).
 * - `clm`:     CLM-8B behind `clm-serve`, which answers the same questions Jev does.
 * - `local`:   the Laya sidecar started by `mu judge start`.
 * - `http`:    any endpoint that takes `{state, questions}` and returns `{answers}`.
 * - `llm`:     a generative model from the host's model registry, prompted to answer as JSON.
 * - `classifier`: a classifier model from the host's model catalog (Jev on OpenCode Zen or Cloudflare, Clef, the
 *              System One models on OpenRouter, a llama.cpp classifier), reached with the host's own credentials.
 * - `mock`:    neutral answers, for tests and offline work.
 */
export interface JudgeConfig {
	/**
	 * `jev` is Jev by whichever access this machine has: TypeSafe directly when TYPESAFE_API_KEY is set, else
	 * OpenRouter when MU_JUDGE_OPENROUTER_API_KEY is set, else the Vercel AI Gateway when AI_GATEWAY_API_KEY is
	 * set, else OpenCode Zen when OPENCODE_API_KEY is set, else Cloudflare Workers AI when CLOUDFLARE_API_KEY and
	 * CLOUDFLARE_ACCOUNT_ID are, else the Vercel AI Gateway with the key pi keeps for it. `typesafe` is Jev over
	 * System One at `baseUrl` (TypeSafe's own, OpenRouter's, a relay's), `gateway` through the Vercel AI Gateway.
	 * `clm` is CLM-8B (github.com/Contrastive-LM/CLM) at the address of a `clm-serve`, which speaks System One too.
	 */
	readonly type: "jev" | "typesafe" | "clm" | "gateway" | "local" | "http" | "llm" | "classifier" | "mock";
	/**
	 * jev, typesafe, gateway: judge model id. clm: a model the server serves, default "clm-latest". llm and
	 * classifier: "provider/model-id", e.g. "opencode/jev-1.13" or "cloudflare-workers-ai/@cf/cloudflare/clef".
	 */
	readonly model?: string;
	/**
	 * gateway, local, http, clm, and the System One route (`typesafe`, or `jev` when a TypeSafe key is set).
	 * For System One this is the endpoint URL; empty uses TypeSafe's own. For clm, the server's address
	 * (`http://host:8700` is enough); empty is http://127.0.0.1:8700.
	 */
	readonly baseUrl?: string;
	/** http: request path, default "/evaluate". */
	readonly path?: string;
	/**
	 * http, typesafe, clm: name of the environment variable holding a bearer token. The token itself never goes in the
	 * file. A typesafe judge keyed by MU_JUDGE_OPENROUTER_API_KEY, MU_JUDGE_CUSTOM_API_KEY or MU_JUDGE_CLM_API_KEY needs
	 * its own `baseUrl`: those keys belong to another service and never go to TypeSafe. clm reads MU_JUDGE_CLM_API_KEY
	 * unless told otherwise, and calls without a key when it is not set: a CLM server asks for one only when it was
	 * started with CLM_API_KEY.
	 */
	readonly apiKeyEnv?: string;
	/** llm: thinking level for the judge model, default "off". */
	readonly thinking?: string;
	readonly timeoutMs?: number;
	readonly profile?: JudgeProfile;
}

export interface KyrnConfig {
	/** Judges tried in order; each later one only sees what the earlier ones left uncertain. */
	readonly tiers: readonly string[];
	/** Named judges, merged over the built-in ones (`jev` and its routes, `clef`, `clm`, `laya`, `mock`). */
	readonly judges: Readonly<Record<string, JudgeConfig>>;
	/** `default` plus per-decision overrides keyed by spec id. */
	readonly modes: Readonly<Record<string, DecisionMode>>;
	/**
	 * Decision id -> its own tiers, for a decision point that needs another judge than the rest,
	 * e.g. `{ "browser.step": ["luna"] }` while everything else runs on a small local model.
	 */
	readonly routes: Readonly<Record<string, readonly string[]>>;
	/** Per-feature switches and options, read by each feature. */
	readonly features: Readonly<Record<string, unknown>>;
	/** mu's own MCP servers: `{ "servers": { "<name>": { "command" | "url", … } } }`. Read by `src/inherit/mcp-config.ts`. */
	readonly mcp?: unknown;
	/** "provider/model-id" of a small generative model for the things a judge cannot do: task frames, lessons. */
	readonly writer?: string;
	/** Store judged states in the ledger (needed to distil a local judge). Off by default: states hold user content. */
	readonly recordState: boolean;
}

export const BUILT_IN_JUDGES: Readonly<Record<string, JudgeConfig>> = {
	jev: { type: "jev" },
	"jev-direct": { type: "typesafe" },
	// OpenRouter serves Jev over the same System One protocol. The key is Jev's own, not the one for OpenRouter's
	// chat models, so setting one never changes the other.
	"jev-openrouter": {
		type: "typesafe",
		baseUrl: "https://openrouter.ai/api/v1/systemone",
		model: "~typesafe/jev-latest",
		apiKeyEnv: "MU_JUDGE_OPENROUTER_API_KEY",
	},
	"jev-gateway": { type: "gateway", model: "typesafe-ai/jev" },
	// Jev on OpenCode Zen, with the key of OpenCode's models (OPENCODE_API_KEY, or `mu auth`). The free one is a
	// limited-time offer of OpenCode's and needs no key at all. OpenCode does not train on what Jev is sent.
	"jev-opencode": { type: "classifier", model: "opencode/jev-1.13" },
	"jev-opencode-free": { type: "classifier", model: "opencode/jev-1.13-free" },
	// Jev on Cloudflare Workers AI, with Cloudflare's key and account (CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID).
	"jev-cloudflare": { type: "classifier", model: "cloudflare-workers-ai/typesafe/jev" },
	// Cloudflare's own System One classifiers. Not measured on mu's questions yet.
	clef: { type: "classifier", model: "cloudflare-workers-ai/@cf/cloudflare/clef" },
	"clef-flash": { type: "classifier", model: "cloudflare-workers-ai/@cf/cloudflare/clef-flash" },
	// CLM-8B on this machine, where `clm-serve` listens by default. Its profile is not measured on mu's questions yet.
	clm: { type: "clm" },
	// Measured in kyrn/docs/03-local-judge.md: the base checkpoint classifies one text well, says "yes" to
	// nearly every relational question, and cannot use a rubric or judge the request itself.
	laya: { type: "local", profile: { capabilities: { relate: false, rate: false, meta: false } } },
	mock: { type: "mock" },
};

export const DEFAULT_CONFIG: KyrnConfig = {
	tiers: ["jev"],
	judges: {},
	// Verdicts take effect out of the box; a point that should only watch is set to "shadow" on its own.
	modes: { default: "active" },
	routes: {},
	features: {},
	recordState: false,
};

const MODES: readonly string[] = ["off", "shadow", "active"];
const JUDGE_TYPES: readonly string[] = [
	"jev",
	"typesafe",
	"clm",
	"gateway",
	"local",
	"http",
	"llm",
	"classifier",
	"mock",
] satisfies JudgeConfig["type"][];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModes(value: unknown): Record<string, DecisionMode> {
	const modes: Record<string, DecisionMode> = {};
	if (!isRecord(value)) return modes;
	for (const [specId, mode] of Object.entries(value)) {
		if (typeof mode === "string" && MODES.includes(mode)) modes[specId] = mode as DecisionMode;
	}
	return modes;
}

function readTiers(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((tier): tier is string => typeof tier === "string")
		.map((tier) => tier.trim())
		.filter(Boolean);
}

function readRoutes(value: unknown): Record<string, readonly string[]> {
	const routes: Record<string, readonly string[]> = {};
	if (!isRecord(value)) return routes;
	for (const [specId, tiers] of Object.entries(value)) {
		const parsed = readTiers(tiers);
		if (parsed.length > 0) routes[specId] = parsed;
	}
	return routes;
}

function readJudges(value: unknown): Record<string, JudgeConfig> {
	const judges: Record<string, JudgeConfig> = {};
	if (!isRecord(value)) return judges;
	for (const [name, config] of Object.entries(value)) {
		if (!isRecord(config) || typeof config.type !== "string") continue;
		if (!JUDGE_TYPES.includes(config.type)) continue;
		judges[name] = config as unknown as JudgeConfig;
	}
	return judges;
}

/** Parses the contents of `mu.json`. Unknown or malformed parts fall back to defaults instead of throwing. */
export function parseConfig(value: unknown): KyrnConfig {
	if (!isRecord(value)) return DEFAULT_CONFIG;
	const tiers = Array.isArray(value.tiers)
		? value.tiers.filter((tier): tier is string => typeof tier === "string")
		: [];
	return {
		tiers: tiers.length > 0 ? tiers : DEFAULT_CONFIG.tiers,
		judges: readJudges(value.judges),
		modes: { ...DEFAULT_CONFIG.modes, ...readModes(value.modes) },
		routes: readRoutes(value.routes),
		features: isRecord(value.features) ? value.features : {},
		mcp: isRecord(value.mcp) ? value.mcp : undefined,
		writer: typeof value.writer === "string" ? value.writer : undefined,
		recordState: value.recordState === true,
	};
}

export interface ConfigSource {
	/** Directory holding `mu.json`, normally the agent directory (~/.mu/agent). */
	readonly dir?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * `mu.json` from the agent directory (`kyrn.json` when there is none), then environment overrides:
 *   MU_JUDGE        comma-separated tiers, e.g. "laya" or "laya,jev"; "off" disables the kernel
 *   MU_JUDGE_MODE   default mode for every decision
 *   MU_WRITER       "provider/model-id"
 * Each is also read under its old `KYRN_` spelling.
 *
 * Only the user's own directory is read. A project must not be able to point
 * the judge, which sees user messages, at an endpoint of its choosing.
 */
export function loadConfig(source: ConfigSource = {}): { config: KyrnConfig; disabled: boolean; problem?: string } {
	const env = source.env ?? process.env;
	let config = DEFAULT_CONFIG;
	let problem: string | undefined;
	// The first file that exists wins, even when it is broken: a half-written mu.json must not silently bring back old settings.
	for (const file of source.dir ? [CONFIG_FILE, LEGACY_CONFIG_FILE] : []) {
		try {
			config = parseConfig(JSON.parse(readFileSync(join(source.dir as string, file), "utf8")));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			problem = `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`;
			break;
		}
	}

	const judge = muEnv("JUDGE", env)?.trim();
	if (judge === "off") return { config, disabled: true, problem };
	if (judge) {
		// "gateway" was the first name of the Jev backend.
		const tiers = judge.split(",").map((tier) => (tier.trim() === "gateway" ? "jev" : tier.trim()));
		config = { ...config, tiers: tiers.filter(Boolean) };
	}
	const mode = muEnv("JUDGE_MODE", env);
	if (mode && MODES.includes(mode)) config = { ...config, modes: { ...config.modes, default: mode as DecisionMode } };
	const writer = muEnv("WRITER", env);
	if (writer) config = { ...config, writer };
	return { config, disabled: false, problem };
}

/** A feature's options: its defaults, overridden by `features.<name>` when that is an object; `false` disables it. */
export function featureOptions<T extends { enabled: boolean }>(config: KyrnConfig, name: string, defaults: T): T {
	const value = config.features[name];
	if (value === false) return { ...defaults, enabled: false };
	if (value === true) return { ...defaults, enabled: true };
	if (isRecord(value)) return { ...defaults, ...value } as T;
	return defaults;
}
