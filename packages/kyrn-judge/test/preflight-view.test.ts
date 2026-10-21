import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import type { Decision } from "../src/decision.ts";
import type { PreflightOutcome } from "../src/decisions/input-preflight.ts";
import {
	hintIdsFor,
	hintsFor,
	judgedText,
	PREFLIGHT_HINTS,
	verdictStateOf,
} from "../src/extension/features/preflight.ts";
import {
	renderPending,
	renderVerdict,
	VERDICT_ENTRY,
	type VerdictData,
	verdictData,
} from "../src/extension/features/preflight-view.ts";
import type { Paint } from "../src/extension/features/welcome.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const plain: Paint = { fg: (_color, text) => text, bold: (text) => text };
const no: Answer = { type: "boolean", probability: 0.04 };

const chatAnswers: Record<string, Answer> = {
	turn_type: { type: "choice", choice: "chat", probabilities: { chat: 0.93, chat_question: 0.05, other: 0.02 } },
	is_side_question: no,
	needs_clarification: no,
	needs_files_changed: no,
	needs_memory: no,
	swarm_worthy: no,
	plan_first: { type: "boolean", probability: 0.91 },
	task_complexity: { type: "score", score: 0.2 },
	reasoning_depth: { type: "score", score: 1.1 },
	tool_complexity: { type: "score", score: 0 },
};

const chatOutcome: PreflightOutcome = {
	turnType: "chat",
	gear: "chat",
	sideQuestion: "no",
	needsClarification: "no",
	needsFilesChanged: "no",
	needsMemory: "no",
	swarmWorthy: "no",
	planFirst: "yes",
	complexity: { task: 0.2, reasoning: 1.1, tools: 0 },
};

function decision(overrides: Partial<Decision<PreflightOutcome>> = {}): Decision<PreflightOutcome> {
	return {
		specId: "input.preflight",
		mode: "active",
		outcome: chatOutcome,
		source: "judge",
		judged: chatOutcome,
		answers: chatAnswers,
		latencyMs: 640,
		...overrides,
	};
}

describe("preflight view", () => {
	it("keeps the message on screen while the judge reads it", () => {
		const lines = renderPending(
			{ message: "猫和狗有什么区别", judge: "jev-latest", elapsedMs: 800, skipKey: "esc" },
			80,
			plain,
		);
		expect(lines[0]).toContain("┃ 猫和狗有什么区别");
		expect(lines[1]).toContain("jev-latest");
		expect(lines[1]).toContain("reading your message · 0.8 s · esc to skip");
		// What is being decided, so the wait reads as work and not as a hang.
		expect(lines[2]).toContain("turn type · side question");
	});

	it("never renders wider than the terminal, and cuts a long message to three lines", () => {
		const long = Array.from(
			{ length: 12 },
			(_, index) => `第${index}行：这是一条很长的消息，用来测试换行和截断`,
		).join("\n");
		for (const width of [24, 40, 80, 120]) {
			const lines = renderPending({ message: long, judge: "jev-latest", elapsedMs: 0 }, width, plain);
			expect(lines.filter((line) => line.includes("┃"))).toHaveLength(3);
			expect(lines[2].trimEnd().endsWith("…")).toBe(true);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows the verdict in the panel until the message reaches the chat", () => {
		const verdict = verdictData(decision(), { by: "jev-latest", state: "applied" });
		const lines = renderPending({ message: "hi", judge: "jev-latest", elapsedMs: 640, verdict }, 80, plain);
		expect(lines[1]).toContain("◆ Jev  chat · answer directly · 640 ms");
		expect(lines[2]).toContain("preparing the turn");
		expect(lines.join("\n")).not.toContain("reading your message");
	});

	it("stores a verdict as plain labelled strings", () => {
		const data = verdictData(decision(), {
			by: "jev-latest",
			state: "applied",
			thinking: { from: "medium", to: "low" },
			hints: ["Write a short plan first."],
		});
		expect(data).toMatchObject({ version: 1, turnType: "chat", gear: "chat", latencyMs: 640, state: "applied" });
		const answers = Object.fromEntries(data.answers);
		expect(answers["turn type"]).toBe("chat 93% · concept question 5% · other 2%");
		expect(answers["side question"]).toBe("no · 4% likely");
		expect(answers["large or risky"]).toBe("yes · 91% likely");
		expect(answers.scope).toBe("a question · 0.2 of 3");
		expect(answers.reasoning).toBe("straightforward explanation · 1.1 of 3");
	});

	it("is one line in the chat and every answer when expanded", () => {
		const data = verdictData(decision(), {
			by: "jev-latest",
			state: "applied",
			thinking: { from: "medium", to: "low" },
			hints: ["Write a short plan first."],
		});
		const collapsed = renderVerdict(data, false, 100, plain);
		expect(collapsed).toEqual([" ◆ Jev  chat · answer directly · thinking medium → low · 640 ms"]);

		const expanded = renderVerdict(data, true, 100, plain);
		expect(expanded).toHaveLength(1 + 10 + 1);
		expect(expanded[1]).toMatch(/turn type\s+chat 93%/);
		expect(expanded.at(-1)).toMatch(/told the model\s+- Write a short plan first\./);
		for (const line of renderVerdict(data, true, 30, plain)) expect(visibleWidth(line)).toBeLessThanOrEqual(30);

		// A hint is a sentence for the model: narrow terminals wrap it, they do not cut it.
		const wordy = {
			...data,
			hints: ["This looks like a large or risky change. Write a short plan and confirm the approach."],
		};
		const narrow = renderVerdict(wordy, true, 60, plain);
		const hintLines = narrow.slice(narrow.findIndex((line) => line.includes("told the model")));
		expect(hintLines.length).toBeGreaterThan(1);
		expect(hintLines.join(" ").replace(/\s+/g, " ")).toContain("confirm the approach.");
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("says so when there is no verdict, when it was only recorded, and when it came too late", () => {
		const failed = decision({
			source: "fallback",
			judged: undefined,
			reason: "error:timeout",
			outcome: { ...chatOutcome, turnType: "unknown", gear: "standard" },
		});
		const none = verdictData(failed, { by: "jev-latest", state: "none" });
		expect(renderVerdict(none, false, 120, plain)[0]).toContain(
			"◇ Jev  no verdict (error:timeout) · using the fallback this turn",
		);
		const skipped = verdictData(undefined, { by: "jev-latest", state: "none", reason: "skipped", waitedMs: 1200 });
		expect(renderVerdict(skipped, false, 120, plain)[0]).toContain("no verdict (skipped)");

		const shadow = verdictData(decision({ mode: "shadow", source: "fallback" }), { by: "laya", state: "shadow" });
		expect(renderVerdict(shadow, false, 120, plain)[0]).toContain(
			"◇ Laya  chat · answer directly · 640 ms · shadow, not applied",
		);

		const late = verdictData(decision(), { by: "jev-latest", state: "late" });
		expect(renderVerdict(late, false, 120, plain)[0]).toContain("arrived after the turn started, not applied");
	});

	it("carries codes next to the English, for a client that translates: reason, hints and the raw answers", () => {
		const failed = decision({
			source: "fallback",
			judged: undefined,
			reason: "error:timeout",
			outcome: { ...chatOutcome, turnType: "unknown", gear: "standard" },
		});
		expect(verdictData(failed, { by: "jev-latest", state: "none" })).toMatchObject({
			reason: "error:timeout",
			reasonCode: "error:timeout",
		});
		const waited = verdictData(undefined, {
			by: "jev-latest",
			state: "none",
			reason: "no answer after 3.0 s",
			reasonCode: "no_answer",
			reasonParams: { seconds: 3 },
		});
		expect(waited).toMatchObject({ reasonCode: "no_answer", reasonParams: { seconds: 3 } });
		// A verdict that came has no reason to translate.
		const applied = verdictData(decision(), {
			by: "jev-latest",
			state: "applied",
			hints: hintsFor(chatOutcome, []),
			hintIds: hintIdsFor(chatOutcome, []),
		});
		expect(applied.reasonCode).toBeUndefined();
		expect(applied.hintIds).toEqual(["plan_first"]);
		expect(applied.hints).toEqual([PREFLIGHT_HINTS.plan_first]);
		expect(applied.answerValues).toEqual(chatAnswers);
		const loose = { ...chatOutcome, needsClarification: "yes" as const, sideQuestion: "yes" as const };
		// A loosely worded request that changes nothing is simply looked into: no hint about it.
		expect(hintIdsFor({ ...loose, gear: "heavy", swarmWorthy: "yes" }, ["hive", "delegate"])).toEqual([
			"side_question",
			"plan_first",
			"try_hive",
			"try_delegate",
		]);
		// One that may change files is resolved by looking and saying the assumption, never by asking first.
		expect(hintIdsFor({ ...loose, needsFilesChanged: "unsure" }, [])).toEqual([
			"resolve",
			"side_question",
			"plan_first",
		]);
		expect(PREFLIGHT_HINTS.resolve).not.toMatch(/ask .* before/i);
		// A reply to the agent's own question is acted on, whatever the judge made of it, judge or no judge.
		expect(hintIdsFor({ ...loose, needsFilesChanged: "yes" }, [], { repliesToQuestion: true })).toEqual([
			"answered",
			"side_question",
			"plan_first",
		]);
		expect(hintIdsFor(undefined, [], { repliesToQuestion: true })).toEqual(["answered"]);
		expect(hintIdsFor(undefined, [])).toEqual([]);
		// The tools a hint points to must exist.
		expect(hintIdsFor({ ...chatOutcome, planFirst: "no", gear: "heavy", swarmWorthy: "yes" }, [])).toEqual([]);
	});

	it("names the step another feature is on while the turn is being prepared", () => {
		const verdict = verdictData(decision(), { by: "jev-latest", state: "applied" });
		const lines = renderPending(
			{
				message: "hi",
				judge: "jev-latest",
				elapsedMs: 640,
				verdict,
				step: "choosing which skills this session needs",
			},
			80,
			plain,
		);
		expect(lines[2]).toContain("choosing which skills this session needs…");
	});

	it("has the judge read what a prompt template does instead of its name", () => {
		const commands = [
			{ name: "init", description: "Analyze the codebase and write AGENTS.md" },
			{ name: "skill:mu-browser", description: "Drive the built-in browser" },
			{ name: "bare" },
		];
		expect(judgedText("/init", commands)).toBe("Analyze the codebase and write AGENTS.md");
		expect(judgedText("/init focus on the tests", commands)).toBe(
			"Analyze the codebase and write AGENTS.md\nfocus on the tests",
		);
		expect(judgedText("/skill:mu-browser open mdn", commands)).toBe("Drive the built-in browser\nopen mdn");
		// Nothing to go on: better no verdict than one about the word "/bare".
		expect(judgedText("/bare", commands)).toBeUndefined();
		// A path is not a command.
		expect(judgedText("/Users/me/app.ts 这个文件是干什么的", commands)).toBe("/Users/me/app.ts 这个文件是干什么的");
		expect(judgedText("what does /init do?", commands)).toBe("what does /init do?");
	});

	it("tells applied, late, shadow, rule-settled and missing verdicts apart", () => {
		expect(verdictStateOf({ turnStarted: false, applied: false })).toBe("none");
		expect(verdictStateOf({ decision: decision(), turnStarted: false, applied: false })).toBe("applied");
		expect(verdictStateOf({ decision: decision(), turnStarted: true, applied: true })).toBe("applied");
		expect(verdictStateOf({ decision: decision(), turnStarted: true, applied: false })).toBe("late");
		expect(verdictStateOf({ decision: decision({ mode: "shadow" }), turnStarted: true, applied: false })).toBe(
			"shadow",
		);
		// The judge failed but the rule still named the turn: that is a verdict.
		const ruled = decision({ source: "fallback", judged: undefined, reason: "error:timeout" });
		expect(verdictStateOf({ decision: ruled, turnStarted: true, applied: true })).toBe("applied");
		const nothing = decision({
			source: "fallback",
			judged: undefined,
			outcome: { ...chatOutcome, turnType: "unknown", gear: "standard" },
		});
		expect(verdictStateOf({ decision: nothing, turnStarted: true, applied: false })).toBe("none");
	});
});

interface FakeUi {
	ui: ExtensionUIContext;
	/** What the panel shows right now, or undefined when it is not on screen. */
	panel(): string[] | undefined;
	press(data: string): void;
	panelHistory: string[];
}

/** Enough of pi's terminal UI for an extension to believe it runs in one. */
function fakeUi(): FakeUi {
	let widget: { render(width: number): string[]; dispose?(): void } | undefined;
	const listeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	const panelHistory: string[] = [];
	const base = {
		setWidget: (_key: string, content: unknown) => {
			widget?.dispose?.();
			widget = undefined;
			if (typeof content === "function") {
				widget = (content as (tui: unknown, theme: Paint) => typeof widget)({ requestRender() {} }, plain);
				panelHistory.push("open");
			} else {
				panelHistory.push("closed");
			}
		},
		onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
	};
	// pi copies the UI context with a spread, so every method an extension may call has to be an own property.
	const quiet = Object.fromEntries(
		["notify", "setStatus", "setWorkingMessage", "setWorkingVisible", "setTitle", "setHeader", "setFooter"].map(
			(name) => [name, () => undefined],
		),
	);
	const ui = { ...quiet, ...base } as unknown as ExtensionUIContext;
	return {
		ui,
		panel: () => widget?.render(80),
		press: (data) => {
			for (const listener of listeners) listener(data);
		},
		panelHistory,
	};
}

function entriesOf(harness: Harness): { type: string; customType?: string; role?: string; data?: unknown }[] {
	return harness.sessionManager.getEntries().map((entry) => ({
		type: entry.type,
		customType: entry.type === "custom" || entry.type === "custom_message" ? entry.customType : undefined,
		role: entry.type === "message" ? entry.message.role : undefined,
		data: entry.type === "custom" ? entry.data : undefined,
	}));
}

function verdicts(harness: Harness): VerdictData[] {
	return entriesOf(harness)
		.filter((entry) => entry.customType === VERDICT_ENTRY)
		.map((entry) => entry.data as VerdictData);
}

describe("preflight on screen", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function tuiHarness(provider: MockJudgeProvider, waitMs = 6000) {
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					only: ["preflight"],
					config: parseConfig({ features: { preflight: { enabled: true, waitMs } } }),
				}),
			],
		});
		harnesses.push(harness);
		const screen = fakeUi();
		harness.session.extensionRunner.setUIContext(screen.ui, "tui");
		return { harness, screen };
	}

	it("stages the message, shows the verdict, then files it under the message in the session", async () => {
		let release: (answers: Record<string, Answer>) => void = () => {};
		const provider = new MockJudgeProvider(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const { harness, screen } = await tuiHarness(provider);
		harness.setResponses([fauxAssistantMessage("Cats are smaller.")]);

		const prompt = harness.session.prompt("猫和狗有什么区别");
		await vi.waitFor(() => expect(screen.panel()).toBeDefined());
		// The judge has not answered: the message is on screen and nothing has reached the model.
		expect(screen.panel()?.[0]).toContain("猫和狗有什么区别");
		expect(screen.panel()?.[1]).toContain("reading your message");
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(0);

		release({ ...chatAnswers, plan_first: no });
		await prompt;

		expect(screen.panel()).toBeUndefined();
		expect(screen.panelHistory).toEqual(["open", "closed"]);
		const [verdict] = verdicts(harness);
		expect(verdict).toMatchObject({ state: "applied", turnType: "chat", gear: "chat", by: "mock" });
		// Same order in the session file as on screen: the message, then what the judge made of it.
		const order = entriesOf(harness)
			.filter((entry) => entry.role === "user" || entry.customType === VERDICT_ENTRY || entry.role === "assistant")
			.map((entry) => entry.role ?? entry.customType);
		expect(order).toEqual(["user", VERDICT_ENTRY, "assistant"]);
		// Shown to the user, never to the model.
		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
	});

	it("lets escape end the wait, and reports the verdict as late when it arrives afterwards", async () => {
		let release: (answers: Record<string, Answer>) => void = () => {};
		const provider = new MockJudgeProvider(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const { harness, screen } = await tuiHarness(provider);
		let modelCalled = false;
		harness.setResponses([
			() => {
				modelCalled = true;
				return fauxAssistantMessage("On it.");
			},
		]);

		const prompt = harness.session.prompt("refactor src/auth.ts to use the new token helper");
		await vi.waitFor(() => expect(screen.panel()).toBeDefined());
		screen.press("\x1b");
		await prompt;

		expect(modelCalled).toBe(true);
		expect(verdicts(harness)).toHaveLength(0);
		release({
			...chatAnswers,
			turn_type: { type: "choice", choice: "single_edit", probabilities: { single_edit: 0.9 } },
		});
		await vi.waitFor(() => expect(verdicts(harness)).toHaveLength(1));
		expect(verdicts(harness)[0]).toMatchObject({ state: "late", turnType: "single_edit" });
	});

	it("stops waiting after waitMs and carries on without a gear", async () => {
		const provider = new MockJudgeProvider(() => new Promise(() => {}));
		const { harness, screen } = await tuiHarness(provider, 30);
		harness.setResponses([fauxAssistantMessage("Done.")]);

		await harness.session.prompt("rename the helper in src/util.ts");

		expect(screen.panelHistory).toEqual(["open", "closed"]);
		expect(harness.session.messages.at(-1)?.role).toBe("assistant");
	});

	it("moves the hints behind the verdict line instead of printing them as a message", async () => {
		const risky: Record<string, Answer> = {
			...chatAnswers,
			turn_type: { type: "choice", choice: "multi_step_task", probabilities: { multi_step_task: 0.9 } },
			needs_files_changed: { type: "boolean", probability: 0.95 },
		};
		const { harness } = await tuiHarness(new MockJudgeProvider(() => risky));
		harness.setResponses([fauxAssistantMessage("Here is the plan.")]);

		await harness.session.prompt("Rewrite the authentication module to use OAuth2 across the whole app.");

		const hint = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "kyrn.hint");
		expect(hint).toMatchObject({ display: false });
		expect(verdicts(harness)[0].hints.join(" ")).toContain("Write a short plan");
	});

	it("leaves print mode exactly as it was: no panel, no verdict entry, hints shown", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => chatAnswers),
					mode: "active",
					only: ["preflight"],
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Hello.")]);

		await harness.session.prompt("Rewrite the authentication module to use OAuth2 across the whole app.");

		expect(verdicts(harness)).toHaveLength(0);
		const hint = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "kyrn.hint");
		expect(hint).toMatchObject({ display: true });
	});
});
