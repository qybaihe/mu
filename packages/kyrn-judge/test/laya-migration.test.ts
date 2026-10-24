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
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { loadConfig, parseConfig } from "../src/config.ts";
import { registerFreeJevNotice } from "../src/extension/features/free-jev.ts";
import { layaNotice, pendingLayaNotice, registerLayaNotice } from "../src/extension/features/laya.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import type { KyrnRuntime } from "../src/extension/runtime.ts";
import { migrateConfigText, mudeReady } from "../src/laya-migration.ts";
import type { MudeFile } from "../src/mude/manifest.ts";
import { mudePaths } from "../src/mude/paths.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

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

type Source = "interactive" | "rpc" | "extension";

/**
 * A session starting as kyrn-judge.ts starts one: the configuration read, the feature registered, session_start.
 * `send` is a message to it, as pi's `input` event brings one: from a person (`interactive` in the terminal, `rpc`
 * from the desktop app), or from an extension.
 */
function open(at: Machine, options: { env?: Record<string, string>; hasUI?: boolean } = {}) {
	const env = { ...at.env, ...options.env };
	const loaded = loadConfig({
		dir: at.agentDir,
		env,
		replaceLaya: () => (mudeReady(at.home, env, FILES) ? "mude" : undefined),
	});
	const notified: { message: string; type?: string }[] = [];
	const presented: { kind: string; payload: unknown }[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const runtime = {
		config: loaded.config,
		pi: { on: (event: string, listener: (event: unknown, ctx: unknown) => void) => handlers.set(event, listener) },
		present: (kind: string, payload: unknown) => presented.push({ kind, payload }),
		touch: () => {},
	};
	registerLayaNotice(
		runtime as unknown as KyrnRuntime,
		loaded.laya,
		{ home: at.home, agentDir: at.agentDir },
		at.home,
	);
	const ctx = {
		hasUI: options.hasUI ?? true,
		ui: { notify: (message: string, type?: string) => notified.push({ message, type }) },
	};
	handlers.get("session_start")?.({ type: "session_start" }, ctx);
	const send = (text: string, source: Source = "rpc") => handlers.get("input")?.({ type: "input", text, source }, ctx);
	return { config: loaded.config, laya: loaded.laya, problem: loaded.problem, notified, presented, send };
}

/** A session a person writes in: it starts, and they send their first message. */
function start(at: Machine, options: { env?: Record<string, string>; hasUI?: boolean } = {}) {
	const session = open(at, options);
	session.send("hello");
	return session;
}

/** The notice waiting in notices.json for someone to see it. */
const pending = (at: Machine) => pendingLayaNotice(join(at.agentDir, "mu", "notices.json"));

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
			"mu: Laya is no longer built in, so mu skips laya in MU_JUDGE and your judge is now Jev. To use another decision model, add it from Hugging Face: mu judge model add <link> (or Settings → Judges in the desktop app).",
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
			expect(layaNotice({ judge: "mude", from: "mu.json" })).toBe(
				"mu：不再内置 Laya，你的判定器现在是 mude 1.0。想用别的决策模型，可以从 Hugging Face 添加：mu judge model add <链接>（或在桌面端「设置 → 判定器」里添加）。",
			);
			expect(layaNotice({ judge: "jev", from: "MU_JUDGE" })).toContain(
				"跳过了 MU_JUDGE 里的 laya，判定器现在是 Jev",
			);
		} finally {
			if (previous === undefined) delete process.env.MU_LANG;
			else process.env.MU_LANG = previous;
		}
	});
});

const JEV_NOTICE =
	"mu: Laya is no longer built in, so your judge is now Jev. To use another decision model, add it from Hugging Face: mu judge model add <link> (or Settings → Judges in the desktop app).";

describe("the Laya notice waits for the first message a person sends", () => {
	it("is left by a session that gets no message, as the app's health check, and said once at the next one's first", () => {
		const at = machine('{"tiers":["laya","jev"]}');
		// The desktop app's backend opens a session at every app start to check that mu runs, and sends it nothing.
		const check = open(at);
		expect(at.read()).toBe('{"tiers":["jev"]}');
		expect(backups(at)).toHaveLength(1);
		expect(check.notified).toEqual([]);
		expect(check.presented).toEqual([]);
		expect(pending(at)).toEqual({ judge: "jev", from: "mu.json" });

		// The conversation the person opens next reads a mu.json without Laya, and the notice still waits.
		const conversation = open(at);
		expect(conversation.laya).toBeUndefined();
		expect(conversation.notified).toEqual([]);
		conversation.send("Fix the flaky login test");
		expect(conversation.notified).toEqual([{ type: "info", message: JEV_NOTICE }]);
		expect(conversation.presented).toEqual([
			{ kind: "judge.notice", payload: { code: "laya_removed", judge: "jev", message: JEV_NOTICE } },
		]);
		expect(pending(at)).toBeUndefined();
		conversation.send("And the signup test");
		expect(conversation.notified).toHaveLength(1);

		// Once seen, no later session says it.
		const later = start(at);
		expect(later.notified).toEqual([]);
		expect(later.presented).toEqual([]);
		expect(backups(at)).toHaveLength(1);
	});

	it("is not taken by a message an extension sends, or an empty one", () => {
		const at = machine('{"tiers":["laya","jev"]}', { mude: true });
		const session = open(at);
		session.send("Carry on with the plan.", "extension");
		session.send("  \n ", "interactive");
		expect(session.notified).toEqual([]);
		expect(pending(at)).toEqual({ judge: "mude", from: "mu.json" });
		session.send("hello", "interactive");
		expect(session.notified).toHaveLength(1);
		expect(session.notified[0].message).toContain("so your judge is now mude 1.0.");
		expect(session.presented[0]).toMatchObject({ payload: { code: "laya_removed", judge: "mude" } });
	});

	it("is left where it is by a run nobody watches, which changes no file either", () => {
		const at = machine('{"tiers":["laya","jev"]}');
		const printed = start(at, { hasUI: false });
		expect(printed.notified).toEqual([]);
		expect(at.read()).toBe('{"tiers":["laya","jev"]}');
		expect(pending(at)).toBeUndefined();

		open(at);
		const printedAfter = start(at, { hasUI: false });
		expect(printedAfter.notified).toEqual([]);
		expect(printedAfter.presented).toEqual([]);
		expect(pending(at)).toEqual({ judge: "jev", from: "mu.json" });
		expect(start(at).notified).toEqual([{ type: "info", message: JEV_NOTICE }]);
	});

	it("says MU_JUDGE's at the first message of every session started with laya in it", () => {
		const at = machine('{"tiers":["clm","jev"]}');
		open(at, { env: { MU_JUDGE: "laya,jev" } });
		expect(pending(at)).toEqual({ judge: "jev", from: "MU_JUDGE" });
		const first = start(at, { env: { MU_JUDGE: "laya,jev" } });
		expect(first.notified[0].message).toContain("so mu skips laya in MU_JUDGE and your judge is now Jev.");
		expect(pending(at)).toBeUndefined();
		expect(start(at, { env: { MU_JUDGE: "laya,jev" } }).notified).toHaveLength(1);
		expect(start(at).notified).toEqual([]);
		expect(at.read()).toBe('{"tiers":["clm","jev"]}');
		expect(backups(at)).toEqual([]);
	});

	it("keeps a notice about mu.json over a later one about MU_JUDGE", () => {
		const at = machine('{"tiers":["laya","jev"]}');
		open(at);
		open(at, { env: { MU_JUDGE: "laya,clm" } });
		expect(pending(at)).toEqual({ judge: "jev", from: "mu.json" });
	});

	it("is said in its own session when notices.json cannot be written", () => {
		const at = machine('{"tiers":["laya","jev"]}');
		// A file where mu's state folder would be.
		writeFileSync(join(at.agentDir, "mu"), "");
		const session = start(at);
		expect(at.read()).toBe('{"tiers":["jev"]}');
		expect(session.notified).toEqual([{ type: "info", message: JEV_NOTICE }]);
	});

	it("shares notices.json with the free Jev notice, which keeps it", () => {
		const at = machine('{"tiers":["laya","jev"]}');
		open(at);
		const runtime = {
			ctx: { hasUI: true, ui: { notify: () => {} } },
			present: () => {},
			onFreeJev: undefined as ((outcome: string) => void) | undefined,
		};
		registerFreeJevNotice(runtime as unknown as KyrnRuntime, { home: at.home, agentDir: at.agentDir });
		runtime.onFreeJev?.("answered");
		const notices = JSON.parse(readFileSync(join(at.agentDir, "mu", "notices.json"), "utf8"));
		expect(notices.freeJev).toMatch(/^\d{4}-\d\d-\d\d$/);
		expect(pending(at)).toEqual({ judge: "jev", from: "mu.json" });
		expect(start(at).notified).toEqual([{ type: "info", message: JEV_NOTICE }]);
		expect(JSON.parse(readFileSync(join(at.agentDir, "mu", "notices.json"), "utf8"))).toEqual({
			version: 1,
			freeJev: notices.freeJev,
		});
	});
});

describe("the Laya notice in a pi session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("waits through mu's own commands, which start no turn, and is said at the first message over RPC", async () => {
		const at = machine('{"tiers":["jev"]}');
		mkdirSync(join(at.agentDir, "mu"), { recursive: true });
		writeFileSync(
			join(at.agentDir, "mu", "notices.json"),
			JSON.stringify({ version: 1, layaRemoved: { judge: "jev", from: "mu.json" } }),
		);
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					config: parseConfig({ features: { memory: false } }),
					only: ["goal"],
					roots: { home: at.home, agentDir: at.agentDir },
					onPresentation: (event) => events.push(event),
				}),
			],
		});
		harnesses.push(harness);
		const notes: string[] = [];
		const known: Record<string, unknown> = { notify: (message: string) => notes.push(message) };
		const ui = new Proxy(known, {
			get: (target, key) => (key in target ? target[key as string] : () => undefined),
		}) as unknown as ExtensionUIContext;
		await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		const notices = () => events.filter((event) => event.kind === "judge.notice").map((event) => event.payload);

		// What the app sends by itself is a command of mu's own, as /goal clear is.
		await harness.session.prompt("/goal clear");
		expect(notices()).toEqual([]);
		expect(pending(at)).toEqual({ judge: "jev", from: "mu.json" });

		harness.setResponses([fauxAssistantMessage("Hi."), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("hello");
		expect(notices()).toEqual([{ code: "laya_removed", judge: "jev", message: JEV_NOTICE }]);
		expect(notes.filter((note) => note === JEV_NOTICE)).toHaveLength(1);
		expect(pending(at)).toBeUndefined();
		await harness.session.prompt("thanks");
		expect(notices()).toHaveLength(1);
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

	it("takes out the last property, and the only one, of judges and routes, and leaves no dangling comma", () => {
		const only =
			'{\n  "tiers": ["jev"],\n  "routes": { "a": ["laya"] },\n  "judges": { "l": { "type": "local" } }\n}\n';
		expect(migrateConfigText(only)).toBe('{\n  "tiers": ["jev"],\n  "routes": {},\n  "judges": {}\n}\n');

		const last = [
			"{",
			'  "routes": {',
			'    "kept": ["clm"],',
			'    "gone": ["laya"]',
			"  },",
			'  "judges": {',
			'    "luna": { "type": "llm", "model": "openai/gpt-5.6-luna" },',
			'    "l": { "type": "local" }',
			"  }",
			"}",
		].join("\n");
		const next = migrateConfigText(last) ?? "";
		expect(next).toBe(
			[
				"{",
				'  "routes": {',
				'    "kept": ["clm"]',
				"  },",
				'  "judges": {',
				'    "luna": { "type": "llm", "model": "openai/gpt-5.6-luna" }',
				"  }",
				"}",
			].join("\n"),
		);
		expect(JSON.parse(next)).toEqual({
			routes: { kept: ["clm"] },
			judges: { luna: { type: "llm", model: "openai/gpt-5.6-luna" } },
		});
	});

	it("handles the commas around a removed entry wherever they stand", () => {
		const layouts = [
			// Comma after the value, before the next key, alone on a line, with spaces on both sides.
			'{"routes":{"a":["laya"],"b":["clm"],"c":["laya"],"d":["jev"],"e":["laya"]}}',
			'{ "routes" : { "a" : [ "laya" ] , "b" : [ "clm" ] , "c" : [ "laya" ] , "d" : [ "jev" ] , "e" : [ "laya" ] } }',
			'{\n  "routes": {\n    "a": ["laya"]\n    ,\n    "b": ["clm"]\n    , "c": ["laya"],\n    "d": ["jev"]\n    ,"e": ["laya"]\n  }\n}',
		];
		for (const text of layouts) {
			const next = migrateConfigText(text);
			expect(next, text).toBeDefined();
			expect(JSON.parse(next as string), text).toEqual({ routes: { b: ["clm"], d: ["jev"] } });
		}
		// A trailing comma is not JSON: such a file is left as it is.
		expect(migrateConfigText('{"tiers":["laya","jev"],}')).toBeUndefined();
		expect(migrateConfigText('{"routes":{"a":["laya"],},"tiers":["jev"]}')).toBeUndefined();
	});

	it("keeps CRLF line endings", () => {
		const text = JSON.stringify(
			{ tiers: ["laya", "jev"], routes: { a: ["laya"], b: ["clm"] }, writer: "x/y" },
			null,
			2,
		)
			.split("\n")
			.join("\r\n");
		const next = migrateConfigText(`${text}\r\n`, "mude") ?? "";
		expect(next.replaceAll("\r\n", "")).not.toContain("\n");
		expect(JSON.parse(next)).toEqual({ tiers: ["mude", "jev"], routes: { a: ["mude"], b: ["clm"] }, writer: "x/y" });
		expect(next).toBe(
			`${JSON.stringify({ tiers: ["mude", "jev"], routes: { a: ["mude"], b: ["clm"] }, writer: "x/y" }, null, 2)
				.split("\n")
				.join("\r\n")}\r\n`,
		);
	});

	it("leaves a file with comments or anything else that is not JSON as it is", () => {
		for (const text of [
			'{\n  // the judges\n  "tiers": ["laya", "jev"]\n}',
			'{ /* local first */ "tiers": ["laya", "jev"] }',
			"{ tiers: ['laya', 'jev'] }",
			'{ "tiers": ["laya", "jev"], "recordState": NaN }',
			'{ "tiers": ["laya", "jev"] } trailing',
			'{ "tiers": ["laya", "jev"]',
			"",
		]) {
			expect(migrateConfigText(text, "mude"), text).toBeUndefined();
		}
	});

	it("over many layouts and orders, writes JSON that names no Laya and keeps every other key", () => {
		const unrelated = {
			modes: { default: "active", "turn.drift": "shadow" },
			features: { browser: { enabled: true }, memory: false, swarm: { models: ["a/b", "c/d"] } },
			writer: "openai/gpt-5.6-luna",
			recordState: false,
			mcp: { servers: { files: { command: "npx", args: ["-y", "files"] } } },
		};
		const luna = { type: "llm", model: "openai/gpt-5.6-luna" };
		const rotate = <T>(list: readonly T[], by: number): T[] => [...list.slice(by), ...list.slice(0, by)];
		const routeEntries: [string, unknown][] = [
			["a", ["laya"]],
			["b", ["laya", "jev"]],
			["c", "laya, clm"],
			["d", ["clm"]],
		];
		const judgeEntries: [string, unknown][] = [
			["luna", luna],
			["mine", { type: "local", baseUrl: "http://127.0.0.1:47823" }],
		];
		const layouts: ((value: unknown) => string)[] = [
			(value) => JSON.stringify(value),
			(value) => JSON.stringify(value, null, 2),
			(value) => `${JSON.stringify(value, null, "\t")}\n`,
			(value) => `${JSON.stringify(value, null, 4).split("\n").join("\r\n")}\r\n`,
		];
		let checked = 0;
		for (let order = 0; order < 4; order++) {
			const top: [string, unknown][] = rotate(
				[
					["tiers", ["laya", "mine", "jev"]],
					["routes", Object.fromEntries(rotate(routeEntries, order))],
					["judges", Object.fromEntries(rotate(judgeEntries, order % 2))],
					...Object.entries(unrelated),
				],
				order * 2,
			);
			const value = Object.fromEntries(top);
			for (const layout of layouts) {
				for (const replacement of [undefined, "mude"]) {
					const text = layout(value);
					const next = migrateConfigText(text, replacement);
					expect(next, text).toBeDefined();
					const parsed = JSON.parse(next as string);
					for (const [key, kept] of Object.entries(unrelated)) expect(parsed[key], key).toEqual(kept);
					expect(parsed.tiers).toEqual(replacement ? ["mude", "jev"] : ["jev"]);
					expect(parsed.routes).toEqual(
						replacement
							? { a: ["mude"], b: ["mude", "jev"], c: "mude, clm", d: ["clm"] }
							: { b: ["jev"], c: "clm", d: ["clm"] },
					);
					expect(parsed.judges).toEqual({ luna });
					expect(Object.keys(parsed)).toEqual(Object.keys(value));
					// Nothing left to change: a second pass leaves the file alone.
					expect(migrateConfigText(next as string, replacement)).toBeUndefined();
					checked++;
				}
			}
		}
		expect(checked).toBe(32);
	});
});
