import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { isPlan, PLAN_ENTRY, PLAN_STATUS, type PlanRecord, planSteps } from "../src/extension/features/plan.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

const PLAN = [
	"Here is what I would do.",
	"",
	"# Plan",
	"1. Rename `fetchUser` to `loadUser` in src/api.ts, and check with `npm test`.",
	"2. **Update the two callers** in src/pages.",
	"- Run the type checker.",
	"",
	"## Risks",
	"- The old name is exported.",
].join("\n");

const call = (name: string, args: Record<string, JsonValue>, id?: string) =>
	fauxAssistantMessage([fauxToolCall(name, args, id ? { id } : undefined)], { stopReason: "toolUse" });

/** A tool that records that it ran. */
function tool(name: string, ran: string[]): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_id, params) => {
			ran.push(`${name} ${JSON.stringify(params)}`);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

interface Dialog {
	readonly method: "select" | "input";
	readonly title: string;
	readonly options?: readonly string[];
	readonly aborted?: boolean;
}

/** What the user does at each dialog, in order: a choice or text, `undefined` for Esc, "hold" to answer nothing. */
type Step = string | undefined | "hold";

function scriptedUi(steps: Step[], dialogs: Dialog[], status: (string | undefined)[]): ExtensionUIContext {
	const answer = (dialog: Dialog, opts?: ExtensionUIDialogOptions): Promise<string | undefined> => {
		const step = steps.shift();
		if (step !== "hold") {
			dialogs.push(dialog);
			return Promise.resolve(step);
		}
		// Stays up until the signal takes it down.
		return new Promise((resolve) => {
			opts?.signal?.addEventListener("abort", () => {
				dialogs.push({ ...dialog, aborted: true });
				resolve(undefined);
			});
		});
	};
	return createTestUiContext({
		select: (title, options, opts) => answer({ method: "select", title, options }, opts),
		input: (title, _placeholder, opts) => answer({ method: "input", title }, opts),
		setStatus: (key, text) => {
			if (key === PLAN_STATUS) status.push(text);
		},
	});
}

const toolResults = (harness: Harness) =>
	harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => ({
			tool: message.toolName,
			text: (message.content as { text?: string }[]).map((block) => block.text ?? "").join(""),
		}));

const userTexts = (harness: Harness) =>
	harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((block) => ("text" in block ? block.text : "")).join(""),
		);

const planMessages = (harness: Harness) =>
	harness.session.messages
		.filter((message) => message.role === "custom" && (message as { customType?: string }).customType === PLAN_ENTRY)
		.map((message) => String((message as { content?: unknown }).content));

const records = (harness: Harness): PlanRecord[] =>
	harness.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === PLAN_ENTRY ? [entry.data as PlanRecord] : [],
		);

describe("plan mode", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(
		setup: {
			steps?: Step[];
			only?: FeatureName[];
			provider?: MockJudgeProvider;
			features?: Record<string, unknown>;
		} = {},
	) {
		const ran: string[] = [];
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			tools: ["edit", "bash"].map((name) => tool(name, ran)),
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: setup.provider ?? new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false, permissions: { mode: "full" }, ...setup.features } }),
					only: setup.only ?? ["plan", "askUser"],
					onPresentation: (event) => events.push(event),
				}),
			],
		});
		harnesses.push(harness);
		const dialogs: Dialog[] = [];
		const status: (string | undefined)[] = [];
		await harness.session.bindExtensions({ uiContext: scriptedUi(setup.steps ?? [], dialogs, status), mode: "tui" });
		const asked = () => events.filter((event) => event.kind === "question.asked").map((event) => event.payload);
		return { harness, ran, dialogs, status, asked };
	}

	it("changes nothing until a plan is approved: edits and commands that change things are refused, looking runs", async () => {
		const { harness, ran, status } = await start();
		await harness.session.prompt("/plan");
		expect(planMessages(harness)).toEqual([expect.stringContaining("[mu: plan mode] The user wants a plan")]);
		expect(status.at(-1)).toBe("Plan mode: nothing changes until you approve a plan (/plan off to leave)");
		harness.setResponses([
			call("edit", { path: "src/api.ts" }),
			call("bash", { command: "rm -rf build" }),
			call("bash", { command: "ls src" }),
			fauxAssistantMessage("Still looking."),
		]);
		await harness.session.prompt("Rename fetchUser.");
		expect(ran).toEqual(['bash {"command":"ls src"}']);
		const [edit, remove] = toolResults(harness);
		expect(edit.text).toContain("mu: plan mode is on, so nothing changes until the user approves a plan");
		expect(edit.text).toContain("edit src/api.ts could change something");
		expect(remove.text).toContain("rm -rf build could change something");
		expect(records(harness)).toEqual([{ state: "on", by: "command" }]);
	});

	it("asks to approve a plan once the run settles; approving ends plan mode and sends the go-ahead", async () => {
		const { harness, ran, dialogs, status, asked } = await start({
			steps: [
				"Approve and start — Plan mode ends and the agent carries it out; its steps go on the task's checklist",
			],
		});
		await harness.session.prompt("/plan");
		harness.setResponses([
			fauxAssistantMessage(PLAN),
			call("edit", { path: "src/api.ts" }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Rename fetchUser.");
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		await vi.waitFor(() => expect(ran).toEqual(['edit {"path":"src/api.ts"}']));
		expect(dialogs).toEqual([
			{
				method: "select",
				title: "Plan: Start on the plan above?",
				options: [
					"Approve and start — Plan mode ends and the agent carries it out; its steps go on the task's checklist",
					"Keep planning — Stay in plan mode; choose something else to say what to change",
					"Something else (type it)",
				],
			},
		]);
		// The approval is a question like ask_user's: a client shows it as its card.
		expect(asked()).toEqual([expect.objectContaining({ header: "Plan", index: 0, count: 1, dialog: "select" })]);
		expect(userTexts(harness).at(-1)).toBe("I approve the plan. Plan mode is off: carry it out now.");
		expect(status.at(-1)).toBeUndefined();
		expect(records(harness)).toEqual([
			{ state: "on", by: "command" },
			{ state: "approved", by: "answer", steps: 0 },
		]);
	});

	it("puts an approved plan's steps on the task's checklist", async () => {
		const { harness } = await start({
			only: ["preflight", "frame", "plan", "askUser"],
			steps: [
				"Approve and start — Plan mode ends and the agent carries it out; its steps go on the task's checklist",
			],
		});
		await harness.session.prompt("/plan");
		harness.setResponses([fauxAssistantMessage(PLAN), fauxAssistantMessage("On it.")]);
		await harness.session.prompt("Rename fetchUser to loadUser.");
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		expect(records(harness).at(-1)).toEqual({ state: "approved", by: "answer", steps: 3 });
		expect(userTexts(harness).at(-1)).toContain("Its 3 steps are on the task's checklist (todo list shows them)");
		harness.appendResponses([call("todo", { action: "list" }), fauxAssistantMessage("Listed.")]);
		await harness.session.prompt("Show the list.");
		const list = toolResults(harness).find((result) => result.tool === "todo")?.text ?? "";
		expect(list).toContain("Rename `fetchUser` to `loadUser` in src/api.ts, and check with `npm test`.");
		expect(list).toContain("Update the two callers in src/pages.");
		expect(list).toContain("Run the type checker.");
		expect(list).not.toContain("The old name is exported.");
	});

	it("keeps planning with what the user wrote, and stays in plan mode", async () => {
		const { harness, ran } = await start({ steps: ["Something else (type it)", "Keep the old name as an alias."] });
		await harness.session.prompt("/plan");
		harness.setResponses([
			fauxAssistantMessage(PLAN),
			call("edit", { path: "src/api.ts" }),
			fauxAssistantMessage("# Plan\n1. Alias it."),
		]);
		await harness.session.prompt("Rename fetchUser.");
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		expect(userTexts(harness)).toContain(
			"Not yet. Keep the old name as an alias.\nKeep planning: change the plan and reply with it under # Plan.",
		);
		expect(ran).toEqual([]);
		expect(records(harness)).toEqual([{ state: "on", by: "command" }]);
	});

	it("a message the user types while the question is up takes it down", async () => {
		const { harness, dialogs } = await start({ steps: ["hold"] });
		await harness.session.prompt("/plan");
		harness.setResponses([fauxAssistantMessage(PLAN), fauxAssistantMessage("Changed the plan.")]);
		await harness.session.prompt("Rename fetchUser.");
		await harness.session.prompt("Also rename the tests.");
		await vi.waitFor(() => expect(dialogs).toEqual([expect.objectContaining({ method: "select", aborted: true })]));
		expect(records(harness)).toEqual([{ state: "on", by: "command" }]);
	});

	it("/plan approve approves the last plan; /plan off leaves without one", async () => {
		const { harness, ran } = await start({ steps: [undefined] });
		await harness.session.prompt("/plan");
		harness.setResponses([fauxAssistantMessage(PLAN), call("edit", { path: "a.ts" }), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Rename fetchUser.");
		await harness.session.prompt("/plan approve");
		await vi.waitFor(() => expect(ran).toEqual(['edit {"path":"a.ts"}']));
		expect(records(harness).at(-1)).toEqual({ state: "approved", by: "command", steps: 0 });

		await harness.session.prompt("/plan");
		await harness.session.prompt("/plan off");
		expect(planMessages(harness).at(-1)).toContain("[mu: plan mode is off]");
		expect(records(harness).at(-1)).toEqual({ state: "off", by: "command" });
		harness.appendResponses([call("edit", { path: "b.ts" }), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Edit b.");
		expect(ran.at(-1)).toBe('edit {"path":"b.ts"}');
	});

	it("turn.continue leaves a plan as it is", async () => {
		const yes: Answer = { type: "boolean", probability: 0.95 };
		const no: Answer = { type: "boolean", probability: 0.03 };
		const provider = new MockJudgeProvider((request: JudgeRequest): Record<string, Answer> => {
			if (!("promised" in request.questions)) return {};
			return { promised: yes, asks_go_ahead: no, work_requested: yes, beyond_request: no, irreversible: no };
		});
		const { harness } = await start({ provider, only: ["plan", "continuation"], steps: ["hold"] });
		await harness.session.prompt("/plan");
		harness.setResponses([
			fauxAssistantMessage(`${PLAN}\n\nI'll start with the rename.`),
			fauxAssistantMessage("unused"),
		]);
		await harness.session.prompt("Rename fetchUser.");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(provider.calls.filter((each) => "promised" in each.questions)).toEqual([]);
	});
});

describe("a plan", () => {
	it("is a reply with a plan heading", () => {
		expect(isPlan(PLAN)).toBe(true);
		expect(isPlan("## Plan: the rename\n- a")).toBe(true);
		expect(isPlan("# 计划\n1. 改名")).toBe(true);
		expect(isPlan("I plan to rename it.")).toBe(false);
		expect(isPlan("# Planning notes")).toBe(false);
	});

	it("has the list items under its heading as steps", () => {
		expect(planSteps(PLAN)).toEqual([
			"Rename `fetchUser` to `loadUser` in src/api.ts, and check with `npm test`.",
			"Update the two callers in src/pages.",
			"Run the type checker.",
		]);
		expect(planSteps("No heading\n- a")).toEqual([]);
	});
});
