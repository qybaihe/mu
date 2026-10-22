import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { DecisionEngine, type DecisionMode } from "../src/decision.ts";
import { describePatchReview, MAX_JUDGED_FILES, swarmPatch } from "../src/decisions/swarm-patch.ts";
import { childArgs, type SwarmAssignment, type SwarmRunner, type SwarmTask } from "../src/extension/features/swarm.ts";
import { editsFiles, rebase } from "../src/extension/features/swarm-isolation.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";
import { initRepo, sh } from "./fixtures/git-repo.ts";

const yes: Answer = { type: "boolean", probability: 0.95 };
const no: Answer = { type: "boolean", probability: 0.04 };

/** Answers the patch review: the change is within the task, and the named files are not called for. */
const review =
	(...unrelated: string[]): MockResponder =>
	(request) => {
		if (!("within_task" in request.questions)) return {};
		return Object.fromEntries(
			Object.entries(request.questions).map(([id, question]) => [
				id,
				unrelated.some((path) => String(question.instructions).includes(path)) ? no : yes,
			]),
		);
	};

const lines = (count: number) => `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
const resultTexts = (harness: Harness): string[] =>
	harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => JSON.stringify((message as { content?: unknown }).content));
const patchIds = (text: string): string[] => [...text.matchAll(/Patch (p-[0-9a-f]{6}):/g)].map((match) => match[1]);

describe("delegate with worktree isolation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(
		runner: SwarmRunner,
		extra: {
			responder?: MockResponder;
			mode?: DecisionMode;
			/** swarm.patch is off by default; the tests of what it says switch it on. */
			patchReview?: DecisionMode;
			swarm?: Record<string, unknown>;
			files?: Record<string, string> | null;
			events?: KyrnPresentationEvent[];
		} = {},
	): Promise<Harness & { repo: string }> {
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(extra.responder ?? review()),
					mode: extra.mode ?? "active",
					config: parseConfig({
						...(extra.patchReview ? { modes: { "swarm.patch": extra.patchReview } } : {}),
						features: { memory: false, browser: false, swarm: { enabled: true, ...extra.swarm } },
					}),
					swarmRunner: runner,
					only: ["swarm"],
					onPresentation: (event) => extra.events?.push(event),
				}),
			],
		});
		harnesses.push(harness);
		// The session's working directory becomes a real repository, unless the test wants none.
		if (extra.files !== null)
			initRepo(harness.tempDir, extra.files ?? { "src/a.txt": lines(12), ".gitignore": "models.json\n" });
		return Object.assign(harness, { repo: realpathSync(harness.tempDir) });
	}

	const delegate = (tasks: Record<string, string>[]) =>
		fauxAssistantMessage([fauxToolCall("delegate", { tasks })], { stopReason: "toolUse" });
	const applyFrom = (args: Record<string, string>) =>
		fauxAssistantMessage([fauxToolCall("apply_patch_from", args)], { stopReason: "toolUse" });

	it("runs a worker in its own checkout, hands back a patch with the judge's view, and applies it only when asked", async () => {
		const seen: { task: SwarmTask; assignment: SwarmAssignment; env?: Readonly<Record<string, string>> }[] = [];
		const events: KyrnPresentationEvent[] = [];
		const harness = await start(
			async (task, assignment, _signal, env) => {
				seen.push({ task, assignment, env });
				const cwd = assignment.cwd ?? "";
				writeFileSync(
					join(cwd, "src/a.txt"),
					readFileSync(join(cwd, "src/a.txt"), "utf8").replace("line 2\n", "line 2, renamed\n"),
				);
				writeFileSync(join(cwd, "package-lock.json"), "{}\n");
				return "**Done** src/a.txt:2";
			},
			{ responder: review("package-lock.json"), events, patchReview: "active" },
		);
		// The parent is in the middle of something: the worker has to see it, the patch must not contain it.
		writeFileSync(join(harness.repo, "src/a.txt"), lines(12).replace("line 11\n", "line 11, parent's edit\n"));
		let beforeApply = "";
		harness.setResponses([
			delegate([{ title: "rename", instructions: `Rename line 2 in ${harness.repo}/src/a.txt`, agent: "worker" }]),
			(context) => {
				beforeApply = readFileSync(join(harness.repo, "src/a.txt"), "utf8");
				const [id] = patchIds(JSON.stringify(context.messages));
				return applyFrom({ id, action: "stat" });
			},
			(context) =>
				applyFrom({ id: patchIds(JSON.stringify(context.messages))[0], action: "diff", file: "src/a.txt" }),
			(context) => applyFrom({ id: patchIds(JSON.stringify(context.messages))[0] }),
			fauxAssistantMessage("Applied."),
		]);

		await harness.session.prompt("Rename it.");

		// The runner was sent to a checkout outside the repository, with the parent's trust and its uncommitted state.
		const { task, assignment } = seen[0];
		const cwd = assignment.cwd ?? "";
		// Directly under the temp directory, under the name the desktop app accepts for a run.
		expect(dirname(dirname(cwd))).toBe(tmpdir());
		expect(cwd).toMatch(/kyrn-swarm-[0-9a-f]{8}[\\/]w0$/);
		expect(cwd.startsWith(harness.repo)).toBe(false);
		expect(assignment.trusted).toBe(true);
		expect(task.instructions).toContain(`${cwd}/src/a.txt`);
		expect(task.instructions).toContain("isolated copy");
		expect(childArgs(task, assignment)).toContain("--approve");

		const [delegated, stat, diff, applied] = resultTexts(harness);
		expect(delegated).toContain("**Done** src/a.txt:2");
		expect(delegated).toContain("2 files changed, +2 -1. It is NOT in your working tree yet.");
		expect(delegated).toContain("M src/a.txt +1 -1");
		expect(delegated).toContain(
			"Scope check by the judge: 1 file in scope, 1 looks unrelated to the task: package-lock.json",
		);
		expect(delegated).toContain("+line 2, renamed");
		expect(delegated).not.toContain("parent's edit\\n+");
		// Nothing came back by itself.
		expect(beforeApply).toBe(lines(12).replace("line 11\n", "line 11, parent's edit\n"));
		expect(stat).toContain("A package-lock.json +1 -0");
		expect(diff).toContain("-line 2");
		expect(diff).not.toContain("package-lock");
		expect(applied).toContain("Applied patch");

		const merged = readFileSync(join(harness.repo, "src/a.txt"), "utf8");
		expect(merged).toContain("line 2, renamed");
		expect(merged).toContain("line 11, parent's edit");
		expect(sh(harness.repo, "diff", "--cached")).toBe("");
		// The checkout and its branch are gone; only the patch is kept.
		expect(existsSync(cwd)).toBe(false);
		expect(sh(harness.repo, "branch", "--list", "mu/agent-*")).toBe("");
		expect(sh(harness.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);

		const swarmEvents = events.filter((event) => event.kind.startsWith("swarm."));
		expect(swarmEvents.map((event) => event.kind)).toEqual([
			"swarm.worktree.created",
			"swarm.patch.ready",
			"swarm.worktree.removed",
			"swarm.patch.applied",
		]);
		expect(swarmEvents[1].payload).toMatchObject({
			files: 2,
			insertions: 2,
			deletions: 1,
			paths: ["package-lock.json", "src/a.txt"],
		});
		expect(swarmEvents[3].payload).toMatchObject({ status: "applied", conflicted: [] });
		expect(JSON.stringify(swarmEvents)).not.toContain("line 2, renamed");
	});

	it("keeps parallel workers apart, and reports the second patch's conflict without touching anything", async () => {
		const dirs: string[] = [];
		let release: () => void = () => {};
		const bothStarted = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await start(async (task, assignment) => {
			const cwd = assignment.cwd ?? "";
			dirs.push(cwd);
			if (dirs.length === 2) release();
			// Both checkouts exist at the same time.
			await bothStarted;
			expect(dirs.every((dir) => existsSync(dir))).toBe(true);
			writeFileSync(join(cwd, "src/a.txt"), lines(12).replace("line 5\n", `line 5, by ${task.title}\n`));
			return `${task.title} done`;
		});
		harness.setResponses([
			delegate([
				{ title: "one", instructions: "Change line 5 your way" },
				{ title: "two", instructions: "Change line 5 another way" },
			]),
			(context) => applyFrom({ id: patchIds(JSON.stringify(context.messages))[0] }),
			(context) => applyFrom({ id: patchIds(JSON.stringify(context.messages))[1] }),
			fauxAssistantMessage("One of them conflicts."),
		]);

		await harness.session.prompt("Do both.");

		expect(new Set(dirs).size).toBe(2);
		const [delegated, first, second] = resultTexts(harness);
		expect(new Set(patchIds(delegated)).size).toBe(2);
		expect(first).toContain("Applied patch");
		expect(second).toContain("was NOT applied, and nothing was changed");
		expect(second).toContain("- src/a.txt");
		expect(readFileSync(join(harness.repo, "src/a.txt"), "utf8")).toBe(
			lines(12).replace("line 5\n", "line 5, by one\n"),
		);
		expect(sh(harness.repo, "branch", "--list", "mu/agent-*")).toBe("");
	});

	it("keeps what a worker changed before it crashed, and still takes its checkout down", async () => {
		let cwd = "";
		const harness = await start(async (_task, assignment) => {
			cwd = assignment.cwd ?? "";
			writeFileSync(join(cwd, "half.txt"), "half done\n");
			throw new Error("subagent exited with code 1 before it finished");
		});
		harness.setResponses([
			delegate([{ title: "crash", instructions: "Write half.txt" }]),
			fauxAssistantMessage("It failed."),
		]);

		await harness.session.prompt("Try.");

		const [delegated] = resultTexts(harness);
		expect(delegated).toContain("FAILED: subagent exited with code 1");
		expect(delegated).toContain("A half.txt +1 -0");
		expect(existsSync(cwd)).toBe(false);
		expect(existsSync(`${cwd}.json`)).toBe(false);
		expect(sh(harness.repo, "branch", "--list", "mu/agent-*")).toBe("");
		expect(existsSync(join(harness.repo, "half.txt"))).toBe(false);
	});

	it("isolates only who edits, works in place where there is no repository, and says so", async () => {
		// By title: an isolated subagent starts later than the others, its checkout has to be made first.
		const where = new Map<string, string | undefined>();
		const runner: SwarmRunner = async (task, assignment) => {
			where.set(task.title, assignment.cwd);
			return "ok";
		};
		const isolatedTitles = () => [...where].filter(([, cwd]) => cwd !== undefined).map(([title]) => title);
		const tasks: Record<string, string>[] = [
			{ title: "look", instructions: "Find it", agent: "scout" },
			{ title: "edit", instructions: "Change it", agent: "worker" },
			{ title: "in-place", instructions: "Change it here", agent: "worker", isolation: "none" },
		];

		const inRepo = await start(runner);
		inRepo.setResponses([delegate(tasks), fauxAssistantMessage("ok")]);
		await inRepo.session.prompt("Go.");
		expect([...where.keys()].sort()).toEqual(["edit", "in-place", "look"]);
		expect(isolatedTitles()).toEqual(["edit"]);
		expect(resultTexts(inRepo)[0]).toContain(
			"It worked in an isolated copy and changed no files: there is no patch.",
		);
		expect(resultTexts(inRepo)[0]).not.toContain("Not isolated");

		where.clear();
		const noRepo = await start(runner, { files: null });
		noRepo.setResponses([delegate(tasks), fauxAssistantMessage("ok")]);
		await noRepo.session.prompt("Go.");
		expect(where.size).toBe(3);
		expect(isolatedTitles()).toEqual([]);
		expect(resultTexts(noRepo)[0]).toContain(
			"Not isolated (this directory is not in a git repository): it worked in place",
		);

		where.clear();
		const switchedOff = await start(runner, { swarm: { isolation: "none" } });
		switchedOff.setResponses([
			delegate([tasks[1], { ...tasks[1], title: "asked", isolation: "worktree" }]),
			fauxAssistantMessage("ok"),
		]);
		await switchedOff.session.prompt("Go.");
		expect(where.size).toBe(2);
		expect(isolatedTitles()).toEqual([]);
		expect(resultTexts(switchedOff)[0]).toContain("Not isolated (isolation is switched off in mu.json)");

		// A path the parent wrote down means the copy, under either spelling of a symlinked repository.
		const parent = {
			repo: { root: "/private/var/proj", prefix: "src/", gitDir: "", head: "" },
			cwd: "/var/proj/src",
		};
		expect(rebase("Edit /var/proj/src/a.ts and /private/var/proj/b.ts", parent, "/tmp/w0")).toBe(
			"Edit /tmp/w0/src/a.ts and /tmp/w0/b.ts",
		);
		// On Windows git writes the root and the prefix with forward slashes; the session's folder has backslashes.
		const windows = {
			repo: { root: "C:/Users/me/repo", prefix: "packages/app/", gitDir: "", head: "" },
			cwd: "C:\\Users\\me\\repo\\packages\\app",
		};
		expect(rebase("Edit C:\\Users\\me\\repo\\packages\\app\\a.ts and C:/Users/me/repo/b.ts", windows, "T:\\w0")).toBe(
			"Edit T:\\w0\\packages\\app\\a.ts and T:\\w0/b.ts",
		);
	});

	it("takes a running subagent's checkout down when the session shuts down", async () => {
		let cwd = "";
		let started: () => void = () => {};
		let release: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const harness = await start(
			(_task, assignment) =>
				new Promise<string>((resolve) => {
					cwd = assignment.cwd ?? "";
					release = () => resolve("late");
					started();
				}),
		);
		harness.setResponses([delegate([{ title: "slow", instructions: "Take your time" }]), fauxAssistantMessage("ok")]);
		const prompt = harness.session.prompt("Go.");
		await running;
		expect(existsSync(cwd)).toBe(true);
		expect(sh(harness.repo, "branch", "--list", "mu/agent-*")).not.toBe("");

		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

		expect(existsSync(cwd)).toBe(false);
		expect(existsSync(`${cwd}.json`)).toBe(false);
		expect(sh(harness.repo, "branch", "--list", "mu/agent-*")).toBe("");
		expect(sh(harness.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		// The subagent coming back afterwards finds its checkout gone, and that is not an error for anyone.
		release();
		await prompt;
		expect(resultTexts(harness)[0]).toContain("late");
	});

	it("asks nothing about scope by default: the result already lists every changed file", async () => {
		const provider = review("b.txt");
		const asked: string[] = [];
		const harness = await start(
			async (_task, assignment) => {
				writeFileSync(join(assignment.cwd ?? "", "b.txt"), "b\n");
				return "done";
			},
			{
				responder: (request) => {
					asked.push(...Object.keys(request.questions));
					return provider(request);
				},
			},
		);
		harness.setResponses([delegate([{ title: "add", instructions: "Add b.txt" }]), fauxAssistantMessage("ok")]);
		await harness.session.prompt("Go.");
		const [delegated] = resultTexts(harness);
		expect(delegated).toContain("A b.txt +1 -0");
		expect(delegated).not.toContain("Scope check");
		expect(asked).not.toContain("within_task");
	});

	it("says nothing about scope in shadow mode, and answers an unknown patch id with the ones it has", async () => {
		const harness = await start(
			async (_task, assignment) => {
				writeFileSync(join(assignment.cwd ?? "", "b.txt"), "b\n");
				return "done";
			},
			{ responder: review("b.txt"), mode: "shadow", patchReview: "shadow" },
		);
		harness.setResponses([
			delegate([{ title: "add", instructions: "Add b.txt" }]),
			applyFrom({ id: "p-000000" }),
			fauxAssistantMessage("ok"),
		]);
		await harness.session.prompt("Go.");
		const [delegated, unknown] = resultTexts(harness);
		expect(delegated).toContain("A b.txt +1 -0");
		expect(delegated).not.toContain("Scope check");
		expect(unknown).toContain('No patch has the id \\"p-000000\\"');
		expect(unknown).toContain(patchIds(delegated)[0]);
	});
});

describe("swarm.patch", () => {
	const engineWith = (responder: MockResponder, mode: DecisionMode = "active") =>
		new DecisionEngine({ judge: new Judge({ provider: new MockJudgeProvider(responder) }), defaultMode: mode });
	const input = {
		task: "rename: Rename cnt to count in src/a.ts",
		files: [
			{ path: "src/a.ts", change: "modified +3 -3" },
			{ path: "package-lock.json", change: "modified +120 -80" },
			{ path: "docs/unsure.md", change: "added +4 -0" },
		],
	};

	it("asks about the whole change and about each file, from the stat alone, and flags only a confident no", async () => {
		const provider = new MockJudgeProvider(() => ({ within_task: yes, file_0: yes, file_1: no }));
		const engine = new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "active" });
		const decision = await engine.decide(swarmPatch, input);

		expect(Object.keys(provider.calls[0].questions)).toEqual(["within_task", "file_0", "file_1", "file_2"]);
		expect(String(provider.calls[0].questions.file_1.instructions)).toBe(
			"Does `task` call for changing this file? package-lock.json (modified +120 -80)",
		);
		expect(provider.calls[0].state).toEqual({
			task: input.task,
			change: "src/a.ts (modified +3 -3)\npackage-lock.json (modified +120 -80)\ndocs/unsure.md (added +4 -0)",
		});
		expect(decision.outcome).toEqual({ withinTask: true, unrelated: ["package-lock.json"], judged: 3 });
		expect(describePatchReview(decision.outcome, 3)).toBe(
			"2 files in scope, 1 looks unrelated to the task: package-lock.json",
		);
	});

	it("says nothing when the judge is unsure, unavailable or off, and caps the files it asks about", async () => {
		const unsure = await engineWith(() => ({})).decide(swarmPatch, input);
		expect(describePatchReview(unsure.outcome, 3)).toBeUndefined();
		const broken = await engineWith(() => {
			throw new Error("judge down");
		}).decide(swarmPatch, input);
		expect(broken).toMatchObject({ source: "fallback", outcome: { withinTask: null, unrelated: [], judged: 0 } });
		expect((await engineWith(() => ({ within_task: no }), "off").decide(swarmPatch, input)).source).toBe("fallback");

		const wide = await engineWith(() => ({ within_task: no })).decide(swarmPatch, input);
		expect(describePatchReview(wide.outcome, 3)).toBe("the change as a whole looks wider than the task");

		const many = {
			task: "t",
			files: Array.from({ length: 30 }, (_, index) => ({ path: `f${index}`, change: "modified +1 -1" })),
		};
		const provider = new MockJudgeProvider(() => ({ within_task: yes }));
		const capped = await new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "active" }).decide(
			swarmPatch,
			many,
		);
		expect(Object.keys(provider.calls[0].questions)).toHaveLength(MAX_JUDGED_FILES + 1);
		expect(describePatchReview(capped.outcome, 30)).toBe("12 files in scope (18 not checked)");
	});

	it("treats a role as editing when it has every tool or names edit or write", () => {
		expect(editsFiles(undefined)).toBe(true);
		expect(editsFiles({ tools: undefined })).toBe(true);
		expect(editsFiles({ tools: ["read", "edit"] })).toBe(true);
		expect(editsFiles({ tools: ["read", "bash"] })).toBe(false);
	});
});
