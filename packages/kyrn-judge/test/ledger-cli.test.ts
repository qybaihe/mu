import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BIN } from "./fixtures/launcher.ts";

describe("mu ledger", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	const run = (sessions: string, ...args: string[]) => {
		const result = spawnSync(process.execPath, [join(BIN, "kyrn-ledger"), ...args], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", HOME: sessions, MU_SESSIONS_DIR: sessions },
		});
		return result.stdout;
	};

	it("shows what the user answered when the judge's verdict sent a call to them, and what they marked wrong", () => {
		const sessions = mkdtempSync(join(tmpdir(), "mu-ledger-"));
		dirs.push(sessions);
		mkdirSync(join(sessions, "project"));
		const entry = (customType: string, data: Record<string, unknown>) =>
			JSON.stringify({ type: "custom", customType, data });
		const decision = (id: string, judged: string) =>
			entry("kyrn.decision", {
				id,
				timestamp: "2026-11-04T10:00:00.000Z",
				specId: "tool.approval",
				specVersion: 3,
				mode: "active",
				providerId: "jev",
				outcome: judged,
				judged,
				source: "judge",
			});
		writeFileSync(
			join(sessions, "project", "session.jsonl"),
			[
				JSON.stringify({ type: "message", message: { role: "user", content: "Publish the package" } }),
				decision("d1", "beyond"),
				entry("kyrn.outcome", { kind: "permission", ledgerId: "d1", answer: "once", waitedMs: 900 }),
				decision("d2", "approve"),
				decision("d3", "unrelated"),
				entry("kyrn.outcome", { kind: "permission", ledgerId: "d3", answer: "once", waitedMs: 400 }),
				entry("kyrn.outcome", {
					kind: "mark",
					ledgerId: "d3",
					specId: "tool.approval",
					specVersion: 3,
					judged: "unrelated",
					mark: "wrong",
					note: "publishing is the task",
				}),
			].join("\n"),
		);

		const lines = run(sessions).split("\n");
		expect(lines.find((line) => line.includes('"beyond"'))).toContain('tool.approval: "beyond"  -> you: once');
		expect(lines.find((line) => line.includes('"approve"'))).not.toContain("-> you");
		// A mark does not take the place of the answer.
		expect(lines.find((line) => line.includes('"unrelated"'))).toContain(
			'tool.approval: "unrelated"  -> you: once, marked wrong (publishing is the task)',
		);
		const records = run(sessions, "--json")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: string; userAnswer?: string; userMark?: unknown });
		expect(records.map((record) => [record.id, record.userAnswer, record.userMark])).toEqual([
			["d1", "once", undefined],
			["d2", undefined, undefined],
			["d3", "once", { mark: "wrong", note: "publishing is the task" }],
		]);
	});

	// A verdict that sends the agent back for nothing reads as one: the run that answered it ended without a call.
	it("shows what the agent did with a nudge a verdict sent it", () => {
		const sessions = mkdtempSync(join(tmpdir(), "mu-ledger-"));
		dirs.push(sessions);
		mkdirSync(join(sessions, "project"));
		const entry = (customType: string, data: Record<string, unknown>) =>
			JSON.stringify({ type: "custom", customType, data });
		const nudge = (id: string, specId: string) =>
			entry("kyrn.decision", {
				id,
				timestamp: "2026-11-04T10:00:00.000Z",
				specId,
				specVersion: 2,
				mode: "active",
				providerId: "jev",
				judged: "continue",
				source: "judge",
			});
		const followed = (ledgerId: string, specId: string, how: "acted" | "ended", calls: number) =>
			entry("kyrn.outcome", { kind: "followed", ledgerId, specId, judged: "continue", followed: how, calls });
		writeFileSync(
			join(sessions, "project", "session.jsonl"),
			[
				JSON.stringify({ type: "message", message: { role: "user", content: "Fix the build" } }),
				nudge("n1", "turn.continue"),
				followed("n1", "turn.continue", "acted", 2),
				nudge("n2", "turn.completion"),
				followed("n2", "turn.completion", "ended", 0),
				nudge("n3", "turn.continue"),
			].join("\n"),
		);

		const verdicts = run(sessions)
			.split("\n")
			.filter((text) => text.includes(': "continue"'));
		expect(verdicts).toHaveLength(3);
		expect(verdicts[0]).toContain('turn.continue: "continue"  -> then: acted (2 tool calls)');
		expect(verdicts[1]).toContain('turn.completion: "continue"  -> then: ended without a tool call');
		expect(verdicts[2]).not.toContain("-> then");
		const records = run(sessions, "--json")
			.trim()
			.split("\n")
			.map((text) => JSON.parse(text) as { id: string; followed?: unknown });
		expect(records.map((record) => [record.id, record.followed])).toEqual([
			["n1", { outcome: "acted", calls: 2 }],
			["n2", { outcome: "ended", calls: 0 }],
			["n3", undefined],
		]);
		const timeline = run(sessions, "--timeline").split("\n");
		expect(timeline.find((text) => text.includes("turn.completion"))).toContain("-> then: ended without a tool call");
	});

	it("reads as many sessions as it is told to, wherever the number stands", () => {
		const sessions = mkdtempSync(join(tmpdir(), "mu-ledger-"));
		dirs.push(sessions);
		for (let index = 0; index < 7; index++) {
			writeFileSync(
				join(sessions, `session-${index}.jsonl`),
				JSON.stringify({
					type: "custom",
					customType: "kyrn.decision",
					data: {
						id: `d${index}`,
						specId: "tool.risk",
						specVersion: 1,
						mode: "active",
						judged: { flagged: false },
						usage: { inputTokens: 300_000 },
					},
				}),
			);
		}
		const last = (...args: string[]) =>
			run(sessions, ...args)
				.trim()
				.split("\n")
				.at(-1);
		expect(last()).toBe("5 verdicts from 5 sessions");
		expect(last("7")).toBe("7 verdicts from 7 sessions");
		expect(last("2")).toBe("2 verdicts from 2 sessions");
		expect(run(sessions, "--json", "6").trim().split("\n")).toHaveLength(6);
		const tallied = (...args: string[]) => run(sessions, ...args).split("\n")[0];
		// From a million, tokens are told in millions.
		expect(tallied("--tally")).toBe(
			"Decision points in the 7 most recent sessions: asked 7 times, 2.1M tokens read by the judge",
		);
		const three = "Decision points in the 3 most recent sessions: asked 3 times, 900.0k tokens read by the judge";
		expect(tallied("--tally", "3")).toBe(three);
		expect(tallied("3", "--tally")).toBe(three);
	});

	// What asking a point costs against what comes of it: the numbers a mode is chosen by.
	it("tallies each decision point with --tally: asked, verdicts, how many differed from the fallback, what came next", () => {
		const sessions = mkdtempSync(join(tmpdir(), "mu-ledger-"));
		dirs.push(sessions);
		mkdirSync(join(sessions, "project"));
		const entry = (customType: string, data: Record<string, unknown>) =>
			JSON.stringify({ type: "custom", customType, data });
		let made = 0;
		const record = (specId: string, fields: Record<string, unknown>) =>
			entry("kyrn.decision", {
				id: `r${++made}`,
				timestamp: "2026-11-04T10:00:00.000Z",
				specId,
				specVersion: 1,
				mode: "active",
				providerId: "jev",
				...fields,
			});
		const verdict = (
			specId: string,
			judged: unknown,
			differs: boolean | undefined,
			fields: Record<string, unknown> = {},
		) =>
			record(specId, {
				judged,
				source: differs ? "judge" : "fallback",
				...(differs === undefined ? {} : { differs }),
				latencyMs: 300,
				usage: { inputTokens: 500 },
				...fields,
			});
		const times = <T>(count: number, make: (index: number) => T): T[] =>
			Array.from({ length: count }, (_, index) => make(index));
		writeFileSync(
			join(sessions, "project", "session.jsonl"),
			[
				// Asked with every message, and the judge is too slow for it.
				verdict("skills.disclosure", { hide: ["pdf"], relevant: [] }, true, { id: "first" }),
				verdict("skills.disclosure", { hide: [], relevant: [] }, false),
				...times(8, () =>
					record("skills.disclosure", { source: "fallback", reason: "error:timeout", differs: false }),
				),
				...times(2, () =>
					record("skills.disclosure", { source: "fallback", reason: "abstain", differs: false, latencyMs: 2500 }),
				),
				entry("kyrn.skill-read", {
					name: "pdf",
					path: "/skills/pdf/SKILL.md",
					turn: 3,
					listed: "hidden",
					verdict: "first",
					hid: true,
				}),
				// In shadow, and the judge never says anything else than mu does anyway.
				...times(20, () => verdict("memory.recall", [], false, { mode: "shadow", reason: "shadow" })),
				// A safety check finds nothing in twenty calls: that is what it does until the call it is there for.
				...times(20, () => verdict("tool.risk", { flagged: false }, false)),
				// One record from before the ledger said whether a verdict differed.
				verdict("tool.approval", "beyond", true, { id: "sent" }),
				verdict("tool.approval", "approve", false, { id: "marked" }),
				verdict("tool.approval", "approve", undefined, { source: "judge" }),
				entry("kyrn.outcome", { kind: "permission", ledgerId: "sent", answer: "once", waitedMs: 900 }),
				entry("kyrn.outcome", {
					kind: "mark",
					ledgerId: "marked",
					specId: "tool.approval",
					specVersion: 1,
					mark: "wrong",
				}),
				...times(6, (index) => verdict("turn.continue", "continue", true, { id: `nudge${index}` })),
				...times(6, (index) =>
					entry("kyrn.outcome", {
						kind: "followed",
						ledgerId: `nudge${index}`,
						specId: "turn.continue",
						followed: index < 2 ? "acted" : "ended",
						calls: index < 2 ? 3 : 0,
					}),
				),
				// One output in four chunks, two of them left out, and one of those read back.
				verdict("tool.admission", ["keep", "drop", "drop", "keep"], true, {
					id: "chunks",
					batch: { size: 4, failures: 0, differs: 2 },
					latencyMs: 1200,
					usage: { inputTokens: 2400 },
				}),
				record("tool.admission", {
					judged: [null, null],
					source: "fallback",
					reason: "error:all",
					differs: false,
					batch: { size: 2, failures: 2, differs: 0 },
				}),
				entry("kyrn.outcome", {
					kind: "refetch",
					source: "archive",
					tool: "bash",
					ledgerId: "chunks",
					specId: "tool.admission",
					chars: 800,
				}),
				verdict("context.preload", { files: ["a.ts"] }, true, { id: "opening" }),
				entry("kyrn.outcome", {
					kind: "preload",
					ledgerId: "opening",
					specId: "context.preload",
					predicted: 4,
					given: 4,
					read: 2,
					hits: 1,
				}),
			].join("\n"),
		);

		const squashed = run(sessions, "--tally")
			.split("\n")
			.map((line) => line.replace(/\s+/g, " ").trim());
		expect(squashed[0]).toBe(
			"Decision points in the 1 most recent session: asked 64 times, 28.4k tokens read by the judge",
		);
		expect(squashed.slice(2, 4)).toEqual([
			"point mode asked verdicts differed median tokens",
			"memory.recall shadow 20 20 0/20 300ms 10.0k",
		]);
		expect(squashed).toContain("tool.risk active 20 20 0/20 300ms 10.0k");
		expect(squashed).toContain("skills.disclosure active 12 2 1/2 300ms 1.0k");
		expect(squashed).toContain("no verdict 10: 8 timeout, 2 abstain");
		expect(squashed).toContain("then: 1 hidden skill read");
		// Two of the three verdicts say whether they differed: the oldest record does not.
		expect(squashed).toContain("tool.approval active 3 3 1/2 300ms 1.5k");
		expect(squashed).toContain("then: sent to you 1 (1 allowed, 0 denied), 1 marked wrong");
		expect(squashed).toContain("turn.continue active 6 6 6/6 300ms 3.0k");
		expect(squashed).toContain("then: 4 of 6 nudges ended without a tool call");
		expect(squashed).toContain("tool.admission active 2 1 1/1 1.2s 2.4k");
		expect(squashed).toContain("no verdict 1: 1 failed");
		expect(squashed).toContain("then: 1 left-out part read back");
		expect(squashed).toContain("then: 1 of 4 forecast files used");
		// Each point that is worth a look comes with the rule that says so.
		const look = squashed.slice(squashed.indexOf("Worth a look") + 1).filter((line) => line.includes(": "));
		expect(look).toEqual([
			"memory.recall: 20 verdicts, none of them different from what mu does with no judge: asking it changed nothing.",
			"skills.disclosure: no verdict 10 of 12 times (8 timeout, 2 abstain): mu waited for the judge and went on as with none.",
			"turn.continue: 4 of 6 nudges ended again without a tool call: the agent was sent back for nothing.",
		]);

		const points = run(sessions, "--tally", "--json")
			.trim()
			.split("\n")
			.map((text) => JSON.parse(text) as { specId: string; [key: string]: unknown });
		expect(points.map((point) => point.specId)).toEqual([
			"memory.recall",
			"tool.risk",
			"skills.disclosure",
			"turn.continue",
			"tool.approval",
			"tool.admission",
			"context.preload",
		]);
		expect(points.find((point) => point.specId === "tool.approval")).toMatchObject({
			modes: ["active"],
			asked: 3,
			verdicts: 3,
			saidWhether: 2,
			differed: 1,
			actedOn: 1,
			medianLatencyMs: 300,
			inputTokens: 1500,
			noVerdict: {},
			after: { sentToYou: 1, allowed: 1, denied: 0, markedWrong: 1 },
			look: [],
		});
		// In shadow a verdict that differs is acted on by nobody.
		expect(points.find((point) => point.specId === "memory.recall")).toMatchObject({
			modes: ["shadow"],
			differed: 0,
			actedOn: 0,
		});
		// No verdict of these came late and no request stood in a line: the tally says nothing of either.
		expect(squashed.filter((line) => line.startsWith("late") || line.startsWith("in line"))).toEqual([]);
		const empty = mkdtempSync(join(tmpdir(), "mu-ledger-"));
		dirs.push(empty);
		expect(run(empty, "--tally")).toContain("No verdicts found under");
	});

	// A verdict that comes after its wait cost the whole wait: the turn went on without it.
	it("tallies the verdicts that came after mu stopped waiting, and the requests that stood in a judge's line", () => {
		const sessions = mkdtempSync(join(tmpdir(), "mu-ledger-"));
		dirs.push(sessions);
		const record = (specId: string, index: number, fields: Record<string, unknown>) =>
			JSON.stringify({
				type: "custom",
				customType: "kyrn.decision",
				data: { id: `${specId}-${index}`, specId, specVersion: 1, mode: "active", providerId: "mude", ...fields },
			});
		const verdict = (specId: string, index: number, fields: Record<string, unknown>) =>
			record(specId, index, {
				judged: { goal: "ship" },
				source: "judge",
				differs: true,
				latencyMs: 3400,
				usage: { inputTokens: 430 },
				...fields,
			});
		const times = <T>(count: number, make: (index: number) => T): T[] =>
			Array.from({ length: count }, (_, index) => make(index));
		writeFileSync(
			join(sessions, "session.jsonl"),
			[
				// Seven of twelve came after the wait, each behind another request at the judge.
				...times(7, (index) => verdict("task.frame", index, { late: true, queuedMs: index < 5 ? 2200 : 900 })),
				...times(5, (index) => verdict("task.frame", 7 + index, { latencyMs: 600 })),
				// Too few verdicts to say anything of the point.
				...times(3, (index) => verdict("input.interjection", index, { late: true })),
				verdict("input.interjection", 3, { latencyMs: 300, queuedMs: 40 }),
				// A late answer that was not sure enough is no verdict, so no late one either.
				record("input.interjection", 4, { source: "fallback", reason: "abstain", differs: false, late: true }),
			].join("\n"),
		);

		const squashed = run(sessions, "--tally")
			.split("\n")
			.map((line) => line.replace(/\s+/g, " ").trim());
		const from = (row: string) => squashed.slice(squashed.indexOf(row), squashed.indexOf(row) + 4);
		expect(from("task.frame active 12 12 12/12 3.4s 5.2k")).toEqual([
			"task.frame active 12 12 12/12 3.4s 5.2k",
			"late 7 of 12 verdicts",
			"in line 7 times, median wait 2.2s",
			"input.interjection active 5 4 4/4 3.4s 1.7k",
		]);
		expect(from("input.interjection active 5 4 4/4 3.4s 1.7k").slice(1)).toEqual([
			"no verdict 1: 1 abstain",
			"late 3 of 4 verdicts",
			"in line 1 time, median wait 40ms",
		]);
		expect(squashed).toContain("late: verdicts that came after mu had stopped waiting for them.");
		expect(squashed).toContain(
			"in line: times the request waited its turn at a judge that answers only a few at a time (`concurrency` in",
		);
		const look = squashed.slice(squashed.indexOf("Worth a look") + 1).filter((line) => line.includes(": "));
		expect(look).toEqual([
			"task.frame: 7 of 12 verdicts came after mu had stopped waiting for them: it waited the whole time and went on without.",
		]);

		const points = run(sessions, "--tally", "--json")
			.trim()
			.split("\n")
			.map((text) => JSON.parse(text) as { specId: string; [key: string]: unknown });
		expect(points).toMatchObject([
			{ specId: "task.frame", verdicts: 12, late: 7, inLine: 7, medianInLineMs: 2200 },
			{ specId: "input.interjection", verdicts: 4, late: 3, inLine: 1, medianInLineMs: 40, look: [] },
		]);
	});

	it("shows one session step by step with --timeline: messages, replies, verdicts, tool results, mu's messages", () => {
		const sessions = mkdtempSync(join(tmpdir(), "mu-ledger-"));
		dirs.push(sessions);
		mkdirSync(join(sessions, "project"));
		const at = (second: number) => new Date(Date.UTC(2026, 10, 4, 10, 0, second)).toISOString();
		const line = (value: Record<string, unknown>) => JSON.stringify(value);
		const message = (second: number, body: Record<string, unknown>) =>
			line({ type: "message", timestamp: at(second), message: body });
		writeFileSync(
			join(sessions, "project", "2026-11-04T10-00-00_one.jsonl"),
			[
				line({ type: "session", timestamp: at(0) }),
				message(0, { role: "user", content: "Run the tests and fix what fails." }),
				message(3, {
					role: "assistant",
					model: "big-model",
					durationMs: 2400,
					usage: { totalTokens: 1250 },
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
				}),
				line({
					type: "custom",
					customType: "kyrn.decision",
					timestamp: at(3),
					data: {
						id: "d1",
						timestamp: at(3),
						specId: "tool.approval",
						mode: "active",
						judged: "approve",
						source: "judge",
						latencyMs: 310,
					},
				}),
				line({
					type: "custom",
					customType: "kyrn.outcome",
					data: { kind: "mark", ledgerId: "d1", mark: "wrong", note: "it ran the slow suite" },
				}),
				message(75, { role: "toolResult", toolCallId: "c1", toolName: "bash", durationMs: 71_500, isError: true }),
				line({
					type: "custom_message",
					customType: "kyrn.nudge",
					timestamp: at(76),
					content: "You edited a file and nothing has run since.",
					display: false,
				}),
				message(80, {
					role: "assistant",
					model: "big-model",
					durationMs: 900,
					stopReason: "stop",
					content: [{ type: "text", text: "Two tests fail." }],
				}),
			].join("\n"),
		);
		writeFileSync(
			join(sessions, "project", "2026-11-03T09-00-00_older.jsonl"),
			message(0, { role: "user", content: "older" }),
		);

		const lines = run(sessions, "--timeline", "--session", "_one").split("\n");
		expect(lines.slice(1, 8)).toEqual([
			'00:00  you    "Run the tests and fix what fails."',
			"00:03  model  big-model  2.4s  1250 tokens  -> bash",
			'00:03  judge  tool.approval "approve"  310ms  -> you: marked wrong (it ran the slow suite)',
			"01:15  tool   bash npm test  71.5s  FAILED",
			'01:16  mu     kyrn.nudge "You edited a file and nothing has run since."  (to the model only)',
			'01:20  model  big-model  900ms  "Two tests fail."',
			"",
		]);
		expect(lines.at(-2)).toBe("2 model replies, 1 tool result, 1 verdict");
		const steps = run(sessions, "--timeline", "--json", "--session", "_one")
			.trim()
			.split("\n")
			.map((text) => JSON.parse(text) as { at: number; lane: string; durationMs?: number; userMark?: unknown });
		expect(steps.map((step) => [step.at, step.lane])).toEqual([
			[0, "you"],
			[3000, "model"],
			[3000, "judge"],
			[75_000, "tool"],
			[76_000, "mu"],
			[80_000, "model"],
		]);
		expect(steps[2].userMark).toEqual({ mark: "wrong", note: "it ran the slow suite" });
		expect(run(sessions, "--timeline", "--session", "nothing-like-it")).toContain(
			"No session matches nothing-like-it",
		);
	});
});
