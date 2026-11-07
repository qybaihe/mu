import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { totalmem } from "node:os";
import { join } from "node:path";
import { MUDE_MODEL } from "./manifest.ts";
import type { MudePaths } from "./paths.ts";

/**
 * mude's server: the package's own `d3_server_mac.py` (the System One API, POST /v1/systemone), run from mu's venv on
 * 127.0.0.1 with a key, as one process for every mu session on this machine. It is started on
 * demand and keeps running until `mu judge mude stop` (or disable, or uninstall): about 3.5-4 GB of memory while it runs.
 */

export const DEFAULT_PORT = 8790;

/** The address mu's `typesafe` judge posts to. */
export function mudeBaseUrl(port: number): string {
	return `http://127.0.0.1:${port}/v1/systemone`;
}

export interface Health {
	readonly status: string;
	readonly model?: string;
}

/** GET /health: open without the key; it answers only once the model is loaded and warmed up. */
export async function health(
	port: number,
	timeoutMs = 2000,
	fetcher: typeof fetch = fetch,
): Promise<Health | undefined> {
	try {
		const response = await fetcher(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) return undefined;
		const body = (await response.json()) as Record<string, unknown>;
		return { status: String(body.status ?? ""), model: typeof body.model === "string" ? body.model : undefined };
	} catch {
		return undefined;
	}
}

/** Whether nothing listens on 127.0.0.1:port. */
export function portFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => probe.close(() => resolve(true)));
	});
}

/** `preferred` when it is free, else one the system hands out. */
export async function choosePort(preferred = DEFAULT_PORT): Promise<number> {
	if (await portFree(preferred)) return preferred;
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen({ port: 0, host: "127.0.0.1" }, () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

export function readPid(paths: MudePaths): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(paths.pid, "utf8").trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** Whether `pid` is a running mude server of this install (not a process that took over the number since). */
export function serverAlive(paths: MudePaths, pid: number | undefined = readPid(paths)): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
		return command.includes("d3_server_mac.py") && command.includes(paths.model);
	} catch {
		return false;
	}
}

/** The MLX buffer cache: 1 GB on a Mac with 16 GB or more, 0.25 GB below (peak use about 4.3 GB against 3.5 GB). */
export function cacheGb(memoryBytes = totalmem()): string {
	return memoryBytes >= 16 * 1024 ** 3 ? "1" : "0.25";
}

function tail(file: string, lines = 12): string {
	try {
		const text = readFileSync(file, "utf8");
		return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
	} catch {
		return "";
	}
}

export interface StartOptions {
	readonly port: number;
	readonly key: string;
	/** The model name the server answers to and the judge asks for. Default mude's. */
	readonly name?: string;
	/** How long to wait for /health. The first start loads 1.8 GB and compiles kernels; default 180 s. */
	readonly timeoutMs?: number;
	/** Start it and return without waiting for it to be ready. */
	readonly wait?: boolean;
	/**
	 * Ends the wait (Ctrl-C, the app cancelling an install). A server this call started goes too: until mude is the
	 * judge nothing asks it, and it would hold about 4 GB of memory for nothing. One that was running before stays.
	 */
	readonly signal?: AbortSignal;
	readonly sleep?: (ms: number) => Promise<void>;
}

export class StartStopped extends Error {
	/** Whether the server went too: one this call started does, one that was running before does not. */
	readonly serverStopped: boolean;

	constructor(serverStopped = false) {
		super("Stopped while the mude 1.0 server was starting");
		this.name = "StartStopped";
		this.serverStopped = serverStopped;
	}
}

export interface Started {
	readonly pid: number;
	readonly port: number;
	readonly already: boolean;
}

export async function startServer(paths: MudePaths, options: StartOptions): Promise<Started> {
	const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	const timeoutMs = options.timeoutMs ?? 180_000;
	const running = readPid(paths);
	if (running && serverAlive(paths, running)) {
		// Already started, by another mu or the desktop app: ready, or still loading.
		if (options.wait !== false) await untilReady(paths, running, options.port, timeoutMs, sleep, options.signal);
		return { pid: running, port: options.port, already: true };
	}
	if (!(await portFree(options.port))) {
		throw new Error(
			`Port ${options.port} on 127.0.0.1 is taken by another program; mu judge mude enable picks a free one`,
		);
	}
	mkdirSync(paths.root, { recursive: true });
	// The previous run's log goes, so that an error below is this run's.
	rmSync(paths.log, { force: true });
	const log = openSync(paths.log, "a", 0o600);
	const child = spawn(
		paths.python,
		[
			join(paths.model, "d3_server_mac.py"),
			"--model",
			paths.model,
			"--host",
			"127.0.0.1",
			"--port",
			String(options.port),
			"--name",
			options.name ?? MUDE_MODEL,
			"--verify",
			"fast",
		],
		{
			cwd: paths.model,
			detached: true,
			stdio: ["ignore", log, log],
			env: {
				PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
				HOME: process.env.HOME,
				LANG: process.env.LANG ?? "en_US.UTF-8",
				DECISION_API_KEY: options.key,
				D3_MLX_CACHE_GB: cacheGb(),
				// Everything it needs is in the package: nothing is fetched from the Hub at run time.
				HF_HUB_OFFLINE: "1",
				TRANSFORMERS_OFFLINE: "1",
				PYTHONUNBUFFERED: "1",
			},
		},
	);
	closeSync(log);
	const pid = child.pid;
	if (!pid) throw new Error("mude's server could not be started");
	child.unref();
	writeFileSync(paths.pid, `${pid}\n`, { mode: 0o600 });
	if (options.wait !== false) {
		try {
			await untilReady(paths, pid, options.port, timeoutMs, sleep, options.signal);
		} catch (error) {
			if (!(error instanceof StartStopped)) throw error;
			await stopServer(paths);
			throw new StartStopped(true);
		}
	}
	return { pid, port: options.port, already: false };
}

async function untilReady(
	paths: MudePaths,
	pid: number,
	port: number,
	timeoutMs: number,
	sleep: (ms: number) => Promise<unknown>,
	signal?: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new StartStopped();
		if ((await health(port))?.status === "ready") return;
		if (!serverAlive(paths, pid)) {
			rmSync(paths.pid, { force: true });
			throw new Error(`mude's server stopped while starting. Its log (${paths.log}) ends with:\n${tail(paths.log)}`);
		}
		await sleep(500);
	}
	throw new Error(`mude's server did not answer within ${Math.round(timeoutMs / 1000)} s; see ${paths.log}`);
}

/** Stops the server this install started. Whether one was running. */
export async function stopServer(
	paths: MudePaths,
	sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
	const pid = readPid(paths);
	if (!pid || !serverAlive(paths, pid)) {
		rmSync(paths.pid, { force: true });
		return false;
	}
	process.kill(pid, "SIGTERM");
	for (let waited = 0; waited < 5000 && serverAlive(paths, pid); waited += 200) await sleep(200);
	if (serverAlive(paths, pid)) process.kill(pid, "SIGKILL");
	rmSync(paths.pid, { force: true });
	return true;
}

/** Bytes the server process holds in memory, when it runs. */
export function serverMemory(pid: number | undefined): number | undefined {
	if (!pid) return undefined;
	try {
		const kb = Number.parseInt(
			execFileSync("/bin/ps", ["-p", String(pid), "-o", "rss="], { encoding: "utf8" }).trim(),
			10,
		);
		return Number.isFinite(kb) ? kb * 1024 : undefined;
	} catch {
		return undefined;
	}
}

/** The log's size, to say where to look without reading all of it. */
export function logExists(paths: MudePaths): boolean {
	return existsSync(paths.log) && statSync(paths.log).size > 0;
}
