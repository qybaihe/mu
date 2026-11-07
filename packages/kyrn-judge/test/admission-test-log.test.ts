import { existsSync, readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { FULL_OUTPUT_ENTRY, type FullOutputRecord } from "../src/extension/full-output.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

/** A failing targeted run as real sessions have them: every failure prints the same DOM dump and stack again. */
const dom = Array.from(
	{ length: 40 },
	(_, n) => `    <div class="row row-${n}" data-testid="sider-item-${n}">item ${n}</div>\n`,
).join("");
const stack = Array.from(
	{ length: 7 },
	(_, n) => ` ❯ node_modules/@testing-library/dom/dist/query-helpers.js:${20 + n}:${5 + n}\n`,
).join("");
const failure = (name: string) =>
	` FAIL  test/sider.dom.test.tsx > sider > ${name}\nTestingLibraryElementError: Unable to find an element with the text: ${name}\n\n<body>\n${dom}</body>\n${stack}\n`;
const failingRun = [
	"\n RUN  v4.1.9 /tmp/synthetic\n\n ❯ test/sider.dom.test.tsx (4 tests | 3 failed) 40ms\n",
	"⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯\n\n",
	failure("shows the wordmark"),
	failure("links to the home route"),
	failure("collapses on a narrow window"),
	" Test Files  1 failed (1)\n      Tests  3 failed | 1 passed (4)\n\n\nCommand exited with code 1",
].join("");

/** A verbose passing run: nothing repeats, and whether the names matter depends on the goal. */
const passingRun = [
	"\n RUN  v4.1.9 /tmp/synthetic\n\n",
	...Array.from({ length: 70 }, (_, n) => ` ✓ test/format.test.ts > formatDate > pads minute ${n} 0ms\n`),
	"\n Test Files  1 passed (1)\n      Tests  70 passed (70)\n",
].join("");

const runTests: AgentTool = {
	name: "run_tests",
	label: "Run tests",
	description: "Run the test suite",
	parameters: Type.Object({ command: Type.String() }),
	execute: async (_id, params) => {
		// A failing run reaches the agent as an error result, like a bash command that exits with 1.
		if (String((params as { command: string }).command).includes("sider")) throw new Error(failingRun);
		return { content: [{ type: "text", text: passingRun }], details: {} };
	},
};

const notNeeded = (): MockJudgeProvider =>
	new MockJudgeProvider((request): Record<string, Answer> => {
		if (!("candidates" in (request.state as object))) return {};
		return Object.fromEntries(
			Object.keys(request.questions).map((id): [string, Answer] => [
				id,
				{ type: "choice", choice: "not_needed", probabilities: { not_needed: 0.97 } },
			]),
		);
	});

const selectionCalls = (provider: MockJudgeProvider) =>
	provider.calls.filter((call) => "candidates" in (call.state as object));

function toolResult(harness: Harness): { text: string; isError: boolean } {
	const result = harness.session.messages.find((message) => message.role === "toolResult") as
		| { content?: { type: string; text?: string }[]; isError?: boolean }
		| undefined;
	return {
		text: (result?.content ?? []).map((block) => block.text ?? "").join("\n"),
		isError: result?.isError === true,
	};
}

describe("test-log admission in a session", () => {
	const harnesses: Harness[] = [];
	const before = process.env.AI_AGENT;
	beforeEach(() => {
		delete process.env.AI_AGENT;
	});
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		if (before === undefined) delete process.env.AI_AGENT;
		else process.env.AI_AGENT = before;
	});

	async function run(
		admission: Record<string, unknown>,
		command: string,
		provider = notNeeded(),
		mode: DecisionMode = "active",
		only: FeatureName[] = ["preflight", "admission"],
	): Promise<Harness> {
		const harness = await createHarness({
			tools: [runTests],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode,
					only,
					config: { ...DEFAULT_CONFIG, features: { admission } },
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxText("Running the tests to see what fails."), fauxToolCall("run_tests", { command })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Did my change break anything? I only need the verdict.");
		return harness;
	}

	it("is off by default: a failing run passes through untouched", async () => {
		const provider = notNeeded();
		const result = toolResult(await run({}, "vitest run sider", provider));
		expect(result.text).toBe(failingRun);
		expect(result.isError).toBe(true);
		expect(selectionCalls(provider)).toHaveLength(0);
	});

	it("rules: omits the repeated failure bodies of a failing run without a judge, and archives the original", async () => {
		const provider = notNeeded();
		const result = toolResult(await run({ testLog: "rules" }, "vitest run sider", provider));
		expect(selectionCalls(provider)).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(result.text.length).toBeLessThan(failingRun.length / 2);
		for (const name of ["shows the wordmark", "links to the home route", "collapses on a narrow window"]) {
			expect(result.text).toContain(`Unable to find an element with the text: ${name}`);
		}
		expect(result.text.match(/data-testid="sider-item-7"/g)).toHaveLength(1);
		expect(result.text).toMatch(
			/\[mu: omitted \d+ lines: identical to lines \d+-\d+ of the full output, kept above\]/,
		);
		expect(result.text).toContain("Command exited with code 1");
		const archive = /full output: (\S+)\]/.exec(result.text)?.[1] ?? "";
		expect(existsSync(archive)).toBe(true);
		expect(readFileSync(archive, "utf8")).toBe(failingRun);
	});

	it("rules, with recall: the pointer is a recall call, and the entry beside the result names the archive", async () => {
		const harness = await run({ testLog: "rules" }, "vitest run sider", notNeeded(), "active", [
			"preflight",
			"admission",
			"recall",
		]);
		const result = toolResult(harness);
		expect(result.text.trimEnd()).toMatch(/full output: recall\(\{ id: "[^"]+" \}\)\]$/);
		const record = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === FULL_OUTPUT_ENTRY ? [entry.data as FullOutputRecord] : [],
			)[0];
		expect(record).toMatchObject({ kind: "archive" });
		expect(readFileSync(record.path, "utf8")).toBe(failingRun);
	});

	it("rules: leaves a verbose passing run alone, because which names matter depends on the goal", async () => {
		expect(toolResult(await run({ testLog: "rules" }, "vitest run format")).text).toBe(passingRun);
	});

	it("jev: asks once, with the user's goal and the agent's stated intent, and applies a sure verdict", async () => {
		const provider = notNeeded();
		const result = toolResult(await run({ testLog: "jev" }, "vitest run format", provider));
		const calls = selectionCalls(provider);
		expect(calls).toHaveLength(1);
		expect(calls[0].state).toMatchObject({
			goal: "Did my change break anything? I only need the verdict.",
			intent: "Running the tests to see what fails.",
			call: "run_tests: vitest run format",
		});
		expect(result.text).toContain("[mu: omitted 70 lines: passing tests (test/format.test.ts)]");
		expect(result.text).toContain("Tests  70 passed (70)");
		expect(result.text).not.toContain("pads minute 33");
	});

	it("jev in shadow: the judge is asked and recorded, the text only changes by rule", async () => {
		const provider = notNeeded();
		expect(toolResult(await run({ testLog: "jev" }, "vitest run format", provider, "shadow")).text).toBe(passingRun);
		expect(selectionCalls(provider)).toHaveLength(1);
		const failing = toolResult(await run({ testLog: "jev" }, "vitest run sider", notNeeded(), "shadow"));
		expect(failing.text).toContain("[mu: omitted");
	});

	it("tells test runners that an agent is reading, unless told not to", async () => {
		await run({ agentEnv: false }, "vitest run format");
		expect(process.env.AI_AGENT).toBeUndefined();
		await run({}, "vitest run format");
		expect(process.env.AI_AGENT).toBe("1");
	});
});
