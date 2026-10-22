import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

describe("ExtensionSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
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
});
