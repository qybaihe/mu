import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Api, Model, ThinkingLevel } from "../src/types.ts";

const originalNebiusApiKey = process.env.NEBIUS_API_KEY;

afterEach(() => {
	if (originalNebiusApiKey === undefined) {
		delete process.env.NEBIUS_API_KEY;
	} else {
		process.env.NEBIUS_API_KEY = originalNebiusApiKey;
	}
});

async function capturePayload(model: Model<Api>, reasoning?: ThinkingLevel): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	await streamSimple(
		model,
		{ systemPrompt: "sys", messages: [{ role: "user", content: "test", timestamp: 0 }] },
		{
			apiKey: "test-nebius-key",
			reasoning,
			onPayload: (value) => {
				payload = value as Record<string, unknown>;
				throw new Error("payload captured");
			},
		},
	).result();
	if (!payload) throw new Error("no payload");
	return payload;
}

describe("Nebius Token Factory models", () => {
	it("sends Nemotron 3.5 reasoning through reasoning_effort none/high", async () => {
		const model = getModel("nebius", "nvidia/Nemotron-3.5-Super-VL");
		expect(model.baseUrl).toBe("https://api.tokenfactory.nebius.com/v1");
		expect(model.compat).toMatchObject({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "high"]);

		const on = await capturePayload(model, "high");
		expect(on.reasoning_effort).toBe("high");
		expect(on.store).toBeUndefined();
		expect(on.max_tokens).toBeTypeOf("number");
		expect(on.max_completion_tokens).toBeUndefined();
		expect((on.messages as { role: string }[])[0].role).toBe("system");

		const off = await capturePayload(model);
		expect(off.reasoning_effort).toBe("none");
	});

	it("sends no reasoning parameter to models without models.dev effort values", async () => {
		const model = getModel("nebius", "nvidia/nemotron-3-super-120b-a12b");
		expect(model.reasoning).toBe(true);
		expect(model.compat?.supportsReasoningEffort).toBe(false);

		const payload = await capturePayload(model, "high");
		expect(payload.reasoning_effort).toBeUndefined();
	});

	it("resolves NEBIUS_API_KEY from the environment", () => {
		process.env.NEBIUS_API_KEY = "test-nebius-key";

		expect(findEnvKeys("nebius")).toEqual(["NEBIUS_API_KEY"]);
		expect(getEnvApiKey("nebius")).toBe("test-nebius-key");
	});
});
