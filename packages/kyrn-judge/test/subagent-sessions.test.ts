import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { childArgs, type SwarmAssignment, type SwarmRunner } from "../src/extension/features/swarm.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { type BeeRunner, SwarmRun } from "../src/swarm/run.ts";
import {
	SUBAGENT_SESSION_ENTRY,
	type SubagentSessionEntry,
	subagentSessionDir,
	subagentSessionFile,
} from "../src/swarm/sessions.ts";
import { USAGE_ENTRY } from "../src/usage.ts";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "kyrn-subagent-sessions-"));
	dirs.push(dir);
	return dir;
};

const saved = { getSessionFile: () => "/home/me/.mu/agent/sessions/--p--/a.jsonl", getSessionId: () => "019a-parent" };
const inMemory = { getSessionFile: () => undefined, getSessionId: () => "019a-memory" };

describe("where a subagent keeps its session", () => {
	it("beside the sessions folder, in a folder of its parent's, named after it", () => {
		const agentDir = join("/home", "me", ".mu", "agent");
		const file = subagentSessionFile(saved, "find the store", agentDir, new Date("2026-11-05T08:12:40.118Z")) ?? "";
		expect(dirname(file)).toBe(join(agentDir, "subagents", "019a-parent"));
		expect(basename(file)).toMatch(/^2026-11-05T08-12-40-118Z_find_the_store_[0-9a-f]{8}\.jsonl$/);
		expect(subagentSessionDir("019a-parent", agentDir)).toBe(dirname(file));
	});

	it("keeps a title in another script readable and a path out of the name", () => {
		const file = subagentSessionFile(saved, "查找/会话 存储", "/a") ?? "";
		expect(basename(file)).toMatch(/^[\w-]+_查找_会话_存储_[0-9a-f]{8}\.jsonl$/);
		expect(dirname(file)).toBe(join("/a", "subagents", "019a-parent"));
	});

	it("never gives two subagents of the same name the same file: pi would carry on the first one's conversation", () => {
		const at = new Date();
		expect(subagentSessionFile(saved, "look", "/a", at)).not.toBe(subagentSessionFile(saved, "look", "/a", at));
	});

	it("is nowhere when the parent keeps no session file", () => {
		expect(subagentSessionFile(inMemory, "look", "/a")).toBeUndefined();
	});

	it("is handed to the child as --session, and without one the child keeps none", () => {
		const assignment: SwarmAssignment = { thinking: "low", routedBy: "default" };
		const task = { title: "t", instructions: "Find it" };
		expect(childArgs(task, { ...assignment, session: "/a/s.jsonl" }).slice(0, 5)).toEqual([
			"--mode",
			"json",
			"-p",
			"--session",
			"/a/s.jsonl",
		]);
		const without = childArgs(task, assignment);
		expect(without.slice(0, 4)).toEqual(["--mode", "json", "-p", "--no-session"]);
		expect(without).not.toContain("--session");
	});
});

describe("a run tells who starts a bee", () => {
	it("as each bee starts, with its spec, and never for one stopped while it waited for a slot", async () => {
		const controller = new AbortController();
		const run = new SwarmRun<string>({
			kind: "delegate",
			title: "two",
			dir: tempDir(),
			limits: { concurrency: 1 },
			bees: ["first", "second"].map((name) => ({
				name,
				task: { title: name, instructions: name },
				assignment: `${name}.jsonl`,
			})),
		});
		const started: string[] = [];
		run.onBeeStart = (bee, spec) => started.push(`${bee.name}:${spec.assignment}:${bee.status}`);
		const runner: BeeRunner<string> = (_task, _assignment, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
			});
		const finished = run.run(runner, controller.signal);
		await vi.waitFor(() => expect(run.bees[0].status).toBe("starting"));
		controller.abort();
		await finished;
		expect(started).toEqual(["first:first.jsonl:starting"]);
		expect(run.bees[1].status).toBe("stopped");
	});
});

describe("in a session", () => {
	const entries = (harness: Harness, type: string) =>
		harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "custom" && entry.customType === type ? [entry] : []));

	/** A parent session with a file, and an agent folder of the test's own: the subagents' folder goes there. */
	const savedParent = () => {
		const agentDir = tempDir();
		// Which of the two is read depends on the build's app name.
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("MU_CODING_AGENT_DIR", agentDir);
		return { agentDir, sessionManager: SessionManager.create(tempDir(), join(agentDir, "sessions")) };
	};

	const delegateHarness = async (runner: SwarmRunner, sessionManager?: SessionManager) => {
		const harness = await createHarness({
			sessionManager,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false, swarm: { isolation: "none" } } }),
					only: ["swarm"],
					swarmRunner: runner,
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	};

	const reporting: SwarmRunner = async (_task, _assignment, _signal, _env, observer) => {
		observer?.event({ type: "agent_start" });
		observer?.event({ type: "agent_settled" });
		return "Found it.";
	};

	it("gives each subagent of a saved session a file of its own, tied to the delegate call that started it", async () => {
		const { agentDir, sessionManager } = savedParent();
		const given: (string | undefined)[] = [];
		const harness = await delegateHarness(async (task, assignment, signal, env, observer) => {
			given.push(assignment.session);
			return reporting(task, assignment, signal, env, observer);
		}, sessionManager);
		let seen = "";
		const call = fauxToolCall("delegate", {
			tasks: [
				{ title: "look", instructions: "Find it" },
				{ title: "look", instructions: "Find the other one" },
			],
		});
		harness.setResponses([
			fauxAssistantMessage([call], { stopReason: "toolUse" }),
			(context: Context) => {
				seen = JSON.stringify(context);
				return fauxAssistantMessage("Done.");
			},
		]);
		await harness.session.prompt("Find both.");

		const folder = subagentSessionDir(sessionManager.getSessionId(), agentDir);
		expect(given).toHaveLength(2);
		expect(new Set(given).size).toBe(2);
		for (const file of given) expect(dirname(file ?? "")).toBe(folder);
		expect(given[0]).toContain("_look_");
		expect(given[1]).toContain("_look-2_");

		const links = entries(harness, SUBAGENT_SESSION_ENTRY).map((entry) => entry.data as SubagentSessionEntry);
		expect(links).toEqual([
			{ toolCallId: call.id, kind: "delegate", name: "look", session: given[0] },
			{ toolCallId: call.id, kind: "delegate", name: "look-2", session: given[1] },
		]);
		// Written as the subagent starts, so before what it spent, which is written when it ends.
		const order = harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "custom" ? [entry.customType] : []));
		expect(order.indexOf(SUBAGENT_SESSION_ENTRY)).toBeLessThan(order.indexOf(USAGE_ENTRY));
		// The model never reads it.
		expect(seen).toContain("Found it.");
		expect(seen).not.toContain(SUBAGENT_SESSION_ENTRY);
		expect(seen).not.toContain(folder);
	});

	it("keeps none for a subagent of a session without a file, and says nothing of one", async () => {
		const given: (string | undefined)[] = [];
		const harness = await delegateHarness(async (task, assignment, signal, env, observer) => {
			given.push(assignment.session);
			return reporting(task, assignment, signal, env, observer);
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", { tasks: [{ title: "look", instructions: "Find it" }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Find it.");
		expect(given).toEqual([undefined]);
		expect(entries(harness, SUBAGENT_SESSION_ENTRY)).toEqual([]);
		expect(entries(harness, USAGE_ENTRY)).toHaveLength(1);
	});

	it("gives a hive's investigators theirs too", async () => {
		const { agentDir, sessionManager } = savedParent();
		const runner: SwarmRunner = async (task) => `${task.title}: done`;
		const harness = await createHarness({
			sessionManager,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false, permissions: { mode: "full" } } }),
					only: ["hive"],
					swarmRunner: runner,
				}),
			],
		});
		harnesses.push(harness);
		const call = fauxToolCall("hive", {
			goal: "Login is flaky in CI only.",
			bees: [
				{ name: "repro", focus: "Reproduce the failure locally" },
				{ name: "history", focus: "Find the commit that introduced it" },
			],
		});
		harness.setResponses([fauxAssistantMessage([call], { stopReason: "toolUse" }), fauxAssistantMessage("Found.")]);
		await harness.session.prompt("Why is login flaky?");

		const links = entries(harness, SUBAGENT_SESSION_ENTRY).map((entry) => entry.data as SubagentSessionEntry);
		expect(links.map(({ toolCallId, kind, name }) => ({ toolCallId, kind, name }))).toEqual([
			{ toolCallId: call.id, kind: "hive", name: "repro" },
			{ toolCallId: call.id, kind: "hive", name: "history" },
		]);
		const folder = subagentSessionDir(sessionManager.getSessionId(), agentDir);
		for (const link of links) expect(dirname(link.session)).toBe(folder);
	});
});
