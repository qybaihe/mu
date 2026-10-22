import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../coding-agent/src/core/extensions/types.ts";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { findOnPath, GitMissing, type GitProbe, type GitRun, spawnGit } from "../src/checkpoint/git.ts";
import { isCheckCommand, isMutatingCall, isReadOnlyCommand } from "../src/checkpoint/mutating.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { DecisionEngine } from "../src/decision.ts";
import { turnRewind } from "../src/decisions/turn-rewind.ts";
import {
	CHECKPOINT_ENTRY,
	type CheckpointEntry,
	offNotice,
	REWIND_MESSAGE,
	REWOUND_ENTRY,
} from "../src/extension/features/checkpoint.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { Judge } from "../src/judge.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const yes: Answer = { type: "boolean", probability: 0.95 };
const no: Answer = { type: "boolean", probability: 0.04 };
const unsure: Answer = { type: "boolean", probability: 0.5 };
const deadEnd: MockResponder = (request): Record<string, Answer> =>
	"dead_end" in request.questions ? { dead_end: yes, progress: no } : {};

interface Ui {
	context: ExtensionUIContext;
	notes: string[];
	asked: { kind: "select" | "confirm"; title: string; message?: string }[];
	editor: string;
}

/** A user who answers dialogs from a script; every other UI call is accepted and ignored. */
function scriptedUi(answers: {
	select?: (title: string, options: string[]) => string | undefined;
	confirm?: boolean;
}): Ui {
	const ui: Ui = { notes: [], asked: [], editor: "", context: undefined as unknown as ExtensionUIContext };
	const known: Record<string, unknown> = {
		notify: (message: string) => ui.notes.push(message),
		select: async (title: string, options: string[]) => {
			ui.asked.push({ kind: "select", title });
			return answers.select?.(title, options);
		},
		confirm: async (title: string, message: string) => {
			ui.asked.push({ kind: "confirm", title, message });
			return answers.confirm ?? false;
		},
		getEditorText: () => ui.editor,
		setEditorText: (text: string) => {
			ui.editor = text;
		},
	};
	ui.context = new Proxy(known, {
		get: (target, key) => (key in target ? target[key as string] : () => undefined),
	}) as unknown as ExtensionUIContext;
	return ui;
}

describe("checkpoints and the judged rewind", () => {
	const harnesses: Harness[] = [];
	const temps: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
	});

	interface Started {
		harness: Harness;
		root: string;
		shadow: string;
		provider: MockJudgeProvider;
		events: KyrnPresentationEvent[];
		ui?: Ui;
		file: (path: string) => string | undefined;
		entries: <T>(customType: string) => T[];
		messages: (customType: string) => string[];
	}

	async function start(
		extra: {
			responder?: MockResponder;
			mode?: DecisionMode;
			ui?: Ui;
			navigation?: boolean;
			git?: string;
			run?: GitRun;
			options?: Record<string, unknown>;
		} = {},
	): Promise<Started> {
		const shadow = realpathSync(mkdtempSync(join(tmpdir(), "mu-checkpoints-")));
		temps.push(shadow);
		const provider = new MockJudgeProvider(extra.responder ?? (() => ({})));
		const events: KyrnPresentationEvent[] = [];
		let root = "";
		const path = (name: unknown) => join(root, String(name));
		const tools: AgentTool[] = [
			{
				name: "write",
				label: "write",
				description: "write",
				parameters: Type.Object({}, { additionalProperties: true }),
				execute: async (_id, params) => {
					const input = params as { path: string; content?: string; remove?: boolean };
					if (input.remove) rmSync(path(input.path));
					else {
						mkdirSync(dirname(path(input.path)), { recursive: true });
						writeFileSync(path(input.path), input.content ?? "");
					}
					return { content: [{ type: "text", text: "written" }], details: {} };
				},
			},
			{
				name: "read",
				label: "read",
				description: "read",
				parameters: Type.Object({}, { additionalProperties: true }),
				execute: async () => ({ content: [{ type: "text", text: "contents" }], details: {} }),
			},
			{
				name: "bash",
				label: "bash",
				description: "bash",
				parameters: Type.Object({}, { additionalProperties: true }),
				execute: async (_id, params) => {
					if (String((params as { command?: string }).command).includes("test")) throw new Error("1 test failed");
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			},
		];
		const harness = await createHarness({
			tools,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: extra.mode ?? "active",
					config: parseConfig({ features: { checkpoint: { dir: shadow, ...extra.options } } }),
					only: ["preflight", "monitor", "checkpoint"],
					onPresentation: (event) => events.push(event),
					checkpoint: extra.run ? { run: extra.run } : extra.git ? { run: spawnGit(extra.git) } : undefined,
				}),
			],
		});
		harnesses.push(harness);
		root = harness.tempDir;
		writeFileSync(join(root, "app.ts"), "v1\n");
		writeFileSync(join(root, "notes.md"), "notes\n");
		if (extra.ui || extra.navigation) {
			await harness.session.bindExtensions({
				uiContext: extra.ui?.context,
				mode: "rpc",
				commandContextActions:
					extra.navigation === false
						? undefined
						: {
								waitForIdle: () => harness.session.waitForIdle(),
								navigateTree: async (targetId, options) => ({
									cancelled: (await harness.session.navigateTree(targetId, options)).cancelled,
								}),
								newSession: async () => ({ cancelled: true }),
								fork: async () => ({ cancelled: true }),
								switchSession: async () => ({ cancelled: true }),
								reload: async () => {},
							},
			});
		}
		return {
			harness,
			root,
			shadow,
			provider,
			events,
			ui: extra.ui,
			file: (name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : undefined),
			entries: <T>(customType: string) =>
				harness.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "custom" && entry.customType === customType ? [entry.data as T] : [],
					),
			messages: (customType) =>
				harness.session.messages
					.filter(
						(message) =>
							message.role === "custom" && (message as { customType?: string }).customType === customType,
					)
					.map((message) => String((message as { content?: unknown }).content)),
		};
	}

	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	const userTexts = (harness: Harness) =>
		harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [JSON.stringify(entry.message.content)] : [],
			);

	it("takes one checkpoint before the first change of a turn, and none in a turn that only reads", async () => {
		const { harness, shadow, entries, events } = await start();
		harness.setResponses([
			call("read", { path: "app.ts" }),
			call("bash", { command: "git status" }),
			fauxAssistantMessage("Read it."),
		]);
		await harness.session.prompt("What does app.ts do?");
		expect(entries(CHECKPOINT_ENTRY)).toEqual([]);
		expect(readdirSync(shadow)).toEqual([]);

		harness.setResponses([
			call("write", { path: "app.ts", content: "v2\n" }),
			call("write", { path: "new.ts", content: "new\n" }),
			fauxAssistantMessage("Changed."),
		]);
		await harness.session.prompt("Change app.ts.");

		const taken = entries<CheckpointEntry>(CHECKPOINT_ENTRY);
		expect(taken).toHaveLength(1);
		expect(taken[0]).toMatchObject({ id: 1, turn: 2, label: "Change app.ts." });
		expect(taken[0].commit).toMatch(/^[0-9a-f]{40,64}$/);
		expect(readdirSync(shadow)).toHaveLength(1);
		expect(events.filter((event) => event.kind === "checkpoint.taken").map((event) => event.payload)).toEqual([
			{ id: 1, turn: 2, label: "Change app.ts." },
		]);
		expect(existsSync(join(harness.tempDir, ".git"))).toBe(false);
	});

	it("/rewind takes files and conversation back, leaves the lesson, and /rewind undo takes the rewind back", async () => {
		const ui = scriptedUi({ select: (_title, options) => options[0], confirm: true });
		const { harness, file, entries, messages, events } = await start({ ui, navigation: true });
		harness.setResponses([fauxAssistantMessage("Hello.")]);
		await harness.session.prompt("Hi.");
		harness.setResponses([
			call("write", { path: "app.ts", content: "broken\n" }),
			call("write", { path: "src/extra.ts", content: "extra\n" }),
			call("write", { path: "notes.md", remove: true }),
			fauxAssistantMessage("Refactored."),
		]);
		await harness.session.prompt("Refactor app.ts.");
		await harness.session.prompt("/checkpoints");
		expect(ui.notes.at(-1)).toContain("#1  turn 2");
		expect(ui.notes.at(-1)).toContain("3 files changed since");

		await harness.session.prompt("/rewind");

		expect(ui.asked[0].title).toContain('checkpoint #1, before "Refactor app.ts."');
		expect(ui.asked[0].title).toContain("put back 1 changed: app.ts");
		expect(ui.asked[0].title).toContain("remove 1 created since: src/extra.ts");
		expect(ui.asked[0].title).toContain("bring back 1 deleted since: notes.md");
		expect([file("app.ts"), file("src/extra.ts"), file("notes.md")]).toEqual(["v1\n", undefined, "notes\n"]);
		// The failed attempt has left the context: the branch ends before the request, which is back in the editor.
		expect(userTexts(harness).join()).not.toContain("Refactor app.ts.");
		expect(userTexts(harness).join()).toContain("Hi.");
		expect(ui.editor).toBe("Refactor app.ts.");
		const lesson = messages(REWIND_MESSAGE);
		expect(lesson).toHaveLength(1);
		expect(lesson[0]).toContain("checkpoint #1");
		expect(lesson[0]).toContain("the user went back to this checkpoint");
		expect(lesson[0]).toContain("app.ts, src/extra.ts, notes.md");
		expect(entries(REWOUND_ENTRY)).toMatchObject([{ to: 1, scope: "both", by: "user" }]);
		expect(events.find((event) => event.kind === "rewind.done")?.payload).toMatchObject({
			id: 1,
			scope: "both",
			conversationMoved: true,
			restored: 1,
			removed: 1,
			broughtBack: 1,
		});

		await harness.session.prompt("/rewind undo");
		expect([file("app.ts"), file("src/extra.ts"), file("notes.md")]).toEqual(["broken\n", "extra\n", undefined]);
		expect(userTexts(harness).join()).toContain("Refactor app.ts.");
		expect(events.some((event) => event.kind === "rewind.undone")).toBe(true);
	});

	it("asks before it reverts a file the user changed by hand, and keeps it when told to", async () => {
		const ui = scriptedUi({ select: (_title, options) => options[0], confirm: true });
		const { harness, root, file } = await start({ ui, navigation: true });
		harness.setResponses([
			call("write", { path: "app.ts", content: "agent\n" }),
			call("write", { path: "notes.md", content: "agent notes\n" }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Change both.");
		writeFileSync(join(root, "notes.md"), "my own careful edit\n");

		await harness.session.prompt("/rewind 1 files");

		expect(ui.asked.map((question) => question.kind)).toEqual(["confirm", "select"]);
		expect(ui.asked[1].title).toContain("1 of these files changed after the agent's last action");
		expect(ui.asked[1].title).toContain("notes.md");
		expect(ui.asked[1].title).not.toContain("app.ts");
		expect(file("app.ts")).toBe("v1\n");
		expect(file("notes.md")).toBe("my own careful edit\n");
		// Files only: the conversation stays where it was.
		expect(userTexts(harness).join()).toContain("Change both.");
	});

	it("restores the files and names the one step left when the conversation cannot be moved from here", async () => {
		const ui = scriptedUi({ confirm: true });
		const { harness, file } = await start({ ui, navigation: false });
		harness.setResponses([call("write", { path: "app.ts", content: "broken\n" }), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Break it.");

		await harness.session.prompt("/rewind 1 both");

		expect(file("app.ts")).toBe("v1\n");
		expect(ui.notes.at(-1)).toContain('run /tree and pick the message "Break it."');
		expect(userTexts(harness).join()).toContain("Break it.");
	});

	const failingRun = () => [
		call("write", { path: "app.ts", content: "attempt\n" }),
		call("bash", { command: "npm test" }),
		call("bash", { command: "npm test" }),
		call("bash", { command: "npm test" }),
	];

	it("active with a user: proposes the rewind at a dead end, and on yes starts over from the request with the lesson", async () => {
		const ui = scriptedUi({ confirm: true });
		const { harness, file, messages, provider, events } = await start({ responder: deadEnd, ui, navigation: true });
		let secondAttempt = "";
		harness.setResponses([
			...failingRun(),
			fauxAssistantMessage("never sent: the run was stopped"),
			(context) => {
				secondAttempt = JSON.stringify(context.messages);
				return fauxAssistantMessage("Trying it another way.");
			},
		]);

		await harness.session.prompt("Make the tests pass.");
		await vi.waitFor(() => expect(secondAttempt).not.toBe(""));
		await harness.session.waitForIdle();

		const asked = provider.calls.filter((request) => "dead_end" in request.questions);
		expect(asked).toHaveLength(1);
		expect(asked[0].state).toMatchObject({
			goal: "Make the tests pass.",
			edits_since_checkpoint: 1,
			last_check_failed: true,
		});
		expect((asked[0].state as { recent_steps: string[] }).recent_steps.at(-1)).toBe("bash: npm test -> error");
		expect(ui.asked).toHaveLength(1);
		expect(ui.asked[0].title).toContain("dead end");
		expect(ui.asked[0].message).toContain("the same failing command ran 3 times: npm test");
		expect(ui.asked[0].message).toContain("put back 1 changed: app.ts");
		expect(file("app.ts")).toBe("v1\n");
		// The new attempt sees the lesson and the request, and nothing of the attempt that was abandoned.
		expect(secondAttempt).toContain("it kept failing");
		expect(secondAttempt).toContain("Make the tests pass.");
		expect(secondAttempt).not.toContain("npm test -> error\\n");
		expect(secondAttempt).not.toContain("1 test failed");
		expect(messages(REWIND_MESSAGE)).toHaveLength(1);
		expect(ui.editor).toBe("");
		expect(events.map((event) => event.kind).filter((kind) => kind.startsWith("rewind."))).toEqual([
			"rewind.proposed",
			"rewind.done",
		]);
		expect(events.find((event) => event.kind === "rewind.proposed")?.payload).toMatchObject({
			id: 1,
			restore: 1,
			paths: ["app.ts"],
			triggerCode: "same_command_failed",
			triggerParams: { times: 3 },
		});
	});

	it("active with a user who says no: nothing is undone, and the turn is not asked again", async () => {
		const ui = scriptedUi({ confirm: false });
		const { harness, file, provider } = await start({ responder: deadEnd, ui, navigation: true });
		harness.setResponses([
			...failingRun(),
			call("bash", { command: "make test" }),
			call("bash", { command: "make test" }),
			call("bash", { command: "make test" }),
			fauxAssistantMessage("Still failing."),
		]);

		await harness.session.prompt("Make the tests pass.");

		expect(ui.asked).toHaveLength(1);
		expect(provider.calls.filter((request) => "dead_end" in request.questions)).toHaveLength(1);
		expect(file("app.ts")).toBe("attempt\n");
	});

	it("active with nobody to ask: undoes nothing and tells the model to step back", async () => {
		const { harness, file, messages, entries } = await start({ responder: deadEnd });
		harness.setResponses([...failingRun(), fauxAssistantMessage("I will try something else.")]);

		await harness.session.prompt("Make the tests pass.");

		expect(file("app.ts")).toBe("attempt\n");
		const steers = messages("kyrn.steer").filter((text) => text.includes("dead end"));
		expect(steers).toHaveLength(1);
		expect(steers[0]).toContain("try a different approach");
		expect(entries(REWOUND_ENTRY)).toEqual([]);
	});

	it("shadow only records the verdict, off does not ask, and an unsure judge changes nothing", async () => {
		const ui = scriptedUi({ confirm: true });
		const shadow = await start({ responder: deadEnd, mode: "shadow", ui, navigation: true });
		shadow.harness.setResponses([...failingRun(), fauxAssistantMessage("Still failing.")]);
		await shadow.harness.session.prompt("Make the tests pass.");
		const records = shadow.harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === "kyrn.decision" ? [entry.data as LedgerRecord] : [],
			)
			.filter((record) => record.specId === "turn.rewind");
		expect(records).toMatchObject([{ mode: "shadow", judged: "propose", outcome: "continue", source: "fallback" }]);
		expect(ui.asked).toEqual([]);
		expect(shadow.file("app.ts")).toBe("attempt\n");

		const off = await start({ responder: deadEnd, mode: "off", ui, navigation: true });
		off.harness.setResponses([...failingRun(), fauxAssistantMessage("Still failing.")]);
		await off.harness.session.prompt("Make the tests pass.");
		expect(off.provider.calls.filter((request) => "dead_end" in request.questions)).toEqual([]);
		expect(ui.asked).toEqual([]);

		const hesitant = await start({ responder: () => ({ dead_end: yes, progress: unsure }), ui, navigation: true });
		hesitant.harness.setResponses([...failingRun(), fauxAssistantMessage("Still failing.")]);
		await hesitant.harness.session.prompt("Make the tests pass.");
		expect(ui.asked).toEqual([]);
		expect(hesitant.file("app.ts")).toBe("attempt\n");
	});

	it("without git the tools run as ever, and the feature says so once", async () => {
		const ui = scriptedUi({});
		const { harness, file, entries } = await start({ ui, navigation: true, git: "mu-test-no-such-git-binary" });
		harness.setResponses([call("write", { path: "app.ts", content: "v2\n" }), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Change it.");
		harness.setResponses([call("write", { path: "app.ts", content: "v3\n" }), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Change it again.");

		expect(file("app.ts")).toBe("v3\n");
		expect(entries(CHECKPOINT_ENTRY)).toEqual([]);
		expect(ui.notes.filter((note) => note.includes("git wasn't found"))).toHaveLength(1);
		await harness.session.prompt("/rewind");
		expect(ui.notes.at(-1)).toContain("checkpoints are off");
	});

	/** Two turns that each change a file, then /rewind: what the session said, and what it presented. */
	async function twoTurnsAndRewind(started: Started) {
		const { harness } = started;
		harness.setResponses([call("write", { path: "app.ts", content: "v2\n" }), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Change it.");
		harness.setResponses([call("write", { path: "app.ts", content: "v3\n" }), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Change it again.");
		await harness.session.prompt("/rewind");
		expect(started.file("app.ts")).toBe("v3\n");
		expect(started.entries(CHECKPOINT_ENTRY)).toEqual([]);
		return started.events.filter((event) => event.kind === "checkpoint.off").map((event) => event.payload);
	}

	// QA on macOS, 2026-09-25: with the Xcode license not accepted, git exits 69, and every turn that wrote a file said
	// "mu: no checkpoint for this turn (git init exited with 69: You have not agreed to the Xcode license…)", in English.
	it.skipIf(process.platform === "win32")(
		"an Xcode whose license nobody accepted yet: the tools run as ever, and the session says why once",
		async () => {
			const bin = realpathSync(mkdtempSync(join(tmpdir(), "mu-xcode-git-")));
			temps.push(bin);
			const git = join(bin, "git");
			writeFileSync(
				git,
				`#!/bin/sh\necho "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license." >&2\nexit 69\n`,
				{ mode: 0o755 },
			);
			const ui = scriptedUi({});
			const off = await twoTurnsAndRewind(await start({ ui, navigation: true, git }));
			const line =
				"mu: checkpoints are off because git can't run on this Mac until you accept the Xcode license. Run sudo xcodebuild -license in Terminal to accept it, then start a new session.";
			// Once for the session's first change; /rewind says it again because it was asked.
			expect(ui.notes).toEqual([line, line]);
			expect(off).toEqual([{ code: "xcode_license", params: {}, message: line }]);
		},
	);

	it("never starts git on a Mac without the developer tools, whose /usr/bin/git only opens their installer", async () => {
		const probe: GitProbe = { platform: "darwin", find: () => "/usr/bin/git", hasDeveloperTools: async () => false };
		const ui = scriptedUi({});
		// Started, this binary would be missing and say "git was not found".
		const run = spawnGit("mu-test-no-such-git-binary", 30_000, probe);
		const off = await twoTurnsAndRewind(await start({ ui, navigation: true, run }));
		const line =
			"mu: checkpoints are off because git needs the command line developer tools, which aren't installed on this Mac. Install them with xcode-select --install, then start a new session.";
		expect(ui.notes).toEqual([line, line]);
		expect(off).toEqual([{ code: "developer_tools_missing", params: {}, message: line }]);
	});

	// mu 0.1.3 started in a home folder on a small server: the first change of every turn snapshotted the whole
	// home into ~/.mu, mu's own snapshots included, so the copy grew with every turn.
	it("takes no checkpoint in the home folder, copies nothing, and says why once, in one line", async () => {
		const ui = scriptedUi({});
		const { harness, root, shadow, file, entries, events } = await start({ ui, navigation: true });
		const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
		process.env.HOME = root;
		process.env.USERPROFILE = root;
		try {
			harness.setResponses([call("write", { path: "app.ts", content: "v2\n" }), fauxAssistantMessage("Done.")]);
			await harness.session.prompt("Change it.");
			harness.setResponses([call("write", { path: "app.ts", content: "v3\n" }), fauxAssistantMessage("Done.")]);
			await harness.session.prompt("Change it again.");
			await harness.session.prompt("/checkpoints");
			await harness.session.prompt("/rewind");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}

		expect(file("app.ts")).toBe("v3\n");
		expect(entries(CHECKPOINT_ENTRY)).toEqual([]);
		expect(readdirSync(shadow)).toEqual([]);
		const line =
			"mu: checkpoints are off for this session because this folder is, or contains, your home folder. Start mu in a project folder to use checkpoints.";
		// Once for the session's first change; /checkpoints and /rewind say it again because they were asked.
		expect(ui.notes).toEqual([line, line, line]);
		expect(events.filter((event) => event.kind === "checkpoint.off").map((event) => event.payload)).toEqual([
			{ code: "home_folder", params: {}, message: line },
		]);
	});

	it("goes without checkpoints for the session once a snapshot would take in too many files", async () => {
		const ui = scriptedUi({});
		const { harness, file, entries, events } = await start({ ui, navigation: true, options: { maxFiles: 1 } });
		harness.setResponses([call("write", { path: "app.ts", content: "v2\n" }), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Change it.");
		harness.setResponses([call("write", { path: "app.ts", content: "v3\n" }), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Change it again.");
		await harness.session.prompt("/rewind");

		expect(file("app.ts")).toBe("v3\n");
		expect(entries(CHECKPOINT_ENTRY)).toEqual([]);
		const said = ui.notes.filter((note) => note.includes("more than 1 files to snapshot"));
		expect(said).toHaveLength(2);
		expect(said[0]).toContain("raise features.checkpoint.maxFiles");
		expect(events.filter((event) => event.kind === "checkpoint.off").map((event) => event.payload)).toEqual([
			{ code: "too_many_files", params: { limit: 1 }, message: said[0] },
		]);
	});

	it("says why in the user's language", () => {
		const limits = { maxFiles: 5000, maxTotalMb: 200, timeoutMs: 30_000 };
		const saved = process.env.MU_LANG;
		process.env.MU_LANG = "zh-CN";
		try {
			expect(offNotice("too_many_bytes", limits)).toEqual({
				line: "mu：本次会话不拍检查点，因为这个文件夹要拍的文件加起来超过 200 MB。在项目文件夹里启动 mu 就有检查点，或者调高 features.checkpoint.maxTotalMb。",
				params: { limitMb: 200 },
			});
			expect(offNotice("xcode_license", limits).line).toBe(
				"mu：检查点已关闭，因为这台 Mac 还没有同意 Xcode 许可协议，git 无法运行。在终端里用 sudo xcodebuild -license 同意后，新开一个会话就有检查点。",
			);
			expect(offNotice("developer_tools_missing", limits).line).toBe(
				"mu：检查点已关闭，因为这台 Mac 没有安装 git 所需的命令行开发者工具。用 xcode-select --install 安装后，新开一个会话就有检查点。",
			);
		} finally {
			if (saved === undefined) delete process.env.MU_LANG;
			else process.env.MU_LANG = saved;
		}
		expect(offNotice("too_slow", limits).line).toBe(
			"mu: checkpoints are off for this session because listing this folder's files took more than 30 s. Start mu in a project folder to use checkpoints.",
		);
	});
});

describe("turn.rewind and what counts as a change", () => {
	it("proposes only for a confident dead end with no progress", async () => {
		const verdict = async (dead_end: Answer, progress: Answer) =>
			(
				await new DecisionEngine({
					judge: new Judge({ provider: new MockJudgeProvider(() => ({ dead_end, progress })) }),
					defaultMode: "active",
				}).decide(turnRewind, {
					goal: "g",
					recentSteps: ["bash: npm test -> error"],
					trigger: "t",
					editsSinceCheckpoint: 2,
				})
			).outcome;
		expect(await verdict(yes, no)).toBe("propose");
		expect(await verdict(yes, yes)).toBe("continue");
		expect(await verdict(unsure, no)).toBe("continue");
		expect(await verdict(no, no)).toBe("continue");
		expect(turnRewind.fallback({ goal: "", recentSteps: [], trigger: "", editsSinceCheckpoint: 0 })).toBe("continue");
	});

	it("treats a command as read-only only when every part of it is on the short list", () => {
		for (const command of ["git status", "ls -la src", "cat a.txt | grep -n foo | head -5", "rg TODO packages"]) {
			expect(isReadOnlyCommand(command), command).toBe(true);
		}
		for (const command of [
			"npm test",
			"echo hi > a.txt",
			"cat a.txt | xargs rm",
			"git status && rm -rf build",
			"ls; rm a",
			"cat $(which node)",
			"git diff --output=patch.diff",
			"git checkout -- .",
			"",
		]) {
			expect(isReadOnlyCommand(command), command).toBe(false);
		}
		expect(isMutatingCall("read", { path: "a" })).toBe(false);
		expect(isMutatingCall("bash", { command: "git log -3" })).toBe(false);
		expect(isMutatingCall("bash", { command: "sed -i s/a/b/ x" })).toBe(true);
		// pi's shell on Windows is the powershell tool: read-only cmdlets read, everything else may write.
		expect(isMutatingCall("powershell", { command: "Get-ChildItem src" })).toBe(false);
		expect(isMutatingCall("powershell", { command: "gci src | Select-String TODO" })).toBe(false);
		expect(isMutatingCall("powershell", { command: "Set-Content a.txt hi" })).toBe(true);
		expect(isMutatingCall("powershell", { command: "Get-Content a.txt > b.txt" })).toBe(true);
		expect(isMutatingCall("some_mcp_tool", {})).toBe(true);
		expect(isCheckCommand("npx vitest --run test/a.test.ts")).toBe(true);
		expect(isCheckCommand("npm run build")).toBe(true);
		expect(isCheckCommand("ls")).toBe(false);
	});
});

describe("a git that is there and cannot run", () => {
	const temps: string[] = [];
	afterEach(() => {
		while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
	});

	it("asks after the developer tools once, and only for the git macOS itself puts in /usr/bin", async () => {
		const asked: string[] = [];
		const probe = (platform: NodeJS.Platform, found: string, tools: boolean): GitProbe => ({
			platform,
			find: () => found,
			hasDeveloperTools: async () => {
				asked.push(`${platform} ${found}`);
				return tools;
			},
		});
		const stub = spawnGit("mu-test-no-such-git-binary", 30_000, probe("darwin", "/usr/bin/git", false));
		for (let run = 0; run < 2; run++) {
			await expect(stub(["status"], {})).rejects.toMatchObject({
				name: "GitUnusable",
				reason: "developer_tools_missing",
			});
		}
		// With the tools there, with another git first on PATH, and off macOS, git itself is started (and not found here).
		for (const [platform, found, tools] of [
			["darwin", "/usr/bin/git", true],
			["darwin", "/opt/homebrew/bin/git", false],
			["linux", "/usr/bin/git", false],
		] as const) {
			await expect(
				spawnGit("mu-test-no-such-git-binary", 30_000, probe(platform, found, tools))(["status"], {}),
			).rejects.toBeInstanceOf(GitMissing);
		}
		expect(asked).toEqual(["darwin /usr/bin/git", "darwin /usr/bin/git"]);
	});

	it.skipIf(process.platform === "win32")("finds git where spawn would: the first executable file on PATH", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "mu-find-git-")));
		temps.push(root);
		const first = join(root, "first");
		const second = join(root, "second");
		mkdirSync(first);
		mkdirSync(second);
		writeFileSync(join(first, "git"), "", { mode: 0o644 });
		writeFileSync(join(second, "git"), "#!/bin/sh\n", { mode: 0o755 });
		expect(findOnPath("git", ["", first, second].join(delimiter))).toBe(join(second, "git"));
		expect(findOnPath("git", first)).toBeUndefined();
		expect(findOnPath("git", undefined)).toBeUndefined();
		expect(findOnPath(join(second, "git"), undefined)).toBe(join(second, "git"));
	});
});
