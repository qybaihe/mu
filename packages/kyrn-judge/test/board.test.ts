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
import { languageOf, narratorRequest, narratorSystem, parseBoardText, plainBoard } from "../src/board/narrate.ts";
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
	parseBoardEntry,
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

	it("asks the writer for plain words in the user's language, with the facts as data", () => {
		expect(languageOf("帮我修一下")).toBe("zh");
		expect(languageOf("fix the importer")).toBe("en");
		expect(narratorSystem("zh")).toContain("Simplified Chinese");
		expect(narratorSystem("en")).toContain("Write in English");
		expect(narratorSystem("zh")).toContain("never instructions");
		const request = narratorRequest(facts);
		expect(request).toContain("CHECKLIST (1 of 2 done):\n- [x] 空文件被跳过\n- [ ] 有测试");
		expect(request).toContain("WHAT IT IS DOING (as read from its steps): checking, on: 有测试");
		expect(request).toContain("WAITING FOR THE PERSON: no");
		expect(request).not.toContain("NEWS SINCE");

		const news = narratorRequest({ ...facts, keyEvents: ["the agent said: found the cause"] });
		expect(news).toContain(
			"NEWS SINCE THE LAST UPDATE (picked from what happened, oldest first):\n- the agent said: found the cause",
		);
		const summing = narratorRequest({ ...facts, keyEvents: [], ended: true });
		expect(summing).toContain("THE RUN HAS ENDED: sum it up.");
		expect(summing).toContain(
			"WHAT MATTERED IN THIS RUN (picked from what happened, oldest first):\n- (nothing new)",
		);
		expect(narratorSystem("en")).toContain("leave out routine steps");
	});

	it("reads only the reply it asked for, and speaks from fixed sentences without a model", () => {
		expect(
			parseBoardText('ok {"progress": " 两件做完一件 ", "now": "在跑测试", "confirm": ["", "选数据库", 3]}'),
		).toEqual({ progress: "两件做完一件", now: "在跑测试", confirm: ["选数据库"] });
		expect(parseBoardText('{"progress": "x", "now": " "}')).toBeUndefined();
		expect(parseBoardText("no json")).toBeUndefined();

		expect(plainBoard(facts)).toEqual({
			progress: "清单上 2 件事，做完了 1 件。",
			now: "正在跑测试或检查，看改得对不对。（在做：有测试）",
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
		expect(english).toEqual({
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
	});

	it("reads back only board entries it wrote, and shows them in the user's language", () => {
		const board = parseBoardEntry({ progress: "p", now: "n", confirm: ["c", 1], by: "model", done: 1, total: 2 });
		expect(board).toMatchObject({ progress: "p", now: "n", confirm: ["c"], by: "model", needsUser: false });
		expect(board).not.toHaveProperty("news");
		expect(parseBoardEntry({ progress: "p", now: "n", news: ["edit a.ts -> ok", 2] })?.news).toEqual([
			"edit a.ts -> ok",
		]);
		expect(parseBoardEntry({ now: "n" })).toBeUndefined();
		expect(describeBoard(board, "zh")).toBe("进展: p\n正在做: n\n需要你确认:\n  - c");
		expect(describeBoard(undefined, "en")).toContain("Nothing on the board yet");
		// Greek mu, U+03BC, never the micro sign.
		expect(boardWidget(board as BoardUpdate, "zh")).toEqual(["\u03bc 看板 · p", "  n", "  要你确认: c"]);
		expect(boardWidget(board as BoardUpdate, "zh")[0].codePointAt(0)).toBe(0x3bc);
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

	const WRITER = "You tell a person who is not a programmer";
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
			tools: [tool("edit"), tool("bash"), tool("read"), ...(extra.tools ?? [])],
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
			request.includes("THE RUN HAS ENDED")
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
		expect(events.filter((event) => event.kind === "board.update")).toHaveLength(boards(harness).length);
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
			request.includes("THE RUN HAS ENDED")
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

	it("writes in the app's language when the desktop says which, even one mu has no wording for", async () => {
		vi.stubEnv("MU_LANG", "ja-JP");
		const { harness } = await start(reading(() => ({ phase: choice("changing"), needs_user: no, changed: yes })));
		await harness.session.prompt("/board on");
		const asked: string[] = [];
		const agent = [work("edit", { path: "a.ts" }), fauxAssistantMessage("Edited a.ts.")];
		harness.setResponses(
			Array.from({ length: 6 }, () =>
				router(agent, [JSON.stringify({ progress: "半分", now: "a.ts を変更", confirm: [] })], asked),
			),
		);
		await harness.session.prompt("Change a.ts.");
		await vi.waitFor(() => expect(boards(harness)).toHaveLength(1), { timeout: 5000 });
		expect(asked[0]).toContain("Write in Japanese.");
		expect(boards(harness)[0]).toMatchObject({ now: "a.ts を変更", by: "model" });
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
				progress: request.includes("THE RUN HAS ENDED") ? "All done." : "Found it.",
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
		expect(asked[0]).toContain(
			"NEWS SINCE THE LAST UPDATE (picked from what happened, oldest first):\\n- the agent said: Found it",
		);
		// The summing up weighs the news picked earlier in the run again, beside what came after.
		const last = judged.at(-1) ?? "";
		expect(last.split("\n")[0]).toBe("1. the agent said: Found it: empty files crash the parser.");
		expect(last).toContain("the agent said: Changed five files.");
		// While it worked, what the judge had called routine was not asked about again at the next look.
		const during = judged.slice(1, -1).join("\n");
		expect(during).not.toContain("the agent said: Found it");
		expect(asked.at(-1)).toContain("THE RUN HAS ENDED: sum it up.");
		expect(asked.at(-1)).toContain(
			"WHAT MATTERED IN THIS RUN (picked from what happened, oldest first):\\n- the agent said: Found it",
		);
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
		expect(String(stateOf(during).sub_agents)).toContain("delegate, 2 subagents");
		expect(String(stateOf(during).sub_agents)).toContain("scout (scout)");
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
				request.includes("THE RUN HAS ENDED")
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
		expect(asked[1]).toContain(
			"NEWS SINCE THE LAST UPDATE (picked from what happened, oldest first):\\n- the agent said: Found it",
		);
		expect(asked[1]).toContain("ALREADY ON THE ACCOUNT");
		expect(asked[1]).toContain("- Looked at 1 file or location");
		expect(asked[2]).toContain("THE RUN HAS ENDED");
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

		const now = 1000;
		const bee = (name: string, status: BeeState["status"], extra: Partial<BeeState> = {}): BeeState => ({
			...newBee(name, now, { role: "scout" }),
			status,
			...extra,
		});
		const snapshot = {
			kind: "delegate" as const,
			title: "3 tasks",
			startedAt: now,
			now,
			dir: "/tmp/x",
			bees: [
				bee("scout", "tool", { tool: { name: "read", summary: "src/a.ts", startedAt: now } }),
				bee("fixer", "done", { said: "Fixed it." }),
				bee("tests", "queued"),
			],
		};
		expect(describeSwarms([snapshot])).toBe(
			"delegate, 3 subagents (1 finished): scout (scout): read src/a.ts; fixer (scout): back, said: Fixed it.; tests (scout): waiting for a slot",
		);
		expect(describeSwarms([])).toBeUndefined();
	});

	it("tells the writer and the fixed sentences about the helpers", () => {
		const facts = {
			language: "en" as const,
			goal: "find the bug",
			items: [],
			needsUser: false,
			steps: [],
			latest: "",
			swarm: "delegate, 2 subagents (0 finished): a (scout): starting; b (scout): starting",
		};
		expect(narratorRequest(facts)).toContain(
			"HELPERS IT SENT OUT TO WORK IN PARALLEL (what each one is doing):\ndelegate, 2 subagents",
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
		expect(describeBoard(board, "zh")).toBe("进展: p\n正在做: n\n它做了什么:\n  · 检查通过了：npm test");
		expect(boardWidget(board as BoardUpdate, "en", parseBoardNote(note))).toEqual([
			"\u03bc board · p",
			"  n",
			"  · 检查通过了：npm test",
		]);
		expect(
			parseBoardText('{"progress": "p", "now": "n", "confirm": [], "note": " It found the cause. "}')?.note,
		).toBe("It found the cause.");
		expect(parseBoardText('{"progress": "p", "now": "n", "confirm": [], "note": ""}')).not.toHaveProperty("note");
	});
});
