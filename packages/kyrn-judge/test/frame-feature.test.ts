import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { createHarness, createTestUiContext, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../coding-agent/test/utilities.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { registerForgetting } from "../src/extension/features/forgetting.ts";
import { CHECKLIST_STATUS, FRAME_ENTRY, FRAME_MESSAGE, registerFrame } from "../src/extension/features/frame.ts";
import { GOAL_ENTRY, registerGoal } from "../src/extension/features/goal.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { KyrnRuntime } from "../src/extension/runtime.ts";
import { constraintId, createFrame, type Frame, type FrameEntryData, type UnmergedText } from "../src/frame/frame.ts";
import { Judge } from "../src/judge.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";
import { attended } from "./attended.ts";

const GOAL = "Add cursor pagination to the users API";
const DB_RULE = "不要修改数据库";
const CORRECTION = `保留原方案。${DB_RULE}`;

const change = (choice: string, limit = "none"): Record<string, Answer> => ({
	change: { type: "choice", choice, probabilities: { [choice]: 0.95 } },
	limit: { type: "choice", choice: limit, probabilities: { [limit]: 0.95 } },
});
/** Answers `task.frame` with one verdict per user message, in order; everything else stays neutral. */
const verdicts =
	(...choices: (string | [string, string])[]): MockResponder =>
	(request) => {
		if (!("change" in request.questions)) return {};
		const next = choices.shift() ?? "none";
		return typeof next === "string" ? change(next) : change(...next);
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
	beforeEach(() => {
		// These sessions don't inherit the task or the control file of a subagent running the tests.
		for (const name of ["KYRN_SWARM_BRIEF", "KYRN_SWARM_CONSTRAINTS", "KYRN_SWARM_DEPTH", "KYRN_SWARM_CONTROL"]) {
			vi.stubEnv(name, undefined);
		}
	});
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
	});

	async function start(
		responder: MockResponder,
		extra: {
			mode?: DecisionMode;
			only?: FeatureName[];
			features?: Record<string, unknown>;
			tools?: AgentTool[];
			sessionManager?: SessionManager;
			/** Someone is at the session: what mu tells them of the checklist is kept in `told`. */
			ui?: boolean;
		} = {},
	) {
		const provider = new MockJudgeProvider(responder);
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			tools: extra.tools,
			sessionManager: extra.sessionManager,
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
		const told: string[] = [];
		/** The footer's line about the checklist, each time it was written; null when it was taken down. */
		const footer: (string | null)[] = [];
		if (extra.ui) {
			const ui = createTestUiContext({
				notify: (message) => {
					if (message.startsWith("mu: this task's checklist")) told.push(message);
				},
				setStatus: (key, text) => {
					if (key === CHECKLIST_STATUS) footer.push(text ?? null);
				},
			});
			await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		}
		const updates = () => events.filter((event) => event.kind === "frame.updated");
		return {
			harness,
			told,
			footer,
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
			{ schema: 2, reason: "created", frame: { version: 1, source: "first-message" } },
		]);
		// A rewind to a user message ends the branch before it, so the entry has to come after that message.
		const branch = harness.sessionManager.getBranch();
		const frameAt = branch.findIndex((entry) => entry.type === "custom" && entry.customType === FRAME_ENTRY);
		const userAt = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userAt).toBeGreaterThanOrEqual(0);
		expect(frameAt).toBeGreaterThan(userAt);
	});

	it("does not enforce a later one-time rename even if the writer proposes it as both task and limit", async () => {
		const rename = "Rename agents.md to AGENTS.md.";
		const { harness, entries } = await start(
			(request): Record<string, Answer> =>
				"change" in request.questions
					? {
							...change("none"),
							// A split work verdict, as on the original turn. It doesn't authorize a limit.
							change: { type: "choice", choice: "subgoal", probabilities: { subgoal: 0.45, new_task: 0.42 } },
						}
					: {},
		);
		harness.setResponses([
			fauxAssistantMessage("Ready."),
			writerReply({ current_subgoal: rename, constraints: [rename] }),
			fauxAssistantMessage("Renamed."),
		]);
		await harness.session.prompt(GOAL);
		await harness.session.prompt(rename);
		expect(entries().at(-1)?.frame).toMatchObject({
			source: "writer",
			change: "unclear",
			currentSubgoal: rename,
			constraints: [],
		});
	});

	async function startLegacy(
		texts: readonly string[],
		responder: MockResponder,
		options: { mode?: DecisionMode; constraints?: Frame["constraints"] } = {},
	) {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: GOAL, timestamp: 0 });
		const unmerged = texts.map((text, index) => ({
			text,
			turn: index + 2,
			entryId: sessionManager.appendMessage({ role: "user", content: text, timestamp: index + 1 }),
			reason: "failed",
			change: "constraint",
		}));
		const frame = { ...createFrame({ text: GOAL, turn: 1 }), constraints: options.constraints ?? [] };
		sessionManager.appendCustomEntry(FRAME_ENTRY, { schema: 1, reason: "stale", frame, unmerged });
		const session = await start(responder, { only: ["frame"], sessionManager, mode: options.mode });
		await session.harness.session.bindExtensions({ mode: "rpc" });
		return { ...session, legacyIds: unmerged.map(({ entryId }) => entryId) };
	}

	it.each(["writer", "rules"])("reclassifies a restored non-heuristic limit once on retry via %s", async (source) => {
		const rule = "Limit edits to the fixture directory.";
		const { harness, shown, frameCalls, legacyIds } = await startLegacy([rule], verdicts(["none", "add"]));
		expect(shown()).toMatchObject({ reason: "restored", unmerged: [{ text: rule, change: "constraint" }] });
		expect(frameCalls()).toHaveLength(0);
		harness.setResponses([
			source === "writer" ? writerReply({ constraints: [] }) : fauxAssistantMessage("not JSON"),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Still here."),
		]);
		await harness.session.prompt("Continue.");
		expect(shown()).toMatchObject({
			unmerged: [],
			frame: { source, constraints: [{ text: rule, source: { turn: 2, entryId: legacyIds[0] } }] },
		});
		await harness.session.prompt("Still there?");
		expect(frameCalls().map(({ state }) => state)).toMatchObject([
			{ user_message: rule },
			{ user_message: "Continue." },
			{ user_message: "Still there?" },
		]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not add a restored one-off rename even if the retry writer quotes it", async () => {
		const rename = "Rename agents.md to AGENTS.md.";
		const { harness, shown, frameCalls } = await startLegacy([rename], verdicts("subgoal"));
		harness.setResponses([writerReply({ constraints: [rename] }), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Continue.");
		expect(frameCalls()[0].state).toMatchObject({ user_message: rename });
		expect(shown()).toMatchObject({ reason: "updated", unmerged: [], frame: { source: "writer", constraints: [] } });
	});

	it.each(["writer", "rules"])("a current withdrawal beats a recovered legacy limit via %s", async (source) => {
		const rule = "Limit edits to the fixture directory.";
		const lift = "Lift the fixture-only limit.";
		const keep = "Do not edit schema.sql.";
		const mixed = `Review pagination. ${keep}`;
		const { harness, shown, frameCalls, legacyIds } = await startLegacy([rule, mixed], (request) => {
			const { user_message } = request.state as { user_message: string };
			return user_message === rule
				? change("none", "add")
				: user_message === mixed
					? change("subgoal", "add")
					: change("none", "withdraw_1");
		});
		harness.setResponses([
			source === "writer" ? writerReply({ constraints: [rule, mixed, keep] }) : fauxAssistantMessage("not JSON"),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt(lift);
		expect(frameCalls()).toHaveLength(3);
		expect(frameCalls()[2].state).toMatchObject({
			user_message: lift,
			task_frame: {
				constraints: [
					{ position: 1, text: rule },
					{ position: 2, text: keep },
				],
			},
		});
		expect(shown()).toMatchObject({
			unmerged: [],
			frame: { source, constraints: [{ text: keep, source: { turn: 3, entryId: legacyIds[1] } }] },
		});
	});

	it.each(["withdraw_1", "replace_1", "once_1"])(
		"does not replay historical %s as a new limit change",
		async (limit) => {
			const constraints = [{ text: "Always ask before committing.", source: { turn: 1 } }];
			const { harness, shown, frameCalls } = await startLegacy(
				["Commit this version instead."],
				verdicts(["none", limit]),
				{ constraints },
			);
			harness.setResponses([writerReply({}), fauxAssistantMessage("Ready.")]);
			await harness.session.prompt("Continue.");
			expect(frameCalls()[0].questions.limit.criteria).toHaveProperty(limit);
			expect(shown()).toMatchObject({ unmerged: [], frame: { constraints } });
		},
	);

	it.each(["off", "shadow"] as const)("does not rejudge legacy rows in %s mode", async (mode) => {
		const { harness, shown, frameCalls } = await startLegacy(
			["Limit edits to the fixture directory."],
			verdicts(["none", "add"]),
			{ mode },
		);
		harness.setResponses([fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Continue.");
		expect(frameCalls().map(({ state }) => state)).toMatchObject(
			mode === "off" ? [] : [{ user_message: "Continue." }],
		);
		expect(shown()?.frame.constraints).toEqual([]);
	});

	it("a withdrawal survives a failed writer and its retry without becoming a second rule", async () => {
		const rename = "Rename agents.md to AGENTS.md";
		const keep = "Do not modify the database.";
		vi.stubEnv("KYRN_SWARM_CONSTRAINTS", JSON.stringify([rename, keep]));
		const { harness, entries } = await start(verdicts(["correction", "withdraw_1"], "none"));
		harness.setResponses([
			fauxAssistantMessage("Ready."),
			fauxAssistantMessage("not JSON"),
			fauxAssistantMessage("Understood."),
			writerReply({ constraints: [rename] }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt(GOAL);
		await harness.session.prompt("The rename is complete. Remove it from constraints and return to pagination.");
		const failed = entries().at(-1);
		expect(failed?.reason).toBe("stale");
		expect(failed?.frame.constraints.map((rule) => rule.text)).toEqual([keep]);
		expect(failed?.unmerged).toMatchObject([{ change: "correction", reason: "failed" }]);
		expect(failed?.unmerged[0].limit).toBeUndefined();
		await harness.session.prompt("Go on.");
		expect(entries().at(-1)?.unmerged).toEqual([]);
		expect(
			entries()
				.at(-1)
				?.frame.constraints.map((rule) => rule.text),
		).toEqual([keep]);
	});

	it.each(["succeeds", "fails"])(
		"runs the authorized implementation when the pending edit ban's writer retry %s",
		async (retry) => {
			const review = "Review the pagination design first.";
			const keep = "Never edit schema.sql.";
			// The condition is beyond the compact view's 200 characters. Its target is the entire quote.
			const ban = `Do not edit ${Array.from({ length: 9 }, (_, i) => `src/pagination/page-${i}.ts`).join(", ")} until I authorize implementation.`;
			const authorization = "I authorize implementation now. Update src/pagination/page-0.ts.";
			const { harness, entries, frameCalls } = await start(
				(request): Record<string, Answer> => {
					if ("change" in request.questions) {
						const { user_message, task_frame } = request.state as {
							user_message: string;
							task_frame: { constraints: { text: string; position: number }[] };
						};
						if (user_message !== authorization) return change("subgoal", "add");
						const target = task_frame.constraints.find(({ text }) => text === ban);
						return change("subgoal", target ? `withdraw_${target.position}` : "none");
					}
					const { tool_call } = request.state as { tool_call: string };
					return Object.fromEntries(
						Object.entries(request.questions).map(([id, question]) => {
							const rule = String(question.instructions);
							const violates = rule.includes(ban) || (rule.includes(keep) && tool_call.includes("schema.sql"));
							const choice = violates ? "violates" : "compatible";
							return [id, { type: "choice", choice, probabilities: { [choice]: 0.95 } }];
						}),
					);
				},
				{ only: ["frame", "constraints"] },
			);
			const write = (path: string) =>
				fauxAssistantMessage([fauxToolCall("write", { path, content: "updated" }, { id: path })], {
					stopReason: "toolUse",
				});
			harness.setResponses([
				fauxAssistantMessage("Ready."),
				fauxAssistantMessage("not JSON"),
				fauxAssistantMessage("Reviewed."),
				retry === "succeeds"
					? writerReply({ constraints: [ban], current_subgoal: "Implement pagination." })
					: fauxAssistantMessage("not JSON"),
				write("src/pagination/page-0.ts"),
				write("schema.sql"),
				fauxAssistantMessage("Done."),
			]);
			await harness.session.prompt(GOAL);
			await harness.session.prompt(`${review} ${keep} ${ban}`);
			expect(entries().at(-1)).toMatchObject({ reason: "stale", frame: { constraints: [] } });
			await harness.session.prompt(authorization);

			expect(
				harness.session.messages
					.filter((m) => m.role === "toolResult")
					.map(({ toolCallId, isError }) => [toolCallId, isError]),
			).toEqual([
				["src/pagination/page-0.ts", false],
				["schema.sql", true],
			]);
			expect(frameCalls()).toHaveLength(2);
			expect(frameCalls()[1]).toMatchObject({
				state: {
					task_frame: {
						current_subgoal: review,
						constraints: [
							{ position: 1, text: keep },
							{ position: 2, text: ban },
						],
					},
				},
				questions: { limit: { criteria: { withdraw_2: expect.any(String) } } },
			});
			expect(entries().at(-2)?.unmerged[0]).toMatchObject({
				reason: "failed",
				withdrawnQuoteIds: [constraintId(ban)],
			});
			expect(entries().at(-1)).toMatchObject({
				frame: {
					source: retry === "succeeds" ? "writer" : "rules",
					constraints: [{ text: keep, source: { turn: 2 } }],
				},
				unmerged: [],
			});
		},
	);

	it("/frame remove withdraws only the named rule, survives restore, and needs neither model", async () => {
		const rename = "Rename agents.md to AGENTS.md";
		const keep = "Do not modify fixture 12.";
		vi.stubEnv("KYRN_SWARM_CONSTRAINTS", JSON.stringify([rename, keep]));
		const { harness, entries, provider, shown } = await start(verdicts(), { mode: "off" });
		harness.setResponses([fauxAssistantMessage("Ready.")]);
		await harness.session.prompt(GOAL);
		const before = harness.sessionManager.getLeafId() ?? "";
		await harness.session.prompt("/frame remove unknown");
		await harness.session.prompt("/frame remove 00000000");
		const ambiguous = constraintId(rename)[0];
		expect(constraintId(keep)).toMatch(new RegExp(`^${ambiguous}`));
		await harness.session.prompt(`/frame remove ${ambiguous}`);
		expect(entries()).toHaveLength(1);
		await harness.session.prompt(`/frame remove ${constraintId(rename).slice(0, 8)}`);
		const after = harness.sessionManager.getLeafId() ?? "";
		expect(
			entries()
				.at(-1)
				?.frame.constraints.map((rule) => rule.text),
		).toEqual([keep]);
		expect(entries()[0].frame.constraints.map((rule) => rule.text)).toEqual([rename, keep]);
		await harness.session.navigateTree(before);
		expect(shown()?.frame.constraints.map((rule) => rule.text)).toEqual([rename, keep]);
		await harness.session.navigateTree(after);
		expect(shown()?.frame.constraints.map((rule) => rule.text)).toEqual([keep]);
		expect(provider.calls).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("persists /frame remove after a writer update from /goal, without an ordinary user message", async () => {
		const condition = `Review pagination. ${DB_RULE}`;
		const { harness, entries, shown } = await start(
			(request): Record<string, Answer> =>
				"change" in request.questions
					? change("subgoal", "add")
					: {
							achieved: { type: "boolean", probability: 0.01 },
							needs_user: { type: "boolean", probability: 0.99 },
						},
			{ only: ["frame", "goal"], features: { goal: { checker: "jev" } } },
		);
		const notify = vi.fn();
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify }), mode: "rpc" });
		const reply: FauxResponseFactory = (context) =>
			JSON.stringify(context.messages).includes("CURRENT FRAME:")
				? writerReply({ constraints: [DB_RULE], current_subgoal: "Review pagination." })
				: fauxAssistantMessage("Which endpoint?");
		harness.setResponses([reply, reply, reply]);
		await harness.session.prompt(`/goal ${GOAL}`);
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("goal paused"), "warning"));
		notify.mockClear();
		await harness.session.prompt(`/goal ${condition}`);
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("goal paused"), "warning"));
		await vi.waitFor(() => expect(shown()?.frame.source).toBe("writer"));
		const branch = harness.sessionManager.getBranch();
		expect(branch.some((entry) => entry.type === "message" && entry.message.role === "user")).toBe(false);
		const origin = branch.find(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === GOAL_ENTRY &&
				(entry.data as { text: string }).text === condition,
		);
		expect(origin).toBeDefined();
		expect(entries().at(-1)?.frame.constraints).toEqual([
			{ text: DB_RULE, source: { turn: 2, entryId: origin?.id } },
		]);
		const before = harness.sessionManager.getLeafId() ?? "";
		await harness.session.prompt(`/frame remove ${constraintId(DB_RULE)}`);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("no longer active"), "info");
		const after = harness.sessionManager.getLeafId() ?? "";
		expect(after).not.toBe(before);
		await harness.session.navigateTree(before);
		expect(shown()?.frame.constraints.map(({ text }) => text)).toEqual([DB_RULE]);
		await harness.session.navigateTree(after);
		expect(shown()).toMatchObject({
			reason: "restored",
			frame: { constraints: [], currentSubgoal: "Review pagination." },
		});
	});

	it.each(["message", "/goal"])(
		"restores a new task and withdrawal from %s while its writer is outstanding",
		async (source) => {
			vi.stubEnv("KYRN_SWARM_CONSTRAINTS", JSON.stringify([DB_RULE]));
			const { harness, entries, shown } = await start(
				(request): Record<string, Answer> =>
					"change" in request.questions
						? change("new_task", "withdraw_1")
						: {
								achieved: { type: "boolean", probability: 0.99 },
								needs_user: { type: "boolean", probability: 0.01 },
							},
				{ only: ["frame", "goal"], features: { frame: { waitMs: 20 }, goal: { checker: "jev" } } },
			);
			const writer = Promise.withResolvers<ReturnType<typeof writerReply>>();
			const reply: FauxResponseFactory = (context) =>
				JSON.stringify(context.messages).includes("CURRENT FRAME:")
					? writer.promise
					: fauxAssistantMessage("Working.");
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("todo", { action: "add", text: "Check the cursor" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Ready."),
				reply,
				reply,
			]);
			try {
				await harness.session.prompt(GOAL);
				const before = harness.sessionManager.getLeafId() ?? "";
				const task = "Lift the database rule. Instead, fix the CSS.";
				await harness.session.prompt(source === "/goal" ? `/goal ${task}` : task);
				await vi.waitFor(() => {
					expect(entries().at(-1)?.frame.constraints).toEqual([]);
					expect(harness.session.isStreaming).toBe(false);
				});
				const after = harness.sessionManager.getLeafId() ?? "";
				if (source === "/goal") {
					const branch = harness.sessionManager.getBranch();
					const origin = branch.findIndex((entry) => entry.type === "custom" && entry.customType === GOAL_ENTRY);
					const frame = branch.findLastIndex(
						(entry) => entry.type === "custom" && entry.customType === FRAME_ENTRY,
					);
					expect(origin).toBeGreaterThanOrEqual(0);
					expect(frame).toBeGreaterThan(origin);
				}
				await harness.session.navigateTree(before);
				expect(shown()?.frame.acceptance).toMatchObject([{ text: "Check the cursor" }]);
				await harness.session.navigateTree(after);
				expect(shown()).toMatchObject({
					reason: "restored",
					frame: { goal: expect.stringContaining("fix the CSS"), acceptance: [], constraints: [] },
				});
			} finally {
				writer.resolve(writerReply({ goal: "Fix the CSS" }));
			}
		},
	);

	it("bounds a stalled writer and a queued removal without retrying an already applied new task", async () => {
		const keep = "Never edit schema.sql.";
		vi.stubEnv("KYRN_SWARM_CONSTRAINTS", JSON.stringify([DB_RULE, keep]));
		const { harness, entries } = await start(verdicts(["new_task", "withdraw_1"]), {
			only: ["frame"],
			features: { frame: { waitMs: 20, writerTimeoutMs: 250 } },
		});
		const notify = vi.fn();
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify }), mode: "rpc" });
		const writer = Promise.withResolvers<ReturnType<typeof writerReply>>();
		harness.setResponses([
			fauxAssistantMessage("Ready."),
			() => writer.promise,
			fauxAssistantMessage("Working."),
			fauxAssistantMessage("Still working."),
		]);
		try {
			await harness.session.prompt(GOAL);
			await harness.session.prompt("Lift the database rule. Fix the CSS instead.");
			const provisional = entries().at(-1);
			expect(provisional).toMatchObject({ reason: "updated", frame: { source: "rules" }, unmerged: [] });
			await harness.session.prompt(`/frame remove ${constraintId(keep)}`);
			expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("still updating"), "warning");
			await vi.waitFor(async () => {
				await harness.session.prompt("/frame");
				expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("writer timed out"), "info");
			});
			await harness.session.prompt("Continue.");
			expect(entries().at(-1)).toEqual(provisional);
			expect(
				entries()
					.at(-1)
					?.frame.constraints.map(({ text }) => text),
			).toEqual([keep]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			writer.resolve(writerReply({ goal: "A late writer reply" }));
		}
	});

	it.each(["stored", "pending"])(
		"/frame remove withdraws a %s quote without losing its pending sibling on restore and retry",
		async (target) => {
			const stale = "Do not edit the spec.";
			const pending = "Never publish the draft.";
			vi.stubEnv("KYRN_SWARM_CONSTRAINTS", JSON.stringify(target === "stored" ? [stale] : []));
			const { harness, entries, frameCalls } = await start(verdicts(["none", "add"], "none"));
			const notify = vi.fn();
			await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify }), mode: "rpc" });
			harness.setResponses([
				fauxAssistantMessage("Ready."),
				fauxAssistantMessage("not JSON"),
				fauxAssistantMessage("Understood."),
				writerReply({ constraints: [stale, pending] }),
				fauxAssistantMessage("Done."),
			]);
			await harness.session.prompt(GOAL);
			await harness.session.prompt(`${stale} ${pending}`);
			expect(entries().at(-1)?.reason).toBe("stale");
			const before = harness.sessionManager.getLeafId() ?? "";
			await harness.session.prompt("/frame");
			expect(notify).toHaveBeenLastCalledWith(expect.stringContaining(`${constraintId(stale)} "${stale}"`), "info");
			await harness.session.prompt(`/frame remove ${constraintId(stale).slice(0, 8)}`);
			const after = harness.sessionManager.getLeafId() ?? "";
			expect(entries().at(-1)).toMatchObject({
				frame: { constraints: [] },
				unmerged: [{ reason: "failed", limit: { kind: "add" }, withdrawnQuoteIds: [constraintId(stale)] }],
			});
			await harness.session.navigateTree(before);
			await harness.session.navigateTree(after);
			await harness.session.prompt("/frame");
			expect(notify).toHaveBeenLastCalledWith(expect.not.stringContaining(constraintId(stale)), "info");
			expect(notify).toHaveBeenLastCalledWith(
				expect.stringContaining(`${constraintId(pending)} "${pending}"`),
				"info",
			);
			expect(frameCalls()).toHaveLength(1);
			await harness.session.prompt("Continue.");
			expect(
				entries()
					.at(-1)
					?.frame.constraints.map((rule) => rule.text),
			).toEqual([pending]);
		},
	);

	it("takes the person's own words as the goal when a host put its rules in front of the first message", async () => {
		const { harness, shown, entries } = await start(verdicts("none"));
		harness.setResponses([fauxAssistantMessage("On it.")]);

		await harness.session.prompt(
			`[Assistant Rules]\n## Available Skills\n- **aionui-config**: Configure AionUi.\n[/Assistant Rules]\n\n${GOAL}`,
		);

		expect(shown()).toMatchObject({ reason: "created", frame: { version: 1, goal: GOAL } });
		expect(entries()).toMatchObject([{ reason: "created", frame: { version: 1, goal: GOAL } }]);
	});

	it("a correction with a new limit keeps only the user's quoted limit and tells the model", async () => {
		const { harness, shown, entries, notes, records } = await start(verdicts(["correction", "add"], "none"));
		let writerSaw = "";
		let agentSaw = "";
		harness.setResponses([
			fauxAssistantMessage("I will add a cursor column to the users table."),
			(context) => {
				writerSaw = JSON.stringify(context.messages);
				return writerReply({ constraints: [DB_RULE], acceptance: [{ text: "no migration is added" }] });
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
		expect(writerSaw).toContain("work: correction, limit:");
		const frame = shown()?.frame;
		expect(frame).toMatchObject({ version: 2, goal: GOAL, source: "writer", change: "correction", updatedTurn: 2 });
		expect(frame?.constraints.map((constraint) => constraint.text)).toEqual([DB_RULE]);
		expect(frame?.acceptance).toMatchObject([{ id: "a1", text: "no migration is added", done: false }]);
		expect(frame?.constraints.map((constraint) => constraint.text)).not.toContain(CORRECTION);
		// The note rides along with the message that caused it, and the model reads it.
		expect(notes()).toHaveLength(1);
		expect(notes()[0]).toContain("[mu task frame v2]");
		expect(agentSaw).toContain(`\\"${DB_RULE}\\" (turn 2)`);
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

	it("keeps one-call permission only for its input, even when the next mid-run input is intercepted", async () => {
		const rule = "Always ask before committing.";
		const permit = "Commit this version now.";
		const delayed = "Commit my next change once.";
		vi.stubEnv("KYRN_SWARM_CONSTRAINTS", JSON.stringify([rule]));
		const judge = Promise.withResolvers<Record<string, Answer>>();
		const provider = new MockJudgeProvider((request) =>
			(request.state as { user_message: string }).user_message === delayed
				? judge.promise
				: change("subgoal", "once_1"),
		);
		let runtime!: KyrnRuntime;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					runtime = new KyrnRuntime(pi, parseConfig({}), new Judge({ provider }));
					// Like interjection answering a status question: later features never receive this input.
					pi.on("input", (event) => (event.text === "status?" ? { action: "handled" } : undefined));
					registerFrame(runtime);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Ready."),
			fauxAssistantMessage("not JSON"),
			fauxAssistantMessage("Understood."),
			writerReply({ current_subgoal: delayed }),
		]);
		await harness.session.prompt(GOAL);
		const first = harness.sessionManager.getLeafId() ?? "";
		await harness.session.prompt(`[Assistant Rules]Host text[/Assistant Rules]\n${permit}`);
		expect(runtime.framePermissionOnce).toEqual({ id: constraintId(rule), userMessage: permit, turn: 2 });
		expect(runtime.frame?.constraints.map(({ text }) => text)).toEqual([rule]);
		expect(runtime.frameState?.unmerged[0]).toMatchObject({ change: "subgoal", reason: "failed" });
		expect(runtime.frameState?.unmerged[0].limit).toBeUndefined();
		const granted = harness.sessionManager.getLeafId() ?? "";
		const input = (text: string) =>
			harness.session.extensionRunner.emitInput(text, undefined, "interactive", "steer");
		await input(delayed);
		expect(runtime.framePermissionOnce).toBeUndefined();
		expect((await input("status?")).action).toBe("handled");
		judge.resolve(change("subgoal", "once_1"));
		await vi.waitFor(() => expect(runtime.frame?.currentSubgoal).toBe(delayed));
		expect(runtime.framePermissionOnce).toBeUndefined();
		await harness.session.navigateTree(first);
		await harness.session.navigateTree(granted);
		expect(runtime.frameState?.unmerged).toMatchObject([{ change: "subgoal", text: permit }]);
		expect(runtime.frame?.constraints.map(({ text }) => text)).toEqual([rule]);
		expect(runtime.framePermissionOnce).toBeUndefined();
	});

	it("only a direct user message can grant once, not a re-sent prompt, command description or /goal text", async () => {
		const rule = "Always ask before committing.";
		const permit = "Commit this version now.";
		vi.stubEnv("KYRN_SWARM_CONSTRAINTS", JSON.stringify([rule]));
		const provider = new MockJudgeProvider(
			(request): Record<string, Answer> =>
				"change" in request.questions
					? change("subgoal", "once_1")
					: {
							achieved: { type: "boolean", probability: 0.99 },
							needs_user: { type: "boolean", probability: 0.01 },
						},
		);
		let runtime!: KyrnRuntime;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					runtime = new KyrnRuntime(
						pi,
						parseConfig({ features: { goal: { checker: "jev" } } }),
						new Judge({ provider }),
					);
					registerFrame(runtime);
					registerGoal(runtime);
					pi.registerCommand("fake-template", { description: permit, handler: async () => {} });
				},
			],
		});
		harnesses.push(harness);
		const goalReply: FauxResponseFactory = (context) =>
			JSON.stringify(context.messages).includes("CURRENT FRAME:")
				? writerReply({ current_subgoal: "goal command" })
				: fauxAssistantMessage("Working.");
		harness.setResponses([
			fauxAssistantMessage("Ready."),
			writerReply({ current_subgoal: "extension send" }),
			writerReply({ current_subgoal: "command description" }),
			goalReply,
			goalReply,
			writerReply({ current_subgoal: "direct input" }),
		]);
		await harness.session.prompt(GOAL);

		const input = harness.session.extensionRunner;
		await input.emitInput(permit, undefined, "extension", "steer");
		await vi.waitFor(() => expect(runtime.frame?.currentSubgoal).toBe("extension send"));
		expect(runtime.framePermissionOnce).toBeUndefined();
		await input.emitInput("/fake-template", undefined, "interactive");
		expect(runtime.frame?.currentSubgoal).toBe("command description");
		expect(runtime.framePermissionOnce).toBeUndefined();
		expect(provider.calls[1].state).toMatchObject({ user_message: permit });

		await harness.session.sendUserMessage(`/goal ${permit}`, { expandPromptTemplates: true });
		await vi.waitFor(() => expect(runtime.frame?.currentSubgoal).toBe("goal command"));
		expect(runtime.framePermissionOnce).toBeUndefined();

		await input.emitInput(permit, undefined, "rpc", "steer");
		await vi.waitFor(() => expect(runtime.frame?.currentSubgoal).toBe("direct input"));
		expect(runtime.framePermissionOnce).toMatchObject({ id: constraintId(rule), userMessage: permit });
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
		const choices = ["add", "none"];
		const { harness, provider, shown, entries } = await start(
			(request): Record<string, Answer> => {
				if ("change" in request.questions) return change("none", choices.shift() ?? "none");
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
		await harness.session.prompt("只看 format 模块");

		expect(shown()).toMatchObject({ reason: "stale", stale: true, frame: { version: 1 } });
		expect(shown()?.unmerged).toMatchObject([{ reason: "failed", limit: { kind: "add" }, turn: 2 }]);
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
		const { harness, shown } = await start(verdicts(["correction", "add"], "none"));
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
		expect(shown()?.frame.constraints).toMatchObject([{ text: DB_RULE, source: { turn: 2 } }]);
	});

	it("tells the model again after a compaction, which drops mu's own notes", async () => {
		const { harness, notes } = await start(verdicts(["correction", "add"], "none", "none"));
		harness.setResponses([
			fauxAssistantMessage("I will add a cursor column."),
			writerReply({ constraints: [DB_RULE] }),
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
		expect(notes().at(-1)).toContain(DB_RULE);
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
				judged: { change: "correction", limit: { kind: "none" } },
				outcome: { change: "none", limit: { kind: "none" } },
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
		const { harness, shown } = await start(verdicts(["correction", "add"]));
		harness.setResponses([
			fauxAssistantMessage("I will add a cursor column."),
			writerReply({ constraints: [DB_RULE] }),
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
		expect(shown()?.frame.constraints[0].text).toBe(DB_RULE);
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

	describe("when a run has ended", () => {
		const call = (params: Record<string, string>) =>
			fauxAssistantMessage([fauxToolCall("todo", params)], { stopReason: "toolUse" });

		it("tells the user where the checklist stands, once for each change of it", async () => {
			const { harness, told, footer } = await start(verdicts(), { ui: true });
			harness.setResponses([
				call({ action: "add", text: "the cursor survives a deleted row" }),
				call({ action: "add", text: "limit is capped at 100" }),
				call({ action: "done", id: "a1", evidence: "users.test.ts: 14 passed" }),
				fauxAssistantMessage("The cursor is in. The cap comes next."),
			]);
			await harness.session.prompt(GOAL);
			expect(told).toEqual([
				[
					"mu: this task's checklist, 1 of 2 done (the evidence is the agent's own):",
					"  [x] the cursor survives a deleted row · users.test.ts: 14 passed",
					"  [ ] limit is capped at 100",
				].join("\n"),
			]);

			// While the run went, the footer had the count at each step: written when it changed, and only then.
			expect(footer).toEqual(["Checklist 0/1", "Checklist 0/2", "Checklist 1/2"]);

			// A run that changes nothing on the list says nothing more about it.
			harness.setResponses([fauxAssistantMessage("Yes, by id.")]);
			await harness.session.prompt("Is the cursor ordered by id?");
			expect(told).toHaveLength(1);
			expect(footer).toHaveLength(3);

			harness.setResponses([
				call({ action: "done", id: "a2", evidence: "limit=500 returns 100 rows" }),
				fauxAssistantMessage("Capped."),
			]);
			await harness.session.prompt("Go on with the cap.");
			expect(told).toHaveLength(2);
			expect(told[1].split("\n")).toEqual([
				"mu: this task's checklist, 2 of 2 done (the evidence is the agent's own):",
				"  [x] the cursor survives a deleted row · users.test.ts: 14 passed",
				"  [x] limit is capped at 100 · limit=500 returns 100 rows",
			]);
		});

		it("says nothing of a task without a checklist, nor with `report` off", async () => {
			const bare = await start(verdicts(), { ui: true });
			bare.harness.setResponses([fauxAssistantMessage("Done.")]);
			await bare.harness.session.prompt(GOAL);
			expect(bare.told).toEqual([]);
			expect(bare.footer).toEqual([]);

			const off = await start(verdicts(), { ui: true, features: { frame: { report: false } } });
			off.harness.setResponses([
				call({ action: "add", text: "limit is capped at 100" }),
				fauxAssistantMessage("Noted."),
			]);
			await off.harness.session.prompt(GOAL);
			expect(off.told).toEqual([]);
		});

		it("with nothing ticked, lists what is open and claims no evidence", async () => {
			const { harness, told } = await start(verdicts(), { ui: true });
			harness.setResponses([
				call({ action: "add", text: "limit is capped at 100" }),
				fauxAssistantMessage("That is what is left to do."),
			]);
			await harness.session.prompt(GOAL);
			expect(told).toEqual(["mu: this task's checklist, 0 of 1 done:\n  [ ] limit is capped at 100"]);
		});
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
			writerReply({ constraints: [DB_RULE] }),
			fauxAssistantMessage("Third."),
		]);
		await harness.session.prompt(GOAL);
		await harness.session.prompt(CORRECTION);

		// The turn ran on version 1; nothing was told to the model yet.
		expect(shown()?.frame.version).toBe(1);
		expect(notes()).toEqual([]);

		release(change("correction", "add"));
		await vi.waitFor(() => expect(shown()?.frame.version).toBe(2));
		expect(updates().at(-1)?.turnId).toBe(2);
		expect(shown()?.frame.updatedTurn).toBe(2);
		// The ledger says the turn had stopped waiting for it; the frame used it all the same.
		const asked = harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "custom" && entry.customType === "kyrn.decision" ? [entry.data] : []))
			.map((data) => data as { specId: string; source: string; late?: boolean })
			.filter((record) => record.specId === "task.frame");
		expect(asked).toMatchObject([{ source: "judge", late: true }]);

		// The next message carries the note.
		await harness.session.prompt("and now?");
		release(change("none"));
		expect(notes()).toHaveLength(1);
		expect(notes()[0]).toContain(DB_RULE);
	});
});
