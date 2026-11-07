import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { isMutatingCall } from "../src/checkpoint/mutating.ts";
import { parseConfig } from "../src/config.ts";
import { carriesCredential } from "../src/extension/features/guard.ts";
import { DISPATCH_ENTRY } from "../src/extension/features/recovery.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import { describePlaces, type Place, readHover, readPlaces, symbolAt } from "../src/lsp/navigation.ts";
import { permissionNeed } from "../src/permissions/modes.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { attended } from "./attended.ts";

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp-server.mjs");

describe("where a symbol is on a line", () => {
	it("is the whole word before a part of one, and the occurrence at the column when it is there twice", () => {
		expect(symbolAt("userid = id;", "id")).toBe(9);
		expect(symbolAt("save(a); save(b);", "save")).toBe(0);
		expect(symbolAt("save(a); save(b);", "save", 11)).toBe(9);
		// Nearest when the column falls between them.
		expect(symbolAt("save(a); save(b);", "save", 8)).toBe(9);
		expect(symbolAt("userIdentity", "Id")).toBe(4);
		expect(symbolAt("nothing here", "save")).toBeUndefined();
	});

	it("is counted in UTF-16 code units, as the protocol counts it: an emoji takes two", () => {
		const line = 'say("🙂"); save();';
		expect(symbolAt(line, "save")).toBe(11);
		expect(symbolAt('说("你好"); save();', "save")).toBe(9);
	});
});

describe("what a server's answer says", () => {
	const pathOf = (uri: string) => (uri.startsWith("file://") ? uri.slice(7) : undefined);
	const range = (line: number, character: number) => ({
		start: { line, character },
		end: { line, character: character + 4 },
	});

	it("reads a location, a list of them and links, which point at the name, keeping each place once", () => {
		expect(readPlaces(null, pathOf)).toEqual([]);
		expect(readPlaces({ uri: "file:///w/a.ts", range: range(2, 4) }, pathOf)).toEqual([
			{ uri: "file:///w/a.ts", path: "/w/a.ts", line: 2, character: 4 },
		]);
		expect(
			readPlaces(
				[
					{ uri: "file:///w/a.ts", range: range(2, 4) },
					{ uri: "file:///w/a.ts", range: range(2, 4) },
					{ uri: "jdt://contents/x", range: range(0, 0) },
					{ nonsense: true },
				],
				pathOf,
			),
		).toEqual([
			{ uri: "file:///w/a.ts", path: "/w/a.ts", line: 2, character: 4 },
			{ uri: "jdt://contents/x", path: undefined, line: 0, character: 0 },
		]);
		// The real path and a link to it are one file.
		const real = (uri: string) => pathOf(uri)?.replace(/^\/private\//, "/");
		expect(
			readPlaces(
				[
					{ uri: "file:///var/a.c", range: range(0, 4) },
					{ uri: "file:///private/var/a.c", range: range(0, 4) },
				],
				real,
			),
		).toEqual([{ uri: "file:///private/var/a.c", path: "/var/a.c", line: 0, character: 4 }]);
		expect(
			readPlaces(
				[{ targetUri: "file:///w/b.ts", targetRange: range(9, 0), targetSelectionRange: range(9, 16) }],
				pathOf,
			),
		).toEqual([{ uri: "file:///w/b.ts", path: "/w/b.ts", line: 9, character: 16 }]);
	});

	it("reads a hover in every shape the protocol allows", () => {
		expect(readHover(null)).toBe("");
		expect(readHover({ contents: { kind: "markdown", value: " **save**: writes " } })).toBe("**save**: writes");
		expect(readHover({ contents: "plain" })).toBe("plain");
		expect(readHover({ contents: [{ language: "ts", value: "function save(): void" }, "Writes it.", ""] })).toBe(
			"```ts\nfunction save(): void\n```\n\nWrites it.",
		);
	});

	it("lists places by file and line, from 1, with the line's text, and says how many it left out", () => {
		const cwd = join(sep, "w");
		const [a, b, lib] = [join(cwd, "src", "a.ts"), join(cwd, "src", "b.ts"), join(sep, "elsewhere", "lib.d.ts")];
		const places: Place[] = [
			{ uri: "u", path: b, line: 4, character: 9 },
			{ uri: "u", path: a, line: 11, character: 16 },
			{ uri: "u", path: a, line: 2, character: 0 },
			{ uri: "u", path: lib, line: 0, character: 0 },
			{ uri: "jdt://x", path: undefined, line: 0, character: 0 },
		];
		const lineOf = (place: Place) => (place.path === a ? `   line ${place.line} ${"x".repeat(200)}` : undefined);
		const text = describePlaces("references", "`save`", places, { cwd, max: 3, lineOf });
		const [head, ...rows] = text.split("\n");
		const local = join("src", "a.ts");
		expect(head).toBe("5 references to `save`, the declaration included. The first 3:");
		expect(rows[0]).toBe(`${lib}:1:1`);
		expect(rows[1]).toBe(`${local}:3:1  line 2 ${"x".repeat(153)}…`);
		expect(rows[2].startsWith(`${local}:12:17  line 11 `)).toBe(true);
		expect(rows[3]).toBe("2 more not shown. Search the text with grep to see them all.");
		expect(describePlaces("definition", "`save`", places.slice(0, 1), { cwd, max: 3, lineOf })).toBe(
			`1 definition of \`save\`:\n${join("src", "b.ts")}:5:10`,
		);
	});
});

describe("the lsp tool", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	async function start(
		extra: {
			server?: Record<string, unknown>;
			lsp?: Record<string, unknown>;
			only?: FeatureName[];
			permissions?: string;
		} = {},
	) {
		const dir = mkdtempSync(join(tmpdir(), "mu-lsp-navigation-"));
		dirs.push(dir);
		const log = join(dir, "server.log");
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					only: extra.only ?? ["lsp"],
					config: parseConfig({
						features: attended({
							memory: false,
							permissions: { mode: extra.permissions ?? "full" },
							lsp: {
								builtin: false,
								quietMs: 40,
								baselineMs: 1000,
								servers: {
									fake: {
										command: process.execPath,
										args: [FAKE_SERVER, JSON.stringify({ log, ...extra.server })],
										extensions: [".fake"],
									},
									absent: { command: "mu-test-no-such-server", extensions: [".nope"] },
								},
								...extra.lsp,
							},
						}),
					}),
				}),
			],
		});
		harnesses.push(harness);
		const write = (name: string, text: string) => writeFileSync(join(harness.tempDir, name), text);
		const starts = () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.split("\n")
						.filter((line) => line.startsWith("start")).length
				: 0;
		/** The results of the model's calls, in order: the text each one returned, and whether it was an error. */
		const results = () =>
			harness.session.messages.flatMap((message) =>
				message.role === "toolResult"
					? [
							{
								text: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
								isError: message.isError,
							},
						]
					: [],
			);
		const ask = async (...calls: Record<string, string | number>[]) => {
			const steps: FauxResponseStep[] = calls.map((args) =>
				fauxAssistantMessage([fauxText("Looking."), fauxToolCall("lsp", args)], { stopReason: "toolUse" }),
			);
			harness.setResponses([...steps, fauxAssistantMessage("Done.")]);
			await harness.session.prompt("Find it.");
			return results().slice(-calls.length);
		};
		return { harness, write, starts, results, ask };
	}

	const project = (write: (name: string, text: string) => void) => {
		write("store.fake", "def save -- writes the record to disk\nimpl save\n");
		write("app.fake", 'say("🙂"); save(record)\nlater: save(again)\n');
	};

	it("finds a definition in another file, from the name or from a column counted in UTF-16", async () => {
		const { write, ask, starts } = await start();
		project(write);
		const [byName, byColumn] = await ask(
			{ op: "definition", path: "app.fake", line: 1, symbol: "save" },
			{ op: "definition", path: "app.fake", line: 1, column: 12 },
		);
		expect(byName).toEqual({
			text: "1 definition of `save`:\nstore.fake:1:5  def save -- writes the record to disk",
			isError: false,
		});
		expect(byColumn.text).toBe(
			"1 definition of the symbol at app.fake:1:12:\nstore.fake:1:5  def save -- writes the record to disk",
		);
		expect(starts()).toBe(1);
	});

	it("lists references with the declaration, at most the configured number, and says how many more", async () => {
		const { write, ask } = await start({ lsp: { navigationResults: 2 } });
		project(write);
		const [references] = await ask({ op: "references", path: "app.fake", line: 2, symbol: "save" });
		expect(references.text.split("\n")).toEqual([
			"4 references to `save`, the declaration included. The first 2:",
			'app.fake:1:12  say("🙂"); save(record)',
			"app.fake:2:8  later: save(again)",
			"2 more not shown. Search the text with grep to see them all.",
		]);
	});

	it("answers implementations and hovers, and links and old-style hovers read the same", async () => {
		const { write, ask } = await start({ server: { links: true, hoverStrings: true } });
		project(write);
		const [implementation, definition, hover] = await ask(
			{ op: "implementation", path: "app.fake", line: 2, symbol: "save" },
			{ op: "definition", path: "app.fake", line: 2, symbol: "save" },
			{ op: "hover", path: "app.fake", line: 2, symbol: "save" },
		);
		expect(implementation.text).toBe("1 implementation of `save`:\nstore.fake:2:6  impl save");
		expect(definition.text).toBe("1 definition of `save`:\nstore.fake:1:5  def save -- writes the record to disk");
		expect(hover.text).toBe("`save`:\n```fake\nsave\n```\n\n-- writes the record to disk");
	});

	it("says plainly when nothing is found, and that a server still loading its project may know later", async () => {
		const { write, ask } = await start({ server: { progressMs: 60_000 } });
		write("app.fake", "ghost()\n");
		const [nothing, hover] = await ask(
			{ op: "definition", path: "app.fake", line: 1, symbol: "ghost" },
			{ op: "hover", path: "app.fake", line: 1, symbol: "ghost" },
		);
		expect(nothing.isError).toBe(false);
		expect(nothing.text).toMatch(
			/^No definitions of `ghost` found\. The language server is still loading the project/,
		);
		expect(hover.text).toMatch(/^No type or documentation for `ghost`\. The language server is still loading/);
	});

	it("asks once more when the server says the content changed under the question", async () => {
		const { write, ask } = await start({ server: { modifiedOnce: true } });
		project(write);
		const [definition] = await ask({ op: "definition", path: "app.fake", line: 1, symbol: "save" });
		expect(definition.text).toContain("store.fake:1:5");
	});

	it("tells the model what to do instead when it cannot ask", async () => {
		const { write, ask } = await start({ server: { noImplementation: true } });
		project(write);
		write("notes.md", "# notes\n");
		write("lib.nope", "x\n");
		const answers = await ask(
			{ op: "implementation", path: "app.fake", line: 1, symbol: "save" },
			{ op: "definition", path: "notes.md", line: 1, symbol: "notes" },
			{ op: "definition", path: "lib.nope", line: 1, symbol: "x" },
			{ op: "definition", path: "gone.fake", line: 1, symbol: "x" },
			{ op: "definition", path: "app.fake", line: 9, symbol: "save" },
			{ op: "definition", path: "app.fake", line: 2, symbol: "record" },
			{ op: "definition", path: "app.fake", line: 2 },
			{ op: "definition", path: "app.fake", line: 2, column: 40 },
		);
		expect(answers.every((answer) => answer.isError)).toBe(true);
		expect(answers.map((answer) => answer.text)).toEqual([
			"fake doesn't answer implementation questions. Ask for references instead, or use grep.",
			"No language server is set up for .md files. Use grep and read.",
			"No language server for .nope files is installed on this machine (mu looks for absent on PATH and installs none). Use grep and read.",
			"gone.fake does not exist.",
			"app.fake has 2 lines; 9 is not one of them.",
			"`record` is not on line 2 of app.fake, which reads: later: save(again)",
			"Give the symbol's name as written on that line (symbol), or its column from 1.",
			"Line 2 of app.fake has 18 columns; 40 is not one of them.",
		]);
	});

	it("says that the project names servers mu ignores until the project is trusted", async () => {
		const { write, ask, harness } = await start();
		mkdirSync(join(harness.tempDir, ".pi"), { recursive: true });
		write(join(".pi", "lsp.json"), JSON.stringify({ servers: { mine: { command: "mine", extensions: [".proj"] } } }));
		write("a.proj", "x\n");
		const [answer] = await ask({ op: "hover", path: "a.proj", line: 1, symbol: "x" });
		expect(answer).toEqual({
			text: "No language server is set up for .proj files. Use grep and read. This project names its own servers in lsp.json, which mu ignores until the user trusts the project (/trust).",
			isError: true,
		});
	});

	it("uses the server the diagnostics already run, and a question is never something to approve", async () => {
		const { write, ask, starts, harness } = await start({
			only: ["lsp", "permissions", "recovery"],
			permissions: "ask",
		});
		project(write);
		const [definition] = await ask({ op: "definition", path: "app.fake", line: 1, symbol: "save" });
		expect(definition).toMatchObject({ isError: false, text: expect.stringContaining("store.fake:1:5") });
		// Asked first, without a person to ask: a call that needed permission would have been refused.
		const dispatched = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === DISPATCH_ENTRY);
		expect(dispatched).toEqual([]);
		expect(starts()).toBe(1);
		// The same setup refuses a call that changes something.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "touch made.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Could not."),
		]);
		await harness.session.prompt("Make the file.");
		expect(existsSync(join(harness.tempDir, "made.txt"))).toBe(false);

		const input = { op: "references", path: "app.fake", line: 1, symbol: "save" };
		expect(permissionNeed("lsp", input, harness.tempDir)).toBeUndefined();
		expect(isMutatingCall("lsp", input)).toBe(false);
		expect(
			carriesCredential("lsp", { ...input, symbol: "sk-live-0123456789abcdef0123" }, [
				"sk-live-0123456789abcdef0123",
			]),
		).toBe(false);
	});

	it("is a capability of the catalog: hidden until opened, then there from the next step", async () => {
		const { write, harness, results } = await start({ only: ["preflight", "catalog", "lsp"] });
		project(write);
		harness.setResponses([fauxAssistantMessage("Hello.")]);
		await harness.session.prompt("Hi.");
		expect(harness.session.getActiveToolNames()).not.toContain("lsp");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find_capability", { open: "lsp:navigation" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("lsp", { op: "definition", path: "app.fake", line: 1, symbol: "save" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("It's in store.fake."),
		]);
		await harness.session.prompt("Where is save defined?");
		expect(harness.session.getActiveToolNames()).toContain("lsp");
		const [opened, definition] = results();
		expect(opened.text).toBe("Code navigation is open. Its tools are available from your next step: lsp");
		expect(definition.text).toContain("store.fake:1:5");
	});

	it("is not there when navigation is switched off", async () => {
		expect((await start()).harness.session.getActiveToolNames()).toContain("lsp");
		expect((await start({ lsp: { navigation: false } })).harness.session.getActiveToolNames()).not.toContain("lsp");
	});
});
