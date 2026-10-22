import { describe, expect, it } from "vitest";
import { renderHelpEn } from "../src/extension/features/commands.ts";

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
