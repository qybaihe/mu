import { describe, expect, it } from "vitest";
import { renderDoctor, renderHelpEn } from "../src/extension/features/commands.ts";
import { modelRef } from "../src/extension/features/welcome.ts";

const sections = [
	{
		title: "Judgment kernel",
		intro: "The judge reads every message first. While it reads, your message waits above the editor.",
		rows: [
			["/frame", "show the current task: the goal, your constraints with their source and the checklist"],
			["/mu mode <point|default> <off|shadow|active>", ""],
			["", "off; shadow (asked and logged, changes nothing); active (the verdict takes effect)"],
			["/implement-and-review <task>", "implement, review, fix, then review the fix again until it holds up"],
		],
	},
] as const;

describe("the English /help", () => {
	it("wraps each description under itself at the terminal's width, never under the command", () => {
		const lines = renderHelpEn(
			"mu 0.1 · head",
			sections,
			"While typing: ! runs a shell command · @ attaches a file",
			60,
		).split("\n");
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
		const frame = lines.findIndex((line) => line.startsWith("  /frame"));
		expect(lines[frame]).toBe(`  /frame${" ".repeat(27 - 8)}show the current task: the goal,`);
		// The description continues in its own column.
		expect(lines[frame + 1]).toMatch(/^ {27}\S/);
		// A command wider than the column: its description follows it, and continues in the column.
		const long = lines.findIndex((line) => line.startsWith("  /implement-and-review <task>   implement"));
		expect(long).toBeGreaterThan(-1);
		expect(lines[long + 1]).toMatch(/^ {27}\S/);
		// A command with nothing beside it, then a row that only continues it.
		expect(lines).toContain("  /mu mode <point|default> <off|shadow|active>");
		expect(lines.some((line) => /^ {27}off; shadow/.test(line))).toBe(true);
		// The intro wraps with the section's indent.
		expect(lines.filter((line) => line.startsWith("  The judge") || /^ {2}[a-z]/.test(line)).length).toBeGreaterThan(
			1,
		);
	});

	it("without a terminal, each row is one line", () => {
		const lines = renderHelpEn("head", sections, "foot").split("\n");
		expect(lines).toContain(
			`  /frame${" ".repeat(27 - 8)}show the current task: the goal, your constraints with their source and the checklist`,
		);
		expect(lines).toContain(
			"  The judge reads every message first. While it reads, your message waits above the editor.",
		);
	});
});

describe("the model in /status and the welcome", () => {
	it("is provider/id, and none for pi's placeholder when there is no model at all", () => {
		expect(modelRef({ provider: "openai", id: "gpt-5.5" })).toBe("openai/gpt-5.5");
		expect(modelRef({ provider: "unknown", id: "unknown" })).toBeUndefined();
		expect(modelRef(undefined)).toBeUndefined();
	});
});

describe("/doctor in a terminal", () => {
	const rows = [
		["FIX ", "model", "none yet: run /login, then /model"],
		["ok  ", "judge", "classifier:opencode/jev-1.13-free answers in 175 ms"],
		[
			"--  ",
			"browse",
			"driven by the judge. It needs a judge that can match a goal to a page (Jev or an LLM judge), e.g. /mu route browser.step llm:openai/gpt-5.6-luna",
		],
	] as const;

	it("says first how many rows need fixing, so pi's Warning: reads as a sentence", () => {
		expect(renderDoctor(rows).split("\n")[0]).toBe("mu doctor found 1 thing to fix");
		expect(renderDoctor([["ok  ", "judge", "fine"]]).split("\n")[0]).toBe("mu doctor: everything is set up");
	});

	it("wraps a long row under its own text", () => {
		const lines = renderDoctor(rows, 60).split("\n");
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
		const browse = lines.findIndex((line) => line.startsWith("--  browse     driven by"));
		expect(lines[browse + 1]).toMatch(/^ {15}\S/);
	});
});
