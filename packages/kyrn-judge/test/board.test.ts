import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import {
	addModelHelp,
	boardModelChoices,
	otherModelChoices,
	RECOMMENDED_BOARD_MODELS,
	SESSION_MODEL,
} from "../src/board/model.ts";
import {
	capWords,
	duration,
	labelOf,
	languageOf,
	narratorRequest,
	narratorSystem,
	parseBoardText,
	plainBoard,
	rulesHeadline,
	tidy,
} from "../src/board/narrate.ts";
import { type BoardNote, noteText, parseBoardNote, reasonTail, shortPath } from "../src/board/notes.ts";
import { BoardProjects } from "../src/board/projects.ts";
import { parseConfig } from "../src/config.ts";
import {
	asksSomething,
	type BoardEvent,
	type BoardInput,
	type BoardReading,
	type BoardStep,
	boardRead,
	keyByRule,
	MAX_EVENTS,
	phaseByRule,
} from "../src/decisions/board-read.ts";
import {
	BOARD_ENTRY,
	type BoardUpdate,
	boardWidget,
	describeBoard,
	describeSwarmCall,
	describeSwarms,
	failureExcerpt,
	firstLine,
	parseBoardEntry,
	swarmNames,
	swarmState,
} from "../src/extension/features/board.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import { SwarmRun } from "../src/swarm/run.ts";
import { type BeeState, newBee } from "../src/swarm/state.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.96 };
const no: Answer = { type: "boolean", probability: 0.03 };
const unsure: Answer = { type: "boolean", probability: 0.5 };
const choice = (option: string): Answer => ({ type: "choice", choice: option, probabilities: { [option]: 0.9 } });

const step = (tool: string, what: string, failed = false, check = false): BoardStep => ({ tool, what, failed, check });
const input = (extra: Partial<BoardInput> = {}): BoardInput => ({
	goal: "the importer skips empty files",
	items: [],
	steps: [],
	latest: "",
	ended: false,
	...extra,
});

const temporary: string[] = [];
afterEach(() => {
	while (temporary.length > 0) rmSync(temporary.pop() as string, { recursive: true, force: true });
});

describe("board reading", () => {
	it("tells the phase by rule from the last step, or from how the run ended", () => {
		expect(phaseByRule(input())).toBe("understanding");
		expect(phaseByRule(input({ steps: [step("read", "src/a.ts")] }))).toBe("understanding");
		expect(phaseByRule(input({ steps: [step("edit", "src/a.ts")] }))).toBe("changing");
		expect(phaseByRule(input({ steps: [step("bash", "npm test", false, true)] }))).toBe("checking");
		expect(phaseByRule(input({ steps: [step("bash", "npm test", true, true)] }))).toBe("fixing");
		// An edit after a failed check is the fix.
		expect(phaseByRule(input({ steps: [step("bash", "npm test", true, true), step("edit", "src/a.ts")] }))).toBe(
			"fixing",
		);
		expect(phaseByRule(input({ ended: true, latest: "Postgres or SQLite？" }))).toBe("waiting");
		expect(phaseByRule(input({ ended: true, latest: "Done: the importer skips empty files." }))).toBe("wrapping_up");
		expect(asksSomething("Which one?  ")).toBe(true);
		expect(asksSomething("用哪个？")).toBe(true);
		expect(asksSomething("It works.")).toBe(false);
	});

	it("asks about the focus only among several open items, about change only after a first board, and whether the user is needed only once the agent stopped", () => {
		const one = boardRead.questionsFor?.(input({ items: [{ id: "A1", text: "skips empty files", done: false }] }));
		expect(Object.keys(one ?? {}).sort()).toEqual(["phase"]);
		const stopped = boardRead.questionsFor?.(
			input({ items: [{ id: "A1", text: "skips empty files", done: false }], ended: true }),
		);
		expect(Object.keys(stopped ?? {}).sort()).toEqual(["needs_user", "phase"]);
		const many = boardRead.questionsFor?.(
			input({
				items: [
					{ id: "A1", text: "skips empty files", done: false },
					{ id: "A2", text: "logs a warning", done: false },
					{ id: "A3", text: "has a test", done: true },
				],
				last: { phase: "changing", now: "Changing the code." },
			}),
		);
		expect(Object.keys(many ?? {}).sort()).toEqual(["changed", "focus", "phase"]);
		const focus = many?.focus;
		expect(focus?.type === "choice" ? Object.keys(focus.criteria) : []).toEqual(["A1", "A2", "none"]);
	});

	it("writes the board again only when something changed, and always when the user is needed", () => {
		const last = { phase: "changing" as const, focus: "A1", now: "Changing the code." };
		const items = [
			{ id: "A1", text: "skips empty files", done: false },
			{ id: "A2", text: "logs a warning", done: false },
		];
		const read = (answers: Record<string, Answer>, extra: Partial<BoardInput> = {}) =>
			boardRead.policy(answers as never, input({ items, last, ...extra })) as BoardReading;
		expect(read({ phase: choice("changing"), focus: choice("A1"), needs_user: no, changed: no }).update).toBe(false);
		expect(read({ phase: choice("checking"), focus: choice("A1"), needs_user: no, changed: no })).toMatchObject({
			phase: "checking",
			update: true,
		});
		expect(read({ phase: choice("changing"), focus: choice("A2"), needs_user: no, changed: no }).update).toBe(true);
		// Unsure means write it when something happened or the run ended: a board one update late is worse than one
		// update too many.
		const unsureNow = { phase: choice("changing"), focus: choice("A1"), changed: unsure };
		expect(read(unsureNow, { events: [{ kind: "step", text: "edit a.ts -> ok" }] }).update).toBe(true);
		expect(read({ ...unsureNow, needs_user: no }, { ended: true }).update).toBe(true);
		// With nothing new (a look on the clock while sub-agents work), unsure is no reason to write the same board.
		expect(read(unsureNow).update).toBe(false);
		expect(read({ ...unsureNow, changed: yes }).update).toBe(true);
		expect(
			read({ phase: choice("changing"), focus: choice("A1"), needs_user: yes, changed: no }, { ended: true }),
		).toMatchObject({
			needsUser: true,
			update: true,
		});
		// Mid-run a wait is a permission request, on the board by rule: the judge's word is not taken for it.
		expect(read({ phase: choice("changing"), focus: choice("A1"), needs_user: yes, changed: no })).toMatchObject({
			needsUser: false,
			update: false,
		});
		// A phase nobody could tell falls back to the rule.
		expect(read({ phase: choice("other"), needs_user: no, changed: no }, { steps: [step("edit", "a")] }).phase).toBe(
			"changing",
		);
		expect(boardRead.fallback(input({ ended: true, latest: "Which one?" }))).toMatchObject({
			phase: "waiting",
			needsUser: true,
			update: true,
		});
	});

	const said = (text: string): BoardEvent => ({ kind: "said", text });
	const did = (text: string, extra: Partial<BoardEvent> = {}): BoardEvent => ({ kind: "step", text, ...extra });

	it("asks about each thing that happened, as news or routine, and shows them numbered", () => {
		const events = [did("edit src/a.ts -> ok"), said("Found it: empty files crash the parser."), did("x", {})];
		const questions = boardRead.questionsFor?.(input({ events })) ?? {};
		expect(Object.keys(questions).filter((id) => id.startsWith("event_"))).toEqual(["event_0", "event_1", "event_2"]);
		const first = questions.event_0;
		expect(first?.type === "choice" ? Object.keys(first.criteria) : []).toEqual(["key", "routine", "unclear"]);
		expect((boardRead.buildState(input({ events })) as Record<string, unknown>).events).toBe(
			"1. edit src/a.ts -> ok\n2. the agent said: Found it: empty files crash the parser.\n3. x",
		);
		// Only the latest are weighed.
		const many = Array.from({ length: MAX_EVENTS + 4 }, (_, index) => did(`step ${index}`));
		expect(
			Object.keys(boardRead.questionsFor?.(input({ events: many })) ?? {}).filter((id) => id.startsWith("event_")),
		).toHaveLength(MAX_EVENTS);
	});

	it("gives the writer the news the judge picked, and writes for news even when the phase did not change", () => {
		const last = { phase: "changing" as const, now: "Changing the code." };
		const events = [
			did("edit a.ts -> ok"),
			said("Found it: the parser chokes on empty files."),
			did("edit b.ts -> ok"),
		];
		const read = (answers: Record<string, Answer>) =>
			boardRead.policy(answers as never, input({ last, events })) as BoardReading;
		const quiet = { phase: choice("changing"), needs_user: no, changed: no };
		expect(
			read({ ...quiet, event_0: choice("routine"), event_1: choice("key"), event_2: choice("routine") }),
		).toMatchObject({ key: [1], update: true });
		expect(
			read({ ...quiet, event_0: choice("routine"), event_1: choice("routine"), event_2: choice("routine") }),
		).toMatchObject({ key: [], update: false });
		// "Cannot tell" about every one: the rule picks, and that alone is no reason to write.
		const unclear = { type: "choice", choice: "unclear" } as Answer;
		expect(read({ ...quiet, event_0: unclear, event_1: unclear, event_2: unclear })).toMatchObject({
			key: [1],
			update: false,
		});
	});

	it("sums up a run that did work once it ends, but not a chat reply", () => {
		const last = { phase: "wrapping_up" as const, now: "Summing up." };
		const quiet = { phase: choice("wrapping_up"), needs_user: no, changed: no };
		const read = (events: BoardEvent[]) =>
			boardRead.policy(quiet as never, input({ last, events, ended: true })) as BoardReading;
		expect(read([did("edit a.ts -> ok"), said("Done.")]).update).toBe(true);
		expect(read([said("Hello! What should I look at?")]).update).toBe(false);
	});

	it("can tell a wait on something other than the person, and sees what is in flight and why a step failed", () => {
		expect(boardRead.version).toBe(5);
		const questions = boardRead.questionsFor?.(input({ last: { phase: "checking", now: "Testing." } })) ?? {};
		const phase = questions.phase;
		expect(phase?.type === "choice" ? Object.keys(phase.criteria) : []).toContain("blocked");
		expect(phase?.instructions).toContain("`in_flight`");
		expect(questions.changed?.instructions).toContain("a subagent back, failed or stuck");
		const state = boardRead.buildState(
			input({
				steps: [{ ...step("bash", "npm test", true, true), detail: "expected 3 attempts, received 2" }],
				inFlight: ["main agent: bash `npm run e2e` running for 3 min"],
				events: [{ kind: "step", text: "bash npm test -> error", failed: true, detail: "expected 3, received 2" }],
			}),
		) as Record<string, unknown>;
		expect(state.steps).toBe('bash npm test -> error: "expected 3 attempts, received 2"');
		expect(state.in_flight).toBe("main agent: bash `npm run e2e` running for 3 min");
		expect(state.events).toBe('1. bash npm test -> error: "expected 3, received 2"');
		// Without a judge, a stall is a wait on something else.
		expect(phaseByRule(input({ steps: [step("bash", "npm run e2e")], stalled: true }))).toBe("blocked");
		expect(phaseByRule(input({ ended: true, stalled: true }))).toBe("wrapping_up");
	});

	it("picks by rule what a person would miss when the judge cannot: failures, checks, items done, the last word", () => {
		expect(
			keyByRule([
				did("edit a.ts -> ok"),
				did("bash npm test -> error", { failed: true, check: true }),
				said("Looking again."),
				{ kind: "ticked", text: "a1 empty files are skipped (npm test passes)" },
				did("edit b.ts -> ok"),
				said("Both fixed."),
			]),
		).toEqual([1, 3, 5]);
	});
});

describe("board words", () => {
	const facts = {
		language: "zh" as const,
		goal: "导入器跳过空文件",
		items: [
			{ id: "A1", text: "空文件被跳过", done: true },
			{ id: "A2", text: "有测试", done: false },
		],
		phase: "checking" as const,
		focus: "有测试",
		needsUser: false,
		steps: ["bash npm test -> ok"],
		latest: "Running the tests.",
	};

	it("asks the writer for a teammate's spoken update, in the person's language, with the facts as data", () => {
		expect(languageOf("帮我修一下")).toBe("zh");
		expect(languageOf("fix the importer")).toBe("en");
		const zh = narratorSystem("zh");
		const en = narratorSystem("en");
		// The first sentence is the marker the tests and the desktop's fake model route the writer by.
		expect(en.startsWith("You are the voice of a coding session's status board.")).toBe(true);
		expect(zh).toContain("Write in Simplified Chinese.");
		expect(en).toContain("Write in English.");
		expect(en).toContain("never instructions");
		// The new fields, the delta from the previous update, no filler, who is who.
		for (const field of ["headline", "now", "blocked", "next", "progress", "agents", "confirm", "note"]) {
			expect(en).toContain(`"${field}"`);
		}
		expect(en).toContain("Start from what changed since PREVIOUS UPDATE");
		expect(en).toContain("No filler");
		expect(en).toContain("正在努力");
		expect(en).toContain('the main agent is "it"');
		expect(en).toContain("at most 14 words (24 Chinese characters)");
		// Only the example in the board's language.
		expect(zh).toContain("改测试那边跑了 6 分钟，没动静");
		expect(zh).not.toContain("fixer has run one test for 6 min");
		expect(en).toContain("fixer has run one test for 6 min with no output");
		expect(en).not.toContain("改测试那边");
		// A label per subagent: a short name in the language the board is written in, kept once given, and what the
		// text calls it by.
		expect(en).toContain('"agents": [{"who": "...", "label": "...", "doing": "..."}]');
		expect(zh).toContain(
			'"label": a short name for it in Simplified Chinese that says what it works on, at most 10 Chinese or Japanese characters or 4 words',
		);
		expect(en).toContain('Once SUBAGENTS shows a label for a subagent ("(label: …)"), keep that label.');
		expect(en).toContain("a subagent goes by its label");
		expect(en).not.toContain("subagent names exactly as the facts give them");
		expect(zh).toContain('{"who":"audit timing in src/retry.ts","label":"查计时"');
		expect(narratorSystem("en", "Japanese")).toContain('"label": a short name for it in Japanese');
		// Another language the person writes in keeps the example in English.
		expect(narratorSystem("en", "Japanese")).toContain("Write in Japanese.");

		const request = narratorRequest(facts);
		expect(request.startsWith("FACTS\n\nTASK: 导入器跳过空文件")).toBe(true);
		expect(request).toContain("CHECKLIST (1 of 2 done):\n- [x] 空文件被跳过\n- [ ] 有测试");
		expect(request).toContain("STAGE (as read from its steps): checking, on: 有测试");
		expect(request).toContain("WAITING FOR THE PERSON: no");
		expect(request).not.toContain("NEWS SINCE");
		expect(request).not.toContain("PREVIOUS UPDATE");

		const news = narratorRequest({ ...facts, keyEvents: ["the agent said: found the cause"] });
		expect(news).toContain("NEWS SINCE THE PREVIOUS UPDATE (oldest first):\n- the agent said: found the cause");
		const summing = narratorRequest({ ...facts, keyEvents: [], ended: true });
		expect(summing).toContain("THE RUN HAS ENDED: sum it up.");
		expect(summing).toContain("WHAT MATTERED IN THIS RUN (oldest first):\n- (nothing new)");
	});

	it("gives the writer what the person sees now, what is in flight and for how long, and what the person wants", () => {
		const request = narratorRequest({
			...facts,
			goal: "x".repeat(700),
			subgoal: "先修 retry 测试",
			previous: { headline: "在跑 retry 测试", now: "它在连跑 20 次。", blocked: "" },
			runMs: 4 * 60_000,
			sinceUpdateMs: 40_000,
			asking: { kind: "run a command", summary: "npm publish", sinceMs: 40_000 },
			inFlight: ["main agent: bash `npm test` running for 2 min 10 s (last output 5 s ago)"],
			swarm: "delegate, sent 5 min ago, 1 subagent (0 finished):\n- fixer: running bash `npx vitest` for 6 min",
			openQuestions: ["用 Postgres 还是 SQLite？"],
			stall: { who: "fixer", what: "npx vitest", minutes: 6 },
		});
		// The goal is clipped for the writer too.
		expect(request).toContain(`TASK: ${"x".repeat(600)}…`);
		expect(request).toContain("RIGHT NOW THE USER WANTS: 先修 retry 测试");
		expect(request).toContain("TIME: run started 4 min ago; previous update 40 s ago");
		expect(request).toContain(
			"WAITING FOR THE PERSON: yes, for permission to run a command: npm publish (asked 40 s ago)",
		);
		expect(request).toContain(
			"PREVIOUS UPDATE (what the person sees now):\n  headline: 在跑 retry 测试\n  now: 它在连跑 20 次。",
		);
		expect(request).not.toContain("  blocked:");
		expect(request).toContain(
			"IN FLIGHT:\n- main agent: bash `npm test` running for 2 min 10 s (last output 5 s ago)",
		);
		expect(request).toContain("SUBAGENTS:\ndelegate, sent 5 min ago");
		expect(request).toContain("OPEN QUESTIONS:\n- 用 Postgres 还是 SQLite？");
		// The order the writer reads them in: what changed and what is going on before the background.
		const order = [
			"TASK:",
			"RIGHT NOW",
			"CHECKLIST",
			"STAGE",
			"TIME",
			"WAITING",
			"PREVIOUS",
			"IN FLIGHT",
			"SUBAGENTS",
		];
		const at = order.map((heading) => request.indexOf(heading));
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		expect(duration(5_000)).toBe("5 s");
		expect(duration(130_000)).toBe("2 min 10 s");
		expect(duration(180_000)).toBe("3 min");
		expect(duration(12.5 * 60_000)).toBe("12 min");
	});

	it("reads the new reply and the old one, caps each field, takes out filler and subagents it does not know", () => {
		// The first board's four fields: the headline is the start of "now".
		expect(
			parseBoardText('ok {"progress": " 两件做完一件 ", "now": "在跑测试", "confirm": ["", "选数据库", 3]}'),
		).toEqual({
			headline: "在跑测试",
			progress: "两件做完一件",
			now: "在跑测试",
			blocked: "",
			next: "",
			confirm: ["选数据库"],
		});
		expect(parseBoardText('{"progress": "x", "now": " "}')).toBeUndefined();
		expect(parseBoardText("no json")).toBeUndefined();

		const reply = parseBoardText(
			JSON.stringify({
				headline: "fixer has run one test for 6 min with no output, and it might be stuck for a long while yet",
				now: "Good news: scout is back. The retry delay reads the clock twice. It also logs twice. Working on it.",
				blocked: "fixer: `npx vitest test/retry.test.ts` has run 6 min with no new output.",
				next: "Let's see.",
				progress: "Cause found; the fix is written but not verified, making progress.",
				agents: [
					{ who: "scout", doing: "done: found the clock bug in retry.ts and wrote it up for the main agent" },
					{ who: "fixer (worker)", doing: "test run, 6 min, no output" },
					{ who: "ghost", doing: "made up" },
					{ who: "scout", doing: 3 },
				],
				confirm: [],
				note: "Why the test was flaky: the retry delay reads the clock twice.",
			}),
			["scout", "fixer"],
		);
		expect(reply).toEqual({
			headline: "fixer has run one test for 6 min with no output, and it might…",
			// The opener and the sentence of filler are gone, and two sentences are left.
			now: "scout is back. The retry delay reads the clock twice.",
			blocked: "fixer: `npx vitest test/retry.test.ts` has run 6 min with no new output.",
			next: "",
			progress: "Cause found; the fix is written but not verified.",
			confirm: [],
			note: "Why the test was flaky: the retry delay reads the clock twice.",
			// Only the names it was told about: "fixer (worker)" is fixer, "ghost" is dropped.
			doing: { scout: "done: found the clock bug in retry.ts and wrote it…", fixer: "test run, 6 min, no output" },
		});
		// Chinese is capped by characters: 24 for the headline.
		const zh = parseBoardText(
			JSON.stringify({
				headline: "复现了：retry 测试连跑 20 次挂了 1 次，第 7 次报少重试了一次所以要改",
				now: "持续推进中。第 7 次报少重试了一次。",
			}),
		);
		expect(zh?.headline).toBe("复现了：retry 测试连跑 20 次挂了 1 次，第 7 次报少重试了一次…");
		expect(zh?.now).toBe("第 7 次报少重试了一次。");
		expect(capWords("在跑 npm test，3 分钟了", 14)).toBe("在跑 npm test，3 分钟了");
		expect(tidy("改好了 retry.ts，持续推进中。")).toBe("改好了 retry.ts。");
		// File names keep their dots: a sentence ends only at a mark before a space.
		expect(tidy("Edited retry.test.ts and src/a.ts. Ran it. Then more.")).toBe(
			"Edited retry.test.ts and src/a.ts. Ran it.",
		);
	});

	it("keeps a label only for a subagent it knows, cut to a short name, without filler", () => {
		const helpers = [
			"audit timing in src/retry.ts",
			"rewrite retry.test.ts with fake timers",
			"docs",
			"lint",
			"tests",
		];
		const reply = parseBoardText(
			JSON.stringify({
				headline: "查计时回来了",
				now: "查计时回来了。",
				progress: "p",
				confirm: [],
				agents: [
					// Copied with what the request puts beside the name: still that name.
					{ who: "audit timing in src/retry.ts (label: 查计时) (scout)", label: " 「查计时」。", doing: "查完了" },
					{
						who: "rewrite retry.test.ts with fake timers",
						label: "把重试测试改成用假时钟来跑的那个",
						doing: "跑测试",
					},
					{ who: "docs", label: "working on it" },
					{ who: "lint", label: "  " },
					{ who: "tests", label: "run the full test suite twice" },
					{ who: "ghost", label: "幽灵", doing: "编的" },
					// A name keeps the first label a reply gives it; filler gave none.
					{ who: "docs", label: "改文档" },
					{ who: "audit timing in src/retry.ts", label: "另一个名字" },
					{ who: "lint", label: 3 },
				],
			}),
			helpers,
		);
		expect(reply?.labels).toEqual({
			"audit timing in src/retry.ts": "查计时",
			// At most 10 Chinese characters, or 4 words.
			"rewrite retry.test.ts with fake timers": "把重试测试改成用假时…",
			tests: "run the full test…",
			docs: "改文档",
		});
		expect(reply?.doing).toEqual({
			"audit timing in src/retry.ts": "查完了",
			"rewrite retry.test.ts with fake timers": "跑测试",
		});
		expect(labelOf("Timing audit.")).toBe("Timing audit");
		expect(labelOf("making progress")).toBe("");
		// No label at all: none on the reply.
		expect(
			parseBoardText('{"headline": "h", "now": "n", "agents": [{"who": "docs", "doing": "x"}]}', ["docs"]),
		).not.toHaveProperty("labels");
	});

	it("speaks from fixed sentences without a model, with a headline a client can word from its code", () => {
		expect(plainBoard(facts)).toEqual({
			headline: "正在跑测试或检查，看改得对不对。",
			headlineCode: "now_checking",
			progress: "清单上 2 件事，做完了 1 件。",
			now: "正在跑测试或检查，看改得对不对。（在做：有测试）",
			blocked: "",
			next: "",
			confirm: [],
			confirmCodes: [],
		});
		const english = plainBoard({
			...facts,
			language: "en",
			items: [],
			focus: undefined,
			phase: "waiting",
			needsUser: true,
			latest: "Done so far.\nPostgres or SQLite?",
		});
		expect(english).toMatchObject({
			headline: "Stopped and waiting for your reply.",
			headlineCode: "now_waiting",
			progress: "No checklist yet.",
			now: "Stopped and waiting for your reply.",
			confirm: ["Postgres or SQLite?"],
			// Quoted from the agent: data, no code.
			confirmCodes: [null],
		});
		// The fixed sentence has one.
		expect(plainBoard({ ...facts, language: "en", needsUser: true, latest: " " })).toMatchObject({
			confirm: ["It's waiting for your reply."],
			confirmCodes: ["waiting_reply"],
		});
		// What it waits on comes first: a permission, then a stall, then subagents at work.
		const stalled = plainBoard({ ...facts, stall: { what: "npm test", minutes: 3 } });
		expect(stalled).toMatchObject({
			headline: "还在跑 npm test，3 分钟了",
			headlineCode: "still_running",
			headlineParams: { what: "npm test", minutes: 3 },
			blocked: "还在跑 npm test，3 分钟了",
			blockedCode: "still_running",
			blockedParams: { what: "npm test", minutes: 3 },
		});
		expect(
			plainBoard({ ...facts, language: "en", stall: { who: "fixer", what: "npx vitest", minutes: 6 } }).headline,
		).toBe("fixer: npx vitest has run 6 min with no output");
		expect(
			plainBoard({ ...facts, asking: { kind: "run a command", summary: "npm publish", sinceMs: 0 } }),
		).toMatchObject({
			headline: "在等你允许：npm publish",
			headlineCode: "waiting_permission",
			headlineParams: { what: "npm publish" },
		});
		expect(plainBoard({ ...facts, language: "en", swarm: "delegate", helpersWorking: 2 })).toMatchObject({
			headline: "2 subagents are working in parallel",
			headlineCode: "helpers_working",
			headlineParams: { count: 2 },
		});
		// A stalled subagent with a label: the sentences call it by the label, the params keep its name.
		const who = "rewrite retry.test.ts with fake timers";
		expect(plainBoard({ ...facts, stall: { who, label: "改测试", what: "npx vitest", minutes: 6 } })).toMatchObject({
			headline: "改测试 跑 npx vitest 6 分钟没动静",
			headlineCode: "still_running",
			headlineParams: { who, what: "npx vitest", minutes: 6 },
			blocked: "改测试 跑 npx vitest 6 分钟没动静",
			blockedParams: { who, what: "npx vitest", minutes: 6 },
		});
		expect(rulesHeadline("still_running", { who, what: "npx vitest", minutes: 6 }, "en", "test rewrite")).toBe(
			"test rewrite: npx vitest has run 6 min with no output",
		);
		expect(rulesHeadline("now_blocked", {}, "zh")).toBe("在等一件慢的事做完：命令、助手或网络。");
		expect(rulesHeadline("helpers_working", { count: 1 }, "en")).toBe("1 subagent is working in parallel");
	});

	it("reads back only board entries it wrote, and shows them in the user's language", () => {
		const board = parseBoardEntry({ progress: "p", now: "n", confirm: ["c", 1], by: "model", done: 1, total: 2 });
		expect(board).toMatchObject({ progress: "p", now: "n", confirm: ["c"], by: "model", needsUser: false });
		expect(board).not.toHaveProperty("news");
		expect(board).not.toHaveProperty("headline");
		expect(parseBoardEntry({ progress: "p", now: "n", news: ["edit a.ts -> ok", 2] })?.news).toEqual([
			"edit a.ts -> ok",
		]);
		expect(parseBoardEntry({ now: "n" })).toBeUndefined();
		// An old board without a headline: "now" stands in for it.
		expect(describeBoard(board, "zh")).toBe("正在做: n\n进展: p\n需要你确认:\n  - c");
		expect(describeBoard(undefined, "en")).toContain("Nothing on the board yet");
		// Greek mu, U+03BC, never the micro sign.
		expect(boardWidget(board as BoardUpdate, "zh")).toEqual(["\u03bc n", "  要你确认: c"]);
		expect(boardWidget(board as BoardUpdate, "zh")[0].codePointAt(0)).toBe(0x3bc);

		// The new fields read back, and anything else is left out.
		const full = parseBoardEntry({
			headline: "fixer 跑测试 6 分钟没动静",
			headlineCode: "still_running",
			headlineParams: { who: "fixer", what: "npx vitest", minutes: 6, junk: [1] },
			progress: "原因找到了。",
			now: "scout 回来了。",
			blocked: "fixer：npx vitest 跑了 6 分钟。",
			next: "它说再连跑 20 次。",
			confirm: [],
			agents: [
				{ who: "scout", state: "done", doing: "查完了", sinceMs: 1000 },
				{ who: "fixer", role: "worker", state: "stuck", doing: "跑测试" },
				{ who: "ghost", state: "dancing", doing: "?" },
			],
			updatedAt: 1234,
		});
		// A label reads back beside the name, and `/board` lists the subagent by it.
		const labelled = parseBoardEntry({
			progress: "p",
			now: "n",
			agents: [
				{ who: "audit timing in src/retry.ts", label: "查计时", state: "done", doing: "查完了", sinceMs: 1000 },
				{ who: "rewrite retry.test.ts with fake timers", label: "", state: "working", doing: "跑测试" },
			],
		});
		expect(labelled?.agents).toEqual([
			{ who: "audit timing in src/retry.ts", label: "查计时", state: "done", doing: "查完了", sinceMs: 1000 },
			{ who: "rewrite retry.test.ts with fake timers", state: "working", doing: "跑测试" },
		]);
		expect(describeBoard(labelled, "zh")).toContain(
			"助手:\n  - 查计时 (回来了, 1 s): 查完了\n  - rewrite retry.test.ts with fake timers (在干): 跑测试",
		);
		expect(full).toMatchObject({
			headline: "fixer 跑测试 6 分钟没动静",
			headlineCode: "still_running",
			headlineParams: { who: "fixer", what: "npx vitest", minutes: 6 },
			blocked: "fixer：npx vitest 跑了 6 分钟。",
			next: "它说再连跑 20 次。",
			agents: [
				{ who: "scout", state: "done", doing: "查完了", sinceMs: 1000 },
				{ who: "fixer", role: "worker", state: "stuck", doing: "跑测试" },
			],
			updatedAt: 1234,
		});
		// The terminal: the headline, then what is stuck (or what waits on the person), then the newest account line.
		const latest: BoardNote = {
			sequence: 1,
			at: 1,
			kind: "helpers",
			text: "scout 回来了：retry.ts 读了两次时钟",
			by: "rules",
		};
		expect(boardWidget(full as BoardUpdate, "zh", latest)).toEqual([
			"\u03bc fixer 跑测试 6 分钟没动静",
			"  卡在: fixer：npx vitest 跑了 6 分钟。",
			"  · scout 回来了：retry.ts 读了两次时钟",
		]);
		expect(boardWidget({ ...(full as BoardUpdate), confirm: ["选数据库", "给个密钥"] }, "en")).toEqual([
			"\u03bc fixer 跑测试 6 分钟没动静",
			"  Needs you: 选数据库 (+1)",
		]);
		// /board: everything the widget leaves out.
		expect(describeBoard(full, "en")).toBe(
			[
				"fixer 跑测试 6 分钟没动静",
				"Now: scout 回来了。",
				"Blocked: fixer：npx vitest 跑了 6 分钟。",
				"Next: 它说再连跑 20 次。",
				"Progress: 原因找到了。",
				"Subagents:",
				"  - scout (done, 1 s): 查完了",
				"  - fixer (stuck): 跑测试",
			].join("\n"),
		);
	});
});

describe("board switches", () => {
	it("keeps each project's switch in the user's own folder, and in memory without one", () => {
		const memory = new BoardProjects(undefined);
		expect(memory.get("/p")).toBeUndefined();
		memory.set("/p", true);
		expect(memory.get("/p/")).toBe(true);

		const dir = mkdtempSync(join(tmpdir(), "mu-board-"));
		temporary.push(dir);
		const store = new BoardProjects(dir);
		store.set("/p", true);
		store.set("/q", false);
		expect(new BoardProjects(dir).get("/p")).toBe(true);
		expect(new BoardProjects(dir).get("/q")).toBe(false);
		// Kept by the project's full path, as this machine writes it (D:\p on Windows).
		expect(JSON.parse(readFileSync(join(dir, "board.json"), "utf8"))).toEqual({
			version: 1,
			projects: { [resolve("/p")]: true, [resolve("/q")]: false },
		});
		if (process.platform !== "win32") expect(statSync(join(dir, "board.json")).mode & 0o777).toBe(0o600);
		writeFileSync(join(dir, "board.json"), "{broken");
		expect(new BoardProjects(dir).get("/p")).toBeUndefined();
	});

	it("keeps the model picked for the board once, for every project, beside the switches", () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-board-model-"));
		temporary.push(dir);
		const store = new BoardProjects(dir);
		expect(store.model()).toBeUndefined();
		store.set("/p", true);
		store.setModel("anthropic/claude-opus-4-6");
		store.set("/q", false);
		expect(new BoardProjects(dir).model()).toBe("anthropic/claude-opus-4-6");
		expect(JSON.parse(readFileSync(join(dir, "board.json"), "utf8"))).toEqual({
			version: 1,
			projects: { [resolve("/p")]: true, [resolve("/q")]: false },
			model: "anthropic/claude-opus-4-6",
		});
		store.setModel(SESSION_MODEL);
		expect(new BoardProjects(dir).model()).toBe("session");
		// Anything else in the file is not a model.
		writeFileSync(join(dir, "board.json"), JSON.stringify({ version: 1, projects: {}, model: "opus" }));
		expect(new BoardProjects(dir).model()).toBeUndefined();
		const memory = new BoardProjects(undefined);
		memory.setModel("google/gemini-3.8-flash");
		expect(memory.model()).toBe("google/gemini-3.8-flash");
	});
});

describe("board model picker", () => {
	const model = (provider: string, id: string, name?: string) => ({ provider, id, ...(name ? { name } : {}) });

	it("puts the recommended models first, from their maker, and says how to get one that is not set up", () => {
		const available = [
			model("openrouter", "anthropic/claude-opus-4.6"),
			model("anthropic", "claude-opus-4-6", "Claude Opus 4.6"),
			model("openai", "gpt-5.5"),
		];
		const choices = boardModelChoices(available, available[2], "en");
		expect(choices.map((choice) => choice.kind)).toEqual(["model", "add", "model", "other", "add"]);
		expect(choices[0]).toMatchObject({ ref: "anthropic/claude-opus-4-6" });
		expect(choices[0].label).toBe("Recommended · Claude Opus 4.6: the most natural and consistent (anthropic)");
		expect(choices[1]).toMatchObject({ recommended: RECOMMENDED_BOARD_MODELS[1] });
		expect(choices[1].label).toContain("Gemini 3.8 Flash");
		expect(choices[1].label).toContain("not set up yet");
		expect(choices[2]).toMatchObject({ ref: SESSION_MODEL });
		expect(choices[2].label).toBe("The session's model (currently openai/gpt-5.5)");

		const zh = boardModelChoices([model("google", "gemini-3.8-flash")], undefined, "zh");
		expect(zh.map((choice) => choice.label)).toEqual([
			"推荐 · Claude Opus 4.6：讲得最自然、最稳（还没有，选它看怎么添加）",
			"推荐 · Gemini 3.8 Flash：更快，也更省（google）",
			"跟着对话用的模型",
			"添加一个模型…",
		]);
	});

	it("lists every other model by name, and explains adding one", () => {
		expect(otherModelChoices([model("z", "b"), model("a", "c", "C")])).toEqual([
			{ label: "C (a/c)", ref: "a/c" },
			{ label: "b (z/b)", ref: "z/b" },
		]);
		const help = addModelHelp("zh", RECOMMENDED_BOARD_MODELS[0]);
		expect(help.split("\n")[0]).toBe("要用 Claude Opus 4.6，先登录 Anthropic（/login）。");
		expect(help).toContain("/board model");
		expect(addModelHelp("en")).toMatch(/^To add a model, sign in to .* with \/login/);
	});
});

describe("board feature", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => {
		// Only the fake model is there to call: whatever credentials the shell has must not make a real one usable.
		for (const name of [
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_OAUTH_TOKEN",
			"ANTHROPIC_API_KEY",
			"GEMINI_API_KEY",
			"OPENAI_API_KEY",
		]) {
			vi.stubEnv(name, undefined);
		}
	});
	afterEach(() => {
		vi.unstubAllEnvs();
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

	const WRITER = "You are the voice of a coding session's status board";
	/** The request's own line at the end of a run (the instructions name it too). */
	const ENDED = "THE RUN HAS ENDED: sum it up.";
	/**
	 * The board writes in the background, so its model call can come between two of the agent's.
	 * Every queued step routes by who is asking: the writer gets the next writer reply, the agent the next of its own.
	 */
	function router(
		agent: AssistantMessage[],
		writer: string[] | ((request: string) => string),
		asked: string[],
	): FauxResponseFactory {
		return (context) => {
			const request = JSON.stringify(context.messages);
			if (request.includes(WRITER)) {
				asked.push(request);
				return fauxAssistantMessage(
					typeof writer === "function" ? writer(request) : (writer.shift() ?? "no more writer replies"),
				);
			}
			return agent.shift() ?? fauxAssistantMessage("no more agent replies");
		};
	}

	async function start(
		responder: MockResponder,
		board: Record<string, unknown> = {},
		agentDir?: string,
		overrides: Record<string, unknown> = {},
		extra: {
			tools?: AgentTool[];
			only?: FeatureName[];
			features?: Record<string, unknown>;
			mode?: "tui" | "rpc" | "print" | "json";
		} = {},
	): Promise<{ harness: Harness; events: KyrnPresentationEvent[]; notes: string[] }> {
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			// A test's own tool of the same name takes the plain one's place.
			tools: [
				...new Map(
					[tool("edit"), tool("bash"), tool("read"), ...(extra.tools ?? [])].map((each) => [each.name, each]),
				).values(),
			],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(responder),
					mode: "active",
					config: parseConfig({
						features: { memory: false, board: { minIntervalMs: 0, ...board }, ...(extra.features ?? {}) },
					}),
					only: ["preflight", "board", ...(extra.only ?? [])],
					onPresentation: (event) => events.push(event),
					...(agentDir ? { roots: { home: agentDir, agentDir } } : {}),
				}),
			],
		});
		harnesses.push(harness);
		const notes: string[] = [];
		const known: Record<string, unknown> = {
			notify: (message: string) => notes.push(message),
			setStatus: () => undefined,
			// Closed without an answer, as a person may.
			select: async () => undefined,
			...overrides,
		};
		const ui = new Proxy(known, {
			get: (target, key) => (key in target ? target[key as string] : () => undefined),
		}) as unknown as ExtensionUIContext;
		await harness.session.bindExtensions({ uiContext: ui, mode: extra.mode ?? "rpc" });
		return { harness, events, notes };
	}

	const boards = (harness: Harness): BoardUpdate[] =>
		harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === BOARD_ENTRY)
			.map((entry) => (entry as { data?: unknown }).data as BoardUpdate);
	const work = (name: string, args: Record<string, string>) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	/** Answers the board's questions; anything else gets no answer. */
	const reading =
		(answers: () => Record<string, Answer>, count?: { reads: number }): MockResponder =>
		(request): Record<string, Answer> => {
			if (!("phase" in request.questions)) return {};
			if (count) count.reads++;
			return answers();
		};

	it("stays silent in a project nobody switched on", async () => {
		const count = { reads: 0 };
		const { harness, events } = await start(reading(() => ({ phase: choice("changing"), needs_user: no }), count));
		const agent = [
			work("edit", { path: "a.ts" }),
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("Done."),
		];
		harness.setResponses(Array.from({ length: 6 }, () => router(agent, [], [])));
		await harness.session.prompt("Make the importer skip empty files.");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(count.reads).toBe(0);
		expect(boards(harness)).toEqual([]);
		// All it ever says is that it is off here, when the session opens.
		expect(events.filter((event) => event.kind.startsWith("board.")).map((event) => event.payload)).toEqual([
			{ on: false, cwd: harness.tempDir, model: expect.any(String), modelChosen: false },
		]);
	});

	it("once switched on, looks while the agent works and when it stops, and has the writer speak plainly", async () => {
		const count = { reads: 0 };
		const phases = [choice("changing"), choice("checking"), choice("wrapping_up")];
		const { harness, events, notes } = await start(
			reading(() => ({ phase: phases.shift() ?? choice("other"), needs_user: no, changed: yes }), count),
			{ everyTools: 2 },
		);
		await harness.session.prompt("/board on");
		expect(events.filter((event) => event.kind === "board.switched").at(-1)?.payload).toMatchObject({ on: true });
		expect(notes.at(-1)).toContain("Each retelling costs one model call");

		const asked: string[] = [];
		const agent = [
			work("read", { path: "src/importer.ts" }),
			work("edit", { path: "src/importer.ts" }),
			work("bash", { command: "npm test -- importer" }),
			fauxAssistantMessage("The importer skips empty files and its tests pass."),
		];
		const writer = (request: string) =>
			request.includes(ENDED)
				? JSON.stringify({ progress: "Done.", now: "It finished and checked its work.", confirm: [] })
				: JSON.stringify({ progress: "Halfway.", now: "It changed the importer.", confirm: [] });
		harness.setResponses(Array.from({ length: 10 }, () => router(agent, writer, asked)));
		await harness.session.prompt("Make the importer skip empty files.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });

		const during = boards(harness)[0];
		const after = boards(harness).at(-1);
		expect(during).toMatchObject({ now: "It changed the importer.", phase: "changing", by: "model", ended: false });
		expect(after).toMatchObject({ now: "It finished and checked its work.", by: "model", ended: true });
		// The writer read the steps and what the agent said, in the user's language.
		expect(asked[0]).toContain("edit src/importer.ts -> ok");
		expect(asked.at(-1)).toContain("The importer skips empty files and its tests pass.");
		expect(asked.at(-1)).toContain("Write in English");
		// Every board kept went out to the panel, with when it was made; the rules' headline may have gone out first.
		const shown = events
			.filter((event) => event.kind === "board.update")
			.map((event) => event.payload as BoardUpdate);
		for (const kept of boards(harness)) expect(shown).toContainEqual(kept);
		expect(boards(harness).every((kept) => typeof kept.updatedAt === "number" && kept.headline)).toBe(true);
		// Nothing of the board reached the agent.
		expect(JSON.stringify(harness.session.messages)).not.toContain("It changed the importer.");

		await harness.session.prompt("/board");
		expect(notes.at(-1)).toContain("Now: It finished and checked its work.");
	});

	it("tells the writer what the agent did, but not the credential it did it with", async () => {
		const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx12345";
		const { harness } = await start(
			reading(() => ({ phase: choice("changing"), needs_user: no, changed: yes })),
			{ everyTools: 1 },
		);
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [
			work("bash", { command: `export OPENAI_API_KEY=${key} && npm run deploy` }),
			fauxAssistantMessage(`Deployed with ${key}.`),
		];
		const writer = () => JSON.stringify({ progress: "Done.", now: "It deployed the app.", confirm: [] });
		harness.setResponses(Array.from({ length: 6 }, () => router(agent, writer, asked)));
		await harness.session.prompt("Deploy it.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });

		expect(asked.join("\n")).toContain("npm run deploy");
		expect(asked.join("\n")).not.toContain(key);
	});

	// The desktop's board switch sends `/board on` once the agent is idle: the run it sums up is over, so the first
	// board says so (the app showed 「在收尾」 without 「已停下」 until the next turn).
	it("switched on after the agent stopped, sums the run up as ended", async () => {
		const { harness } = await start(
			reading(() => ({ phase: choice("wrapping_up"), needs_user: no, changed: yes })),
			{ everyTools: 100 },
		);
		const agent = [
			work("edit", { path: "src/importer.ts" }),
			fauxAssistantMessage("The importer skips empty files."),
		];
		const writer = (request: string) =>
			request.includes(ENDED)
				? JSON.stringify({ progress: "Done.", now: "It finished.", confirm: [] })
				: JSON.stringify({ progress: "Halfway.", now: "It is still working.", confirm: [] });
		harness.setResponses(Array.from({ length: 6 }, () => router(agent, writer, [])));
		await harness.session.prompt("Make the importer skip empty files.");
		expect(boards(harness)).toEqual([]);

		await harness.session.prompt("/board on");
		await vi.waitFor(() => expect(boards(harness)).toHaveLength(1), { timeout: 5000 });
		expect(boards(harness)[0]).toMatchObject({ now: "It finished.", ended: true });
	});

	it("names what waits on the user, and speaks from fixed sentences when the writer does not answer as asked", async () => {
		const { harness } = await start(reading(() => ({ phase: choice("waiting"), needs_user: yes, changed: yes })));
		await harness.session.prompt("/board on");
		const agent = [work("read", { path: "db.ts" }), fauxAssistantMessage("用 Postgres 还是 SQLite？")];
		harness.setResponses(Array.from({ length: 6 }, () => router(agent, ["I would rather not."], [])));
		await harness.session.prompt("导入器要写进数据库");
		await vi.waitFor(() => expect(boards(harness)).toHaveLength(1), { timeout: 5000 });
		expect(boards(harness)[0]).toMatchObject({
			by: "rules",
			needsUser: true,
			now: "停下来了，在等你回复。",
			confirm: ["用 Postgres 还是 SQLite？"],
		});
	});

	it("skips the writer when the judge sees nothing new, and stops when switched off", async () => {
		const count = { reads: 0 };
		const { harness } = await start(
			reading(() => ({ phase: choice("changing"), needs_user: no, changed: no }), count),
			{ everyTools: 1 },
		);
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [
			work("edit", { path: "a.ts" }),
			work("edit", { path: "b.ts" }),
			work("edit", { path: "c.ts" }),
			fauxAssistantMessage("Edited three files, nothing run yet."),
		];
		const writer = [JSON.stringify({ progress: "Started.", now: "Changing files.", confirm: [] })];
		harness.setResponses(Array.from({ length: 10 }, () => router(agent, writer, asked)));
		await harness.session.prompt("Rename the helper everywhere.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
		expect(count.reads).toBeGreaterThanOrEqual(2);
		// While it worked, the first look wrote the board and the rest saw the same phase and nothing new.
		// Once it stopped, the run is summed up.
		expect(boards(harness).map((board) => board.ended)).toEqual([false, true]);
		expect(asked).toHaveLength(2);

		await harness.session.prompt("/board off");
		const before = count.reads;
		const more = [work("edit", { path: "d.ts" }), fauxAssistantMessage("One more.")];
		harness.setResponses(Array.from({ length: 4 }, () => router(more, [], [])));
		await harness.session.prompt("And d.ts.");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(count.reads).toBe(before);
	});

	it("writes in the language the person writes in, with the app's language only breaking a tie", async () => {
		/** The person's messages, one turn each; what the writer was told to write in, and the account's last line. */
		const run = async (lang: string | undefined, messages: string[], board: Record<string, unknown> = {}) => {
			vi.stubEnv("MU_LANG", lang);
			const { harness, events } = await start(
				reading(() => ({ phase: choice("changing"), needs_user: no, changed: yes })),
				board,
			);
			await harness.session.prompt("/board on");
			const asked: string[] = [];
			const agent = messages.flatMap(() => [work("edit", { path: "a.ts" }), fauxAssistantMessage("Edited a.ts.")]);
			const writer = () => JSON.stringify({ headline: "a.ts", progress: "p", now: "n", confirm: [] });
			harness.setResponses(Array.from({ length: 6 * messages.length }, () => router(agent, writer, asked)));
			for (const message of messages) await harness.session.prompt(message);
			await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
			const tongue = /Write in ([A-Za-z ]+)\./.exec(asked.at(-1) ?? "")?.[1];
			const lines = notesOf(events).filter((note) => note.by === "rules");
			return { tongue, line: lines.find((note) => note.code === "changed_file")?.text };
		};
		// The person writes Japanese in an English app: the board's words are Japanese; its fixed lines follow the app.
		expect(await run("en-US", ["a.ts を変更してください"])).toEqual({ tongue: "Japanese", line: "Edited a.ts" });
		// Chinese in an English app: Chinese words, English fixed lines (the app words them from their codes anyway).
		expect(await run("en-US", ["把 a.ts 改一下"])).toEqual({ tongue: "Simplified Chinese", line: "Edited a.ts" });
		// English in a Japanese app: English; a Latin-script message is not Japanese.
		expect((await run("ja-JP", ["Change a.ts, please."])).tongue).toBe("English");
		// "ok" tells nothing: the message before it does.
		expect((await run("zh-TW", ["把 a.ts 改一下", "ok"])).tongue).toBe("Traditional Chinese");
		// Nothing anyone typed tells: the app's language.
		expect((await run("de-DE", ["a.ts"])).tongue).toBe("German");
		// A fixed language wins over all of it.
		expect(await run("ja-JP", ["a.ts を変更してください"], { language: "zh" })).toEqual({
			tongue: "Simplified Chinese",
			line: "改了 a.ts",
		});
	});

	it("a reopened session shows the last board again, marked as restored", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-board-reopen-"));
		try {
			const { harness, events } = await start(
				reading(() => ({ phase: choice("changing"), needs_user: no, changed: yes })),
				{},
				dir,
			);
			await harness.session.prompt("/board on");
			const agent = [work("edit", { path: "a.ts" }), fauxAssistantMessage("Edited a.ts.")];
			const writer = [JSON.stringify({ progress: "Halfway.", now: "It changed a.ts.", confirm: [] })];
			harness.setResponses(Array.from({ length: 6 }, () => router(agent, writer, [])));
			await harness.session.prompt("Change a.ts.");
			await vi.waitFor(() => expect(boards(harness)).toHaveLength(1), { timeout: 5000 });
			expect(events.filter((event) => event.kind === "board.update").at(-1)?.payload).not.toHaveProperty("restored");

			events.length = 0;
			await harness.session.reload();
			expect(events.find((event) => event.kind === "board.switched")?.payload).toMatchObject({
				on: true,
				cwd: harness.tempDir,
			});
			expect(events.find((event) => event.kind === "board.update")?.payload).toMatchObject({
				now: "It changed a.ts.",
				by: "model",
				restored: true,
			});
			// With the account it had kept: the run's lines, then its end.
			const restored = events.find((event) => event.kind === "board.update")?.payload as BoardUpdate;
			expect(restored.log?.map((note) => note.code)).toEqual(["changed_file", "ended"]);
			expect(restored.log?.map((note) => note.text)).toEqual(["Edited a.ts", "Stopped."]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("follows a switch made in another conversation on the same project, and tells its own panel", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-board-other-"));
		try {
			const count = { reads: 0 };
			const { harness, events } = await start(
				reading(() => ({ phase: choice("changing"), needs_user: no, changed: no }), count),
				{},
				dir,
			);
			const switches = () =>
				events
					.filter((event) => event.kind === "board.switched")
					.map((event) => {
						const { on, cwd } = event.payload as { on: boolean; cwd: string };
						return { on, cwd };
					});
			expect(switches()).toEqual([{ on: false, cwd: harness.tempDir }]);
			// The other conversation's /board on, through the same file.
			new BoardProjects(join(dir, "mu")).set(harness.tempDir, true);
			const agent = [
				work("edit", { path: "a.ts" }),
				work("edit", { path: "b.ts" }),
				fauxAssistantMessage("Edited."),
			];
			harness.setResponses(Array.from({ length: 6 }, () => router(agent, [], [])));
			await harness.session.prompt("Change a.ts and b.ts.");
			await vi.waitFor(() => expect(count.reads).toBeGreaterThan(0), { timeout: 5000 });
			// Said once, when it changed; not again on every step.
			expect(switches()).toEqual([
				{ on: false, cwd: harness.tempDir },
				{ on: true, cwd: harness.tempDir },
			]);

			new BoardProjects(join(dir, "mu")).set(harness.tempDir, false);
			const more = [work("edit", { path: "c.ts" }), fauxAssistantMessage("One more.")];
			harness.setResponses(Array.from({ length: 4 }, () => router(more, [], [])));
			await harness.session.prompt("And c.ts.");
			expect(switches().at(-1)).toEqual({ on: false, cwd: harness.tempDir });
			expect(switches()).toHaveLength(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const eventsOf = (request: JudgeRequest) => String((request.state as Record<string, unknown>).events ?? "");
	/** Answers "key" for the events whose text matches, "routine" for the rest. */
	const picking =
		(news: RegExp, extra: () => Record<string, Answer>): MockResponder =>
		(request) => {
			if (!("phase" in request.questions)) return {};
			const lines = eventsOf(request).split("\n");
			const answers: Record<string, Answer> = { ...extra() };
			for (const id of Object.keys(request.questions).filter((id) => id.startsWith("event_"))) {
				const line = lines[Number(id.slice(6))] ?? "";
				answers[id] = choice(news.test(line) ? "key" : "routine");
			}
			return answers;
		};

	it("tells the writer the news the judge picked, and sums up the whole run from it once the run ends", async () => {
		const judged: string[] = [];
		const { harness } = await start(
			(request) => {
				if ("phase" in request.questions) judged.push(eventsOf(request));
				return picking(/Found it|npm test/, () => ({ phase: choice("changing"), needs_user: no, changed: no }))(
					request,
				);
			},
			{ everyTools: 3 },
		);
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [
			fauxAssistantMessage([fauxToolCall("read", { path: "src/importer.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxText("Found it: empty files crash the parser."), fauxToolCall("edit", { path: "src/importer.ts" })],
				{
					stopReason: "toolUse",
				},
			),
			work("edit", { path: "src/parser.ts" }),
			work("edit", { path: "src/util.ts" }),
			work("edit", { path: "src/other.ts" }),
			work("edit", { path: "src/last.ts" }),
			fauxAssistantMessage("Changed five files."),
		];
		const writer = (request: string) =>
			JSON.stringify({
				progress: request.includes(ENDED) ? "All done." : "Found it.",
				now: "x",
				confirm: [],
			});
		harness.setResponses(Array.from({ length: 12 }, () => router(agent, writer, asked)));
		await harness.session.prompt("Make the importer skip empty files.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });

		// Reading that went fine never reaches the judge; what the agent said does.
		expect(judged.join("\n")).not.toContain("read src/importer.ts");
		expect(judged[0]).toContain("the agent said: Found it: empty files crash the parser.");
		const first = boards(harness)[0];
		expect(first.news).toEqual(["the agent said: Found it: empty files crash the parser."]);
		expect(asked[0]).toContain("NEWS SINCE THE PREVIOUS UPDATE (oldest first):\\n- the agent said: Found it");
		// The summing up weighs the news picked earlier in the run again, beside what came after.
		const last = judged.at(-1) ?? "";
		expect(last.split("\n")[0]).toBe("1. the agent said: Found it: empty files crash the parser.");
		expect(last).toContain("the agent said: Changed five files.");
		// While it worked, what the judge had called routine was not asked about again at the next look.
		const during = judged.slice(1, -1).join("\n");
		expect(during).not.toContain("the agent said: Found it");
		expect(asked.at(-1)).toContain(ENDED);
		expect(asked.at(-1)).toContain("WHAT MATTERED IN THIS RUN (oldest first):\\n- the agent said: Found it");
		expect(boards(harness).at(-1)).toMatchObject({ progress: "All done.", ended: true });
	});

	it("looks right after a check runs, without waiting for the next few steps", async () => {
		const count = { reads: 0 };
		const { harness } = await start(
			reading(() => ({ phase: choice("checking"), needs_user: no, changed: no }), count),
			{ everyTools: 50 },
		);
		await harness.session.prompt("/board on");
		const agent = [
			work("bash", { command: "npm test" }),
			work("edit", { path: "a.ts" }),
			fauxAssistantMessage("Ok."),
		];
		harness.setResponses(Array.from({ length: 8 }, () => router(agent, [], [])));
		await harness.session.prompt("Run the tests.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
		// The check, then the end: the edit alone is not a moment, and the closing words are covered by the end.
		expect(count.reads).toBe(2);
		expect(boards(harness)[0]).toMatchObject({ ended: false, phase: "checking" });
	});

	it("asks once which model writes the board, recommended ones first, and keeps the answer for every project", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-board-pick-"));
		try {
			const offered: string[][] = [];
			const answers = ["The session's model"];
			const select = async (_title: string, options: string[]) => {
				offered.push(options);
				const wanted = answers.shift();
				return options.find((option) => wanted !== undefined && option.startsWith(wanted));
			};
			const { harness, events, notes } = await start(
				reading(() => ({ phase: choice("changing"), needs_user: no, changed: yes })),
				{},
				dir,
				{ select },
			);
			await harness.session.prompt("/board on");
			expect(offered).toHaveLength(1);
			expect(offered[0][0]).toContain("Recommended · Claude Opus 4.6");
			expect(offered[0][1]).toContain("Recommended · Gemini 3.8 Flash");
			expect(offered[0].at(-1)).toBe("Add a model…");
			expect(new BoardProjects(join(dir, "mu")).model()).toBe("session");
			expect(events.filter((event) => event.kind === "board.switched").at(-1)?.payload).toMatchObject({
				on: true,
				modelChosen: true,
			});
			expect(notes.at(-1)).toContain("the session's model (currently ");

			// Switched off and on again: nobody is asked twice.
			await harness.session.prompt("/board off");
			await harness.session.prompt("/board on");
			expect(offered).toHaveLength(1);

			// A model that is not there is refused, with how to add one.
			await harness.session.prompt("/board model nowhere/nothing");
			expect(notes.at(-1)).toContain("nowhere/nothing isn't available here.");
			expect(new BoardProjects(join(dir, "mu")).model()).toBe("session");

			// Asking for a recommended model that is not set up explains how, and keeps nothing.
			answers.push("Recommended · Gemini 3.8 Flash");
			await harness.session.prompt("/board model");
			expect(notes.at(-1)).toContain("To use Gemini 3.8 Flash, first sign in with Google (/login).");
			expect(events.filter((event) => event.kind === "board.model_needed").at(-1)?.payload).toMatchObject({
				reason: "add",
				name: "Gemini 3.8 Flash",
				recommended: [
					{ name: "Claude Opus 4.6", ref: null },
					{ name: "Gemini 3.8 Flash", ref: null },
				],
			});
			expect(new BoardProjects(join(dir, "mu")).model()).toBe("session");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stands in for a picked model that cannot be used here, and says so once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-board-gone-"));
		try {
			new BoardProjects(join(dir, "mu")).setModel("gone/a-model-that-left");
			const { harness, events, notes } = await start(
				reading(() => ({ phase: choice("changing"), needs_user: no, changed: yes })),
				{ everyTools: 1 },
				dir,
			);
			await harness.session.prompt("/board on");
			const asked: string[] = [];
			const agent = [
				work("edit", { path: "a.ts" }),
				work("edit", { path: "b.ts" }),
				fauxAssistantMessage("Edited."),
			];
			const writer = () => JSON.stringify({ progress: "p", now: "n", confirm: [] });
			harness.setResponses(Array.from({ length: 8 }, () => router(agent, writer, asked)));
			await harness.session.prompt("Change a.ts and b.ts.");
			await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
			// The conversation's model wrote it instead.
			expect(boards(harness).every((board) => board.by === "model")).toBe(true);
			const needed = events.filter((event) => event.kind === "board.model_needed");
			expect(needed.map((event) => event.payload)).toEqual([
				expect.objectContaining({ reason: "unusable", model: "gone/a-model-that-left" }),
			]);
			expect(notes.filter((note) => note.includes("isn't available here"))).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drops a look still running when the session ends, and cancels its writer", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const count = { reads: 0 };
		const { harness, events } = await start(async (request): Promise<Record<string, Answer>> => {
			if (!("phase" in request.questions)) return {};
			count.reads++;
			await gate;
			return { phase: choice("changing"), needs_user: no, changed: yes };
		});
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [work("edit", { path: "a.ts" }), fauxAssistantMessage("Edited a.ts.")];
		const writer = [JSON.stringify({ progress: "Halfway.", now: "It changed a.ts.", confirm: [] })];
		harness.setResponses(Array.from({ length: 6 }, () => router(agent, writer, asked)));
		await harness.session.prompt("Change a.ts.");
		await vi.waitFor(() => expect(count.reads).toBe(1), { timeout: 5000 });

		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		release();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(boards(harness)).toEqual([]);
		expect(events.some((event) => event.kind === "board.update")).toBe(false);
		expect(asked).toEqual([]);
	});
	it("puts a permission the agent waits for on the board at once, and takes it off once answered", async () => {
		vi.stubEnv("MU_PERMISSIONS", "ask");
		const judged: string[] = [];
		const whileAsked: string[] = [];
		let events: KyrnPresentationEvent[] = [];
		const started = await start(
			(request) => {
				if ("phase" in request.questions) judged.push(eventsOf(request));
				return reading(() => ({ phase: choice("checking"), needs_user: no, changed: yes }))(request);
			},
			{},
			undefined,
			{
				select: async (_title: string, options: string[]) => {
					const shown = events.filter((event) => event.kind === "board.update").at(-1)?.payload as
						| BoardUpdate
						| undefined;
					whileAsked.push(...(shown?.confirm ?? []));
					return options[0];
				},
			},
			{ only: ["permissions"] },
		);
		events = started.events;
		const { harness } = started;
		await harness.session.prompt("/board on");
		const agent = [work("bash", { command: "npm test" }), fauxAssistantMessage("Tests pass.")];
		harness.setResponses(Array.from({ length: 6 }, () => router(agent, [], [])));
		await harness.session.prompt("Run the tests.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
		// While the picker was open, the board already said what waits on the person, from fixed sentences.
		expect(whileAsked).toEqual(["mu wants to run a command: npm test. It's waiting for your permission."]);
		const updates = events
			.filter((event) => event.kind === "board.update")
			.map((event) => event.payload as BoardUpdate);
		const asked = updates.findIndex((update) => update.needsUser && update.confirm.length > 0);
		expect(asked).toBeGreaterThanOrEqual(0);
		expect(updates[asked]).toMatchObject({ by: "rules", confirmCodes: [null] });
		expect(updates[asked + 1]).toMatchObject({ needsUser: false, confirm: [] });
		// Answered, it is a thing that happened, for the judge to weigh as news.
		expect(judged.join("\n")).toContain("asked the person's permission for: npm test -> allowed");
	});

	it("does not sum up while a goal sends the agent back to work, and tells the person that it did", async () => {
		const judged: string[] = [];
		const { harness } = await start(
			(request) => {
				if ("achieved" in request.questions) return { achieved: no, needs_user: no };
				if ("phase" in request.questions) judged.push(eventsOf(request));
				return reading(() => ({ phase: choice("changing"), needs_user: no, changed: yes }))(request);
			},
			{},
			undefined,
			{},
			{ only: ["goal"], features: { goal: { checker: "jev", maxContinuations: 1 } } },
		);
		await harness.session.prompt("/board on");
		const agent = [
			work("edit", { path: "a.ts" }),
			fauxAssistantMessage("Changed a.ts."),
			work("edit", { path: "b.ts" }),
			fauxAssistantMessage("Changed b.ts too."),
		];
		harness.setResponses(Array.from({ length: 10 }, () => router(agent, [], [])));
		await harness.session.prompt("/goal every test passes");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 8000 });
		// The first run's end was no end for the person: the goal sent the agent back, and the board said so.
		expect(boards(harness).filter((update) => update.ended)).toHaveLength(1);
		expect(judged.join("\n")).toContain("mu sent it back to work, round 1");
		expect(judged.at(-1)).toContain("the goal is paused");
	});

	it("looks at what the subagents do while they work, on a clock, and tells the person about them", async () => {
		const judged: JudgeRequest[] = [];
		const dir = mkdtempSync(join(tmpdir(), "mu-board-swarm-"));
		temporary.push(dir);
		const delegate: AgentTool = {
			name: "delegate",
			label: "delegate",
			description: "delegate",
			parameters: Type.Object({ tasks: Type.Array(Type.Object({ title: Type.String() })) }),
			execute: async (_id, params) => {
				const run = new SwarmRun<object>({
					kind: "delegate",
					title: "2 tasks",
					dir,
					bees: (params as { tasks: { title: string }[] }).tasks.map((task) => ({
						name: task.title,
						task: { title: task.title, instructions: "look" },
						assignment: {},
						role: "scout",
					})),
				});
				const outcomes = await run.run(async () => {
					await new Promise((resolve) => setTimeout(resolve, 1500));
					return "found it";
				});
				return {
					content: [{ type: "text", text: outcomes.map((outcome) => outcome.report).join("\n") }],
					details: {},
				};
			},
		};
		const { harness } = await start(
			(request) => {
				if ("phase" in request.questions) judged.push(request);
				return reading(() => ({ phase: choice("understanding"), needs_user: no, changed: yes }))(request);
			},
			{},
			undefined,
			{},
			{ tools: [delegate] },
		);
		await harness.session.prompt("/board on");
		const agent = [
			fauxAssistantMessage([fauxToolCall("delegate", { tasks: [{ title: "scout" }, { title: "fixer" }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("They found it."),
		];
		harness.setResponses(Array.from({ length: 6 }, () => router(agent, [], [])));
		await harness.session.prompt("Find the bug.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 8000 });
		const stateOf = (request: JudgeRequest | undefined) => (request?.state ?? {}) as Record<string, unknown>;
		// A look while they worked, from the clock: the judge saw who was out and what each was doing.
		const during = judged.find((request) => "sub_agents" in stateOf(request));
		expect(String(stateOf(during).sub_agents)).toMatch(/^delegate, sent \d+ s ago, 2 subagents \(0 finished\):/);
		// By name, as the writer must report them; the role only when it is not the name.
		expect(String(stateOf(during).sub_agents)).toContain("\n- scout: ");
		expect(String(stateOf(during).sub_agents)).toContain("\n- fixer (scout): ");
		const shown = boards(harness).find((update) => !update.ended && update.now.includes("Subagents"));
		expect(shown?.now).toBe("Subagents are working on parts of it in parallel; waiting for them to finish.");
		// Sending them out and their coming back are events, in a person's words, not the JSON of the call.
		expect(String(stateOf(during).events)).toContain("sent out 2 subagents: scout, fixer");
		expect(judged.map((request) => String(stateOf(request).events)).join("\n")).toContain(
			"delegate 2 subagents: scout, fixer -> ok",
		);
	});

	/** A delegate whose two subagents work for `ms`, standing in the same place all along. */
	const slowDelegate = (dir: string, ms: number): AgentTool => ({
		name: "delegate",
		label: "delegate",
		description: "delegate",
		parameters: Type.Object({ tasks: Type.Array(Type.Object({ title: Type.String() })) }),
		execute: async (_id, params) => {
			const run = new SwarmRun<object>({
				kind: "delegate",
				title: "2 tasks",
				dir,
				bees: (params as { tasks: { title: string }[] }).tasks.map((task) => ({
					name: task.title,
					task: { title: task.title, instructions: "look" },
					assignment: {},
					role: "scout",
				})),
			});
			await run.run(async () => {
				await new Promise((resolve) => setTimeout(resolve, ms));
				return "found it";
			});
			return { content: [{ type: "text", text: "found it" }], details: {} };
		},
	});

	it("while subagents work, looks on the clock only when one of them started, finished or failed", async () => {
		const looks = async (board: Record<string, unknown>): Promise<number> => {
			const judged: JudgeRequest[] = [];
			const dir = mkdtempSync(join(tmpdir(), "mu-board-follow-"));
			temporary.push(dir);
			const { harness } = await start(
				(request) => {
					if ("phase" in request.questions) judged.push(request);
					return reading(() => ({ phase: choice("understanding"), needs_user: no, changed: yes }))(request);
				},
				board,
				undefined,
				{},
				{ tools: [slowDelegate(dir, 3500)] },
			);
			await harness.session.prompt("/board on");
			const agent = [
				fauxAssistantMessage([fauxToolCall("delegate", { tasks: [{ title: "scout" }, { title: "fixer" }] })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("They found it."),
			];
			harness.setResponses(Array.from({ length: 6 }, () => router(agent, [], [])));
			await harness.session.prompt("Find the bug.");
			await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 10000 });
			return judged.filter((request) => "sub_agents" in ((request.state ?? {}) as Record<string, unknown>)).length;
		};
		// A tick a second for 3.5 s: the first sees them at work, the others see the same and ask nothing.
		expect(await looks({})).toBe(1);
		expect(await looks({ followAlways: true })).toBeGreaterThan(1);
	}, 20_000);

	it("sums up where each subagent stands, not what it is doing at the moment", () => {
		const bee = (name: string, status: BeeState["status"]): BeeState => ({ ...newBee(name, 0), status });
		const run = (...bees: BeeState[]) => ({ bees });
		expect(swarmState([run(bee("a", "thinking"), bee("b", "queued"))])).toBe("a:working,b:queued");
		// Thinking, a tool, a retry: still at work.
		expect(swarmState([run(bee("a", "tool"), bee("b", "queued"))])).toBe(
			swarmState([run(bee("a", "retrying"), bee("b", "queued"))]),
		);
		expect(swarmState([run(bee("a", "wrapping-up")), run(bee("c", "done"))])).toBe("a:wrapping-up|c:done");
	});

	it("stays off in a one-shot run, where nobody watches it, unless told otherwise", async () => {
		const run = async (board: Record<string, unknown>, mode: "print" | "json") => {
			const count = { reads: 0 };
			const asked: string[] = [];
			const { harness } = await start(
				reading(() => ({ phase: choice("changing"), needs_user: no, changed: yes }), count),
				{ everyTools: 1, ...board },
				undefined,
				{},
				{ mode },
			);
			await harness.session.prompt("/board on");
			const agent = [work("edit", { path: "a.ts" }), fauxAssistantMessage("Edited a.ts.")];
			const writer = () => JSON.stringify({ progress: "Done.", now: "It changed a.ts.", confirm: [] });
			harness.setResponses(Array.from({ length: 6 }, () => router(agent, writer, asked)));
			await harness.session.prompt("Change a.ts.");
			await new Promise((resolve) => setTimeout(resolve, 200));
			return { reads: count.reads, boards: boards(harness).length, writer: asked.length };
		};
		expect(await run({}, "print")).toEqual({ reads: 0, boards: 0, writer: 0 });
		expect(await run({}, "json")).toEqual({ reads: 0, boards: 0, writer: 0 });
		const unattended = await run({ unattended: true }, "print");
		expect(unattended.reads).toBeGreaterThan(0);
		expect(unattended.boards).toBeGreaterThan(0);
	});

	it("hears from the monitor that the agent goes in circles, and looks at once", async () => {
		const judged: string[] = [];
		const { harness } = await start(
			(request) => {
				if ("phase" in request.questions) judged.push(eventsOf(request));
				return reading(() => ({ phase: choice("stuck"), needs_user: no, changed: yes }))(request);
			},
			{ everyTools: 50 },
			undefined,
			{},
			{ only: ["monitor"], features: { monitor: { repeats: 2, every: 100 } } },
		);
		await harness.session.prompt("/board on");
		const agent = [
			work("bash", { command: "npm test" }),
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("I keep getting the same result."),
		];
		harness.setResponses(Array.from({ length: 8 }, () => router(agent, [], [])));
		await harness.session.prompt("Fix the tests.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
		expect(judged.join("\n")).toContain("mu noticed it repeating the same step: bash: npm test -> ok");
		expect(boards(harness).some((update) => !update.ended && update.phase === "stuck")).toBe(true);
	});

	const notesOf = (events: KyrnPresentationEvent[]) =>
		events.filter((event) => event.kind === "board.note").map((event) => event.payload as BoardNote);

	it("keeps a running account: a line the moment a step ends, reading folded into one line that grows", async () => {
		const { harness, events } = await start(
			reading(() => ({ phase: choice("changing"), needs_user: no, changed: yes })),
			{ everyTools: 100 },
		);
		await harness.session.prompt("/board on");
		const agent = [
			work("read", { path: "src/a.ts" }),
			work("read", { path: "src/b.ts" }),
			work("edit", { path: "/work/app/src/importer.ts" }),
			work("bash", { command: "npm test" }),
			fauxAssistantMessage("Done."),
		];
		const writer = () => JSON.stringify({ progress: "p", now: "n", confirm: [], note: "" });
		harness.setResponses(Array.from({ length: 10 }, () => router(agent, writer, [])));
		await harness.session.prompt("Make the importer skip empty files.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
		const notes = notesOf(events);
		expect(notes.map((note) => `${note.by}:${note.code}:${note.text}`)).toEqual([
			"rules:looked:Looked at 1 file or location",
			"rules:looked:Looked at 2 files or locations",
			"rules:changed_file:Edited src/importer.ts",
			"rules:check_passed:Check passed: npm test",
			"rules:ended:Stopped.",
		]);
		expect(notes[1]).toMatchObject({ sequence: notes[0].sequence, at: notes[0].at, params: { count: 2 } });
		expect(notes[2].kind).toBe("step");
		expect(notes[3].kind).toBe("check");
		// The lines came as the steps ended, before any board was written.
		const kinds = events.filter((event) => event.kind.startsWith("board.")).map((event) => event.kind);
		expect(kinds.indexOf("board.note")).toBeLessThan(kinds.indexOf("board.update"));
		// The board carries the account, for the terminal's /board and for a reopened session.
		expect(
			boards(harness)
				.at(-1)
				?.log?.map((note) => note.code),
		).toEqual(["looked", "changed_file", "check_passed", "ended"]);
		expect(JSON.stringify(harness.session.messages)).not.toContain("Looked at");
	});

	it("retells what the agent said as soon as the judge calls it news, and stays quiet about routine remarks", async () => {
		const { harness, events } = await start(
			picking(/Found it/, () => ({ phase: choice("changing"), needs_user: no, changed: no })),
			{ everyTools: 100 },
		);
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [
			fauxAssistantMessage(
				[fauxText("Let me look at the importer."), fauxToolCall("read", { path: "src/importer.ts" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxText("Found it: empty files crash the parser."), fauxToolCall("edit", { path: "src/importer.ts" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Fixed."),
		];
		// The writer adds a line to the account only when the news gives it something to tell.
		const writer = (request: string) =>
			JSON.stringify(
				request.includes(ENDED)
					? { progress: "All done.", now: "Finished.", confirm: [], note: "It fixed the crash on empty files." }
					: request.includes("- the agent said: Found it")
						? {
								progress: "Found the cause.",
								now: "Changing the importer.",
								confirm: [],
								note: "It found why: an empty file made the reader crash.",
							}
						: { progress: "Starting.", now: "Reading the importer.", confirm: [], note: "" },
			);
		harness.setResponses(Array.from({ length: 10 }, () => router(agent, writer, asked)));
		await harness.session.prompt("Make the importer skip empty files.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
		const told = notesOf(events).filter((note) => note.by === "model");
		expect(told.map((note) => [note.kind, note.text])).toEqual([
			["said", "It found why: an empty file made the reader crash."],
			["ended", "It fixed the crash on empty files."],
		]);
		// The finding was told while the agent still worked, not with the summing up.
		const shown = events.filter((event) => event.kind === "board.note" || event.kind === "board.update");
		const finding = shown.findIndex((event) => (event.payload as BoardNote).text === told[0].text);
		const summedUp = shown.findIndex(
			(event) => event.kind === "board.update" && (event.payload as BoardUpdate).ended,
		);
		expect(finding).toBeLessThan(summedUp);
		// The first look wrote the first board; "Let me look" was routine and got no news; the finding did, and the
		// writer saw the account so far; the end summed up.
		expect(asked).toHaveLength(3);
		expect(asked[0]).toContain("- (nothing new)");
		expect(asked[1]).toContain("NEWS SINCE THE PREVIOUS UPDATE (oldest first):\\n- the agent said: Found it");
		expect(asked[1]).toContain("ALREADY ON THE ACCOUNT");
		expect(asked[1]).toContain("- Looked at 1 file or location");
		expect(asked[2]).toContain(ENDED);
	});

	it("quotes the agent's own words when the writer does not answer, so the account still has the finding", async () => {
		const { harness, events } = await start(
			picking(/Found it/, () => ({ phase: choice("changing"), needs_user: no, changed: no })),
			{ everyTools: 100 },
		);
		await harness.session.prompt("/board on");
		const agent = [
			fauxAssistantMessage(
				[fauxText("Found it: empty files crash the parser."), fauxToolCall("edit", { path: "src/importer.ts" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Fixed."),
		];
		harness.setResponses(Array.from({ length: 8 }, () => router(agent, () => "I would rather not.", [])));
		await harness.session.prompt("Make the importer skip empty files.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
		// The quote and the edit's line race (the writer answers while the edit runs); the end comes last.
		const lines = notesOf(events).map((note) => `${note.code}:${note.text}`);
		expect(lines.slice(0, 2).sort()).toEqual([
			"changed_file:Edited src/importer.ts",
			"said_quote:It said: Found it: empty files crash the parser.",
		]);
		expect(lines[2]).toBe("ended:Stopped.");
		expect(lines).toHaveLength(3);
	});

	it("tells the writer why a check failed, from its output, without the credential in it", async () => {
		const token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
		const failing: AgentTool = {
			...tool("bash"),
			execute: async () => {
				throw new Error(
					[
						" RUN  v4.1.11 /work/app",
						" ✓ test/a.test.ts (3 tests) 12ms",
						" FAIL  test/retry.test.ts > retries 3 times",
						"AssertionError: expected 3 attempts, received 2",
						`Error: the reporter could not upload with ${token}`,
						" Test Files  1 failed | 1 passed (2)",
					].join("\n"),
				);
			},
		};
		const { harness, events } = await start(
			reading(() => ({ phase: choice("fixing"), needs_user: no, changed: yes })),
			{ everyTools: 100 },
			undefined,
			{},
			{ tools: [failing] },
		);
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [
			fauxAssistantMessage(
				[
					fauxText("Running the retry test."),
					fauxToolCall("bash", { command: "npx vitest --run test/retry.test.ts" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("It fails: one attempt short."),
		];
		const writer = (request: string) =>
			JSON.stringify(
				request.includes(ENDED)
					? { headline: "Stopped: the retry test fails", progress: "p", now: "n", confirm: [] }
					: { headline: "Running the retry test", progress: "p", now: "It runs the retry test.", confirm: [] },
			);
		harness.setResponses(Array.from({ length: 10 }, () => router(agent, writer, asked)));
		await harness.session.prompt("test/retry.test.ts 在 CI 上时不时挂，帮我查一下。");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
		const all = asked.join("\n");
		// Why it failed, from its own output: the error lines, not the passing ones.
		expect(all).toContain(
			'bash npx vitest --run test/retry.test.ts -> error: \\"FAIL test/retry.test.ts > retries 3 times | AssertionError: expected 3 attempts, received 2 | Error: the reporter could not upload with [redacted]\\"',
		);
		expect(all).not.toContain(token);
		// Taken out where the excerpt is made: the judge and the panel get it too.
		const news = boards(harness).flatMap((kept) => kept.news ?? []);
		expect(news.join("\n")).toContain("[redacted]");
		expect(JSON.stringify(boards(harness))).not.toContain(token);
		// The second request shows what the person saw: the first board's words.
		expect(asked.at(-1)).toContain(
			"PREVIOUS UPDATE (what the person sees now):\\n  headline: Running the retry test",
		);
		expect(asked.at(-1)).toContain("Write in Simplified Chinese.");
		const failed = notesOf(events).find((note) => note.code === "check_failed");
		expect(failed).toMatchObject({ failed: true, params: { command: "npx vitest --run test/retry.test.ts" } });
		expect(failureExcerpt({ content: [{ type: "text", text: "\u001b[31mError: boom\u001b[0m" }] })).toBe(
			"Error: boom",
		);
		expect(failureExcerpt({ content: [{ type: "text", text: "a\nb\nc" }] })).toBe("b | c");
		expect(failureExcerpt({ content: [] })).toBeUndefined();
	});

	it("keeps a permission on the board while a look that started before it was asked writes", async () => {
		vi.stubEnv("MU_PERMISSIONS", "ask");
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const asked: string[] = [];
		let events: KyrnPresentationEvent[] = [];
		const updates = () =>
			events.filter((event) => event.kind === "board.update").map((event) => event.payload as BoardUpdate);
		let whilePicking: BoardUpdate | undefined;
		const started = await start(
			reading(() => ({ phase: choice("checking"), needs_user: no, changed: yes })),
			{},
			undefined,
			{
				// The picker is open: the slow writer answers now, and its board must still say what waits on the person.
				select: async (_title: string, options: string[]) => {
					release();
					await vi.waitFor(() => expect(updates().some((update) => update.by === "model")).toBe(true), {
						timeout: 5000,
					});
					whilePicking = updates().at(-1);
					return options[0];
				},
			},
			{ only: ["permissions"] },
		);
		events = started.events;
		const { harness } = started;
		await harness.session.prompt("/board on");
		const agent = [
			fauxAssistantMessage([fauxText("Running the tests now."), fauxToolCall("bash", { command: "npm test" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Tests pass."),
		];
		const slow: FauxResponseFactory = async (context) => {
			const request = JSON.stringify(context.messages);
			if (!request.includes(WRITER)) return agent.shift() ?? fauxAssistantMessage("no more agent replies");
			asked.push(request);
			if (asked.length === 1) await gate;
			return fauxAssistantMessage(
				JSON.stringify({
					headline: "It is running the tests",
					progress: "p",
					now: "It runs npm test.",
					confirm: [],
				}),
			);
		};
		harness.setResponses(Array.from({ length: 8 }, () => slow));
		await harness.session.prompt("Run the tests.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 8000 });
		// The writer had not heard of the ask, and its board went out while the picker was open: the ask stayed.
		expect(asked[0]).toContain("WAITING FOR THE PERSON: no");
		expect(whilePicking).toMatchObject({
			by: "model",
			now: "It runs npm test.",
			needsUser: true,
			phase: "waiting",
			confirm: ["mu wants to run a command: npm test. It's waiting for your permission."],
			headline: "Waiting for your permission: npm test",
			headlineCode: "waiting_permission",
			headlineParams: { what: "npm test" },
		});
		// The ask itself, at once and by rule, says the agent waits: not the stage it was in before.
		const ask = updates().find((update) => update.headlineCode === "waiting_permission");
		expect(ask).toMatchObject({ phase: "waiting", needsUser: true });
		// Answered: off the board.
		const after = updates().slice(updates().indexOf(whilePicking as BoardUpdate) + 1);
		expect(after[0]).toMatchObject({ needsUser: false, confirm: [] });
		expect(after[0].headlineCode).not.toBe("waiting_permission");
	});

	/** A delegate like the real one: it streams snapshots while its subagents work and returns the last one. */
	const streamingDelegate = (dir: string, limits: Record<string, number> = {}): AgentTool => ({
		name: "delegate",
		label: "delegate",
		description: "delegate",
		parameters: Type.Object({ tasks: Type.Array(Type.Object({ title: Type.String() })) }),
		execute: async (_id, params, signal, onUpdate) => {
			const run = new SwarmRun<object>({
				kind: "delegate",
				title: "2 tasks",
				dir,
				limits,
				bees: (params as { tasks: { title: string }[] }).tasks.map((task) => ({
					name: task.title,
					task: { title: task.title, instructions: "look" },
					assignment: {},
					role: task.title === "fixer" ? "worker" : "scout",
				})),
			});
			run.onChange = () =>
				onUpdate?.({ content: [{ type: "text", text: "…" }], details: { snapshot: run.snapshot() } });
			const outcomes = await run.run(async (task, _assignment, stop, _env, observer) => {
				observer?.event({ type: "agent_start" });
				if (task.title === "scout") {
					await new Promise((resolve) => setTimeout(resolve, 300));
					observer?.event({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "backoff() reads Date.now() twice." }],
						},
					});
					return "backoff() reads Date.now() twice.";
				}
				// fixer starts a test in watch mode and never says anything again: the watchdog stops it.
				observer?.event({
					type: "tool_execution_start",
					toolName: "bash",
					args: { command: "npx vitest test/retry.test.ts" },
				});
				return new Promise<string>((_resolve, reject) =>
					stop?.addEventListener("abort", () => reject(new Error("stopped"))),
				);
			}, signal);
			return {
				content: [{ type: "text", text: outcomes.map((outcome) => outcome.report).join("\n") }],
				details: { snapshot: run.snapshot(), reports: outcomes.map((outcome) => outcome.report) },
			};
		},
	});

	it("tells each subagent's end as it happens, names the one that timed out, and lists who is doing what", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-board-helpers-"));
		temporary.push(dir);
		const judged: string[] = [];
		const { harness, events } = await start(
			(request) => {
				if ("phase" in request.questions) judged.push(eventsOf(request));
				return reading(() => ({ phase: choice("understanding"), needs_user: no, changed: yes }))(request);
			},
			{},
			undefined,
			{},
			{ tools: [streamingDelegate(dir, { toolStallSeconds: 1, beeMinutes: 0 })] },
		);
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [
			fauxAssistantMessage([fauxToolCall("delegate", { tasks: [{ title: "scout" }, { title: "fixer" }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("scout found it; fixer timed out."),
		];
		// The writer names a subagent the facts never mentioned: that one is dropped.
		const writer = () =>
			JSON.stringify({
				headline: "scout is back, fixer is still on the test",
				progress: "p",
				now: "n",
				agents: [
					{ who: "fixer", doing: "running the retry test" },
					{ who: "ghost", doing: "haunting" },
				],
				confirm: [],
			});
		harness.setResponses(Array.from({ length: 12 }, () => router(agent, writer, asked)));
		await harness.session.prompt("Find why retry.test.ts is flaky.");
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 10_000 });

		const lines = notesOf(events).filter((note) => note.kind === "helpers");
		expect(lines.map((note) => `${note.code}:${note.who ?? ""}:${note.text}`)).toEqual([
			"helpers_sent::Started 2 subagents: scout, fixer",
			"helper_done:scout:scout is back: backoff() reads Date.now() twice.",
			"helper_failed:fixer:fixer timed out",
			"helpers_back::2 subagents finished, 1 with errors",
		]);
		expect(lines[2]).toMatchObject({ failed: true, params: { name: "fixer", reason: "timed_out" } });
		expect(String(lines[2].params?.detail)).toContain("no sign of life from its bash call");
		expect(lines[3]).toMatchObject({ failed: true, params: { count: 2, failed: 1 } });
		// Each end was news for the judge while the delegation still ran, not only once it returned.
		const scoutBack = judged.findIndex((text) =>
			text.includes("scout came back, reporting: backoff() reads Date.now() twice."),
		);
		const fixerOut = judged.findIndex((text) => text.includes("fixer timed out: no sign of life"));
		expect(scoutBack).toBeGreaterThanOrEqual(0);
		expect(fixerOut).toBeGreaterThan(scoutBack);
		expect(judged.slice(0, fixerOut + 1).join("\n")).not.toContain("delegate 2 subagents: scout, fixer ->");
		// The writer was told who is out, by name, and the board lists them by rule with its words for a known name.
		expect(asked.some((request) => request.includes("SUBAGENTS:\\ndelegate, sent"))).toBe(true);
		const withAgents = events
			.filter((event) => event.kind === "board.update")
			.map((event) => event.payload as BoardUpdate)
			.find((update) => update.by === "model" && update.agents?.some((agent) => agent.state === "done"));
		expect(withAgents?.agents?.map((agent) => agent.who)).toEqual(["scout", "fixer"]);
		expect(withAgents?.agents?.[0]).not.toHaveProperty("role");
		expect(withAgents?.agents?.[0]).toMatchObject({
			who: "scout",
			state: "done",
			doing: "backoff() reads Date.now() twice.",
		});
		expect(withAgents?.agents?.[1]).toMatchObject({
			who: "fixer",
			role: "worker",
			state: "working",
			doing: "running the retry test",
		});
		expect(typeof withAgents?.agents?.[1].sinceMs).toBe("number");
		// Without subagents at work, no list.
		expect(boards(harness).at(-1)).not.toHaveProperty("agents");
	}, 20_000);

	it("calls each subagent by the label the writer gave it, keeps the label across looks, and keeps the name as its identifier", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-board-labels-"));
		temporary.push(dir);
		const AUDIT = "audit timing in src/retry.ts";
		const REWRITE = "rewrite retry.test.ts with fake timers";
		let shown: KyrnPresentationEvent[] = [];
		const updates = () =>
			shown.filter((event) => event.kind === "board.update").map((event) => event.payload as BoardUpdate);
		const labelled = () => updates().some((update) => update.agents?.some((agent) => agent.label));
		const stalledByLabel = () =>
			notesOf(shown).some((note) => note.code === "still_running" && note.label === "改测试");
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const delegate: AgentTool = {
			name: "delegate",
			label: "delegate",
			description: "delegate",
			parameters: Type.Object({ tasks: Type.Array(Type.Object({ title: Type.String() })) }),
			execute: async (_id, params, signal, onUpdate) => {
				const run = new SwarmRun<object>({
					kind: "delegate",
					title: "2 tasks",
					dir,
					bees: (params as { tasks: { title: string }[] }).tasks.map((task) => ({
						name: task.title,
						task: { title: task.title, instructions: "look" },
						assignment: {},
						role: task.title === AUDIT ? "scout" : "worker",
					})),
				});
				run.onChange = () =>
					onUpdate?.({ content: [{ type: "text", text: "…" }], details: { snapshot: run.snapshot() } });
				const outcomes = await run.run(async (task, _assignment, _stop, _env, observer) => {
					observer?.event({ type: "agent_start" });
					if (task.title === AUDIT) {
						// Back once the board has named it.
						await vi.waitFor(() => expect(labelled()).toBe(true), { timeout: 8000 });
						const report = "backoff() reads Date.now() twice.";
						observer?.event({
							type: "message_end",
							message: { role: "assistant", content: [{ type: "text", text: report }] },
						});
						return report;
					}
					// The other starts a test and says nothing until the test lets it go.
					observer?.event({
						type: "tool_execution_start",
						toolName: "bash",
						args: { command: "npx vitest test/retry.test.ts" },
					});
					await gate;
					return "rewrote it";
				}, signal);
				return {
					content: [{ type: "text", text: outcomes.map((outcome) => outcome.report).join("\n") }],
					details: { snapshot: run.snapshot(), reports: outcomes.map((outcome) => outcome.report) },
				};
			},
		};
		const widgets: string[][] = [];
		const started = await start(
			reading(() => ({ phase: choice("understanding"), needs_user: no, changed: yes })),
			{ language: "zh", stallMs: 1000 },
			undefined,
			{
				setWidget: (key: string, lines?: string[]) => {
					if (key === "mu-board" && lines) widgets.push(lines);
				},
			},
			{ tools: [delegate], mode: "tui" },
		);
		const { harness, events } = started;
		shown = events;
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [
			fauxAssistantMessage([fauxToolCall("delegate", { tasks: [{ title: AUDIT }, { title: REWRITE }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("两个都回来了。"),
		];
		// Only the first reply gives labels; the later ones leave them out, and a label once given stays.
		const writer = () =>
			JSON.stringify({
				headline: `看板 ${asked.length}`,
				progress: "p",
				now: "n",
				blocked: "",
				agents:
					asked.length === 1
						? [
								{ who: AUDIT, label: "查计时", doing: "在查计时" },
								{ who: REWRITE, label: "改测试", doing: "在改测试" },
							]
						: [
								{ who: AUDIT, doing: "查完了" },
								{ who: REWRITE, doing: "跑测试" },
							],
				confirm: [],
			});
		harness.setResponses(Array.from({ length: 16 }, () => router(agent, writer, asked)));
		const done = harness.session.prompt("test/retry.test.ts 时不时挂，查一下。");
		await vi.waitFor(() => expect(stalledByLabel()).toBe(true), { timeout: 10_000 });
		release();
		await done;
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 10_000 });

		// The account: the sentence says the label, `who` and the params keep the name.
		const back = notesOf(events).find((note) => note.code === "helper_done");
		expect(back).toMatchObject({
			who: AUDIT,
			label: "查计时",
			text: "查计时 回来了：backoff() reads Date.now() twice.",
			params: { name: AUDIT },
		});
		const stall = notesOf(events)
			.filter((note) => note.code === "still_running" && note.label)
			.at(-1);
		expect(stall).toMatchObject({
			who: REWRITE,
			label: "改测试",
			params: { who: REWRITE, what: "npx vitest test/retry.test.ts" },
		});
		expect(stall?.text).toMatch(/^改测试 跑 npx vitest test\/retry\.test\.ts \d+ 分钟没动静$/);
		// The writer heard the labels once given, beside the names.
		expect(asked[0]).not.toContain("(label: 查计时)");
		expect(asked.slice(1).some((request) => request.includes(`${AUDIT} (label: 查计时) (scout)`))).toBe(true);
		expect(asked.slice(1).some((request) => request.includes(`${REWRITE} (label: 改测试) (worker)`))).toBe(true);
		// Every board after the labels came lists the subagents by name with their labels, though later replies
		// gave none.
		const first = updates().findIndex((update) => update.agents?.some((each) => each.label));
		const later = updates()
			.slice(first)
			.filter((update) => update.agents?.length);
		expect(later.length).toBeGreaterThan(1);
		for (const update of later) {
			expect(update.agents?.map((each) => [each.who, each.label])).toEqual([
				[AUDIT, "查计时"],
				[REWRITE, "改测试"],
			]);
		}
		expect(later.at(-1)?.agents?.[0]).toMatchObject({ doing: "查完了" });
		// What the rules word themselves call it by the label too: what is stuck, and the headline before the writer's.
		const blocked = updates().find(
			(update) => update.blockedCode === "still_running" && update.blocked?.startsWith("改测试"),
		);
		expect(blocked?.blockedParams).toMatchObject({ who: REWRITE });
		const headline = updates().find(
			(update) => update.headlineCode === "still_running" && update.headline?.startsWith("改测试 跑"),
		);
		expect(headline?.headlineParams).toMatchObject({ who: REWRITE });
		// The terminal's three lines say the labels.
		const lines = widgets.flat();
		expect(lines.some((line) => line.startsWith("  · 查计时 回来了："))).toBe(true);
		expect(lines.some((line) => line.startsWith("  卡在: 改测试 跑 npx vitest"))).toBe(true);
	}, 30_000);

	it("says a long call is still running, on one line that grows, with one look at 1, 3 and 10 minutes", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let running = false;
		const slowBash: AgentTool = {
			...tool("bash"),
			execute: async () => {
				running = true;
				await gate;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const judged: string[] = [];
		const { harness, events } = await start(
			(request) => {
				if ("phase" in request.questions) judged.push(eventsOf(request));
				return reading(() => ({ phase: choice("blocked"), needs_user: no, changed: yes }))(request);
			},
			{ everyTools: 100 },
			undefined,
			{},
			{ tools: [slowBash] },
		);
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [work("bash", { command: "npm run e2e" }), fauxAssistantMessage("The e2e tests pass.")];
		const writer = () =>
			JSON.stringify({ headline: "e2e tests are running", progress: "p", now: "n", blocked: "", confirm: [] });
		harness.setResponses(Array.from({ length: 12 }, () => router(agent, writer, asked)));
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.now() });
		try {
			const done = harness.session.prompt("Run the e2e tests.");
			await vi.waitFor(() => expect(running).toBe(true), { timeout: 5000 });
			const stallLooks = () => judged.filter((text) => text.includes("is still running")).length;
			// The clock ticks every 15 s: each step is crossed at the first tick past it.
			let at = 0;
			for (const [seconds, looks] of [
				[75, 1],
				[195, 2],
				[615, 3],
				[1500, 3],
			]) {
				await vi.advanceTimersByTimeAsync((seconds - at) * 1000);
				at = seconds;
				await vi.waitFor(() => expect(stallLooks()).toBe(looks), { timeout: 5000 });
			}
			release();
			await done;
		} finally {
			vi.useRealTimers();
		}
		await vi.waitFor(() => expect(boards(harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
		const stalls = notesOf(events).filter((note) => note.code === "still_running");
		expect(stalls.map((note) => note.params?.minutes)).toEqual([1, 3, 10]);
		expect(new Set(stalls.map((note) => `${note.sequence}:${note.at}`)).size).toBe(1);
		expect(stalls.at(-1)?.text).toBe("Still running npm run e2e, 10 min in");
		// The writer heard what is in flight and for how long, and the board says what is stuck when it did not.
		expect(
			asked.some((request) => request.includes("IN FLIGHT:\\n- main agent: bash `npm run e2e` running for 10 min")),
		).toBe(true);
		const shown = events
			.filter((event) => event.kind === "board.update")
			.map((event) => event.payload as BoardUpdate);
		const late = shown.filter((update) => !update.ended && update.by === "model").at(-1);
		expect(late).toMatchObject({
			phase: "blocked",
			headline: "e2e tests are running",
			blocked: "Still running npm run e2e, 10 min in",
			blockedCode: "still_running",
			blockedParams: { what: "npm run e2e", minutes: 10 },
		});
		// Before the writer's words, the rules' headline went out at once.
		expect(shown.some((update) => update.headlineCode === "still_running")).toBe(true);
		// Once the call ended, its line stays in the account but grows no more, and the step has its own line.
		expect(notesOf(events).at(-2)?.code).toBe("ran_command");
	}, 20_000);

	it("writes the board even when something new keeps arriving while the judge reads, once the board is stale", async () => {
		const writes = async (board: Record<string, unknown>): Promise<number> => {
			let reads = 0;
			let answered = 0;
			let harness: Harness | undefined;
			// The agent reads until the judge has answered four looks, so every look comes while it works.
			const read: AgentTool = {
				...tool("read"),
				execute: async () => {
					await vi.waitFor(() => expect(answered).toBe(4), { timeout: 5000 });
					await new Promise((resolve) => setTimeout(resolve, 100));
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			};
			const started = await start(
				async (request): Promise<Record<string, Answer>> => {
					if (!("phase" in request.questions)) return {};
					reads++;
					await new Promise((resolve) => setTimeout(resolve, 5));
					// Every look but the fourth: the agent says something more while the judge reads.
					if (reads <= 3) {
						await harness?.session.extensionRunner.emitMessageEnd({
							type: "message_end",
							message: fauxAssistantMessage([fauxText(`Still looking (${reads}).`)], { stopReason: "toolUse" }),
						});
					}
					answered++;
					return { phase: choice("understanding"), needs_user: no, changed: yes };
				},
				{ everyTools: 100, ...board },
				undefined,
				{},
				{ tools: [read] },
			);
			harness = started.harness;
			await harness.session.prompt("/board on");
			const asked: string[] = [];
			const agent = [
				fauxAssistantMessage([fauxText("Let me look."), fauxToolCall("read", { path: "a.ts" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Done looking."),
			];
			const writer = () =>
				JSON.stringify({ headline: `Look ${asked.length}`, progress: "p", now: "n", confirm: [] });
			harness.setResponses(Array.from({ length: 10 }, () => router(agent, writer, asked)));
			await harness.session.prompt("Look at a.ts.");
			await vi.waitFor(() => expect(boards(started.harness).at(-1)?.ended).toBe(true), { timeout: 5000 });
			return asked.filter((request) => !request.includes(ENDED)).length;
		};
		// The first board is written although more came in while the judge read: there was none to fall back on.
		// With a fresh board, a look overtaken by more leaves the writing to the one after it.
		expect(await writes({ maxStaleMs: 60_000 })).toBe(2);
		// Once the board the person sees is older than maxStaleMs, every look writes.
		expect(await writes({ maxStaleMs: 0 })).toBe(4);
	});
});

describe("board and subagents", () => {
	it("describes a delegation and the subagents at work as a person hears of them", () => {
		expect(describeSwarmCall("delegate", { tasks: [{ title: "scout" }, { title: " fixer " }, {}] })).toBe(
			"3 subagents: scout, fixer, a task",
		);
		expect(describeSwarmCall("hive", { goal: "why the login fails", bees: [{ name: "repro" }] })).toBe(
			"1 investigator on: why the login fails",
		);
		expect(describeSwarmCall("bash", { command: "ls" })).toBeUndefined();

		const start = 1_000_000;
		const now = start + 5 * 60_000;
		const bee = (name: string, status: BeeState["status"], extra: Partial<BeeState> = {}): BeeState => ({
			...newBee(name, start, { role: "worker" }),
			startedAt: start,
			status,
			...extra,
		});
		const snapshot = {
			kind: "delegate" as const,
			title: "5 tasks",
			startedAt: start,
			now,
			dir: "/tmp/x",
			bees: [
				// Six minutes on one command, nothing out of it for as long, one step failed before.
				bee("fixer", "tool", {
					tool: { name: "bash", summary: "bash npx vitest test/retry.test.ts", startedAt: now - 362_000 },
					lastEventAt: now - 360_000,
					toolErrors: 1,
				}),
				bee("scout", "done", {
					role: "scout",
					endedAt: start + 2 * 60_000,
					finals: ["## Found it\nbackoff() reads Date.now() twice, so the second attempt waits too little."],
				}),
				bee("tests", "queued"),
				bee("lint", "timed-out", { endedAt: now, error: "no sign of life from its bash call for 15m00s" }),
				bee("docs", "retrying", {
					retry: { attempt: 2, maxAttempts: 3, delayMs: 1000, message: "429 rate limited" },
				}),
			],
		};
		expect(describeSwarms([snapshot], now)).toBe(
			[
				"delegate, sent 5 min ago, 5 subagents (2 finished):",
				"- fixer (worker): running bash `npx vitest test/retry.test.ts` for 6 min 2 s; no new output for 6 min; 1 failed step",
				'- scout: back after 2 min; reported: "Found it"',
				"- tests (worker): waiting for a slot",
				"- lint (worker): timed out after 5 min: no sign of life from its bash call for 15m00s",
				"- docs (worker): retrying after an error (attempt 2 of 3): 429 rate limited",
			].join("\n"),
		);
		expect(describeSwarms([])).toBeUndefined();
		expect(firstLine("(Warning: withheld text.)\n## Found it\nmore")).toBe("Found it");
	});

	it("shows the writer the label each subagent has, beside its exact name, for it to keep", () => {
		const start = 1_000_000;
		const now = start + 2 * 60_000;
		const audit = "audit timing in src/retry.ts";
		const rewrite = "rewrite retry.test.ts with fake timers";
		const snapshot = {
			kind: "delegate" as const,
			title: "2 tasks",
			startedAt: start,
			now,
			dir: "/tmp/x",
			bees: [
				{
					...newBee(audit, start, { role: "scout" }),
					startedAt: start,
					status: "done" as const,
					endedAt: now,
					finals: ["backoff() reads Date.now() twice."],
				},
				{
					...newBee(rewrite, start, { role: "worker" }),
					startedAt: start,
					status: "thinking" as const,
					lastEventAt: now,
				},
				{
					...newBee("scout", start, { role: "scout" }),
					startedAt: start,
					status: "thinking" as const,
					lastEventAt: now,
				},
			],
		};
		const swarm = describeSwarms(
			[snapshot],
			now,
			new Map([
				[audit, "查计时"],
				["scout", "scout"],
			]),
		);
		expect(swarm).toBe(
			[
				"delegate, sent 2 min ago, 3 subagents (1 finished):",
				'- audit timing in src/retry.ts (label: 查计时) (scout): back after 2 min; reported: "backoff() reads Date.now() twice."',
				// No label yet: the name alone.
				"- rewrite retry.test.ts with fake timers (worker): thinking, 2 min in",
				"- scout (label: scout): thinking, 2 min in",
			].join("\n"),
		);
		expect(
			narratorRequest({
				language: "zh",
				goal: "修 retry 测试",
				items: [],
				needsUser: false,
				steps: [],
				latest: "",
				swarm,
			}),
		).toContain(
			"SUBAGENTS:\ndelegate, sent 2 min ago, 3 subagents (1 finished):\n- audit timing in src/retry.ts (label: 查计时) (scout): back",
		);
		// The names a delegation gives: the task titles, or the hive's member names.
		expect(swarmNames("delegate", { tasks: [{ title: " scout " }, {}, { title: "fixer" }] })).toEqual([
			"scout",
			"fixer",
		]);
		expect(swarmNames("hive", { goal: "g", bees: [{ name: "repro" }, { name: "history" }] })).toEqual([
			"repro",
			"history",
		]);
		expect(swarmNames("bash", { command: "ls" })).toEqual([]);
	});

	it("tells the writer and the fixed sentences about the helpers", () => {
		const facts = {
			language: "en" as const,
			goal: "find the bug",
			items: [],
			needsUser: false,
			steps: [],
			latest: "",
			swarm: "delegate, sent 1 s ago, 2 subagents (0 finished):\n- a (scout): thinking, 1 s in\n- b (scout): thinking, 1 s in",
		};
		expect(narratorRequest(facts)).toContain(
			"SUBAGENTS:\ndelegate, sent 1 s ago, 2 subagents (0 finished):\n- a (scout)",
		);
		expect(plainBoard(facts).now).toBe(
			"Subagents are working on parts of it in parallel; waiting for them to finish.",
		);
		expect(plainBoard({ ...facts, language: "zh" }).now).toBe("派了几个助手分头干，在等它们回来。");
		expect(plainBoard({ ...facts, ended: true, phase: "wrapping_up" }).now).toBe("The work is done; wrapping up.");
	});
});

describe("board account", () => {
	it("words each line in the person's language, for one or many", () => {
		expect(noteText("looked", { count: 1 }, "en")).toBe("Looked at 1 file or location");
		expect(noteText("looked", { count: 3 }, "en")).toBe("Looked at 3 files or locations");
		expect(noteText("looked", { count: 3 }, "zh")).toBe("看了 3 个文件或地方");
		expect(noteText("check_failed", { command: "npm test" }, "zh")).toBe("检查没通过：npm test");
		expect(noteText("helpers_sent", { count: 1, titles: "scout" }, "en")).toBe("Started 1 subagent: scout");
		expect(noteText("helpers_back", { count: 2 }, "zh")).toBe("2 个助手回来了");
		expect(noteText("helpers_back", { count: 2, failed: 0 }, "en")).toBe("2 subagents finished");
		expect(noteText("helpers_back", { count: 2, failed: 1 }, "zh")).toBe("回来了 2 个，1 个出错");
		expect(noteText("helpers_back", { count: 2, failed: 1 }, "en")).toBe("2 subagents finished, 1 with errors");
		expect(noteText("helper_done", { name: "scout", summary: "retry.ts 读了两次时钟" }, "zh")).toBe(
			"scout 回来了：retry.ts 读了两次时钟",
		);
		expect(noteText("helper_done", { name: "scout", summary: "" }, "en")).toBe("scout is back");
		expect(
			["failed", "timed_out", "stopped"].map((reason) => noteText("helper_failed", { name: "fixer", reason }, "zh")),
		).toEqual(["fixer 出错了", "fixer 超时了", "fixer 被停了"]);
		expect(noteText("helper_failed", { name: "fixer", reason: "timed_out" }, "en")).toBe("fixer timed out");
		expect(noteText("still_running", { what: "npm test", minutes: 3 }, "zh")).toBe("还在跑 npm test，3 分钟了");
		expect(noteText("still_running", { what: "npm test", minutes: 3 }, "en")).toBe(
			"Still running npm test, 3 min in",
		);
		expect(noteText("still_running", { who: "fixer", what: "npx vitest", minutes: 6 }, "zh")).toBe(
			"fixer 跑 npx vitest 6 分钟没动静",
		);
		expect(noteText("still_running", { who: "fixer", what: "npx vitest", minutes: 6 }, "en")).toBe(
			"fixer: npx vitest has run 6 min with no output",
		);
		// A label stands in for the subagent's name in the words; a sentence that names none is the same with one.
		expect(
			noteText("helper_done", { name: "audit timing in src/retry.ts", summary: "读了两次时钟" }, "zh", "查计时"),
		).toBe("查计时 回来了：读了两次时钟");
		expect(noteText("helper_failed", { name: "x", reason: "timed_out" }, "en", "test rewrite")).toBe(
			"test rewrite timed out",
		);
		expect(noteText("still_running", { who: "x", what: "npx vitest", minutes: 6 }, "zh", "改测试")).toBe(
			"改测试 跑 npx vitest 6 分钟没动静",
		);
		expect(noteText("still_running", { what: "npm test", minutes: 3 }, "zh", "改测试")).toBe(
			"还在跑 npm test，3 分钟了",
		);
		expect(noteText("check_failed", { command: "npm test" }, "zh", "查计时")).toBe("检查没通过：npm test");
		expect(noteText("goal_round", { round: 2, reason: reasonTail("tests still fail", "en") }, "en")).toBe(
			"The goal isn't met yet, so mu kept the agent working (round 2): tests still fail",
		);
		expect(noteText("goal_paused", { reason: reasonTail("", "zh") }, "zh")).toBe("目标暂停了");
		expect(noteText("goal_paused", { reason: reasonTail("你打断了", "zh") }, "zh")).toBe("目标暂停了：你打断了");
		expect(shortPath("/Users/x/project/src/a.ts")).toBe("src/a.ts");
		expect(shortPath("a.ts")).toBe("a.ts");
		expect(shortPath("C:\\work\\app\\src\\a.ts")).toBe("src/a.ts");
	});

	it("reads the account back from a stored board, and shows it under the state", () => {
		const note = {
			sequence: 3,
			at: 1000,
			kind: "check",
			text: "检查通过了：npm test",
			by: "rules",
			code: "check_passed",
			params: { command: "npm test" },
		};
		expect(parseBoardNote(note)).toEqual(note);
		expect(parseBoardNote({ ...note, kind: "odd", by: "x", failed: true, params: { a: [1] } })).toEqual({
			sequence: 3,
			at: 1000,
			kind: "step",
			text: note.text,
			by: "rules",
			code: "check_passed",
			failed: true,
		});
		expect(parseBoardNote({ at: 1 })).toBeUndefined();
		const board = parseBoardEntry({ progress: "p", now: "n", log: [note, "junk"] });
		expect(board?.log).toEqual([note]);
		expect(describeBoard(board, "zh")).toBe("正在做: n\n进展: p\n它做了什么:\n  · 检查通过了：npm test");
		expect(boardWidget(board as BoardUpdate, "en", parseBoardNote(note))).toEqual([
			"\u03bc n",
			"  · 检查通过了：npm test",
		]);
		// A line about a subagent says which one.
		expect(parseBoardNote({ ...note, who: "scout" })).toMatchObject({ who: "scout" });
		expect(parseBoardNote({ ...note, who: "" })).not.toHaveProperty("who");
		// And what the board calls it, only beside its name.
		expect(parseBoardNote({ ...note, who: "audit timing in src/retry.ts", label: "查计时" })).toMatchObject({
			who: "audit timing in src/retry.ts",
			label: "查计时",
		});
		expect(parseBoardNote({ ...note, label: "查计时" })).not.toHaveProperty("label");
		expect(parseBoardNote({ ...note, who: "scout", label: "" })).not.toHaveProperty("label");
		expect(
			parseBoardText('{"progress": "p", "now": "n", "confirm": [], "note": " It found the cause. "}')?.note,
		).toBe("It found the cause.");
		expect(parseBoardText('{"progress": "p", "now": "n", "confirm": [], "note": ""}')).not.toHaveProperty("note");
	});
});
