import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSwarmResult } from "../src/extension/features/swarm.ts";
import type { Paint } from "../src/extension/features/welcome.ts";
import {
	CHECKPOINT,
	HIVE_MESSAGE,
	lastCall,
	NOTES_HEADER,
	SWARM_MESSAGE,
	toolsClosed,
	wrapUp,
} from "../src/swarm/markers.ts";
import { activeRuns, type BeeObserver, type BeeRunner, controlPath, SwarmRun } from "../src/swarm/run.ts";
import { applyEvent, type BeeEvent, codedError, newBee, reportOf, summarizeCall } from "../src/swarm/state.ts";
import { clock, renderSwarm } from "../src/swarm/view.ts";

const plain: Paint = { fg: (_color, text) => text, bold: (text) => text };

const assistant = (text: string, extra: Record<string, unknown> = {}): BeeEvent => ({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 1000, output: 50, cacheRead: 200, cost: { total: 0.01 } },
		...extra,
	},
});

const toolTurn = (text: string): BeeEvent => ({
	type: "message_end",
	message: {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
		],
		stopReason: "toolUse",
	},
});

describe("bee state", () => {
	it("follows a bee through thinking, a tool call and its report", () => {
		const bee = newBee("repro", 0);
		expect(bee.status).toBe("queued");

		applyEvent(bee, { type: "agent_start" }, 1000);
		expect(bee).toMatchObject({ status: "thinking", startedAt: 1000 });

		applyEvent(bee, { type: "message_start", message: { role: "assistant" } }, 1100);
		applyEvent(
			bee,
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Running the " } },
			1200,
		);
		applyEvent(bee, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "tests." } }, 1300);
		expect(bee.said).toBe("Running the tests.");

		applyEvent(bee, toolTurn("Running the tests."), 1400);
		applyEvent(bee, { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }, 1500);
		expect(bee).toMatchObject({ status: "tool", toolCalls: 1, tool: { name: "bash", summary: "bash npm test" } });
		expect(bee.finals).toEqual([]);

		applyEvent(bee, { type: "tool_execution_end", toolName: "bash", isError: true }, 9000);
		applyEvent(bee, { type: "turn_end" }, 9000);
		expect(bee).toMatchObject({ status: "thinking", tool: undefined, toolErrors: 1, turns: 1, lastEventAt: 9000 });

		applyEvent(bee, assistant("**Found** the test fails in src/auth.ts:42."), 12_000);
		expect(applyEvent(bee, { type: "agent_end" }, 12_100)).toBe(false);
		expect(applyEvent(bee, { type: "agent_settled" }, 12_200)).toBe(true);
		expect(reportOf(bee)).toBe("**Found** the test fails in src/auth.ts:42.");
		expect(bee.usage).toMatchObject({ input: 1000, output: 50, cost: 0.01 });
		expect(bee.recent.map((entry) => entry.text)).toEqual(["bash npm test", "bash failed"]);
	});

	it("keeps the start of a long message, so a finished bee's row begins where its report does", () => {
		// It used to keep the last 600 characters: the row of a bee back with a long report began mid-sentence.
		const start = "**Found** - the parser fails on empty files.";
		const report = `${start} ${"The evidence is in src/parser.ts and in its tests. ".repeat(20)}`.trim();
		const bee = newBee("repro", 0);
		applyEvent(bee, { type: "message_start", message: { role: "assistant" } }, 1);
		for (const delta of report.split(/(?<= )/)) {
			applyEvent(bee, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }, 2);
		}
		expect(bee.said?.startsWith(start)).toBe(true);
		expect(bee.said?.length).toBeLessThanOrEqual(600);

		applyEvent(bee, assistant(report), 3);
		const kept = bee.said?.slice(0, -1) ?? "";
		expect(bee.said?.endsWith("…")).toBe(true);
		expect(bee.said?.length).toBeLessThanOrEqual(600);
		// Cut between two words, not inside one.
		expect(report.startsWith(kept)).toBe(true);
		expect(report[kept.length]).toBe(" ");

		const chinese = `发现：空文件会让解析器崩溃。${"证据在解析器的代码和测试里，复现步骤已经写好。".repeat(30)}`;
		applyEvent(bee, assistant(chinese), 4);
		expect(bee.said?.startsWith("发现：空文件会让解析器崩溃。")).toBe(true);
		expect(bee.said).toMatch(/[，。]…$/);

		applyEvent(bee, assistant("Done: nothing to change."), 5);
		expect(bee.said).toBe("Done: nothing to change.");
	});

	it("shows a rate-limited bee as retrying, and forgets the error once a request goes through", () => {
		const bee = newBee("web", 0);
		applyEvent(bee, { type: "agent_start" }, 0);
		applyEvent(bee, assistant("", { stopReason: "error", errorMessage: "429 rate limited" }), 100);
		expect(bee.error).toBe("429 rate limited");
		// The same, as a code a client translates by; the provider's own message stays as data.
		expect(bee).toMatchObject({ errorCode: "model_error", errorParams: { message: "429 rate limited" } });
		applyEvent(
			bee,
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 4000, errorMessage: "429 rate limited" },
			200,
		);
		expect(bee).toMatchObject({ status: "retrying", retry: { attempt: 1, maxAttempts: 3 } });
		applyEvent(bee, { type: "auto_retry_end", success: true }, 4300);
		applyEvent(bee, assistant("It works now."), 6000);
		expect(bee).toMatchObject({ status: "thinking", retry: undefined, error: undefined, errorCode: undefined });
		expect(bee.recent.map((entry) => [entry.code, entry.params])).toEqual([
			["model_error", { message: "429 rate limited" }],
			["retry", { attempt: 1, maxAttempts: 3, message: "429 rate limited" }],
		]);
	});

	it("records what the harness told the bee as something that happened to it, not as its words", () => {
		const bee = newBee("code", 0);
		const told = (customType: string, text: string): BeeEvent => ({
			type: "message_start",
			message: { role: "custom", customType, content: text },
		});
		applyEvent(bee, told(HIVE_MESSAGE, `${NOTES_HEADER}\n- web (finding): a\n- repro (dead end): b`), 1);
		applyEvent(bee, told(HIVE_MESSAGE, CHECKPOINT), 2);
		applyEvent(bee, told(HIVE_MESSAGE, lastCall(["- web (finding): late"])), 3);
		applyEvent(bee, told(SWARM_MESSAGE, wrapUp("time budget of 10 min reached")), 4);
		// Notes and a checkpoint due at the same step come as one message.
		applyEvent(bee, told(HIVE_MESSAGE, `${NOTES_HEADER}\n- web (finding): c\n\n${CHECKPOINT}`), 5);
		expect(bee.recent.map((entry) => entry.text)).toEqual([
			"← 2 notes from the others",
			"← asked what it has found so far",
			"← last call: 1 late note",
			"← told to wrap up and report",
			"← 1 note from the others",
			"← asked what it has found so far",
		]);
		expect(bee.recent.map((entry) => [entry.code, entry.params])).toEqual([
			["notes_received", { count: 2 }],
			["asked_findings", undefined],
			["late_notes", { count: 1 }],
			["told_wrap_up", undefined],
			["notes_received", { count: 1 }],
			["asked_findings", undefined],
		]);
		expect(bee.said).toBeUndefined();
	});

	it("keeps the report when a bee that had finished was spoken to again", () => {
		const report = `**Found** - the cascade skips tiers marked untrusted. ${"Evidence and file references. ".repeat(12)}`;
		// What the first hives returned: the last words, not the report.
		expect(reportOf({ finals: [report, "Acknowledged. The decisive path is established."] })).toBe(
			`${report}\n\nAdded afterwards:\nAcknowledged. The decisive path is established.`,
		);
		// The answer to a last call is not a report at all.
		expect(reportOf({ finals: [report, "NO CHANGE"] })).toBe(report);
		expect(reportOf({ finals: [report, "no change."] })).toBe(report);
		// A corrected report after a last call replaces the first one.
		const corrected = `${report} Corrected: the cause is in config.ts, not cascade.ts.`;
		expect(reportOf({ finals: [report, corrected] })).toBe(corrected);
		expect(reportOf({ finals: [] })).toBe("");
	});

	it("sums up a tool call the way a person wants to read it", () => {
		expect(summarizeCall("bash", { command: "npm run\n  check" })).toBe("bash npm run check");
		expect(summarizeCall("read", { path: "src/app.ts" })).toBe("read src/app.ts");
		expect(summarizeCall("grep", { pattern: "TODO", path: "src" })).toBe("grep TODO in src");
		expect(summarizeCall("browse", { url: "https://docs.typesafe.ai", goal: "find the quickstart" })).toBe(
			'browse https://docs.typesafe.ai "find the quickstart"',
		);
		expect(summarizeCall("ls", {})).toBe("ls");
		expect(summarizeCall("bash", { command: "x".repeat(400) }).length).toBeLessThanOrEqual(140);
	});
});

describe("swarm run", () => {
	const dirs: string[] = [];
	const tempDir = () => {
		const dir = mkdtempSync(join(tmpdir(), "kyrn-swarm-test-"));
		dirs.push(dir);
		return dir;
	};

	afterEach(() => {
		vi.useRealTimers();
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	type Script = (
		observer: BeeObserver | undefined,
		signal: AbortSignal | undefined,
		env: Readonly<Record<string, string>>,
	) => Promise<string>;

	/** A runner whose bees do what their script says. */
	const scripted =
		(scripts: Record<string, Script>): BeeRunner<string> =>
		(task, _assignment, signal, env, observer) =>
			scripts[task.title](observer, signal, env ?? {});

	const untilAborted = (signal: AbortSignal | undefined) =>
		new Promise<string>((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(new Error("the sub-agent was stopped")), { once: true });
		});

	const spec = (name: string) => ({ name, task: { title: name, instructions: name }, assignment: "a" });

	it("runs bees side by side up to the limit, and keeps the rest visibly waiting", async () => {
		const gates: Record<string, () => void> = {};
		const script =
			(name: string): Script =>
			(observer) =>
				new Promise((resolve) => {
					observer?.event({ type: "agent_start" });
					gates[name] = () => {
						observer?.event(assistant(`report of ${name}`));
						resolve(`report of ${name}`);
					};
				});
		const run = new SwarmRun<string>({
			kind: "delegate",
			title: "3 tasks",
			dir: tempDir(),
			bees: [spec("a"), spec("b"), spec("c")],
			limits: { concurrency: 2 },
		});
		const finished = run.run(scripted({ a: script("a"), b: script("b"), c: script("c") }));
		await vi.waitFor(() => expect(Object.keys(gates)).toEqual(["a", "b"]));
		expect(run.bees.map((bee) => bee.status)).toEqual(["thinking", "thinking", "queued"]);
		expect(activeRuns()).toContain(run);

		gates.a();
		await vi.waitFor(() => expect(gates.c).toBeDefined());
		expect(run.bees.map((bee) => bee.status)).toEqual(["done", "thinking", "thinking"]);
		gates.b();
		gates.c();

		const outcomes = await finished;
		expect(outcomes.map((outcome) => outcome.report)).toEqual(["report of a", "report of b", "report of c"]);
		expect(run.endedAt).toBeDefined();
		expect(activeRuns()).not.toContain(run);
	});

	it("takes a bee added while it runs, and none once it is over", async () => {
		const gates: Record<string, () => void> = {};
		const script =
			(name: string): Script =>
			(observer) =>
				new Promise((resolve) => {
					observer?.event({ type: "agent_start" });
					gates[name] = () => {
						observer?.event(assistant(`report of ${name}`));
						resolve(`report of ${name}`);
					};
				});
		const run = new SwarmRun<string>({
			kind: "hive",
			title: "one angle",
			dir: tempDir(),
			bees: [spec("a")],
			limits: { concurrency: 2 },
		});
		const finished = run.run(scripted({ a: script("a"), verify: script("verify") }));
		await vi.waitFor(() => expect(gates.a).toBeDefined());

		// A free slot: the new bee starts at once, beside the running one.
		expect(run.add(spec("verify"))).toBe(1);
		await vi.waitFor(() => expect(gates.verify).toBeDefined());
		expect(run.bees.map((bee) => [bee.name, bee.status])).toEqual([
			["a", "thinking"],
			["verify", "thinking"],
		]);

		gates.a();
		gates.verify();
		const outcomes = await finished;
		expect(outcomes.map((outcome) => outcome.report)).toEqual(["report of a", "report of verify"]);
		expect(run.add(spec("late"))).toBe(-1);
		expect(run.bees).toHaveLength(2);
	});

	it("stops a bee that shows no sign of life instead of waiting for it forever", async () => {
		vi.useFakeTimers();
		const run = new SwarmRun<string>({
			kind: "hive",
			title: "why does it hang",
			dir: tempDir(),
			bees: [spec("stuck"), spec("fine")],
			limits: { stallSeconds: 60, quietSeconds: 20, beeMinutes: 0 },
		});
		const finished = run.run(
			scripted({
				stuck: (observer, signal) => {
					observer?.event({ type: "agent_start" });
					observer?.event(toolTurn("Let me look at the lock file first."));
					return untilAborted(signal);
				},
				fine: async (observer) => {
					observer?.event({ type: "agent_start" });
					observer?.event(assistant("All good."));
					return "All good.";
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(25_000);
		expect(run.bees[0].quietMs).toBeGreaterThanOrEqual(20_000);
		expect(run.bees[0].status).toBe("thinking");

		await vi.advanceTimersByTimeAsync(40_000);
		const [stuck, fine] = await finished;
		expect(stuck.state.status).toBe("timed-out");
		expect(stuck.report).toContain("STOPPED BY THE WATCHDOG: no sign of life from the model for 1m0");
		expect(stuck.state).toMatchObject({ errorCode: "stalled", errorParams: { what: "model", seconds: 60 } });
		// What it had said is not lost with it.
		expect(stuck.report).toContain("Let me look at the lock file first.");
		expect(fine).toMatchObject({ report: "All good.", state: { status: "done" } });
	});

	it("gives a silent tool call more time than a silent model", async () => {
		vi.useFakeTimers();
		const run = new SwarmRun<string>({
			kind: "delegate",
			title: "1 task",
			dir: tempDir(),
			bees: [spec("build")],
			limits: { stallSeconds: 60, toolStallSeconds: 600, beeMinutes: 0 },
		});
		let release: (report: string) => void = () => {};
		const finished = run.run(
			scripted({
				build: (observer) =>
					new Promise((resolve) => {
						observer?.event({ type: "agent_start" });
						observer?.event({ type: "tool_execution_start", toolName: "bash", args: { command: "make all" } });
						release = (report) => {
							observer?.event({ type: "tool_execution_end", toolName: "bash" });
							observer?.event(assistant(report));
							resolve(report);
						};
					}),
			}),
		);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(run.bees[0].status).toBe("tool");
		release("It builds.");
		expect((await finished)[0]).toMatchObject({ report: "It builds.", state: { status: "done" } });
	});

	it("asks a bee that is over its time budget for its report, and ends it only if none comes", async () => {
		vi.useFakeTimers();
		const dir = tempDir();
		const run = new SwarmRun<string>({
			kind: "hive",
			title: "slow web research",
			dir,
			bees: [spec("obedient"), spec("deaf")],
			limits: { beeMinutes: 1, graceSeconds: 30, stallSeconds: 0, toolStallSeconds: 0 },
		});
		const heartbeat = (observer: BeeObserver | undefined) =>
			setInterval(
				() =>
					observer?.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "." } }),
				5000,
			);
		const finished = run.run(
			scripted({
				obedient: (observer, _signal, env) =>
					new Promise((resolve) => {
						observer?.event({ type: "agent_start" });
						const beat = heartbeat(observer);
						// What the child-side listener does: sees the request between steps, and reports.
						const poll = setInterval(() => {
							if (!existsSync(env.KYRN_SWARM_CONTROL)) return;
							clearInterval(poll);
							clearInterval(beat);
							observer?.event(assistant("What I have so far: the docs moved."));
							resolve("What I have so far: the docs moved.");
						}, 1000);
					}),
				deaf: (observer, signal) => {
					observer?.event({ type: "agent_start" });
					const beat = heartbeat(observer);
					return untilAborted(signal).finally(() => clearInterval(beat));
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(59_000);
		expect(run.bees.map((bee) => bee.wrapUp)).toEqual([undefined, undefined]);

		await vi.advanceTimersByTimeAsync(3000);
		expect(JSON.parse(readFileSync(controlPath(dir, 0), "utf8"))).toEqual({
			action: "wrap_up",
			reason: "time budget of 1 min reached",
		});
		// One that never shows it heard gets the grace period twice over, and no more.
		await vi.advanceTimersByTimeAsync(50_000);
		expect(run.bees[1].status).toBe("wrapping-up");
		await vi.advanceTimersByTimeAsync(20_000);

		const [obedient, deaf] = await finished;
		expect(obedient.state.status).toBe("done");
		expect(obedient.report).toBe("(Cut short: time budget of 1 min reached.)\nWhat I have so far: the docs moved.");
		expect(deaf.state.status).toBe("timed-out");
		expect(deaf.report).toContain("time budget of 1 min reached; no report within 60s of being asked");
		expect(obedient.state.wrapUp).toMatchObject({ code: "time_budget", params: { minutes: 1 } });
		expect(deaf.state).toMatchObject({
			errorCode: "no_report_in_time",
			errorParams: { seconds: 60, after: "time_budget" },
		});
	});

	it("counts the grace period from when a bee heard it was to report, and keeps what a cut-off one had written", async () => {
		// Seen live, with a model thinking at "high": asked at 5m00s, heard it 22 s later when its step ended, wrote
		// its report for 37 s and was cut off by a 60 s grace period counted from the asking, report and all.
		vi.useFakeTimers();
		const dir = tempDir();
		const run = new SwarmRun<string>({
			kind: "hive",
			title: "slow thinkers",
			dir,
			bees: [spec("slow"), spec("cut")],
			limits: { beeMinutes: 1, graceSeconds: 30, stallSeconds: 0, toolStallSeconds: 0 },
		});
		const asked = (env: Readonly<Record<string, string>>) =>
			new Promise<void>((resolve) => {
				const poll = setInterval(() => {
					if (!existsSync(env.KYRN_SWARM_CONTROL)) return;
					clearInterval(poll);
					resolve();
				}, 1000);
			});
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const delta = (text: string): BeeEvent => ({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: text },
		});
		const reason = "time budget of 1 min reached";
		const finished = run.run(
			scripted({
				// Deep in a step when it is asked: it hears 20 s later, from the tool call that step ends in.
				slow: async (observer, _signal, env) => {
					observer?.event({ type: "agent_start" });
					observer?.event({ type: "message_start", message: { role: "assistant" } });
					await asked(env);
					for (let i = 0; i < 4; i++) {
						await sleep(5000);
						observer?.event(delta("."));
					}
					observer?.event({
						type: "message_start",
						message: { role: "toolResult", content: [{ type: "text", text: toolsClosed(reason) }] },
					});
					observer?.event({ type: "message_start", message: { role: "assistant" } });
					for (let i = 0; i < 5; i++) {
						await sleep(5000);
						observer?.event(delta("Found it. "));
					}
					observer?.event(assistant("FOUND: the docs moved to /v2."));
					return "FOUND: the docs moved to /v2.";
				},
				// Hears it at once and starts its report, but does not finish it in time.
				cut: async (observer, signal, env) => {
					observer?.event({ type: "agent_start" });
					await asked(env);
					observer?.event({
						type: "message_start",
						message: { role: "custom", customType: SWARM_MESSAGE, content: wrapUp(reason) },
					});
					observer?.event({ type: "message_start", message: { role: "assistant" } });
					observer?.event(delta("FOUND: the cache key ignores the locale "));
					observer?.event(delta("(src/cache.ts:41); ruled out: the CDN."));
					const beat = setInterval(() => observer?.event(delta(" ")), 5000);
					return untilAborted(signal).finally(() => clearInterval(beat));
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(130_000);

		const [slow, cut] = await finished;
		expect(slow.state.status).toBe("done");
		expect(slow.report).toBe(`(Cut short: ${reason}.)\nFOUND: the docs moved to /v2.`);
		expect(slow.state.wrapUp?.heardAt).toBeGreaterThan(slow.state.wrapUp?.at ?? 0);
		expect(cut.state.status).toBe("timed-out");
		expect(cut.report).toMatch(/no report within 3\ds of being asked/);
		expect(cut.report).toContain(
			"What it had written of its report when it was stopped:\nFOUND: the cache key ignores the locale (src/cache.ts:41); ruled out: the CDN.",
		);
	});

	it("lets the user stop one bee or all of them and still get what was found", async () => {
		const run = new SwarmRun<string>({
			kind: "hive",
			title: "stop me",
			dir: tempDir(),
			bees: [spec("a"), spec("b"), spec("c")],
			limits: { concurrency: 2 },
		});
		const working: Script = (observer, signal) => {
			observer?.event({ type: "agent_start" });
			observer?.event(toolTurn("FOUND: the cache key ignores the locale."));
			return untilAborted(signal);
		};
		const finished = run.run(scripted({ a: working, b: working, c: working }));
		await vi.waitFor(() => expect(run.bees[1].status).toBe("thinking"));

		expect(run.kill("nobody", "ended by the user")).toBe(0);
		expect(run.kill("a", "ended by the user")).toBe(1);
		await vi.waitFor(() => expect(run.bees[2].status).toBe("thinking"));
		// Stopping asks for a report; the ones still waiting for a slot are simply dropped.
		expect(run.wrapUp(undefined, "stopped by the user")).toBe(2);
		expect(run.bees.map((bee) => bee.status)).toEqual(["stopped", "wrapping-up", "wrapping-up"]);
		run.kill(undefined, "ended by the user");

		const outcomes = await finished;
		expect(outcomes.map((outcome) => outcome.state.status)).toEqual(["stopped", "stopped", "stopped"]);
		expect(outcomes[0].report).toContain("STOPPED: ended by the user");
		expect(outcomes[0].report).toContain("FOUND: the cache key ignores the locale.");
	});

	it("turns a cancelled tool call into stopped bees, not into a rejection", async () => {
		const controller = new AbortController();
		const run = new SwarmRun<string>({ kind: "delegate", title: "1 task", dir: tempDir(), bees: [spec("a")] });
		const finished = run.run(
			scripted({
				a: (observer, signal) => {
					observer?.event({ type: "agent_start" });
					return untilAborted(signal);
				},
			}),
			controller.signal,
		);
		await vi.waitFor(() => expect(run.bees[0].status).toBe("thinking"));
		controller.abort();
		const [outcome] = await finished;
		expect(outcome.state).toMatchObject({
			status: "stopped",
			error: "the run was cancelled",
			errorCode: "cancelled",
		});
	});

	it("reports a bee that could not run as failed, with the reason", async () => {
		const run = new SwarmRun<string>({ kind: "delegate", title: "1 task", dir: tempDir(), bees: [spec("a")] });
		const [outcome] = await run.run(async () => {
			throw new Error("sub-agent exited with code 1 before it finished: No API key found");
		});
		expect(outcome.state.status).toBe("failed");
		expect(outcome.report).toContain("FAILED: sub-agent exited with code 1 before it finished: No API key found");
		expect(outcome.state).toMatchObject({
			errorCode: "error",
			errorParams: { message: "sub-agent exited with code 1 before it finished: No API key found" },
		});
		// An error that says what it is keeps its code.
		const [coded] = await new SwarmRun<string>({
			kind: "delegate",
			title: "1 task",
			dir: tempDir(),
			bees: [spec("b")],
		}).run(async () => {
			throw codedError("sub-agent exited with code 2 before it finished", {
				code: "exited_early",
				params: { exitCode: 2 },
			});
		});
		expect(coded.state).toMatchObject({ errorCode: "exited_early", errorParams: { exitCode: 2 } });
	});

	it("writes each bee's steps to a transcript, without the token stream", async () => {
		const dir = tempDir();
		const run = new SwarmRun<string>({ kind: "delegate", title: "1 task", dir, bees: [spec("my bee/1")] });
		await run.run(
			scripted({
				"my bee/1": async (observer) => {
					observer?.event({ type: "agent_start" });
					observer?.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
					observer?.event(assistant("done"));
					return "done";
				},
			}),
		);
		const path = run.bees[0].transcript ?? "";
		expect(path).toBe(join(dir, "transcripts", "0-my_bee_1.jsonl"));
		const types = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as BeeEvent).type);
		expect(types).toEqual(["agent_start", "message_end"]);
	});
});

describe("swarm view", () => {
	const snapshot = () => {
		const working = newBee("jev-web", 0, {
			role: "investigator",
			model: "openai-codex/gpt-5.6-sol",
			thinking: "medium",
		});
		applyEvent(working, { type: "agent_start" }, 1000);
		applyEvent(working, toolTurn("三个精确 Google 查询均被反爬页拦截，改用其他公开检索入口。"), 60_000);
		applyEvent(
			working,
			{
				type: "tool_execution_start",
				toolName: "browse",
				args: { url: "https://docs.typesafe.ai/llms.txt", goal: "find the quickstart page" },
			},
			120_000,
		);
		working.published = 3;
		working.received = 1;
		const done = newBee("pi-delta", 0, { role: "investigator", model: "openai-codex/gpt-5.6-terra" });
		applyEvent(done, { type: "agent_start" }, 1000);
		applyEvent(done, assistant("**Found** - the committed tree equals upstream."), 90_000);
		done.status = "done";
		done.endedAt = 90_000;
		const waiting = newBee("history", 0);
		const dead = newBee("judge-code", 0);
		dead.status = "timed-out";
		dead.startedAt = 1000;
		dead.endedAt = 100_000;
		dead.error = "no sign of life from the model for 5m00s";
		return {
			kind: "hive" as const,
			title: "what is KYRN",
			startedAt: 0,
			now: 134_000,
			bees: [working, done, waiting, dead],
			board: {
				notes: 12,
				deliveries: 5,
				judged: 58,
				published: {},
				received: {},
				latest: [
					{
						at: "",
						bee: "pi-delta",
						kind: "finding",
						score: 0.85,
						to: ["jev-web"],
						text: "The committed tree equals upstream; KYRN lives in untracked packages.",
					},
				],
			},
			dir: "/tmp/kyrn-hive-x",
		};
	};

	it("says for every bee whether it is alive and what it is doing this second", () => {
		const text = renderSwarm(snapshot(), { expanded: false, width: 140 }, plain).join("\n");
		expect(text).toContain(
			"⬢ hive · 4 investigators · 2m14s · 1 working, 1 done, 1 stopped · board 12 notes, 5 passed on · 58 judged",
		);
		expect(text).toMatch(
			/jev-web\s+investigator · gpt-5\.6-sol · thinking medium · 2m13s · 1 tool call · 3 notes out, 1 in/,
		);
		expect(text).toContain('↳ browse https://docs.typesafe.ai/llms.txt "find the quickstart page" · 14s');
		expect(text).toMatch(/✓ pi-delta\s+investigator · gpt-5\.6-terra · 1m29s/);
		expect(text).toContain("↳ waiting for a free slot");
		expect(text).toContain("↳ no sign of life from the model for 5m00s");
		expect(text).toContain("pi-delta → jev-web finding 0.85");
		expect(text).toContain("/swarm stop [name]: report now, keep what was found");
	});

	it("shows what a quiet bee last said and how long it has been quiet", () => {
		const view = snapshot();
		view.bees[0].tool = undefined;
		view.bees[0].status = "thinking";
		view.bees[0].quietMs = 92_000;
		const text = renderSwarm(view, { expanded: false, width: 140 }, plain).join("\n");
		expect(text).toContain("no sign of life for 1m32s");
		expect(text).toContain("三个精确 Google 查询均被反爬页拦截");
	});

	// https://github.com/qybaihe/mu/issues/7
	it("cuts the status shown before the first snapshot to the terminal width", () => {
		const status = "choosing a role, a model and a thinking level for 1 sub-agent…";
		const result = renderSwarmResult(
			{ content: [{ type: "text", text: `${status}\n${status}` }] },
			{ expanded: false },
			plain as unknown as Theme,
		);
		for (const width of [24, 40]) {
			for (const line of result.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(result.render(100)).toEqual([status, status]);
	});

	it("adds each bee's recent steps when expanded, and never draws wider than the terminal", () => {
		const expanded = renderSwarm(snapshot(), { expanded: true, width: 100 }, plain);
		expect(expanded.join("\n")).toContain("ago  browse https://docs.typesafe.ai/llms.txt");
		for (const width of [40, 72, 100]) {
			for (const line of renderSwarm(snapshot(), { expanded: true, width }, plain)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("sums a finished run up, with the reports behind the expand key", () => {
		const view = { ...snapshot(), endedAt: 200_000 };
		view.bees[0].status = "done";
		view.bees[0].endedAt = 200_000;
		view.bees[2].status = "stopped";
		const collapsed = renderSwarm(view, { expanded: false, width: 140 }, plain).join("\n");
		expect(collapsed).toContain("finished in 3m20s · 2 reported, 2 did not");
		expect(collapsed).not.toContain("/swarm stop");
		const expanded = renderSwarm(
			view,
			{ expanded: true, width: 140, reports: ["Jev is TypeSafe AI's System One model.", "", "", ""] },
			plain,
		).join("\n");
		expect(expanded).toContain("Jev is TypeSafe AI's System One model.");
		expect(expanded).toContain("transcripts, board and gate log: /tmp/kyrn-hive-x");
	});

	it("formats durations the way the rest of the view reads", () => {
		expect([clock(900), clock(59_400), clock(61_000), clock(3_605_000)]).toEqual(["1s", "59s", "1m01s", "60m05s"]);
	});
});
