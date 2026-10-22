import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { DecisionEngine } from "../src/decision.ts";
import { hiveDeliver, hivePublish, hiveRelate } from "../src/decisions/hive.ts";
import { candidatesOf } from "../src/extension/features/hive.ts";
import type { SwarmRunner } from "../src/extension/features/swarm.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { Board, foldRelations, isDuplicate, type Note, overlapping, type Relation } from "../src/hive/board.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import { BRIEF_ENV, parseBrief, type SwarmBrief } from "../src/swarm/brief.ts";
import { markOf } from "../src/swarm/markers.ts";
import type { Answer } from "../src/types.ts";
import { attended } from "./attended.ts";

const yes: Answer = { type: "boolean", probability: 0.95 };
const no: Answer = { type: "boolean", probability: 0.04 };
const kind = (choice: string): Answer => ({ type: "choice", choice, probabilities: { [choice]: 0.9 } });
const note = (patch: Partial<Note>): Note => ({
	id: "n1",
	bee: "repro",
	kind: "finding",
	score: 0.9,
	text: "npm test -- login fails only when TZ=UTC is set",
	source: "bash",
	at: "2026-09-20T00:00:00Z",
	...patch,
});

describe("hive board", () => {
	it("hands each reader only what is new to it, and survives a torn line", () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		const writer = new Board(dir);
		const reader = new Board(dir);

		writer.post(note({ id: "a" }));
		expect(reader.fresh().map((entry) => entry.id)).toEqual(["a"]);
		expect(reader.fresh()).toEqual([]);

		appendFileSync(join(dir, "board.jsonl"), '{"id":"torn","bee":"x"');
		expect(reader.fresh()).toEqual([]);
		appendFileSync(join(dir, "board.jsonl"), ',"kind":"finding","score":1,"text":"t","source":"s","at":""}\n');
		writer.post(note({ id: "b" }));
		expect(reader.fresh().map((entry) => entry.id)).toEqual(["torn", "b"]);
		expect(writer.all()).toHaveLength(3);
	});

	it("hands each reader only the relations that are new to it", () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		const writer = new Board(dir);
		const reader = new Board(dir);
		writer.relate({ later: "b", earlier: "a", relation: "supersedes", score: 0.9, by: "history", at: "" });
		expect(reader.freshRelations().map((row) => row.later)).toEqual(["b"]);
		expect(reader.freshRelations()).toEqual([]);
		expect(reader.relations()).toHaveLength(1);
	});

	it("finds the earlier notes a new one may be speaking about, closest first", () => {
		const known = [
			note({ id: "tz" }),
			note({ id: "cookie", bee: "auth", text: "the session cookie is dropped in refresh() at src/session.ts:88" }),
			note({ id: "vitest", bee: "web", text: "the project uses vitest for its unit tests" }),
		];
		const later =
			"login passes once the inherited TZ=UTC is unset: the failing npm test run was the CI env, not the code";
		expect(overlapping(later, known).map((entry) => entry.id)).toEqual(["tz"]);
		expect(overlapping("nothing in common here", known)).toEqual([]);
		expect(overlapping(later, known, { limit: 0 })).toEqual([]);
	});

	it("reads the board with its corrections: what stands, what was replaced, what is in dispute", () => {
		const notes = [
			note({ id: "a" }),
			note({ id: "b", bee: "history" }),
			note({ id: "c", bee: "web" }),
			note({ id: "d", bee: "auth" }),
		];
		const row = (later: string, earlier: string, relation: Relation) => ({
			later,
			earlier,
			relation,
			score: 0.9,
			by: "x",
			at: "",
		});
		const state = foldRelations(notes, [
			row("b", "a", "supersedes"),
			row("c", "b", "contradicts"),
			row("d", "c", "supports"),
			row("d", "missing", "supersedes"),
		]);
		expect(state.current.map((entry) => entry.id)).toEqual(["b", "c", "d"]);
		expect(state.superseded.get("a")?.later).toBe("b");
		expect([...state.contested.keys()]).toEqual(["b", "c"]);
		expect(state.supported.get("c")).toEqual(["auth"]);
		// A dispute one side of which was since replaced is over.
		const settled = foldRelations(notes, [row("c", "b", "contradicts"), row("d", "b", "supersedes")]);
		expect(settled.contested.size).toBe(0);
		expect(settled.current.map((entry) => entry.id)).toEqual(["a", "c", "d"]);
	});

	it("counts a note as confirmed only by other investigators, each once", () => {
		// Seen live: a bee's three notes in a row "supported" each other, and the report said "confirmed by 4"
		// of a note only one other investigator had spoken to.
		const notes = [
			note({ id: "a", bee: "history" }),
			note({ id: "b", bee: "history" }),
			note({ id: "c", bee: "web" }),
			note({ id: "d", bee: "web" }),
			note({ id: "e", bee: "repro" }),
		];
		const row = (later: string, earlier: string) => ({
			later,
			earlier,
			relation: "supports" as const,
			score: 0.9,
			by: "",
			at: "",
		});
		const state = foldRelations(notes, [row("b", "a"), row("c", "a"), row("d", "a"), row("e", "a"), row("d", "c")]);
		expect(state.supported.get("a")).toEqual(["web", "repro"]);
		expect(state.supported.has("c")).toBe(false);
	});

	it("knows without asking that a repeated note is not news", () => {
		const known = [note({})];
		expect(isDuplicate("npm test -- login fails only when TZ=UTC is set.", known)).toBe(true);
		expect(isDuplicate("the session cookie is dropped in refresh() at src/session.ts:88", known)).toBe(false);
	});

	it("takes what a bee said as a candidate, and the beginning of what its tools returned only when asked to", () => {
		const message = {
			content: [
				{ type: "text", text: "The cookie is dropped in refresh(): it never copies the Set-Cookie header." },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test -- login" } },
			],
		};
		const results = [
			{
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: `FAIL login.test.ts\n${"x".repeat(900)}` }],
			},
			{ toolCallId: "c2", toolName: "ls", content: [{ type: "text", text: "a.ts" }] },
		];
		// In 7 hives none of 32 tool outputs put to the judge was published.
		expect(candidatesOf(message, results).map((candidate) => candidate.source)).toEqual(["said"]);

		const candidates = candidatesOf(message, results, { toolOutputs: true });
		expect(candidates.map((candidate) => candidate.source)).toEqual(["said", 'bash {"command":"npm test -- login"}']);
		expect(candidates[1].text).toHaveLength(600);
	});

	it("reads the mark a bee starts its note with, as the checkpoint asks", () => {
		expect(markOf("FOUND: refresh() drops the cookie at src/session.ts:88")).toBe("finding");
		expect(markOf("**FOUND:** refresh() drops the cookie")).toBe("finding");
		expect(markOf("  **FOUND**: refresh() drops the cookie")).toBe("finding");
		expect(markOf("DEAD END: the TZ theory, login passes with TZ=UTC")).toBe("dead_end");
		// Not marked: lower case, a mark further in, or no colon.
		expect(markOf("Found: it was the env.")).toBeUndefined();
		expect(markOf("Reading on. FOUND: maybe")).toBeUndefined();
		expect(markOf("**Found** - refresh() drops the cookie")).toBeUndefined();
	});
});

describe("hive gates", () => {
	const engineWith = (responder: MockResponder) =>
		new DecisionEngine({ judge: new Judge({ provider: new MockJudgeProvider(responder) }), defaultMode: "active" });

	it("publishes news, not routine progress, and delivers a decision to everyone", async () => {
		const input = { goal: "fix login", focus: "reproduce it", note: "fails only with TZ=UTC", source: "said" };
		const news = await engineWith(() => ({ share_worthy: yes, kind: kind("finding") })).decide(hivePublish, input);
		const routine = await engineWith(() => ({ share_worthy: yes, kind: kind("other") })).decide(hivePublish, input);
		const irrelevant = await engineWith(() => ({ share_worthy: no, kind: kind("finding") })).decide(
			hivePublish,
			input,
		);

		expect(news.outcome).toEqual({ publish: true, kind: "finding", score: 0.95 });
		expect(routine.outcome.publish).toBe(false);
		expect(irrelevant.outcome.publish).toBe(false);

		const deliver = { focus: "read the auth code", note: "we will not touch src/generated", from: "lead" };
		const engine = engineWith(() => ({ useful: no }));
		expect((await engine.decide(hiveDeliver, { ...deliver, kind: "decision" })).outcome.deliver).toBe(true);
		expect((await engine.decide(hiveDeliver, { ...deliver, kind: "finding" })).outcome.deliver).toBe(false);
	});

	it("delivers without a judge rather than cutting the bees off from each other", async () => {
		const deliver = { focus: "read the auth code", note: "login fails only with TZ=UTC", from: "repro" };
		const down = engineWith(() => {
			throw new Error("judge down");
		});
		expect(await down.decide(hiveDeliver, { ...deliver, kind: "finding" })).toMatchObject({
			source: "fallback",
			outcome: { deliver: true },
		});
	});

	it("relates a later note to an earlier one, and lets a worker replace its own words without a vote", async () => {
		const relation = (choice: string, probability = 0.9): Answer => ({
			type: "choice",
			choice,
			probabilities: { [choice]: probability },
		});
		const input = {
			goal: "fix login",
			earlier: { bee: "repro", kind: "finding" as const, text: "the tests cannot run here" },
			later: { bee: "history", kind: "finding" as const, text: "they run once the inherited env is cleared" },
		};
		const relate = (answer: Answer, subject = input) =>
			engineWith(() => ({ relation: answer }))
				.decide(hiveRelate, subject)
				.then((decision) => decision.outcome);

		expect(await relate(relation("supersedes"))).toEqual({ relation: "supersedes", score: 0.9 });
		expect((await relate(relation("contradicts"))).relation).toBe("contradicts");
		expect((await relate(relation("supports"))).relation).toBe("supports");
		expect(
			(await relate(relation("contradicts"), { ...input, later: { ...input.later, bee: "repro" } })).relation,
		).toBe("supersedes");
		expect((await relate(relation("none"))).relation).toBeNull();
		expect((await relate(relation("supersedes", 0.4))).relation).toBeNull();
	});

	it("takes another investigator's note off the board only on a near-certain reading, and a bee's own on the common bar", async () => {
		// Calibration on real hives: across bees every "supersedes" at 0.6-0.87 was wrong, typically a later note
		// that agreed and added. Seen live: "a bee is killed 90 s after its wrap-up" read as replacing "the
		// defaults are 10 min and 90 s" (0.76), and the bee that had it right was told it no longer held.
		const reading = (choice: string, probability: number): Answer => ({
			type: "choice",
			choice,
			probabilities: { [choice]: probability },
		});
		const earlier = { bee: "configuration", kind: "finding" as const, text: "defaults are 10 min and 90 s" };
		const later = { bee: "implementation", kind: "finding" as const, text: "a bee is killed 90 s after its wrap-up" };
		const relate = (answer: Answer, own = false) =>
			engineWith(() => ({ relation: answer }))
				.decide(hiveRelate, {
					goal: "how long can a hive take",
					earlier,
					later: own ? { ...later, bee: earlier.bee } : later,
				})
				.then((decision) => decision.outcome);

		expect(await relate(reading("supersedes", 0.87))).toEqual({ relation: null, score: 0.87 });
		expect((await relate(reading("supersedes", 0.95))).relation).toBe("supersedes");
		expect((await relate(reading("supersedes", 0.7), true)).relation).toBe("supersedes");
		// The bar is for replacing, not for agreeing or disputing.
		expect((await relate(reading("supports", 0.7))).relation).toBe("supports");
		expect((await relate(reading("contradicts", 0.7))).relation).toBe("contradicts");
	});
});

describe("hive in a session", () => {
	const harnesses: Harness[] = [];
	const saved = { ...process.env };
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		duringRead = () => {};
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("KYRN_HIVE_") || key.startsWith("KYRN_SWARM_")) delete process.env[key];
		}
		Object.assign(process.env, saved);
	});

	/** Set by a test to have something happen while the bee's tool runs. */
	let duringRead: () => void = () => {};
	const readTool: AgentTool = {
		name: "read",
		label: "read",
		description: "read",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async () => {
			duringRead();
			return { content: [{ type: "text", text: "export const ok = true;" }], details: {} };
		},
	};

	/** A bee in a hive whose judge shares nothing of its own and accepts every note about TZ=UTC. */
	async function bee(dir: string, extraEnv: Record<string, string> = {}) {
		Object.assign(process.env, {
			KYRN_HIVE_DIR: dir,
			KYRN_HIVE_BEE: "auth-code",
			KYRN_HIVE_GOAL: "fix the flaky login",
			KYRN_HIVE_FOCUS: "read the session code",
			...extraEnv,
		});
		const harness = await createHarness({
			tools: [readTool],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider((request): Record<string, Answer> => {
						const state = request.state as { note?: string };
						if ("share_worthy" in request.questions) return { share_worthy: no, kind: kind("other") };
						if ("useful" in request.questions)
							return { useful: String(state.note).includes("TZ=UTC") ? yes : no };
						return {};
					}),
					mode: "active",
					config: parseConfig({
						features: attended({ memory: false, admission: false, permissions: { mode: "full" } }),
					}),
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	}

	const step = (text: string) =>
		fauxAssistantMessage([fauxText(text), fauxToolCall("read", { path: "src/session.ts" })], {
			stopReason: "toolUse",
		});

	it("inside a bee: notes are handed over at a working step, and a finished bee is not woken up again", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		new Board(dir).post(note({ id: "from-repro" }));
		const harness = await bee(dir);
		const seen: string[] = [];
		const record = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: unknown }) => {
			seen.push(JSON.stringify(context.messages));
			return reply;
		};
		harness.setResponses([
			record(step("Reading the session code to see where the cookie is set.")),
			// The judge needs a moment; the note is in the inbox by the end of this step.
			async (context) => {
				await vi.waitFor(() => expect(new Board(dir).judged()).toBeGreaterThan(0));
				return record(step("Still reading, now the refresh path in the same file."))(context);
			},
			record(fauxAssistantMessage("**Found** - refresh() drops the cookie; it only shows when TZ=UTC.")),
		]);

		await harness.session.prompt("Investigate your angle.");

		expect(seen).toHaveLength(3);
		expect(seen[1]).not.toContain("fails only when TZ=UTC");
		expect(seen[2]).toContain("Notes from the other workers");
		expect(seen[2]).toContain("fails only when TZ=UTC");
		expect(new Board(dir).deliveries()).toEqual([{ note: "from-repro", to: "auth-code", score: 0.95 }]);
		// The report is the bee's last word: nothing arrived afterwards to make it say "Acknowledged".
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
		expect(JSON.stringify(harness.session.messages.at(-1))).toContain("**Found**");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("inside a bee: notes and a checkpoint due at the same step come as one message, so the report stays its last word", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		new Board(dir).post(note({ id: "from-repro" }));
		const harness = await bee(dir);
		const silent = () =>
			fauxAssistantMessage(
				[fauxToolCall("read", { path: "src/session.ts" }), fauxToolCall("read", { path: "src/refresh.ts" })],
				{ stopReason: "toolUse" },
			);
		let reportContext = "";
		harness.setResponses([
			silent(),
			// By the end of this step the note is in the inbox, and four tool calls have gone by without a word.
			async () => {
				await vi.waitFor(() => expect(readFileSync(join(dir, "gate.jsonl"), "utf8")).toContain('"gate":"deliver"'));
				return silent();
			},
			(context) => {
				reportContext = JSON.stringify(context.messages);
				return fauxAssistantMessage("**Found** - refresh() drops the cookie; it only shows when TZ=UTC.");
			},
			// Taken only by a bee woken up again after its report (live run, 2026-09-24).
			fauxAssistantMessage("FOUND: refresh() drops the cookie."),
		]);

		await harness.session.prompt("Investigate your angle.");

		expect(reportContext).toContain("fails only when TZ=UTC");
		expect(reportContext).toContain("Checkpoint for the other investigators");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(JSON.stringify(harness.session.messages.at(-1))).toContain("**Found**");
	});

	it("inside a bee: a note that arrives while it writes its report gets one last call, and only one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		const harness = await bee(dir);
		let lastCallSeen = "";
		harness.setResponses([
			() => {
				// It lands while the report is being written: too late for a working step.
				new Board(dir).post(note({ id: "late" }));
				return fauxAssistantMessage("**Found** - refresh() drops the session cookie.");
			},
			(context) => {
				lastCallSeen = JSON.stringify(context.messages);
				new Board(dir).post(note({ id: "later", text: "also TZ=UTC breaks the date parser in src/date.ts" }));
				return fauxAssistantMessage("NO CHANGE");
			},
		]);

		await harness.session.prompt("Investigate your angle.");

		expect(lastCallSeen).toContain("Last call before your report is handed in.");
		expect(lastCallSeen).toContain("fails only when TZ=UTC");
		expect(lastCallSeen).toContain("reply with exactly: NO CHANGE");
		// The second late note found nobody: there is no third turn.
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
		expect(new Board(dir).deliveries().map((delivery) => delivery.note)).toEqual(["late"]);
	});

	it("inside any subagent: a wrap-up request asks for the report and closes the tools", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		const control = join(dir, "bee-0.json");
		const harness = await bee(dir, { KYRN_SWARM_CONTROL: control });
		// The request comes in while a tool runs: the bee hears of it at the end of that step.
		duringRead = () => {
			duringRead = () => {};
			writeFileSync(control, JSON.stringify({ action: "wrap_up", reason: "time budget of 10 min reached" }));
		};
		let afterRequest = "";
		let afterBlocked = "";
		harness.setResponses([
			step("Reading the session code."),
			(context) => {
				afterRequest = JSON.stringify(context.messages);
				// A model that does not listen and reaches for a tool anyway.
				return step("One more file.");
			},
			(context) => {
				afterBlocked = JSON.stringify(context.messages);
				return fauxAssistantMessage("Report: the cookie is set in refresh(); not yet verified under TZ=UTC.");
			},
		]);

		await harness.session.prompt("Investigate your angle.");

		expect(afterRequest).toContain("Time is up. (time budget of 10 min reached.) Stop investigating now");
		expect(afterBlocked).toContain("Time is up: no more tool calls. (time budget of 10 min reached.)");
		expect(JSON.stringify(harness.session.messages.at(-1))).toContain("Report: the cookie is set in refresh()");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("inside any subagent: a request that lands mid-step is answered by the very next tool call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		const control = join(dir, "bee-0.json");
		const harness = await bee(dir, { KYRN_SWARM_CONTROL: control });
		let ran = 0;
		duringRead = () => {
			ran++;
		};
		harness.setResponses([
			() => {
				writeFileSync(control, JSON.stringify({ action: "wrap_up", reason: "stopped by the user" }));
				return step("Reading the session code.");
			},
			fauxAssistantMessage("Report: nothing established yet."),
		]);

		await harness.session.prompt("Investigate your angle.");

		expect(ran).toBe(0);
		const blocked = JSON.stringify(harness.session.messages.find((message) => message.role === "toolResult"));
		expect(blocked).toContain("Time is up: no more tool calls. (stopped by the user.)");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("inside a bee: a correction to a note it holds reaches it by rule, in place of the replaced note", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		const board = new Board(dir);
		board.post(note({ id: "e1" }));
		board.post(
			note({
				id: "l1",
				bee: "history",
				text: "TZ=UTC was a red herring: after clearing the inherited TZ from the CI env, login passes in every zone",
			}),
		);
		board.relate({ later: "l1", earlier: "e1", relation: "supersedes", score: 0.93, by: "history", at: "" });
		const harness = await bee(dir);
		const seen: string[] = [];
		const record = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: unknown }) => {
			seen.push(JSON.stringify(context.messages));
			return reply;
		};
		harness.setResponses([
			record(step("Reading the session code.")),
			async (context) => {
				// Both notes judged, then the correction folded in: three gate rows.
				await vi.waitFor(() => expect(new Board(dir).judged()).toBeGreaterThanOrEqual(3));
				return record(step("Still reading."))(context);
			},
			record(fauxAssistantMessage("**Found** - nothing more.")),
		]);

		await harness.session.prompt("Investigate your angle.");

		// The context is compared as JSON, so the quotes inside the line are escaped.
		expect(seen[2]).toContain('CORRECTION from history: what repro reported earlier (\\"npm test -- login fails');
		expect(seen[2]).toContain("login passes in every zone");
		expect(seen[2]).not.toContain("- repro (finding)");
		expect(new Board(dir).deliveries()).toEqual([{ note: "l1", to: "auth-code", score: 0.93 }]);
		expect(readFileSync(join(dir, "gate.jsonl"), "utf8")).toContain('"gate":"withheld"');
	});

	it("inside a bee: a dispute over a note it holds reaches it with both sides kept", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		const board = new Board(dir);
		board.post(note({ id: "e1" }));
		board.post(
			note({
				id: "n2",
				bee: "history",
				text: "login passes locally with TZ=UTC set; the failure is not the timezone",
			}),
		);
		board.relate({ later: "n2", earlier: "e1", relation: "contradicts", score: 0.8, by: "history", at: "" });
		const harness = await bee(dir);
		const seen: string[] = [];
		const record = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: unknown }) => {
			seen.push(JSON.stringify(context.messages));
			return reply;
		};
		harness.setResponses([
			record(step("Reading the session code.")),
			async (context) => {
				await vi.waitFor(() => expect(new Board(dir).judged()).toBeGreaterThanOrEqual(3));
				return record(step("Still reading."))(context);
			},
			record(fauxAssistantMessage("**Found** - nothing more.")),
		]);

		await harness.session.prompt("Investigate your angle.");

		expect(seen[2]).toContain(
			'CONFLICT, both kept: repro says \\"npm test -- login fails only when TZ=UTC is set\\" but history says \\"login passes locally',
		);
		expect(seen[2]).toContain("say which holds");
		expect(seen[2]).not.toContain("- repro (finding)");
		expect(new Board(dir).deliveries()).toEqual([
			{ note: "e1", to: "auth-code", score: 0.8 },
			{ note: "n2", to: "auth-code", score: 0.8 },
		]);
	});

	it("inside a bee: what it posts is held against what the board already says", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		new Board(dir).post(note({ id: "e1" }));
		Object.assign(process.env, {
			KYRN_HIVE_DIR: dir,
			KYRN_HIVE_BEE: "auth-code",
			KYRN_HIVE_GOAL: "fix the flaky login",
			KYRN_HIVE_FOCUS: "read the session code",
		});
		const harness = await createHarness({
			tools: [readTool],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider((request): Record<string, Answer> => {
						const state = request.state as { note?: string; later?: string };
						if ("share_worthy" in request.questions) {
							const news = String(state.note).includes("inherited TZ");
							return { share_worthy: news ? yes : no, kind: kind(news ? "finding" : "other") };
						}
						if ("relation" in request.questions) {
							const choice = String(state.later).includes("inherited TZ") ? "supersedes" : "none";
							return { relation: { type: "choice", choice, probabilities: { [choice]: 0.9 } } };
						}
						if ("useful" in request.questions) return { useful: no };
						return {};
					}),
					mode: "active",
					config: parseConfig({
						features: attended({ memory: false, admission: false, permissions: { mode: "full" } }),
					}),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxText(
						"FOUND: the login test passes once the inherited TZ=UTC is unset from the environment; the earlier npm test failure was the CI env, not the code",
					),
					fauxToolCall("read", { path: "src/session.ts" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Found: it was the env."),
		]);

		await harness.session.prompt("Investigate your angle.");
		await vi.waitFor(() => expect(new Board(dir).relations()).toHaveLength(1));

		const mine = new Board(dir).all().find((entry) => entry.bee === "auth-code");
		expect(new Board(dir).relations()[0]).toMatchObject({
			later: mine?.id,
			earlier: "e1",
			relation: "supersedes",
			score: 0.9,
			by: "auth-code",
		});
		// The gate log keeps the judge's own reading beside the outcome: the bar is calibrated from it.
		const relate = readFileSync(join(dir, "gate.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.find((row) => row.gate === "relate");
		expect(relate).toMatchObject({ relation: "supersedes", choice: "supersedes", p: { supersedes: 0.9 } });
	});

	it("inside a bee: the judge posts what the bee found and hands it what the others found", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
		new Board(dir).post(note({ id: "from-repro" }));
		new Board(dir).post(note({ id: "noise", bee: "web", text: "the project uses vitest for its unit tests" }));
		Object.assign(process.env, {
			KYRN_HIVE_DIR: dir,
			KYRN_HIVE_BEE: "auth-code",
			KYRN_HIVE_GOAL: "fix the flaky login",
			KYRN_HIVE_FOCUS: "read the session code",
		});

		const tool: AgentTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => ({
				content: [{ type: "text", text: `export function refresh() {\n${"  // body\n".repeat(40)}}` }],
				details: {},
			}),
		};
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider((request): Record<string, Answer> => {
						const state = request.state as { note?: string };
						if ("share_worthy" in request.questions) {
							const news = String(state.note).includes("never copies the Set-Cookie");
							return { share_worthy: news ? yes : no, kind: kind(news ? "finding" : "other") };
						}
						if ("useful" in request.questions)
							return { useful: String(state.note).includes("TZ=UTC") ? yes : no };
						return {};
					}),
					mode: "active",
					config: parseConfig({
						features: attended({ memory: false, admission: false, permissions: { mode: "full" } }),
					}),
				}),
			],
		});
		harnesses.push(harness);
		let second = "";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxText("refresh() never copies the Set-Cookie header, so the session cookie is lost."),
					fauxToolCall("read", { path: "src/session.ts" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				second = JSON.stringify(context.messages);
				return fauxAssistantMessage("Found: the cookie is dropped in refresh().");
			},
		]);

		await harness.session.prompt("Investigate your angle.");
		await vi.waitFor(() => expect(new Board(dir).all().some((entry) => entry.bee === "auth-code")).toBe(true));

		const mine = new Board(dir).all().filter((entry) => entry.bee === "auth-code");
		expect(mine).toHaveLength(1);
		expect(mine[0]).toMatchObject({ kind: "finding", source: "said" });
		expect(mine[0].text).toContain("never copies the Set-Cookie header");
		// What the repro bee found reached this one before its next step; the irrelevant note did not.
		await vi.waitFor(() =>
			expect(new Board(dir).deliveries()).toEqual([{ note: "from-repro", to: "auth-code", score: 0.95 }]),
		);
		if (second.includes("kyrn.hive") || second.includes("TZ=UTC")) {
			expect(second).toContain("fails only when TZ=UTC");
			expect(second).not.toContain("uses vitest");
		}
	});

	it("inside a bee: a note it marks as the checkpoint asks is published by rule, the rest is put to the judge", async () => {
		const posted = async (hive: Record<string, unknown>) => {
			const dir = mkdtempSync(join(tmpdir(), "kyrn-hive-test-"));
			Object.assign(process.env, {
				KYRN_HIVE_DIR: dir,
				KYRN_HIVE_BEE: "auth-code",
				KYRN_HIVE_GOAL: "fix the flaky login",
				KYRN_HIVE_FOCUS: "read the session code",
			});
			// A judge that would hold everything back, as it held back 14 of 45 marked findings in 7 hives.
			const provider = new MockJudgeProvider((request): Record<string, Answer> => {
				if ("share_worthy" in request.questions) return { share_worthy: no, kind: kind("other") };
				return {};
			});
			const harness = await createHarness({
				tools: [readTool],
				extensionFactories: [
					createKyrnJudgeExtension({
						provider,
						mode: "active",
						config: parseConfig({
							features: { memory: false, admission: false, permissions: { mode: "full" }, hive },
						}),
					}),
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				step(
					"FOUND: refresh() never copies the Set-Cookie header, so the session cookie is lost at src/session.ts:88",
				),
				step("DEAD END: the cookie domain is right; login.test.ts sets it to localhost as the server does"),
				step("Reading the refresh path in the same file once more, to see where the header goes."),
				fauxAssistantMessage("Report: refresh() drops the cookie."),
			]);
			await harness.session.prompt("Investigate your angle.");
			await vi.waitFor(() => expect(new Board(dir).judged()).toBeGreaterThanOrEqual(3));
			const asked = provider.calls
				.filter((call) => "share_worthy" in call.questions)
				.map((call) => String((call.state as { note?: string }).note));
			return { notes: new Board(dir).all(), asked };
		};

		const { notes, asked } = await posted({});
		expect(notes.map((entry) => [entry.kind, entry.score, entry.text.slice(0, 10)])).toEqual([
			["finding", 1, "FOUND: ref"],
			["dead_end", 1, "DEAD END: "],
		]);
		// Only the unmarked words went to the judge.
		expect(asked).toEqual(["Reading the refresh path in the same file once more, to see where the header goes."]);

		const judged = await posted({ publishMarked: false });
		expect(judged.notes).toEqual([]);
		expect(judged.asked).toHaveLength(3);
	});

	it("the queen: with no model ladder asks the judge nothing, and every bee keeps the session's thinking", async () => {
		const seen: { bee: string; thinking: string; model?: string }[] = [];
		const runner: SwarmRunner = async (task, assignment, _signal, env) => {
			seen.push({ bee: env?.KYRN_HIVE_BEE ?? "", thinking: assignment.thinking, model: assignment.model });
			return `${task.title}: done`;
		};
		const hard = (): Record<string, Answer> => ({
			difficulty: { type: "score", score: 3 },
			reasoning: { type: "score", score: 0 },
		});
		const queen = async (features: Record<string, unknown>) => {
			seen.length = 0;
			const provider = new MockJudgeProvider(hard);
			const harness = await createHarness({
				extensionFactories: [
					createKyrnJudgeExtension({
						provider,
						mode: "active",
						config: parseConfig({
							features: attended({ memory: false, permissions: { mode: "full" }, ...features }),
						}),
						swarmRunner: runner,
					}),
				],
			});
			harnesses.push(harness);
			harness.setResponses([
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
			await harness.session.prompt("Why is login flaky?");
			return {
				routing: provider.calls.filter((call) => "difficulty" in call.questions).length,
				session: harness.session.thinkingLevel,
			};
		};

		const plain = await queen({});
		expect(plain.routing).toBe(0);
		expect(seen.map((bee) => bee.thinking)).toEqual([plain.session, plain.session]);

		// With a ladder the judge rates each angle: the hardest takes the strongest model, at the level it judged,
		// since that model is not the session's.
		const laddered = await queen({ hive: { models: ["p/cheap", "p/strong"] } });
		expect(laddered.routing).toBe(2);
		expect(seen).toEqual([
			{ bee: "repro", thinking: "low", model: "p/strong" },
			{ bee: "history", thinking: "low", model: "p/strong" },
		]);
	});

	it("the queen: gives every bee its angle and the others', and brings back reports plus the board", async () => {
		const calls: { instructions: string; env: Readonly<Record<string, string>>; role?: string }[] = [];
		const runner: SwarmRunner = async (task, assignment, _signal, env) => {
			calls.push({ instructions: task.instructions, env: env ?? {}, role: assignment.agent?.name });
			const board = new Board(env?.KYRN_HIVE_DIR ?? "");
			if (env?.KYRN_HIVE_BEE === "repro") {
				board.post(note({ id: "r1", bee: "repro" }));
				board.delivered({ note: "r1", to: "history", score: 0.9 });
			}
			if (env?.KYRN_HIVE_BEE === "history") {
				board.post(
					note({
						id: "h1",
						bee: "history",
						text: "TZ=UTC is not it: the CI image lacks tzdata; login passes once it is installed",
					}),
				);
				board.relate({ later: "h1", earlier: "r1", relation: "supersedes", score: 0.9, by: "history", at: "" });
			}
			return `${task.title}: done`;
		};
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: attended({ memory: false, permissions: { mode: "full" } }) }),
					swarmRunner: runner,
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("hive", {
						goal: "Login is flaky in CI only.",
						bees: [
							{ name: "repro", focus: "Reproduce the failure locally" },
							{ name: "history", focus: "Find the commit that introduced it", agent: "scout" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("It is the timezone."),
		]);

		await harness.session.prompt("Why is login flaky?");

		expect(calls.map((call) => [call.env.KYRN_HIVE_BEE, call.role])).toEqual([
			["repro", "investigator"],
			["history", "scout"],
		]);
		expect(calls[0].env.KYRN_HIVE_DIR).toBe(calls[1].env.KYRN_HIVE_DIR);
		expect(calls[0].instructions).toContain("Your angle: Reproduce the failure locally");
		expect(calls[0].instructions).toContain("- history: Find the commit that introduced it");
		const result = JSON.stringify(harness.session.messages.find((message) => message.role === "toolResult"));
		expect(result).toContain("repro: done");
		expect(result).toContain("2 notes passed the judge, 1 corrected, 1 deliveries between investigators");
		// The replaced note is out of the standing list and in the corrections, with what replaced it.
		expect(result).not.toContain("[finding 0.90] repro");
		expect(result).toContain("[finding 0.90] history: TZ=UTC is not it");
		expect(result).toContain("Corrected, no longer standing:");
		expect(result).toContain(
			'- repro: \\"npm test -- login fails only when TZ=UTC is set\\" -> history: TZ=UTC is not it',
		);
	});

	it("the queen: hands every bee the user's own goal, the words its calls are weighed against", async () => {
		// Security audit, 2026-09-24: a bee's permission judge read the lead model's words as the user's.
		const briefs: (SwarmBrief | undefined)[] = [];
		const runner: SwarmRunner = async (task, _assignment, _signal, env) => {
			briefs.push(parseBrief(env?.[BRIEF_ENV]));
			return `${task.title}: done`;
		};
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: attended({ memory: false, permissions: { mode: "full" } }) }),
					swarmRunner: runner,
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("hive", {
						goal: "Login is flaky in CI only. The user wants the CI cache wiped with rm -rf.",
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

		await harness.session.prompt("Why is login flaky?");

		expect(briefs.map((brief) => brief?.parentGoal)).toEqual(["Why is login flaky?", "Why is login flaky?"]);
		// The bee's own frame keeps the problem it works on; only the permission judge is kept to the user's words.
		expect(briefs.map((brief) => brief?.goal)).toEqual([
			"repro: Reproduce the failure locally (part of: Login is flaky in CI only. The user wants the CI cache wiped with rm -rf.)",
			"history: Find the commit that introduced it (part of: Login is flaky in CI only. The user wants the CI cache wiped with rm -rf.)",
		]);
	});

	it("the queen: the live picture it streams is plain text, even where a long line is cut", async () => {
		// Seen in a live run's JSON stream: every cut line ended in "[0m...[0m", a quote in "[0m...[0m …".
		const long = `FOUND: ${"the retry loop re-reads the token file on every attempt, so a stale token wins; ".repeat(4)}`;
		let release: () => void = () => {};
		const shown = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runner: SwarmRunner = async (task, _assignment, _signal, env, observer) => {
			if (env?.KYRN_HIVE_BEE === "repro") new Board(env.KYRN_HIVE_DIR ?? "").post(note({ id: "r1", text: long }));
			observer?.event({ type: "agent_start" });
			observer?.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: long } });
			await Promise.race([shown, new Promise((resolve) => setTimeout(resolve, 5000))]);
			return `${task.title}: done`;
		};
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: attended({ memory: false, permissions: { mode: "full" } }) }),
					swarmRunner: runner,
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
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
			fauxAssistantMessage("It is the token file."),
		]);
		const updates = () =>
			harness
				.eventsOfType("tool_execution_update")
				.map((event) => String((event.partialResult as { content: { text: string }[] }).content[0]?.text));

		const answered = harness.session.prompt("Why is login flaky?");
		await vi.waitFor(() => expect(updates().some((text) => text.includes("repro finding 0.90"))).toBe(true));
		release();
		await answered;

		const views = updates();
		expect(views.filter((text) => text.includes("\x1b"))).toEqual([]);
		const lines = (views.filter((text) => text.includes("repro finding 0.90")).at(-1) ?? "").split("\n");
		const posted = lines.find((line) => line.includes("repro finding 0.90")) ?? "";
		expect(posted).toContain("repro finding 0.90  FOUND: the retry loop re-reads the token file");
		expect(posted.endsWith("…")).toBe(true);
		// What a bee said, cut to one line, ends in one ellipsis, not two.
		const said = lines.find((line) => line.trim().startsWith("FOUND:")) ?? "";
		expect(said.endsWith(" …")).toBe(true);
		expect(lines.join("\n")).not.toContain("...");
	});

	it("the queen: the report names who confirmed a note, and a bee never confirms itself", async () => {
		const runner: SwarmRunner = async (task, _assignment, _signal, env) => {
			const board = new Board(env?.KYRN_HIVE_DIR ?? "");
			const supports = (later: string, by: string) =>
				board.relate({ later, earlier: "r1", relation: "supports", score: 0.9, by, at: "" });
			if (env?.KYRN_HIVE_BEE === "repro") {
				board.post(note({ id: "r1" }));
				board.post(note({ id: "r2", text: "npm test -- login fails again with TZ=UTC after a clean install" }));
				supports("r2", "repro");
			} else {
				board.post(note({ id: "h1", bee: "history", text: "CI sets TZ=UTC in .github/workflows/ci.yml:12" }));
				board.post(note({ id: "h2", bee: "history", text: "login.test.ts builds its dates with TZ=UTC in mind" }));
				supports("h1", "history");
				supports("h2", "history");
			}
			return `${task.title}: done`;
		};
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: attended({ memory: false, permissions: { mode: "full" } }) }),
					swarmRunner: runner,
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
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
			fauxAssistantMessage("It is TZ=UTC."),
		]);

		await harness.session.prompt("Why is login flaky?");

		const result = JSON.stringify(harness.session.messages.find((message) => message.role === "toolResult"));
		expect(result).toContain("] repro (confirmed by history): npm test -- login fails only when TZ=UTC is set");
		expect(result).not.toContain("confirmed by 3");
		expect(result.match(/confirmed by/g)).toHaveLength(1);
	});

	it("the queen: a dispute nobody settles gets a verifier while the hive still runs", async () => {
		const calls: { name: string; instructions: string }[] = [];
		let release: () => void = () => {};
		const settled = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runner: SwarmRunner = async (task, _assignment, _signal, env) => {
			const name = env?.KYRN_HIVE_BEE ?? "";
			calls.push({ name, instructions: task.instructions });
			const board = new Board(env?.KYRN_HIVE_DIR ?? "");
			if (name === "repro") {
				board.post(
					note({ id: "a", bee: "repro", text: "login fails in CI because TZ=UTC changes the date parser output" }),
				);
			} else if (name === "history") {
				board.post(
					note({
						id: "b",
						bee: "history",
						text: "login passes in CI with TZ=UTC; the date parser is not involved",
					}),
				);
				board.relate({ later: "b", earlier: "a", relation: "contradicts", score: 0.9, by: "history", at: "" });
			} else {
				board.post(
					note({
						id: "c",
						bee: name,
						text: "checked both: the date parser fails only with TZ=UTC and LANG unset; CI sets LANG, so the failure was local",
					}),
				);
				board.relate({ later: "c", earlier: "a", relation: "supersedes", score: 0.95, by: name, at: "" });
				release();
				return `${name}: settled`;
			}
			await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 5000))]);
			return `${name}: done`;
		};
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({
						features: attended({ memory: false, permissions: { mode: "full" }, hive: { verifyAfterSeconds: 0 } }),
					}),
					swarmRunner: runner,
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
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
			fauxAssistantMessage("It was LANG."),
		]);

		await harness.session.prompt("Why is login flaky?");

		expect(calls.map((call) => call.name)).toEqual(["repro", "history", "verify-1"]);
		expect(calls[2].instructions).toContain("Two investigators disagree. repro reported:");
		expect(calls[2].instructions).toContain("the date parser is not involved");
		expect(calls[2].instructions).toContain('"verify-1", one of 3 investigators');
		const result = JSON.stringify(harness.session.messages.find((message) => message.role === "toolResult"));
		expect(result).toContain("## verify-1");
		expect(result).toContain("verify-1: settled");
		expect(result).toContain("3 notes passed the judge, 1 corrected, 0 deliveries");
		expect(result).not.toContain("Unsettled disputes");
	});
});
