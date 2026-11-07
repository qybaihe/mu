import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { type GoalInput, goalMet } from "../src/decisions/goal-met.ts";
import {
	describeGoal,
	GOAL_ENTRY,
	GOAL_MESSAGE,
	type GoalState,
	parseGoalEntry,
	stepsOf,
} from "../src/extension/features/goal.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { goalCheckRequest, parseGoalJudgement } from "../src/goal/check.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.97 };
const no: Answer = { type: "boolean", probability: 0.02 };
const unsure: Answer = { type: "boolean", probability: 0.55 };

describe("goal mode", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function tool(name: string): AgentTool {
		return {
			name,
			label: name,
			description: name,
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
	}

	async function start(
		responder: MockResponder,
		extra: { mode?: DecisionMode; goal?: Record<string, unknown> } = {},
	): Promise<Harness> {
		const harness = await createHarness({
			tools: [tool("edit"), tool("bash")],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(responder),
					mode: extra.mode ?? "active",
					// The judge's own check here; the model's check has its tests below.
					config: parseConfig({ features: { memory: false, goal: { checker: "jev", ...extra.goal } } }),
					only: ["preflight", "goal", "completion"],
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	}

	/** Answers the goal check from a list, one per run that ends; anything else gets no answer. */
	const verdicts =
		(...list: { achieved: Answer; needs_user: Answer }[]): MockResponder =>
		(request): Record<string, Answer> =>
			"achieved" in request.questions ? (list.shift() ?? { achieved: no, needs_user: no }) : {};

	const states = (harness: Harness): GoalState[] =>
		harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === GOAL_ENTRY)
			.map((entry) => (entry as { data?: unknown }).data as GoalState);
	const sent = (harness: Harness): string[] =>
		harness.session.messages
			.filter(
				(message) => message.role === "custom" && (message as { customType?: string }).customType === GOAL_MESSAGE,
			)
			.map((message) => String((message as { content?: unknown }).content));
	const work = (name: string, input: Record<string, string>) =>
		fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" });
	const settled = (harness: Harness, left: number) =>
		vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(left), { timeout: 5000 });

	it("reads what the harness knows before what the message claims", () => {
		const input: GoalInput = { goal: "tests pass", finalMessage: "All done.", openItems: 0, unverified: false };
		expect(goalMet.policy({ achieved: yes, needs_user: no }, input)).toBe("met");
		expect(goalMet.policy({ achieved: unsure, needs_user: no }, input)).toBe("continue");
		expect(goalMet.policy({ achieved: no, needs_user: unsure }, input)).toBe("continue");
		// An open acceptance item, or an edit nothing ran after, is "not yet" whatever the message says.
		expect(goalMet.policy({ achieved: yes, needs_user: no }, { ...input, openItems: 1 })).toBe("continue");
		expect(goalMet.policy({ achieved: yes, needs_user: no }, { ...input, unverified: true })).toBe("continue");
		// A question to the user is never answered by working on.
		expect(goalMet.policy({ achieved: no, needs_user: yes }, { ...input, openItems: 3 })).toBe("ask");
		// Without a judge the facts still count, and the rest is the user's call.
		expect(goalMet.fallback({ ...input, openItems: 2 })).toBe("continue");
		expect(goalMet.fallback({ ...input, unverified: true })).toBe("continue");
		expect(goalMet.fallback(input)).toBe("unjudged");
	});

	it("sends the agent back to work until the judge reads the goal as met", async () => {
		const harness = await start(verdicts({ achieved: no, needs_user: no }, { achieved: yes, needs_user: no }));
		harness.setResponses([
			fauxAssistantMessage("I had a first look at the failing tests."),
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("Every test in packages/x passes now: 41 of 41."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("/goal every test in packages/x passes");
		await settled(harness, 1);

		expect(states(harness).map((state) => `${state.status}:${state.continuations}`)).toEqual([
			"active:0",
			"active:1",
			"met:1",
		]);
		const messages = sent(harness);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toContain("every test in packages/x passes");
		expect(messages[1]).toContain("not met yet");
		expect(messages[1]).toContain("continuation 1 of 20");
	});

	it("does not carry a check over to a goal set while it was reading", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let checks = 0;
		const harness = await start(async (request): Promise<Record<string, Answer>> => {
			if (!("achieved" in request.questions)) return {};
			checks++;
			if (checks === 1) {
				await gate;
				return { achieved: no, needs_user: no };
			}
			return { achieved: yes, needs_user: no };
		});
		harness.setResponses([
			fauxAssistantMessage("I had a look at the importer."),
			fauxAssistantMessage("The exporter writes UTF-8 now."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("/goal the importer handles empty files");
		await vi.waitFor(() => expect(checks).toBe(1), { timeout: 5000 });
		await harness.session.prompt("/goal the exporter writes UTF-8");
		release();
		await settled(harness, 1);

		expect(
			states(harness).map((state) => `${state.text.split(" ")[1]}:${state.status}:${state.continuations}`),
		).toEqual(["importer:active:0", "exporter:active:0", "exporter:met:0"]);
		// The first goal's "not yet" never became a continuation of the second.
		expect(sent(harness).some((message) => message.includes("not met yet"))).toBe(false);
	});

	it("gives its reasons in Chinese when the app is in Chinese", async () => {
		vi.stubEnv("MU_LANG", "zh-CN");
		const harness = await start(verdicts());
		harness.setResponses([
			fauxAssistantMessage("I think this is fine."),
			fauxAssistantMessage("As I said, this is fine."),
			fauxAssistantMessage("unused"),
		]);
		await harness.session.prompt("/goal the importer handles empty files");
		await settled(harness, 1);
		expect(states(harness).at(-1)).toMatchObject({
			status: "paused",
			reason: "代理连续 2 次什么都没做就停下了",
			// The same, for a client in a language mu has no words for.
			reasonCode: "idle",
			reasonParams: { runs: 2 },
		});
		// What the model reads stays in English.
		expect(sent(harness)[1]).toContain("not met yet");
	});

	it("stops by itself when the agent twice ends a run without doing anything", async () => {
		const harness = await start(verdicts());
		harness.setResponses([
			fauxAssistantMessage("I think this is fine."),
			fauxAssistantMessage("As I said, this is fine."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("/goal the importer handles empty files");
		await settled(harness, 1);

		const last = states(harness).at(-1);
		expect(last?.status).toBe("paused");
		expect(last?.reason).toContain("ended without the agent doing anything");
		expect(sent(harness)).toHaveLength(2);
	});

	it("waits when the agent needs the user, and goes on with a fresh allowance once they answer", async () => {
		const harness = await start(verdicts({ achieved: no, needs_user: yes }, { achieved: yes, needs_user: no }));
		harness.setResponses([
			fauxAssistantMessage("Which database should the importer write to, Postgres or SQLite?"),
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("The importer writes to Postgres and its tests pass."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("/goal the importer writes to the database");
		await settled(harness, 3);
		expect(states(harness).at(-1)).toMatchObject({ status: "paused", reason: "the agent needs something from you" });
		// Nothing was sent after the question: the agent is not told to keep going past it.
		expect(sent(harness)).toHaveLength(1);

		expect(states(harness).at(-1)?.reasonCode).toBe("needs_user");

		await harness.session.prompt("Postgres.");
		await settled(harness, 1);
		expect(states(harness).map((state) => state.status)).toEqual(["active", "paused", "active", "met"]);
		// A code belongs to the pause it explains, and goes with it.
		expect(
			states(harness)
				.slice(2)
				.map((state) => state.reasonCode),
		).toEqual([undefined, undefined]);
	});

	it("keeps to its allowance of continuations", async () => {
		const harness = await start(verdicts(), { goal: { maxContinuations: 1 } });
		harness.setResponses([
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("Three tests still fail."),
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("Two tests still fail."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("/goal every test passes");
		await settled(harness, 1);

		const last = states(harness).at(-1);
		expect(last).toMatchObject({ status: "paused", continuations: 1 });
		expect(last?.reason).toContain("reached the limit of 1 continuation");
		expect(last).toMatchObject({ reasonCode: "continuations_used_up", reasonParams: { max: 1 } });
	});

	it("goes by the facts alone when no judge is acted on, and leaves the rest to the user", async () => {
		let asked = 0;
		const harness = await start(
			(request): Record<string, Answer> => {
				if ("achieved" in request.questions) asked++;
				return "achieved" in request.questions ? { achieved: yes, needs_user: no } : {};
			},
			{ mode: "shadow" },
		);
		harness.setResponses([
			work("edit", { path: "src/importer.ts" }),
			fauxAssistantMessage("Done, empty files are skipped now."),
			work("bash", { command: "npm test -- importer" }),
			fauxAssistantMessage("The importer tests pass."),
			fauxAssistantMessage("unused"),
		]);

		await harness.session.prompt("/goal the importer handles empty files");
		await settled(harness, 1);

		// The edit nothing ran after is a fact: back to work, with the file named. The goal check speaks alone.
		const messages = sent(harness);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toContain("src/importer.ts");
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && (message as { customType?: string }).customType === "kyrn.nudge",
			),
		).toBe(false);
		// After the test ran nothing is provably unfinished, and a shadowed judge is recorded, not obeyed.
		expect(asked).toBe(2);
		const last = states(harness).at(-1);
		expect(last?.status).toBe("paused");
		expect(last?.reason).toContain("no judge");
	});

	it("pauses a goal that was running when the session closed, and tells the app why", async () => {
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(),
					mode: "active",
					config: parseConfig({ features: { memory: false, goal: { checker: "jev" } } }),
					only: ["goal"],
					onPresentation: (event) => events.push(event),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: { notify: () => undefined, setStatus: () => undefined } as unknown as ExtensionUIContext,
			mode: "tui",
		});
		harness.sessionManager.appendCustomEntry(GOAL_ENTRY, { status: "active", text: "ship it", continuations: 3 });
		await harness.session.reload();
		expect(events.filter((event) => event.kind === "goal.state").map((event) => event.payload)).toEqual([
			{
				status: "paused",
				text: "ship it",
				continuations: 3,
				reason: "the session was reopened",
				reasonCode: "session_reopened",
				maxContinuations: 20,
			},
		]);
		// Nothing is written: the session keeps what it had.
		expect(states(harness).map((state) => state.status)).toEqual(["active"]);
	});

	it("shows and clears the goal, and reads back only entries it wrote", async () => {
		const harness = await start(verdicts({ achieved: yes, needs_user: no }));
		harness.setResponses([fauxAssistantMessage("The README names the flag."), fauxAssistantMessage("unused")]);
		await harness.session.prompt("/goal the README names the new flag");
		await settled(harness, 1);
		await harness.session.prompt("/goal clear");
		expect(states(harness).map((state) => state.status)).toEqual(["active", "met", "cleared"]);

		expect(parseGoalEntry({ status: "active", text: "x", continuations: 2.7 })).toEqual({
			status: "active",
			text: "x",
			reason: undefined,
			continuations: 2,
		});
		expect(parseGoalEntry({ status: "running", text: "x" })).toBeUndefined();
		expect(parseGoalEntry({ status: "active", text: "  " })).toBeUndefined();
		expect(parseGoalEntry("active")).toBeUndefined();
		expect(describeGoal(undefined)).toContain("/goal <condition>");
		expect(
			describeGoal({ status: "paused", text: "ship it", reason: "you interrupted the run", continuations: 3 }),
		).toContain("you interrupted the run");
		expect(parseGoalEntry({ status: "active", text: "x", next: "run it", checkedBy: "model" })).toMatchObject({
			next: "run it",
			checkedBy: "model",
		});
		expect(parseGoalEntry({ status: "active", text: "x", checkedBy: "oracle" })?.checkedBy).toBeUndefined();
	});

	describe("checked by a model", () => {
		const CHECK = "You check, each time a coding agent stops working";
		/** The model's goal check: fails the test if the call is anything else, and keeps what it was asked. */
		const check =
			(reply: Record<string, unknown> | string, asked: string[] = []): FauxResponseFactory =>
			(context) => {
				const request = JSON.stringify(context.messages);
				if (!request.includes(CHECK)) throw new Error(`expected the goal check, got ${request.slice(0, 300)}`);
				asked.push(request);
				return fauxAssistantMessage(typeof reply === "string" ? reply : JSON.stringify(reply));
			};

		it("sends the agent back with the reason and the next step, until the model reads the evidence as met", async () => {
			let judged = 0;
			const harness = await start(
				(request): Record<string, Answer> => {
					if ("achieved" in request.questions) judged++;
					return {};
				},
				{ goal: { checker: "model" } },
			);
			const asked: string[] = [];
			harness.setResponses([
				work("bash", { command: "npm test" }),
				fauxAssistantMessage("Three tests still fail."),
				check(
					{ verdict: "continue", reason: "三个测试还在失败", next: "先修 parser 的空行用例", stalled: false },
					asked,
				),
				work("bash", { command: "npm test -- parser" }),
				fauxAssistantMessage("All 41 tests pass."),
				check({ verdict: "met", reason: "npm test 41 个全部通过", next: "", stalled: false }, asked),
				fauxAssistantMessage("unused"),
			]);

			await harness.session.prompt("/goal 所有测试通过");
			await settled(harness, 1);

			expect(
				states(harness).map((state) => `${state.status}:${state.continuations}:${state.checkedBy ?? "-"}`),
			).toEqual(["active:0:-", "active:1:model", "met:1:model"]);
			expect(states(harness)[1]).toMatchObject({ reason: "三个测试还在失败", next: "先修 parser 的空行用例" });
			expect(states(harness)[2].reason).toBe("npm test 41 个全部通过");
			const messages = sent(harness);
			expect(messages[1]).toContain("Why not yet: 三个测试还在失败");
			expect(messages[1]).toContain("Next: 先修 parser 的空行用例");
			// The model read the goal, the run's steps, the last check and the closing message; the judge was never asked.
			expect(asked[0]).toContain("所有测试通过");
			expect(asked[0]).toContain("bash npm test -> ok");
			expect(asked[0]).toContain("Last check `npm test` passed");
			expect(asked[0]).toContain("Three tests still fail.");
			expect(asked[1]).toContain("先修 parser 的空行用例");
			expect(judged).toBe(0);
		});

		it("keeps going on an edit nothing ran after, whatever the model says", async () => {
			const harness = await start(() => ({}), { goal: { checker: "model" } });
			harness.setResponses([
				work("edit", { path: "src/importer.ts" }),
				fauxAssistantMessage("Done."),
				check({ verdict: "met", reason: "it says done", stalled: false }),
				work("bash", { command: "npm test -- importer" }),
				fauxAssistantMessage("The importer tests pass."),
				check({ verdict: "met", reason: "the importer tests pass", stalled: false }),
				fauxAssistantMessage("unused"),
			]);
			await harness.session.prompt("/goal the importer handles empty files");
			await settled(harness, 1);
			expect(states(harness).map((state) => state.status)).toEqual(["active", "active", "met"]);
			expect(sent(harness)[1]).toContain("You edited src/importer.ts and nothing has run since");
		});

		it("waits with the model's reason when the agent needs the user", async () => {
			const harness = await start(() => ({}), { goal: { checker: "model" } });
			harness.setResponses([
				fauxAssistantMessage("Postgres or SQLite?"),
				check({ verdict: "needs_user", reason: "要你选数据库", stalled: false }),
				fauxAssistantMessage("unused"),
			]);
			await harness.session.prompt("/goal the importer writes to the database");
			await settled(harness, 1);
			expect(states(harness).at(-1)).toMatchObject({
				status: "paused",
				reason: "the agent needs something from you: 要你选数据库",
			});
			expect(sent(harness)).toHaveLength(1);
		});

		it("tells the agent to change course when it goes in circles, and pauses the second time", async () => {
			const harness = await start(() => ({}), { goal: { checker: "model" } });
			harness.setResponses([
				work("bash", { command: "npm test" }),
				fauxAssistantMessage("Still failing."),
				check({ verdict: "continue", reason: "same failure", next: "read the stack trace", stalled: true }),
				work("bash", { command: "npm test" }),
				fauxAssistantMessage("Still failing."),
				check({ verdict: "continue", reason: "the same test run again", next: "read it", stalled: true }),
				fauxAssistantMessage("unused"),
			]);
			await harness.session.prompt("/goal every test passes");
			await settled(harness, 1);
			expect(sent(harness)[1]).toContain("Do not repeat it: take a different approach.");
			const last = states(harness).at(-1);
			expect(last?.status).toBe("paused");
			expect(last?.reason).toContain("no progress in 2 runs in a row (the same test run again)");
			expect(last).toMatchObject({
				reasonCode: "no_progress",
				reasonParams: { runs: 2, detail: "the same test run again" },
			});
		});

		it("falls back to the judge when the model does not answer in the form asked", async () => {
			let judged = 0;
			const harness = await start(
				(request): Record<string, Answer> => {
					if (!("achieved" in request.questions)) return {};
					judged++;
					return { achieved: yes, needs_user: no };
				},
				{ goal: { checker: "model" } },
			);
			harness.setResponses([
				work("bash", { command: "npm test" }),
				fauxAssistantMessage("All tests pass."),
				check("I think the goal is probably met."),
				fauxAssistantMessage("unused"),
			]);
			await harness.session.prompt("/goal every test passes");
			await settled(harness, 1);
			expect(judged).toBe(1);
			expect(states(harness).at(-1)).toMatchObject({ status: "met", checkedBy: "jev" });
		});

		it("asks for the condition when /goal comes alone, and enters goal mode with the answer", async () => {
			const harness = await start(() => ({}), { goal: { checker: "model" } });
			const asked: string[] = [];
			const statuses: (string | undefined)[] = [];
			// pi spreads the UI context, so every method used has to be a real property.
			const known: Record<string, unknown> = {
				notify: () => undefined,
				input: async (title: string) => {
					asked.push(title);
					return "  the README names the flag  ";
				},
				setStatus: (key: string, text: string | undefined) => {
					if (key === "mu-goal") statuses.push(text);
				},
			};
			const ui = new Proxy(known, {
				get: (target, key) => (key in target ? target[key as string] : () => undefined),
			}) as unknown as ExtensionUIContext;
			await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
			harness.setResponses([
				work("bash", { command: "grep flag README.md" }),
				fauxAssistantMessage("The README names --flag."),
				check({ verdict: "met", reason: "README 里写了 --flag", stalled: false }),
				fauxAssistantMessage("unused"),
			]);
			await harness.session.prompt("/goal");
			await settled(harness, 1);
			expect(asked[0]).toContain("what must be true");
			expect(states(harness).map((state) => `${state.status}:${state.text}`)).toEqual([
				"active:the README names the flag",
				"met:the README names the flag",
			]);
			// Cleared when the session started with no goal, then set with it.
			expect(statuses).toEqual([undefined, "goal 0/20", "goal met"]);
		});

		it("builds the request from the run and reads only the reply it asked for", () => {
			const { steps, checks } = stepsOf([
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "a", name: "bash", arguments: { command: "npm test" } },
						{ type: "toolCall", id: "b", name: "edit", arguments: { path: "src/x.ts", newText: "y" } },
					],
				},
				{
					role: "toolResult",
					toolCallId: "a",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "FAIL x" }],
				},
				{ role: "toolResult", toolCallId: "b", toolName: "edit", isError: false, content: [] },
				{ role: "toolResult", toolCallId: "unknown", toolName: "bash", isError: false, content: [] },
			]);
			expect(steps).toEqual(["bash npm test -> error", "edit src/x.ts <- y -> ok"]);
			expect(checks).toEqual([{ command: "npm test", failed: true, output: "FAIL x" }]);

			const request = goalCheckRequest({
				goal: "tests pass",
				continuation: 2,
				maxContinuations: 20,
				previousNext: "fix x",
				openItems: ["A1 tests pass"],
				unverifiedFiles: ["src/x.ts"],
				lastCheck: checks[0],
				steps,
				finalMessage: "",
			});
			expect(request).toContain("CONTINUATION: 2 of at most 20");
			expect(request).toContain("NEXT STEP THE PREVIOUS CHECK NAMED:\nfix x");
			expect(request).toContain("- Open acceptance items: A1 tests pass");
			expect(request).toContain("- Edited with nothing run after the last edit: src/x.ts");
			expect(request).toContain("Last check `npm test` FAILED, ending with:\nFAIL x");
			expect(request).toContain("CLOSING MESSAGE:\n(empty)");

			expect(
				parseGoalJudgement('Sure: {"verdict": "continue", "reason": " r ", "next": " n ", "stalled": true} ok'),
			).toEqual({ verdict: "continue", reason: "r", next: "n", stalled: true });
			// A next step only belongs to "continue".
			expect(parseGoalJudgement('{"verdict": "met", "reason": "r", "next": "n"}')?.next).toBeUndefined();
			expect(parseGoalJudgement('{"verdict": "done"}')).toBeUndefined();
			expect(parseGoalJudgement("{not json}")).toBeUndefined();
			expect(parseGoalJudgement("no braces")).toBeUndefined();
		});
	});
});
