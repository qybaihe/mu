import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { type GitProbe, UNUSABLE_TEXT } from "../src/checkpoint/git.ts";
import { parseConfig } from "../src/config.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import {
	applyPlan,
	type Change,
	type CommitPlan,
	parsePlanReply,
	readChange,
	rulePlan,
	validatePlan,
} from "../src/packs/commit.ts";
import { type Runner, run } from "../src/packs/exec.ts";
import { gitOver, repoState } from "../src/packs/git.ts";
import { filePatch } from "../src/packs/unified-diff.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { initRepo, sh, tempArea } from "./fixtures/git-repo.ts";

const git = gitOver(run);
/** Everything a commit needs, and no hooks from the machine's own git configuration. */
const LOCAL = { "user.name": "t", "user.email": "t@t", "commit.gpgsign": "false", "core.hooksPath": ".git/no-hooks" };

const numbered = (count: number, change: Record<number, string> = {}) =>
	`${Array.from({ length: count }, (_line, index) => change[index + 1] ?? `line ${index + 1}`).join("\n")}\n`;

/** The two hunks of a.txt, top first. */
const hunksOfA = (change: Change) =>
	change.units.filter((unit) => unit.label.startsWith("a.txt")).map((unit) => unit.id);

const unitOf = (change: Change, fragment: string) => {
	const unit = change.units.find((candidate) => candidate.label.includes(fragment));
	if (!unit)
		throw new Error(`no unit for ${fragment}: ${change.units.map((candidate) => candidate.label).join(" | ")}`);
	return unit.id;
};

describe("/commit: a change split into commits", () => {
	const temps: string[] = [];
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
	});

	/** A repository with one commit, then: two far-apart edits in one file, an edit, a rename with an edit, a binary edit, a staged new file, an untracked file. */
	function changedRepo(): string {
		const { root, dir } = tempArea("mu-commit-");
		temps.push(root);
		const repo = initRepo(
			join(dir, "repo"),
			{
				"a.txt": numbered(30),
				"b.txt": "b\n",
				"old.txt": numbered(12),
				"bin.dat": Buffer.from([0, 1, 2, 3, 250, 251, 0, 7]),
			},
			LOCAL,
		);
		writeFileSync(join(repo, "a.txt"), numbered(30, { 2: "line 2 changed", 28: "line 28 changed" }));
		writeFileSync(join(repo, "b.txt"), "b changed\n");
		sh(repo, "mv", "old.txt", "new.txt");
		writeFileSync(join(repo, "new.txt"), numbered(12, { 6: "renamed and edited" }));
		writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 9, 250, 251, 0, 7, 8]));
		writeFileSync(join(repo, "c.txt"), "new file\n");
		sh(repo, "add", "c.txt");
		writeFileSync(join(repo, "u.txt"), "not tracked\n");
		return repo;
	}

	async function changeOf(repo: string) {
		const state = await repoState(git, repo);
		if (!state.ok) throw new Error(state.message);
		return { state, change: await readChange(git, state.root, state.head) };
	}

	it("reads the change as hunks and whole files, and never untracked files", async () => {
		const { change } = await changeOf(changedRepo());
		const labels = change.units.map((unit) => unit.label);
		expect(labels.filter((label) => label.startsWith("a.txt"))).toHaveLength(2);
		expect(labels.some((label) => label.startsWith("old.txt renamed to new.txt"))).toBe(true);
		expect(labels.some((label) => label.includes("bin.dat") && label.includes("binary"))).toBe(true);
		expect(labels.some((label) => label.startsWith("new file c.txt"))).toBe(true);
		expect(change.untracked).toEqual(["u.txt"]);
		expect(change.recentSubjects).toEqual(["init"]);
	});

	it("makes the commits in the planned order, the second hunk of a file before its first", async () => {
		const repo = changedRepo();
		const { state, change } = await changeOf(repo);
		const plan: CommitPlan = {
			source: "model",
			commits: [
				{ message: "Change the end of a", units: [hunksOfA(change)[1], unitOf(change, "new file c.txt")] },
				{
					message: "Change the rest",
					units: [
						hunksOfA(change)[0],
						unitOf(change, "b.txt"),
						unitOf(change, "bin.dat"),
						unitOf(change, "renamed"),
					],
				},
			],
		};
		expect(validatePlan(plan, change.units)).toEqual([]);

		const outcome = await applyPlan(git, state, change, plan);

		expect(outcome.status).toBe("done");
		expect(sh(repo, "log", "--format=%s").trim().split("\n")).toEqual([
			"Change the rest",
			"Change the end of a",
			"init",
		]);
		// The first commit holds the end of a.txt only, and the new file.
		expect(sh(repo, "show", "HEAD~1:a.txt")).toBe(numbered(30, { 28: "line 28 changed" }));
		expect(sh(repo, "show", "HEAD~1:c.txt")).toBe("new file\n");
		expect(sh(repo, "show", "HEAD~1:b.txt")).toBe("b\n");
		// Everything that was tracked is committed, byte for byte; the untracked file is left alone.
		expect(sh(repo, "status", "--porcelain")).toBe("?? u.txt\n");
		expect(sh(repo, "show", "HEAD:a.txt")).toBe(readFileSync(join(repo, "a.txt"), "utf8"));
		expect(sh(repo, "diff", "--stat", "HEAD~1", "HEAD", "--", "bin.dat")).toContain("Bin");
	});

	it("puts a later hunk where it belongs after an earlier one moved the lines, even among identical lines", async () => {
		const { root, dir } = tempArea("mu-commit-");
		temps.push(root);
		// Forty identical lines: a hunk placed two lines off still matches its context, and would land there silently.
		const same = (count: number) => "x\n".repeat(count);
		const repo = initRepo(join(dir, "repo"), { "e.txt": same(40) }, LOCAL);
		writeFileSync(join(repo, "e.txt"), `${same(2)}y1\ny2\ny3\n${same(26)}z\n${same(10)}`);
		const { state, change } = await changeOf(repo);
		const [top, bottom] = change.units.map((unit) => unit.id);
		const file = change.files[0];
		const [first, second] = file.hunks;
		expect(second).toBeDefined();
		// How git aligns identical lines is its own business; what matters is that the top hunk moves the rest.
		const moved = first.newLines - first.oldLines;
		expect(moved).not.toBe(0);
		// Alone, the bottom hunk's new side has not moved yet; after the top one, its old side has.
		expect(filePatch(file, new Set([second.index]), new Set())).toContain(
			`@@ -${second.oldStart},${second.oldLines} +${second.newStart - moved},${second.newLines} @@`,
		);
		expect(filePatch(file, new Set([second.index]), new Set([first.index]))).toContain(
			`@@ -${second.oldStart + moved},${second.oldLines} +${second.newStart},${second.newLines} @@`,
		);

		const outcome = await applyPlan(git, state, change, {
			source: "model",
			commits: [
				{ message: "Top", units: [top] },
				{ message: "Bottom", units: [bottom] },
			],
		});

		expect(outcome.status).toBe("done");
		expect(sh(repo, "status", "--porcelain")).toBe("");
		const afterTop = sh(repo, "show", "HEAD~1:e.txt");
		expect(afterTop.startsWith(`${same(2)}y1\ny2\ny3\n`)).toBe(true);
		expect(afterTop.split("\n").length - 1).toBe(40 + moved);
		expect(afterTop).not.toContain("z");
	});

	it.skipIf(process.platform === "win32")(
		"leaves HEAD and the index as they were when a hook refuses a commit halfway",
		async () => {
			const repo = changedRepo();
			// The user had staged part of the change themselves.
			sh(repo, "add", "b.txt");
			const hooks = join(repo, "..", "hooks");
			mkdirSync(hooks);
			writeFileSync(
				join(hooks, "pre-commit"),
				"#!/bin/sh\nif git diff --cached --name-only | grep -q '^b.txt$'; then echo 'b.txt is frozen' >&2; exit 1; fi\nexit 0\n",
			);
			chmodSync(join(hooks, "pre-commit"), 0o755);
			sh(repo, "config", "core.hooksPath", hooks);
			const head = sh(repo, "rev-parse", "HEAD");
			const index = readFileSync(join(repo, ".git", "index"));
			const status = sh(repo, "status", "--porcelain");
			const { state, change } = await changeOf(repo);
			const ofA = (unit: { label: string }) => unit.label.startsWith("a.txt");
			const plan: CommitPlan = {
				source: "model",
				commits: [
					{ message: "Change a", units: change.units.filter(ofA).map((unit) => unit.id) },
					{ message: "Change the rest", units: change.units.filter((unit) => !ofA(unit)).map((unit) => unit.id) },
				],
			};
			expect(validatePlan(plan, change.units)).toEqual([]);

			const outcome = await applyPlan(git, state, change, plan);

			expect(outcome).toMatchObject({ status: "failed" });
			if (outcome.status !== "failed") return;
			expect(outcome.step).toContain("commit 2");
			expect(outcome.reason).toContain("b.txt is frozen");
			expect(outcome.undone).toHaveLength(1);
			expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
			expect(readFileSync(join(repo, ".git", "index")).equals(index)).toBe(true);
			expect(sh(repo, "status", "--porcelain")).toBe(status);
		},
	);

	it("touches nothing when someone committed while the plan was being read", async () => {
		const repo = changedRepo();
		const { state, change } = await changeOf(repo);
		// Another terminal commits between the plan and the "yes".
		sh(repo, "add", "b.txt");
		sh(repo, "commit", "-q", "-m", "Someone else's commit");
		const head = sh(repo, "rev-parse", "HEAD");
		const index = readFileSync(join(repo, ".git", "index"));

		const outcome = await applyPlan(git, state, change, rulePlan(change));

		expect(outcome).toMatchObject({ status: "failed", step: "checking HEAD", undone: [] });
		if (outcome.status === "failed") expect(outcome.reason).toContain("run /commit again");
		expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
		expect(sh(repo, "log", "-n", "1", "--format=%s").trim()).toBe("Someone else's commit");
		expect(readFileSync(join(repo, ".git", "index")).equals(index)).toBe(true);
	});

	it("makes the first commit of a repository that has none yet", async () => {
		const { root, dir } = tempArea("mu-commit-");
		temps.push(root);
		const repo = join(dir, "fresh");
		mkdirSync(repo);
		sh(repo, "init", "-q", "-b", "main", ".");
		for (const [key, value] of Object.entries(LOCAL)) sh(repo, "config", key, value);
		writeFileSync(join(repo, "x.txt"), "x\n");
		writeFileSync(join(repo, "y.txt"), "y\n");
		sh(repo, "add", "x.txt", "y.txt");
		const { state, change } = await changeOf(repo);
		expect(state.head).toBeUndefined();

		const outcome = await applyPlan(git, state, change, {
			source: "model",
			commits: [
				{ message: "Add x", units: [unitOf(change, "x.txt")] },
				{ message: "Add y", units: [unitOf(change, "y.txt")] },
			],
		});

		expect(outcome.status).toBe("done");
		expect(sh(repo, "log", "--format=%s").trim().split("\n")).toEqual(["Add y", "Add x"]);
		expect(sh(repo, "log", "--max-parents=0", "--format=%s").trim()).toBe("Add x");
		expect(sh(repo, "status", "--porcelain")).toBe("");
	});

	it("takes a model's plan only when every unit is in exactly one commit", async () => {
		const { change } = await changeOf(changedRepo());
		const ids = change.units.map((unit) => unit.id);
		expect(parsePlanReply("I would split it by feature.")).toMatchObject({
			ok: false,
			problem: "no JSON object in the reply",
		});
		expect(parsePlanReply("{not json}")).toMatchObject({ ok: false });
		expect(parsePlanReply('{"commits":[]}')).toMatchObject({ ok: false, problem: "no commits in the reply" });
		expect(parsePlanReply('{"commits":[{"units":["u1"]}]}')).toMatchObject({
			ok: false,
			problem: "a commit has no message",
		});
		const parsed = parsePlanReply(`Here: {"commits":[{"message":"All of it","units":${JSON.stringify(ids)}}]}`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(validatePlan(parsed.plan, change.units)).toEqual([]);

		const problems = validatePlan(
			{
				source: "model",
				commits: [
					{ message: "One", units: [ids[0], ids[0], "u99"] },
					{ message: "Two", units: ids.slice(1, -1) },
				],
			},
			change.units,
		);
		expect(problems).toContain("commit 1 names an unknown unit u99");
		expect(problems).toContain(`unit ${ids[0]} is in 2 commits`);
		expect(problems).toContain(`not in any commit: ${ids.at(-1)}`);

		// Without a model: one commit per file, named by what happened to it.
		const byFile = rulePlan(change).commits.map((commit) => commit.message);
		expect(byFile).toContain("Add c.txt");
		expect(byFile).toContain("a.txt");
		expect(validatePlan(rulePlan(change), change.units)).toEqual([]);
	});

	describe("the command", () => {
		interface Ui {
			context: ExtensionUIContext;
			notes: string[];
			asked: string[];
		}
		function scriptedUi(confirm: boolean): Ui {
			const ui: Ui = { notes: [], asked: [], context: undefined as unknown as ExtensionUIContext };
			const known: Record<string, unknown> = {
				notify: (message: string) => ui.notes.push(message),
				confirm: async (_title: string, message: string) => {
					ui.asked.push(message);
					return confirm;
				},
			};
			ui.context = new Proxy(known, {
				get: (target, key) => (key in target ? target[key as string] : () => undefined),
			}) as unknown as ExtensionUIContext;
			return ui;
		}

		async function session(ui?: Ui): Promise<{ harness: Harness; repo: string }> {
			const harness = await createHarness({
				extensionFactories: [
					createKyrnJudgeExtension({
						provider: new MockJudgeProvider(() => ({})),
						mode: "active",
						config: parseConfig({ features: { memory: false } }),
						only: ["preflight", "packs"],
					}),
				],
			});
			harnesses.push(harness);
			const repo = harness.tempDir;
			sh(repo, "init", "-q", "-b", "main", ".");
			for (const [key, value] of Object.entries(LOCAL)) sh(repo, "config", key, value);
			// Whatever the session keeps in its folder is not part of the project.
			writeFileSync(join(repo, ".git", "info", "exclude"), "*\n!a.txt\n!b.txt\n");
			writeFileSync(join(repo, "a.txt"), numbered(30));
			writeFileSync(join(repo, "b.txt"), "b\n");
			sh(repo, "add", "a.txt", "b.txt");
			sh(repo, "commit", "-qm", "init");
			writeFileSync(join(repo, "a.txt"), numbered(30, { 2: "top", 28: "bottom" }));
			writeFileSync(join(repo, "b.txt"), "b changed\n");
			if (ui) await harness.session.bindExtensions({ uiContext: ui.context, mode: "rpc" });
			return { harness, repo };
		}
		const log = (repo: string) => sh(repo, "log", "--format=%s").trim().split("\n");

		it("asks with the plan, then commits what the model proposed, with the user's guidance in the request", async () => {
			const ui = scriptedUi(true);
			const { harness, repo } = await session(ui);
			let request = "";
			harness.setResponses([
				(context) => {
					request = JSON.stringify(context.messages);
					return fauxAssistantMessage(
						JSON.stringify({
							commits: [
								{ message: "feat: change the bottom of a", units: ["u2"] },
								{ message: "fix: change the top of a and b", units: ["u1", "u3"] },
							],
						}),
					);
				},
			]);

			await harness.session.prompt("/commit keep the bottom apart");

			expect(request).toContain("GUIDANCE FROM THE USER");
			expect(request).toContain("keep the bottom apart");
			expect(ui.asked).toHaveLength(1);
			expect(ui.asked[0]).toContain("1. feat: change the bottom of a");
			expect(ui.asked[0]).toContain("Nothing will be pushed");
			expect(log(repo)).toEqual(["fix: change the top of a and b", "feat: change the bottom of a", "init"]);
			expect(ui.notes.at(-1)).toContain("Made 2 commits");
		});

		it("sends a plan that misses a unit back once, then falls back to one commit per file", async () => {
			const ui = scriptedUi(true);
			const { harness, repo } = await session(ui);
			const incomplete = fauxAssistantMessage('{"commits":[{"message":"a only","units":["u1","u2"]}]}');
			harness.setResponses([incomplete, incomplete]);

			await harness.session.prompt("/commit");

			expect(harness.getPendingResponseCount()).toBe(0);
			expect(ui.asked[0]).toContain("wasn't usable (not in any commit: u3)");
			expect(log(repo)).toEqual(["b.txt", "a.txt", "init"]);
		});

		it("asks and answers in Chinese when the app is in Chinese", async () => {
			vi.stubEnv("MU_LANG", "zh-CN");
			const refusing = scriptedUi(false);
			const { harness, repo } = await session(refusing);
			harness.setResponses([fauxAssistantMessage('{"commits":[{"message":"all","units":["u1","u2","u3"]}]}')]);
			await harness.session.prompt("/commit");
			expect(refusing.asked.at(-1)).toContain("做这个提交？不会推送。");
			expect(refusing.notes.at(-1)).toBe("什么都没有提交。");
			expect(log(repo)).toEqual(["init"]);
		});

		// Found with the QA fixes, 2026-09-25: the packs started git without the Mac check checkpoints have.
		it.skipIf(process.platform === "win32")(
			"says in the user's words that git cannot run on this Mac, and asks nothing",
			async () => {
				const ui = scriptedUi(true);
				const { harness, repo } = await session(ui);
				const bin = mkdtempSync(join(tmpdir(), "mu-commit-git-"));
				temps.push(bin);
				writeFileSync(
					join(bin, "git"),
					`#!/bin/sh\necho "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'." >&2\nexit 69\n`,
					{ mode: 0o755 },
				);
				// Only while /commit runs: the repository is read with the real git.
				vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
				try {
					await harness.session.prompt("/commit");
				} finally {
					vi.unstubAllEnvs();
				}
				expect(ui.notes).toEqual([
					"/commit can't run: git can't run on this Mac until you accept the Xcode license. Run sudo xcodebuild -license in Terminal to accept it, then try again.",
				]);
				expect(ui.asked).toEqual([]);
				expect(log(repo)).toEqual(["init"]);
			},
		);

		it("commits nothing when the user says no, or when there is nobody to ask", async () => {
			const refusing = scriptedUi(false);
			const first = await session(refusing);
			first.harness.setResponses([fauxAssistantMessage('{"commits":[{"message":"all","units":["u1","u2","u3"]}]}')]);
			await first.harness.session.prompt("/commit");
			expect(log(first.repo)).toEqual(["init"]);
			expect(refusing.notes.at(-1)).toBe("Nothing was committed.");

			const alone = await session();
			alone.harness.setResponses([fauxAssistantMessage('{"commits":[{"message":"all","units":["u1","u2","u3"]}]}')]);
			await alone.harness.session.prompt("/commit");
			expect(alone.harness.getPendingResponseCount()).toBe(0);
			expect(log(alone.repo)).toEqual(["init"]);
			expect(sh(alone.repo, "status", "--porcelain")).toBe(" M a.txt\n M b.txt\n");
		});
	});
});

describe("the packs' git on a Mac where git cannot run", () => {
	const mac = (developerTools: boolean): GitProbe => ({
		platform: "darwin",
		find: () => "/usr/bin/git",
		hasDeveloperTools: vi.fn(async () => developerTools),
	});
	const answering =
		(code: number, stderr: string, calls: string[][] = []): Runner =>
		async (_command, args) => {
			calls.push([...args]);
			return { code, stdout: "", stderr, missing: false, stopped: false };
		};

	it("never starts the system's stub without the developer tools, and looks once", async () => {
		const probe = mac(false);
		const calls: string[][] = [];
		const git = gitOver(answering(0, "", calls), "git", probe);
		expect(await repoState(git, "/work")).toEqual({
			ok: false,
			reason: "unusable",
			unusable: "developer_tools_missing",
			message: UNUSABLE_TEXT.developer_tools_missing,
		});
		expect((await git(["status"], { cwd: "/work" })).unusable).toBe("developer_tools_missing");
		expect(calls).toEqual([]);
		expect(probe.hasDeveloperTools).toHaveBeenCalledTimes(1);
	});

	it("reads an exit 69 that names the Xcode license as git held back, not as a folder outside a repository", async () => {
		const held = answering(
			69,
			"You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'.",
		);
		expect(await repoState(gitOver(held, "git", mac(true)), "/work")).toEqual({
			ok: false,
			reason: "unusable",
			unusable: "xcode_license",
			message: UNUSABLE_TEXT.xcode_license,
		});
		const other = answering(69, "fatal: something else");
		expect(await repoState(gitOver(other, "git", mac(true)), "/work")).toMatchObject({ reason: "not-a-repo" });
	});
});
