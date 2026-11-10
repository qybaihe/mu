import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	createHarness,
	createTestUiContext,
	getMessageText,
	getUserTexts,
	type Harness,
} from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { rowOf } from "../src/evolve/store.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";
import { attended } from "./attended.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The judge's answer to "what is this message?" (input.interjection's one question). */
const reads = (choice: string): Answer => ({ type: "choice", choice, probabilities: { [choice]: 0.95 } });

/** How the judge answers about one mid-run message: what it reads, after how long, or that it fails. */
type Verdict = { kind?: string; delayMs?: number; fails?: boolean };

const GOAL = "Migrate the users table.";
const IMAGE = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

describe("interjection: mu decides when a message sent mid-run reaches the work", () => {
	const harnesses: Harness[] = [];
	const folders: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (folders.length > 0) rmSync(folders.pop() as string, { recursive: true, force: true });
	});

	/**
	 * A session with mu's kernel as it comes, but for the judge, which answers from `verdicts`. Its first run calls a
	 * tool that waits until `release()`, so messages can be sent while it goes.
	 */
	async function running(
		verdicts: Record<string, Verdict>,
		extra: {
			modes?: Record<string, string>;
			features?: Record<string, unknown>;
			only?: FeatureName[];
			/** Someone is at the session: what mu tells them is kept in `notes`. Without it the session has no UI. */
			ui?: boolean;
			/** mu's own folder, for a test that reads what the evolve feature kept there. */
			agentDir?: string;
		} = {},
	) {
		const asked: string[] = [];
		/** What the judge was told the agent is doing, for each message it was asked about. */
		const actions: string[] = [];
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const wait: AgentTool = {
			name: "wait",
			label: "wait",
			description: "Waits until the test lets it go.",
			parameters: Type.Object({}),
			execute: async () => {
				await released;
				return { content: [{ type: "text", text: "done waiting" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [wait],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(async (request): Promise<Record<string, Answer>> => {
						const state = request.state as { user_message?: unknown; current_action?: unknown };
						if (!("kind" in request.questions) || state.current_action === undefined) return {};
						const message = String(state.user_message);
						asked.push(message);
						actions.push(String(state.current_action));
						const verdict = verdicts[message] ?? {};
						if (verdict.delayMs) await sleep(verdict.delayMs);
						if (verdict.fails) throw new Error("the judge is down");
						return verdict.kind ? { kind: reads(verdict.kind) } : {};
					}),
					only: extra.only,
					// No `mode`: the modes are mu's own, as parseConfig makes them from mu.json.
					config: parseConfig({
						modes: extra.modes,
						features: attended({ memory: false, permissions: { mode: "full" }, ...extra.features }),
					}),
					...(extra.agentDir ? { roots: { home: extra.agentDir, agentDir: extra.agentDir } } : {}),
				}),
			],
		});
		harnesses.push(harness);
		/** Everything mu told the user, and among it its answers to a question about progress. */
		const notes: string[] = [];
		const answers: string[] = [];
		if (extra.ui) {
			const ui = createTestUiContext({
				notify: (message) => {
					notes.push(message);
					if (message.startsWith("mu: the agent is still working")) answers.push(message);
				},
				// A question nobody answers: the dialog closes when its time is up.
				select: async (_title, _options, dialog) => {
					await sleep(dialog?.timeout ?? 0);
					return undefined;
				},
			});
			await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		}
		const started = new Promise<void>((resolve) => {
			const stop = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					stop();
					resolve();
				}
			});
		});
		/** What the model had from the person when it answered: the texts of the user messages it was sent. */
		const seen: string[][] = [];
		const answer = (text: string) => (context: { messages: readonly { role: string }[] }) => {
			seen.push(context.messages.filter((message) => message.role === "user").map(getMessageText));
			return fauxAssistantMessage(text);
		};
		return { harness, session: harness.session, asked, actions, release, started, seen, answer, notes, answers };
	}

	/** How many times `text` reached the conversation as the person's message. */
	const times = (harness: Harness, text: string) => getUserTexts(harness).filter((said) => said === text).length;

	it("out of the box, a steer the judge reads as extra work waits for the end of the run, and arrives once", async () => {
		const extra = "Also add an index on email.";
		const run = await running({ [extra]: { kind: "addition" } });
		run.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			run.answer("Migrated."),
			run.answer("Index added."),
		]);
		const first = run.session.prompt(GOAL);
		await run.started;

		await run.session.prompt(extra, { streamingBehavior: "steer" });
		await sleep(20);
		expect(run.asked).toEqual([extra]);
		expect(run.session.getSteeringMessages()).toEqual([]);
		expect(run.session.getFollowUpMessages()).toEqual([extra]);

		run.release();
		await first;
		// The step after the tool went on without it; it came once the run had answered.
		expect(run.seen[0]).not.toContain(extra);
		expect(run.seen[1]).toContain(extra);
		expect(times(run.harness, extra)).toBe(1);
	});

	it("a correction queued for after the run reaches the model at its next step instead", async () => {
		const correction = "Stop, that is the production database.";
		const run = await running({ [correction]: { kind: "correction" } });
		run.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			run.answer("Stopped."),
		]);
		const first = run.session.prompt(GOAL);
		await run.started;

		await run.session.prompt(correction, { streamingBehavior: "followUp" });
		await sleep(20);
		expect(run.session.getSteeringMessages()).toEqual([correction]);
		expect(run.session.getFollowUpMessages()).toEqual([]);

		run.release();
		await first;
		expect(run.seen[0]).toContain(correction);
		expect(times(run.harness, correction)).toBe(1);
	});

	it("an unrelated question waits for the end of the run", async () => {
		const question = "By the way, what does the deploy script do?";
		const run = await running({ [question]: { kind: "side_question" } });
		run.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			run.answer("Migrated."),
			run.answer("It builds and uploads."),
		]);
		const first = run.session.prompt(GOAL);
		await run.started;

		await run.session.prompt(question, { streamingBehavior: "steer" });
		await sleep(20);
		expect(run.session.getFollowUpMessages()).toEqual([question]);
		run.release();
		await first;
		expect(times(run.harness, question)).toBe(1);
	});

	it("a verdict that agrees, or an unclear one, leaves the message as it was sent", async () => {
		const agrees = "Use the staging database instead.";
		const unclear = "Hmm.";
		const run = await running({ [agrees]: { kind: "correction" }, [unclear]: { kind: "other" } });
		run.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			run.answer("Switching to staging."),
			run.answer("Done."),
		]);
		const first = run.session.prompt(GOAL);
		await run.started;

		await run.session.prompt(agrees, { streamingBehavior: "steer" });
		await run.session.prompt(unclear, { streamingBehavior: "steer" });
		await sleep(20);
		expect(run.asked).toEqual([agrees, unclear]);
		expect(run.session.getSteeringMessages()).toEqual([agrees, unclear]);
		expect(run.session.getFollowUpMessages()).toEqual([]);

		run.release();
		await first;
		expect(times(run.harness, agrees)).toBe(1);
		expect(times(run.harness, unclear)).toBe(1);
	});

	it("a judge that fails, or answers too late, leaves the message as sent, and a late verdict re-sends nothing", async () => {
		const failed = "Also add an index on email.";
		const late = "And drop the old column.";
		const run = await running(
			{ [failed]: { kind: "addition", fails: true }, [late]: { kind: "addition", delayMs: 400 } },
			{ features: { interjection: { waitMs: 100 } } },
		);
		run.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			run.answer("Migrated, with the index."),
			run.answer("Column dropped."),
		]);
		const first = run.session.prompt(GOAL);
		await run.started;

		await run.session.prompt(failed, { streamingBehavior: "steer" });
		const sentAt = Date.now();
		await run.session.prompt(late, { streamingBehavior: "steer" });
		// It waited for the verdict as long as it may, and no longer.
		expect(Date.now() - sentAt).toBeGreaterThanOrEqual(90);
		expect(Date.now() - sentAt).toBeLessThan(380);
		expect(run.session.getSteeringMessages()).toEqual([failed, late]);

		// The verdict that came after the wait would have queued it for later: it changes nothing now.
		await sleep(450);
		expect(run.asked).toEqual([failed, late]);
		expect(run.session.getSteeringMessages()).toEqual([failed, late]);
		expect(run.session.getFollowUpMessages()).toEqual([]);

		run.release();
		await first;
		expect(times(run.harness, failed)).toBe(1);
		expect(times(run.harness, late)).toBe(1);
	});

	it("messages sent in quick succession reach the run in the order they were sent, however long each verdict takes", async () => {
		// The first is read slowly and re-sent as a steer, the second is read at once and stays one.
		const slow = "Wait, keep the old column for now.";
		const fast = "And use a transaction.";
		const run = await running({ [slow]: { kind: "correction", delayMs: 300 }, [fast]: { kind: "correction" } });
		run.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			run.answer("Keeping it."),
			run.answer("In a transaction."),
		]);
		const first = run.session.prompt(GOAL);
		await run.started;

		await Promise.all([
			run.session.prompt(slow, { streamingBehavior: "followUp" }),
			run.session.prompt(fast, { streamingBehavior: "steer" }),
		]);
		await sleep(20);
		expect(run.session.getSteeringMessages()).toEqual([slow, fast]);
		expect(run.session.getFollowUpMessages()).toEqual([]);

		run.release();
		await first;
		expect(getUserTexts(run.harness).filter((text) => text === slow || text === fast)).toEqual([slow, fast]);
	});

	it("a run that ends while a message waits for its verdict is followed by a run the message starts, once", async () => {
		const extra = "Also add an index on email.";
		const run = await running({ [extra]: { kind: "addition", delayMs: 200 } });
		run.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			run.answer("Migrated."),
			run.answer("Index added."),
		]);
		const first = run.session.prompt(GOAL);
		await run.started;

		const sent = run.session.prompt(extra, { streamingBehavior: "steer" });
		run.release();
		await first;
		await sent;
		await sleep(20);
		expect(run.seen[0]).not.toContain(extra);
		expect(run.seen[1]).toContain(extra);
		expect(times(run.harness, extra)).toBe(1);
		expect(run.session.isStreaming).toBe(false);
	});

	it("a message with images, or one sent before mu has a goal, goes as sent without asking the judge", async () => {
		const run = await running({ "Look at this.": { kind: "addition" } });
		run.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			run.answer("Migrated."),
		]);
		const first = run.session.prompt(GOAL);
		await run.started;
		const withImage = await run.session.extensionRunner.emitInput("Look at this.", [IMAGE], "interactive", "steer");
		expect(withImage.action).not.toBe("handled");
		run.release();
		await first;
		expect(run.asked).toEqual([]);

		// Only the interjection feature: nothing has read the first message for a goal.
		const bare = await running({ "Also add an index on email.": { kind: "addition" } }, { only: ["interjection"] });
		bare.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			bare.answer("Migrated."),
		]);
		const bareFirst = bare.session.prompt(GOAL);
		await bare.started;
		await bare.session.prompt("Also add an index on email.", { streamingBehavior: "steer" });
		expect(bare.session.getSteeringMessages()).toEqual(["Also add an index on email."]);
		bare.release();
		await bareFirst;
		expect(bare.asked).toEqual([]);
	});

	// The kernel keeps the model's last words: admission, memory and the language server each kept a copy, and with all
	// three off the judge read that the agent was doing nothing.
	it("reads what the model said last as what the agent is doing, whichever other features are on", async () => {
		const extra = "Also add an index on email.";
		const run = await running({ [extra]: { kind: "addition" } }, { only: ["preflight", "frame", "interjection"] });
		run.harness.setResponses([
			fauxAssistantMessage([fauxText("Copying the rows into the new table first."), fauxToolCall("wait", {})], {
				stopReason: "toolUse",
			}),
			run.answer("Migrated."),
			run.answer("Index added."),
		]);
		const first = run.session.prompt(GOAL);
		await run.started;
		await run.session.prompt(extra, { streamingBehavior: "steer" });
		await sleep(20);
		run.release();
		await first;
		expect(run.actions).toEqual(["Copying the rows into the new table first."]);
	});

	describe("a question about how far the work has got", () => {
		const question = "How far along are you?";
		const todo = (params: Record<string, string>) => fauxToolCall("todo", params);

		it("is answered by mu from what it knows, and the agent is not sent it", async () => {
			const run = await running({ [question]: { kind: "status" } }, { ui: true });
			run.harness.setResponses([
				fauxAssistantMessage(
					[
						todo({ action: "add", text: "The users table has the new columns" }),
						todo({ action: "add", text: "Every row is copied" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([todo({ action: "done", id: "a1", evidence: "the migration ran" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxText("Copying the rows into the new table first."), fauxToolCall("wait", {})], {
					stopReason: "toolUse",
				}),
				run.answer("Migrated."),
			]);
			const first = run.session.prompt(GOAL);
			await run.started;

			// Queued for after the run, as a question that can wait would be: it is answered now all the same.
			await run.session.prompt(question, { streamingBehavior: "followUp" });
			await sleep(20);
			expect(run.session.getSteeringMessages()).toEqual([]);
			expect(run.session.getFollowUpMessages()).toEqual([]);
			expect(run.answers).toHaveLength(1);
			expect(run.answers[0].split("\n")).toEqual([
				"mu: the agent is still working and wasn't sent \"How far along are you?\". Here's where the run stands:",
				expect.stringMatching(/^ {2}\d+ s into this run, 4 steps so far\.$/),
				"  Checklist, 1 of 2 done:",
				"    [x] The users table has the new columns",
				"    [ ] Every row is copied",
				expect.stringMatching(/^ {2}Running now: wait \(\d+ s\)$/),
				'  It last said: "Copying the rows into the new table first."',
				"To have the agent answer instead, send the same message again within a minute.",
			]);

			run.release();
			await first;
			expect(run.seen.flat()).not.toContain(question);
			expect(times(run.harness, question)).toBe(0);
		});

		it("goes to the agent when the user sends it again right after mu's answer", async () => {
			const run = await running({ [question]: { kind: "status" } }, { ui: true });
			run.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
				run.answer("Half of the rows are copied."),
				run.answer("Migrated."),
			]);
			const first = run.session.prompt(GOAL);
			await run.started;

			await run.session.prompt(question, { streamingBehavior: "steer" });
			await run.session.prompt(question, { streamingBehavior: "steer" });
			await sleep(20);
			// The judge was asked once: the second time, the message was the agent's without a verdict.
			expect(run.asked).toEqual([question]);
			expect(run.answers).toHaveLength(1);
			expect(run.session.getSteeringMessages()).toEqual([question]);

			run.release();
			await first;
			expect(run.seen[0]).toContain(question);
			expect(times(run.harness, question)).toBe(1);
		});

		it("is the agent's where nobody would read mu's answer, or with `answerStatus` off", async () => {
			const unseen = await running({ [question]: { kind: "status" } });
			const off = await running(
				{ [question]: { kind: "status" } },
				{ ui: true, features: { interjection: { answerStatus: false } } },
			);
			for (const run of [unseen, off]) {
				run.harness.setResponses([
					fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
					run.answer("Half of the rows are copied."),
					run.answer("Migrated."),
				]);
				const first = run.session.prompt(GOAL);
				await run.started;
				await run.session.prompt(question, { streamingBehavior: "steer" });
				await sleep(20);
				expect(run.asked).toEqual([question]);
				expect(run.answers).toEqual([]);
				expect(run.session.getSteeringMessages()).toEqual([question]);
				run.release();
				await first;
				expect(times(run.harness, question)).toBe(1);
			}
		});

		it("says what waits for the user", async () => {
			const run = await running(
				{ [question]: { kind: "status" } },
				{ ui: true, features: { askUser: { waitMs: 60 } } },
			);
			run.harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("ask_user", {
							questions: [{ question: "Tabs or spaces?", options: [{ label: "Tabs" }, { label: "Spaces" }] }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
				run.answer("Migrated."),
			]);
			const first = run.session.prompt(GOAL);
			await run.started;
			await run.session.prompt(question, { streamingBehavior: "steer" });
			expect(run.answers[0]).toContain("\n  mu has a question for you: type /answer\n");
			run.release();
			await first;
		});
	});

	// The evolve feature counts the messages a user writes into a run in its own `input` handler, which runs after
	// this feature's and never sees a message this one takes.
	it("tells the evolve feature of each message it takes: one it re-sends, and one it answers", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mu-interjection-agent-"));
		folders.push(agentDir);
		const extra = "Also add an index on email.";
		const question = "How far along are you?";
		const plain = "Hmm.";
		const run = await running(
			{ [extra]: { kind: "addition" }, [question]: { kind: "status" }, [plain]: { kind: "other" } },
			{ ui: true, agentDir },
		);
		run.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			run.answer("Migrated."),
			run.answer("Index added."),
		]);
		const first = run.session.prompt(GOAL);
		await run.started;
		await run.session.prompt(extra, { streamingBehavior: "steer" });
		await run.session.prompt(question, { streamingBehavior: "steer" });
		await run.session.prompt(plain, { streamingBehavior: "steer" });
		run.release();
		await first;

		const kept = join(agentDir, "mu", "evolve.jsonl");
		const rows = readFileSync(kept, "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => rowOf(JSON.parse(line)) ?? []);
		const runs = rows.filter((row) => row.type === "run");
		expect(runs).toEqual([expect.objectContaining({ messages: 3, status: 1, stopped: false })]);

		// With enough runs to add up, /evolve says how many of the messages only asked how far the work was.
		const quiet = { ...runs[0], messages: 0, status: 0 };
		appendFileSync(kept, `${[quiet, quiet, quiet, quiet].map((row) => JSON.stringify(row)).join("\n")}\n`);
		await run.session.prompt("/evolve");
		expect(run.notes.at(-1)).toContain(
			"  You wrote into a run 3 times, 1 of them to ask how far it was, which mu answered.",
		);
	});

	it("with shadow as the default mode in mu.json, the message goes at once as sent and the verdict is only recorded", async () => {
		const extra = "Also add an index on email.";
		const run = await running({ [extra]: { kind: "addition", delayMs: 300 } }, { modes: { default: "shadow" } });
		run.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			run.answer("Migrated, with the index."),
		]);
		const first = run.session.prompt(GOAL);
		await run.started;

		const sentAt = Date.now();
		await run.session.prompt(extra, { streamingBehavior: "steer" });
		expect(Date.now() - sentAt).toBeLessThan(200);
		expect(run.session.getSteeringMessages()).toEqual([extra]);
		await sleep(350);
		expect(run.asked).toEqual([extra]);
		expect(run.session.getFollowUpMessages()).toEqual([]);

		run.release();
		await first;
		expect(times(run.harness, extra)).toBe(1);
	});
});
