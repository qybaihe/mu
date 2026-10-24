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
 * - `http`:    any endpoint that takes `{state, questions}` and returns `{answers}`.
 * - `llm`:     a generative model from the host's model registry, prompted to answer as JSON.
 * - `classifier`: a classifier model from the host's model catalog (Jev on OpenCode Zen or Cloudflare, Clef, the
 *              System One models on OpenRouter, a llama.cpp classifier), reached with the host's own credentials.
 * - `openai`:  OpenAI's decision model (`gpt-6-luna`) through its Decisions API, with an OpenAI API key.
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
	 * `openai` is OpenAI's decision model through `POST /v1/decisions`.
	 */
	readonly type: "jev" | "typesafe" | "clm" | "gateway" | "http" | "llm" | "classifier" | "openai" | "mock";
	/**
	 * jev, typesafe, gateway: judge model id. clm: a model the server serves, default "clm-latest". openai: default
	 * "gpt-6-luna". llm and classifier: "provider/model-id", e.g. "opencode/jev-1.13" or
	 * "cloudflare-workers-ai/@cf/cloudflare/clef".
	 */
	readonly model?: string;
	/**
	 * gateway, http, clm, and the System One route (`typesafe`, or `jev` when a TypeSafe key is set).
	 * For System One this is the endpoint URL; empty uses TypeSafe's own. For clm, the server's address
	 * (`http://host:8700` is enough); empty is http://127.0.0.1:8700. For openai, a relay or proxy that serves the
	 * same Decisions endpoint; empty is https://api.openai.com/v1.
	 */
	readonly baseUrl?: string;
	/** http: request path, default "/evaluate". */
	readonly path?: string;
	/**
	 * http, typesafe, clm: name of the environment variable holding a bearer token. The token itself never goes in the
	 * file. A typesafe judge keyed by MU_JUDGE_OPENROUTER_API_KEY, MU_JUDGE_CUSTOM_API_KEY or MU_JUDGE_CLM_API_KEY needs
	 * its own `baseUrl`: those keys belong to another service and never go to TypeSafe. clm reads MU_JUDGE_CLM_API_KEY
	 * unless told otherwise, and calls without a key when it is not set: a CLM server asks for one only when it was
	 * started with CLM_API_KEY. openai reads MU_JUDGE_OPENAI_KEY unless told otherwise; at OpenAI's own address, without
	 * it, the key of mu's `openai` model provider (`/login`, `mu setup`, OPENAI_API_KEY). Neither the provider's key nor
	 * a key of another judge service is ever sent to another address.
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
	/** Named judges, merged over the built-in ones (`jev` and its routes, `clef`, `clm`, `mude`, `openai`, `mock`). */
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
	// mude, the decision model trained for mu's judgment layer, on this Mac (`mu judge mude install`, Apple silicon):
	// the System One server that comes in its package, on 127.0.0.1:8790, with the key the install wrote to the .env.
	// Trusted on every capability: on mu's own dev scenarios (an internal benchmark, not public yet) it did as well as Jev
	// or better on relate, rate, meta, screening tool output (`tool.admission`) and promises (`turn.continue`), and on
	// classify but for one check: a tool's description screened for injected instructions (`tool.description`), where
	// Jev did better. Nothing measured it on injections in fetched content (`tool.injection`). So with a judge behind it,
	// `mu judge mude` routes those two checks to that judge (`routes` in mu.json). It answers in about 0.1 s here.
	mude: {
		type: "typesafe",
		baseUrl: "http://127.0.0.1:8790/v1/systemone",
		model: "mude",
		apiKeyEnv: "MU_JUDGE_MUDE_KEY",
		timeoutMs: 4000,
	},
	// OpenAI's decision model, gpt-6-luna, through the Decisions API. Not measured on mu's questions yet.
	openai: { type: "openai" },
	mock: { type: "mock" },
};

export const DEFAULT_CONFIG: KyrnConfig = {
	tiers: ["jev"],
	judges: {},
	// Verdicts take effect out of the box; a point that should only watch is set to "shadow" on its own.
	modes: {
		default: "active",
		// swarm.patch is off: it sees only paths and line counts, which the delegate result already lists, and it held
		// up every delegate call that brought back a patch.
		"swarm.patch": "off",
		// capability.disclosure is off: asked on every message, it opened nothing in 162 benchmark questions and 34 in
		// real sessions, while it held up the start of the turn. Packs stay hidden, and find_capability opens one.
		"capability.disclosure": "off",
		// Its rules deliver what matters; in single-prompt runs a "next_turn" verdict never reached anyone.
		"notify.routing": "shadow",
		// input.interjection follows the default: mu, not the key that sent it, decides when a message sent mid-run
		// reaches the work. A message waits for its verdict for at most 1.5 s (`features.interjection.waitMs`), and goes
		// as sent without one. A built-in "active" here would keep it acting under a default of shadow.
		// Its steers were mostly wrong where it flagged anything at all, so it only records until it is reworked.
		"turn.drift": "shadow",
	},
	routes: {},
	features: {},
	recordState: false,
};

const MODES: readonly string[] = ["off", "shadow", "active"];
/** Laya's name, and the type of its sidecar, which mu no longer has (`retiredJudges`). */
export const LAYA = "laya";
const RETIRED_TYPE = "local";
const JUDGE_TYPES: readonly string[] = [
	"jev",
	"typesafe",
	"clm",
	"gateway",
	"http",
	"llm",
	"classifier",
	"openai",
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

/**
 * Laya, the third-party local judge mu had until 0.2.4 (a Core ML sidecar of type `local`), is no longer built in. The
 * names in `judges` (as mu.json has it) that meant it: `laya`, unless an entry of a type mu knows took that name, and
 * every entry of type `local`. A configuration that still names one of them is read without it (laya-migration.ts).
 */
export function retiredJudges(judges: unknown): Set<string> {
	const names = new Set<string>();
	const entries = isRecord(judges) ? judges : {};
	const own = entries[LAYA];
	if (!(isRecord(own) && typeof own.type === "string" && JUDGE_TYPES.includes(own.type))) names.add(LAYA);
	for (const [name, entry] of Object.entries(entries)) {
		if (isRecord(entry) && entry.type === RETIRED_TYPE) names.add(name);
	}
	return names;
}

/**
 * `tiers` without the retired judges: `replacement` where the first of them was (mude, when it is set up on this
 * machine), or nothing. A judge already in the list is not added twice. Undefined when `tiers` names none of them.
 */
export function withoutRetired(
	tiers: readonly string[],
	retired: ReadonlySet<string>,
	replacement?: string,
): string[] | undefined {
	if (!tiers.some((tier) => retired.has(tier.trim()))) return undefined;
	const mapped = tiers.flatMap((tier) => (retired.has(tier.trim()) ? (replacement ? [replacement] : []) : [tier]));
	return mapped.filter((tier, index) => tier !== replacement || mapped.indexOf(tier) === index);
}

/** Whether `tiers` or a route of a parsed mu.json names a retired judge (`retiredJudges`). */
export function namesRetired(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const retired = retiredJudges(value.judges);
	// `tiers` is read as a list only (parseConfig); a route may be "a, b" too (readRoutes).
	const lists = [
		Array.isArray(value.tiers) ? value.tiers : [],
		...(isRecord(value.routes) ? Object.values(value.routes) : []),
	];
	return lists.some((tiers) => readTiers(tiers).some((tier) => retired.has(tier)));
}

export interface ParseOptions {
	/**
	 * The judge that answers where the file still names Laya (`retiredJudges`): mude, when it is set up on this
	 * machine. Asked only when the file names Laya. Without one, Laya is left out, and `tiers` with nothing else in it
	 * is the default.
	 */
	readonly replaceLaya?: () => string | undefined;
}

/** Parses the contents of `mu.json`. Unknown or malformed parts fall back to defaults instead of throwing. */
export function parseConfig(value: unknown, options: ParseOptions = {}): KyrnConfig {
	if (!isRecord(value)) return DEFAULT_CONFIG;
	const named = Array.isArray(value.tiers)
		? value.tiers.filter((tier): tier is string => typeof tier === "string")
		: [];
	const retired = retiredJudges(value.judges);
	const replacement = namesRetired(value) ? options.replaceLaya?.() : undefined;
	const tiers = withoutRetired(named, retired, replacement) ?? named;
	const routes = readRoutes(value.routes);
	for (const [specId, routed] of Object.entries(routes)) {
		const kept = withoutRetired(routed, retired, replacement);
		if (kept === undefined) continue;
		// A route left with no judge goes back to `tiers`.
		if (kept.length > 0) routes[specId] = kept;
		else delete routes[specId];
	}
	return {
		tiers: tiers.length > 0 ? tiers : DEFAULT_CONFIG.tiers,
		judges: readJudges(value.judges),
		modes: { ...DEFAULT_CONFIG.modes, ...readModes(value.modes) },
		routes,
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
	/** See `ParseOptions.replaceLaya`. */
	readonly replaceLaya?: () => string | undefined;
}

/** Where the configuration named Laya, which it is read without, and what took its place in the file. */
export interface LayaSkipped {
	/** mu.json (or kyrn.json) names it: laya-migration.ts takes it out of the file once. */
	readonly file: boolean;
	/** MU_JUDGE names it: skipped in every session that has the variable. */
	readonly env: boolean;
	/** The judge put where Laya was in the file (mude), if any. */
	readonly replacement?: string;
}

/**
 * `mu.json` from the agent directory (`kyrn.json` when there is none), then environment overrides:
 *   MU_JUDGE        comma-separated tiers, e.g. "jev" or "mude,jev"; "off" disables the kernel
 *   MU_JUDGE_MODE   default mode for every decision
 *   MU_WRITER       "provider/model-id"
 * Each is also read under its old `KYRN_` spelling.
 *
 * Laya is skipped wherever it is named (`retiredJudges`); `laya` says where.
 *
 * Only the user's own directory is read. A project must not be able to point
 * the judge, which sees user messages, at an endpoint of its choosing.
 */
export function loadConfig(source: ConfigSource = {}): {
	config: KyrnConfig;
	disabled: boolean;
	problem?: string;
	laya?: LayaSkipped;
} {
	const env = source.env ?? process.env;
	let config = DEFAULT_CONFIG;
	let problem: string | undefined;
	let inFile = false;
	let replacement: string | undefined;
	// The first file that exists wins, even when it is broken: a half-written mu.json must not silently bring back old settings.
	for (const file of source.dir ? [CONFIG_FILE, LEGACY_CONFIG_FILE] : []) {
		try {
			const value: unknown = JSON.parse(readFileSync(join(source.dir as string, file), "utf8"));
			inFile = namesRetired(value);
			config = parseConfig(value, {
				replaceLaya: () => {
					replacement = source.replaceLaya?.();
					return replacement;
				},
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			problem = `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`;
			break;
		}
	}

	let inEnv = false;
	const judge = muEnv("JUDGE", env)?.trim();
	if (judge === "off") return { config, disabled: true, problem };
	if (judge) {
		// "gateway" was the first name of the Jev backend.
		const tiers = judge
			.split(",")
			.map((tier) => (tier.trim() === "gateway" ? "jev" : tier.trim()))
			.filter(Boolean);
		// Laya is left out; MU_JUDGE naming nothing else leaves the judges of the file.
		const kept = config.judges[LAYA] ? tiers : tiers.filter((tier) => tier !== LAYA);
		inEnv = kept.length < tiers.length;
		if (kept.length > 0) config = { ...config, tiers: kept };
	}
	const mode = muEnv("JUDGE_MODE", env);
	if (mode && MODES.includes(mode)) config = { ...config, modes: { ...config.modes, default: mode as DecisionMode } };
	const writer = muEnv("WRITER", env);
	if (writer) config = { ...config, writer };
	const laya = inFile || inEnv ? { file: inFile, env: inEnv, replacement } : undefined;
	return { config, disabled: false, problem, ...(laya ? { laya } : {}) };
}

/** A feature's options: its defaults, overridden by `features.<name>` when that is an object; `false` disables it. */
export function featureOptions<T extends { enabled: boolean }>(config: KyrnConfig, name: string, defaults: T): T {
	const value = config.features[name];
	if (value === false) return { ...defaults, enabled: false };
	if (value === true) return { ...defaults, enabled: true };
	if (isRecord(value)) return { ...defaults, ...value } as T;
	return defaults;
}
