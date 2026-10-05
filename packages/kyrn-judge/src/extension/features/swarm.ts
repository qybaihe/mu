import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { swarmRouting } from "../../decisions/swarm-routing.ts";
import { say } from "../../language.ts";
import { stopPlan } from "../../platform.ts";
import {
	BRIEF_ENV,
	briefEnv,
	briefFor,
	briefMessage,
	describeFrameOut,
	FRAME_OUT_ENV,
	type FrameOut,
	MAX_DONE,
	PREVIOUS_CHARS,
	parseFrameOut,
} from "../../swarm/brief.ts";
import { describeRecord } from "../../swarm/patches.ts";
import {
	activeRuns,
	type BeeObserver,
	type BeeRunner,
	type BeeTask,
	type SwarmLimits,
	SwarmRun,
	type SwarmSnapshot,
} from "../../swarm/run.ts";
import { type BeeEvent, codedError } from "../../swarm/state.ts";
import { renderSwarm, swarmText } from "../../swarm/view.ts";
import { type AgentDefinition, type AgentThinking, loadAgents, THINKING_LEVELS } from "../agents.ts";
import { clip, type KyrnRuntime, userWords } from "../runtime.ts";
import { Isolation, type IsolationOutcome, type Placement, patchesOf } from "./swarm-isolation.ts";

/** A role the main model asked for by name is in `agent`. Left out, the judge picks one. */
export type SwarmTask = BeeTask;

export interface SwarmAssignment extends Placement {
	/** The role the sub-agent plays. Undefined runs a plain sub-agent with every tool and no role prompt. */
	agent?: AgentDefinition;
	/** "provider/model-id", or undefined to use the child's default model. */
	model?: string;
	thinking: AgentThinking;
	/** Who settled the role: the main model, the judge, or nobody (the default role). */
	routedBy: "caller" | "judge" | "default";
}

/**
 * Runs one task in a fresh context and resolves with the sub-agent's final
 * message. `env` is added to the child's environment; `observer` is told
 * everything the child does while it does it.
 */
export type SwarmRunner = BeeRunner<SwarmAssignment>;

/** A sub-agent's process ended before its run did. Killed from outside, it has no exit code but the signal that ended it. */
export function exitedEarly(code: number | null, signal: NodeJS.Signals | null, detail: string): Error {
	const how = code !== null ? `exited with code ${code}` : `was ended by ${signal ?? "a signal"}`;
	return codedError(`sub-agent ${how} before it finished${detail ? `: ${detail}` : ""}`, {
		code: "exited_early",
		params: code !== null ? { exitCode: code } : { signal: signal ?? "unknown" },
	});
}

/** The model a task's difficulty maps to on a ladder ordered from cheapest to strongest. */
export function pickModel(ladder: readonly string[], strength: number): string | undefined {
	if (ladder.length === 0) return undefined;
	return ladder[Math.round(Math.min(1, Math.max(0, strength)) * (ladder.length - 1))];
}

/**
 * The thinking level a sub-agent starts with. A role's pin wins. Otherwise a
 * sub-agent on the session's own model keeps the session's level: its system
 * prompt and tools are the parent's, so with the same level its first call
 * reads them from the parent's prompt cache, and most providers key that cache
 * on the thinking level (user rule, 2026-09-23). Only a different model takes
 * the level the judge chose for the task.
 */
export function thinkingForRoute(route: {
	pinned?: AgentThinking;
	model?: string;
	sessionModel?: string;
	sessionThinking: string;
	judged: AgentThinking;
}): AgentThinking {
	if (route.pinned) return route.pinned;
	const sameModel =
		route.model === undefined || route.sessionModel === undefined || route.model === route.sessionModel;
	if (sameModel && (THINKING_LEVELS as readonly string[]).includes(route.sessionThinking)) {
		return route.sessionThinking as AgentThinking;
	}
	return route.judged;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && existsSync(script)) return { command: process.execPath, args: [...process.execArgv, script, ...args] };
	const generic = /^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase());
	return generic ? { command: "pi", args } : { command: process.execPath, args };
}

/** Extensions given on the command line are not in any settings file, so a child only gets them if they are passed on. */
export function forwardedExtensionArgs(argv: readonly string[] = process.argv.slice(2)): string[] {
	const forwarded: string[] = [];
	for (let index = 0; index < argv.length - 1; index++) {
		if (argv[index] === "-e" || argv[index] === "--extension") forwarded.push("-e", argv[++index]);
	}
	return forwarded;
}

/** The command line of one sub-agent, without the executable. Exported for tests. */
export function childArgs(task: SwarmTask, assignment: SwarmAssignment, promptPath?: string): string[] {
	// JSON mode: the child reports every step as it takes it, not just its last words when it is over.
	const args = ["--mode", "json", "-p", "--no-session", "--thinking", assignment.thinking];
	if (assignment.model) args.push("--model", assignment.model);
	if (assignment.agent?.tools) args.push("--tools", assignment.agent.tools.join(","));
	if (promptPath) args.push("--append-system-prompt", promptPath);
	// A temp checkout is a path nobody ever trusted; it is the parent's project, so the parent's answer holds.
	if (assignment.trusted !== undefined) args.push(assignment.trusted ? "--approve" : "--no-approve");
	args.push(...forwardedExtensionArgs(), briefMessage(task.instructions, task.brief));
	return args;
}

/**
 * A chain: one step at a time, each handed what the step before reported, as
 * data in its brief. A step that does not finish ends the chain there: the
 * steps after it were planned on its result.
 */
export function chainRunner(runner: SwarmRunner): SwarmRunner {
	let previous: { title: string; report: string } | undefined;
	let broken: string | undefined;
	return async (task, assignment, signal, env, observer) => {
		if (broken)
			throw codedError(`not started: the step before it ("${broken}") did not finish`, {
				code: "chain_broken",
				params: { step: broken },
			});
		const step = previous && task.brief ? { ...task, brief: { ...task.brief, previous } } : task;
		try {
			const report = await runner(step, assignment, signal, env, observer);
			const said = report.trim() || "(it finished without a report)";
			previous = {
				title: task.title,
				report: said.length > PREVIOUS_CHARS ? `${said.slice(0, PREVIOUS_CHARS)}\n… (cut)` : said,
			};
			return report;
		} catch (error) {
			broken = task.title;
			throw error;
		}
	};
}

/** A sub-agent works in its parent's permission mode, as it is now, not as the parent started. */
export function permissionEnv(runtime: KyrnRuntime): Record<string, string> {
	const mode = runtime.permissionMode?.();
	return mode ? { MU_PERMISSIONS: mode } : {};
}

/** Where a sub-agent leaves its acceptance list for the parent. */
export function frameOutPath(dir: string, index: number): string {
	return join(dir, "control", `frame-${index}.json`);
}

async function readFrameOut(path: string): Promise<FrameOut | undefined> {
	try {
		return parseFrameOut(await readFile(path, "utf8"));
	} catch {
		// It never ticked, or never got that far: there is no list to report.
		return undefined;
	}
}

/** How long a child that has finished may take to exit by itself before it is told to. Idle keep-alive sockets hold it for seconds. */
const EXIT_GRACE_MS = 1500;
const KILL_GRACE_MS = 5000;

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return (content as Record<string, unknown>[])
		.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join("\n");
}

/**
 * A child pi process in JSON mode. It inherits the agent directory, so
 * credentials and settings carry over. The run counts as over when the child
 * says its agent has settled, not when the process is gone: a finished child
 * lingers for seconds on idle connections, and nobody should wait for that.
 */
export const spawnRunner: SwarmRunner = async (task, assignment, signal, env, observer?: BeeObserver) => {
	let promptDir: string | undefined;
	let promptPath: string | undefined;
	if (assignment.agent?.systemPrompt) {
		promptDir = await mkdtemp(join(tmpdir(), "kyrn-agent-"));
		promptPath = join(promptDir, `${assignment.agent.name}.md`);
		await writeFile(promptPath, assignment.agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
	}
	try {
		return await new Promise<string>((resolve, reject) => {
			const invocation = piInvocation(childArgs(task, assignment, promptPath));
			const child = spawn(invocation.command, invocation.args, {
				// An isolated sub-agent works in its own checkout; everyone else where the parent is.
				cwd: assignment.cwd,
				// No stdin: print mode would otherwise wait for it when it is not a terminal.
				stdio: ["ignore", "pipe", "pipe"],
				// On the desktop app's Electron a sub-agent needs the variable its parent dropped (kyrn-judge.ts) to run as Node.
				env: {
					...process.env,
					...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
					KYRN_SWARM_DEPTH: "1",
					...env,
				},
			});
			let buffer = "";
			let stderr = "";
			let lastText = "";
			let failure: string | undefined;
			let settled = false;
			let finished = false;

			const terminate = () => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				// On Windows `kill` ends the sub-agent alone and orphans what it started: there the whole tree goes.
				const stop = stopPlan(process.platform, child.pid, false);
				if (stop.kind === "command") {
					spawn(stop.command, stop.args, { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
				} else child.kill(stop.signal);
				const hard = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}, KILL_GRACE_MS);
				hard.unref?.();
			};
			const finish = (error?: Error) => {
				if (finished) return;
				finished = true;
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve(lastText.trim());
			};
			const onAbort = () => {
				terminate();
				finish(new Error("the sub-agent was stopped"));
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });

			const onLine = (line: string) => {
				if (!line.trim()) return;
				let event: BeeEvent;
				try {
					event = JSON.parse(line) as BeeEvent;
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const stop = event.message.stopReason;
					if (stop === "error" || stop === "aborted") {
						failure = event.message.errorMessage ?? `the model request was ${stop}`;
					} else {
						failure = undefined;
						const text = textOf(event.message.content);
						if (text.trim()) lastText = text;
					}
				}
				observer?.event(event);
				if (event.type === "agent_settled") {
					settled = true;
					const grace = setTimeout(terminate, EXIT_GRACE_MS);
					grace.unref?.();
					finish(failure ? new Error(failure) : undefined);
				}
			};
			child.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) onLine(line);
			});
			child.stderr.on("data", (data: Buffer) => {
				stderr = (stderr + data.toString()).slice(-2000);
			});
			child.on("error", (error) => finish(error));
			child.on("close", (code, signal) => {
				if (buffer.trim()) onLine(buffer);
				if (settled) return;
				finish(exitedEarly(code, signal, stderr.trim().slice(-400)));
			});
		});
	} finally {
		if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
	}
};

/** Names are how the user and the board refer to a sub-agent, so two of them cannot share one. */
export function uniqueNames(names: readonly string[]): string[] {
	const seen = new Map<string, number>();
	return names.map((raw) => {
		const name = raw.trim() || "task";
		const count = (seen.get(name) ?? 0) + 1;
		seen.set(name, count);
		return count === 1 ? name : `${name}-${count}`;
	});
}

/** What the tool shows before the first sub-agent exists: routing is a judge call, and a judge call can take seconds. */
export function announceRouting(
	onUpdate:
		| ((partial: {
				content: { type: "text"; text: string }[];
				details: SwarmDetails | { code: string; params: { count: number } } | undefined;
		  }) => void)
		| undefined,
	count: number,
): void {
	onUpdate?.({
		content: [
			{
				type: "text",
				text: `choosing a role, a model and a thinking level for ${count} sub-agent${count === 1 ? "" : "s"}…`,
			},
		],
		// No snapshot yet: a client that translates says the same from the code.
		details: { code: "choosing_roles", params: { count } },
	});
}

/** Limits of a swarm, as they are written in mu.json. */
export const SWARM_LIMIT_DEFAULTS = {
	/** Minutes a sub-agent may work before it is told to wrap up and report. 0 means no budget. */
	beeMinutes: 10,
	/** Seconds it then has to hand in its report, from when it heard it was to; twice this at most from the asking. */
	graceSeconds: 90,
	/** Seconds without a sign of life before it is stopped: while the model thinks, and while a tool runs. */
	stallSeconds: 300,
	toolStallSeconds: 900,
};

export function limitsFrom(options: typeof SWARM_LIMIT_DEFAULTS & { concurrency: number }): Partial<SwarmLimits> {
	return {
		concurrency: options.concurrency,
		beeMinutes: options.beeMinutes,
		graceSeconds: options.graceSeconds,
		stallSeconds: options.stallSeconds,
		toolStallSeconds: options.toolStallSeconds,
	};
}

export interface SwarmDetails {
	snapshot: SwarmSnapshot;
	/** Set once the run is over. */
	reports?: string[];
}

/** Partial results at most this often: the picture changes with every streamed token. */
const UPDATE_EVERY_MS = 200;

/** Feeds the tool's partial results from a run, as text for whoever cannot draw and as a snapshot for the terminal. */
export function streamUpdates(
	run: SwarmRun<SwarmAssignment>,
	onUpdate: ((partial: { content: { type: "text"; text: string }[]; details: SwarmDetails }) => void) | undefined,
): void {
	if (!onUpdate) return;
	let last = 0;
	let pending: ReturnType<typeof setTimeout> | undefined;
	const send = () => {
		pending = undefined;
		last = Date.now();
		const snapshot = run.snapshot();
		onUpdate({
			content: [{ type: "text", text: swarmText(snapshot, { expanded: false, width: 120 }) }],
			details: { snapshot },
		});
	};
	run.onChange = () => {
		if (run.endedAt !== undefined) {
			if (pending) clearTimeout(pending);
			return;
		}
		const wait = UPDATE_EVERY_MS - (Date.now() - last);
		if (wait <= 0) send();
		else pending ??= setTimeout(send, wait);
	};
}

/** The terminal's view of a swarm tool call: live while it runs, a summary with the reports behind ctrl+o when it is over. */
export function renderSwarmResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	options: { expanded: boolean },
	theme: Theme,
): { render(width: number): string[]; invalidate(): void } {
	const details = result.details as SwarmDetails | undefined;
	return {
		render: (width: number) => {
			// The status before the first snapshot ("choosing a role…") is cut to the width too: a longer line kills the TUI (#7).
			if (!details?.snapshot)
				return (result.content[0]?.text ?? "")
					.split("\n")
					.slice(0, options.expanded ? 400 : 12)
					.map((line) => truncateToWidth(line, width, "…"));
			return renderSwarm(details.snapshot, { expanded: options.expanded, width, reports: details.reports }, theme);
		},
		invalidate() {},
	};
}

/** A snapshot small enough to keep in the session: what each bee came to, without its activity log or its words. */
export function compactSnapshot(snapshot: SwarmSnapshot): SwarmSnapshot {
	return {
		...snapshot,
		bees: snapshot.bees.map((bee) => ({ ...bee, recent: [], finals: [], said: undefined })),
		board: snapshot.board ? { ...snapshot.board, latest: snapshot.board.latest.slice(-8) } : undefined,
	};
}

function describeAgent(agent: AgentDefinition): string {
	const pins = [agent.model, agent.thinking && `thinking ${agent.thinking}`].filter(Boolean).join(", ");
	return `${agent.name} (${agent.source}${pins ? `, ${pins}` : ""}): ${agent.description}\n  tools: ${agent.tools?.join(", ") ?? "all"}`;
}

/**
 * C1-C4, the swarm. pi has no sub-agents by design; mu adds one tool. Each
 * task runs in its own context window, and because that context starts empty,
 * the judge can give every task the role, the cheapest model and the thinking
 * level that fit it without costing the main session any prompt cache.
 *
 * Roles use pi's agent file format, so files written for pi's subagent
 * example work here unchanged. With no configuration at all this still
 * works: built-in roles, the session's own model, judge-picked thinking.
 */
export function registerSwarm(runtime: KyrnRuntime, runner: SwarmRunner = spawnRunner): void {
	const options = runtime.options("swarm", {
		enabled: true,
		/** Cheapest to strongest. Empty means every sub-agent uses the session's current model. */
		models: [] as string[],
		maxTasks: 6,
		concurrency: 3,
		/** The role for tasks that fit none. Set to "" for a plain sub-agent with no role. */
		defaultAgent: "worker",
		/** Where the user's own roles live. Empty means `<agentDir>/agents`. */
		agentsDir: "",
		/** `worktree`: a role that edits files works in its own git worktree and hands back a patch. `none`: everyone works in place. */
		isolation: "worktree",
		/** An isolated sub-agent starts from the parent's uncommitted state, not from the last commit. */
		carryUncommitted: true,
		/** Lines of a patch shown with the sub-agent's report. */
		patchPreviewLines: 30,
		...SWARM_LIMIT_DEFAULTS,
	});
	// A sub-agent does not get to spawn its own swarm.
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;
	const isolation = new Isolation(runtime, options);
	isolation.registerTool();

	// Read per call: a role file edited mid-session applies to the next delegation.
	const agents = (): AgentDefinition[] => loadAgents(options.agentsDir || join(getAgentDir(), "agents"));
	// A role needs at least one of its tools to exist here: "browser" without the browse tool would be a dead end.
	const usable = (): AgentDefinition[] => {
		const known = new Set(pi.getAllTools().map((tool) => tool.name));
		return agents().filter((agent) => !agent.tools || agent.tools.some((tool) => known.has(tool)));
	};

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: `Run tasks in fresh sub-agents, each with its own context window: in parallel for parts that do not depend on each other and for side work whose details you do not need (broad code search, web research), or with chain: true one after another, each step handed what the step before reported (scout, then plan, then implement). Each sub-agent sees only its own instructions, so make them self-contained. Give each part what must be true when it is done (done) and, when it is for an item of your todo list, that item's id (serves): the sub-agent works to that list, and you get back which criteria it met with its evidence. A fitting role, model and thinking level are chosen per task; name a role only when you want a specific one (${agents()
			.map((agent) => agent.name)
			.join(
				", ",
			)}). Returns each sub-agent's final report. In a git repository a sub-agent that edits files works in an isolated copy, and its changes come back as a patch that only apply_patch_from brings in.`,
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					title: Type.String({ description: "Short name of the task" }),
					instructions: Type.String({
						description: "Complete, self-contained instructions, including what to report back",
					}),
					agent: Type.Optional(Type.String({ description: "Role name. Leave out to have one chosen." })),
					done: Type.Optional(
						Type.Array(Type.String(), {
							maxItems: MAX_DONE,
							description: "What must be true when this part is done, one checkable statement each",
						}),
					),
					serves: Type.Optional(
						Type.String({ description: "Id of the item of your todo list this part is for, such as a2" }),
					),
					isolation: Type.Optional(
						Type.Union([Type.Literal("worktree"), Type.Literal("none")], {
							description:
								"worktree: edit in an isolated copy and hand back a patch (default for roles that edit). none: edit in place",
						}),
					),
				}),
				{ minItems: 1 },
			),
			chain: Type.Optional(
				Type.Boolean({
					description:
						"Run the tasks in order, one at a time; each gets the report of the one before. Stops at the first step that does not finish. Steps edit in place unless one asks for a worktree",
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			runtime.touch(ctx);
			const parent = runtime.frame;
			// What the user asked for goes down with each part: inside the sub-agent it is what its calls are weighed against.
			const userGoal = userWords(runtime.turn.userMessage);
			// Each part gets a frame of its own: the part as its goal, the caller's criteria as its checklist.
			const tasks: SwarmTask[] = params.tasks.slice(0, options.maxTasks).map((task) => ({
				title: task.title,
				instructions: task.instructions,
				agent: task.agent,
				brief: briefFor(task, parent, userGoal),
			}));
			const constraints = (parent?.constraints ?? []).map((constraint) => constraint.text);
			const inheritedConstraints =
				constraints.length > 0 ? { KYRN_SWARM_CONSTRAINTS: JSON.stringify(constraints.slice(-12)) } : undefined;
			const names = uniqueNames(tasks.map((task) => task.title));
			announceRouting(onUpdate, tasks.length);
			const roles = usable();
			const byName = new Map(roles.map((agent) => [agent.name, agent]));
			const menu = Object.fromEntries(roles.map((agent) => [agent.name, agent.description]));

			// What this project's lessons say about each part, asked alongside the routing: it costs the wait of neither.
			const lessons = runtime.knownLessons?.(
				tasks.map((task) => `${task.title}: ${task.instructions}`),
				signal,
			);
			const routes = await runtime.engine.decideMany(
				swarmRouting,
				tasks.map((task) => ({
					task: clip(`${task.title}: ${task.instructions}`, 600),
					// A role the caller named is settled, so the judge is only asked how hard the task is.
					agents: task.agent && byName.has(task.agent) ? undefined : menu,
				})),
				{ signal },
			);
			const known = (await lessons?.catch(() => undefined)) ?? [];
			tasks.forEach((task, index) => {
				const found = known[index];
				if (task.brief && found && found.length > 0) task.brief = { ...task.brief, lessons: found };
			});
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const sessionThinking = pi.getThinkingLevel();
			const assignments: SwarmAssignment[] = routes.map((route, index) => {
				const named = tasks[index].agent ? byName.get(tasks[index].agent ?? "") : undefined;
				// The judge routes whatever the decision mode: a delegated task has no "unchanged behaviour" to fall back to.
				const judged = route.judged?.agent ? byName.get(route.judged.agent) : undefined;
				const agent = named ?? judged ?? byName.get(options.defaultAgent);
				const verdict = route.judged ?? route.outcome;
				const model = agent?.model ?? pickModel(options.models, verdict.strength) ?? current;
				return {
					agent,
					model,
					thinking: thinkingForRoute({
						pinned: agent?.thinking,
						model,
						sessionModel: current,
						sessionThinking,
						judged: verdict.thinking,
					}),
					routedBy: named ? "caller" : judged ? "judge" : "default",
				};
			});

			// Who edits gets a checkout of its own, if there is a repository to make one from.
			const runDir = join(tmpdir(), `kyrn-swarm-${randomUUID().slice(0, 8)}`);
			const isolated = new Map<SwarmTask, number>();
			tasks.forEach((task, index) => {
				// In a chain each step builds on the one before, so it has to see that step's edits: in place unless asked.
				const asked = params.tasks[index].isolation ?? (params.chain ? "none" : undefined);
				if (isolation.wanted(asked, assignments[index].agent) === "worktree") isolated.set(task, index);
			});
			const outcomesOfIsolation = new Map<SwarmTask, IsolationOutcome>();
			const stepped = params.chain ? chainRunner(runner) : runner;
			let placedRunner = stepped;
			if (isolated.size > 0) {
				const { repo, problem } = await isolation.repo(ctx.cwd);
				if (repo) {
					placedRunner = isolation.wrap(
						stepped,
						{ repo, cwd: ctx.cwd, runDir, trusted: ctx.isProjectTrusted(), isolated },
						outcomesOfIsolation,
					);
				} else {
					for (const task of isolated.keys()) {
						outcomesOfIsolation.set(task, {
							isolated: false,
							notes: [`Not isolated (${problem}): it worked in place, in your working tree.`],
						});
					}
				}
			}

			const run = new SwarmRun<SwarmAssignment>({
				kind: "delegate",
				title: params.chain
					? `a chain of ${tasks.length} step${tasks.length === 1 ? "" : "s"}`
					: `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
				titleCode: { code: params.chain ? "delegate_chain" : "delegate_tasks", params: { count: tasks.length } },
				dir: runDir,
				limits: { ...limitsFrom(options), ...(params.chain ? { concurrency: 1 } : {}) },
				bees: tasks.map((task, index) => ({
					name: names[index],
					task,
					assignment: assignments[index],
					role: assignments[index].agent?.name,
					model: assignments[index].model,
					thinking: assignments[index].thinking,
					env: {
						// What the user ruled out for the task holds for whoever works on a part of it.
						...inheritedConstraints,
						// So does how much it may do without asking.
						...permissionEnv(runtime),
						...(task.brief
							? { [BRIEF_ENV]: briefEnv(task.brief), [FRAME_OUT_ENV]: frameOutPath(runDir, index) }
							: {}),
					},
				})),
			});
			streamUpdates(run, onUpdate);
			const outcomes = await run.run(placedRunner, signal);
			const reports = outcomes.map((outcome) => outcome.report);
			const frames = await Promise.all(tasks.map((_task, index) => readFrameOut(frameOutPath(runDir, index))));
			// The judge's view of what wants to come back. It is a line of text, never a gate.
			await isolation.review(outcomesOfIsolation, signal).catch(() => undefined);

			const text = tasks
				.map((task, index) => {
					const { agent, model, thinking } = assignments[index];
					const label = [agent?.name ?? "no role", model ?? "default model", `thinking ${thinking}`].join(", ");
					const checklist = describeFrameOut(frames[index], task.brief?.serves);
					return `## ${params.chain ? `${index + 1}. ` : ""}${task.title} [${label}]\n${reports[index]}${checklist ? `\n\n${checklist}` : ""}${isolation.describe(outcomesOfIsolation.get(task))}`;
				})
				.join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: {
					snapshot: compactSnapshot(run.snapshot()),
					reports,
					frames: frames.map((frame) => frame ?? null),
					patches: tasks.map((task) => outcomesOfIsolation.get(task)?.patch?.id ?? null),
					assignments: assignments.map(({ agent, model, thinking, routedBy }) => ({
						agent: agent?.name,
						model,
						thinking,
						routedBy,
					})),
				},
			};
		},
		renderResult: (result, renderOptions, theme) => renderSwarmResult(result, renderOptions, theme),
	});

	registerSwarmCommand(runtime);

	pi.registerCommand("agents", {
		description: say({
			zh: "列出 delegate 工具能用的子代理角色，以及在哪里加你自己的",
			en: "List the sub-agent roles the delegate tool can use, and where to add your own",
		}),
		handler: async (_args, ctx) => {
			const dir = options.agentsDir || join(getAgentDir(), "agents");
			const ladder = options.models.length > 0 ? options.models.join(" < ") : "the session's current model";
			ctx.ui.notify(
				[
					...agents().map(describeAgent),
					"",
					`models: ${ladder}`,
					`Add or override a role with a markdown file in ${dir} (frontmatter: name, description, tools, model, thinking).`,
				].join("\n"),
				"info",
			);
		},
	});
}

const withCommand = new WeakSet<KyrnRuntime>();

/** Where `/swarm` and `/hive` say what they have to say. */
export interface SwarmCommandContext {
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

/**
 * What `/swarm [stop|kill] [name]` does, and `/hive` without a question. `idle` is what is said when nothing
 * runs, for a command that has more to offer then.
 */
export function controlSwarm(runtime: KyrnRuntime, args: string, ctx: SwarmCommandContext, idle?: string): void {
	const [verb = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const name = rest.join(" ") || undefined;
	const runs = activeRuns();
	// What isolated sub-agents handed back stays listed after they are gone: it is waiting for a decision.
	const patches = patchesOf(runtime).map((record) => `  ${describeRecord(record)}`);
	const patchList = patches.length > 0 ? `patches (apply_patch_from brings one in)\n${patches.join("\n")}` : "";
	if (runs.length === 0) {
		ctx.ui.notify(
			[patchList || "No sub-agents are running. They start when the agent uses its delegate or hive tool.", idle]
				.filter(Boolean)
				.join("\n"),
			"info",
		);
		return;
	}
	if (verb === "stop" || verb === "kill") {
		const reached = runs.reduce(
			(sum, run) =>
				sum +
				(verb === "stop"
					? run.wrapUp(name, "stopped by the user", { code: "stopped_by_user" })
					: run.kill(name, "ended by the user", "stopped", { code: "ended_by_user" })),
			0,
		);
		ctx.ui.notify(
			reached === 0
				? `Nothing to ${verb}${name ? ` named "${name}"` : ""}. Running: ${runs.flatMap((run) => run.bees.map((bee) => bee.name)).join(", ")}`
				: verb === "stop"
					? `Asked ${reached} sub-agent${reached === 1 ? "" : "s"} to stop and report. Anything that has not reported in time is ended.`
					: `Ended ${reached} sub-agent${reached === 1 ? "" : "s"}. What they had found is kept.`,
			reached === 0 ? "warning" : "info",
		);
		return;
	}
	ctx.ui.notify(
		[...runs.map((run) => swarmText(run.snapshot(), { expanded: true, width: 110 })), patchList]
			.filter(Boolean)
			.join("\n\n"),
		"info",
	);
}

/**
 * `/swarm`: look at the sub-agents that are running right now, and end them
 * without losing what they found. Commands run while the agent is busy, so
 * this works in the middle of a hive or a delegate call, which is when it is
 * needed. Esc cancels the whole tool call and throws its results away; this
 * does not. (`/hive` does the same without a question: see hive.ts.)
 */
export function registerSwarmCommand(runtime: KyrnRuntime): void {
	// The swarm and the hive both bring it; one session gets it once.
	if (withCommand.has(runtime)) return;
	withCommand.add(runtime);
	runtime.pi.registerCommand("swarm", {
		description: say({
			zh: "正在干活的子代理：/swarm 看每个在做什么，/swarm stop [名字] 让它现在交报告，/swarm kill [名字] 立刻结束它",
			en: "Sub-agents at work: /swarm (what each one is doing), /swarm stop [name] (report now), /swarm kill [name]",
		}),
		// No argument completions on purpose: with them the first Enter picks a completion and only the
		// second one runs the command, and "stop" is typed by someone who wants it to happen now.
		handler: async (args, ctx) => controlSwarm(runtime, args, ctx),
	});
}
