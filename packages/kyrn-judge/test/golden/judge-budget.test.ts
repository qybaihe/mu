import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../../src/config.ts";
import { createKyrnJudgeExtension } from "../../src/extension/kyrn-judge.ts";
import { LEDGER_ENTRY_TYPE } from "../../src/extension/runtime.ts";
import type { LedgerRecord } from "../../src/ledger.ts";
import { MockJudgeProvider } from "../../src/providers/mock.ts";
import { attended } from "../attended.ts";
import { GOLDEN_CASES } from "./decision-inputs.ts";

/**
 * What a turn costs in judge calls, kept in `judge-budget.md`: for a few scripted turns in Judge mode, with every
 * feature on, how many requests go to the judge, how many characters of state and questions they carry (about four to
 * a token), and which decisions ask, and whether the agent waits for them. A feature that starts asking the judge once
 * more per turn, or per tool call, or sends it more, shows up there as a diff in the pull request: the judge's cost and
 * latency are paid on every turn of every user. `npx vitest --run test/golden -u` writes the file.
 *
 * The judge is the mock with its neutral answers, so a run takes the paths a judge that cannot tell would take. Two
 * runs of a turn ask the same, as `replay.test.ts` shows, so the numbers do not move by themselves.
 */
const GOLDEN = fileURLToPath(new URL("./judge-budget.md", import.meta.url));

interface Turn {
	readonly name: string;
	readonly prompt: string;
	readonly replies: readonly FauxResponseStep[];
}

const TURNS: readonly Turn[] = [
	{
		name: "a question, answered without tools",
		prompt: "What does parseDuration return for 90?",
		replies: [fauxAssistantMessage("90 seconds: a plain number is read as seconds.")],
	},
	{
		name: "a look at two files",
		prompt: "Where is the duration format parsed?",
		replies: [
			fauxAssistantMessage(
				[fauxToolCall("read", { path: "src/parse.ts" }), fauxToolCall("read", { path: "src/format.ts" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("In src/parse.ts, parseDuration; src/format.ts only prints durations."),
		],
	},
	{
		name: "a fix: test, edit, test again",
		prompt: "The parseDuration test fails for 1h30m, can you fix it?",
		replies: [
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm test -- parse" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("edit", { path: "src/parse.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm test -- parse" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Fixed the hours and minutes in parseDuration; the test passes."),
		],
	},
];

/** The tools the turns call, doing nothing: what they return is not what is measured. */
const tool = (name: string): AgentTool => ({
	name,
	label: name,
	description: name,
	parameters: Type.Object({}, { additionalProperties: true }),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
});

/** Whether the agent waits for a decision (`inline`), races it with other work, or never waits. */
const LATENCY = new Map(GOLDEN_CASES.map((golden) => [golden.spec.id, golden.spec.latency]));

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

/** One turn, its judge requests and its ledger records. An interactive session asks more than `mu --print`. */
async function measure(turn: Turn, interactive: boolean) {
	const provider = new MockJudgeProvider();
	const features = { permissions: { mode: "judge" } };
	const harness = await createHarness({
		tools: ["read", "edit", "write", "bash"].map(tool),
		extensionFactories: [
			createKyrnJudgeExtension({
				provider,
				mode: "active",
				config: parseConfig({ features: interactive ? attended(features) : features }),
			}),
		],
	});
	harnesses.push(harness);
	harness.setResponses([...turn.replies]);
	await harness.session.prompt(turn.prompt);
	await harness.session.waitForIdle();
	const records = harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === LEDGER_ENTRY_TYPE)
		.map((entry) => (entry as { data: LedgerRecord }).data);
	const chars = provider.calls.reduce(
		(sum, call) => sum + JSON.stringify({ state: call.state, questions: call.questions }).length,
		0,
	);
	return { requests: provider.calls.length, chars, records };
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function section(turn: Turn, interactive: boolean, measured: Awaited<ReturnType<typeof measure>>): string {
	const rows = new Map<string, { asked: number; without: number }>();
	for (const record of measured.records) {
		const row = rows.get(record.specId) ?? { asked: 0, without: 0 };
		if (record.source === "judge") row.asked++;
		else row.without++;
		rows.set(record.specId, row);
	}
	const inline = measured.records.filter((record) => LATENCY.get(record.specId) === "inline").length;
	return [
		`## ${turn.name}, ${interactive ? "interactive" : "mu --print"}`,
		"",
		`- ${count(measured.requests, "request")} to the judge, ${measured.chars} characters of state and questions`,
		`- ${count(measured.records.length, "decision")}, ${inline} of them inline (the agent waits for them)`,
		"",
		"| decision | latency | judge answered | decided without it |",
		"|---|---|---|---|",
		...[...rows]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([id, row]) => `| \`${id}\` | ${LATENCY.get(id) ?? "?"} | ${row.asked} | ${row.without} |`),
	].join("\n");
}

// Windows is left out as for the model surface: the turns are the same there, and one platform keeps the file.
describe.skipIf(process.platform === "win32")("what a turn costs in judge calls", () => {
	it("is as recorded", async () => {
		const parts = [
			"# What a turn costs in judge calls",
			"",
			"Generated by `judge-budget.test.ts`: one user message each, in Judge mode with every feature on, answered by",
			"a judge that cannot tell. A change here is a change to what every turn of every user costs. Do not edit by",
			"hand; run the test with `-u`.",
		];
		for (const turn of TURNS) {
			for (const interactive of [false, true])
				parts.push("", section(turn, interactive, await measure(turn, interactive)));
		}
		await expect(`${parts.join("\n")}\n`).toMatchFileSnapshot(GOLDEN);
	}, 60_000);
});
