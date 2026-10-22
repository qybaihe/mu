import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { DecisionEngine, defineDecision } from "../src/decision.ts";
import {
	judgeDisplayName,
	type Paint,
	readVersions,
	renderWelcome,
	VERSIONS,
	type WelcomeView,
} from "../src/extension/features/welcome.ts";
import { Judge } from "../src/judge.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { threeZone } from "../src/policy.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

const plain: Paint = { fg: (_color, text) => text, bold: (text) => text };

const view: WelcomeView = {
	version: "0.1.0",
	piVersion: "0.86.0",
	judge: "laya",
	health: { ok: true, latencyMs: 95 },
	mode: "active",
	model: "openai-codex/gpt-5.6-sol",
	thinking: "medium",
	cwd: "/work/项目/app",
	expanded: false,
	keys: { expand: "ctrl+o", model: "ctrl+l", thinking: "shift+tab" },
};

describe("welcome screen", () => {
	it("says who is judging, how fast, and which model is thinking", () => {
		const text = renderWelcome(view, 100, plain).join("\n");

		expect(text).toContain("judgment-first coding agent");
		expect(text).toContain("Laya · answering in 95 ms · decision points active");
		expect(text).toContain("openai-codex/gpt-5.6-sol · thinking medium");
		expect(text).toContain("/help");
		expect(text).not.toContain("What the judge does here");
		expect(renderWelcome({ ...view, expanded: true }, 100, plain).join("\n")).toContain("What the judge does here");
	});

	it("names judges as people say them: the free Jev with its version, a cascade in order", () => {
		expect(judgeDisplayName("jev")).toBe("Jev");
		expect(judgeDisplayName("jev-1.13-free")).toBe("Jev 1.13 (free)");
		expect(judgeDisplayName("jev-latest")).toBe("Jev");
		expect(judgeDisplayName("jev-1.13")).toBe("Jev 1.13");
		expect(judgeDisplayName("laya>jev")).toBe("Laya, Jev");
		expect(judgeDisplayName("laya,jev")).toBe("Laya, Jev");
		expect(judgeDisplayName("clef-flash")).toBe("clef-flash");
	});

	it("never renders a line wider than the terminal, with wide characters", () => {
		for (const width of [20, 43, 44, 60, 78, 79, 140]) {
			for (const line of renderWelcome({ ...view, expanded: true }, width, plain)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		// No frame: the header ends on a hairline as wide as the screen allows, never a box.
		const lines = renderWelcome(view, 60, plain);
		expect(lines.some((line) => /[│╭╰]/.test(line))).toBe(false);
		expect(lines.at(-2)).toBe(`  ${"─".repeat(58)}`);
	});

	it("tells the truth when the judge is down, off, or no model is logged in", () => {
		const down = renderWelcome({ ...view, health: { ok: false, latencyMs: 4000, error: "unreachable" } }, 100, plain);
		const keyless = renderWelcome({ ...view, health: { ok: false, latencyMs: 0, error: "auth" } }, 100, plain);
		const broken = renderWelcome({ ...view, health: { ok: false, latencyMs: 90, error: "server" } }, 100, plain);
		const off = renderWelcome({ ...view, judge: "off" }, 100, plain);
		const fresh = renderWelcome({ ...view, model: undefined, health: "checking" }, 100, plain);

		expect(down.join("\n")).toContain("unreachable; using the fallbacks");
		expect(keyless.join("\n")).toContain("no usable key (run mu setup); using the fallbacks");
		expect(broken.join("\n")).toContain("failing (server); using the fallbacks");
		expect(off.join("\n")).toContain("off · every decision point uses its fallback");
		expect(fresh.join("\n")).toContain("none yet · run /login, or mu setup in a terminal");
		expect(fresh.join("\n")).toContain("checking");
	});

	// mu 0.1.3 from npm greeted with "v0.1.0 · built on pi 0.1.3": the judgment layer's own version, and pi's
	// VERSION, which pi reads from the folder the launcher points it at, mu-agent's.
	it("shows mu's version and pi's, from the npm package and from a source checkout", () => {
		const pkg = mkdtempSync(join(tmpdir(), "mu-versions-"));
		try {
			writeFileSync(
				join(pkg, "package.json"),
				JSON.stringify({ name: "mu-agent", version: "0.1.4", muBuild: { pi: "0.86.0", judge: "0.1.0" } }),
			);
			mkdirSync(join(pkg, "judge", "dist"), { recursive: true });
			writeFileSync(join(pkg, "judge", "package.json"), JSON.stringify({ name: "@kyrn/judge", version: "0.1.0" }));
			// Where the bundled welcome.ts looks from: the build rewrites import.meta.url to its source's place in judge/.
			const bundle = pathToFileURL(join(pkg, "judge", "mu", "index.js")).href;
			const source = new URL("src/extension/features/welcome.ts", new URL("../", bundle));
			// pi's own VERSION in the package is mu's: it must not be taken for pi's.
			expect(readVersions(new URL("../../../", source), "0.1.4")).toEqual({ mu: "0.1.4", pi: "0.86.0" });
		} finally {
			rmSync(pkg, { recursive: true, force: true });
		}

		const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
		const versionOf = (path: string) =>
			(JSON.parse(readFileSync(join(repo, path), "utf8")) as { version: string }).version;
		expect(VERSIONS).toEqual({
			mu: versionOf("kyrn/npm/package.template.json"),
			pi: versionOf("packages/coding-agent/package.json"),
		});
		const header = renderWelcome({ ...view, version: "0.1.4", piVersion: "0.86.0" }, 100, plain).join("\n");
		expect(header).toContain("mu  v0.1.4");
		expect(header).toContain("built on pi 0.86.0");
	});
});

describe("per-decision judges", () => {
	const spec = (id: string) =>
		defineDecision({
			id,
			version: 1,
			cacheImpact: "none",
			latency: "inline",
			questions: { yes: { type: "boolean", instructions: "Is `text` a greeting?" } },
			buildState: (input: { text: string }) => ({ text: input.text }),
			policy: (answers) => threeZone(answers.yes),
			fallback: () => "unsure" as const,
		});

	it("reads routes from the config, as lists or comma strings", () => {
		const config = parseConfig({
			tiers: ["laya"],
			routes: { "browser.step": ["luna"], "turn.drift": "laya, jev", bad: [] },
		});

		expect(config.routes).toEqual({ "browser.step": ["luna"], "turn.drift": ["laya", "jev"] });
		expect(parseConfig({}).routes).toEqual({});
	});

	it("answers a routed decision with its own judge and records which one answered", async () => {
		const shared = new MockJudgeProvider(() => ({ yes: { type: "boolean", probability: 0.05 } }), "small");
		const capable = new MockJudgeProvider(() => ({ yes: { type: "boolean", probability: 0.95 } }), "capable");
		const ledger = new MemoryLedger();
		const engine = new DecisionEngine({ judge: new Judge({ provider: shared }), defaultMode: "active", ledger });
		engine.setJudgeFor("browser.step", new Judge({ provider: capable }));

		const routed = await engine.decide(spec("browser.step"), { text: "hi" });
		const usual = await engine.decide(spec("input.preflight"), { text: "hi" });

		expect([routed.outcome, usual.outcome]).toEqual(["yes", "no"]);
		expect(capable.calls).toHaveLength(1);
		expect(shared.calls).toHaveLength(1);
		expect(ledger.records.map((record) => record.providerId)).toEqual(["capable", "small"]);

		engine.setJudgeFor("browser.step", undefined);
		expect((await engine.decide(spec("browser.step"), { text: "hi" })).outcome).toBe("no");
	});

	it("probes the shared judge without counting it as a decision", async () => {
		const ledger = new MemoryLedger();
		const engine = new DecisionEngine({ judge: new Judge({ provider: new MockJudgeProvider() }), ledger });

		expect((await engine.probe()).ok).toBe(true);
		expect(engine.stats.calls).toBe(0);
		expect(ledger.records).toHaveLength(0);
	});
});
