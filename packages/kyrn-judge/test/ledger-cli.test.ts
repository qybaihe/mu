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

	it("shows what the user answered when the judge's verdict sent a call to them", () => {
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
			].join("\n"),
		);

		const lines = run(sessions).split("\n");
		expect(lines.find((line) => line.includes('"beyond"'))).toContain('tool.approval: "beyond"  -> you: once');
		expect(lines.find((line) => line.includes('"approve"'))).not.toContain("-> you");
		const records = run(sessions, "--json")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: string; userAnswer?: string });
		expect(records.map((record) => [record.id, record.userAnswer])).toEqual([
			["d1", "once"],
			["d2", undefined],
		]);
	});
});
