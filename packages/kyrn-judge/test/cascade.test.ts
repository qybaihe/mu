import { describe, expect, it, vi } from "vitest";
import { CascadeJudge, isUncertain } from "../src/cascade.ts";
import { loadConfig, parseConfig } from "../src/config.ts";
import { DecisionEngine, defineDecision } from "../src/decision.ts";
import { JudgeError } from "../src/errors.ts";
import { Judge } from "../src/judge.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { threeZone } from "../src/policy.ts";
import { LlmJudgeProvider } from "../src/providers/llm.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { buildJudge } from "../src/registry.ts";
import type { Answer, JudgeProvider, Questions } from "../src/types.ts";

const questions = {
	edit: { type: "boolean", instructions: "Does `user_message` request a code change?" },
	vague: { type: "boolean", instructions: "Is `user_message` too vague to act on?" },
	size: { type: "score", instructions: "What is the scope?", criteria: ["a question", "one place", "many places"] },
} satisfies Questions;

function named(id: string, answers: Record<string, Answer>): MockJudgeProvider {
	return new MockJudgeProvider(() => answers, id);
}

const failing: JudgeProvider = {
	id: "down",
	evaluate: async () => {
		throw new JudgeError("unreachable", "sidecar is not running");
	},
};

describe("CascadeJudge", () => {
	it("asks the next tier only what the first one left uncertain or is not trusted on", async () => {
		const local = named("laya", {
			edit: { type: "boolean", probability: 0.95 },
			vague: { type: "boolean", probability: 0.5 },
			size: { type: "score", score: 1.5 },
		});
		const strong = named("jev", {
			vague: { type: "boolean", probability: 0.03 },
			size: { type: "score", score: 0.2 },
		});
		const cascade = new CascadeJudge([
			{ judge: new Judge({ provider: local }), profile: { capabilities: { rate: false } } },
			{ judge: new Judge({ provider: strong }) },
		]);

		const result = await cascade.evaluate({ state: { user_message: "rename cnt" }, questions });

		// The score never reached the local judge: it is not trusted to rate.
		expect(Object.keys(local.calls[0].questions)).toEqual(["edit", "vague"]);
		expect(Object.keys(strong.calls[0].questions).sort()).toEqual(["size", "vague"]);
		expect(result.answers.edit).toMatchObject({ probability: 0.95, judge: "laya" });
		expect(result.answers.vague).toMatchObject({ probability: 0.03, judge: "jev" });
		expect(result.answers.size).toMatchObject({ score: 0.2, judge: "jev" });
		expect(result.tiers).toMatchObject([
			{ judgeId: "laya", asked: 2, kept: 1 },
			{ judgeId: "jev", asked: 2, kept: 2 },
		]);
		expect(result.providerId).toBe("cascade(laya>jev)");
	});

	it("keeps an uncertain answer when the stronger tier is down", async () => {
		const local = named("laya", {
			edit: { type: "boolean", probability: 0.95 },
			vague: { type: "boolean", probability: 0.5 },
			size: { type: "score", score: 1.5 },
		});
		const cascade = new CascadeJudge([
			{ judge: new Judge({ provider: local }) },
			{ judge: new Judge({ provider: failing }) },
		]);

		const result = await cascade.evaluate({ state: "x", questions });

		expect(result.answers.vague).toMatchObject({ probability: 0.5, judge: "laya" });
		expect(result.tiers?.[1]).toMatchObject({ judgeId: "down", error: "unreachable" });
	});

	it("skips a dead first tier and fails only when nobody answers", async () => {
		const strong = named("jev", {
			edit: { type: "boolean", probability: 0.9 },
			vague: { type: "boolean", probability: 0.1 },
			size: { type: "score", score: 2 },
		});
		const recovered = new CascadeJudge([
			{ judge: new Judge({ provider: failing }) },
			{ judge: new Judge({ provider: strong }) },
		]);
		const dead = new CascadeJudge([{ judge: new Judge({ provider: failing }) }]);

		expect((await recovered.evaluate({ state: "x", questions })).answers.edit.judge).toBe("jev");
		await expect(dead.evaluate({ state: "x", questions })).rejects.toMatchObject({ kind: "unreachable" });
	});

	// Found with the QA fixes, 2026-09-25: laya then a keyless Jev would say "no judge yet", Jev then laya "the judge
	// did not answer": what failed last decided. A judge that may answer next time is what the next call can expect.
	it("when every tier fails, reports the failure that may pass over one that lasts, in either order", async () => {
		const tier = (id: string, error: JudgeError) => ({
			judge: new Judge({
				provider: {
					id,
					evaluate: async () => {
						throw error;
					},
				},
			}),
		});
		const noKey = tier("jev", new JudgeError("auth", "No API key is configured for Jev"));
		const noCredit = tier("gateway", new JudgeError("payment_required", "The gateway answered 402"));
		const down = tier("laya", new JudgeError("unreachable", "sidecar is not running"));
		for (const tiers of [
			[noKey, down],
			[down, noKey],
			[down, noCredit, noKey],
		]) {
			await expect(new CascadeJudge(tiers).evaluate({ state: "x", questions })).rejects.toMatchObject({
				kind: "unreachable",
			});
		}
		// Only lasting failures: the last one, as before.
		await expect(new CascadeJudge([noKey, noCredit]).evaluate({ state: "x", questions })).rejects.toMatchObject({
			kind: "payment_required",
		});
		// No judge that could be built at all fails as a judge without a key does.
		const none = buildJudge(parseConfig({ tiers: ["no-such-judge"] }));
		await expect(none.judge.evaluate({ state: "x", questions })).rejects.toMatchObject({ kind: "auth" });
	});

	it("answers neutrally when no tier is trusted with a question, instead of guessing", async () => {
		const local = named("laya", { edit: { type: "boolean", probability: 0.95 } });
		const cascade = new CascadeJudge([
			{ judge: new Judge({ provider: local }), profile: { capabilities: { relate: false, rate: false } } },
		]);

		const result = await cascade.evaluate({
			state: "x",
			questions,
			capabilities: { vague: "relate" },
		});

		expect(Object.keys(local.calls[0].questions)).toEqual(["edit"]);
		expect(result.answers.vague).toMatchObject({ probability: 0.5, judge: "untrusted" });
		expect(result.answers.size).toMatchObject({ score: 1, judge: "untrusted" });
	});

	it("treats a confident 'other' as settled and a weak pick as uncertain", () => {
		const choice = { type: "choice", instructions: "Kind?", criteria: { edit: null, other: null } } as const;
		expect(isUncertain(choice, { type: "choice", choice: "other", probabilities: { other: 0.9, edit: 0.1 } })).toBe(
			false,
		);
		expect(isUncertain(choice, { type: "choice", choice: "edit", probabilities: { edit: 0.55, other: 0.45 } })).toBe(
			true,
		);
	});
});

describe("LlmJudgeProvider", () => {
	it("turns a JSON reply wrapped in prose into typed answers", async () => {
		let prompt = "";
		const provider = new LlmJudgeProvider({
			id: "llm:test/model",
			complete: async (request) => {
				prompt = request.user;
				return {
					text: 'Sure:\n```json\n{"answers": {"edit": {"p": 0.97}, "vague": {"p": -0.2}, "size": {"score": 7}}}\n```',
					inputTokens: 210,
					outputTokens: 30,
				};
			},
		});

		const response = await provider.evaluate({ state: { user_message: "把超时改成 60 秒" }, questions });

		expect(prompt).toContain("把超时改成 60 秒");
		expect(response.answers.edit).toEqual({ type: "boolean", probability: 0.97 });
		expect(response.answers.vague).toEqual({ type: "boolean", probability: 0 });
		expect(response.answers.size).toEqual({ type: "score", score: 2 });
		expect(response.usage).toEqual({ inputTokens: 210, outputTokens: 30 });
	});

	it("spreads the rest of a choice's probability over the other options", async () => {
		const kind = {
			kind: { type: "choice", instructions: "Kind?", criteria: { edit: null, chat: null, other: null } },
		} satisfies Questions;
		const provider = new LlmJudgeProvider({
			id: "llm:test/model",
			complete: async () => ({ text: '{"answers":{"kind":{"choice":"chat","p":0.8}}}' }),
		});

		const { answers } = await provider.evaluate({ state: "hi", questions: kind });

		expect(answers.kind).toMatchObject({ type: "choice", choice: "chat" });
		const probabilities = (answers.kind as { probabilities: Record<string, number> }).probabilities;
		expect(probabilities.chat).toBeCloseTo(0.8);
		expect(probabilities.edit).toBeCloseTo(0.1);
	});

	it("rejects a reply that skips a question or invents an option", async () => {
		const provider = new LlmJudgeProvider({
			id: "llm:test/model",
			complete: async () => ({ text: '{"answers":{"edit":{"p":0.9}}}' }),
		});
		await expect(provider.evaluate({ state: "x", questions })).rejects.toMatchObject({ kind: "invalid_response" });
	});
});

describe("judge configuration", () => {
	it("uses the configured credential variable for both direct Jev and gateway", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ answers: {} }), { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		try {
			for (const type of ["jev", "gateway"] as const) {
				const config = parseConfig({
					tiers: ["custom"],
					judges: { custom: { type, apiKeyEnv: "KYRN_JUDGE_CUSTOM" } },
				});
				const built = buildJudge(config, { env: { KYRN_JUDGE_CUSTOM: "fixture" } });
				await built.judge.evaluate({ state: "fixture", questions: { q: questions.edit } }).catch(() => {});
				const [url, options] = fetch.mock.lastCall as unknown as [string, RequestInit];
				expect(new Headers(options.headers).get("authorization")).toBe("Bearer fixture");
				expect(url).toContain(type === "jev" ? "api.typesafe.ai" : "ai-gateway.vercel.sh");
			}
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("preserves direct Jev configuration instead of silently discarding desktop settings", () => {
		const config = parseConfig({
			judges: {
				jev: { type: "jev", model: "jev-fixture", timeoutMs: 15000 },
				direct: { type: "typesafe", model: "jev-fixture" },
			},
		});
		expect(config.judges.jev).toMatchObject({ type: "jev", model: "jev-fixture", timeoutMs: 15000 });
		expect(buildJudge({ ...config, tiers: ["direct"] }).judge.id).toBe("typesafe:jev-fixture");
	});
	it("builds the tiers named in the config and reports the ones it cannot", () => {
		const config = parseConfig({
			tiers: ["mock", "luna", "nope"],
			judges: { luna: { type: "llm", model: "openai-codex/gpt-5.6-luna" } },
		});

		const withoutHost = buildJudge(config);
		const withHost = buildJudge(config, { llm: () => async () => ({ text: "{}" }) });

		expect(withoutHost.judge.id).toBe("mock");
		expect(withoutHost.problems).toHaveLength(2);
		expect(withHost.judge.id).toBe("cascade(mock>llm:openai-codex/gpt-5.6-luna)");
		expect(withHost.problems).toEqual(['unknown judge "nope"']);
	});

	it("lets the environment pick the tiers, the default mode, or switch the kernel off", () => {
		const picked = loadConfig({ env: { KYRN_JUDGE: "laya, gateway", KYRN_JUDGE_MODE: "active" } });
		expect(picked.config.tiers).toEqual(["laya", "jev"]);
		expect(picked.config.modes.default).toBe("active");
		expect(loadConfig({ env: { KYRN_JUDGE: "off" } }).disabled).toBe(true);
		expect(loadConfig({ env: {} }).config.tiers).toEqual(["jev"]);
	});

	it("ignores malformed parts of mu.json instead of failing", () => {
		const config = parseConfig({
			tiers: "laya",
			modes: { default: "loud", "tool.admission": "active" },
			judges: [1],
		});
		expect(config.tiers).toEqual(["jev"]);
		expect(config.modes).toEqual({ default: "active", "tool.admission": "active" });
		expect(config.judges).toEqual({});
	});
});

describe("DecisionEngine.decideMany", () => {
	const chunkRelevant = defineDecision({
		id: "test.chunk",
		version: 1,
		questions: { relevant: { type: "boolean", instructions: "Does `chunk` matter for `intent`?" } },
		cacheImpact: "none",
		latency: "inline",
		buildState: (chunk: string) => ({ intent: "find the failing test", chunk }),
		policy: (answers) => threeZone(answers.relevant),
		fallback: () => "unsure" as const,
	});

	it("judges every input, keeps their order, and writes one ledger record", async () => {
		const ledger = new MemoryLedger();
		const provider = new MockJudgeProvider((request) => ({
			relevant: {
				type: "boolean",
				probability: String((request.state as { chunk: string }).chunk).includes("FAIL") ? 0.96 : 0.03,
			},
		}));
		const engine = new DecisionEngine({ judge: new Judge({ provider }), ledger, defaultMode: "active" });

		const decisions = await engine.decideMany(chunkRelevant, ["npm warn deprecated", "FAIL login.test.ts", "done"]);

		expect(decisions.map((decision) => decision.outcome)).toEqual(["no", "yes", "no"]);
		expect(ledger.records).toHaveLength(1);
		expect(ledger.records[0]).toMatchObject({ specId: "test.chunk", batch: { size: 3, failures: 0 } });
		expect(ledger.records[0].outcome).toEqual(["no", "yes", "no"]);
	});

	it("falls back item by item when the judge is down", async () => {
		const engine = new DecisionEngine({ judge: new Judge({ provider: failing }), defaultMode: "active" });
		const decisions = await engine.decideMany(chunkRelevant, ["a", "b"]);
		expect(decisions.map((decision) => decision.outcome)).toEqual(["unsure", "unsure"]);
		expect(decisions[0].reason).toBe("error:unreachable");
	});
});
