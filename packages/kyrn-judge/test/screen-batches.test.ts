import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { toolAdmission } from "../src/decisions/tool-admission.ts";
import { toolInjection } from "../src/decisions/tool-injection.ts";
import { KyrnRuntime } from "../src/extension/runtime.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

/** Just enough of pi to build a runtime. */
const pi = { on: () => {}, appendEntry: () => {}, getCommands: () => [] } as unknown as ExtensionAPI;
const runtime = (config: Record<string, unknown>) =>
	new KyrnRuntime(pi, parseConfig(config), new Judge({ provider: new MockJudgeProvider() }));
const lightning = { type: "logprob", baseUrl: "https://judge.example/v1", model: "nvidia/Nemotron-3_5-Lightning" };

describe("screening tool output in batches", () => {
	it("asks a logprob judge one chunk or passage at a time, and other judges many at once", () => {
		expect(runtime({ tiers: ["nemotron-local"] }).answersInBatches(toolAdmission.id, "screen")).toBe(true);
		expect(runtime({ tiers: ["jev"] }).answersInBatches(toolInjection.id, "screen")).toBe(true);
		const logprob = runtime({ tiers: ["lightning"], judges: { lightning } });
		expect(logprob.answersInBatches(toolAdmission.id, "screen")).toBe(false);
		expect(logprob.answersInBatches(toolInjection.id, "screen")).toBe(false);
	});

	it("goes by the judge that answers the decision: its route, and the first judge trusted to screen", () => {
		const routed = runtime({ tiers: ["jev"], judges: { lightning }, routes: { [toolAdmission.id]: ["lightning"] } });
		expect(routed.answersInBatches(toolAdmission.id, "screen")).toBe(false);
		expect(routed.answersInBatches(toolInjection.id, "screen")).toBe(true);
		// The cascade passes over a judge not trusted to screen: Jev answers, in batches.
		const untrusted = runtime({
			tiers: ["lightning", "jev"],
			judges: { lightning: { ...lightning, profile: { capabilities: { screen: false } } } },
		});
		expect(untrusted.answersInBatches(toolAdmission.id, "screen")).toBe(true);
	});
});
