import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { NudgeFollowed } from "../src/extension/features/nudge-outcome.ts";
import { OUTCOME_ENTRY } from "../src/extension/features/permissions.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { LEDGER_ENTRY_TYPE } from "../src/extension/runtime.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.95 };
const no: Answer = { type: "boolean", probability: 0.03 };

/** Says a closing message that announces the tests promised them, and nothing else. */
const promises = new MockJudgeProvider((request: JudgeRequest): Record<string, Answer> => {
	if (!("promised" in request.questions)) return {};
	const text = (request.state as { final_message?: string }).final_message ?? "";
	return {
		promised: /Let me run the tests next/.test(text) ? yes : no,
		asks_go_ahead: no,
		work_requested: no,
		beyond_request: no,
		irreversible: no,
	};
});

const bash: AgentTool = {
	name: "bash",
	label: "bash",
	description: "bash",
	parameters: Type.Object({}, { additionalProperties: true }),
	execute: async () => ({ content: [{ type: "text", text: "212 passed" }], details: {} }),
};

describe("what the agent did with a nudge", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function run(
		answer: ReturnType<typeof fauxAssistantMessage>[],
		first = "I found the bug. Let me run the tests next.",
	) {
		const harness = await createHarness({
			tools: [bash],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: promises,
					mode: "active",
					config: parseConfig({ features: { memory: false, permissions: { mode: "full" } } }),
					only: ["continuation"],
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(first), ...answer, fauxAssistantMessage("unused")]);
		await harness.session.prompt("Fix the flaky login test.");
		const entries = harness.sessionManager.getEntries();
		const of = <T>(type: string) =>
			entries
				.filter((entry) => entry.type === "custom" && entry.customType === type)
				.map((entry) => (entry as { data: T }).data);
		return { outcomes: of<NudgeFollowed>(OUTCOME_ENTRY), records: of<LedgerRecord>(LEDGER_ENTRY_TYPE) };
	}

	it("records that the run answering the nudge acted, on the verdict that sent it", async () => {
		const { outcomes, records } = await run([
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm test" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Ran them: all 212 pass."),
		]);
		const nudged = records.find((record) => record.specId === "turn.continue" && record.outcome === "promised");
		expect(nudged).toBeDefined();
		expect(outcomes).toEqual([
			{
				kind: "followed",
				ledgerId: nudged?.id,
				specId: "turn.continue",
				judged: "promised",
				followed: "acted",
				calls: 1,
			},
		]);
	});

	it("records that it ended again without a tool call", async () => {
		const { outcomes } = await run([fauxAssistantMessage("The work is already complete.")]);
		expect(outcomes).toEqual([expect.objectContaining({ kind: "followed", followed: "ended", calls: 0 })]);
	});

	it("records nothing when no verdict sent the agent back", async () => {
		const { outcomes } = await run([], "Fixed it: all 212 tests pass.");
		expect(outcomes).toEqual([]);
	});
});
