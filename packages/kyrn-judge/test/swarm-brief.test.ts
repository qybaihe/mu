import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expandPromptTemplate, loadPromptTemplates } from "../../coding-agent/src/core/prompt-templates.ts";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { loadAgents } from "../src/extension/agents.ts";
import {
	announceRouting,
	chainRunner,
	childArgs,
	type SwarmAssignment,
	type SwarmRunner,
	type SwarmTask,
} from "../src/extension/features/swarm.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { createFrame } from "../src/frame/frame.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import {
	BRIEF_ENV,
	briefEnv,
	briefFor,
	briefFrame,
	briefMessage,
	describeFrameOut,
	FRAME_OUT_ENV,
	parseBrief,
	parseFrameOut,
} from "../src/swarm/brief.ts";

const parentFrame = () => ({
	...createFrame({ text: "Make the report page load in under a second", turn: 1 }),
	acceptance: [{ id: "a1", text: "The slow query is found", done: false, addedBy: "model" as const }],
	nextItem: 2,
});

describe("the brief a subagent is handed", () => {
	it("places the part in the parent's frame: its goal, the item it serves, and what done means", () => {
		const brief = briefFor(
			{ title: "find", instructions: "Find the slow query", done: ["The query is named", "  "], serves: "#A1" },
			parentFrame(),
		);
		expect(brief).toEqual({
			goal: "find: Find the slow query",
			parentGoal: "Make the report page load in under a second",
			serves: { id: "a1", text: "The slow query is found" },
			done: ["The query is named"],
		});
		// An id the parent's list does not have is dropped, not an error.
		expect(briefFor({ title: "t", instructions: "i", serves: "a9" }, parentFrame()).serves).toBeUndefined();
		expect(parseBrief(briefEnv(brief))).toEqual({ ...brief, previous: undefined });
	});

	it("takes nothing but a brief from the environment", () => {
		for (const raw of [undefined, "", "not json", "null", "[]", '{"goal": 3}', '{"goal": "  "}']) {
			expect(parseBrief(raw)).toBeUndefined();
		}
		const parsed = parseBrief(JSON.stringify({ goal: "g", done: ["x", 4, "y"], serves: { id: "a1" } }));
		expect(parsed).toMatchObject({ goal: "g", done: ["x", "y"], serves: undefined });
	});

	it("becomes the subagent's first frame, with the criteria as items it cannot drop", () => {
		const frame = briefFrame(briefFor({ title: "t", instructions: "i", done: ["one", "two"] }, undefined), 0);
		expect(frame.goal).toBe("t: i");
		expect(frame.acceptance).toEqual([
			{ id: "a1", text: "one", done: false, addedBy: "user" },
			{ id: "a2", text: "two", done: false, addedBy: "user" },
		]);
		expect(frame.nextItem).toBe(3);
	});

	it("is the first message: the part, why, what the step before found, and the checklist", () => {
		const brief = {
			...briefFor({ title: "fix", instructions: "Fix it", done: ["Tests pass"], serves: "a1" }, parentFrame()),
			previous: { title: "find", report: "It is the join in report.sql" },
		};
		const message = briefMessage("Fix it", brief);
		expect(message).toContain("Task: Fix it");
		expect(message).toContain("larger piece of work: Make the report page load");
		expect(message).toContain("It serves this item of that work: The slow query is found");
		expect(message).toContain("<previous-step>\nIt is the join in report.sql\n</previous-step>");
		expect(message).toContain("a1. Tests pass");
		// Without a brief nothing changes.
		expect(briefMessage("Fix it", undefined)).toBe("Task: Fix it");
		const args = childArgs(
			{ title: "fix", instructions: "Fix it", brief } as SwarmTask,
			{
				thinking: "low",
				routedBy: "default",
			} as SwarmAssignment,
		);
		expect(args.at(-1)).toBe(message);
	});

	it("comes back as a checklist the parent can act on", () => {
		const out = parseFrameOut(
			JSON.stringify({
				goal: "g",
				acceptance: [
					{ id: "a1", text: "The query is named", done: true, evidence: "EXPLAIN shows a seq scan on orders" },
					{ id: "a2", text: "An index is proposed", done: false, evidence: "" },
					{ id: 3, text: "bad" },
				],
				openQuestions: ["Is orders partitioned?"],
			}),
		);
		expect(out?.acceptance).toHaveLength(2);
		const serves = { id: "a1", text: "The slow query is found" };
		expect(describeFrameOut(out, serves)).toBe(
			[
				"Acceptance list: 1 of 2 met.",
				"  [x] The query is named (EXPLAIN shows a seq scan on orders)",
				"  [ ] An index is proposed",
				"Open questions: Is orders partitioned?",
				"It serves your item a1 (The slow query is found), which is not done yet.",
			].join("\n"),
		);
		const all = { goal: "g", acceptance: [{ id: "a1", text: "x", done: true }], openQuestions: [] };
		expect(describeFrameOut(all, serves)).toContain("tick a1 with todo");
		expect(describeFrameOut(undefined)).toBe("");
		expect(parseFrameOut("{")).toBeUndefined();
	});
});

describe("delegate and the subagent's frame", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});
	const temp = () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-brief-"));
		dirs.push(dir);
		return dir;
	};

	it("hands each part its brief and reports the list the subagent left, not only its words", async () => {
		const seen: { task: SwarmTask; env: Record<string, string> }[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false, swarm: { isolation: "none" } } }),
					only: ["preflight", "frame", "swarm"],
					swarmRunner: async (task, _assignment, _signal, env = {}) => {
						seen.push({ task, env: { ...env } });
						// What the child's frame feature leaves behind when it stops.
						writeFileSync(
							env[FRAME_OUT_ENV],
							JSON.stringify({
								goal: task.brief?.goal,
								acceptance: [{ id: "a1", text: "The query is named", done: true, evidence: "orders join" }],
								openQuestions: [],
							}),
						);
						return "Found it: the join on orders.";
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("todo", { action: "add", text: "The slow query is found" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("delegate", {
						tasks: [
							{ title: "find", instructions: "Find the slow query", done: ["The query is named"], serves: "a1" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Found."),
		]);

		await harness.session.prompt("Make the report page load in under a second");

		expect(seen).toHaveLength(1);
		const brief = parseBrief(seen[0].env[BRIEF_ENV]);
		expect(brief).toEqual({
			goal: "find: Find the slow query",
			parentGoal: "Make the report page load in under a second",
			serves: { id: "a1", text: "The slow query is found" },
			done: ["The query is named"],
			previous: undefined,
		});
		const result = harness.session.messages.filter((message) => message.role === "toolResult").at(-1);
		const text = JSON.stringify(result);
		expect(text).toContain("Found it: the join on orders.");
		expect(text).toContain("Acceptance list: 1 of 1 met.");
		expect(text).toContain("tick a1 with todo");
		expect((result as { details?: { frames?: unknown[] } }).details?.frames).toHaveLength(1);
	});

	it("inside the subagent: the part is the goal, the criteria are its todo list, and the list is left for the parent", async () => {
		const dir = temp();
		const out = join(dir, "frame.json");
		vi.stubEnv("KYRN_SWARM_DEPTH", "1");
		vi.stubEnv("KYRN_SWARM_CONTROL", join(dir, "control.json"));
		vi.stubEnv(FRAME_OUT_ENV, out);
		vi.stubEnv(
			BRIEF_ENV,
			briefEnv(
				briefFor({ title: "find", instructions: "Find the slow query", done: ["The query is named"] }, undefined),
			),
		);
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false } }),
					only: ["preflight", "frame"],
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("todo", { action: "list" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("todo", { action: "done", id: "a1", evidence: "EXPLAIN shows the orders join" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("It is the orders join."),
		]);

		await harness.session.prompt(briefMessage("Find the slow query", parseBrief(process.env[BRIEF_ENV])));

		const listed = harness.session.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(listed)).toContain("[ ] a1 The query is named");
		expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
			goal: "find: Find the slow query",
			acceptance: [{ id: "a1", text: "The query is named", done: true, evidence: "EXPLAIN shows the orders join" }],
			openQuestions: [],
		});
	});
});

describe("a chain of subagents", () => {
	const assignment = { thinking: "low", routedBy: "default" } as SwarmAssignment;
	const step = (title: string): SwarmTask => ({
		title,
		instructions: `do ${title}`,
		brief: briefFor({ title, instructions: `do ${title}` }, undefined),
	});

	it("hands each step what the step before reported, and starts nothing after a step that did not finish", async () => {
		const seen: (string | undefined)[] = [];
		const runner: SwarmRunner = async (task) => {
			seen.push(task.brief?.previous?.report);
			if (task.title === "plan") throw new Error("the model request was aborted");
			return `${task.title} report`;
		};
		const chained = chainRunner(runner);
		expect(await chained(step("scout"), assignment)).toBe("scout report");
		await expect(chained(step("plan"), assignment)).rejects.toThrow("aborted");
		await expect(chained(step("implement"), assignment)).rejects.toThrow(
			'the step before it ("plan") did not finish',
		);
		await expect(chained(step("again"), assignment)).rejects.toMatchObject({
			coded: { code: "chain_broken", params: { step: "plan" } },
		});
		expect(seen).toEqual([undefined, "scout report"]);
		// The step itself is not changed: only what the child is handed.
		expect(step("x").brief?.previous).toBeUndefined();
	});

	it("delegate with chain: true runs one step at a time, in order, each told what the one before found", async () => {
		const events: string[] = [];
		const handed: { title: string; previous?: string; message: string }[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false, permissions: { mode: "full" } } }),
					only: ["preflight", "frame", "swarm"],
					swarmRunner: async (task, assignment) => {
						events.push(`start ${task.title}`);
						handed.push({
							title: task.title,
							previous: task.brief?.previous?.report,
							message: childArgs(task, assignment).at(-1) ?? "",
						});
						await new Promise((resolve) => setTimeout(resolve, 20));
						events.push(`end ${task.title}`);
						return `${task.title}: found src/report.ts`;
					},
				}),
			],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("delegate", {
							chain: true,
							tasks: [
								{ title: "scout", instructions: "Find the report code", agent: "scout" },
								{ title: "plan", instructions: "Plan the change", agent: "planner" },
							],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Planned."),
			]);
			await harness.session.prompt("Plan a faster report page");

			expect(events).toEqual(["start scout", "end scout", "start plan", "end plan"]);
			expect(handed.map((each) => each.previous)).toEqual([undefined, "scout: found src/report.ts"]);
			expect(handed[1].message).toContain('What the step before this one ("scout") reported');
			const result = JSON.stringify(
				harness.session.messages.filter((message) => message.role === "toolResult").at(-1),
			);
			expect(result).toContain("## 1. scout");
			expect(result).toContain("## 2. plan");
			// The title mu wrote, as a code for a client that translates.
			const details = (
				harness.session.messages.filter((message) => message.role === "toolResult").at(-1) as {
					details?: { snapshot?: { title?: string; titleCode?: unknown } };
				}
			).details;
			expect(details?.snapshot).toMatchObject({
				title: "a chain of 2 steps",
				titleCode: { code: "delegate_chain", params: { count: 2 } },
			});
		} finally {
			harness.cleanup();
		}
	});
});

describe("workflow commands", () => {
	const prompts = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
	const roles = new Set(loadAgents(join(tmpdir(), "mu-no-user-agents")).map((agent) => agent.name));

	it("/implement, /scout-and-plan and /implement-and-review load as pi prompt templates and name roles that exist", () => {
		const { templates, diagnostics } = loadPromptTemplates({
			cwd: tmpdir(),
			agentDir: tmpdir(),
			promptPaths: [prompts],
			includeDefaults: false,
		});
		expect(diagnostics).toEqual([]);
		for (const name of ["implement", "scout-and-plan", "implement-and-review"]) {
			const template = templates.find((each) => each.name === name);
			expect(template?.description, name).toBeTruthy();
			const expanded = expandPromptTemplate(`/${name} make the report page fast`, templates);
			expect(expanded, name).toContain("make the report page fast");
			expect(expanded, name).toContain("chain: true");
			for (const role of expanded.matchAll(/\(agent `([a-z]+)`\)/g))
				expect(roles, `${name}: ${role[1]}`).toContain(role[1]);
		}
		expect(expandPromptTemplate("/scout-and-plan x", templates)).toContain("Do not implement anything");
	});
});

describe("what the subagent tools say before a run starts", () => {
	it("says it is choosing roles as a code too, for a client that translates", () => {
		const updates: unknown[] = [];
		announceRouting((partial) => updates.push(partial), 3);
		expect(updates).toEqual([
			{
				content: [{ type: "text", text: "choosing a role, a model and a thinking level for 3 subagents…" }],
				details: { code: "choosing_roles", params: { count: 3 } },
			},
		]);
	});
});
