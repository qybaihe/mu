import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

// Under another name than pi, as mu runs it (kyrn/bin/mu.mjs gives the package piConfig.name "mu").
vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/config.ts")>()),
	APP_NAME: "mu",
}));

const { SettingsManager } = await import("../src/core/settings-manager.ts");

describe("quietStartup under mu's name", () => {
	const dirs: string[] = [];
	const settingsIn = (settings?: Record<string, unknown>) => {
		const dir = mkdtempSync(join(tmpdir(), "mu-quiet-"));
		dirs.push(dir);
		if (settings) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		return SettingsManager.create(dir, dir);
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("keeps only the header by default: mu's welcome, without pi's listing of loaded resources", () => {
		expect(settingsIn().getQuietStartup()).toBe("header");
	});

	test("a setting of its own holds, false included", () => {
		expect(settingsIn({ quietStartup: false }).getQuietStartup()).toBe(false);
		expect(settingsIn({ quietStartup: true }).getQuietStartup()).toBe(true);
	});
});
