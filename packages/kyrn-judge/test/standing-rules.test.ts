import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { foldLessons, isUsersWord, type StoredLesson, standingRules } from "../src/memory/store.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

const lesson = (id: string, fields: Partial<StoredLesson> = {}): StoredLesson => ({
	id,
	kind: "correction",
	trigger: `when ${id} comes up`,
	lesson: `Do ${id}.`,
	scope: {},
	source: { origin: "user" },
	status: "active",
	uses: { recalled: 0, applied: 0 },
	created: "2026-11-01T00:00:00.000Z",
	updated: "2026-11-01T00:00:00.000Z",
	...fields,
});

describe("standing rules in the lesson store", () => {
	it("are the active lessons marked standing that hold in the project, the most recently confirmed first", () => {
		const lessons = foldLessons([
			lesson("old", { standing: true }),
			lesson("plain"),
			lesson("new", { standing: true, updated: "2026-11-09T00:00:00.000Z" }),
			lesson("elsewhere", { standing: true, scope: { cwd: "/work/other" } }),
			lesson("gone", { standing: true }),
			// Later lines of the file: one rule is forgotten, one has its standing taken away.
			{ id: "gone", status: "retired" },
			{ id: "old", standing: false },
		]);
		expect(standingRules(lessons, "/work/project").map((rule) => rule.id)).toEqual(["new"]);
		expect(lessons.find((each) => each.id === "old")?.standing).toBeUndefined();
	});

	it("counts only what the user said as the user's word", () => {
		expect(isUsersWord(lesson("a"))).toBe(true);
		expect(isUsersWord(lesson("b", { source: { origin: "command" } }))).toBe(true);
		for (const origin of ["outcome", "model", "subagent"] as const) {
			expect(isUsersWord(lesson("c", { source: { origin } }))).toBe(false);
		}
	});
});

describe("a standing rule at the constraint gate", () => {
	const harnesses: Harness[] = [];
	const folders: string[] = [];
	const ran: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (folders.length > 0) rmSync(folders.pop() as string, { recursive: true, force: true });
		ran.length = 0;
	});

	const bash: AgentTool = {
		name: "bash",
		label: "bash",
		description: "bash",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_id, params) => {
			ran.push(String((params as { command?: unknown }).command));
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
	const yes: Answer = { type: "boolean", probability: 0.96 };

	async function start(lessons: readonly StoredLesson[], constraints: Record<string, unknown> = {}) {
		const folder = mkdtempSync(join(tmpdir(), "mu-standing-"));
		folders.push(folder);
		const path = join(folder, "lessons.jsonl");
		writeFileSync(path, lessons.map((each) => `${JSON.stringify(each)}\n`).join(""));
		const provider = new MockJudgeProvider((request: JudgeRequest): Record<string, Answer> => {
			const answers: Record<string, Answer> = {};
			for (const [id, question] of Object.entries(request.questions)) {
				if (id.startsWith("constraint_") && String(question.instructions).includes("never npm test"))
					answers[id] = yes;
			}
			return answers;
		});
		const harness = await createHarness({
			tools: [bash],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					config: parseConfig({ features: { memory: { path }, permissions: { mode: "full" }, constraints } }),
					only: ["preflight", "memory", "constraints"],
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm test" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("I will use the script instead."),
		]);
		await harness.session.prompt("Check that the login fix holds.");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		return { provider, blocked: JSON.stringify(result) };
	}
	const rule = lesson("abcd1234-rule", { standing: true, lesson: "Run ./test.sh, never npm test." });

	it("stops a call that goes against it, and names the lesson so the user can take it away", async () => {
		const { provider, blocked } = await start([rule]);
		expect(ran).toEqual([]);
		expect(blocked).toContain("this call goes against what the user said");
		expect(blocked).toContain("Run ./test.sh, never npm test.");
		expect(blocked).toContain(
			"It is a standing rule from an earlier session (lesson abcd1234; the user removes one with /forget).",
		);
		const [asked] = provider.calls.filter((call) => "constraint_0" in call.questions);
		expect(asked.questions.constraint_0.instructions).toBe(
			'Does `tool_call` go against this instruction from the user? "Run ./test.sh, never npm test."',
		);
	});

	it("is not checked when it is only a lesson, when it was forgotten, or when no standing rule is checked", async () => {
		await start([{ ...rule, standing: undefined }]);
		expect(ran).toEqual(["npm test"]);
		ran.length = 0;
		await start([{ ...rule, status: "retired" }]);
		expect(ran).toEqual(["npm test"]);
		ran.length = 0;
		await start([rule], { maxStanding: 0 });
		expect(ran).toEqual(["npm test"]);
	});
});
