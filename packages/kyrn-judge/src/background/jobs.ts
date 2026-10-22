import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	createWriteStream,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	statSync,
	type WriteStream,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { OutputCleaner, RingBuffer } from "./ring-buffer.ts";
import { groupAlive, type KillStep, killPlan, runKillStep, type SpawnPlan } from "./shell.ts";

/**
 * Background jobs: commands that outlive the tool call that started them.
 *
 * Each job writes to a ring buffer (what the model reads, newest kept) and to a
 * log file (everything, raw). A job is its shell AND whatever the shell started:
 * on POSIX the shell leads a process group, so stopping a job signals the group,
 * first SIGTERM and after a grace period SIGKILL. A command that backgrounds its
 * own child (`server &`) leaves the group alive after the shell exits; such a job
 * is reported as `lingering` and is still stopped with the rest.
 *
 * With `outputToFile` a job writes straight to its log file and the buffer is
 * filled from there, so the job does not need this process to go on: `release`
 * leaves such jobs running when a one-shot run ends.
 */
export type StoppedBy = "model" | "user" | "shutdown";

export interface JobInfo {
	readonly id: string;
	readonly name: string;
	readonly command: string;
	readonly cwd: string;
	readonly pid: number | undefined;
	readonly state: "running" | "exited";
	/** A shell killed by a signal reports 128 + the signal number, as shells do. */
	readonly exitCode: number | undefined;
	readonly stoppedBy: StoppedBy | undefined;
	/** The shell has exited but processes it started are still running (POSIX). */
	readonly lingering: boolean;
	readonly startedAt: number;
	readonly durationMs: number;
	readonly logPath: string;
	/** Characters written so far, and how many of them no `read` has returned yet. */
	readonly total: number;
	readonly unread: number;
}

export type JobEvent =
	| { readonly type: "start"; readonly job: JobInfo }
	/** `observed`: a `wait` on this job was in flight, so its caller is being told already. */
	| { readonly type: "exit"; readonly job: JobInfo; readonly observed: boolean }
	| { readonly type: "stop"; readonly job: JobInfo }
	| { readonly type: "match"; readonly job: JobInfo; readonly line: string };

export interface JobManagerOptions {
	readonly logDir: string;
	/** Jobs that may run at the same time. */
	readonly maxJobs: number;
	readonly bufferChars: number;
	readonly killGraceMs: number;
	/** The log stops growing here; the ring buffer goes on. */
	readonly maxLogBytes?: number;
	/** Finished jobs kept for `list` and late reads. */
	readonly keepFinished?: number;
	readonly platform?: NodeJS.Platform;
	/**
	 * The command writes to its log file, not to a pipe, and the output is read back from the file. Such a job can
	 * outlive this process (see `release`); the log then has no size limit.
	 */
	readonly outputToFile?: boolean;
	/** Resolves the shell for one command. Injected, because shell discovery reads the machine. */
	readonly plan: (command: string) => SpawnPlan;
	readonly env?: () => NodeJS.ProcessEnv;
	readonly onEvent?: (event: JobEvent) => void;
	/** For tests of the stop sequence. */
	readonly kill?: (step: KillStep) => void;
}

export class JobError extends Error {}

export interface ReadResult {
	readonly job: JobInfo;
	readonly text: string;
	/** Pass this as `since` to get only what comes after. */
	readonly next: number;
	/** Characters asked for that had already left the buffer. They are in the log. */
	readonly missed: number;
	/** Characters left out because of `maxChars`; the newest are kept. */
	readonly skipped: number;
}

export interface WaitResult {
	readonly reason: "match" | "exit" | "timeout" | "aborted";
	readonly line?: string;
}

const MAX_PATTERN = 300;
const MAX_LINE = 2000;
const EXIT_FLUSH_MS = 250;
const FORCE_WAIT_MS = 2000;
const TAIL_MS = 100;
const TAIL_CHUNK = 65_536;

/** A model's regex, or the same text as a plain substring when it does not compile. Case is ignored. */
export function compilePattern(source: string): { test: (line: string) => boolean; literal: boolean } {
	const trimmed = source.slice(0, MAX_PATTERN);
	try {
		const pattern = new RegExp(trimmed, "i");
		return { test: (line) => pattern.test(line.slice(0, MAX_LINE)), literal: false };
	} catch {
		const needle = trimmed.toLowerCase();
		return { test: (line) => line.slice(0, MAX_LINE).toLowerCase().includes(needle), literal: true };
	}
}

interface Job {
	id: string;
	name: string;
	command: string;
	cwd: string;
	child: ChildProcess;
	buffer: RingBuffer;
	log: WriteStream | undefined;
	/** Reads what the command wrote to its log file since the last call, with `outputToFile`. */
	tail: { offset: number; timer: NodeJS.Timeout | undefined; pull: () => void } | undefined;
	logPath: string;
	logBytes: number;
	startedAt: number;
	endedAt: number | undefined;
	exitCode: number | undefined;
	finished: boolean;
	lingering: boolean;
	stoppedBy: StoppedBy | undefined;
	readCursor: number;
	watch: { test: (line: string) => boolean; from: number; armed: boolean } | undefined;
	/** Called on new output and on the end of the job. */
	listeners: Set<() => void>;
	waiting: number;
}

export class JobManager {
	private readonly options: JobManagerOptions;
	private readonly platform: NodeJS.Platform;
	private readonly jobs = new Map<string, Job>();
	private sequence = 0;

	constructor(options: JobManagerOptions) {
		this.options = options;
		this.platform = options.platform ?? process.platform;
	}

	start(request: { command: string; cwd: string; name?: string; watch?: string }): JobInfo {
		const command = request.command.trim();
		if (!command) throw new JobError("The command is empty.");
		const running = [...this.jobs.values()].filter((job) => !job.finished);
		if (running.length >= this.options.maxJobs) {
			throw new JobError(
				`${running.length} background jobs are running, which is the limit. Stop one first: ${running.map((job) => job.id).join(", ")}.`,
			);
		}
		try {
			if (!statSync(request.cwd).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new JobError(`Working directory does not exist: ${request.cwd}`);
		}

		const plan = this.options.plan(command);
		const id = `bg-${++this.sequence}`;
		mkdirSync(this.options.logDir, { recursive: true });
		const logPath = join(this.options.logDir, `${id}.log`);
		// The command holds its own descriptor of the file; ours is closed once it has one.
		const out = this.options.outputToFile ? openSync(logPath, "a") : undefined;
		let child: ChildProcess;
		try {
			child = spawn(plan.file, [...plan.args], {
				cwd: request.cwd,
				detached: plan.detached,
				env: this.options.env?.() ?? process.env,
				stdio: [plan.stdin === undefined ? "ignore" : "pipe", out ?? "pipe", out ?? "pipe"],
				windowsHide: true,
			});
		} finally {
			if (out !== undefined) closeSync(out);
		}
		if (plan.stdin !== undefined) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(plan.stdin);
		}

		const job: Job = {
			id,
			name: request.name?.trim() || id,
			command,
			cwd: request.cwd,
			child,
			buffer: new RingBuffer(this.options.bufferChars),
			log: out === undefined ? createWriteStream(logPath) : undefined,
			tail: out === undefined ? undefined : { offset: 0, timer: undefined, pull: () => {} },
			logPath,
			logBytes: 0,
			startedAt: Date.now(),
			endedAt: undefined,
			exitCode: undefined,
			finished: false,
			lingering: false,
			stoppedBy: undefined,
			readCursor: 0,
			watch: request.watch ? { ...compilePattern(request.watch), from: 0, armed: true } : undefined,
			listeners: new Set(),
			waiting: 0,
		};
		job.log?.on("error", () => {
			job.log = undefined;
		});
		this.jobs.set(id, job);
		this.wire(job);
		this.prune();
		this.emit({ type: "start", job: this.info(job) });
		return this.info(job);
	}

	private wire(job: Job): void {
		const { child } = job;
		const decoder = new TextDecoder();
		const cleaner = new OutputCleaner();
		const append = (text: string) => {
			if (!text) return;
			job.buffer.append(text);
			this.checkWatch(job);
			for (const listener of [...job.listeners]) listener();
		};
		const onData = (data: Buffer) => {
			this.writeLog(job, data);
			append(cleaner.push(decoder.decode(data, { stream: true })));
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		const tail = job.tail;
		if (tail) {
			const chunk = Buffer.alloc(TAIL_CHUNK);
			tail.pull = () => {
				let fd: number;
				try {
					fd = openSync(job.logPath, "r");
				} catch {
					return;
				}
				try {
					for (;;) {
						const read = readSync(fd, chunk, 0, chunk.length, tail.offset);
						if (read <= 0) break;
						tail.offset += read;
						append(cleaner.push(decoder.decode(chunk.subarray(0, read), { stream: true })));
					}
				} finally {
					closeSync(fd);
				}
			};
			tail.timer = setInterval(() => {
				tail.pull();
				// Nothing closes when the last process of a lingering group ends: look.
				if (job.finished && job.lingering && child.pid !== undefined && !groupAlive(child.pid, this.platform)) {
					job.lingering = false;
					this.closeLog(job);
				}
			}, TAIL_MS);
			// Reading a job's output never keeps this process alive.
			tail.timer.unref();
		}

		let flushTimer: NodeJS.Timeout | undefined;
		let finishing = false;
		const finish = () => {
			if (finishing) return;
			finishing = true;
			if (flushTimer) clearTimeout(flushTimer);
			job.endedAt ??= Date.now();
			job.exitCode ??= 1;
			job.tail?.pull();
			append(cleaner.push(decoder.decode()) + cleaner.flush());
			job.lingering = child.pid !== undefined && groupAlive(child.pid, this.platform);
			let announced = false;
			const announce = () => {
				if (announced) return;
				announced = true;
				// Asked before the waiters are released: whoever waits on this job is told by its own call.
				const observed = job.waiting > 0;
				job.finished = true;
				for (const listener of [...job.listeners]) listener();
				this.emit({ type: "exit", job: this.info(job), observed });
			};
			// A lingering group still holds the pipes: its output keeps arriving, so the log stays open until they close.
			const log = job.lingering ? undefined : job.log;
			if (!log) return announce();
			// The job counts as ended once its log is on disk: whoever is told of the end may read the file next.
			job.log = undefined;
			log.end(announce);
			setTimeout(announce, 500).unref();
		};
		child.once("error", (error) => {
			append(`[mu: the command could not be started: ${error.message}]\n`);
			job.exitCode = 127;
			finish();
		});
		child.once("exit", (code, signal) => {
			job.endedAt = Date.now();
			job.exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1);
			// The last output can arrive after the exit; a child that inherited the pipes may never close them.
			flushTimer = setTimeout(finish, EXIT_FLUSH_MS);
		});
		child.once("close", () => {
			finish();
			// A file has no end to wait for: a lingering group may still write to it, and is read until it is stopped.
			if (!job.tail || !job.lingering) this.closeLog(job);
		});
	}

	private writeLog(job: Job, data: Buffer): void {
		if (!job.log) return;
		const limit = this.options.maxLogBytes ?? 50 * 1024 * 1024;
		if (job.logBytes + data.length > limit) {
			job.log.write(`\n[mu: the log stops here at ${limit} bytes; the job goes on]\n`);
			this.closeLog(job);
			return;
		}
		job.logBytes += data.length;
		job.log.write(data);
	}

	private closeLog(job: Job): void {
		job.log?.end();
		job.log = undefined;
		if (job.tail?.timer) {
			clearInterval(job.tail.timer);
			job.tail.timer = undefined;
			job.tail.pull();
		}
	}

	/** One notice per reading: a matching line disarms the watch until the output is read again. */
	private checkWatch(job: Job): void {
		const watch = job.watch;
		if (!watch?.armed) return;
		const { text, from } = job.buffer.read(watch.from);
		const lines = text.split("\n");
		let offset = from;
		// The last piece is a line still being written: it waits for its newline.
		for (let index = 0; index < lines.length - 1; index++) {
			offset += lines[index].length + 1;
			if (!watch.test(lines[index])) continue;
			watch.from = offset;
			watch.armed = false;
			this.emit({ type: "match", job: this.info(job), line: lines[index].slice(0, MAX_LINE) });
			return;
		}
		watch.from = offset;
	}

	read(id: string, request: { since?: number; maxChars: number }): ReadResult {
		const job = this.require(id);
		const { text, from, missed } = job.buffer.read(request.since ?? job.readCursor);
		const maxChars = Math.max(1, request.maxChars);
		const skipped = Math.max(0, text.length - maxChars);
		job.readCursor = Math.max(job.readCursor, from + text.length);
		if (job.watch) {
			job.watch.armed = true;
			job.watch.from = Math.max(job.watch.from, job.readCursor);
		}
		return {
			job: this.info(job),
			text: skipped > 0 ? text.slice(skipped) : text,
			next: from + text.length,
			missed,
			skipped,
		};
	}

	/**
	 * Resolves when a line after `since` matches, when the job ends, after the
	 * timeout, or on abort, whichever is first. Without a pattern it waits for the
	 * end of the job. A line still being written counts: prompts have no newline.
	 */
	wait(
		id: string,
		request: { pattern?: string; since?: number; timeoutMs: number; signal?: AbortSignal },
	): Promise<WaitResult> {
		const job = this.require(id);
		const pattern = request.pattern ? compilePattern(request.pattern) : undefined;
		let scanFrom = request.since ?? job.readCursor;
		const scan = (): string | undefined => {
			if (!pattern) return undefined;
			const { text, from } = job.buffer.read(scanFrom);
			const lines = text.split("\n");
			let offset = from;
			for (let index = 0; index < lines.length; index++) {
				if (pattern.test(lines[index])) return lines[index].slice(0, MAX_LINE);
				if (index < lines.length - 1) offset += lines[index].length + 1;
			}
			scanFrom = offset;
			return undefined;
		};

		return new Promise((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			const settle = (result: WaitResult) => {
				if (timer) clearTimeout(timer);
				job.listeners.delete(check);
				request.signal?.removeEventListener("abort", onAbort);
				job.waiting--;
				resolve(result);
			};
			const check = () => {
				const line = scan();
				if (line !== undefined) settle({ reason: "match", line });
				else if (job.finished) settle({ reason: "exit" });
			};
			const onAbort = () => settle({ reason: "aborted" });
			job.waiting++;
			if (request.signal?.aborted) return settle({ reason: "aborted" });
			const line = scan();
			if (line !== undefined) return settle({ reason: "match", line });
			if (job.finished) return settle({ reason: "exit" });
			job.listeners.add(check);
			request.signal?.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => settle({ reason: "timeout" }), Math.max(0, request.timeoutMs));
		});
	}

	/** Ends the job and everything it started: asks first, forces after the grace period. */
	async stop(id: string, by: StoppedBy): Promise<JobInfo> {
		const job = this.require(id);
		const pid = job.child.pid;
		if (pid === undefined || (job.finished && !job.lingering)) return this.info(job);
		job.stoppedBy ??= by;
		const kill = this.options.kill ?? runKillStep;
		const gone = () => job.finished && !groupAlive(pid, this.platform);
		kill(killPlan(pid, false, this.platform));
		if (!(await this.until(job, gone, this.options.killGraceMs))) {
			kill(killPlan(pid, true, this.platform));
			await this.until(job, gone, FORCE_WAIT_MS);
		}
		job.lingering = job.lingering && groupAlive(pid, this.platform);
		if (!job.lingering) this.closeLog(job);
		this.emit({ type: "stop", job: this.info(job) });
		return this.info(job);
	}

	/** Polls a condition that a job's end may change; resolves to whether it came true in time. */
	private until(job: Job, condition: () => boolean, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			if (condition()) return resolve(true);
			const startedAt = Date.now();
			const done = (result: boolean) => {
				clearInterval(poll);
				job.listeners.delete(check);
				resolve(result);
			};
			const check = () => {
				if (condition()) done(true);
				else if (Date.now() - startedAt >= timeoutMs) done(false);
			};
			// Listeners hear the shell end; a lingering group ends without an event, hence the poll.
			const poll = setInterval(check, 50);
			job.listeners.add(check);
		});
	}

	/** Stops every job. A session must not leave processes behind. Resolves to how many were stopped. */
	async shutdown(graceMs = Math.min(this.options.killGraceMs, 1500)): Promise<number> {
		const live = [...this.jobs.values()].filter((job) => !job.finished || job.lingering);
		const kill = this.options.kill ?? runKillStep;
		for (const job of live) {
			job.stoppedBy ??= "shutdown";
			if (job.child.pid !== undefined) kill(killPlan(job.child.pid, false, this.platform));
		}
		await Promise.all(
			live.map(async (job) => {
				const pid = job.child.pid;
				if (pid === undefined) return;
				const gone = () => job.finished && !groupAlive(pid, this.platform);
				if (!(await this.until(job, gone, graceMs))) {
					kill(killPlan(pid, true, this.platform));
					await this.until(job, gone, 500);
				}
				this.closeLog(job);
			}),
		);
		return live.length;
	}

	/**
	 * Leaves the jobs that are still running to go on after this process ends: stops reading them and lets the
	 * process exit without waiting for them. Only jobs that write to their log file (`outputToFile`) are released; the
	 * others would lose their output pipe, so they are stopped as on `shutdown`. Resolves to the jobs left running.
	 */
	async release(): Promise<JobInfo[]> {
		const live = [...this.jobs.values()].filter((job) => !job.finished || job.lingering);
		const kept = live.filter((job) => job.tail !== undefined && job.child.pid !== undefined);
		for (const job of kept) {
			this.closeLog(job);
			job.child.unref();
			this.jobs.delete(job.id);
		}
		if (kept.length < live.length) await this.shutdown();
		return kept.map((job) => this.info(job));
	}

	/** The last resort, for a process that exits without a session shutdown. Synchronous on POSIX. */
	killAllNow(): void {
		for (const job of this.jobs.values()) {
			const pid = job.child.pid;
			if (pid === undefined || (job.finished && !job.lingering)) continue;
			job.stoppedBy ??= "shutdown";
			(this.options.kill ?? runKillStep)(killPlan(pid, true, this.platform));
		}
	}

	list(): JobInfo[] {
		return [...this.jobs.values()].map((job) => this.info(job));
	}

	get(id: string): JobInfo | undefined {
		const job = this.jobs.get(id);
		return job ? this.info(job) : undefined;
	}

	runningCount(): number {
		return [...this.jobs.values()].filter((job) => !job.finished || job.lingering).length;
	}

	private require(id: string): Job {
		const job = this.jobs.get(id.trim());
		if (job) return job;
		const known = [...this.jobs.keys()].join(", ");
		throw new JobError(
			`No background job has the id "${id}". ${known ? `Known jobs: ${known}.` : "None was started."}`,
		);
	}

	private prune(): void {
		const keep = this.options.keepFinished ?? 20;
		const finished = [...this.jobs.values()].filter((job) => job.finished && !job.lingering);
		for (const job of finished.slice(0, Math.max(0, finished.length - keep))) this.jobs.delete(job.id);
	}

	private info(job: Job): JobInfo {
		return {
			id: job.id,
			name: job.name,
			command: job.command,
			cwd: job.cwd,
			pid: job.child.pid,
			state: job.finished ? "exited" : "running",
			exitCode: job.finished ? job.exitCode : undefined,
			stoppedBy: job.stoppedBy,
			lingering: job.lingering,
			startedAt: job.startedAt,
			durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
			logPath: job.logPath,
			total: job.buffer.end,
			unread: Math.max(0, job.buffer.end - job.readCursor),
		};
	}

	private emit(event: JobEvent): void {
		try {
			this.options.onEvent?.(event);
		} catch {
			/* An observer's problem is not the job's. */
		}
	}
}

/** Removes the log directories of sessions that ended more than `days` ago. Logs live under the user's home, so they must not pile up. */
export function pruneLogDirs(root: string, days: number, now = Date.now()): number {
	let removed = 0;
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return 0;
	}
	for (const name of names) {
		const path = join(root, name);
		try {
			const stats = statSync(path);
			if (!stats.isDirectory() || now - stats.mtimeMs < days * 86_400_000) continue;
			rmSync(path, { recursive: true, force: true });
			removed++;
		} catch {
			/* Someone else's, or gone: leave it. */
		}
	}
	return removed;
}
