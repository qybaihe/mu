import { describe, expect, it } from "vitest";
import { BUILT_IN_JUDGES, parseConfig } from "../src/config.ts";
import { isJudgeError } from "../src/errors.ts";
import { CLM_BASE_URL, clmEndpoint, TypeSafeJudgeProvider } from "../src/providers/typesafe.ts";
import { buildJudge } from "../src/registry.ts";
import type { Questions } from "../src/types.ts";

const questions = {
	edit: { type: "boolean", instructions: "Does `user_message` ask for a code change?" },
	kind: { type: "choice", instructions: "What is it?", criteria: { chat: "Small talk", other: "Something else" } },
	size: { type: "score", instructions: "How big?", criteria: ["small", "medium", "large"] },
} satisfies Questions;

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		seen.url = String(url);
		seen.init = init;
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

describe("TypeSafeJudgeProvider", () => {
	it("speaks System One: yes/no questions go out as noul and come back as probabilities", async () => {
		const seen: { url?: string; init?: RequestInit } = {};
		const provider = new TypeSafeJudgeProvider({
			apiKey: "test-key",
			fetch: fakeFetch(
				200,
				{
					model: "jev-1",
					answers: {
						edit: { noul: 0.93 },
						kind: { choice: "chat", confidence: 0.8, probabilities: { chat: 0.9, other: 0.1 } },
						size: { score: 1.4, confidence: 0.7, probabilities: {} },
					},
					usage: { input_tokens: 300, output_tokens: 40 },
				},
				seen,
			),
		});

		const result = await provider.evaluate({ state: { user_message: "hi" }, questions });
		const sent = JSON.parse(String(seen.init?.body)) as {
			model: string;
			questions: Record<string, { type: string }>;
		};

		expect(seen.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(new Headers(seen.init?.headers).get("authorization")).toBe("Bearer test-key");
		expect(sent.model).toBe("jev-latest");
		expect(Object.values(sent.questions).map((question) => question.type)).toEqual(["noul", "choice", "score"]);
		expect(result.answers.edit).toMatchObject({ type: "boolean", probability: 0.93 });
		expect(result.answers.kind).toMatchObject({
			type: "choice",
			choice: "chat",
			probabilities: { chat: 0.9, other: 0.1 },
		});
		expect(result.answers.size).toMatchObject({ type: "score", score: 1.4 });
		expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 40 });
		expect(result.modelId).toBe("jev-1");
	});

	it("posts to a configured base URL, including a private-network HTTP address", async () => {
		const seen: { url?: string } = {};
		const provider = new TypeSafeJudgeProvider({
			apiKey: "k",
			baseUrl: "http://192.168.31.124:8000/v1/systemone/",
			fetch: fakeFetch(
				200,
				{
					answers: {
						edit: { noul: 0.5 },
						kind: { choice: "other" },
						size: { score: 1 },
					},
				},
				seen,
			),
		});
		await provider.evaluate({ state: "s", questions });
		expect(seen.url).toBe("http://192.168.31.124:8000/v1/systemone");
	});

	it("classifies failures without ever echoing the key", async () => {
		const denied = new TypeSafeJudgeProvider({
			apiKey: "secret-key",
			fetch: fakeFetch(401, { error: { message: "bad key" } }),
		});
		const partial = new TypeSafeJudgeProvider({
			apiKey: "secret-key",
			fetch: fakeFetch(200, { answers: { edit: { noul: 0.5 } } }),
		});
		const keyless = new TypeSafeJudgeProvider({ apiKey: () => undefined, fetch: fakeFetch(200, {}) });

		for (const [provider, kind] of [
			[denied, "auth"],
			[partial, "invalid_response"],
			[keyless, "auth"],
		] as const) {
			const error = await provider.evaluate({ state: "s", questions }).catch((caught: unknown) => caught);
			expect(isJudgeError(error) && error.kind).toBe(kind);
			expect(String(error)).not.toContain("secret-key");
		}
	});

	it("reads an empty base URL as TypeSafe's own", async () => {
		const seen: { url?: string } = {};
		const provider = new TypeSafeJudgeProvider({
			apiKey: "k",
			baseUrl: "",
			fetch: fakeFetch(
				200,
				{ answers: { edit: { noul: 0.5 }, kind: { choice: "other" }, size: { score: 1 } } },
				seen,
			),
		});
		await provider.evaluate({ state: "s", questions });
		expect(seen.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(provider.id).toBe("typesafe:jev-latest");
	});

	it("reaches Jev on OpenRouter with a key of its own, and names that service when something is wrong", async () => {
		const seen: { url?: string; init?: RequestInit } = {};
		const built = buildJudge(parseConfig({ tiers: ["jev-openrouter"] }), {
			env: { MU_JUDGE_OPENROUTER_API_KEY: "or-key", TYPESAFE_API_KEY: "ts-key" },
			fetch: fakeFetch(
				200,
				{ answers: { edit: { noul: 0.5 }, kind: { choice: "other" }, size: { score: 1 } } },
				seen,
			),
		});
		expect(built.problems).toEqual([]);
		expect(built.judge.id).toBe("openrouter.ai:~typesafe/jev-latest");
		await built.judge.evaluate({ state: "s", questions });
		expect(seen.url).toBe("https://openrouter.ai/api/v1/systemone");
		expect(JSON.parse(String(seen.init?.body)).model).toBe("~typesafe/jev-latest");
		expect(new Headers(seen.init?.headers).get("authorization")).toBe("Bearer or-key");

		const keyless = new TypeSafeJudgeProvider({
			apiKey: () => undefined,
			keyName: "MU_JUDGE_OPENROUTER_API_KEY",
			baseUrl: "https://openrouter.ai/api/v1/systemone",
			fetch: fakeFetch(200, {}),
		});
		const unreachable = new TypeSafeJudgeProvider({
			apiKey: "or-key",
			baseUrl: "https://openrouter.ai/api/v1/systemone",
			fetch: (async () => {
				throw new TypeError("fetch failed");
			}) as typeof fetch,
		});
		for (const [provider, message] of [
			[keyless, "No API key is configured for Jev at openrouter.ai (MU_JUDGE_OPENROUTER_API_KEY)"],
			[unreachable, "Could not reach openrouter.ai"],
		] as const) {
			const error = await provider.evaluate({ state: "s", questions }).catch((caught: unknown) => caught);
			expect(error instanceof Error && error.message).toBe(message);
		}
	});

	it("never sends a key set up for another service to TypeSafe: such a judge needs its own address", () => {
		const relay = { type: "typesafe", apiKeyEnv: "MU_JUDGE_CUSTOM_API_KEY" };
		const without = buildJudge(parseConfig({ tiers: ["relay"], judges: { relay } }), {
			env: { MU_JUDGE_CUSTOM_API_KEY: "c" },
		});
		expect(without.problems[0]).toBe(
			'Judge "relay" needs a baseUrl: its key MU_JUDGE_CUSTOM_API_KEY is not sent to TypeSafe',
		);
		expect(without.judge.id).not.toContain("typesafe");

		const withAddress = buildJudge(
			parseConfig({
				tiers: ["relay"],
				judges: { relay: { ...relay, baseUrl: "http://10.0.0.5:8000/v1/systemone" } },
			}),
			{ env: { MU_JUDGE_CUSTOM_API_KEY: "c" } },
		);
		expect(withAddress.problems).toEqual([]);
		expect(withAddress.judge.id).toBe("10.0.0.5:8000:jev-latest");
	});

	it("asks each service for Jev by the name that service gives it, when none is set", () => {
		// The desktop writes the OpenRouter profile without a model when its field is left empty.
		const openRouter = {
			type: "typesafe",
			baseUrl: "https://openrouter.ai/api/v1/systemone",
			apiKeyEnv: "MU_JUDGE_OPENROUTER_API_KEY",
		};
		const written = parseConfig({ tiers: ["jev-openrouter"], judges: { "jev-openrouter": openRouter } });
		expect(buildJudge(written, { env: { MU_JUDGE_OPENROUTER_API_KEY: "o" } }).judge.id).toBe(
			"openrouter.ai:~typesafe/jev-latest",
		);

		// A model set on the automatic tier is TypeSafe's; the gateway takes one only in its own form.
		const typeSafeName = parseConfig({ tiers: ["jev"], judges: { jev: { type: "jev", model: "jev-latest" } } });
		expect(buildJudge(typeSafeName, { env: { TYPESAFE_API_KEY: "k" } }).judge.id).toBe("typesafe:jev-latest");
		expect(buildJudge(typeSafeName, { env: {} }).judge.id).toBe("gateway:typesafe-ai/jev");
		const gatewayName = parseConfig({ tiers: ["jev"], judges: { jev: { type: "jev", model: "typesafe-ai/jev-1" } } });
		expect(buildJudge(gatewayName, { env: {} }).judge.id).toBe("gateway:typesafe-ai/jev-1");
	});

	it("makes the jev tier TypeSafe with a TypeSafe key, OpenRouter with a key for Jev there, and the gateway otherwise", () => {
		const config = parseConfig({ tiers: ["jev"] });

		expect(buildJudge(config, { env: { TYPESAFE_API_KEY: "k", MU_JUDGE_OPENROUTER_API_KEY: "o" } }).judge.id).toBe(
			"typesafe:jev-latest",
		);
		expect(buildJudge(config, { env: { MU_JUDGE_OPENROUTER_API_KEY: "o" } }).judge.id).toBe(
			"openrouter.ai:~typesafe/jev-latest",
		);
		expect(buildJudge(config, { env: {} }).judge.id).toBe("gateway:typesafe-ai/jev");
		expect(buildJudge(parseConfig({ tiers: ["jev-gateway"] }), { env: { TYPESAFE_API_KEY: "k" } }).judge.id).toBe(
			"gateway:typesafe-ai/jev",
		);
	});
});

describe("CLM", () => {
	// Answers as `clm-serve` writes them: each carries its type, and usage counts billing units.
	const clmAnswers = {
		model: "clm-latest",
		answers: {
			edit: { type: "noul", noul: 0.71 },
			kind: { type: "choice", choice: "other", confidence: 0.6, probabilities: { chat: 0.2, other: 0.8 } },
			size: {
				type: "score",
				score: 0.4,
				confidence: 0.5,
				legend: { "0": "small", "1": "medium", "2": "large" },
				probabilities: { "0": 0.6, "1": 0.4, "2": 0 },
			},
		},
		usage: { billing_units: 3, input_tokens: 196, output_tokens: 0 },
	};

	it("reaches a CLM server on this machine, sending no key when none is set", async () => {
		const seen: { url?: string; init?: RequestInit } = {};
		const built = buildJudge(parseConfig({ tiers: ["clm"] }), { env: {}, fetch: fakeFetch(200, clmAnswers, seen) });
		expect(built.problems).toEqual([]);
		expect(built.judge.id).toBe("127.0.0.1:8700:clm-latest");

		const result = await built.judge.evaluate({ state: { user_message: "rename it" }, questions });
		expect(seen.url).toBe(`${CLM_BASE_URL}/v1/systemone`);
		expect(new Headers(seen.init?.headers).has("authorization")).toBe(false);
		expect(JSON.parse(String(seen.init?.body)).model).toBe("clm-latest");
		expect(result.answers.edit).toMatchObject({ type: "boolean", probability: 0.71 });
		expect(result.answers.kind).toMatchObject({ type: "choice", choice: "other", probabilities: { other: 0.8 } });
		expect(result.answers.size).toMatchObject({ type: "score", score: 0.4 });
		expect(result.modelId).toBe("clm-latest");
	});

	it("takes a server's address as clm-serve prints it or as CLM's own client takes it", () => {
		expect(clmEndpoint(undefined)).toBe("http://127.0.0.1:8700/v1/systemone");
		expect(clmEndpoint("")).toBe("http://127.0.0.1:8700/v1/systemone");
		for (const address of [
			"http://gpu:8700",
			"http://gpu:8700/",
			"http://gpu:8700/v1",
			"http://gpu:8700/v1/systemone/",
		]) {
			expect(clmEndpoint(address)).toBe("http://gpu:8700/v1/systemone");
		}
		// Behind a proxy that mounts it under a path of its own, the address is used as written.
		expect(clmEndpoint("https://example.com/clm/v1/systemone")).toBe("https://example.com/clm/v1/systemone");
	});

	it("sends MU_JUDGE_CLM_API_KEY when it is set, and names it when a server asks for a key", async () => {
		const seen: { init?: RequestInit } = {};
		const config = parseConfig({ tiers: ["gpu"], judges: { gpu: { type: "clm", baseUrl: "http://10.0.0.7:8700" } } });
		const keyed = buildJudge(config, {
			env: { MU_JUDGE_CLM_API_KEY: "clm-key" },
			fetch: fakeFetch(200, clmAnswers, seen),
		});
		await keyed.judge.evaluate({ state: "s", questions });
		expect(new Headers(seen.init?.headers).get("authorization")).toBe("Bearer clm-key");

		const clm = (fetchImpl: typeof fetch, apiKey?: string) =>
			new TypeSafeJudgeProvider({
				apiKey: () => apiKey,
				keyName: "MU_JUDGE_CLM_API_KEY",
				keyOptional: true,
				judgeName: "CLM",
				model: "clm-latest",
				baseUrl: clmEndpoint("http://10.0.0.7:8700"),
				fetch: fetchImpl,
			});
		const cases = [
			[
				clm(fakeFetch(401, { detail: "invalid API key" })),
				"auth",
				"CLM at 10.0.0.7:8700 asks for a key (MU_JUDGE_CLM_API_KEY)",
			],
			[clm(fakeFetch(401, { detail: "invalid API key" }), "wrong"), "auth", "invalid API key"],
			[
				clm(fakeFetch(502, { detail: "embedder unreachable at http://127.0.0.1:8090/v1/embeddings" })),
				"server",
				"embedder unreachable at http://127.0.0.1:8090/v1/embeddings",
			],
			// FastAPI's own validation errors list the request back: none of it reaches the message.
			[
				clm(fakeFetch(422, { detail: [{ msg: "field required", input: { state: "secret state" } }] })),
				"bad_request",
				"CLM at 10.0.0.7:8700 responded with HTTP 422",
			],
			[
				clm((async () => {
					throw new TypeError("fetch failed");
				}) as typeof fetch),
				"unreachable",
				"Could not reach CLM at 10.0.0.7:8700",
			],
		] as const;
		for (const [provider, kind, message] of cases) {
			const error = await provider.evaluate({ state: "secret state", questions }).catch((caught: unknown) => caught);
			expect(isJudgeError(error) && error.kind).toBe(kind);
			expect(error instanceof Error && error.message).toBe(message);
		}
	});

	it("never sends the CLM key to TypeSafe", () => {
		const judge = { type: "typesafe", apiKeyEnv: "MU_JUDGE_CLM_API_KEY" };
		const built = buildJudge(parseConfig({ tiers: ["odd"], judges: { odd: judge } }), {
			env: { MU_JUDGE_CLM_API_KEY: "c" },
		});
		expect(built.problems[0]).toBe(
			'Judge "odd" needs a baseUrl: its key MU_JUDGE_CLM_API_KEY is not sent to TypeSafe',
		);
	});
});

describe("mude", () => {
	const answers = {
		answers: { edit: { noul: 0.9 }, kind: { choice: "other", probabilities: { other: 0.95 } }, size: { score: 1 } },
	};

	it("asks mude's server on this machine with the key the install wrote, and trusts it on every capability", async () => {
		const seen: { url?: string; init?: RequestInit } = {};
		const built = buildJudge(parseConfig({ tiers: ["mude"] }), {
			env: { MU_JUDGE_MUDE_KEY: "local-key", TYPESAFE_API_KEY: "ts-key" },
			fetch: fakeFetch(200, answers, seen),
		});
		expect(built.problems).toEqual([]);
		expect(built.judge.id).toBe("127.0.0.1:8790:mude");
		const result = await built.judge.evaluate({ state: { user_message: "rename it" }, questions });
		expect(seen.url).toBe("http://127.0.0.1:8790/v1/systemone");
		expect(new Headers(seen.init?.headers).get("authorization")).toBe("Bearer local-key");
		expect(JSON.parse(String(seen.init?.body)).model).toBe("mude");
		expect(result.answers.edit).toMatchObject({ type: "boolean", probability: 0.9 });
		expect(BUILT_IN_JUDGES.mude.profile).toBeUndefined();
		expect(BUILT_IN_JUDGES.mude.timeoutMs).toBe(4000);
	});

	it("never sends mude's key to TypeSafe", () => {
		const built = buildJudge(
			parseConfig({ tiers: ["odd"], judges: { odd: { type: "typesafe", apiKeyEnv: "MU_JUDGE_MUDE_KEY" } } }),
			{
				env: { MU_JUDGE_MUDE_KEY: "local-key" },
			},
		);
		expect(built.problems[0]).toBe('Judge "odd" needs a baseUrl: its key MU_JUDGE_MUDE_KEY is not sent to TypeSafe');
	});
});
