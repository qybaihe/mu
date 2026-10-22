import { describe, expect, it } from "vitest";
import { BUILT_IN_JUDGES, parseConfig } from "../src/config.ts";
import { buildJudge } from "../src/registry.ts";
import type { Questions } from "../src/types.ts";

const questions = {
	risky: { type: "boolean", instructions: "Does the command delete files outside the project?" },
	kind: { type: "choice", instructions: "What kind of command is it?", criteria: { read: "Reads", build: "Builds" } },
} satisfies Questions;

describe("built-in Nemotron judges", () => {
	it("asks Nemotron 3 Ultra on Token Factory through the LLM judge prompt, thinking off", async () => {
		expect(BUILT_IN_JUDGES.nemotron).toEqual({
			type: "llm",
			model: "nebius/nvidia/Nemotron-3-Ultra-550b-a55b",
			thinking: "off",
		});
		const asked: { model: string; thinking?: string }[] = [];
		const { judge, problems } = buildJudge(parseConfig({ tiers: ["nemotron"] }), {
			llm: (model, options) => {
				asked.push({ model, thinking: options?.thinking });
				return async () => ({ text: '{"answers": {"risky": {"p": 0.02}, "kind": {"choice": "build", "p": 0.9}}}' });
			},
		});
		expect(problems).toEqual([]);
		const result = await judge.evaluate({ state: { command: "rm -rf build && npm run build" }, questions });
		expect(asked).toEqual([{ model: "nebius/nvidia/Nemotron-3-Ultra-550b-a55b", thinking: "off" }]);
		expect(result.answers.risky).toMatchObject({ type: "boolean", probability: 0.02 });
		expect(result.answers.kind).toMatchObject({ type: "choice", choice: "build" });
	});

	it("asks Ultra with thinking on as nemotron-think, with time for it", async () => {
		expect(BUILT_IN_JUDGES["nemotron-think"]).toMatchObject({ type: "llm", thinking: "high", timeoutMs: 60_000 });
		const asked: (string | undefined)[] = [];
		const { problems } = buildJudge(parseConfig({ tiers: ["nemotron-think"] }), {
			llm: (_model, options) => {
				asked.push(options?.thinking);
				return async () => ({ text: "{}" });
			},
		});
		expect(problems).toEqual([]);
		expect(asked).toEqual(["high"]);
	});

	it("reaches the distilled Nemotron on this machine over System One, without a key", async () => {
		const captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			captured.push({
				url: String(input),
				body: JSON.parse(String(init?.body)),
				headers: (init?.headers ?? {}) as Record<string, string>,
			});
			const answers = { risky: { noul: 0.03 }, kind: { choice: "build", probabilities: { read: 0.1, build: 0.9 } } };
			return new Response(JSON.stringify({ model: "mu-judge-nemotron", answers }), { status: 200 });
		};
		const { judge, problems } = buildJudge(parseConfig({ tiers: ["nemotron-local"] }), { env: {}, fetch });
		expect(problems).toEqual([]);
		const result = await judge.evaluate({ state: { command: "npm run build" }, questions });
		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe("http://127.0.0.1:8770/v1/systemone");
		expect(captured[0].body).toMatchObject({ model: "mu-judge-nemotron", questions: { risky: { type: "noul" } } });
		expect(captured[0].headers.Authorization).toBeUndefined();
		expect(result.answers.risky).toMatchObject({ type: "boolean", probability: 0.03 });
		expect(result.answers.kind).toMatchObject({ type: "choice", choice: "build" });
	});

	it("sends a System One judge's key when its variable is set, and reports one without an address", () => {
		const config = parseConfig({
			tiers: ["box", "broken"],
			judges: {
				box: { type: "systemone", baseUrl: "http://gpu-box:8770/v1/systemone", model: "m", apiKeyEnv: "BOX_KEY" },
				broken: { type: "systemone", model: "m" },
			},
		});
		const { judge, problems } = buildJudge(config, { env: { BOX_KEY: "secret" } });
		expect(judge.id).toContain("gpu-box:8770:m");
		expect(problems).toEqual(['Judge "broken" needs a baseUrl']);
	});
});
