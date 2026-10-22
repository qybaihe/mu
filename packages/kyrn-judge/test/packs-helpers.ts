import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";
import { attended } from "./attended.ts";

export const yes: Answer = { type: "boolean", probability: 0.96 };
export const no: Answer = { type: "boolean", probability: 0.03 };

/** Says yes to the disclosure question of every capability whose title holds one of the fragments, no to the rest. */
export function disclosing(...fragments: string[]): MockResponder {
	return (request) =>
		Object.fromEntries(
			Object.entries(request.questions)
				.filter(([id]) => id.startsWith("capability_"))
				.map(([id, question]) => [
					id,
					fragments.some((fragment) => String(question.instructions).includes(fragment)) ? yes : no,
				]),
		);
}

/** A session with the catalog and the packs, and nothing else that would ask the judge. */
export async function startPacks(
	harnesses: Harness[],
	options: { responder?: MockResponder; mode?: DecisionMode; packs?: Record<string, unknown> } = {},
): Promise<{ harness: Harness; provider: MockJudgeProvider }> {
	const provider = new MockJudgeProvider(options.responder ?? disclosing());
	const harness = await createHarness({
		extensionFactories: [
			createKyrnJudgeExtension({
				provider,
				mode: options.mode ?? "active",
				config: parseConfig({ features: attended({ memory: false, packs: options.packs ?? {} }) }),
				// Preflight is what counts user turns.
				only: ["preflight", "catalog", "packs"],
			}),
		],
	});
	harnesses.push(harness);
	return { harness, provider };
}

export const active = (harness: Harness): string[] => harness.session.getActiveToolNames();
export const registered = (harness: Harness): string[] => harness.session.getAllTools().map((tool) => tool.name);

export function toolResults(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => JSON.stringify(message));
}

export const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
