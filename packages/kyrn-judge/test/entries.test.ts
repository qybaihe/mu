import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { ENTRY_TYPES, type EntryType, entryType } from "../src/entries.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { attended } from "./attended.ts";
import { unbumped } from "./golden/golden-support.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = join(root, "test/golden/entries.md");
const DESKTOP = join(root, "../../desktop/packages/desktop/src/common/utils/nativeHost");

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return name.endsWith(".ts") ? [path] : [];
	});
}

interface Written {
	readonly type: string;
	readonly kind: EntryType["kind"];
	readonly file: string;
}

/**
 * What `src` writes, as the code says it: the type given to `appendEntry` (an entry) or set as `customType` (a message),
 * a string or a constant whose string is found anywhere in `src`.
 */
function written(): Written[] {
	const files = sources(join(root, "src"));
	const constants = new Map<string, string>();
	for (const file of files) {
		for (const match of readFileSync(file, "utf8").matchAll(/\bconst ([A-Z][A-Z0-9_]*) = "([^"]+)"/g)) {
			constants.set(match[1], match[2]);
		}
	}
	const found = new Map<string, Written>();
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		const uses = [
			...[...text.matchAll(/appendEntry(?:<[^>(]*>)?\(\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))/g)].map((match) => ({
				kind: "entry" as const,
				match,
			})),
			...[...text.matchAll(/customType:\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))/g)].map((match) => ({
				kind: "message" as const,
				match,
			})),
		];
		for (const { kind, match } of uses) {
			const type = match[1] ?? constants.get(match[2]);
			if (type === undefined) throw new Error(`${relative(root, file)}: ${match[0]} names no string constant`);
			// Forward slashes, as the registry writes paths, on Windows too.
			const at = { type, kind, file: relative(root, file).replaceAll("\\", "/") };
			found.set(`${type} ${kind} ${at.file}`, at);
		}
	}
	return [...found.values()];
}

/** The registry as a file: a table of who writes and reads each type, then one section per type with its schema. */
function render(): string {
	const sorted = [...ENTRY_TYPES].sort((a, b) =>
		a.type === b.type ? a.kind.localeCompare(b.kind) : a.type.localeCompare(b.type),
	);
	const cell = (items: readonly string[]) => (items.length > 0 ? items.join("; ") : "-");
	return `${[
		"# Custom entries and messages in a session",
		"",
		"Written by `entries.test.ts` from `src/entries.ts`. Do not edit by hand. A section that changes needs a new",
		"`version` for its type in `src/entries.ts`; then run the test with `-u`. The table above the sections may change",
		"without one.",
		"",
		"| type | kind | written by | read by | what it is |",
		"|---|---|---|---|---|",
		...sorted.map(
			(entry) =>
				`| \`${entry.type}\` | ${entry.kind} | ${cell(entry.writers)} | ${cell(entry.readers)} | ${entry.summary} |`,
		),
		...sorted.flatMap((entry) => [
			"",
			`## ${entry.type} v${entry.version}`,
			"",
			entry.schema
				? `A ${entry.kind}, read by another program:`
				: `A ${entry.kind}. No schema: no other program reads it.`,
			...(entry.schema ? ["", "```json", JSON.stringify(entry.schema, null, "\t"), "```"] : []),
		]),
	].join("\n")}\n`;
}

describe("the custom entries and messages kyrn writes", () => {
	it("are each registered, with the files that write them, and each registered one is still written", () => {
		const found = written();
		const missing = found
			.filter((at) => !entryType(at.type, at.kind)?.writers.includes(at.file))
			.map((at) => `${at.type} (${at.kind}) in ${at.file}`);
		expect(missing, "add these to src/entries.ts, or the file to its writers").toEqual([]);
		const stale = ENTRY_TYPES.flatMap((entry) =>
			entry.writers
				.filter((file) => !found.some((at) => at.type === entry.type && at.kind === entry.kind && at.file === file))
				.map((file) => `${entry.type} (${entry.kind}) in ${file}`),
		);
		expect(stale, "src/entries.ts names writers that no longer write these").toEqual([]);
		const keys = ENTRY_TYPES.map((entry) => `${entry.type} ${entry.kind}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("include every entry the desktop app reads, each with a schema and the app among its readers", () => {
		const read = ["reducer.ts", "settings.ts"].flatMap((name) =>
			[...readFileSync(join(DESKTOP, name), "utf8").matchAll(/export const [A-Z_]+_ENTRY = '([^']+)'/g)].map(
				(match) => ({ type: match[1], file: name }),
			),
		);
		expect(read.length).toBeGreaterThanOrEqual(6);
		for (const { type, file } of read) {
			const entry = entryType(type, "entry");
			expect(entry?.schema, type).toBeDefined();
			expect(entry?.readers, type).toContain(`desktop: nativeHost/${file}`);
		}
	});

	it("are as recorded, and a type whose section changed has a new version", async () => {
		const rendered = render();
		let recorded = "";
		try {
			recorded = readFileSync(GOLDEN, "utf8");
		} catch {
			// Not written yet: the snapshot below writes it.
		}
		expect(unbumped(recorded, rendered), "these changed: bump their version, then run with -u").toEqual([]);
		await expect(rendered).toMatchFileSnapshot(GOLDEN);
	});
});

describe("what sessions of mu write", () => {
	const harnesses: Harness[] = [];
	const temps: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
	});

	const tool = (name: string, execute?: AgentTool["execute"]): AgentTool => ({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: execute ?? (async () => ({ content: [{ type: "text", text: "ok" }], details: {} })),
	});

	/** A session whose permission questions are answered "Allow once". */
	async function start(features: Record<string, unknown>, tools: AgentTool[], only?: string[]) {
		const harness = await createHarness({
			tools,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(),
					mode: "active",
					config: parseConfig({ features }),
					...(only ? { only: only as never } : {}),
				}),
			],
		});
		harnesses.push(harness);
		const known: Record<string, unknown> = {
			select: async (_title: string, options: string[]) =>
				options.find((option) => option.startsWith("Allow once")) ?? options[0],
			setStatus: () => undefined,
			notify: () => undefined,
		};
		const ui = new Proxy(known, {
			get: (target, key) => (key in target ? target[key as string] : () => undefined),
		}) as unknown as ExtensionUIContext;
		await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		return harness;
	}

	interface Seen {
		readonly type: string;
		readonly kind: EntryType["kind"];
		readonly data: unknown;
	}

	/** Every custom entry and message of a session, as the file holds it. */
	const customOf = (harness: Harness): Seen[] =>
		harness.sessionManager.getEntries().flatMap((entry): Seen[] => {
			if (entry.type === "custom")
				return [
					{ type: entry.customType, kind: "entry" as const, data: JSON.parse(JSON.stringify(entry.data ?? null)) },
				];
			if (entry.type === "custom_message")
				return [{ type: entry.customType, kind: "message" as const, data: undefined }];
			return [];
		});

	/**
	 * Of the types with a schema, these runs do not write `kyrn.subagent-session` (no sub-agent runs) or `kyrn.monitor`
	 * (no drift check or loop happens in a few steps); their schemas are held to the code by hand.
	 */
	it("writes only registered types, and each entry another program reads fits its schema", async () => {
		const shadow = realpathSync(mkdtempSync(join(tmpdir(), "mu-entries-")));
		temps.push(shadow);
		let project = "";
		const write = tool("write", async (_id, params) => {
			const input = params as { path: string; content?: string };
			mkdirSync(dirname(join(project, input.path)), { recursive: true });
			writeFileSync(join(project, input.path), input.content ?? "");
			return { content: [{ type: "text", text: "written" }], details: {} };
		});
		// Judge mode as in an interactive session, every feature on: a permission switch, a change, a command the
		// judge cannot tell about and the user allows, and a verdict the user marks wrong.
		const judged = await start(
			attended({
				memory: false,
				permissions: { mode: "judge" },
				checkpoint: { dir: shadow },
				board: { defaultOn: true, model: "session" },
			}),
			[write, tool("bash"), tool("read")],
		);
		project = judged.tempDir;
		await judged.session.prompt("/permissions ask --here");
		await judged.session.prompt("/permissions judge --here");
		judged.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "src/parse.ts", content: "export const x = 1;\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm publish" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Fixed parseDuration and published the package."),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Done."),
		]);
		await judged.session.prompt("Fix the parseDuration test in src/parse.ts, then publish the package.");
		await vi.waitFor(() => expect(customOf(judged).some((entry) => entry.type === "kyrn.board")).toBe(true));
		const record = customOf(judged).find((entry) => entry.type === "kyrn.decision")?.data as { id: string };
		await judged.session.prompt(`/ledger wrong ${record.id} it asked about nothing`);

		// A goal the agent is sent back to work for.
		const goal = await start(
			{ memory: false, goal: { checker: "jev" } },
			[tool("bash")],
			["preflight", "goal", "completion"],
		);
		goal.setResponses([
			fauxAssistantMessage("I had a first look."),
			fauxAssistantMessage("Every test passes now."),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Done."),
		]);
		await goal.session.prompt("/goal every test passes");
		await goal.session.waitForIdle();

		const all = [...customOf(judged), ...customOf(goal)];
		const unregistered = all.filter((entry) => !entryType(entry.type, entry.kind));
		expect(unregistered.map((entry) => `${entry.type} (${entry.kind})`)).toEqual([]);
		const misfits = all.flatMap((entry) => {
			const schema = entryType(entry.type, entry.kind)?.schema;
			if (!schema || Value.Check(schema, entry.data)) return [];
			const why = [...Value.Errors(schema, entry.data)].map((error) => `${error.instancePath} ${error.message}`);
			return [`${entry.type}: ${why.slice(0, 3).join("; ")} in ${JSON.stringify(entry.data).slice(0, 300)}`];
		});
		expect(misfits).toEqual([]);
		const types = new Set(all.map((entry) => entry.type));
		for (const type of [
			"kyrn.decision",
			"kyrn.outcome",
			"kyrn.verdict",
			"kyrn.goal",
			"kyrn.checkpoint",
			"kyrn.board",
			"mu.permissions",
		])
			expect(types, type).toContain(type);
		const outcomes = all
			.filter((entry) => entry.type === "kyrn.outcome")
			.map((entry) => (entry.data as { kind: string }).kind);
		expect(new Set(outcomes)).toEqual(new Set(["permission", "mark"]));
	}, 60_000);
});
