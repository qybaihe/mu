import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { layaNotice, registerLayaNotice } from "../src/extension/features/laya.ts";
import type { KyrnRuntime } from "../src/extension/runtime.ts";
import { migrateConfigText, mudeReady } from "../src/laya-migration.ts";
import type { MudeFile } from "../src/mude/manifest.ts";
import { mudePaths } from "../src/mude/paths.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for mude 1.0's 1.8 GB package: one small file, checked as an install checks it. */
const FILES: readonly MudeFile[] = [{ path: "weights.bin", size: 4, sha256: "a".repeat(64) }];

/** One machine: mu's home with its agent folder and mu.json, and mude 1.0 set up there or not. */
function machine(config: string | undefined, options: { mude?: boolean; file?: string } = {}) {
	const home = mkdtempSync(join(tmpdir(), "mu-laya-"));
	dirs.push(home);
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });
	const file = join(agentDir, options.file ?? "mu.json");
	if (config !== undefined) writeFileSync(file, config);
	if (options.mude) {
		const paths = mudePaths(home);
		mkdirSync(join(paths.venv, "bin"), { recursive: true });
		writeFileSync(paths.python, "");
		mkdirSync(paths.model, { recursive: true });
		writeFileSync(join(paths.model, "weights.bin"), "1234");
		const { mtimeMs } = statSync(join(paths.model, "weights.bin"));
		writeFileSync(
			join(paths.model, ".mu-verified.json"),
			JSON.stringify({ "weights.bin": { size: 4, mtimeMs, sha256: "a".repeat(64) } }),
		);
	}
	const env: Record<string, string> = options.mude ? { MU_JUDGE_MUDE_KEY: "fixture-mude-key" } : {};
	return { home, agentDir, env, read: () => readFileSync(file, "utf8") };
}

type Machine = ReturnType<typeof machine>;

/** A session starting as kyrn-judge.ts starts one: the configuration read, then the notice at session_start. */
function start(at: Machine, options: { env?: Record<string, string>; hasUI?: boolean } = {}) {
	const env = { ...at.env, ...options.env };
	const loaded = loadConfig({
		dir: at.agentDir,
		env,
		replaceLaya: () => (mudeReady(at.home, env, FILES) ? "mude" : undefined),
	});
	const notified: { message: string; type?: string }[] = [];
	const presented: { kind: string; payload: unknown }[] = [];
	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	const runtime = {
		config: loaded.config,
		pi: {
			on: (event: string, listener: (event: unknown, ctx: unknown) => void) => {
				if (event === "session_start") sessionStart = listener;
			},
		},
		present: (kind: string, payload: unknown) => presented.push({ kind, payload }),
	};
	if (loaded.laya) {
		const roots = { home: at.home, agentDir: at.agentDir };
		registerLayaNotice(runtime as unknown as KyrnRuntime, loaded.laya, roots, at.home);
	}
	const ui = { notify: (message: string, type?: string) => notified.push({ message, type }) };
	sessionStart?.({}, { hasUI: options.hasUI ?? true, ui });
	return { config: loaded.config, laya: loaded.laya, problem: loaded.problem, notified, presented };
}

const backups = (at: Machine): string[] =>
	existsSync(join(at.home, "backups")) ? readdirSync(join(at.home, "backups")) : [];

describe("a configuration that still names Laya, which mu no longer has", () => {
	it("puts mude 1.0 in its place when mude is set up here, in mu.json once, and says so once", () => {
		const before = '{\n\t"tiers": ["laya", "jev"],\n\t"modes": { "default": "active" }\n}\n';
		const at = machine(before, { mude: true });

		const first = start(at);
		expect(first.config.tiers).toEqual(["mude", "jev"]);
		// Only the judges changed; the rest of the file is as it was, byte for byte.
		expect(at.read()).toBe('{\n\t"tiers": ["mude", "jev"],\n\t"modes": { "default": "active" }\n}\n');
		expect(first.notified).toEqual([
			{
				type: "info",
				message:
					"mu: Laya is no longer built in, so your judge is now mude 1.0. To use another decision model, add it from Hugging Face: mu judge model add <link> (or Settings → Judges in the desktop app).",
			},
		]);
		expect(first.presented).toEqual([
			{
				kind: "judge.notice",
				payload: { code: "laya_removed", judge: "mude", message: first.notified[0].message },
			},
		]);
		// The file as it was is kept.
		const [backup] = backups(at);
		expect(readFileSync(join(at.home, "backups", backup, "mu.json"), "utf8")).toBe(before);

		// The next session: nothing to change, nothing to say.
		const second = start(at);
		expect(second.laya).toBeUndefined();
		expect(second.config.tiers).toEqual(["mude", "jev"]);
		expect(second.notified).toEqual([]);
		expect(at.read()).toBe('{\n\t"tiers": ["mude", "jev"],\n\t"modes": { "default": "active" }\n}\n');
		expect(backups(at)).toHaveLength(1);
	});

	it("without mude, leaves Laya out, and with no judge left uses mu's default, Jev", () => {
		const behind = machine('{"tiers":["laya","jev"]}');
		const kept = start(behind);
		expect(kept.config.tiers).toEqual(["jev"]);
		expect(behind.read()).toBe('{"tiers":["jev"]}');
		expect(kept.notified[0].message).toContain("so your judge is now Jev.");

		const alone = machine(JSON.stringify({ tiers: ["laya"], recordState: false }, null, 2));
		const fallback = start(alone);
		expect(fallback.config.tiers).toEqual(["jev"]);
		expect(alone.read()).toBe('{\n  "tiers": [\n    "jev"\n  ],\n  "recordState": false\n}');
		expect(fallback.notified[0].message).toContain("so your judge is now Jev.");
		// mude installed without its key (never enabled): not set up, so not used.
		const keyless = machine('{"tiers":["laya","jev"]}', { mude: true });
		expect(start(keyless, { env: { MU_JUDGE_MUDE_KEY: "" } }).config.tiers).toEqual(["jev"]);
		expect(mudeReady(keyless.home, {}, FILES)).toBe(false);
	});

	it("takes it out of routes too: mude in its place, or the rest, and a route left empty goes back to the tiers", () => {
		const routes = { "memory.capture": ["laya", "jev"], "browser.step": ["laya"], "turn.drift": "laya, clm" };
		const text = `${JSON.stringify({ tiers: ["jev"], routes, features: { memory: true } }, null, "\t")}\n`;

		const without = machine(text);
		const first = start(without);
		expect(first.config.routes).toEqual({ "memory.capture": ["jev"], "turn.drift": ["clm"] });
		expect(JSON.parse(without.read())).toEqual({
			tiers: ["jev"],
			routes: { "memory.capture": ["jev"], "turn.drift": "clm" },
			features: { memory: true },
		});
		expect(first.notified).toHaveLength(1);

		const withMude = machine(text, { mude: true });
		expect(start(withMude).config.routes).toEqual({
			"memory.capture": ["mude", "jev"],
			"browser.step": ["mude"],
			"turn.drift": ["mude", "clm"],
		});
		expect(JSON.parse(withMude.read()).routes).toEqual({
			"memory.capture": ["mude", "jev"],
			"browser.step": ["mude"],
			"turn.drift": "mude, clm",
		});
	});

	it("reads a judge of one's own of Laya's type, local, as Laya, and keeps one called laya of another type", () => {
		const text = [
			"{",
			'  "tiers": ["mine", "jev"],',
			'  "judges": {',
			'    "mine": { "type": "local", "baseUrl": "http://127.0.0.1:47823" },',
			'    "luna": { "type": "llm", "model": "openai/gpt-5.6-luna" }',
			"  }",
			"}",
			"",
		].join("\n");
		const sidecar = machine(text);
		const first = start(sidecar);
		expect(first.config.tiers).toEqual(["jev"]);
		expect(first.config.judges).toEqual({ luna: { type: "llm", model: "openai/gpt-5.6-luna" } });
		expect(sidecar.read()).toBe(
			[
				"{",
				'  "tiers": ["jev"],',
				'  "judges": {',
				'    "luna": { "type": "llm", "model": "openai/gpt-5.6-luna" }',
				"  }",
				"}",
				"",
			].join("\n"),
		);
		expect(first.notified).toHaveLength(1);

		const own = '{"tiers":["laya"],"judges":{"laya":{"type":"http","baseUrl":"http://judge.internal:8000"}}}';
		const mine = machine(own, { mude: true });
		const kept = start(mine);
		expect(kept.laya).toBeUndefined();
		expect(kept.config.tiers).toEqual(["laya"]);
		expect(kept.notified).toEqual([]);
		expect(mine.read()).toBe(own);
	});

	it("skips laya in MU_JUDGE in every session that has it, and changes no file for it", () => {
		const at = machine('{"tiers":["clm","jev"]}', { mude: true });
		const named = start(at, { env: { MU_JUDGE: "laya,jev" } });
		expect(named.config.tiers).toEqual(["jev"]);
		expect(named.notified[0].message).toBe(
			"mu: Laya is no longer built in, so mu skips the laya in MU_JUDGE and your judge is now Jev. To use another decision model, add it from Hugging Face: mu judge model add <link> (or Settings → Judges in the desktop app).",
		);
		// MU_JUDGE naming nothing else leaves the file's judges.
		const alone = start(at, { env: { KYRN_JUDGE: "laya" } });
		expect(alone.config.tiers).toEqual(["clm", "jev"]);
		expect(alone.notified).toHaveLength(1);
		expect(at.read()).toBe('{"tiers":["clm","jev"]}');
		expect(backups(at)).toEqual([]);
	});

	it("leaves a mu.json that is not plain JSON as it is", () => {
		const broken = '{ "tiers": ["laya", "jev"], // mine\n}\n';
		const at = machine(broken, { mude: true });
		const session = start(at);
		expect(session.problem).toContain("mu.json could not be read");
		expect(session.config.tiers).toEqual(["jev"]);
		expect(session.notified).toEqual([]);
		expect(at.read()).toBe(broken);
		expect(migrateConfigText(broken, "mude")).toBeUndefined();
		expect(backups(at)).toEqual([]);
	});

	it("leaves the file to a session someone sees, when the first one is a run nobody watches", () => {
		const at = machine('{"tiers":["laya","jev"]}', { mude: true });
		const printed = start(at, { hasUI: false });
		expect(printed.config.tiers).toEqual(["mude", "jev"]);
		expect(printed.notified).toEqual([]);
		expect(at.read()).toBe('{"tiers":["laya","jev"]}');

		const seen = start(at);
		expect(seen.notified).toHaveLength(1);
		expect(at.read()).toBe('{"tiers":["mude","jev"]}');
	});

	it("fixes kyrn.json on a machine that only has that one", () => {
		const at = machine('{ "tiers": ["laya", "jev"] }', { file: "kyrn.json" });
		start(at);
		expect(at.read()).toBe('{ "tiers": ["jev"] }');
		expect(existsSync(join(at.agentDir, "mu.json"))).toBe(false);
	});

	it("words the notice in Chinese for a Chinese interface", () => {
		const previous = process.env.MU_LANG;
		process.env.MU_LANG = "zh-CN";
		try {
			expect(layaNotice({ file: true, env: false, replacement: "mude" }, "jev")).toBe(
				"mu：不再内置 Laya，你的判定器现在是 mude 1.0。想用别的决策模型，可以从 Hugging Face 添加：mu judge model add <链接>（或在桌面端「设置 → 判定器」里添加）。",
			);
			expect(layaNotice({ file: false, env: true }, "jev")).toContain("跳过了 MU_JUDGE 里的 laya，判定器现在是 Jev");
		} finally {
			if (previous === undefined) delete process.env.MU_LANG;
			else process.env.MU_LANG = previous;
		}
	});
});

describe("migrateConfigText", () => {
	it("writes a judge list the way it was written, and touches nothing else", () => {
		const text = [
			"{",
			'\t"features": { "browser": { "enabled": true } },',
			'\t"tiers": [',
			'\t\t"laya",',
			'\t\t"mude",',
			'\t\t"jev"',
			"\t],",
			'\t"writer": "openai/gpt-5.6-luna"',
			"}",
		].join("\n");
		// mude where Laya was, not twice.
		expect(migrateConfigText(text, "mude")).toBe(
			[
				"{",
				'\t"features": { "browser": { "enabled": true } },',
				'\t"tiers": [',
				'\t\t"mude",',
				'\t\t"jev"',
				"\t],",
				'\t"writer": "openai/gpt-5.6-luna"',
				"}",
			].join("\n"),
		);
		expect(migrateConfigText('{"tiers":["jev"],"routes":{"x":["clm"]}}', "mude")).toBeUndefined();
		expect(migrateConfigText("[1, 2]")).toBeUndefined();
		// Every route gone, and every judge entry: empty objects, not dangling commas.
		expect(
			migrateConfigText('{"routes":{"a":["laya"],"b":"laya"},"judges":{"l":{"type":"local"}},"tiers":["l"]}'),
		).toBe('{"routes":{},"judges":{},"tiers":["jev"]}');
		expect(
			migrateConfigText('{\n  "routes": {\n    "a": ["laya"],\n    "b": ["clm"],\n    "c": ["laya"]\n  }\n}'),
		).toBe('{\n  "routes": {\n    "b": ["clm"]\n  }\n}');
	});
});
