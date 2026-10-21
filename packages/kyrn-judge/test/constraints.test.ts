import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { describeCall } from "../src/extension/features/constraints.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { createFrame, inheritConstraints, parseInheritedConstraints } from "../src/frame/frame.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.97 };
const no: Answer = { type: "boolean", probability: 0.02 };
const unsure: Answer = { type: "boolean", probability: 0.55 };

describe("hard constraints on tool calls", () => {
	const harnesses: Harness[] = [];
	const ran: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		ran.length = 0;
		delete process.env.KYRN_SWARM_CONSTRAINTS;
	});

	function tool(name: string): AgentTool {
		return {
			name,
			label: name,
			description: name,
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async (_id, params) => {
				ran.push(`${name}:${JSON.stringify(params)}`);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
	}

	async function start(responder: MockResponder, mode: DecisionMode = "active"): Promise<Harness> {
		// A subagent's frame starts with what its parent was told: the shortest way to a frame with a constraint.
		process.env.KYRN_SWARM_CONSTRAINTS = JSON.stringify(["先别修改数据库相关的文件"]);
		const harness = await createHarness({
			tools: [tool("edit"), tool("read")],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(responder),
					mode,
					config: parseConfig({ features: { memory: false } }),
					only: ["preflight", "frame", "constraints"],
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	}
	const verdict =
		(answer: Answer): MockResponder =>
		(request): Record<string, Answer> =>
			"constraint_0" in request.questions ? { constraint_0: answer } : {};
	const edit = (path: string) =>
		fauxAssistantMessage([fauxToolCall("edit", { path, newText: "x" })], { stopReason: "toolUse" });

	it("stops a change that goes against what the user said, and says it in the user's words", async () => {
		const harness = await start(verdict(yes));
		harness.setResponses([edit("db/schema.sql"), fauxAssistantMessage("I will leave the schema alone.")]);

		await harness.session.prompt("Speed up the report page.");

		expect(ran).toEqual([]);
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(result)).toContain("先别修改数据库相关的文件");
	});

	it("lets a change through when the judge says no, is unsure, is only shadowing, or is not asked at all", async () => {
		for (const [answer, mode] of [
			[no, "active"],
			[unsure, "active"],
			[yes, "shadow"],
			[yes, "off"],
		] as const) {
			ran.length = 0;
			const harness = await start(verdict(answer), mode);
			harness.setResponses([edit("src/report.ts"), fauxAssistantMessage("Done.")]);
			await harness.session.prompt("Speed up the report page.");
			expect(ran, `${mode} ${answer.probability}`).toHaveLength(1);
		}
	});

	it("never asks about a call that changes nothing", async () => {
		let asked = 0;
		const harness = await start((request) => {
			if ("constraint_0" in request.questions) asked++;
			return {};
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "db/schema.sql" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Read it."),
		]);

		await harness.session.prompt("What is in the schema?");

		expect(asked).toBe(0);
		expect(ran).toHaveLength(1);
	});

	it("describes a call briefly: where, and the beginning of what", () => {
		expect(describeCall("bash", { command: "rm -rf build" })).toBe("rm -rf build");
		expect(describeCall("edit", { path: "a.ts", newText: "const a = 1;" })).toBe("a.ts <- const a = 1;");
		expect(describeCall("write", { path: "b.md", content: "x".repeat(900) }).length).toBeLessThanOrEqual(500);
	});

	it("hands a parent's constraints to a subagent's frame once, and ignores anything that is not a list of sentences", () => {
		const frame = createFrame({ turn: 1, text: "Task: fix the flaky test" });
		const inherited = inheritConstraints(frame, ["no new dependencies", "no new dependencies", " "]);
		expect(inherited.constraints.map((constraint) => constraint.text)).toEqual(["no new dependencies"]);
		expect(inherited.constraints[0].source).toEqual({ turn: 0 });
		expect(inheritConstraints(inherited, ["no new dependencies"])).toBe(inherited);
		expect(parseInheritedConstraints('["a", 3, "b"]')).toEqual(["a", "b"]);
		expect(parseInheritedConstraints("{not json")).toEqual([]);
		expect(parseInheritedConstraints(undefined)).toEqual([]);
	});
});
