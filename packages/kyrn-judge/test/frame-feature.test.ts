import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../coding-agent/test/utilities.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { registerForgetting } from "../src/extension/features/forgetting.ts";
import { FRAME_ENTRY, FRAME_MESSAGE, registerFrame } from "../src/extension/features/frame.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { KyrnRuntime } from "../src/extension/runtime.ts";
import { createFrame, type Frame, type FrameEntryData, type UnmergedText } from "../src/frame/frame.ts";
import { Judge } from "../src/judge.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";
import { attended } from "./attended.ts";

const GOAL = "Add cursor pagination to the users API";
const CORRECTION = "保留原方案，但取消数据库变更";

const change = (choice: string): Record<string, Answer> => ({
	change: { type: "choice", choice, probabilities: { [choice]: 0.95 } },
});
/** Answers `task.frame` with one verdict per user message, in order; everything else stays neutral. */
const verdicts =
	(...choices: string[]): MockResponder =>
	(request) => {
		if (!("change" in request.questions)) return {};
		return change(choices.shift() ?? "none");
	};

const writerReply = (frame: Record<string, unknown>) =>
	fauxAssistantMessage(
		JSON.stringify({
			goal: GOAL,
			constraints: [],
			current_subgoal: null,
			acceptance: [],
			open_questions: [],
			...frame,
		}),
	);

interface FramePayload {
	reason: string;
	stale: boolean;
	frame: Frame;
	unmerged: UnmergedText[];
}

describe("task frame feature", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(
		responder: MockResponder,
		extra: {
			mode?: DecisionMode;
			only?: FeatureName[];
			features?: Record<string, unknown>;
			tools?: AgentTool[];
		} = {},
	) {
		const provider = new MockJudgeProvider(responder);
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			tools: extra.tools,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: extra.mode ?? "active",
					only: extra.only ?? ["preflight", "frame"],
					config: parseConfig({ features: attended(extra.features) }),
					onPresentation: (event) => events.push(event),
				}),
			],
		});
		harnesses.push(harness);
		const updates = () => events.filter((event) => event.kind === "frame.updated");
		return {
			harness,
			provider,
			updates,
			/** The frame as the desktop was last told. */
			shown: () => updates().at(-1)?.payload as FramePayload | undefined,
			frameCalls: () => provider.calls.filter((call) => "change" in call.questions),
			entries: () =>
				harness.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "custom" && entry.customType === FRAME_ENTRY ? [entry.data as FrameEntryData] : [],
					),
			notes: () =>
				harness.session.messages.flatMap((message) =>
					message.role === "custom" && (message as { customType?: string }).customType === FRAME_MESSAGE
						? [String((message as { content?: unknown }).content)]
						: [],
				),
			records: () =>
				harness.sessionManager
					.getEntries()
					.flatMap((entry) =>
						entry.type === "custom" && entry.customType === "kyrn.decision" ? [entry.data as LedgerRecord] : [],
					),
		};
	}

	it("the first message makes version 1 without a judge or a model, and says nothing extra to the model", async () => {
		const { harness, shown, frameCalls, entries, notes } = await start(verdicts("new_task"));
		harness.setResponses([fauxAssistantMessage("On it.")]);

		await harness.session.prompt(GOAL);

		expect(frameCalls()).toHaveLength(0);
		expect(shown()).toMatchObject({ reason: "created", stale: false, frame: { version: 1, goal: GOAL } });
		expect(notes()).toEqual([]);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		// Stored after the user message, with that message as the source of nothing yet.
		expect(entries()).toMatchObject([
			{ schema: 1, reason: "created", frame: { version: 1, source: "first-message" } },
		]);
		// A rewind to a user message ends the branch before it, so the entry has to come after that message.
		const branch = harness.sessionManager.getBranch();
		const frameAt = branch.findIndex((entry) => entry.type === "custom" && entry.customType === FRAME_ENTRY);
		const userAt = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userAt).toBeGreaterThanOrEqual(0);
		expect(frameAt).toBeGreaterThan(userAt);
	});

	it("takes the person's own words as the goal when a host put its rules in front of the first message", async () => {
		const { harness, shown, entries } = await start(verdicts("none"));
		harness.setResponses([fauxAssistantMessage("On it.")]);

		await harness.session.prompt(
			`[Assistant Rules]\n## Available Skills\n- **aionui-config**: Configure AionUi.\n[/Assistant Rules]\n\n${GOAL}`,
		);

		expect(shown()).toMatchObject({ reason: "created", frame: { version: 1, goal: GOAL } });
		expect(entries()).toMatchObject([{ reason: "created", frame: { version: 1, goal: GOAL } }]);
	});

	it("a correction bumps the version, keeps the user's words although the writer paraphrased, and tells the model", async () => {
		const { harness, shown, entries, notes, records } = await start(verdicts("correction", "none"));
		let writerSaw = "";
		let agentSaw = "";
		harness.setResponses([
			fauxAssistantMessage("I will add a cursor column to the users table."),
			(context) => {
				writerSaw = JSON.stringify(context.messages);
				return writerReply({ constraints: ["不要修改数据库"], acceptance: [{ text: "no migration is added" }] });
			},
			(context) => {
				agentSaw = JSON.stringify(context.messages);
				return fauxAssistantMessage("Understood, no schema change.");
			},
			fauxAssistantMessage("Yes."),
		]);

		await harness.session.prompt(GOAL);
		await harness.session.prompt(CORRECTION);

		expect(writerSaw).toContain("CURRENT FRAME");
		expect(writerSaw).toContain("read by the judge as: correction");
		const frame = shown()?.frame;
		expect(frame).toMatchObject({ version: 2, goal: GOAL, source: "writer", change: "correction", updatedTurn: 2 });
		expect(frame?.constraints.map((constraint) => constraint.text)).toEqual([CORRECTION]);
		expect(frame?.acceptance).toMatchObject([{ id: "a1", text: "no migration is added", done: false }]);
		expect(JSON.stringify(frame)).not.toContain("不要修改数据库");
		// The note rides along with the message that caused it, and the model reads it.
		expect(notes()).toHaveLength(1);
		expect(notes()[0]).toContain("[mu task frame v2]");
		expect(agentSaw).toContain(`\\"${CORRECTION}\\" (turn 2)`);
		// The stored version names the entry of the message the constraint came from.
		const stored = entries().at(-1);
		const userEntry = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && JSON.stringify(entry.message).includes(CORRECTION));
		expect(stored?.frame.constraints[0].source).toEqual({ turn: 2, entryId: userEntry?.id });

		await harness.session.prompt("ok?");
		expect(notes()).toHaveLength(1);
		// Every judgment records the task version it was made under.
		await vi.waitFor(() => expect(records().filter((record) => record.specId === "task.frame")).toHaveLength(2));
		const origins = records()
			.filter((record) => record.specId === "task.frame")
			.map((record) => record.origin);
		expect(origins).toEqual([
			{ turn: 2, frame: 1 },
			{ turn: 3, frame: 2 },
		]);
	});

	it("a writer that fails leaves the last valid frame, marked stale, and the next message repairs it", async () => {
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
			execute: async () => ({ content: [{ type: "text", text: passingRun }], details: {} }),
		};
		const choices = ["constraint", "none"];
		const { harness, provider, shown, entries } = await start(
			(request): Record<string, Answer> => {
				if ("change" in request.questions) return change(choices.shift() ?? "none");
				if (!("candidates" in (request.state as object))) return {};
				return Object.fromEntries(
					Object.keys(request.questions).map((id): [string, Answer] => [
						id,
						{ type: "choice", choice: "not_needed", probabilities: { not_needed: 0.97 } },
					]),
				);
			},
			{ only: ["preflight", "frame", "admission"], features: { admission: { testLog: "jev" } }, tools: [runTests] },
		);
		const selections = () => provider.calls.filter((call) => "candidates" in (call.state as object));
		const run = () =>
			fauxAssistantMessage([fauxText("Running the tests."), fauxToolCall("run_tests", { command: "vitest run" })], {
				stopReason: "toolUse",
			});
		const results = () =>
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => JSON.stringify(message));
		harness.setResponses([
			fauxAssistantMessage("Which part?"),
			fauxAssistantMessage("Sure, I updated the frame for you."),
			run(),
			fauxAssistantMessage("All green."),
			writerReply({ constraints: ["只看 format 模块"] }),
			run(),
			fauxAssistantMessage("Still green."),
		]);

		await harness.session.prompt("Did my change break anything? I only need the verdict.");
		await harness.session.prompt("只看 format 模块，别的不用管");

		expect(shown()).toMatchObject({ reason: "stale", stale: true, frame: { version: 1 } });
		expect(shown()?.unmerged).toMatchObject([{ reason: "failed", change: "constraint", turn: 2 }]);
		expect(entries().at(-1)).toMatchObject({ reason: "stale", frame: { version: 1 } });
		// Selecting test output by the goal is held back while the goal may be out of date.
		expect(selections()).toHaveLength(0);
		expect(results()[0]).toContain("pads minute 33");

		await harness.session.prompt("go on");

		expect(shown()).toMatchObject({ reason: "updated", stale: false, frame: { version: 2, source: "writer" } });
		expect(shown()?.frame.constraints).toMatchObject([{ text: "只看 format 模块", source: { turn: 2 } }]);
		expect(selections()).toHaveLength(1);
		expect(results()[1]).not.toContain("pads minute 33");
	});

	it("a second writer failure in a row hands over to the rules, so the frame is never stale for good", async () => {
		const { harness, shown } = await start(verdicts("correction", "none"));
		harness.setResponses([
			fauxAssistantMessage("I will add a cursor column."),
			fauxAssistantMessage("not json"),
			fauxAssistantMessage("Ok."),
			fauxAssistantMessage('{"goal": 7}'),
			fauxAssistantMessage("Ok again."),
		]);
		await harness.session.prompt(GOAL);
		await harness.session.prompt(CORRECTION);
		expect(shown()).toMatchObject({ stale: true, frame: { version: 1 } });

		await harness.session.prompt("go on");
		expect(shown()).toMatchObject({ reason: "updated", stale: false, unmerged: [] });
		expect(shown()?.frame).toMatchObject({ version: 2, source: "rules", change: "correction", goal: GOAL });
		expect(shown()?.frame.constraints).toMatchObject([{ text: CORRECTION, source: { turn: 2 } }]);
	});

	it("tells the model again after a compaction, which drops mu's own notes", async () => {
		const { harness, notes } = await start(verdicts("correction", "none", "none"));
		harness.setResponses([
			fauxAssistantMessage("I will add a cursor column."),
			writerReply({ constraints: [CORRECTION] }),
			fauxAssistantMessage("No schema change."),
			fauxAssistantMessage("Three."),
			fauxAssistantMessage("Four."),
		]);
		await harness.session.prompt(GOAL);
		await harness.session.prompt(CORRECTION);
		await harness.session.prompt("ok?");
		expect(notes()).toHaveLength(1);

		const firstKept = harness.sessionManager.getEntries().find((entry) => entry.type === "message");
		const id = harness.sessionManager.appendCompaction("summary", firstKept?.id ?? "", 9000);
		const entry = harness.sessionManager.getEntry(id);
		if (entry?.type !== "compaction") throw new Error("Missing compaction");
		await harness.session.extensionRunner.emit({
			type: "session_compact",
			compactionEntry: entry,
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		});
		await harness.session.prompt("and the tests?");
		expect(notes().at(-1)).toContain(CORRECTION);
		expect(notes().length).toBeGreaterThan(1);
	});

	it("shadow records the verdict and changes nothing; off does not even ask", async () => {
		const shadow = await start(verdicts("correction", "new_task"), { mode: "shadow" });
		shadow.harness.setResponses([
			fauxAssistantMessage("One."),
			fauxAssistantMessage("Two."),
			fauxAssistantMessage("3"),
		]);
		await shadow.harness.session.prompt(GOAL);
		await shadow.harness.session.prompt(CORRECTION);
		await vi.waitFor(() =>
			expect(shadow.records().find((record) => record.specId === "task.frame")).toMatchObject({
				mode: "shadow",
				source: "fallback",
				judged: "correction",
				outcome: "none",
			}),
		);
		await shadow.harness.session.prompt("third message");
		// No writer call took a response, no version, no note: the frame is the rule-made one.
		expect(shadow.harness.getPendingResponseCount()).toBe(0);
		expect(shadow.shown()?.frame.version).toBe(1);
		expect(shadow.notes()).toEqual([]);
		// The consumers see what the stand-in showed them: the goal, and the latest message before this one as the subgoal.
		const preflights = shadow.provider.calls.filter((call) => "turn_type" in call.questions);
		expect(preflights[2].state).toMatchObject({ task_frame: { goal: GOAL, current_subgoal: CORRECTION } });

		const off = await start(verdicts("correction"), { mode: "off" });
		off.harness.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
		await off.harness.session.prompt(GOAL);
		await off.harness.session.prompt(CORRECTION);
		expect(off.provider.calls).toHaveLength(0);
		expect(off.shown()?.frame.version).toBe(1);
	});

	it("a rewind brings back the frame of that branch, and so does a fresh extension instance", async () => {
		const { harness, shown } = await start(verdicts("correction"));
		harness.setResponses([
			fauxAssistantMessage("I will add a cursor column."),
			writerReply({ constraints: [CORRECTION] }),
			fauxAssistantMessage("No schema change then."),
		]);
		await harness.session.prompt(GOAL);
		await harness.session.prompt(CORRECTION);
		expect(shown()?.frame.version).toBe(2);
		const leaf = harness.sessionManager.getLeafId();
		const corrected = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && JSON.stringify(entry.message).includes(CORRECTION));

		// Back to the correction itself: the branch ends before it, and so does the frame.
		await harness.session.navigateTree(corrected?.id ?? "");
		expect(shown()).toMatchObject({ reason: "restored", frame: { version: 1, constraints: [] } });

		await harness.session.navigateTree(leaf ?? "");
		expect(shown()).toMatchObject({ reason: "restored", frame: { version: 2 } });
		expect(shown()?.frame.constraints[0].text).toBe(CORRECTION);
	});

	it("todo: the model adds an item, ticks it with evidence and lists it; none of that bumps the version", async () => {
		const { harness, shown, entries } = await start(verdicts());
		const call = (params: Record<string, string>) =>
			fauxAssistantMessage([fauxToolCall("todo", params)], { stopReason: "toolUse" });
		harness.setResponses([
			call({ action: "add", text: "the cursor survives a deleted row" }),
			call({ action: "add", text: "limit is capped at 100" }),
			call({ action: "done", id: "a9", evidence: "guessing" }),
			call({ action: "done", id: "a1" }),
			call({ action: "done", id: "a1", evidence: "users.test.ts: 14 passed" }),
			call({ action: "list" }),
			fauxAssistantMessage("One item is still open."),
		]);

		await harness.session.prompt(GOAL);

		expect(harness.session.getActiveToolNames()).toContain("todo");
		const results = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => JSON.stringify((message as { content?: unknown }).content));
		expect(results[0]).toContain("Added a1: the cursor survives a deleted row");
		expect(results[2]).toContain('No item has the id \\"a9\\"');
		expect(results[3]).toContain("evidence");
		expect(results[4]).toContain("Ticked a1");
		expect(results[5]).toContain("[x] a1 the cursor survives a deleted row · users.test.ts: 14 passed");
		expect(results[5]).toContain("[ ] a2 limit is capped at 100");

		expect(shown()).toMatchObject({ reason: "progress", frame: { version: 1, nextItem: 3 } });
		expect(shown()?.frame.acceptance).toEqual([
			{
				id: "a1",
				text: "the cursor survives a deleted row",
				done: true,
				doneBy: "model",
				evidence: "users.test.ts: 14 passed",
				addedBy: "model",
			},
			{ id: "a2", text: "limit is capped at 100", done: false, addedBy: "model" },
		]);
		// Stored like a version, so a reload or a rewind has the same list: created, two adds, one tick. Refusals store nothing.
		expect(entries().map((entry) => entry.reason)).toEqual(["created", "progress", "progress", "progress"]);
		expect(entries().every((entry) => entry.frame.version === 1)).toBe(true);
	});

	it("completion: 'done' with an acceptance item open earns the one nudge, and it names the item", async () => {
		const sure: Answer = { type: "boolean", probability: 0.96 };
		const { harness } = await start(
			(request): Record<string, Answer> =>
				"claims_done" in request.questions
					? { claims_done: sure, needs_check: { type: "boolean", probability: 0.1 } }
					: {},
			{ only: ["preflight", "frame", "completion"] },
		);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("todo", { action: "add", text: "limit is capped at 100" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("All done, pagination works."),
			fauxAssistantMessage("Right, the cap is missing. Adding it."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt(GOAL);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));

		const nudges = harness.session.messages.flatMap((message) =>
			message.role === "custom" && (message as { customType?: string }).customType === "kyrn.nudge"
				? [String((message as { content?: unknown }).content)]
				: [],
		);
		// Nothing was edited, so the old check alone would have stayed silent.
		expect(nudges).toHaveLength(1);
		expect(nudges[0]).toContain("a1 limit is capped at 100");
		expect(nudges[0]).toContain("todo tool");
		expect(nudges[0]).not.toContain("You edited");
	});

	it("todo is a baseline capability in the catalog", async () => {
		let runtime: KyrnRuntime | undefined;
		const extensions = await createTestExtensionsResult([
			(pi: ConstructorParameters<typeof KyrnRuntime>[0]) => {
				runtime = new KyrnRuntime(pi, parseConfig({}), new Judge({ provider: new MockJudgeProvider() }));
				registerFrame(runtime);
			},
		]);
		expect(extensions.extensions).toHaveLength(1);
		expect(runtime?.catalog.get("tool:todo")).toMatchObject({ kind: "tool", tools: ["todo"], exposure: "always" });
		expect(runtime?.catalog.hiddenTools().has("todo")).toBe(false);
	});

	it("forgetting holds back while the frame is stale, and carries on once it has caught up", async () => {
		const provider = new MockJudgeProvider(() => ({ still_needed: { type: "boolean", probability: 0.01 } }));
		let runtime: KyrnRuntime | undefined;
		const extensions = await createTestExtensionsResult([
			(pi: ConstructorParameters<typeof KyrnRuntime>[0]) => {
				runtime = new KyrnRuntime(pi, parseConfig({ modes: { default: "active" } }), new Judge({ provider }));
				registerForgetting(runtime);
			},
		]);
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getExtensions = () => extensions;
		const harness = await createHarness({ resourceLoader, settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		vi.spyOn(harness.session, "getContextUsage").mockImplementation(() => ({
			tokens: 9000,
			contextWindow: 10000,
			percent: 90,
		}));
		const bulky = `start\n${"old listing line\n".repeat(500)}end`;
		const messages: Message[] = [
			{ role: "user", content: "List the files.", timestamp: 1 },
			fauxAssistantMessage([{ type: "toolCall", id: "call-0", name: "list", arguments: { path: "dir" } }], {
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolName: "list",
				toolCallId: "call-0",
				content: [{ type: "text", text: bulky }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "Now something else.", timestamp: 20 },
			{ role: "user", content: "Continue.", timestamp: 21 },
		];
		for (const message of messages) harness.sessionManager.appendMessage(message);
		const project = () => harness.session.extensionRunner.emitContext(messages);
		if (!runtime) throw new Error("The extension did not load");

		const frame = createFrame({ text: "List the files.", turn: 1 });
		runtime.frameState = { frame, unmerged: [{ text: CORRECTION, turn: 2, change: "new_task", reason: "failed" }] };
		expect(runtime.frameStale).toBe(true);
		expect(await project()).toEqual(messages);
		expect(provider.calls).toHaveLength(0);

		// A message nobody judged is not staleness: that is how the harness ran before it had a frame.
		runtime.frameState = { frame, unmerged: [{ text: "Continue.", turn: 3, reason: "unjudged" }] };
		expect(runtime.frameStale).toBe(false);
		expect(await project()).not.toEqual(messages);
		expect(provider.calls).toHaveLength(1);
		vi.restoreAllMocks();
	});

	it("a late update does not hold the turn, and lands under the turn that asked", async () => {
		let release: (answers: Record<string, Answer>) => void = () => {};
		const { harness, updates, shown, notes } = await start(
			(request) => {
				if (!("change" in request.questions)) return {};
				return new Promise<Record<string, Answer>>((resolve) => {
					release = resolve;
				});
			},
			{ features: { frame: { waitMs: 20 } } },
		);
		harness.setResponses([
			fauxAssistantMessage("I will add a cursor column."),
			fauxAssistantMessage("Working on it."),
			writerReply({ constraints: [CORRECTION] }),
			fauxAssistantMessage("Third."),
		]);
		await harness.session.prompt(GOAL);
		await harness.session.prompt(CORRECTION);

		// The turn ran on version 1; nothing was told to the model yet.
		expect(shown()?.frame.version).toBe(1);
		expect(notes()).toEqual([]);

		release(change("correction"));
		await vi.waitFor(() => expect(shown()?.frame.version).toBe(2));
		expect(updates().at(-1)?.turnId).toBe(2);
		expect(shown()?.frame.updatedTurn).toBe(2);

		// The next message carries the note.
		await harness.session.prompt("and now?");
		release(change("none"));
		expect(notes()).toHaveLength(1);
		expect(notes()[0]).toContain(CORRECTION);
	});
});
