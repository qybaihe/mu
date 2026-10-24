import { describe, expect, it } from "vitest";
import { BUILT_IN_JUDGES, parseConfig } from "../src/config.ts";
import { isJudgeError } from "../src/errors.ts";
import { decisionsEndpoint, isOpenAIAddress, OpenAIDecisionsJudgeProvider } from "../src/providers/openai-decisions.ts";
import { buildJudge, resolveJudgeConfig } from "../src/registry.ts";
import type { Questions } from "../src/types.ts";

/** OpenAI's Decisions API without a network or a key: every request goes to a fake fetch, every key is made up. */

const questions = {
	edit: {
		type: "boolean",
		instructions: "Does `user_message` ask for a code change?",
		criteria: { true: "It asks to change code", false: "It asks a question" },
	},
	kind: { type: "choice", instructions: "What is it?", criteria: { chat: "Small talk", other: null } },
	size: { type: "score", instructions: "How big?", criteria: ["small", "medium", "large"] },
} satisfies Questions;

/** Answers as the Decisions API writes them: in question order, each named; here out of order, matched by name. */
const wireAnswers = [
	{
		type: "score",
		name: "size",
		score: 1.4,
		probabilities: [
			{ value: 0, label: "small", probability: 0.1 },
			{ value: 1, label: "medium", probability: 0.4 },
			{ value: 2, label: "large", probability: 0.5 },
		],
		confidence: 0.7,
	},
	{ type: "predicate", name: "edit", probability: 0.93 },
	{
		type: "choice",
		name: "kind",
		choice: "chat",
		probabilities: [
			{ value: "chat", probability: 0.9 },
			{ value: "other", probability: 0.1 },
		],
		confidence: 0.8,
	},
];
const wireUsage = { input_tokens: 300, input_tokens_details: { cached_tokens: 120, cache_write_tokens: 40 } };

interface Seen {
	url?: string;
	init?: RequestInit;
	calls: number;
}

function fakeFetch(status: number, body: unknown, seen: Seen = { calls: 0 }): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		seen.calls++;
		seen.url = String(url);
		seen.init = init;
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

const answered = (seen?: Seen) =>
	fakeFetch(200, { model: "gpt-6-luna-2026-10-22", answers: wireAnswers, usage: wireUsage }, seen);
const bearer = (seen: Seen) => new Headers(seen.init?.headers).get("authorization");
const sentBody = (seen: Seen) => JSON.parse(String(seen.init?.body)) as Record<string, unknown>;

async function failure(provider: OpenAIDecisionsJudgeProvider) {
	return provider.evaluate({ state: "secret state", questions }).catch((caught: unknown) => caught);
}

describe("OpenAIDecisionsJudgeProvider", () => {
	it("asks predicates, choices and scores, and reads each answer back in the kernel's shape", async () => {
		const seen: Seen = { calls: 0 };
		const provider = new OpenAIDecisionsJudgeProvider({ apiKey: "test-key", fetch: answered(seen) });
		const result = await provider.evaluate({ state: { user_message: "rename it" }, questions });

		expect(seen.url).toBe("https://api.openai.com/v1/decisions");
		expect(bearer(seen)).toBe("Bearer test-key");
		expect(sentBody(seen)).toEqual({
			model: "gpt-6-luna",
			// Structured state goes as its JSON text.
			input: '{"user_message":"rename it"}',
			questions: [
				{
					type: "predicate",
					name: "edit",
					// A predicate has no criteria field: their meanings go with the instructions.
					instructions:
						"Does `user_message` ask for a code change?\n\nTrue means: It asks to change code\nFalse means: It asks a question",
				},
				{
					type: "choice",
					name: "kind",
					instructions: "What is it?",
					// An option without a description goes without one.
					choices: [{ value: "chat", description: "Small talk" }, { value: "other" }],
				},
				{
					type: "score",
					name: "size",
					instructions: "How big?",
					levels: [{ label: "small" }, { label: "medium" }, { label: "large" }],
				},
			],
		});

		expect(result.answers).toEqual({
			edit: { type: "boolean", probability: 0.93 },
			kind: { type: "choice", choice: "chat", probabilities: { chat: 0.9, other: 0.1 }, confidence: 0.8 },
			size: { type: "score", score: 1.4, probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 }, confidence: 0.7 },
		});
		// Output tokens are not charged; cache reads and writes are counted apart.
		expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 0, cachedInputTokens: 120, cacheWriteTokens: 40 });
		expect(result.modelId).toBe("gpt-6-luna-2026-10-22");
		expect(provider.id).toBe("openai:gpt-6-luna");
	});

	it("sends text state as it is, and a yes/no question without criteria as its instructions alone", async () => {
		const seen: Seen = { calls: 0 };
		const provider = new OpenAIDecisionsJudgeProvider({
			apiKey: "k",
			fetch: fakeFetch(200, { answers: [{ type: "predicate", name: "q", probability: 0.2 }] }, seen),
		});
		const result = await provider.evaluate({
			state: "plain text",
			questions: { q: { type: "boolean", instructions: "Is it plain?" } },
		});
		expect(sentBody(seen)).toMatchObject({
			input: "plain text",
			questions: [{ type: "predicate", name: "q", instructions: "Is it plain?" }],
		});
		expect(result.answers.q).toEqual({ type: "boolean", probability: 0.2 });
		expect(result.modelId).toBe("gpt-6-luna");
	});

	it("fails a call with a refusal or a missing answer, as the kernel's other judges do", async () => {
		const answers = (replace: string, by?: Record<string, unknown>) =>
			wireAnswers.flatMap((answer) => (answer.name !== replace ? [answer] : by ? [by] : []));
		const cases = [
			[answers("kind", { type: "refusal", name: "kind" }), 'OpenAI declined to answer "kind"'],
			[answers("size"), 'OpenAI gave no usable answer for "size"'],
			[answers("edit", { type: "choice", name: "edit", choice: "yes" }), 'OpenAI gave no usable answer for "edit"'],
			[
				answers("kind", { type: "choice", name: "kind", choice: "neither", confidence: 0.9 }),
				'OpenAI gave no usable answer for "kind"',
			],
		] as const;
		for (const [body, message] of cases) {
			const provider = new OpenAIDecisionsJudgeProvider({ apiKey: "k", fetch: fakeFetch(200, { answers: body }) });
			const error = await failure(provider);
			expect(isJudgeError(error) && error.kind).toBe("invalid_response");
			expect(error instanceof Error && error.message).toBe(message);
		}
		const empty = new OpenAIDecisionsJudgeProvider({ apiKey: "k", fetch: fakeFetch(200, { usage: wireUsage }) });
		expect(await failure(empty)).toMatchObject({
			kind: "invalid_response",
			message: "OpenAI response has no answers",
		});
	});

	it("classifies HTTP failures as TypeSafe's are, without ever echoing the key or the state", async () => {
		const key = "sk-proj-made-up-openai-key-000";
		const cases = [
			[401, { error: { message: `Incorrect API key provided: ${key}.` } }, "auth", "Incorrect API key provided: …."],
			[403, { error: { message: "Your account does not have access to the Decisions API." } }, "auth", undefined],
			[
				403,
				{ error: { message: "You exceeded your current quota, check your billing details." } },
				"payment_required",
				undefined,
			],
			[429, { error: { message: "Rate limit reached for gpt-6-luna." } }, "rate_limited", undefined],
			[500, {}, "server", "OpenAI responded with HTTP 500"],
			[503, { error: { message: "The server is overloaded." } }, "server", undefined],
			[400, { error: { message: "Invalid value for 'questions'." } }, "bad_request", undefined],
		] as const;
		for (const [status, body, kind, message] of cases) {
			const provider = new OpenAIDecisionsJudgeProvider({ apiKey: key, fetch: fakeFetch(status, body) });
			const error = await failure(provider);
			expect(isJudgeError(error) && error.kind, String(status)).toBe(kind);
			expect(isJudgeError(error) && error.status).toBe(status);
			if (message) expect(error instanceof Error && error.message).toBe(message);
			expect(String(error)).not.toContain(key);
			expect(String(error)).not.toContain("secret state");
		}
		const unreachable = new OpenAIDecisionsJudgeProvider({
			apiKey: key,
			fetch: (async () => {
				throw new TypeError("fetch failed");
			}) as typeof fetch,
		});
		expect(await failure(unreachable)).toMatchObject({ kind: "unreachable", message: "Could not reach OpenAI" });
	});

	it("asks for its key before sending anything, and names the variable it reads", async () => {
		const seen: Seen = { calls: 0 };
		const provider = new OpenAIDecisionsJudgeProvider({ apiKey: () => undefined, fetch: answered(seen) });
		expect(await failure(provider)).toMatchObject({
			kind: "auth",
			message: "No API key is configured for OpenAI (MU_JUDGE_OPENAI_KEY)",
		});
		expect(seen.calls).toBe(0);
	});

	it("posts to the Decisions endpoint of any address that serves it, and names that host", async () => {
		expect(decisionsEndpoint(undefined)).toBe("https://api.openai.com/v1/decisions");
		expect(decisionsEndpoint("")).toBe("https://api.openai.com/v1/decisions");
		expect(decisionsEndpoint("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/decisions");
		expect(decisionsEndpoint("https://api.openai.com")).toBe("https://api.openai.com/v1/decisions");
		expect(decisionsEndpoint("https://proxy.example.com/openai/v1")).toBe(
			"https://proxy.example.com/openai/v1/decisions",
		);
		expect(decisionsEndpoint("http://10.0.0.5:8080/v1/decisions")).toBe("http://10.0.0.5:8080/v1/decisions");
		expect(isOpenAIAddress(undefined)).toBe(true);
		expect(isOpenAIAddress("https://api.openai.com/v1")).toBe(true);
		expect(isOpenAIAddress("http://api.openai.com/v1")).toBe(false);
		expect(isOpenAIAddress("https://api.openai.com.example.com/v1")).toBe(false);
		expect(isOpenAIAddress("https://proxy.example.com/openai/v1")).toBe(false);

		const relay = new OpenAIDecisionsJudgeProvider({
			apiKey: "k",
			baseUrl: "https://relay.example.com/v1",
			model: "gpt-6-luna",
			fetch: (async () => {
				throw new TypeError("fetch failed");
			}) as typeof fetch,
		});
		expect(relay.id).toBe("relay.example.com:gpt-6-luna");
		expect(await failure(relay)).toMatchObject({ message: "Could not reach relay.example.com" });
	});
});

describe("the openai judge", () => {
	it("is built in, and a judge of mu.json may be of its type", () => {
		expect(BUILT_IN_JUDGES.openai).toEqual({ type: "openai" });
		expect(resolveJudgeConfig("openai", parseConfig({}))).toEqual({ type: "openai" });
		const luna = {
			type: "openai",
			model: "gpt-6-luna",
			baseUrl: "https://proxy.example.com/v1",
			apiKeyEnv: "MU_JUDGE_PROXY_KEY",
			timeoutMs: 5000,
		};
		const config = parseConfig({ tiers: ["luna", "jev"], judges: { luna } });
		expect(config.judges.luna).toEqual(luna);
		expect(config.tiers).toEqual(["luna", "jev"]);
		expect(buildJudge(config, { env: { MU_JUDGE_PROXY_KEY: "p" } }).problems).toEqual([]);
	});

	it("sends its own key, MU_JUDGE_OPENAI_KEY, before the key of mu's openai provider", async () => {
		const seen: Seen = { calls: 0 };
		const built = buildJudge(parseConfig({ tiers: ["openai"] }), {
			env: { MU_JUDGE_OPENAI_KEY: "judge-key", OPENAI_API_KEY: "provider-key" },
			openaiApiKey: () => "stored-key",
			fetch: answered(seen),
		});
		expect(built.problems).toEqual([]);
		expect(built.judge.id).toBe("openai:gpt-6-luna");
		const result = await built.judge.evaluate({ state: "s", questions });
		expect(bearer(seen)).toBe("Bearer judge-key");
		// The cache counts reach the result through the judge and the cascade.
		expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 0, cachedInputTokens: 120, cacheWriteTokens: 40 });
	});

	it("at OpenAI's own address, falls back to the openai provider's key: the host's, else OPENAI_API_KEY", async () => {
		const stored: Seen = { calls: 0 };
		await buildJudge(parseConfig({ tiers: ["openai"] }), {
			env: { OPENAI_API_KEY: "provider-key" },
			openaiApiKey: () => "stored-key",
			fetch: answered(stored),
		}).judge.evaluate({ state: "s", questions });
		expect(bearer(stored)).toBe("Bearer stored-key");

		const fromEnv: Seen = { calls: 0 };
		await buildJudge(parseConfig({ tiers: ["openai"] }), {
			env: { OPENAI_API_KEY: "provider-key" },
			fetch: answered(fromEnv),
		}).judge.evaluate({ state: "s", questions });
		expect(bearer(fromEnv)).toBe("Bearer provider-key");

		// The host says there is none (a Sign in with ChatGPT, a provider moved elsewhere): OPENAI_API_KEY is not tried.
		const none: Seen = { calls: 0 };
		const error = await buildJudge(parseConfig({ tiers: ["openai"] }), {
			env: { OPENAI_API_KEY: "provider-key" },
			openaiApiKey: () => undefined,
			fetch: answered(none),
		})
			.judge.evaluate({ state: "s", questions })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({
			kind: "auth",
			message:
				"No API key is configured for OpenAI (MU_JUDGE_OPENAI_KEY, or OpenAI's key from mu setup or OPENAI_API_KEY)",
		});
		expect(none.calls).toBe(0);
	});

	it("never sends the openai provider's key to another address: a relay or proxy gets its own key only", async () => {
		const relay = { type: "openai", baseUrl: "https://relay.example.com/v1" };
		const config = parseConfig({ tiers: ["relay"], judges: { relay } });
		const unkeyed: Seen = { calls: 0 };
		const error = await buildJudge(config, {
			env: { OPENAI_API_KEY: "provider-key" },
			openaiApiKey: () => "stored-key",
			fetch: answered(unkeyed),
		})
			.judge.evaluate({ state: "s", questions })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({
			kind: "auth",
			message: "No API key is configured for relay.example.com (MU_JUDGE_OPENAI_KEY)",
		});
		expect(unkeyed.calls).toBe(0);

		const keyed: Seen = { calls: 0 };
		const built = buildJudge(config, {
			env: { MU_JUDGE_OPENAI_KEY: "judge-key", OPENAI_API_KEY: "provider-key" },
			fetch: answered(keyed),
		});
		expect(built.judge.id).toBe("relay.example.com:gpt-6-luna");
		await built.judge.evaluate({ state: "s", questions });
		expect(keyed.url).toBe("https://relay.example.com/v1/decisions");
		expect(bearer(keyed)).toBe("Bearer judge-key");

		// Named outright, OPENAI_API_KEY still goes to OpenAI alone.
		const named = parseConfig({ tiers: ["relay"], judges: { relay: { ...relay, apiKeyEnv: "OPENAI_API_KEY" } } });
		expect(buildJudge(named, { env: { OPENAI_API_KEY: "provider-key" } }).problems[0]).toBe(
			'Judge "relay": OPENAI_API_KEY is only sent to api.openai.com, not to its baseUrl',
		);
	});

	it("never sends another judge service's key to OpenAI, nor its own key to TypeSafe", () => {
		for (const keyName of [
			"TYPESAFE_API_KEY",
			"AI_GATEWAY_API_KEY",
			"MU_JUDGE_OPENROUTER_API_KEY",
			"MU_JUDGE_MUDE_KEY",
		]) {
			const config = parseConfig({ tiers: ["odd"], judges: { odd: { type: "openai", apiKeyEnv: keyName } } });
			const built = buildJudge(config, { env: { [keyName]: "other-key" } });
			expect(built.problems[0]).toBe(
				`Judge "odd": its key ${keyName} belongs to another service and is not sent to OpenAI`,
			);
		}
		for (const keyName of ["MU_JUDGE_OPENAI_KEY", "OPENAI_API_KEY"]) {
			const config = parseConfig({ tiers: ["odd"], judges: { odd: { type: "typesafe", apiKeyEnv: keyName } } });
			expect(buildJudge(config, { env: { [keyName]: "openai-key" } }).problems[0]).toBe(
				`Judge "odd" needs a baseUrl: its key ${keyName} is not sent to TypeSafe`,
			);
		}
	});
});
