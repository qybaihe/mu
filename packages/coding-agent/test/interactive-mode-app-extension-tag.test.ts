import { afterEach, describe, expect, test } from "vitest";
import { isAppExtension } from "../src/config.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const tagOf = (path: string) =>
	(InteractiveMode as any).prototype.getAutocompleteSourceTag.call(
		{},
		{ path, source: "cli", scope: "temporary", origin: "top-level" },
	);

describe("the app's own extensions in autocomplete", () => {
	const saved = process.env.PI_APP_EXTENSIONS;
	afterEach(() => {
		if (saved === undefined) delete process.env.PI_APP_EXTENSIONS;
		else process.env.PI_APP_EXTENSIONS = saved;
	});

	test("an extension loaded with -e is tagged [t], unless the launcher names it as the app's own", () => {
		delete process.env.PI_APP_EXTENSIONS;
		expect(tagOf("/opt/mu/judge/mu/index.js")).toBe("t");

		process.env.PI_APP_EXTENSIONS = "/opt/mu/judge/mu/index.js";
		expect(tagOf("/opt/mu/judge/mu/index.js")).toBeUndefined();
		// Another extension given with -e keeps its tag.
		expect(tagOf("/home/me/my-extension.ts")).toBe("t");
	});

	test("PI_APP_EXTENSIONS is a list, compared as resolved paths", () => {
		process.env.PI_APP_EXTENSIONS = ["", "/opt/mu/judge/mu/index.js", "/opt/other.ts"].join(
			process.platform === "win32" ? ";" : ":",
		);
		expect(isAppExtension("/opt/mu/judge/mu/../mu/index.js")).toBe(true);
		expect(isAppExtension("/opt/other.ts")).toBe(true);
		expect(isAppExtension("/opt/elsewhere.ts")).toBe(false);
	});
});
