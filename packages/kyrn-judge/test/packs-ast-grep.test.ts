import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "../../coding-agent/test/suite/harness.ts";
import {
	applyEdits,
	editsDiff,
	findAstGrep,
	formatSearch,
	parseSgLine,
	planRewrite,
	rewrite,
	runSg,
	type SgMatch,
	sgArgs,
} from "../src/packs/ast-grep.ts";
import { findOnPath, installHint, invocationFor, quoteForCmd, run } from "../src/packs/exec.ts";
import { active, call, disclosing, registered, startPacks, toolResults } from "./packs-helpers.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures/packs");
const lines = (name: string) => readFileSync(join(fixtures, name), "utf8").split("\n").filter(Boolean);
const matches = (name: string) => lines(name).map((line) => parseSgLine(line) as SgMatch);

/** The file the rewrite fixture was recorded from. */
const C_TS = 'const s = "中文 héllo"; const z = foo(foo(1), "世界");\nfoo(2);\n';

const temporary: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mu-packs-"));
	temporary.push(dir);
	return dir;
}

/** A program that answers like ast-grep 0.44 from the recorded fixtures, and notes the arguments it was given. */
function fakeAstGrep(dir: string): { command: string; argsLog: string } {
	const command = join(dir, "fake-ast-grep");
	const argsLog = join(dir, "args.json");
	writeFileSync(
		command,
		`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("ast-grep 0.44.0"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args));
const rewrite = args.some((arg) => arg.startsWith("--rewrite="));
process.stdout.write(fs.readFileSync(${JSON.stringify(fixtures)} + (rewrite ? "/sg-rewrite.jsonl" : "/sg-search.jsonl")));
`,
		{ mode: 0o755 },
	);
	return { command, argsLog };
}

afterEach(() => {
	while (temporary.length > 0) rmSync(temporary.pop() as string, { recursive: true, force: true });
});

describe("running programs without a shell", () => {
	it("passes a program through untouched outside Windows", () => {
		expect(invocationFor("ast-grep", ["run", "--pattern=$A"], { platform: "linux", env: {} })).toEqual({
			command: "ast-grep",
			args: ["run", "--pattern=$A"],
			verbatim: false,
		});
	});

	it("starts an .exe found through PATH and PATHEXT directly on Windows", () => {
		const env = { Path: "C:\\tools;C:\\Users\\me\\scoop\\shims", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
		const isFile = (path: string) => path === "C:\\Users\\me\\scoop\\shims\\ast-grep.EXE";
		expect(findOnPath("ast-grep", { platform: "win32", env, isFile })).toBe(
			"C:\\Users\\me\\scoop\\shims\\ast-grep.EXE",
		);
		expect(invocationFor("ast-grep", ["--version"], { platform: "win32", env, isFile })).toEqual({
			command: "C:\\Users\\me\\scoop\\shims\\ast-grep.EXE",
			args: ["--version"],
			verbatim: false,
		});
		expect(invocationFor("sg", ["--version"], { platform: "win32", env, isFile })).toBeUndefined();
	});

	it("hands an npm .cmd shim to cmd.exe with every metacharacter escaped, never to a shell as plain text", () => {
		const env = { PATH: "C:\\npm", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
		const isFile = (path: string) => path === "C:\\npm\\ast-grep.CMD";
		const invocation = invocationFor("ast-grep", ['--pattern=log("a" & $B)'], { platform: "win32", env, isFile });
		expect(invocation?.command).toBe("C:\\Windows\\system32\\cmd.exe");
		expect(invocation?.verbatim).toBe(true);
		expect(invocation?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		// No quote, ampersand or parenthesis reaches cmd.exe without a caret in front of it.
		const line = invocation?.args[3].slice(1, -1) ?? "";
		expect(line.replace(/\^./g, "")).not.toMatch(/["&()]/);
		expect(quoteForCmd('a"b', false)).toBe('^"a\\^"b^"');
		expect(quoteForCmd("dir\\", false)).toBe('^"dir\\\\^"');
	});

	it("reports a program that is not installed as missing instead of throwing", async () => {
		const result = await run(join(tempDir(), "no-such-program"), ["--version"]);
		expect(result.missing).toBe(true);
	});

	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const pidIn = (file: string) => Number(readFileSync(file, "utf8").trim());

	it.skipIf(process.platform === "win32")(
		"answers when the program exits, even if something it started still holds its output",
		async () => {
			const pidFile = join(tempDir(), "background.pid");
			const started = Date.now();
			const result = await run("sh", ["-c", `sleep 30 & echo $! > "${pidFile}"; echo done`]);
			try {
				expect(result).toMatchObject({ code: 0, stdout: "done\n", stopped: false });
				expect(Date.now() - started).toBeLessThan(5000);
			} finally {
				process.kill(pidIn(pidFile), "SIGKILL");
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"a timeout ends the program and everything it started (a git hook's own children)",
		async () => {
			const pidFile = join(tempDir(), "hook-child.pid");
			const started = Date.now();
			const result = await run("sh", ["-c", `sleep 30 & echo $! > "${pidFile}"; wait`], { timeoutMs: 300 });
			expect(result.stopped).toBe(true);
			expect(Date.now() - started).toBeLessThan(5000);
			const child = pidIn(pidFile);
			await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 3000 });
		},
	);

	it("gives an install hint in the package manager of the platform", () => {
		expect(installHint("ast-grep", "darwin")).toContain("brew install ast-grep");
		expect(installHint("ast-grep", "win32")).toContain("scoop install main/ast-grep");
		expect(installHint("ast-grep", "linux")).toContain("npm install --global @ast-grep/cli");
		expect(installHint("git", "win32")).toContain("winget install --id Git.Git");
	});
});

describe("ast-grep: arguments and output", () => {
	it("spells every value as --flag=value and puts the paths after --", () => {
		expect(sgArgs({ pattern: "-$A", language: "ts", paths: ["-odd", "src"] })).toEqual([
			"run",
			"--pattern=-$A",
			"--lang=ts",
			"--json=stream",
			"--color=never",
			"--",
			"-odd",
			"src",
		]);
		expect(sgArgs({ pattern: "foo($A)", language: "py", rewrite: "" })).toEqual([
			"run",
			"--pattern=foo($A)",
			"--lang=py",
			"--rewrite=",
			"--json=stream",
			"--color=never",
			"--",
			".",
		]);
	});

	it("reads recorded search output: lines counted from 1, multi-line matches, grouped by file", () => {
		const found = matches("sg-search.jsonl");
		expect(found.map((match) => [match.file, match.line, match.endLine])).toEqual([
			["src/a.ts", 2, 2],
			["src/a.ts", 4, 5],
			["src/b.ts", 2, 2],
		]);
		expect(found.every((match) => match.replacement === undefined)).toBe(true);
		expect(formatSearch({ matches: found, total: 3, more: false, problem: undefined })).toBe(
			[
				"3 matches in 2 files",
				"src/a.ts",
				'  2: console.log("hello", 1)',
				"  4-5: console.log(`multi …(+1 lines)",
				"src/b.ts",
				'  2: console.log("b")',
			].join("\n"),
		);
		expect(formatSearch({ matches: found.slice(0, 2), total: 5000, more: true, problem: undefined })).toContain(
			"Showing 2 of 5000+ matches",
		);
		expect(parseSgLine("not json")).toBeUndefined();
		expect(parseSgLine('{"text":"x"}')).toBeUndefined();
	});

	it("rewrites by byte offsets, keeps the outer of two nested matches as ast-grep does, and shows the diff", () => {
		const plan = planRewrite(matches("sg-rewrite.jsonl"));
		const edits = plan.get("src/c.ts") ?? [];
		// Three matches were reported; foo(1) lies inside foo(foo(1), "世界").
		expect(edits.map((edit) => edit.replacement)).toEqual(['bar(foo(1), "世界")', "bar(2)"]);
		const source = Buffer.from(C_TS, "utf8");
		// What `ast-grep --update-all` itself made of this file.
		expect(applyEdits(source, edits)?.toString("utf8")).toBe(
			'const s = "中文 héllo"; const z = bar(foo(1), "世界");\nbar(2);\n',
		);
		expect(editsDiff("src/c.ts", source, edits)).toBe(
			[
				"--- a/src/c.ts",
				"+++ b/src/c.ts",
				"@@ -1,2 +1,2 @@",
				'-const s = "中文 héllo"; const z = foo(foo(1), "世界");',
				"-foo(2);",
				'+const s = "中文 héllo"; const z = bar(foo(1), "世界");',
				"+bar(2);",
			].join("\n"),
		);
	});

	it("keeps line numbers right when a rewrite adds lines, and leaves CRLF endings alone", () => {
		const source = Buffer.from("a();\r\nkeep();\r\na();\r\n", "utf8");
		const edit = (start: number): SgMatch => ({
			file: "x.ts",
			line: 1,
			endLine: 1,
			text: "a()",
			start,
			end: start + 3,
			replacement: "b(\n1)",
		});
		const edits = [edit(0), edit(15)];
		expect(applyEdits(source, edits)?.toString("utf8")).toBe("b(\n1);\r\nkeep();\r\nb(\n1);\r\n");
		expect(
			editsDiff("x.ts", source, edits)
				.split("\n")
				.filter((row) => row.startsWith("@@")),
		).toEqual(["@@ -1,1 +1,2 @@", "@@ -3,1 +4,2 @@"]);
	});

	it("leaves a file alone when it no longer holds what ast-grep matched, and writes under the file lock", async () => {
		const plan = planRewrite(matches("sg-rewrite.jsonl"));
		const log: string[] = [];
		const disk = new Map<string, Buffer>([["/repo/src/c.ts", Buffer.from(C_TS, "utf8")]]);
		const files = {
			read: async (path: string) => disk.get(path) as Buffer,
			write: async (path: string, data: Buffer) => {
				log.push(`write ${path}`);
				disk.set(path, data);
			},
			locked: async <T>(path: string, work: () => Promise<T>) => {
				log.push(`lock ${path}`);
				const result = await work();
				log.push(`unlock ${path}`);
				return result;
			},
			resolve: (file: string) => `/repo/${file}`,
		};

		const dry = await rewrite(plan, files, { apply: false, maxDiffChars: 10000 });
		expect(dry).toMatchObject({ files: 1, edits: 2, written: false, stale: [] });
		expect(disk.get("/repo/src/c.ts")?.toString("utf8")).toBe(C_TS);

		const applied = await rewrite(plan, files, { apply: true, maxDiffChars: 10000 });
		expect(applied.written).toBe(true);
		expect(log.slice(-3)).toEqual(["lock /repo/src/c.ts", "write /repo/src/c.ts", "unlock /repo/src/c.ts"]);
		expect(disk.get("/repo/src/c.ts")?.toString("utf8")).toContain("bar(2);");

		// The same plan again: the file has moved on, so nothing is written and the file is named.
		const again = await rewrite(plan, files, { apply: true, maxDiffChars: 10000 });
		expect(again).toMatchObject({ files: 0, edits: 0, stale: ["src/c.ts"] });
		expect(log.filter((entry) => entry.startsWith("write"))).toHaveLength(1);
	});
});

describe.skipIf(process.platform === "win32")("ast-grep: against a stand-in binary", () => {
	it("accepts a binary only when its --version says ast-grep", async () => {
		const dir = tempDir();
		const { command } = fakeAstGrep(dir);
		expect(await findAstGrep(run, { command })).toEqual({ command, version: "0.44.0" });

		// shadow-utils ships an unrelated `sg` on Linux.
		const other = join(dir, "sg");
		writeFileSync(other, "#!/bin/sh\necho 'Usage: sg group [[-c] command]' >&2\nexit 1\n", { mode: 0o755 });
		expect(await findAstGrep(run, { command: other })).toBeUndefined();
		expect(await findAstGrep(run, { command: join(dir, "absent") })).toBeUndefined();
	});

	it("streams matches, keeps only as many as asked for and stops counting at the ceiling", async () => {
		const dir = tempDir();
		const { command, argsLog } = fakeAstGrep(dir);
		const binary = { command, version: "0.44.0" };
		const query = { pattern: "console.log($$$ARGS)", language: "ts", paths: ["src"] };

		const all = await runSg(run, binary, query, { cwd: dir, keep: 50, ceiling: 5000 });
		expect(all).toMatchObject({ total: 3, more: false, problem: undefined });
		expect(JSON.parse(readFileSync(argsLog, "utf8"))).toEqual(sgArgs(query));

		const capped = await runSg(run, binary, query, { cwd: dir, keep: 1, ceiling: 2 });
		expect(capped.matches).toHaveLength(1);
		expect(capped).toMatchObject({ total: 2, more: true });
	});
});

describe.skipIf(process.platform === "win32")("pack:ast-grep in the catalog", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is hidden by default: its tools are not even registered", async () => {
		const { harness } = await startPacks(harnesses, { packs: { astGrepCommand: fakeAstGrep(tempDir()).command } });
		harness.setResponses([fauxAssistantMessage("Hello.")]);
		await harness.session.prompt("Hi.");
		expect(registered(harness)).not.toContain("sg_search");
		expect(active(harness)).toContain("find_capability");
	});

	it("is opened by a confident judge, and then searches", async () => {
		const { harness } = await startPacks(harnesses, {
			responder: disclosing("ast-grep"),
			packs: { astGrepCommand: fakeAstGrep(tempDir()).command },
		});
		harness.setResponses([
			call("sg_search", { pattern: "console.log($$$ARGS)", language: "ts" }),
			fauxAssistantMessage("Three calls."),
		]);
		await harness.session.prompt("Find every console.log call in this project.");
		expect(active(harness)).toEqual(expect.arrayContaining(["sg_search", "sg_rewrite"]));
		expect(toolResults(harness)[0]).toContain("3 matches in 2 files");
	});

	it("is opened when the model asks for it, and a dry run writes nothing", async () => {
		const dir = tempDir();
		const { harness } = await startPacks(harnesses, { packs: { astGrepCommand: fakeAstGrep(dir).command } });
		mkdirSync(join(harness.tempDir, "src"));
		writeFileSync(join(harness.tempDir, "src/c.ts"), C_TS);
		harness.setResponses([
			call("find_capability", { open: "pack:ast-grep" }),
			call("sg_rewrite", { pattern: "foo($$$A)", rewrite: "bar($$$A)", language: "ts" }),
			call("sg_rewrite", { pattern: "foo($$$A)", rewrite: "bar($$$A)", language: "ts", apply: true }),
			fauxAssistantMessage("Renamed."),
		]);
		await harness.session.prompt("Rename foo to bar.");
		const results = toolResults(harness);
		expect(results[0]).toContain("sg_search, sg_rewrite");
		expect(results[1]).toContain("Dry run: 2 places in 1 files would change");
		expect(results[2]).toContain("Rewrote 2 places in 1 files");
		expect(readFileSync(join(harness.tempDir, "src/c.ts"), "utf8")).toBe(
			'const s = "中文 héllo"; const z = bar(foo(1), "世界");\nbar(2);\n',
		);
	});

	it("stays hidden and says how to install ast-grep when the binary is missing", async () => {
		const { harness } = await startPacks(harnesses, {
			responder: disclosing("ast-grep"),
			packs: { astGrepCommand: join(tempDir(), "absent") },
		});
		harness.setResponses([
			call("find_capability", { open: "pack:ast-grep" }),
			fauxAssistantMessage("Not installed."),
		]);
		// The judge wants it open as well: that failure is silent and the prompt goes through.
		await harness.session.prompt("Find every console.log call.");
		expect(toolResults(harness)[0]).toContain("ast-grep is not installed. Install it with:");
		expect(registered(harness)).not.toContain("sg_search");
		harness.setResponses([call("find_capability", { query: "ast-grep" }), fauxAssistantMessage("Still hidden.")]);
		await harness.session.prompt("Look again.");
		expect(toolResults(harness)[1]).toContain("pack:ast-grep");
	});

	it("has its tools from the start when the catalog is off, since nothing is hidden then", async () => {
		const { harness } = await startPacks(harnesses, {
			packs: { astGrepCommand: fakeAstGrep(tempDir()).command },
			features: { catalog: false },
		});
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("Hi.");
		expect(active(harness)).toEqual(expect.arrayContaining(["sg_search", "sg_rewrite"]));
	});

	it("stays hidden with disclosure off, and opens when the model asks", async () => {
		const { harness, provider } = await startPacks(harnesses, {
			mode: "off",
			responder: disclosing("ast-grep"),
			packs: { astGrepCommand: fakeAstGrep(tempDir()).command },
		});
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("Find every console.log call.");
		expect(registered(harness)).not.toContain("sg_search");
		expect(provider.calls).toEqual([]);
		harness.setResponses([call("find_capability", { open: "pack:ast-grep" }), fauxAssistantMessage("Open.")]);
		await harness.session.prompt("Search for them.");
		expect(active(harness)).toEqual(expect.arrayContaining(["sg_search", "sg_rewrite"]));
	});
});

const real = ["ast-grep", "sg"].find((command) =>
	/^ast-grep\s/.test(spawnSync(command, ["--version"], { encoding: "utf8" }).stdout ?? ""),
);

describe.skipIf(!real)("ast-grep: the real binary (runs only where it is installed)", () => {
	it("finds, previews and rewrites across files, agreeing with the recorded fixtures", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src/c.ts"), C_TS);
		writeFileSync(join(dir, "src/neg.ts"), "const a = -x;\n");
		const binary = await findAstGrep(run);
		expect(binary?.version).toMatch(/^\d+\.\d+/);
		if (!binary) return;

		const dash = await runSg(
			run,
			binary,
			{ pattern: "-$A", language: "ts", paths: ["src"] },
			{ cwd: dir, keep: 10, ceiling: 100 },
		);
		expect(dash.matches.map((match) => [match.file, match.line, match.text])).toEqual([["src/neg.ts", 1, "-x"]]);

		const found = await runSg(
			run,
			binary,
			{ pattern: "foo($$$A)", rewrite: "bar($$$A)", language: "ts", paths: ["src"] },
			{ cwd: dir, keep: 100, ceiling: 100 },
		);
		expect(found.total).toBe(3);
		// A rewrite with --json is a dry run in ast-grep itself: the file is as it was.
		expect(readFileSync(join(dir, "src/c.ts"), "utf8")).toBe(C_TS);
		const edits = planRewrite(found.matches).get("src/c.ts") ?? [];
		expect(applyEdits(Buffer.from(C_TS, "utf8"), edits)?.toString("utf8")).toBe(
			'const s = "中文 héllo"; const z = bar(foo(1), "世界");\nbar(2);\n',
		);

		const none = await runSg(
			run,
			binary,
			{ pattern: "nothingLikeThis($A)", language: "ts" },
			{ cwd: dir, keep: 10, ceiling: 100 },
		);
		expect(none).toMatchObject({ total: 0, problem: undefined });
		const unknown = await runSg(
			run,
			binary,
			{ pattern: "x", language: "klingon" },
			{ cwd: dir, keep: 1, ceiling: 1 },
		);
		expect(unknown.problem).toContain("klingon");
	});
});
