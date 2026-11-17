import { checkCalibration } from "./calibration.ts";
import { CascadeJudge, type CascadeTier, type JudgeProfile } from "./cascade.ts";
import { BUILT_IN_JUDGES, type JudgeConfig, type KyrnConfig, LAYA } from "./config.ts";
import { JudgeError, type JudgeErrorKind } from "./errors.ts";
import { Judge, type JudgeLike } from "./judge.ts";
import { type ClassifierCall, ClassifierJudgeProvider } from "./providers/classifier.ts";
import { FreeJev, type FreeJevOutcome } from "./providers/free-jev.ts";
import { type ApiKeyResolver, GatewayJudgeProvider } from "./providers/gateway.ts";
import { HttpJudgeProvider } from "./providers/http-judge.ts";
import { JevRoutes } from "./providers/jev-routes.ts";
import { type LlmCompletion, LlmJudgeProvider } from "./providers/llm.ts";
import { LogprobJudgeProvider } from "./providers/logprob.ts";
import { MockJudgeProvider } from "./providers/mock.ts";
import {
	isOpenAIAddress,
	OPENAI_JUDGE_KEY,
	OpenAIDecisionsJudgeProvider,
	type OpenAIKeyProblem,
} from "./providers/openai-decisions.ts";
import { RefusalGuard } from "./providers/refusal-guard.ts";
import { CLM_DEFAULT_MODEL, clmEndpoint, TypeSafeJudgeProvider } from "./providers/typesafe.ts";
import { JudgeQueue } from "./queue.ts";
import type { JudgeProvider } from "./types.ts";

/** A judge's service that turned its key down, or cannot charge the account behind it (`RefusalGuard`). */
export interface JudgeRefusal {
	/** The judge by its name in the order (`jev`, `relay`). */
	readonly judge: string;
	/** The service that refused, as the ledger names it (`typesafe:jev-latest`). */
	readonly service: string;
	/** `auth`: the service turned the key down. `payment_required`: the account behind it cannot pay. */
	readonly kind: JudgeErrorKind;
	/** What the service said. */
	readonly message: string;
}

/** What only the host application can supply: credentials and generative models. */
export interface JudgeHost {
	gatewayApiKey?: ApiKeyResolver;
	/**
	 * The key of the host's `openai` model provider (pi's auth storage, OPENAI_API_KEY), for an `openai` judge at
	 * OpenAI's own address that has no key of its own. Without it, OPENAI_API_KEY from `env`.
	 */
	openaiApiKey?: ApiKeyResolver;
	/** Told when an `openai` judge has no key any more, or OpenAI turns its key down. */
	openaiKeyProblem?: (problem: OpenAIKeyProblem) => void;
	/** The `fetch` judge providers call with, e.g. one that keeps its connections open between calls. */
	fetch?: typeof fetch;
	/** A completion function bound to "provider/model-id", or undefined when the host has no such model. */
	llm?: (model: string, options: { thinking?: string }) => LlmCompletion | undefined;
	/** A classifier model of the host's catalog, bound to "provider/model-id", or undefined when the host has none. */
	classify?: (model: string) => ClassifierCall | undefined;
	/** How each call to the free Jev went, when the `jev` judge falls back to it (no key for any of Jev's services). */
	freeJev?: (outcome: FreeJevOutcome) => void;
	/** Told when a judge's service turned its key down, or cannot charge the account, and is left alone for now. */
	refused?: (refusal: JudgeRefusal) => void;
	/**
	 * The lines of the judges that answer only a few requests at a time (`JudgeConfig.concurrency`), by server. A host
	 * that builds judges more than once (the tiers, each route, a switch at runtime) passes the same map every time,
	 * so that a server has one line however many orders name it. Without it, each build keeps its own.
	 */
	queues?: Map<string, JudgeQueue>;
	env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_TIMEOUT_MS: Readonly<Record<JudgeConfig["type"], number>> = {
	// Jev answers in well under a second, but a cold connection over a long route can take several.
	jev: 10_000,
	typesafe: 10_000,
	// A CLM server embeds every question together with the state: a batch of long ones takes seconds on a small GPU.
	clm: 8000,
	// A small judge on this machine answers in a fraction of a second; long states on a laptop take a few.
	systemone: 8000,
	gateway: 4000,
	http: 8000,
	llm: 30_000,
	// Jev and its kin on a service of the host's catalog: the same latency as Jev's own routes.
	classifier: 10_000,
	// One short request per question, all at once; a hosted model's queue can still take seconds.
	logprob: 10_000,
	// A hosted judge too, over a long route when the connection is cold.
	openai: 10_000,
	mock: 1000,
};

/** OpenAI's keys: the `openai` judge's own, and the one of mu's `openai` model provider. */
const OPENAI_KEYS: readonly string[] = [OPENAI_JUDGE_KEY, "OPENAI_API_KEY"];

/**
 * Keys for a service other than TypeSafe (Jev on OpenRouter, an address of the user's own, a CLM server, mude, OpenAI).
 * Any other variable may hold a TypeSafe key under a name of its own, and goes to TypeSafe when no address is set.
 */
const KEYS_FOR_ELSEWHERE: ReadonlySet<string> = new Set([
	"MU_JUDGE_OPENROUTER_API_KEY",
	"MU_JUDGE_CUSTOM_API_KEY",
	"MU_JUDGE_CLM_API_KEY",
	"MU_JUDGE_MUDE_KEY",
	...OPENAI_KEYS,
]);

/** Keys of the other judge services, which an `openai` judge never sends to OpenAI or anywhere else. */
const KEYS_NOT_FOR_OPENAI: ReadonlySet<string> = new Set([
	"TYPESAFE_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OPENCODE_API_KEY",
	"CLOUDFLARE_API_KEY",
	...[...KEYS_FOR_ELSEWHERE].filter((key) => !OPENAI_KEYS.includes(key)),
]);

/** `llm:provider/model` and `classifier:provider/model` name a judge inline, without a `judges` entry. */
export function resolveJudgeConfig(name: string, config: KyrnConfig): JudgeConfig | undefined {
	if (name.startsWith("llm:")) return { type: "llm", model: name.slice("llm:".length) };
	if (name.startsWith("classifier:")) return { type: "classifier", model: name.slice("classifier:".length) };
	return config.judges[name] ?? BUILT_IN_JUDGES[name];
}

/**
 * A judge's provider. Each service is asked through a `RefusalGuard`, and `host.refused` hears when one starts to be
 * left alone. Not from OpenAI's judge, which reports its key itself (`host.openaiKeyProblem`).
 */
function createProvider(name: string, judge: JudgeConfig, host: JudgeHost): JudgeProvider {
	if (judge.type === "jev") return jevRoutes(name, judge, host);
	const provider = connect(name, judge, host);
	if (judge.type === "openai") return new RefusalGuard(provider);
	return new RefusalGuard(provider, (refusal) =>
		host.refused?.({ judge: name, service: provider.id, kind: refusal.kind, message: refusal.message }),
	);
}

/**
 * The `jev` judge's services, in the order `JevRoutes` asks them. A TypeSafe key is the direct route, a key for Jev on
 * OpenRouter the next, then a Vercel AI Gateway key, an OpenCode key (the paid Jev) and Cloudflare's key and account.
 * After them: the Vercel AI Gateway with the key pi keeps for it, and last Jev 1.13 on OpenCode Zen, free for a limited
 * time, with no key at all. Each service names the model its own way: a model set here is TypeSafe's ("jev-latest"),
 * and reaches the gateway only when it is written the gateway's way ("typesafe-ai/jev").
 */
function jevRoutes(name: string, judge: JudgeConfig, host: JudgeHost): JudgeProvider {
	const env = host.env ?? {};
	const keyed: JudgeProvider[] = [];
	if (env[judge.apiKeyEnv ?? "TYPESAFE_API_KEY"])
		keyed.push(createProvider(name, { ...judge, type: "typesafe" }, host));
	const openRouter = BUILT_IN_JUDGES["jev-openrouter"];
	if (openRouter.apiKeyEnv && env[openRouter.apiKeyEnv]) keyed.push(createProvider(name, openRouter, host));
	// The judge's own key variable and address are TypeSafe's: the gateway gets neither, only its own key.
	const model = judge.model?.includes("/") ? judge.model : "typesafe-ai/jev";
	const gateway = createProvider(name, { type: "gateway", model }, host);
	const gatewayKeyed = Boolean(env.AI_GATEWAY_API_KEY);
	if (gatewayKeyed) keyed.push(gateway);
	// Outside a mu session there is no catalog to reach OpenCode or Cloudflare with: the gateway is the last route.
	if (!host.classify) return new JevRoutes(gatewayKeyed ? keyed : [...keyed, gateway], keyed[0] ?? gateway);
	if (env.OPENCODE_API_KEY) keyed.push(createProvider(name, BUILT_IN_JUDGES["jev-opencode"], host));
	if (env.CLOUDFLARE_API_KEY && env.CLOUDFLARE_ACCOUNT_ID) {
		keyed.push(createProvider(name, BUILT_IN_JUDGES["jev-cloudflare"], host));
	}
	// The free Jev's end has a notice of its own (`host.freeJev`): its guard reports nothing.
	const free = new FreeJev(new RefusalGuard(connect(name, BUILT_IN_JUDGES["jev-opencode-free"], host)), host.freeJev);
	return new JevRoutes(gatewayKeyed ? [...keyed, free] : [...keyed, gateway, free], keyed[0] ?? free);
}

/** The provider that speaks to a judge's service, for every type but `jev`, which is several of them (`jevRoutes`). */
function connect(name: string, judge: JudgeConfig, host: JudgeHost): JudgeProvider {
	switch (judge.type) {
		case "mock":
			return new MockJudgeProvider();
		case "http": {
			if (!judge.baseUrl) throw new TypeError(`Judge "${name}" needs a baseUrl (the address of its server)`);
			const apiKeyEnv = judge.apiKeyEnv;
			return new HttpJudgeProvider({
				id: `http:${name}`,
				baseUrl: judge.baseUrl,
				path: judge.path,
				headers: (): Record<string, string> => {
					const token = apiKeyEnv ? host.env?.[apiKeyEnv] : undefined;
					return token ? { Authorization: `Bearer ${token}` } : {};
				},
				fetch: host.fetch,
			});
		}
		case "llm": {
			if (!judge.model) throw new TypeError(`Judge "${name}" needs a model ("provider/model-id")`);
			const complete = host.llm?.(judge.model, { thinking: judge.thinking });
			if (!complete) throw new TypeError(`Judge "${name}": model "${judge.model}" is not available`);
			return new LlmJudgeProvider({ id: `llm:${judge.model}`, complete });
		}
		case "classifier": {
			if (!judge.model?.includes("/")) throw new TypeError(`Judge "${name}" needs a model ("provider/model-id")`);
			const call = host.classify?.(judge.model);
			if (!call) throw new TypeError(`Judge "${name}": classifier models need a mu session`);
			return new ClassifierJudgeProvider({ model: judge.model, call });
		}
		case "logprob": {
			if (!judge.baseUrl || !judge.model) throw new TypeError(`Judge "${name}" needs a baseUrl and a model`);
			const keyName = judge.apiKeyEnv ?? "MU_JUDGE_CUSTOM_API_KEY";
			return new LogprobJudgeProvider({
				baseUrl: judge.baseUrl,
				model: judge.model,
				apiKey: () => host.env?.[keyName],
				keyName,
				body: judge.body,
				fetch: host.fetch,
			});
		}
		case "typesafe": {
			const keyName = judge.apiKeyEnv ?? "TYPESAFE_API_KEY";
			// A key set up for another service goes only to the address it was set up with, never to TypeSafe's.
			if (KEYS_FOR_ELSEWHERE.has(keyName) && !judge.baseUrl) {
				throw new TypeError(`Judge "${name}" needs a baseUrl: its key ${keyName} is not sent to TypeSafe`);
			}
			return new TypeSafeJudgeProvider({
				apiKey: () => host.env?.[keyName],
				keyName,
				model: judge.model,
				baseUrl: judge.baseUrl,
				fetch: host.fetch,
			});
		}
		case "clm": {
			// `clm-serve` asks for a key only when it was started with CLM_API_KEY; without one set here, none is sent.
			const keyName = judge.apiKeyEnv ?? "MU_JUDGE_CLM_API_KEY";
			return new TypeSafeJudgeProvider({
				apiKey: () => host.env?.[keyName],
				keyName,
				keyOptional: true,
				judgeName: "CLM",
				model: judge.model || CLM_DEFAULT_MODEL,
				baseUrl: clmEndpoint(judge.baseUrl),
				fetch: host.fetch,
			});
		}
		case "systemone": {
			// Like clm, for any other System One server: a key only when MU_JUDGE_SYSTEMONE_API_KEY (or apiKeyEnv) is set.
			if (!judge.baseUrl) throw new TypeError(`Judge "${name}" needs a baseUrl`);
			const keyName = judge.apiKeyEnv ?? "MU_JUDGE_SYSTEMONE_API_KEY";
			return new TypeSafeJudgeProvider({
				apiKey: () => host.env?.[keyName],
				keyName,
				keyOptional: true,
				judgeName: name,
				model: judge.model,
				baseUrl: clmEndpoint(judge.baseUrl),
				fetch: host.fetch,
			});
		}
		case "openai": {
			// The judge's own key (MU_JUDGE_OPENAI_KEY) goes to the judge's address. The key of mu's `openai` model
			// provider goes to OpenAI's own address only, never to a relay or proxy.
			const keyName = judge.apiKeyEnv ?? OPENAI_JUDGE_KEY;
			const atOpenAI = isOpenAIAddress(judge.baseUrl);
			if (KEYS_NOT_FOR_OPENAI.has(keyName)) {
				throw new TypeError(
					`Judge "${name}": its key ${keyName} belongs to another service and is not sent to OpenAI`,
				);
			}
			if (keyName === "OPENAI_API_KEY" && !atOpenAI) {
				throw new TypeError(`Judge "${name}": OPENAI_API_KEY is only sent to api.openai.com, not to its baseUrl`);
			}
			const providerKey = atOpenAI && keyName === OPENAI_JUDGE_KEY;
			return new OpenAIDecisionsJudgeProvider({
				apiKey: async () =>
					host.env?.[keyName] ||
					(providerKey ? await (host.openaiApiKey ?? (() => host.env?.OPENAI_API_KEY))() : undefined),
				keyName: providerKey ? `${OPENAI_JUDGE_KEY}, or OpenAI's key from mu setup or OPENAI_API_KEY` : keyName,
				model: judge.model,
				baseUrl: judge.baseUrl,
				fetch: host.fetch,
				onKeyProblem: host.openaiKeyProblem,
			});
		}
		default:
			return new GatewayJudgeProvider({
				apiKey: judge.apiKeyEnv
					? () => host.env?.[judge.apiKeyEnv!]
					: (host.gatewayApiKey ?? (() => host.env?.AI_GATEWAY_API_KEY)),
				model: judge.model,
				baseUrl: judge.baseUrl,
				fetch: host.fetch,
			});
	}
}

export interface BuiltJudge {
	readonly judge: JudgeLike;
	/** Tiers that could not be created, with the reason. The cascade runs without them. */
	readonly problems: readonly string[];
}

/** The configured tiers as one judge. Unknown or unavailable tiers are reported, not fatal. */
/** The names a judge can be asked for by, for whoever typed one mu does not know: mu.json's own first, then mu's. */
function knownJudges(config: KyrnConfig): string {
	// `mock` answers tests, never a person.
	const names = [...new Set([...Object.keys(config.judges), ...Object.keys(BUILT_IN_JUDGES)])].filter(
		(name) => name !== "mock",
	);
	return `Judges mu knows: ${names.join(", ")}; or llm:<provider>/<model>, classifier:<provider>/<model>`;
}

export function buildJudge(config: KyrnConfig, host: JudgeHost = {}): BuiltJudge {
	const tiers: CascadeTier[] = [];
	const problems: string[] = [];
	const queues = host.queues ?? new Map<string, JudgeQueue>();
	for (const name of config.tiers) {
		const judgeConfig = resolveJudgeConfig(name, config);
		if (!judgeConfig) {
			problems.push(
				name === LAYA
					? `"laya" is no longer built into mu: add a decision model from Hugging Face with mu judge model add <link>`
					: `unknown judge "${name}". ${knownJudges(config)}`,
			);
			continue;
		}
		try {
			const provider = createProvider(name, judgeConfig, host);
			const timeoutMs = judgeConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS[judgeConfig.type];
			tiers.push({
				judge: new Judge({ provider, timeoutMs, queue: queueOf(name, judgeConfig, queues, problems) }),
				profile: readableProfile(name, judgeConfig, problems),
			});
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (tiers.length === 0) {
		problems.push("no usable judge; every decision falls back");
		tiers.push({ judge: new Judge({ provider: new UnavailableJudgeProvider() }) });
	}
	return { judge: new CascadeJudge(tiers), problems };
}

/**
 * The line of a judge that says how many requests it answers at a time, undefined for one that does not. A server has
 * one line: judges at the same address share it, and a judge without an address goes by its name. `concurrency` is
 * mu.json's text: one that is no whole number of at least 1 is named in `problems`, and the judge gets no line.
 */
function queueOf(
	name: string,
	judge: JudgeConfig,
	queues: Map<string, JudgeQueue>,
	problems: string[],
): JudgeQueue | undefined {
	const concurrency: unknown = judge.concurrency;
	if (concurrency === undefined) return undefined;
	if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1) {
		problems.push(
			`judge "${name}": concurrency is not a whole number of 1 or more, so its requests are not lined up`,
		);
		return undefined;
	}
	const server = judge.baseUrl ?? name;
	const queue = queues.get(server) ?? new JudgeQueue(concurrency);
	queues.set(server, queue);
	return queue;
}

/**
 * A judge's profile with the calibration curves that can be read. The profile is mu.json's text: a curve that cannot
 * be read is left out and named in `problems`, and the judge's answers to that question are read as it gives them.
 */
function readableProfile(name: string, judge: JudgeConfig, problems: string[]): JudgeProfile | undefined {
	const profile = judge.profile;
	if (profile?.calibration === undefined) return profile;
	const { calibration, rejected } = checkCalibration(profile.calibration);
	for (const what of rejected) problems.push(`judge "${name}": ${what}, so it is not used`);
	return { ...profile, calibration };
}

/** No judge at all fails as a judge without a key does: nothing answers until the user sets one up. */
class UnavailableJudgeProvider implements JudgeProvider {
	readonly id = "none";
	async evaluate(): Promise<never> {
		throw new JudgeError("auth", "No judge is configured");
	}
}
