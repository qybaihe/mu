import { describe, expect, it } from "vitest";
import { canNameProcess } from "../src/cli/setup.ts";

describe("canNameProcess", () => {
	it("names the process under plain Node on every platform", () => {
		for (const platform of ["darwin", "linux", "win32"] as const) {
			expect(canNameProcess(platform, undefined)).toBe(true);
		}
	});

	it("leaves an Electron binary running as Node on macOS unnamed, so it never gets a Dock icon", () => {
		expect(canNameProcess("darwin", "37.2.0")).toBe(false);
	});

	it("names an Electron binary running as Node elsewhere", () => {
		expect(canNameProcess("win32", "37.2.0")).toBe(true);
		expect(canNameProcess("linux", "37.2.0")).toBe(true);
	});
});
