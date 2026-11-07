import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findChrome } from "../src/browser/chrome.ts";
import { loadConfig } from "../src/config.ts";
import { VERDICT_ENTRY } from "../src/extension/features/preflight-view.ts";
import { PRESENTATION_STATUS_KEY } from "../src/extension/presentation.ts";
import { LEDGER_ENTRY_TYPE } from "../src/extension/runtime.ts";
import { muEnv, muHome } from "../src/naming.ts";
import { HIVE_MESSAGE, SWARM_MESSAGE } from "../src/swarm/markers.ts";

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "mu-naming-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("the rename from KYRN to mu", () => {
	it("reads a setting under its new name first and under its old name still", () => {
		expect(muEnv("JUDGE", { MU_JUDGE: "clm", KYRN_JUDGE: "jev" })).toBe("clm");
		expect(muEnv("JUDGE", { KYRN_JUDGE: "jev" })).toBe("jev");
		expect(muEnv("JUDGE", { MU_JUDGE: "", KYRN_JUDGE: "jev" })).toBe("jev");
		expect(muEnv("JUDGE", {})).toBeUndefined();
	});

	it("applies the judge, mode and writer overrides under either spelling", () => {
		const current = loadConfig({ env: { MU_JUDGE: "clm,gateway", MU_JUDGE_MODE: "active", MU_WRITER: "p/m" } });
		expect(current.config).toMatchObject({ tiers: ["clm", "jev"], modes: { default: "active" }, writer: "p/m" });

		const legacy = loadConfig({ env: { KYRN_JUDGE: "clm", KYRN_JUDGE_MODE: "off", KYRN_WRITER: "p/old" } });
		expect(legacy.config).toMatchObject({ tiers: ["clm"], modes: { default: "off" }, writer: "p/old" });

		expect(loadConfig({ env: { KYRN_JUDGE: "off" } }).disabled).toBe(true);
		expect(loadConfig({ env: { MU_JUDGE: "clm", KYRN_JUDGE: "off" } }).disabled).toBe(false);
	});

	it("reads mu.json, and kyrn.json only when there is no mu.json", () => {
		const dir = temp();
		writeFileSync(join(dir, "kyrn.json"), JSON.stringify({ tiers: ["old"] }));
		expect(loadConfig({ dir, env: {} }).config.tiers).toEqual(["old"]);

		writeFileSync(join(dir, "mu.json"), JSON.stringify({ tiers: ["new"] }));
		expect(loadConfig({ dir, env: {} }).config.tiers).toEqual(["new"]);
		expect(loadConfig({ dir: temp(), env: {} })).toMatchObject({ config: { tiers: ["jev"] }, disabled: false });
	});

	it("reports a broken mu.json instead of quietly bringing the old settings back", () => {
		const dir = temp();
		writeFileSync(join(dir, "kyrn.json"), JSON.stringify({ tiers: ["old"] }));
		writeFileSync(join(dir, "mu.json"), "{ not json");

		const loaded = loadConfig({ dir, env: {} });

		expect(loaded.problem).toMatch(/^mu\.json could not be read/);
		expect(loaded.config.tiers).toEqual(["jev"]);
	});

	it("keeps the old home until it has been moved, and never invents a second one beside it", () => {
		const fresh = temp();
		expect(muHome(fresh)).toBe(join(fresh, ".mu"));

		const before = temp();
		mkdirSync(join(before, ".kyrn"));
		expect(muHome(before)).toBe(join(before, ".kyrn"));

		// After `mv ~/.kyrn ~/.mu`, with or without a compatibility link left at the old path.
		const after = temp();
		mkdirSync(join(after, ".mu"));
		mkdirSync(join(after, ".kyrn"));
		expect(muHome(after)).toBe(join(after, ".mu"));
	});

	it("finds the browser named by MU_CHROME or, as before, KYRN_CHROME", () => {
		const chrome = join(temp(), "chrome");
		writeFileSync(chrome, "");
		expect(findChrome({ MU_CHROME: chrome })).toBe(chrome);
		expect(findChrome({ KYRN_CHROME: chrome })).toBe(chrome);
	});

	it("leaves every name that is already stored in sessions and desktop event logs as it was", () => {
		// Renaming any of these orphans history: compaction would quote them as user text, forgetting would
		// not restore, verdict lines would not render, and the desktop would drop the events without an error.
		expect({ LEDGER_ENTRY_TYPE, VERDICT_ENTRY, PRESENTATION_STATUS_KEY, HIVE_MESSAGE, SWARM_MESSAGE }).toEqual({
			LEDGER_ENTRY_TYPE: "kyrn.decision",
			VERDICT_ENTRY: "kyrn.verdict",
			PRESENTATION_STATUS_KEY: "kyrn.presentation.v1",
			HIVE_MESSAGE: "kyrn.hive",
			SWARM_MESSAGE: "kyrn.swarm",
		});
	});
});
