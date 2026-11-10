import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The suggestions each feature keeps waiting are read in that feature's own tests (evolve, feature-offers, procedures).
describe("/waiting: one list of what waits for the user", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** A session in Ask first mode whose user answers no question: each closes when its time is up. */
	async function start() {
		const bash: AgentTool = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const harness = await createHarness({
			tools: [bash],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({
						features: { memory: false, permissions: { mode: "ask", waitMs: 40 }, askUser: { waitMs: 40 } },
					}),
					only: ["permissions", "askUser"],
				}),
			],
		});
		harnesses.push(harness);
		const notes: string[] = [];
		const ui = createTestUiContext({
			notify: (message) => notes.push(message),
			select: async (_title, _options, dialog) => {
				await sleep(dialog?.timeout ?? 0);
				return undefined;
			},
		});
		await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		return { harness, notes };
	}

	it("says so when nothing waits", async () => {
		const { harness, notes } = await start();
		await harness.session.prompt("/waiting");
		expect(notes).toEqual(["Nothing waits for you."]);
	});

	it("lists the step that needs permission and the question the model went on without, each with its command", async () => {
		const { harness, notes } = await start();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm publish" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("ask_user", {
						questions: [
							{
								question: "Which tag should the release get?",
								options: [{ label: "latest" }, { label: "next" }],
							},
							{ question: "Announce it?", options: [{ label: "Yes" }, { label: "No" }] },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Built the package. Publishing waits for you."),
		]);
		await harness.session.prompt("Release the package.");

		await harness.session.prompt("/waiting");
		expect(notes.at(-1)).toBe(
			[
				"The agent's work waits for these:",
				"  /approve: a step that runs once you allow it: npm publish",
				"  /answer: the model asked, and went on without your answer: Which tag should the release get? (and 1 more)",
			].join("\n"),
		);
	});
});
