import { createHash } from "node:crypto";
import { type DriftInput, type DriftOutcome, turnDrift } from "../../decisions/turn-drift.ts";
import { openItems } from "../../frame/frame.ts";
import { clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";
import { describeCall } from "./admission.ts";

const MINUTE = 60_000;

/**
 * Which call this was and what came of it, for the loop rule. `describeCall` is for reading: it keeps the path of a
 * read and drops its offset, and cuts a script after 300 characters, so a file paged through and two scripts that
 * differ only further down would look like one call made three times. The key holds all of the input and the result.
 */
function callKey(toolName: string, input: unknown, isError: boolean, content: unknown): string {
	return createHash("sha1")
		.update(JSON.stringify([toolName, input ?? null, isError, textOf(content)]))
		.digest("hex");
}

/** One tool result as the drift check reads it. */
export interface ObservedCall {
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly isError: boolean;
	/** The result text the model sees. */
	readonly text: string;
	/** A shell command's exit code, when the tool reported one. */
	readonly exitCode?: number;
	readonly durationMs?: number;
}

/** Lines a shell tool adds about how the command ended or was cut: the exit code already says it. */
const STATUS_LINE =
	/^(?:Command exited with code -?\d+|Command timed out after .*|Command aborted|Command terminated without an exit code|\[Showing .*\]|\(no output\))$/;

/** The last line of output that is not the tool's own note about how the command ended. */
export function lastLine(text: string): string {
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index].trim();
		if (line && !STATUS_LINE.test(line)) return line;
	}
	return "";
}

function duration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
}

/** `bash: make -> exit 2 in 14s; last line: <line>`. A shell command or an error shows its last line; a read does not. */
export function actionLine(call: ObservedCall): string {
	const value = call.input.command ?? call.input.pattern ?? call.input.path ?? call.input.query;
	const what = clip(typeof value === "string" ? value : JSON.stringify(call.input), 160);
	const status = call.exitCode !== undefined ? `exit ${call.exitCode}` : call.isError ? "error" : "ok";
	const took = call.durationMs !== undefined ? ` in ${duration(call.durationMs)}` : "";
	const last = isShellTool(call.toolName) || call.isError ? clip(lastLine(call.text), 100) : "";
	return `${call.toolName}: ${what} -> ${status}${took}${last ? `; last line: ${last}` : ""}`;
}

/** Numbers change between runs of the same thing: times, process ids, line numbers. */
function shape(line: string): string {
	return line.toLowerCase().replace(/\d+/g, "#");
}

/** The same call (whole input) with the same outcome (exit status and last line, numbers aside). */
function outcomeKey(call: ObservedCall): string {
	return createHash("sha1")
		.update(
			JSON.stringify([call.toolName, call.input ?? null, call.exitCode ?? call.isError, shape(lastLine(call.text))]),
		)
		.digest("hex");
}

/** A here document's lines are what goes into a file, not commands: `if a > b:` redirects nothing. */
function withoutHeredocs(command: string): string {
	const kept: string[] = [];
	let end: string | undefined;
	for (const line of command.split("\n")) {
		if (end !== undefined) {
			if (line.trim() === end) end = undefined;
			continue;
		}
		kept.push(line);
		end = /<<-?\s*['"]?(\w+)['"]?/.exec(line)?.[1];
	}
	return kept.join("\n");
}

/** Files a call wrote: what `write` and `edit` changed, and the targets of a shell command's `>`, `>>` and `tee`. */
export function writtenPaths(call: ObservedCall): string[] {
	if (call.toolName === "write" || call.toolName === "edit") {
		return !call.isError && typeof call.input.path === "string" ? [call.input.path] : [];
	}
	if (!isShellTool(call.toolName) || typeof call.input.command !== "string") return [];
	const bare = withoutHeredocs(call.input.command).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
	const paths: string[] = [];
	for (const match of bare.matchAll(
		/(?:^|[^<>&\d])(?:\d?>{1,2}|&>)\s*([^\s;&|<>()']+)|\btee\s+(?:-a\s+)?([^\s;&|<>()']+)/g,
	)) {
		const path = match[1] ?? match[2];
		if (path && !path.startsWith("/dev/")) paths.push(path);
	}
	return paths;
}

function lastCount(text: string, pattern: RegExp): number | undefined {
	let found: number | undefined;
	for (const match of text.matchAll(pattern)) found = Number(match[1] ?? match[2]);
	return found;
}

/** The pass and fail counts of a test runner's summary (pytest, jest, vitest, mocha, cargo, unittest), if any. */
export function testCounts(text: string): { passed?: number; failed?: number } {
	const tail = text.slice(-4000);
	return {
		passed: lastCount(tail, /\b(\d+) (?:tests? )?(?:passed|passing)\b/gi),
		failed: lastCount(tail, /\b(\d+) (?:tests? )?(?:failed|failing)\b|\bfailures=(\d+)/gi),
	};
}

/**
 * Signs that a run moves, read from its tool results: a file written for the first time, more tests passing or
 * fewer failing than ever before, an error not seen before, a call that failed now passing, a call that ran a minute
 * or more and succeeded (an install, a build, a batch job, a sub-agent: work done, whatever it wrote), an item
 * ticked. Reads, searches, another edit of the same file and the same error again are not progress.
 */
export class Progress {
	private readonly written = new Set<string>();
	private readonly errors = new Set<string>();
	/** Calls (tool and whole input) whose last run failed. */
	private readonly failing = new Set<string>();
	/** Calls that ran long and succeeded: running the same one again is waiting, not new work. */
	private readonly worked = new Set<string>();
	private mostPassed = -1;
	private fewestFailed = Number.POSITIVE_INFINITY;

	/** True when this result is a sign of progress. */
	observe(call: ObservedCall): boolean {
		let moved = false;
		for (const path of writtenPaths(call)) {
			if (this.written.has(path)) continue;
			this.written.add(path);
			moved = true;
		}
		if (call.toolName === "todo" && call.input.action === "done" && !call.isError) moved = true;
		if (isShellTool(call.toolName)) {
			const counts = testCounts(call.text);
			if (counts.passed !== undefined && counts.passed > this.mostPassed) {
				this.mostPassed = counts.passed;
				moved = true;
			}
			if (counts.failed !== undefined && counts.failed < this.fewestFailed) {
				this.fewestFailed = counts.failed;
				moved = true;
			}
		}
		const same = JSON.stringify([call.toolName, call.input ?? null]);
		if (call.isError || (call.exitCode ?? 0) !== 0) {
			const error = shape(lastLine(call.text));
			if (!this.errors.has(error)) {
				this.errors.add(error);
				moved = true;
			}
			this.failing.add(same);
			return moved;
		}
		if (this.failing.delete(same)) moved = true;
		if ((call.durationMs ?? 0) >= MINUTE && !this.worked.has(same)) {
			this.worked.add(same);
			moved = true;
		}
		return moved;
	}
}

export interface WatchOptions {
	/** Tool results that make a check due, once `minMinutes` have passed since the last one. */
	readonly every: number;
	readonly minMinutes: number;
	/** A check is due this long after the last one, whatever happened. */
	readonly maxMinutes: number;
	/** A drift steer needs this long without progress. */
	readonly stuckMinutes: number;
	/** At most one steer per this long. */
	readonly cooldownMinutes: number;
	/** Recent calls the judge sees. */
	readonly window: number;
}

export type WatchSteer =
	| { readonly kind: "drift"; readonly minutes: number; readonly latest: string }
	| { readonly kind: "loop"; readonly minutes: number; readonly action: string; readonly times: number };

/**
 * What the drift check knows about one user turn, and when it asks. It has no timer and no clock of its own: every
 * method takes the time, so tests and an offline replay of recorded sessions drive it with theirs. Time the agent
 * spends waiting between runs does not count: `pause` at the end of a run, `resume` at the start of the next.
 */
export class DriftWatch {
	private readonly options: WatchOptions;
	private readonly progress = new Progress();
	private readonly lines: string[] = [];
	private readonly outcomes: string[] = [];
	/** Outcome keys a loop steer has named already. */
	private readonly warned = new Set<string>();
	private idleMs = 0;
	private pausedAt: number | undefined;
	private readonly startedAt: number;
	private lastProgressAt: number;
	private lastCheckAt: number;
	private sinceCheck = 0;
	private lastSteerAt: number | undefined;
	private previous: DriftOutcome | undefined;

	constructor(options: WatchOptions, now: number) {
		this.options = options;
		this.startedAt = now;
		this.lastProgressAt = now;
		this.lastCheckAt = now;
	}

	private clock(now: number): number {
		return now - this.idleMs - (this.pausedAt === undefined ? 0 : now - this.pausedAt);
	}

	pause(now: number): void {
		this.pausedAt ??= now;
	}

	resume(now: number): void {
		if (this.pausedAt === undefined) return;
		this.idleMs += now - this.pausedAt;
		this.pausedAt = undefined;
	}

	/** True once there is something to judge. */
	get hasActions(): boolean {
		return this.lines.length > 0;
	}

	observe(call: ObservedCall, now: number): void {
		this.lines.push(actionLine(call));
		this.outcomes.push(outcomeKey(call));
		if (this.lines.length > this.options.window) {
			this.lines.shift();
			this.outcomes.shift();
		}
		this.sinceCheck++;
		if (this.progress.observe(call)) this.lastProgressAt = this.clock(now);
	}

	/** Enough tool results and enough time since the last check, or long enough whatever happened. */
	due(now: number): boolean {
		const since = this.clock(now) - this.lastCheckAt;
		return (
			(this.sinceCheck >= this.options.every && since >= this.options.minMinutes * MINUTE) ||
			since >= this.options.maxMinutes * MINUTE
		);
	}

	/** Milliseconds until a check is due whatever happens. */
	untilDue(now: number): number {
		return Math.max(0, this.lastCheckAt + this.options.maxMinutes * MINUTE - this.clock(now));
	}

	minutesSinceProgress(now: number): number {
		return Math.floor((this.clock(now) - this.lastProgressAt) / MINUTE);
	}

	/** The outcome key that came back most often in the window, and how often. */
	private mostRepeated(): { key: string; index: number; times: number } {
		let best = { key: "", index: -1, times: 0 };
		for (let index = this.outcomes.length - 1; index >= 0; index--) {
			const key = this.outcomes[index];
			const times = this.outcomes.filter((each) => each === key).length;
			if (times > best.times) best = { key, index, times };
		}
		return best;
	}

	/** What the judge is asked. Asking starts the count toward the next check. */
	ask(frame: { goal: string; subgoal?: string; openItem?: string }, now: number): DriftInput {
		const at = this.clock(now);
		this.lastCheckAt = at;
		this.sinceCheck = 0;
		return {
			goal: frame.goal,
			...(frame.subgoal ? { subgoal: frame.subgoal } : {}),
			...(frame.openItem ? { openItem: frame.openItem } : {}),
			recentActions: [...this.lines],
			minutesSinceProgress: this.minutesSinceProgress(now),
			elapsedMinutes: Math.floor((at - this.startedAt) / MINUTE),
			repeats: Math.max(1, this.mostRepeated().times),
		};
	}

	/**
	 * What to do with a check's reading (undefined when the judge gave none). A drift reading steers only when the
	 * check before it read drift too and nothing has moved for `stuckMinutes`; a loop reading steers once per call it
	 * names. Neither steers within `cooldownMinutes` of the last steer.
	 */
	read(reading: DriftOutcome | undefined, now: number): WatchSteer | undefined {
		const previous = this.previous;
		this.previous = reading;
		const at = this.clock(now);
		if (this.lastSteerAt !== undefined && at - this.lastSteerAt < this.options.cooldownMinutes * MINUTE) {
			return undefined;
		}
		const minutes = this.minutesSinceProgress(now);
		if (reading === "loop") {
			const repeated = this.mostRepeated();
			if (repeated.index < 0 || this.warned.has(repeated.key)) return undefined;
			this.warned.add(repeated.key);
			this.lastSteerAt = at;
			return { kind: "loop", minutes, action: this.lines[repeated.index], times: repeated.times };
		}
		if (reading !== "drift" || previous !== "drift") return undefined;
		if (at - this.lastProgressAt < this.options.stuckMinutes * MINUTE) return undefined;
		this.lastSteerAt = at;
		return { kind: "drift", minutes, latest: this.lines.at(-1) ?? "" };
	}

	/** The loop rule steered about the latest call: it counts toward the cool-down, and the judge does not name it again. */
	steeredOnLoop(now: number): void {
		this.lastSteerAt = this.clock(now);
		const latest = this.outcomes.at(-1);
		if (latest) this.warned.add(latest);
	}
}

function steerText(steer: WatchSteer, openItem: string | undefined): string {
	const quiet = steer.minutes === 1 ? "1 minute" : `${steer.minutes} minutes`;
	if (steer.kind === "loop") {
		const times = steer.times > 1 ? ` came back the same ${steer.times} times` : " looks repeated";
		return `The recent steps look like a loop: ${clip(steer.action, 160)}${times}, and nothing has moved in ${quiet}. Say what it told you and try a different approach.`;
	}
	const on = openItem ? ` on "${clip(openItem, 100)}"` : "";
	return `Check your course: nothing has moved${on} in ${quiet}, and the recent steps (latest: ${clip(steer.latest, 160)}) look unrelated to the goal. Try a different approach, or say in one line why this one is needed.`;
}

/**
 * A shell command's exit code and wall time: as the tool reports them alongside its text, else from the text (a
 * failed command ends on "Command exited with code N"). A command that timed out or was aborted has no exit code.
 */
function shellFacts(
	toolName: string,
	text: string,
	isError: boolean,
	structured: unknown,
): { exitCode?: number; durationMs?: number } {
	if (!isShellTool(toolName)) return {};
	const record = (typeof structured === "object" && structured !== null ? structured : {}) as {
		exit_code?: unknown;
		wall_time_seconds?: unknown;
	};
	const said = /Command exited with code (-?\d+)\s*$/.exec(text)?.[1];
	const exitCode =
		typeof record.exit_code === "number" ? record.exit_code : said ? Number(said) : isError ? undefined : 0;
	return {
		...(exitCode !== undefined ? { exitCode } : {}),
		...(typeof record.wall_time_seconds === "number" ? { durationMs: record.wall_time_seconds * 1000 } : {}),
	};
}

/**
 * B5: a loop is a fact (the same call with the same result, three times), so a rule catches it. Drift is a judgment,
 * asked in the background once enough has happened (`every` tool results and `minMinutes`), or once enough time has
 * passed whatever happened (`maxMinutes`, on a timer, so a long silent reply is covered too). The judge sees what
 * shows whether the run moves; a steer needs drift twice in a row and `stuckMinutes` without progress, or a loop
 * reading, and at most one comes per `cooldownMinutes`. Either one earns the agent a single line, not a lecture.
 * In shadow mode the same rules run on the judge's reading, and what would have been said is recorded, not sent.
 */
export function registerMonitor(runtime: KyrnRuntime): void {
	const options = runtime.options("monitor", {
		enabled: true,
		every: 6,
		minMinutes: 3,
		maxMinutes: 10,
		stuckMinutes: 10,
		cooldownMinutes: 15,
		repeats: 3,
		window: 8,
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	/** The last `repeats` calls as the loop rule compares them. */
	let keys: string[] = [];
	let warnedLoops = new Set<string>();
	/** When each call started, for tools that do not report their own time. */
	const started = new Map<string, number>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Ended with the run: a verdict after it has nothing left to steer. */
	let run: AbortController | undefined;
	let asking = false;
	/** A new turn's watch. Its clock stands still until a run starts: the wait for one is not the agent's time. */
	const fresh = (): DriftWatch => {
		const next = new DriftWatch(options, Date.now());
		if (!run) next.pause(Date.now());
		return next;
	};
	let watch = fresh();

	const steer = (content: string) => {
		pi.sendMessage({ customType: "kyrn.steer", content, display: true }, { deliverAs: "steer" });
	};

	const stopTimer = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const check = (): void => {
		if (!run || asking || runtime.mode(turnDrift.id) === "off") return;
		const frame = runtime.taskFrame();
		if (!frame?.goal || !watch.hasActions) return;
		const openItem = openItems(runtime.frame)[0]?.text;
		const asked = watch;
		const input = asked.ask(
			{ goal: frame.goal, subgoal: frame.currentSubgoal, openItem: openItem && clip(openItem, 200) },
			Date.now(),
		);
		schedule();
		asking = true;
		void runtime.engine
			.decide(turnDrift, input, { signal: run.signal })
			.then((decision) => {
				// A new message started another turn while the judge was out: its reading is about the old one.
				if (asked !== watch) return;
				// What the judge read counts in shadow mode too, so the record says what an active check would have done.
				const said = asked.read(decision.judged, Date.now());
				if (!said) return;
				const content = steerText(said, openItem);
				if (decision.source !== "judge") {
					pi.appendEntry("kyrn.monitor", { kind: said.kind, judged: true, shadow: true, content });
					return;
				}
				pi.appendEntry("kyrn.monitor", { kind: said.kind, judged: true, content });
				runtime.trouble(
					said.kind,
					said.kind === "loop" ? said.action : "the recent steps look unrelated to the goal",
				);
				steer(content);
			})
			.catch(() => {})
			.finally(() => {
				asking = false;
				// A timer that came due while the judge was out found it busy: the next one counts from this check.
				if (!timer) schedule();
			});
	};

	/** The check that comes `maxMinutes` after the last one, even when no tool result arrives. It never keeps the process alive. */
	const schedule = () => {
		stopTimer();
		if (!run) return;
		timer = setTimeout(() => {
			timer = undefined;
			try {
				check();
			} catch {
				// Outside any event handler: a failing check must not take the process down.
			}
		}, watch.untilDue(Date.now()));
		timer.unref();
	};

	pi.on(
		"input",
		failOpen((event) => {
			if (event.source !== "extension" && !event.streamingBehavior) {
				keys = [];
				warnedLoops = new Set();
				started.clear();
				watch = fresh();
			}
			return undefined;
		}),
	);

	pi.on(
		"agent_start",
		failOpen(() => {
			run?.abort();
			run = new AbortController();
			watch.resume(Date.now());
			schedule();
			return undefined;
		}),
	);

	const end = () => {
		stopTimer();
		run?.abort();
		run = undefined;
		watch.pause(Date.now());
	};
	pi.on(
		"agent_end",
		failOpen(() => {
			end();
			return undefined;
		}),
	);
	pi.on(
		"session_shutdown",
		failOpen(() => {
			end();
			return undefined;
		}),
	);

	pi.on(
		"tool_call",
		failOpen((event) => {
			started.set(event.toolCallId, Date.now());
			return undefined;
		}),
	);

	pi.on(
		"tool_result",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			const now = Date.now();
			const toolName = "toolName" in event ? String(event.toolName) : "tool";
			const action = `${describeCall(toolName, event.input)} -> ${event.isError ? "error" : "ok"}`;
			const key = callKey(toolName, event.input, event.isError, event.content);
			const since = started.get(event.toolCallId);
			started.delete(event.toolCallId);
			const text = textOf(event.content);
			const facts = shellFacts(toolName, text, event.isError, event.structuredContent);
			watch.observe(
				{
					toolName,
					input: event.input,
					isError: event.isError,
					text,
					...(since !== undefined ? { durationMs: now - since } : {}),
					...facts,
				},
				now,
			);
			keys = [...keys, key].slice(-options.repeats);

			const looping = keys.length === options.repeats && keys.every((entry) => entry === key);
			if (looping && !warnedLoops.has(key)) {
				warnedLoops.add(key);
				watch.steeredOnLoop(now);
				pi.appendEntry("kyrn.monitor", { kind: "loop", action });
				runtime.trouble("loop", action);
				steer(
					`The same call has now run ${options.repeats} times with the same outcome (${action}). Say what it told you and try a different approach.`,
				);
				return undefined;
			}

			if (watch.due(now)) check();
			return undefined;
		}),
	);
}
