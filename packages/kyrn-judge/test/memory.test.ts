import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { DecisionEngine } from "../src/decision.ts";
import {
	memoryApplied,
	memoryCapture,
	memoryMerge,
	memoryOutcome,
	memoryRecallForTask,
	memoryWorth,
} from "../src/decisions/memory.ts";
import type { SwarmRunner } from "../src/extension/features/swarm.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { Judge } from "../src/judge.ts";
import { lessonLinesOf, parsePhrase, turnDigest } from "../src/memory/phrasing.ts";
import {
	foldLessons,
	LessonStore,
	neighbours,
	rankForRecall,
	readLessons,
	type StoredLesson,
	terms,
	writeLesson,
} from "../src/memory/store.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import { briefFor, briefMessage, knownLessons } from "../src/swarm/brief.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.9 };
const no: Answer = { type: "boolean", probability: 0.1 };
const pick = (choice: string, probability = 0.9): Answer => ({
	type: "choice",
	choice,
	probabilities: { [choice]: probability },
});

const dirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "mu-lessons-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A whole lesson as the second version writes one. */
function lesson(id: string, fields: Partial<StoredLesson> = {}): StoredLesson {
	return {
		id,
		kind: "correction",
		trigger: `when ${id} comes up`,
		lesson: `Do ${id}.`,
		scope: {},
		source: { origin: "user" },
		status: "active",
		uses: { recalled: 0, applied: 0 },
		created: "2026-09-20T00:00:00.000Z",
		updated: "2026-09-20T00:00:00.000Z",
		...fields,
	};
}

const seed = (path: string, lines: readonly unknown[]) =>
	writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));

function judged(responder: MockResponder) {
	const provider = new MockJudgeProvider(responder);
	return { provider, engine: new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "active" }) };
}

describe("the lessons file", () => {
	it("folds lines by id, reads first-version lines as active corrections, and survives what is broken", () => {
		const path = join(temp(), "lessons.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify({
					id: "v1",
					trigger: "running tests",
					lesson: "Use vitest --run.",
					cwd: "/p",
					created: "2026-09-20T00:00:00.000Z",
				}),
				"{not json",
				JSON.stringify(lesson("v2", { kind: "fact", lesson: "first wording", uses: { recalled: 1, applied: 0 } })),
				JSON.stringify({ id: "v2", lesson: "second wording", updated: "2026-09-22T00:00:00.000Z" }),
				// A malformed field is dropped, not the line and not the lesson.
				JSON.stringify({ id: "v2", uses: { recalled: 2, applied: "many" }, source: { origin: "model" } }),
				// A tombstone for a lesson that is not there brings nothing back.
				JSON.stringify({ id: "ghost", status: "retired" }),
				JSON.stringify({ id: "v1", status: "retired", kind: "nonsense" }),
				// Nothing to inject: not a lesson.
				JSON.stringify(lesson("v3", { scope: { cwd: "/q" }, lesson: "  " })),
			].join("\n"),
		);
		const lessons = readLessons(path);
		expect(lessons.map((each) => each.id)).toEqual(["v1", "v2"]);
		expect(lessons[0]).toEqual({
			id: "v1",
			kind: "correction",
			trigger: "running tests",
			lesson: "Use vitest --run.",
			scope: { cwd: "/p" },
			source: { origin: "user" },
			status: "retired",
			uses: { recalled: 0, applied: 0 },
			created: "2026-09-20T00:00:00.000Z",
			updated: "2026-09-20T00:00:00.000Z",
		});
		expect(lessons[1]).toMatchObject({
			kind: "fact",
			lesson: "second wording",
			source: { origin: "model" },
			uses: { recalled: 1, applied: 0 },
			updated: "2026-09-22T00:00:00.000Z",
		});
		// The file ends without a newline: what is appended starts a line of its own.
		writeLesson(path, { id: "v4", trigger: "x", lesson: "y" });
		expect(readLessons(path).map((each) => each.id)).toEqual(["v1", "v2", "v4"]);
		expect(
			foldLessons([
				{ id: "a", trigger: "t", lesson: "l" },
				{ id: "a", scope: {} },
			]),
		).toHaveLength(1);
	});

	it("reads the file as it grows, waits for a line still being written, and starts over when it is replaced", () => {
		const dir = temp();
		const path = join(dir, "lessons.jsonl");
		const store = new LessonStore(path);
		expect(store.all()).toEqual([]);
		store.write(lesson("a"));
		expect(store.all().map((each) => each.id)).toEqual(["a"]);
		appendFileSync(path, `${JSON.stringify({ id: "a", status: "retired" })}\n`);
		expect(store.get("a")?.status).toBe("retired");
		const line = JSON.stringify(lesson("b"));
		appendFileSync(path, line.slice(0, 20));
		expect(store.all().map((each) => each.id)).toEqual(["a"]);
		appendFileSync(path, `${line.slice(20)}\n`);
		expect(store.all().map((each) => each.id)).toEqual(["a", "b"]);
		// A last line without its newline counts, and counts once when the newline comes.
		appendFileSync(path, JSON.stringify({ id: "b", uses: { recalled: 3, applied: 1 } }));
		expect(store.get("b")?.uses).toEqual({ recalled: 3, applied: 1 });
		store.write({ id: "b", status: "superseded" });
		expect(store.get("b")).toMatchObject({ status: "superseded", uses: { recalled: 3, applied: 1 } });
		expect(readLessons(path).map((each) => each.status)).toEqual(["retired", "superseded"]);

		const other = join(dir, "other.jsonl");
		seed(other, [lesson("c")]);
		renameSync(other, path);
		expect(store.all().map((each) => each.id)).toEqual(["c"]);

		// Without a file, the lessons last as long as the session.
		const memory = new LessonStore(undefined);
		memory.write(lesson("m"));
		memory.write({ id: "m", status: "retired" });
		expect(memory.all()).toMatchObject([{ id: "m", status: "retired" }]);
	});

	it("offers recall the project's active lessons, the most followed first, then the latest", () => {
		const lessons = [
			lesson("old", { scope: { cwd: "/p" }, updated: "2026-09-20T00:00:00.000Z" }),
			lesson("followed", { scope: { cwd: "/p" }, uses: { recalled: 5, applied: 3 } }),
			lesson("new", { scope: { cwd: "/p" }, updated: "2026-09-22T00:00:00.000Z" }),
			lesson("everywhere", { updated: "2026-09-21T00:00:00.000Z" }),
			lesson("elsewhere", { scope: { cwd: "/other" }, uses: { recalled: 9, applied: 9 } }),
			lesson("retired", { scope: { cwd: "/p" }, status: "retired", uses: { recalled: 9, applied: 9 } }),
		];
		expect(rankForRecall(lessons, "/p", 10).map((each) => each.id)).toEqual(["followed", "new", "everywhere", "old"]);
		expect(rankForRecall(lessons, "/p", 2).map((each) => each.id)).toEqual(["followed", "new"]);
	});

	it("finds the kept lessons a new one shares the most words with, in Chinese too", () => {
		expect([...terms("不要用 npm test，会卡住")].sort()).toEqual(
			["npm", "test", "不要", "会卡", "卡住", "要用"].sort(),
		);
		// Filler and short words say nothing about what a lesson is about; punctuation is not part of a word.
		expect([...terms("When the tests run, use vitest --run.")].sort()).toEqual(["run", "tests", "use", "vitest"]);
		const kept = [
			lesson("commits", { trigger: "writing a commit message", lesson: "Use conventional commits." }),
			lesson("tests", { trigger: "running the tests", lesson: "Run them with vitest --run, never npm test." }),
			lesson("chinese", { trigger: "跑测试的时候", lesson: "不要用 npm test，会卡住。" }),
			lesson("elsewhere", { scope: { cwd: "/other" }, trigger: "running the tests", lesson: "Use npm test." }),
			lesson("retired", { status: "retired", trigger: "running the tests", lesson: "Use npm test." }),
		];
		const near = (text: string, limit = 6) =>
			neighbours({ trigger: text, lesson: text }, kept, "/p", limit).map((each) => each.id);
		expect(near("Run the tests with npm test")).toEqual(["tests", "chinese"]);
		expect(near("跑测试会卡住")).toEqual(["chinese"]);
		expect(near("Deploy on Fridays")).toEqual([]);
		expect(near("Run the tests with npm test", 1)).toEqual(["tests"]);
		expect(near("Run the tests with npm test", 0)).toEqual([]);
	});

	it("reads Lesson: lines out of a report, a writer's reply, and one turn as a digest", () => {
		const report = [
			"**Done**: changed src/report.ts:40",
			"- **Lessons**: one below",
			"Lesson: when the dev server port is taken -> start it with PORT=5174 npm run dev",
			"- **Lesson:** the fixtures folder is generated → run npm run fixtures before the tests",
			"  lesson: Keep the snapshot files sorted.",
			"The lesson: this line is prose, not a lesson.",
		].join("\n");
		expect(lessonLinesOf(report)).toEqual([
			{ trigger: "when the dev server port is taken", lesson: "start it with PORT=5174 npm run dev" },
			{ trigger: "the fixtures folder is generated", lesson: "run npm run fixtures before the tests" },
			{ trigger: "Keep the snapshot files sorted.", lesson: "Keep the snapshot files sorted." },
		]);
		expect(lessonLinesOf(report, 1)).toHaveLength(1);

		expect(parsePhrase('Sure: {"trigger": "npm test hangs", "lesson": "Run vitest --run instead."} Done.')).toEqual({
			trigger: "npm test hangs",
			lesson: "Run vitest --run instead.",
		});
		expect(parsePhrase("I would rather not.")).toBeUndefined();
		expect(parsePhrase('{"trigger": "", "lesson": "x"}')).toBeUndefined();

		const steps = Array.from({ length: 30 }, (_, index) => `bash: step ${index + 1} -> ok`);
		const digest = turnDigest({ request: "Make the tests pass", steps, dropped: 5, finalMessage: "They pass." });
		const lines = digest.split("\n");
		expect(lines[0]).toBe("user: Make the tests pass");
		expect(lines.slice(1, 7)).toEqual(steps.slice(0, 6).map((step) => `step: ${step}`));
		// 30 steps kept, 6 from the start and 14 from the end shown, and 5 more that were never kept.
		expect(lines[7]).toBe("(15 more steps)");
		expect(lines.at(-2)).toBe("step: bash: step 30 -> ok");
		expect(lines.at(-1)).toBe("assistant: They pass.");
	});
});

describe("the experience library's questions", () => {
	const kept = (count: number) =>
		Array.from({ length: count }, (_, index) => ({
			id: `e${index + 1}`,
			trigger: `t${index + 1}`,
			lesson: `l${index + 1}`,
		}));

	it("merge: one choice per neighbour with an escape, read as same, refines, contradicts or unrelated", async () => {
		const { provider, engine } = judged(() => ({
			merge_1: pick("same"),
			merge_2: pick("refines"),
			merge_3: pick("contradicts"),
			merge_4: pick("unrelated"),
			merge_5: pick("unclear"),
			// Split between two options: nothing is sure enough to act on.
			merge_6: { type: "choice", choice: "same", probabilities: { same: 0.45, refines: 0.4 } },
		}));
		const decision = await engine.decide(memoryMerge, {
			candidate: { trigger: "t", lesson: "l" },
			existing: kept(6),
		});
		expect(decision.outcome).toEqual(["same", "refines", "contradicts", "unrelated", "unrelated", "unrelated"]);
		const request = provider.calls[0] as JudgeRequest;
		expect(Object.keys(request.questions)).toEqual([
			"merge_1",
			"merge_2",
			"merge_3",
			"merge_4",
			"merge_5",
			"merge_6",
		]);
		expect(request.questions.merge_2).toMatchObject({
			instructions: "Compared with `candidate`, what is `existing_2`?",
		});
		const question = request.questions.merge_1;
		expect(question.type === "choice" && Object.keys(question.criteria)).toEqual([
			"same",
			"refines",
			"contradicts",
			"unrelated",
			"unclear",
		]);
		expect(request.state).toMatchObject({ candidate: "When: t\nDo: l", existing_1: "When: t1\nDo: l1" });
		// Nobody could compare them: the new lesson is stored as it is.
		const failing = judged(() => {
			throw new Error("down");
		});
		const fallback = await failing.engine.decide(memoryMerge, {
			candidate: { trigger: "t", lesson: "l" },
			existing: kept(2),
		});
		expect(fallback).toMatchObject({ source: "fallback", outcome: ["unrelated", "unrelated"] });
	});

	it("worth: a choice per candidate, with the project's instructions as the last field; only a sure pick counts", async () => {
		const { provider, engine } = judged(() => ({
			worth_1: pick("reusable"),
			worth_2: pick("one_off"),
			worth_3: pick("already_known"),
			worth_4: pick("reusable", 0.5),
		}));
		const lessons = [1, 2, 3, 4].map((n) => ({ trigger: `t${n}`, lesson: `l${n}` }));
		const decision = await engine.decide(memoryWorth, { lessons, projectInstructions: "AGENTS.md:\nUse pnpm." });
		expect(decision.outcome).toEqual(["reusable", "one_off", "already_known", "unclear"]);
		const request = provider.calls[0] as JudgeRequest;
		expect(Object.keys(request.state as object)).toEqual([
			"lesson_1",
			"lesson_2",
			"lesson_3",
			"lesson_4",
			"project_instructions",
		]);
		expect(request.questions.worth_1).toMatchObject({
			type: "choice",
			instructions: "What is `lesson_1` to a coding agent that works in this project later?",
		});
		const question = request.questions.worth_1;
		expect(question.type === "choice" && Object.keys(question.criteria)).toEqual([
			"reusable",
			"one_off",
			"already_known",
			"unclear",
		]);
		const none = await engine.decide(memoryWorth, { lessons: lessons.slice(0, 1), projectInstructions: "" });
		expect((provider.calls[1] as JudgeRequest).state).toMatchObject({ project_instructions: "(none)" });
		expect(none.outcome).toEqual(["reusable"]);
	});

	it("applied and outcome: booleans over the turn's digest, which comes last; unsure is neither", async () => {
		const { provider, engine } = judged(
			(request): Record<string, Answer> =>
				"way_out" in request.questions
					? { way_out: yes }
					: { applied_1: yes, applied_2: no, applied_3: { type: "boolean", probability: 0.5 } },
		);
		const applied = await engine.decide(memoryApplied, { lessons: kept(3), turnDigest: "user: x\nassistant: y" });
		expect(applied.outcome).toEqual({ applied: ["e1"], notApplied: ["e2"] });
		const appliedRequest = provider.calls[0] as JudgeRequest;
		expect(Object.keys(appliedRequest.state as object)).toEqual(["lesson_1", "lesson_2", "lesson_3", "turn_digest"]);
		expect(appliedRequest.questions.applied_2).toMatchObject({
			type: "boolean",
			instructions: "Judging by `turn_digest`, did the assistant do what `lesson_2` says?",
		});

		const outcome = await engine.decide(memoryOutcome, { trouble: "loop: bash: npm test -> error", turnDigest: "d" });
		expect(outcome.outcome).toBe("learn");
		const outcomeRequest = provider.calls[1] as JudgeRequest;
		expect(Object.keys(outcomeRequest.state as object)).toEqual(["trouble", "turn_digest"]);
		expect(outcomeRequest.questions.way_out).toMatchObject({
			instructions:
				"Judging by `turn_digest`, is the approach that finally worked different from the one the agent started with, which ran into `trouble`?",
		});
	});

	it("capture says which kind of lesson it is; recall over a task says it reads a task", async () => {
		const capture = async (correction: Answer, preference: Answer) =>
			(
				await judged(() => ({ correction, preference })).engine.decide(memoryCapture, {
					userMessage: "No, use pnpm here.",
					previousAssistantMessage: "Running npm install.",
				})
			).outcome;
		expect(await capture(yes, yes)).toBe("correction");
		expect(await capture(no, yes)).toBe("preference");
		expect(await capture(no, no)).toBe("skip");

		const { provider, engine } = judged(() => ({ lesson_0: yes, lesson_1: no }));
		const decision = await engine.decide(memoryRecallForTask, {
			task: "measure: Measure the report page",
			lessons: kept(2),
		});
		expect(decision.outcome).toEqual({ apply: ["e1"] });
		expect(provider.calls[0]).toMatchObject({
			state: { task: "measure: Measure the report page" },
			questions: { lesson_0: { type: "boolean", instructions: "Does this situation match `task`? t1" } },
		});
	});
});

describe("the experience library in a session", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => {
		// Only the fake model may answer a writer call: credentials in the shell must not make a real one usable.
		for (const name of [
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_OAUTH_TOKEN",
			"ANTHROPIC_API_KEY",
			"GEMINI_API_KEY",
			"OPENAI_API_KEY",
			// The messages below are the English ones.
			"MU_LANG",
			"KYRN_LANG",
		]) {
			vi.stubEnv(name, undefined);
		}
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	interface Setup {
		tools?: AgentTool[];
		only?: FeatureName[];
		features?: Record<string, unknown>;
		memory?: Record<string, unknown>;
		modes?: Record<string, string>;
		runner?: SwarmRunner;
	}

	async function start(responder: MockResponder, setup: Setup = {}) {
		const path = join(temp(), "lessons.jsonl");
		const events: KyrnPresentationEvent[] = [];
		const provider = new MockJudgeProvider(responder);
		const harness = await createHarness({
			tools: setup.tools,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					config: parseConfig({
						modes: setup.modes,
						features: { memory: { path, ...setup.memory }, ...setup.features },
					}),
					only: ["preflight", "memory", ...(setup.only ?? [])],
					onPresentation: (event) => events.push(event),
					swarmRunner: setup.runner,
				}),
			],
		});
		harnesses.push(harness);
		const notes: string[] = [];
		const known: Record<string, unknown> = {
			notify: (message: string) => notes.push(message),
			setStatus: () => undefined,
		};
		const ui = new Proxy(known, {
			get: (target, key) => (key in target ? target[key as string] : () => undefined),
		}) as unknown as ExtensionUIContext;
		await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		return {
			harness,
			notes,
			path,
			stored: () => readLessons(path),
			/** The payloads of one kind of presentation event, in order. */
			shown: (kind: KyrnPresentationEvent["kind"]) =>
				events.filter((event) => event.kind === kind).map((event) => event.payload),
			/** The judge requests that carried this question. */
			asked: (question: string) => provider.calls.filter((call) => question in call.questions),
		};
	}

	function tool(name: string, run: (params: Record<string, unknown>) => string): AgentTool {
		return {
			name,
			label: name,
			description: name,
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async (_id, params) => ({
				content: [{ type: "text", text: run((params ?? {}) as Record<string, unknown>) }],
				details: {},
			}),
		};
	}
	/** `npm test` never comes back in this project; vitest does. */
	const bash = () =>
		tool("bash", (params) => {
			if (String(params.command).includes("npm test")) throw new Error("npm test: the watcher never exits");
			return "Test Files 3 passed, Tests 41 passed";
		});
	const run = (command: string) =>
		fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
	/** The agent's replies in order; the call that puts a way out into words gets `writer`, whenever it comes. */
	const router =
		(agent: AssistantMessage[], writer: string, heard: string[]): FauxResponseFactory =>
		(context) => {
			const request = JSON.stringify(context.messages);
			if (request.includes("The agent ran into this")) {
				heard.push(request);
				return fauxAssistantMessage(writer);
			}
			return agent.shift() ?? fauxAssistantMessage("no more agent replies");
		};
	const WAY_OUT = JSON.stringify({
		trigger: "npm test starts a watcher that never exits here",
		lesson: "Run the tests with npx vitest --run.",
	});

	it("user: a correction becomes a lesson in the user's words, as a correction of this project", async () => {
		const session = await start(
			(request): Record<string, Answer> =>
				"correction" in request.questions ? { correction: yes, preference: no } : {},
		);
		session.harness.setResponses([fauxAssistantMessage("Running npm test."), fauxAssistantMessage("Understood.")]);
		await session.harness.session.prompt("Run the tests.");
		await session.harness.session.prompt("No, never use npm test here, it hangs.");
		await vi.waitFor(() => expect(session.stored()).toHaveLength(1));
		const [kept] = session.stored();
		expect(kept).toMatchObject({
			kind: "correction",
			trigger: "No, never use npm test here, it hangs.",
			lesson: "No, never use npm test here, it hangs.",
			scope: { cwd: session.harness.tempDir },
			source: { origin: "user", turn: 2 },
			status: "active",
			uses: { recalled: 0, applied: 0 },
		});
		expect(kept.source.session).toBeTruthy();
		expect(session.shown("memory.stored")).toEqual([kept]);
		// The first message has nothing before it to correct.
		expect(session.asked("correction")).toHaveLength(1);
	});

	it("outcome: a loop the turn got out of with a passing check becomes a workaround, asked once", async () => {
		const heard: string[] = [];
		const session = await start(
			(request): Record<string, Answer> => ("way_out" in request.questions ? { way_out: yes } : {}),
			{ tools: [bash()], only: ["monitor"] },
		);
		const agent = [
			run("npm test"),
			run("npm test"),
			run("npm test"),
			run("npx vitest --run"),
			fauxAssistantMessage("The tests pass with npx vitest --run; npm test starts a watcher."),
			fauxAssistantMessage("Nothing to do."),
		];
		session.harness.setResponses(Array.from({ length: 8 }, () => router(agent, WAY_OUT, heard)));
		await session.harness.session.prompt("Make the tests pass.");
		await vi.waitFor(() => expect(session.stored()).toHaveLength(1));

		expect(session.stored()[0]).toMatchObject({
			kind: "workaround",
			trigger: "npm test starts a watcher that never exits here",
			lesson: "Run the tests with npx vitest --run.",
			source: { origin: "outcome", turn: 1 },
		});
		const [asked] = session.asked("way_out");
		expect(session.asked("way_out")).toHaveLength(1);
		expect(asked.state).toMatchObject({ trouble: "loop: bash: npm test -> error" });
		const digest = String((asked.state as { turn_digest: string }).turn_digest);
		expect(digest).toContain("user: Make the tests pass.");
		expect(digest).toContain("step: bash: npm test -> error");
		expect(digest).toContain("step: bash: npx vitest --run -> ok");
		expect(digest).toContain("assistant: The tests pass with npx vitest --run");
		// The conversation's model phrased it, from what the judge was shown.
		expect(heard).toHaveLength(1);
		expect(heard[0]).toContain("loop: bash: npm test -> error");

		// A turn without trouble adds no question.
		await session.harness.session.prompt("Thanks.");
		expect(session.asked("way_out")).toHaveLength(1);
	});

	/** Answers the goal check with "met", and the outcome question with `wayOut`. */
	const goalMetAnd =
		(wayOut: Answer): MockResponder =>
		(request): Record<string, Answer> => {
			if ("achieved" in request.questions) return { achieved: yes, needs_user: no };
			return "way_out" in request.questions ? { way_out: wayOut } : {};
		};
	const withGoal = {
		tools: [bash()],
		only: ["monitor", "goal"] as FeatureName[],
		features: { goal: { checker: "jev" } },
	};

	it("outcome: a loop in a goal that the check reads as met is learned from too", async () => {
		const session = await start(goalMetAnd(yes), withGoal);
		const agent = [
			run("npm test"),
			run("npm test"),
			run("npm test"),
			// No check passes in this run: only the goal holding says the agent found its way out.
			run("cat package.json"),
			fauxAssistantMessage("Every test passes now."),
		];
		session.harness.setResponses(Array.from({ length: 6 }, () => router(agent, WAY_OUT, [])));
		await session.harness.session.prompt("/goal every test passes");
		await vi.waitFor(() => expect(session.stored()).toHaveLength(1), { timeout: 5000 });
		expect(session.stored()[0]).toMatchObject({ kind: "workaround", source: { origin: "outcome", turn: 1 } });
		expect(session.asked("achieved")).toHaveLength(1);
		expect(session.asked("way_out")).toHaveLength(1);
	});

	it("outcome: a turn that ends with a passing check and the goal met is asked about once", async () => {
		const session = await start(goalMetAnd(no), withGoal);
		const agent = [
			run("npm test"),
			run("npm test"),
			run("npm test"),
			run("npx vitest --run"),
			fauxAssistantMessage("Done."),
		];
		session.harness.setResponses(Array.from({ length: 6 }, () => router(agent, WAY_OUT, [])));
		await session.harness.session.prompt("/goal every test passes");
		await vi.waitFor(() => expect(session.asked("achieved")).toHaveLength(1), { timeout: 5000 });
		await vi.waitFor(() => expect(session.asked("way_out")).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(session.asked("way_out")).toHaveLength(1);
		// The judge saw no different way out: nothing is kept.
		expect(session.stored()).toEqual([]);
	});

	it("outcome: drift is no trouble to learn a way out of: it names no failing call", async () => {
		let checks = 0;
		const session = await start(
			(request): Record<string, Answer> => {
				// Drift at the first two checks only, which makes a steer: a check passes after it.
				if ("course" in request.questions) return { course: pick(++checks <= 2 ? "drift" : "on_track") };
				return "way_out" in request.questions ? { way_out: yes } : {};
			},
			{
				tools: [bash()],
				only: ["monitor"],
				features: { monitor: { every: 1, minMinutes: 0, stuckMinutes: 0 } },
				modes: { "turn.drift": "active" },
			},
		);
		const agent = [
			run("ls"),
			run("cat package.json"),
			run("npx vitest --run"),
			fauxAssistantMessage("The tests pass."),
		];
		session.harness.setResponses(Array.from({ length: 6 }, () => router(agent, WAY_OUT, [])));
		await session.harness.session.prompt("Make the tests pass.");
		// The monitor did flag drift and steer, after which a check passed.
		await vi.waitFor(() => expect(session.asked("course").length).toBeGreaterThan(0));
		const steers = session.harness.session.messages.filter(
			(message) => message.role === "custom" && (message as { customType?: string }).customType === "kyrn.steer",
		);
		expect(steers.length).toBeGreaterThan(0);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(session.asked("way_out")).toEqual([]);
		expect(session.stored()).toEqual([]);
	});

	it("model: remember keeps what the judge reads as reusable, and says why it keeps nothing else", async () => {
		const verdicts = [pick("reusable"), pick("one_off")];
		const session = await start(
			(request): Record<string, Answer> =>
				"worth_1" in request.questions ? { worth_1: verdicts.shift() ?? pick("unclear") } : {},
		);
		const remember = (trigger: string, text: string) =>
			fauxAssistantMessage([fauxToolCall("remember", { trigger, lesson: text })], { stopReason: "toolUse" });
		session.harness.setResponses([
			remember("the dev server does not start because port 5173 is taken", "Start it with PORT=5174 npm run dev."),
			remember("this bug", "The typo was on line 12."),
			fauxAssistantMessage("Noted."),
		]);
		await session.harness.session.prompt("Start the dev server.");

		expect(session.stored()).toEqual([
			expect.objectContaining({
				kind: "fact",
				trigger: "the dev server does not start because port 5173 is taken",
				lesson: "Start it with PORT=5174 npm run dev.",
				source: expect.objectContaining({ origin: "model" }),
			}),
		]);
		const results = session.harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => JSON.stringify(message));
		expect(results[0]).toContain("Stored: Start it with PORT=5174 npm run dev.");
		expect(results[1]).toContain("Not stored: the judge read it as mattering for this task only.");
		expect(session.asked("worth_1")[0].state).toEqual({
			lesson_1:
				"When: the dev server does not start because port 5173 is taken\nDo: Start it with PORT=5174 npm run dev.",
			project_instructions: "(none)",
		});
	});

	it("model: remember keeps a lesson the judge gave no verdict on, or could not tell about", async () => {
		// The model's call is a vote already. Only a judge that reads the lesson as not worth keeping turns it down.
		const verdicts: (Answer | undefined)[] = [undefined, pick("unclear")];
		const session = await start((request): Record<string, Answer> => {
			if (!("worth_1" in request.questions)) return {};
			const verdict = verdicts.shift();
			// No answer at all: the judge abstains, and the decision falls back.
			return verdict ? { worth_1: verdict } : {};
		});
		const remember = (trigger: string, text: string) =>
			fauxAssistantMessage([fauxToolCall("remember", { trigger, lesson: text })], { stopReason: "toolUse" });
		session.harness.setResponses([
			remember("the dev server does not start because port 5173 is taken", "Start it with PORT=5174 npm run dev."),
			remember("a migration fails with a lock timeout", "Stop the worker queue before migrating."),
			fauxAssistantMessage("Noted."),
		]);
		await session.harness.session.prompt("Start the dev server.");

		expect(session.stored().map((lesson) => lesson.lesson)).toEqual([
			"Start it with PORT=5174 npm run dev.",
			"Stop the worker queue before migrating.",
		]);
		const results = session.harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => JSON.stringify(message));
		expect(results[0]).toContain("Stored: Start it with PORT=5174 npm run dev.");
		expect(results[1]).toContain("Stored: Stop the worker queue before migrating.");
	});

	it("subagents: Lesson: lines of a report are judged together and the reusable ones kept", async () => {
		const session = await start(
			(request): Record<string, Answer> =>
				"worth_1" in request.questions ? { worth_1: pick("reusable"), worth_2: pick("one_off") } : {},
			{
				only: ["swarm"],
				features: { swarm: { isolation: "none", agentsDir: temp() } },
				runner: async () =>
					[
						"**Done**: the report page loads in 0.8 s.",
						"Lesson: when the report page is slow -> flush the redis query cache before measuring",
						"Lesson: the numbers above were measured on my machine",
					].join("\n"),
			},
		);
		session.harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("delegate", { tasks: [{ title: "measure", instructions: "Measure the report page" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Measured."),
		]);
		await session.harness.session.prompt("How fast is the report page?");
		await vi.waitFor(() => expect(session.stored()).toHaveLength(1));
		expect(session.stored()[0]).toMatchObject({
			kind: "fact",
			trigger: "when the report page is slow",
			lesson: "flush the redis query cache before measuring",
			source: { origin: "subagent" },
		});
		expect(session.asked("worth_1")).toHaveLength(1);
	});

	it("command: /remember keeps the user's words without asking whether they are worth it", async () => {
		const session = await start(() => ({}));
		await session.harness.session.prompt("/remember Always run the linter before committing.");
		expect(session.stored()).toEqual([
			expect.objectContaining({
				kind: "preference",
				trigger: "Always run the linter before committing.",
				lesson: "Always run the linter before committing.",
				source: expect.objectContaining({ origin: "command" }),
			}),
		]);
		expect(session.notes.at(-1)).toBe("Saved.");
		expect(session.asked("worth_1")).toHaveLength(0);
		// Word for word again: a rule, not a question.
		await session.harness.session.prompt("/remember always run the linter before   committing.");
		expect(session.stored()).toHaveLength(1);
		expect(session.asked("merge_1")).toHaveLength(0);
		expect(session.notes.at(-1)).toBe("Already saved: Always run the linter before committing.");
	});

	describe("merging before a lesson is stored", () => {
		const tests = (cwd: string) =>
			lesson("tests-lesson", {
				scope: { cwd },
				trigger: "running the tests",
				lesson: "Run the tests with npm test.",
				source: { origin: "user" },
			});
		const mergeWith =
			(verdict: string): MockResponder =>
			(request): Record<string, Answer> =>
				"merge_1" in request.questions ? { merge_1: pick(verdict) } : {};
		/** A session with one kept lesson about running the tests, in the session's own project. */
		const withTestsLesson = async (verdict: string) => {
			const session = await start(mergeWith(verdict));
			seed(session.path, [tests(session.harness.tempDir)]);
			return session;
		};

		it("same: nothing new is stored, the kept one counts as confirmed", async () => {
			const session = await withTestsLesson("same");
			await session.harness.session.prompt("/remember Use npm test to run the tests.");
			const [kept] = session.stored();
			expect(session.stored()).toHaveLength(1);
			expect(kept.updated > "2026-09-20T00:00:00.000Z").toBe(true);
			expect(kept.uses).toEqual({ recalled: 0, applied: 0 });
			expect(session.shown("memory.merged")).toEqual([
				{ id: expect.any(String), into: "tests-lesson", how: "same" },
			]);
			expect(session.notes.at(-1)).toBe("Already saved: Run the tests with npm test.");
			expect(session.asked("merge_1")[0].state).toEqual({
				candidate: "When: Use npm test to run the tests.\nDo: Use npm test to run the tests.",
				existing_1: "When: running the tests\nDo: Run the tests with npm test.",
			});
		});

		it("refines: the sharper lesson is stored and replaces the old one", async () => {
			const session = await withTestsLesson("refines");
			await session.harness.session.prompt("/remember Run the tests with npm test -- --run so they do not watch.");
			const [old, sharper] = session.stored();
			expect(old).toMatchObject({ id: "tests-lesson", status: "superseded" });
			expect(sharper).toMatchObject({ status: "active", supersedes: "tests-lesson", source: { origin: "command" } });
			expect(session.shown("memory.merged")).toEqual([{ id: "tests-lesson", into: sharper.id, how: "refines" }]);
			expect(session.notes.at(-1)).toBe("Saved. It replaces:\n- Run the tests with npm test.");
		});

		it("contradicts: the user's latest word retires the old lesson", async () => {
			const session = await withTestsLesson("contradicts");
			await session.harness.session.prompt("/remember Never run npm test here, use vitest --run.");
			const [old, latest] = session.stored();
			expect(old).toMatchObject({ id: "tests-lesson", status: "retired" });
			expect(latest).toMatchObject({ status: "active", lesson: "Never run npm test here, use vitest --run." });
			expect(latest.supersedes).toBeUndefined();
			expect(session.shown("memory.merged")).toEqual([{ id: "tests-lesson", into: latest.id, how: "contradicts" }]);
			expect(session.shown("memory.retired")).toEqual([{ id: "tests-lesson", reason: "contradicted" }]);
		});

		it("contradicts: the model's word does not retire the user's, and is not kept beside it", async () => {
			const session = await start((request): Record<string, Answer> => {
				if ("worth_1" in request.questions) return { worth_1: pick("reusable") };
				return "merge_1" in request.questions ? { merge_1: pick("contradicts") } : {};
			});
			seed(session.path, [tests(session.harness.tempDir)]);
			session.harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("remember", { trigger: "running the tests", lesson: "Run the tests with yarn test." })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Done."),
			]);
			await session.harness.session.prompt("Run the tests.");
			expect(session.stored()).toEqual([expect.objectContaining({ id: "tests-lesson", status: "active" })]);
			const result = session.harness.session.messages.find((message) => message.role === "toolResult");
			expect(JSON.stringify(result)).toContain("Not stored: it contradicts a kept lesson, which stands.");
			expect(session.shown("memory.merged")).toEqual([
				{ id: expect.any(String), into: "tests-lesson", how: "contradicts" },
			]);
			expect(session.shown("memory.retired")).toEqual([]);
		});

		it("unrelated, or no verdict: stored as it is", async () => {
			const session = await withTestsLesson("unrelated");
			await session.harness.session.prompt("/remember Run the linter before the tests.");
			expect(session.stored().map((each) => each.status)).toEqual(["active", "active"]);
			expect(session.shown("memory.merged")).toEqual([]);

			const unanswered = await start(() => ({}));
			seed(unanswered.path, [tests(unanswered.harness.tempDir)]);
			await unanswered.harness.session.prompt("/remember Run the tests twice before a release.");
			expect(unanswered.asked("merge_1")).toHaveLength(1);
			expect(unanswered.stored()).toHaveLength(2);
		});
	});

	it("recall: ranked candidates, the first places for the most followed, and each injection counted", async () => {
		const session = await start(
			(request): Record<string, Answer> =>
				"lesson_0" in request.questions ? { lesson_0: yes, lesson_1: yes, lesson_2: no, lesson_3: yes } : {},
			{ memory: { maxInjected: 2 } },
		);
		const cwd = session.harness.tempDir;
		seed(session.path, [
			lesson("old", {
				scope: { cwd },
				trigger: "old trigger",
				lesson: "Old lesson.",
				updated: "2026-09-20T00:00:00.000Z",
			}),
			lesson("followed", {
				scope: { cwd },
				trigger: "followed trigger",
				lesson: "Followed lesson.",
				uses: { recalled: 4, applied: 3 },
			}),
			lesson("new", {
				scope: { cwd },
				trigger: "new trigger",
				lesson: "New lesson.",
				updated: "2026-09-22T00:00:00.000Z",
			}),
			lesson("everywhere", {
				trigger: "everywhere trigger",
				lesson: "Everywhere lesson.",
				updated: "2026-09-21T00:00:00.000Z",
			}),
			lesson("elsewhere", { scope: { cwd: "/elsewhere" }, lesson: "Elsewhere lesson." }),
			lesson("retired", { scope: { cwd }, status: "retired", lesson: "Retired lesson." }),
		]);
		let seen = "";
		session.harness.setResponses([
			(context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("Done.");
			},
		]);
		await session.harness.session.prompt("Fix the login test.");

		const [asked] = session.asked("lesson_0");
		expect(Object.values(asked.questions).map((question) => question.instructions)).toEqual([
			"Does this situation match `user_message`? followed trigger",
			"Does this situation match `user_message`? new trigger",
			"Does this situation match `user_message`? everywhere trigger",
			"Does this situation match `user_message`? old trigger",
		]);
		// Three apply, two places: the most followed and the newest get them.
		expect(seen).toContain("Followed lesson.");
		expect(seen).toContain("New lesson.");
		expect(seen).not.toContain("Old lesson.");
		const byId = new Map(session.stored().map((each) => [each.id, each]));
		expect(byId.get("followed")?.uses).toMatchObject({ recalled: 5, applied: 3, lastRecalled: expect.any(String) });
		expect(byId.get("new")?.uses).toMatchObject({ recalled: 1, applied: 0 });
		expect(byId.get("old")?.uses).toEqual({ recalled: 0, applied: 0 });
		// Use accounting is not a change of the lesson.
		expect(byId.get("new")?.updated).toBe("2026-09-22T00:00:00.000Z");
		expect(session.shown("memory.recalled")).toEqual([{ ids: ["followed", "new"], turn: 1 }]);
	});

	it("applied: a lesson followed is counted, one recalled eight times and never followed retires", async () => {
		const session = await start((request): Record<string, Answer> => {
			if ("lesson_0" in request.questions) return { lesson_0: yes, lesson_1: yes, lesson_2: yes };
			// The candidates are ranked, the followed ones first: that is the order of the check too.
			return "applied_1" in request.questions ? { applied_1: yes, applied_2: no, applied_3: no } : {};
		});
		const cwd = session.harness.tempDir;
		seed(session.path, [
			lesson("unused", { scope: { cwd }, lesson: "Mention the changelog.", uses: { recalled: 7, applied: 0 } }),
			lesson("useful", {
				scope: { cwd },
				lesson: "Run the login test with vitest --run.",
				uses: { recalled: 2, applied: 1 },
			}),
			// Recalled often and not followed this time, but followed once: it stays.
			lesson("once", {
				scope: { cwd },
				lesson: "Clear the session store first.",
				uses: { recalled: 12, applied: 1 },
				updated: "2026-09-19T00:00:00.000Z",
			}),
		]);
		session.harness.setResponses([fauxAssistantMessage("I ran the login test with vitest --run and it passes.")]);
		await session.harness.session.prompt("Fix the login test.");
		await vi.waitFor(() => expect(session.shown("memory.retired")).toHaveLength(1));

		const byId = new Map(session.stored().map((each) => [each.id, each]));
		expect(byId.get("useful")).toMatchObject({ status: "active", uses: { recalled: 3, applied: 2 } });
		expect(byId.get("once")).toMatchObject({ status: "active", uses: { recalled: 13, applied: 1 } });
		expect(byId.get("unused")).toMatchObject({ status: "retired", uses: { recalled: 8, applied: 0 } });
		expect(session.shown("memory.applied")).toEqual([{ ids: ["useful"] }]);
		expect(session.shown("memory.retired")).toEqual([{ id: "unused", reason: "unused" }]);
		const [check] = session.asked("applied_1");
		expect(check.state).toMatchObject({
			lesson_1: "When: when useful comes up\nDo: Run the login test with vitest --run.",
			lesson_2: "When: when once comes up\nDo: Clear the session store first.",
			lesson_3: "When: when unused comes up\nDo: Mention the changelog.",
		});
		const digest = String((check.state as { turn_digest: string }).turn_digest);
		expect(digest).toBe(
			"user: Fix the login test.\nassistant: I ran the login test with vitest --run and it passes.",
		);
	});

	it("applied: switched off, or with retireAfter 0, nothing is retired", async () => {
		const recalledOften = (cwd: string) => [lesson("unused", { scope: { cwd }, uses: { recalled: 30, applied: 0 } })];
		const answers: MockResponder = (request): Record<string, Answer> => {
			if ("lesson_0" in request.questions) return { lesson_0: yes };
			return "applied_1" in request.questions ? { applied_1: no } : {};
		};

		const off = await start(answers, { memory: { applied: false } });
		seed(off.path, recalledOften(off.harness.tempDir));
		off.harness.setResponses([fauxAssistantMessage("Done.")]);
		await off.harness.session.prompt("Do it.");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(off.asked("applied_1")).toHaveLength(0);
		expect(off.stored()[0]).toMatchObject({ status: "active", uses: { recalled: 31, applied: 0 } });

		const keepAll = await start(answers, { memory: { retireAfter: 0 } });
		seed(keepAll.path, recalledOften(keepAll.harness.tempDir));
		keepAll.harness.setResponses([fauxAssistantMessage("Done.")]);
		await keepAll.harness.session.prompt("Do it.");
		await vi.waitFor(() => expect(keepAll.asked("applied_1")).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(keepAll.stored()[0]).toMatchObject({ status: "active", uses: { recalled: 31, applied: 0 } });
		expect(keepAll.shown("memory.retired")).toEqual([]);
	});

	it("/lessons lists this project's lessons, /lessons all the rest too, /forget retires one", async () => {
		const session = await start(() => ({}));
		const cwd = session.harness.tempDir;
		seed(session.path, [
			lesson("aaaa1111-mine", { scope: { cwd }, lesson: "Mine.", uses: { recalled: 4, applied: 2 } }),
			lesson("aaaa2222-retired", { scope: { cwd }, kind: "workaround", lesson: "Old.", status: "retired" }),
			lesson("bbbb3333-everywhere", { kind: "fact", lesson: "Everywhere." }),
			lesson("cccc4444-elsewhere", { scope: { cwd: "/elsewhere" }, lesson: "Elsewhere." }),
		]);
		await session.harness.session.prompt("/lessons");
		expect(session.notes.at(-1)).toBe("id · kind · recalled/followed · lesson\naaaa1111 · correction · 4/2 · Mine.");
		await session.harness.session.prompt("/lessons all");
		expect(session.notes.at(-1)).toBe(
			[
				"id · kind · recalled/followed · lesson",
				"aaaa1111 · correction · 4/2 · Mine.",
				"bbbb3333 · fact · 0/0 · Everywhere. (global)",
				"aaaa2222 · workaround · 0/0 · Old. (retired)",
			].join("\n"),
		);
		await session.harness.session.prompt("/forget aaaa");
		expect(session.notes.at(-1)).toContain("2 lessons start with aaaa; type more of the id:");
		await session.harness.session.prompt("/forget cccc");
		expect(session.notes.at(-1)).toBe("No lesson in this project starts with cccc.");
		await session.harness.session.prompt("/forget aaaa2");
		expect(session.notes.at(-1)).toContain("That lesson isn't active:");
		await session.harness.session.prompt("/forget AAAA1");
		expect(session.notes.at(-1)).toBe("Retired: Mine.");
		expect(session.shown("memory.retired")).toEqual([{ id: "aaaa1111-mine", reason: "forgotten" }]);
		await session.harness.session.prompt("/lessons");
		expect(session.notes.at(-1)).toContain("No lessons for this project yet.");
		// /remember alone lists them too, as it always did.
		await session.harness.session.prompt("/remember");
		expect(session.notes.at(-1)).toContain("No lessons for this project yet.");
	});

	it("subagents: a brief carries the lessons that apply to its task, without counting a use", async () => {
		const messages: string[] = [];
		const session = await start(
			(request): Record<string, Answer> =>
				"lesson_0" in request.questions && "task" in (request.state as object) ? { lesson_0: yes } : {},
			{
				only: ["swarm"],
				features: { swarm: { isolation: "none", agentsDir: temp() } },
				runner: async (task) => {
					messages.push(briefMessage(task.instructions, task.brief));
					return "Measured: 0.8 s.";
				},
			},
		);
		seed(session.path, [
			lesson("redis", {
				scope: { cwd: session.harness.tempDir },
				trigger: "measuring the report page",
				lesson: "Flush the redis query cache before measuring the report page.",
			}),
		]);
		session.harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("delegate", { tasks: [{ title: "measure", instructions: "Measure the report page" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Measured."),
		]);
		await session.harness.session.prompt("How fast is the report page?");

		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain(
			"Known lessons from earlier work in this project. Follow them where they apply:\n- Flush the redis query cache before measuring the report page.",
		);
		const forTask = session.asked("lesson_0").filter((call) => "task" in (call.state as object));
		expect(forTask[0]).toMatchObject({
			state: { task: "measure: Measure the report page" },
			questions: { lesson_0: { instructions: "Does this situation match `task`? measuring the report page" } },
		});
		expect(session.shown("memory.recalled")).toContainEqual({
			ids: ["redis"],
			turn: 1,
			task: "measure: Measure the report page",
		});
		expect(session.stored()[0].uses).toEqual({ recalled: 0, applied: 0 });

		// The same section, from the brief alone; nothing when nothing applies.
		const brief = { ...briefFor({ title: "t", instructions: "i" }, undefined), lessons: ["Do x."] };
		expect(briefMessage("i", brief)).toContain("Follow them where they apply:\n- Do x.");
		expect(knownLessons([])).toEqual([]);
	});

	it("subagents: each investigator of a hive gets the lessons for its angle, and its Lesson: lines come back", async () => {
		// The role files of this machine are not part of the test.
		const agentDir = temp();
		for (const name of ["PI_CODING_AGENT_DIR", "MU_CODING_AGENT_DIR", "KYRN_CODING_AGENT_DIR"])
			vi.stubEnv(name, agentDir);
		const instructions = new Map<string, string>();
		const session = await start(
			(request): Record<string, Answer> => {
				const task = (request.state as { task?: unknown }).task;
				if ("lesson_0" in request.questions && typeof task === "string")
					return { lesson_0: task.startsWith("Reproduce") ? yes : no };
				return "worth_1" in request.questions ? { worth_1: pick("reusable") } : {};
			},
			{
				only: ["hive"],
				runner: async (task, _assignment, _signal, env) => {
					const bee = env?.KYRN_HIVE_BEE ?? "";
					instructions.set(bee, task.instructions);
					return bee === "repro"
						? "Reproduced it.\nLesson: when login fails only in CI -> install tzdata in the image first"
						: "Nothing found.";
				},
			},
		);
		seed(session.path, [
			lesson("tz", {
				scope: { cwd: session.harness.tempDir },
				trigger: "reproducing a failure that happens in CI only",
				lesson: "Run the tests with TZ=UTC, as CI does.",
			}),
		]);
		session.harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("hive", {
						goal: "Login is flaky in CI only.",
						bees: [
							{ name: "repro", focus: "Reproduce the failure locally" },
							{ name: "history", focus: "Find the commit that introduced it" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("It is the timezone."),
		]);
		await session.harness.session.prompt("Why is login flaky?");
		await vi.waitFor(() => expect(session.stored()).toHaveLength(2));

		expect(instructions.get("repro")).toContain(
			"Known lessons from earlier work in this project. Follow them where they apply:\n- Run the tests with TZ=UTC, as CI does.",
		);
		expect(instructions.get("history")).not.toContain("Known lessons");
		expect(session.asked("lesson_0").map((call) => (call.state as { task?: string }).task)).toContain(
			"Reproduce the failure locally (part of: Login is flaky in CI only.)",
		);
		expect(session.stored()[1]).toMatchObject({
			kind: "fact",
			trigger: "when login fails only in CI",
			lesson: "install tzdata in the image first",
			source: { origin: "subagent" },
		});
	});

	it("inside a subagent it keeps nothing and offers no remember tool", async () => {
		vi.stubEnv("KYRN_SWARM_DEPTH", "1");
		const session = await start(() => ({}));
		expect(session.harness.session.getAllTools().map((each) => each.name)).not.toContain("remember");
		// Without the command, the words go to the model as a message.
		session.harness.setResponses([fauxAssistantMessage("Noted.")]);
		await session.harness.session.prompt("/remember Something.");
		expect(session.stored()).toEqual([]);
	});
});
