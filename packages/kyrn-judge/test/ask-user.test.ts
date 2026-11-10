import { fauxAssistantMessage, fauxToolCall, type JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import {
	choiceText,
	PENDING_STATUS,
	QUESTION_ENTRY,
	type QuestionRecord,
	readPicks,
} from "../src/extension/features/ask-user.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";
import { attended } from "./attended.ts";

const DATABASE = {
	question: "Which database should the app use?",
	header: "Database",
	options: [
		{ label: "SQLite (Recommended)", description: "One file, nothing to run" },
		{ label: "Postgres", description: "A server to run, scales further" },
	],
};
const PARTS = {
	question: "Which parts should I set up now?",
	options: [{ label: "Auth" }, { label: "Billing" }, { label: "Admin panel" }],
	multiSelect: true,
};

const ask = (questions: JsonValue[], id = "call-ask") =>
	fauxAssistantMessage([fauxToolCall("ask_user", { questions }, { id })], { stopReason: "toolUse" });

interface Dialog {
	readonly method: "select" | "input";
	readonly title: string;
	readonly options?: readonly string[];
	readonly timeout?: number;
}

/** What the user does at each dialog, in order: a choice or text, `undefined` for Esc, "wait" to let it time out. */
type Step = string | undefined | "wait";

function scriptedUi(steps: Step[], dialogs: Dialog[], status: (string | undefined)[]): ExtensionUIContext {
	const answer = (dialog: Dialog, opts?: ExtensionUIDialogOptions): Promise<string | undefined> => {
		dialogs.push({ ...dialog, ...(opts?.timeout ? { timeout: opts.timeout } : {}) });
		const step = steps.shift();
		if (step === "wait") return new Promise((resolve) => setTimeout(() => resolve(undefined), opts?.timeout ?? 0));
		return Promise.resolve(step);
	};
	return createTestUiContext({
		select: (title, options, opts) => answer({ method: "select", title, options }, opts),
		input: (title, _placeholder, opts) => answer({ method: "input", title }, opts),
		setStatus: (key, text) => {
			if (key === PENDING_STATUS) status.push(text);
		},
	});
}

const lastResult = (harness: Harness, tool = "ask_user") => {
	const result = [...harness.session.messages]
		.reverse()
		.find((message) => message.role === "toolResult" && message.toolName === tool) as
		| { content: { text?: string }[]; details?: unknown }
		| undefined;
	return { text: (result?.content ?? []).map((block) => block.text ?? "").join("\n"), details: result?.details };
};

const records = (harness: Harness): QuestionRecord[] =>
	harness.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === QUESTION_ENTRY ? [entry.data as QuestionRecord] : [],
		);

describe("ask_user", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(
		setup: {
			steps?: Step[];
			features?: Record<string, unknown>;
			only?: FeatureName[];
			provider?: MockJudgeProvider;
			noUi?: boolean;
		} = {},
	) {
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: setup.provider ?? new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false, permissions: { mode: "full" }, ...setup.features } }),
					...(setup.only ? { only: setup.only } : { only: ["askUser"] }),
					onPresentation: (event) => events.push(event),
				}),
			],
		});
		harnesses.push(harness);
		const dialogs: Dialog[] = [];
		const status: (string | undefined)[] = [];
		if (!setup.noUi)
			await harness.session.bindExtensions({
				uiContext: scriptedUi(setup.steps ?? [], dialogs, status),
				mode: "tui",
			});
		const of = (kind: string) => events.filter((event) => event.kind === kind).map((event) => event.payload);
		return { harness, dialogs, status, of };
	}

	it("asks each question with its options and an answer of one's own, and gives the model the answers", async () => {
		const { harness, dialogs, of } = await start({
			steps: [choiceText(DATABASE.options[1]), "1, 3"],
		});
		harness.setResponses([ask([DATABASE, PARTS]), fauxAssistantMessage("Setting up Postgres with auth and admin.")]);
		await harness.session.prompt("Start the app's backend.");

		expect(dialogs).toEqual([
			{
				method: "select",
				title: "Database: Which database should the app use? (1/2)",
				options: [
					"SQLite (Recommended) — One file, nothing to run",
					"Postgres — A server to run, scales further",
					"Something else (type it)",
				],
				timeout: 120_000,
			},
			expect.objectContaining({ method: "input", timeout: 120_000 }),
		]);
		// A pick-any question lists its options by number.
		expect(dialogs[1].title).toContain("Which parts should I set up now? (2/2) (pick any)");
		expect(dialogs[1].title).toContain("3. Admin panel");
		const { text, details } = lastResult(harness);
		expect(text).toBe(
			[
				"The user answered:",
				"- Database: Which database should the app use? → Postgres",
				"- Which parts should I set up now? → Auth, Admin panel",
			].join("\n"),
		);
		expect(details).toMatchObject({ outcome: "answered" });
		expect(records(harness)).toEqual([
			expect.objectContaining({ toolCallId: "call-ask", count: 2, outcome: "answered", answered: 2 }),
		]);
		// What a client shows as a card: the question in full, and what the dialog after it offers.
		expect(of("question.asked")[0]).toMatchObject({
			toolCallId: "call-ask",
			index: 0,
			count: 2,
			header: "Database",
			options: DATABASE.options,
			multiSelect: false,
			dialog: "select",
			choices: dialogs[0].options,
		});
		expect(of("question.asked")[1]).toMatchObject({ index: 1, multiSelect: true, dialog: "input" });
		expect(of("question.resolved")).toEqual([
			expect.objectContaining({
				index: 0,
				outcome: "answered",
				answer: expect.objectContaining({ selected: ["Postgres"] }),
			}),
			expect.objectContaining({ index: 1, outcome: "answered" }),
		]);
	});

	it("takes an answer in the user's own words", async () => {
		const { harness } = await start({
			steps: ["Something else (type it)", "Whatever the hosting gives me", "SSO only"],
		});
		harness.setResponses([ask([DATABASE, PARTS]), fauxAssistantMessage("Noted.")]);
		await harness.session.prompt("Start the app's backend.");
		expect(lastResult(harness).text).toBe(
			[
				"The user answered:",
				'- Database: Which database should the app use? → in their own words: "Whatever the hosting gives me"',
				'- Which parts should I set up now? → in their own words: "SSO only"',
			].join("\n"),
		);
	});

	it("Esc skips the question and the rest, and asking again in that turn gets the same answer at once", async () => {
		const { harness, dialogs } = await start({ steps: [undefined] });
		harness.setResponses([
			ask([DATABASE, PARTS]),
			ask([DATABASE], "call-again"),
			fauxAssistantMessage("Going with SQLite."),
		]);
		await harness.session.prompt("Start the app's backend.");
		expect(dialogs).toHaveLength(1);
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		const texts = results.map((message) => (message.content as { text: string }[])[0].text);
		expect(texts[0]).toContain("The user skipped these questions. Do not ask them again");
		expect(texts[1]).toContain("already skipped your questions in this turn");
		expect(records(harness)).toEqual([expect.objectContaining({ outcome: "skipped", answered: 0 })]);
	});

	it("an answered question then a skipped one: the model gets the answer and is told the rest was skipped", async () => {
		const { harness } = await start({ steps: [choiceText(DATABASE.options[0]), undefined] });
		harness.setResponses([ask([DATABASE, PARTS]), fauxAssistantMessage("SQLite it is.")]);
		await harness.session.prompt("Start the app's backend.");
		const { text, details } = lastResult(harness);
		expect(text).toContain("→ SQLite (Recommended)");
		expect(text).toContain("They skipped the rest:\n- Which parts should I set up now?");
		expect(details).toMatchObject({ outcome: "partly" });
	});

	it("nobody answers in time: pending, the model carries on, and /answer asks again and steers the answer in", async () => {
		const { harness, dialogs, status } = await start({
			steps: ["wait", choiceText(DATABASE.options[1]), "2"],
			features: { askUser: { waitMs: 60 } },
		});
		harness.setResponses([ask([DATABASE, PARTS]), fauxAssistantMessage("Laid out the routes while you decide.")]);
		await harness.session.prompt("Start the app's backend.");
		const { text, details } = lastResult(harness);
		expect(text).toContain("The user has not answered yet:\n- Database: Which database should the app use?");
		expect(text).toContain("This is pending, not a skipped answer, and not permission.");
		expect(details).toMatchObject({ outcome: "pending" });
		expect(status).toEqual(["mu has a question for you: type /answer"]);
		expect(dialogs[0].timeout).toBe(60);

		harness.appendResponses([fauxAssistantMessage("Postgres and billing, then.")]);
		await harness.session.prompt("/answer");
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		expect(dialogs).toHaveLength(3);
		const users = harness.session.messages.filter((message) => message.role === "user");
		expect(JSON.stringify(users.at(-1)?.content)).toContain(
			"[My answer to what you asked with ask_user (call call-ask), after you carried on]",
		);
		expect(JSON.stringify(users.at(-1)?.content)).toContain("Which database should the app use? → Postgres");
		expect(JSON.stringify(users.at(-1)?.content)).toContain("Which parts should I set up now? → Billing");
		expect(status.at(-1)).toBeUndefined();
		expect(records(harness)).toEqual([
			expect.objectContaining({ outcome: "pending", answered: 0 }),
			expect.objectContaining({ outcome: "answered", answered: 2, late: true }),
		]);
	});

	it("does not wait a second time for someone who did not answer, until they write again", async () => {
		const { harness, dialogs } = await start({
			steps: ["wait", choiceText(DATABASE.options[0])],
			features: { askUser: { waitMs: 60 } },
		});
		harness.setResponses([
			ask([DATABASE], "call-first"),
			ask([PARTS], "call-second"),
			fauxAssistantMessage("Laid out the routes while you decide."),
		]);
		const startedAt = Date.now();
		await harness.session.prompt("Start the app's backend.");
		// One dialog and one wait: the second set of questions is pending at once.
		expect(dialogs).toHaveLength(1);
		expect(Date.now() - startedAt).toBeLessThan(110);
		expect(lastResult(harness).text).toContain("The user has not answered yet:\n- Which parts should I set up now?");
		expect(records(harness)).toEqual([
			expect.objectContaining({ toolCallId: "call-first", outcome: "pending" }),
			expect.objectContaining({ toolCallId: "call-second", outcome: "pending", waitedMs: 0 }),
		]);

		// They wrote: they are here, and the next question is asked.
		harness.setResponses([ask([DATABASE], "call-third"), fauxAssistantMessage("SQLite it is.")]);
		await harness.session.prompt("I'm back. Go on.");
		expect(dialogs).toHaveLength(2);
		expect(lastResult(harness).text).toContain("→ SQLite (Recommended)");
	});

	it("the user's next message settles what was still open", async () => {
		const { harness, status } = await start({ steps: ["wait"], features: { askUser: { waitMs: 30 } } });
		harness.setResponses([
			ask([DATABASE]),
			fauxAssistantMessage("Waiting on the database."),
			fauxAssistantMessage("OK."),
		]);
		await harness.session.prompt("Start the app's backend.");
		expect(status).toEqual(["mu has a question for you: type /answer"]);
		await harness.session.prompt("Use Postgres.");
		expect(status.at(-1)).toBeUndefined();
	});

	it("with nobody to ask, says so at once", async () => {
		const { harness } = await start({ noUi: true });
		harness.setResponses([ask([DATABASE]), fauxAssistantMessage("Going with SQLite.")]);
		await harness.session.prompt("Start the app's backend.");
		expect(lastResult(harness).text).toContain("Nobody can answer questions in this session.");
		expect(records(harness)).toEqual([expect.objectContaining({ outcome: "nobody" })]);
	});

	it("is left out of an unattended run's request, and is on the model's list in an attended one", async () => {
		const unattended = await start({ noUi: true, only: ["catalog", "askUser"] });
		unattended.harness.setResponses([fauxAssistantMessage("Done.")]);
		await unattended.harness.session.prompt("Hello.");
		expect(unattended.harness.session.getActiveToolNames()).not.toContain("ask_user");

		const interactive = await start({ only: ["catalog", "askUser"], features: attended() });
		interactive.harness.setResponses([fauxAssistantMessage("Done.")]);
		await interactive.harness.session.prompt("Hello.");
		expect(interactive.harness.session.getActiveToolNames()).toContain("ask_user");
	});

	it("while questions are open, a go-ahead verdict does not send the agent back", async () => {
		const yes: Answer = { type: "boolean", probability: 0.95 };
		const no: Answer = { type: "boolean", probability: 0.03 };
		const provider = new MockJudgeProvider((request: JudgeRequest): Record<string, Answer> => {
			if (!("promised" in request.questions)) return {};
			return { promised: no, asks_go_ahead: yes, work_requested: yes, beyond_request: no, irreversible: no };
		});
		const { harness } = await start({
			steps: ["wait"],
			provider,
			only: ["askUser", "continuation"],
			features: { askUser: { waitMs: 30 } },
		});
		harness.setResponses([
			ask([DATABASE]),
			fauxAssistantMessage("Routes are in. Should I wire the database once you pick one?"),
			fauxAssistantMessage("unused"),
		]);
		await harness.session.prompt("Build the backend.");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(provider.calls.filter((call) => "promised" in call.questions)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});

describe("readPicks", () => {
	const options = [{ label: "Auth" }, { label: "Billing" }, { label: "Admin panel" }];
	it("reads option numbers in any separator, once each and in order", () => {
		expect(readPicks("3, 1", options)).toEqual(["Auth", "Admin panel"]);
		expect(readPicks("2 2", options)).toEqual(["Billing"]);
		expect(readPicks("1，3", options)).toEqual(["Auth", "Admin panel"]);
	});
	it("takes anything else as the user's own words", () => {
		expect(readPicks("4", options)).toBe("4");
		expect(readPicks("auth and billing", options)).toBe("auth and billing");
		expect(readPicks("1 and 2", options)).toBe("1 and 2");
	});
});
