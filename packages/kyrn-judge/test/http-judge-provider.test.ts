import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { DecisionEngine, defineDecision } from "../src/decision.ts";
import { isJudgeError } from "../src/errors.ts";
import { Judge } from "../src/judge.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { threeZone } from "../src/policy.ts";
import { HttpJudgeProvider } from "../src/providers/http-judge.ts";
import { buildJudge } from "../src/registry.ts";
import type { Questions } from "../src/types.ts";

const questions = {
	refund: { type: "boolean", instructions: "Does the customer request a refund?" },
} satisfies Questions;

interface CapturedRequest {
	url: string;
	init: RequestInit;
}

function fakeFetch(status: number, body: unknown, captured: CapturedRequest[] = []): typeof fetch {
	return async (input, init) => {
		captured.push({ url: String(input), init: init ?? {} });
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	};
}

const BASE = "http://judge.internal:8000";

const serverBody = {
	answers: { refund: { type: "boolean", probability: 0.9877 } },
	usage: { inputTokens: 47, outputTokens: 0 },
	warnings: [
		{ type: "state_truncated", questionId: "refund", message: "state has 2000 tokens, only the first 990 were read" },
		{ message: "a warning without a type is dropped" },
	],
};

describe("HttpJudgeProvider", () => {
	it("posts the gateway-shaped request to the server, without credentials unless given", async () => {
		const captured: CapturedRequest[] = [];
		const provider = new HttpJudgeProvider({ baseUrl: BASE, fetch: fakeFetch(200, serverBody, captured) });

		await provider.evaluate({ state: { message: "charged twice" }, questions });

		expect(captured[0].url).toBe(`${BASE}/evaluate`);
		expect(captured[0].init.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(String(captured[0].init.body))).toEqual({ state: { message: "charged twice" }, questions });
	});

	it("keeps the answers and the well-formed warnings", async () => {
		const provider = new HttpJudgeProvider({ baseUrl: `${BASE}/`, fetch: fakeFetch(200, serverBody) });

		const response = await provider.evaluate({ state: "charged twice", questions });

		expect(provider.id).toBe(`http:${BASE}`);
		expect(response.answers.refund).toEqual({ type: "boolean", probability: 0.9877 });
		expect(response.usage).toEqual({ inputTokens: 47, outputTokens: 0 });
		expect(response.warnings).toEqual([
			{
				type: "state_truncated",
				questionId: "refund",
				message: "state has 2000 tokens, only the first 990 were read",
			},
		]);
	});

	it("says where the server it could not reach is", async () => {
		const provider = new HttpJudgeProvider({
			baseUrl: BASE,
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});

		const error = await provider.evaluate({ state: "x", questions }).catch((caught: unknown) => caught);

		expect(isJudgeError(error) && error.kind).toBe("unreachable");
		expect((error as Error).message).toBe(`Judge server is not reachable at ${BASE}`);
	});

	it("maps a rejected request and a server crash to different error kinds", async () => {
		const rejected = new HttpJudgeProvider({
			baseUrl: BASE,
			fetch: fakeFetch(400, { error: { message: "Question has too many options for the token budget" } }),
		});
		const crashed = new HttpJudgeProvider({
			baseUrl: BASE,
			fetch: fakeFetch(500, { error: { message: "Judge failed" } }),
		});

		const badRequest = await rejected.evaluate({ state: "x", questions }).catch((caught: unknown) => caught);
		const server = await crashed.evaluate({ state: "x", questions }).catch((caught: unknown) => caught);

		expect(isJudgeError(badRequest) && badRequest.kind).toBe("bad_request");
		expect((badRequest as Error).message).toContain("too many options");
		expect(isJudgeError(server) && server.kind).toBe("server");
	});

	it("records truncation warnings and which judge answered in the ledger", async () => {
		const ledger = new MemoryLedger();
		const engine = new DecisionEngine({
			judge: new Judge({
				provider: new HttpJudgeProvider({ id: "http:mine", baseUrl: BASE, fetch: fakeFetch(200, serverBody) }),
			}),
			ledger,
			defaultMode: "active",
		});
		const spec = defineDecision({
			id: "test.refund",
			version: 1,
			questions,
			cacheImpact: "none",
			latency: "inline",
			buildState: (message: string) => ({ message }),
			policy: (answers) => threeZone(answers.refund),
			fallback: () => "unsure" as const,
		});

		const decision = await engine.decide(spec, "charged twice");

		expect(decision.outcome).toBe("yes");
		expect(decision.warnings).toHaveLength(1);
		expect(ledger.records[0]).toMatchObject({
			providerId: "http:mine",
			warnings: [{ type: "state_truncated", questionId: "refund" }],
		});
	});
});

describe("an http judge in mu.json", () => {
	it("needs the address of its server, and sends its token from the variable it names", async () => {
		const captured: CapturedRequest[] = [];
		const config = parseConfig({
			tiers: ["mine", "nowhere"],
			judges: {
				mine: { type: "http", baseUrl: BASE, path: "/judge", apiKeyEnv: "MINE_TOKEN" },
				nowhere: { type: "http" },
			},
		});
		const built = buildJudge(config, {
			env: { MINE_TOKEN: "fixture-token" },
			fetch: fakeFetch(200, serverBody, captured),
		});

		expect(built.problems).toEqual(['Judge "nowhere" needs a baseUrl (the address of its server)']);
		await built.judge.evaluate({ state: "x", questions });
		expect(captured[0].url).toBe(`${BASE}/judge`);
		expect(captured[0].init.headers).toEqual({
			Authorization: "Bearer fixture-token",
			"Content-Type": "application/json",
		});
	});

	it("says that Laya is no longer built in, where /mu judge or a route still names it", () => {
		// mu.json is read without it (config.ts); `/mu judge laya` during a session is not.
		expect(parseConfig({ tiers: ["laya", "mock"] }).tiers).toEqual(["mock"]);
		expect(buildJudge({ ...DEFAULT_CONFIG, tiers: ["laya", "mock"] }).problems).toEqual([
			'"laya" is no longer built into mu: add a decision model from Hugging Face with mu judge model add <link>',
		]);
	});
});
