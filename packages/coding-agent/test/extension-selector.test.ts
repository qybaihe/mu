import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const plain = (lines: string[]) => lines.map((line) => stripAnsi(line).trimEnd());

function render(selector: ExtensionSelectorComponent): string {
	return stripAnsi(selector.render(80).join("\n"));
}

function visibleOptions(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.includes("option-"))
		.map((line) => line.trim().replace(/^→ /, ""));
}

describe("extension selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("the cursor starts on initialIndex, and Enter picks that option", () => {
		const onSelect = vi.fn();
		const selector = new ExtensionSelectorComponent("Mode", ["Full", "Judge", "Ask"], onSelect, vi.fn(), {
			initialIndex: 1,
		});
		expect(plain(selector.render(60))).toContain(" → Judge");
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith("Judge");
	});

	test("an initialIndex outside the options starts on the first", () => {
		const onSelect = vi.fn();
		const selector = new ExtensionSelectorComponent("Mode", ["Full", "Judge"], onSelect, vi.fn(), {
			initialIndex: 5,
		});
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith("Full");
	});

	test("a long option continues under its text, not under the marker", () => {
		const long = "Judge mode — reads and edits inside the project go ahead, and the judge decides on the rest";
		const selector = new ExtensionSelectorComponent("Mode", ["Full", long], vi.fn(), vi.fn());
		const lines = plain(selector.render(40));
		const first = lines.findIndex((line) => line.startsWith("   Judge mode"));
		expect(first).toBeGreaterThan(-1);
		expect(lines[first + 1]).toMatch(/^ {3}\S/);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	// #6688: long extension selectors must keep the selected option visible.
	it("windows long option lists around the selection", () => {
		const options = Array.from({ length: 15 }, (_, index) => `option-${index + 1}`);
		const selector = new ExtensionSelectorComponent(
			"Choose",
			options,
			() => {},
			() => {},
		);

		let output = render(selector);
		expect(visibleOptions(output)).toEqual(options.slice(0, 10));
		expect(output).toContain("→ option-1");
		expect(output).toContain("  (1/15)");

		for (let i = 0; i < 7; i++) selector.handleInput("\x1b[B");
		output = render(selector);
		expect(visibleOptions(output)).toEqual(options.slice(2, 12));
		expect(output).toContain("→ option-8");
		expect(output).toContain("  (8/15)");

		for (let i = 0; i < 7; i++) selector.handleInput("\x1b[B");
		output = render(selector);
		expect(visibleOptions(output)).toEqual(options.slice(5, 15));
		expect(output).toContain("→ option-15");
		expect(output).toContain("  (15/15)");
	});

	it("renders short and empty option lists without a scroll indicator", () => {
		const shortOptions = ["option-1", "option-2", "option-3"];
		const shortOutput = render(
			new ExtensionSelectorComponent(
				"Choose",
				shortOptions,
				() => {},
				() => {},
			),
		);
		expect(visibleOptions(shortOutput)).toEqual(shortOptions);
		expect(shortOutput).toContain("→ option-1");
		expect(shortOutput).not.toContain("(1/3)");

		const emptyOutput = render(
			new ExtensionSelectorComponent(
				"Choose",
				[],
				() => {},
				() => {},
			),
		);
		expect(emptyOutput).toContain("Choose");
		expect(emptyOutput).toContain("↑↓ navigate");
		expect(emptyOutput).not.toContain("→");
	});
});
