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
