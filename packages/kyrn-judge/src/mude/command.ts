import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { homedir, release, totalmem } from "node:os";
import { join } from "node:path";
import { type ConfigFiles, disableMude, enableMude, judgeSetting, mudeInTiers, readState } from "./config.ts";
import { DownloadError, downloadedBytes, downloadFiles, huggingFaceToken, missingFiles } from "./download.ts";
import { MUDE_BYTES, MUDE_FILES, MUDE_REPO, MUDE_REVISION, mudeFileUrl } from "./manifest.ts";
import { type MudePaths, mudePaths } from "./paths.ts";
import { downloadUv, ensureVenv, findUv, venvReady } from "./python.ts";
import {
	choosePort,
	DEFAULT_PORT,
	health,
	portFree,
	readPid,
	serverAlive,
	serverMemory,
	startServer,
	stopServer,
} from "./server.ts";

/**
 * `mu judge mude`: installs mude 1.0, mu's decision model optimized for coding, on this Mac and makes it mu's judge. One command
 * downloads the model (1.8 GB, every file checked against its pinned sha256), makes its Python environment, starts its
 * server on 127.0.0.1 and puts it first in mu.json. The desktop app runs the same commands with --json.
 */

const USAGE = `mu judge mude: mude 1.0, mu's own decision model optimized for coding, as the judge on this Mac
(Apple silicon, macOS 14 or later)

  mu judge mude install [--local-only]   download it (${(MUDE_BYTES / 1e9).toFixed(1)} GB), set it up, start it and make it the judge;
                                         after a stop (Ctrl-C, a lost connection, a power cut), it goes on from there
  mu judge mude enable [--local-only | --with-fallback]
                                         make it the judge again, or change what happens when it can't answer
  mu judge mude disable                  back to the judges from before, and stop its server
  mu judge mude start | stop             start or stop its server (about 4 GB of memory while it runs)
  mu judge mude status                   what is installed, running and enabled
  mu judge mude uninstall                disable it and delete the model and its Python environment

What mude 1.0 cannot answer, because its server is not running or it is unsure, goes to the judges that were there
before it (Jev by default): those are hosted, so what they read leaves this machine. With --local-only, it is the
only judge, and such a decision takes its fallback instead. Add --json for one JSON object per line.
`;

interface Out {
	step(step: string, message: string): void;
	progress(event: { file: string; done: number; total: number; checking: boolean }): void;
	line(text: string): void;
	status(status: MudeStatus): void;
	error(message: string, kind?: string): void;
}

function jsonOut(write: (text: string) => void): Out {
	const emit = (value: Record<string, unknown>) => write(`${JSON.stringify(value)}\n`);
	let last = 0;
	return {
		step: (step, message) => emit({ type: "step", step, message }),
		progress: (event) => {
			const now = Date.now();
			if (now - last < 250 && event.done < event.total && !event.checking) return;
			last = now;
			emit({ type: "progress", ...event });
		},
		line: (text) => emit({ type: "log", line: text }),
		status: (status) => emit({ type: "status", ...status }),
		error: (message, kind) => emit({ type: "error", message, kind }),
	};
}

function humanOut(write: (text: string) => void, tty: boolean): Out {
	let shown = -1;
	return {
		step: (_step, message) => {
			if (shown >= 0 && tty) write("\n");
			shown = -1;
			write(`${message}\n`);
		},
		progress: ({ done, total, checking }) => {
			const percent = total > 0 ? Math.floor((done / total) * 100) : 100;
			if (tty) {
				write(
					`\r  ${percent}%  ${(done / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB${checking ? "  (checking)" : ""}   `,
				);
				shown = percent;
			} else if (percent >= shown + 10 || percent === 100) {
				shown = percent - (percent % 10);
				write(`  ${percent}%\n`);
			}
		},
		line: (text) => write(`  ${text}\n`),
		status: (status) => write(describe(status)),
		error: (message) => {
			// Below the progress line, not on it.
			if (shown >= 0 && tty) write("\n");
			shown = -1;
			write(`${message}\n`);
		},
	};
}

export interface MudeStatus {
	readonly supported: boolean;
	readonly problems: readonly string[];
	readonly installed: boolean;
	/** Bytes of the model on disk, partly downloaded files included: above 0 while not installed, an install stopped part way. */
	readonly downloadedBytes: number;
	readonly pythonReady: boolean;
	readonly running: boolean;
	readonly ready: boolean;
	readonly port: number;
	readonly pid?: number;
	readonly memoryBytes?: number;
	readonly enabled: boolean;
	readonly localOnly: boolean;
	readonly fallback: readonly string[];
	readonly model: string;
	readonly folder: string;
	readonly log: string;
}

function describe(status: MudeStatus): string {
	const lines: string[] = [];
	if (!status.supported) {
		lines.push(`mude 1.0 can't run here: ${status.problems.join("; ")}`);
		return `${lines.join("\n")}\n`;
	}
	lines.push(
		`model     ${
			status.installed
				? `installed (${MUDE_REPO} @ ${MUDE_REVISION.slice(0, 7)})`
				: status.downloadedBytes > 0
					? `partly downloaded (${(status.downloadedBytes / 1e9).toFixed(1)} of ${(MUDE_BYTES / 1e9).toFixed(1)} GB): mu judge mude install goes on from there`
					: "not installed: mu judge mude install"
		}`,
	);
	if (status.installed && !status.pythonReady) lines.push("python    not set up: mu judge mude install");
	lines.push(
		`server    ${status.ready ? `running on 127.0.0.1:${status.port}${status.memoryBytes ? ` · ${(status.memoryBytes / 1e9).toFixed(1)} GB of memory` : ""}` : status.running ? `starting on 127.0.0.1:${status.port}` : "stopped"}`,
	);
	if (status.enabled) {
		lines.push(
			status.localOnly
				? "judge     mude 1.0 only: a decision it cannot answer takes its fallback, and nothing goes to a hosted judge"
				: `judge     mude 1.0, then ${status.fallback.join(" > ")} for what it cannot answer (what those read leaves this machine)`,
		);
	} else {
		lines.push(`judge     ${status.installed ? "not enabled: mu judge mude enable" : "not enabled"}`);
	}
	lines.push(`folder    ${status.folder}`);
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------

export interface Context {
	readonly paths: MudePaths;
	readonly files: ConfigFiles;
	readonly lockFile: string;
	readonly env: NodeJS.ProcessEnv;
	/** Stops a download (Ctrl-C, or the app ending the install): what it got so far stays for the next install. */
	readonly signal?: AbortSignal;
}

/** What keeps mude from running on this machine, if anything. */
export function problems(
	options: { platform?: string; arm64?: boolean; darwinMajor?: number; memoryBytes?: number } = {},
): string[] {
	const platform = options.platform ?? process.platform;
	if (platform !== "darwin") return ["it needs a Mac with Apple silicon (an M1 or newer)"];
	const out: string[] = [];
	const arm64 = options.arm64 ?? appleSilicon();
	if (!arm64) out.push("it needs Apple silicon (an M1 or newer); this Mac has an Intel processor");
	// Darwin 23 is macOS 14.
	const darwinMajor = options.darwinMajor ?? Number.parseInt(release().split(".")[0] ?? "0", 10);
	if (darwinMajor < 23) out.push("it needs macOS 14 or later");
	const memory = options.memoryBytes ?? totalmem();
	if (memory < 8 * 1024 ** 3)
		out.push(
			`it needs 8 GB of memory or more (it uses about 4 GB); this Mac has ${Math.round(memory / 1024 ** 3)} GB`,
		);
	return out;
}

function appleSilicon(): boolean {
	if (process.arch === "arm64") return true;
	// A Node running under Rosetta reports x64 on an Apple silicon Mac.
	try {
		return execFileSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).trim() === "1";
	} catch {
		return false;
	}
}

function freeBytes(path: string): number | undefined {
	let dir = path;
	while (!existsSync(dir)) {
		const parent = join(dir, "..");
		if (parent === dir) return undefined;
		dir = parent;
	}
	try {
		const stats = statfsSync(dir);
		return stats.bavail * stats.bsize;
	} catch {
		return undefined;
	}
}

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

/**
 * Whether an install makes mude the only judge: as its flags say, else as the install it goes on from was asked (one
 * that stopped part way left install.json), else not.
 */
export function installLocalOnly(ctx: Context, args: readonly string[]): boolean {
	if (args.includes("--local-only")) return true;
	if (args.includes("--with-fallback")) return false;
	try {
		const value: unknown = JSON.parse(readFileSync(ctx.paths.install, "utf8"));
		return typeof value === "object" && value !== null && "localOnly" in value && value.localOnly === true;
	} catch {
		return false;
	}
}

function installed(ctx: Context): boolean {
	return missingFiles(ctx.paths.model, MUDE_FILES).length === 0;
}

function key(ctx: Context): string {
	try {
		const existing = readFileSync(ctx.paths.key, "utf8").trim();
		if (existing) return existing;
	} catch {
		// A first install.
	}
	mkdirSync(ctx.paths.root, { recursive: true });
	const made = randomBytes(32).toString("hex");
	writeFileSync(ctx.paths.key, `${made}\n`, { mode: 0o600 });
	return made;
}

/** The port to start on: the one from before when it is free or already ours, else 8790, else any free one. */
async function port(ctx: Context): Promise<number> {
	const previous = readState(ctx.paths)?.port;
	if (previous && (serverAlive(ctx.paths) || (await portFree(previous)))) return previous;
	return choosePort(DEFAULT_PORT);
}

export async function status(ctx: Context): Promise<MudeStatus> {
	const found = problems();
	const state = readState(ctx.paths);
	const at = state?.port ?? DEFAULT_PORT;
	const pid = readPid(ctx.paths);
	const running = serverAlive(ctx.paths, pid);
	const ready = running && (await health(at))?.status === "ready";
	const setting = judgeSetting(ctx.files);
	return {
		supported: found.length === 0,
		problems: found,
		installed: installed(ctx),
		downloadedBytes: downloadedBytes(ctx.paths.model, MUDE_FILES),
		pythonReady: venvReady(ctx.paths, ctx.lockFile),
		running,
		ready,
		port: at,
		pid: running ? pid : undefined,
		memoryBytes: running ? serverMemory(pid) : undefined,
		enabled: setting.enabled,
		localOnly: setting.localOnly,
		fallback: setting.fallback,
		model: `${MUDE_REPO}@${MUDE_REVISION}`,
		folder: ctx.paths.root,
		log: ctx.paths.log,
	};
}

async function ensureInstalled(ctx: Context, out: Out): Promise<void> {
	const missing = missingFiles(ctx.paths.model, MUDE_FILES);
	if (missing.length > 0) {
		const need = missing.reduce((sum, file) => sum + file.size, 0);
		const already = downloadedBytes(ctx.paths.model, MUDE_FILES);
		const free = freeBytes(ctx.paths.root);
		// The bytes still to come (what a stopped install left is on the disk already), the Python environment (about
		// 1 GB) and room to spare.
		const room = MUDE_BYTES - already + 2e9;
		if (free !== undefined && free < room) {
			throw new Error(
				`Not enough free disk space: mude 1.0 needs about ${gb(room)} GB, and ${gb(free)} GB are free`,
			);
		}
		out.step(
			"download",
			already > 0
				? `Going on with the mude 1.0 download (${MUDE_REPO}): ${gb(already)} of ${gb(MUDE_BYTES)} GB are here already`
				: `Downloading mude 1.0 (${MUDE_REPO}, ${gb(need)} GB) and checking every file`,
		);
		try {
			await downloadFiles({
				dir: ctx.paths.model,
				files: MUDE_FILES,
				url: (path) => mudeFileUrl(path, ctx.env.HF_ENDPOINT || undefined),
				token: huggingFaceToken(ctx.env),
				onProgress: (event) => out.progress(event),
				signal: ctx.signal,
			});
		} catch (error) {
			if (error instanceof DownloadError && error.kind === "aborted") {
				throw new DownloadError(
					`Stopped with ${gb(downloadedBytes(ctx.paths.model, MUDE_FILES))} of ${gb(MUDE_BYTES)} GB downloaded: mu judge mude install goes on from there`,
					"aborted",
				);
			}
			throw error;
		}
	}
	if (!venvReady(ctx.paths, ctx.lockFile)) {
		out.step("python", "Setting up the Python environment for mude 1.0 (MLX, transformers; about 1 GB, once)");
		try {
			let uv = findUv(ctx.paths, ctx.env);
			if (!uv) uv = await downloadUv(ctx.paths, { onLine: (line) => out.line(line) });
			await ensureVenv(ctx.paths, ctx.lockFile, uv, { onLine: (line) => out.line(line), env: ctx.env });
		} catch (error) {
			// Ctrl-C reaches uv too, which then fails: that is a stop, not a broken environment.
			if (ctx.signal?.aborted) {
				throw new DownloadError(
					"Stopped while setting up the Python environment: mu judge mude install goes on from there",
					"aborted",
				);
			}
			throw error;
		}
	}
}

function requireInstalled(ctx: Context): void {
	if (!installed(ctx) || !venvReady(ctx.paths, ctx.lockFile)) {
		throw new Error("mude 1.0 is not installed here yet: mu judge mude install");
	}
}

async function start(ctx: Context, out: Out, wait = true): Promise<number> {
	const at = await port(ctx);
	out.step(
		"start",
		serverAlive(ctx.paths)
			? `The mude 1.0 server is running on 127.0.0.1:${at}`
			: `Starting the mude 1.0 server on 127.0.0.1:${at} (loading the model takes a few seconds)`,
	);
	await startServer(ctx.paths, { port: at, key: key(ctx), wait });
	return at;
}

function enable(ctx: Context, out: Out, at: number, localOnly: boolean): void {
	const tiers = enableMude(ctx.paths, ctx.files, { port: at, key: key(ctx), localOnly });
	out.step(
		"enable",
		localOnly
			? "mude 1.0 is the judge, on its own. New mu sessions use it; one that is open now picks it up when it starts again."
			: `mude 1.0 is the judge, with ${tiers.slice(1).join(" > ")} behind it for what it cannot answer. New mu sessions use it.`,
	);
}

export async function main(
	argv: readonly string[],
	ctx: Context,
	write: (text: string) => void,
	tty = false,
): Promise<number> {
	const json = argv.includes("--json");
	const args = argv.filter((arg) => arg !== "--json");
	const out = json ? jsonOut(write) : humanOut(write, tty);
	const command = args[0] ?? "status";
	const flag = (name: string) => args.includes(name);
	try {
		if (command === "help" || command === "--help" || command === "-h") {
			write(USAGE);
			return 0;
		}
		const unknown = args
			.slice(1)
			.find((arg) => !["--local-only", "--with-fallback", "--no-wait", "--yes"].includes(arg));
		if (unknown) {
			out.error(`Unknown option for mu judge mude ${command}: ${unknown} (mu judge mude help)`, "usage");
			return 2;
		}
		if (command === "status") {
			out.status(await status(ctx));
			return 0;
		}
		const found = problems();
		if (found.length > 0 && command !== "stop" && command !== "disable" && command !== "uninstall") {
			out.error(`mude 1.0 can't run on this machine: ${found.join("; ")}.`, "unsupported");
			return 1;
		}
		switch (command) {
			case "install": {
				// An install that goes on from one that stopped keeps what that one was asked for, unless told otherwise:
				// local only stays local only.
				const localOnly = installLocalOnly(ctx, args);
				mkdirSync(ctx.paths.root, { recursive: true });
				writeFileSync(ctx.paths.install, `${JSON.stringify({ localOnly })}\n`);
				await ensureInstalled(ctx, out);
				const at = await start(ctx, out);
				enable(ctx, out, at, localOnly);
				rmSync(ctx.paths.install, { force: true });
				break;
			}
			case "enable": {
				requireInstalled(ctx);
				const current = judgeSetting(ctx.files);
				const localOnly = flag("--local-only")
					? true
					: flag("--with-fallback")
						? false
						: current.enabled && current.localOnly;
				const at = await start(ctx, out);
				enable(ctx, out, at, localOnly);
				break;
			}
			case "disable": {
				if (!mudeInTiers(ctx.files)) {
					const stopped = await stopServer(ctx.paths);
					out.step("disable", `mude 1.0 was not the judge${stopped ? "; its server is stopped" : ""}.`);
					break;
				}
				const tiers = disableMude(ctx.paths, ctx.files);
				const stopped = await stopServer(ctx.paths);
				out.step(
					"disable",
					`mude 1.0 is no longer the judge: ${tiers.join(" > ")} again${stopped ? ", and its server is stopped" : ""}.`,
				);
				break;
			}
			case "start": {
				requireInstalled(ctx);
				await start(ctx, out, !flag("--no-wait"));
				break;
			}
			case "stop": {
				const stopped = await stopServer(ctx.paths);
				out.step("stop", stopped ? "The mude 1.0 server is stopped." : "The mude 1.0 server was not running.");
				break;
			}
			case "uninstall": {
				if (mudeInTiers(ctx.files) || readState(ctx.paths)?.wroteEntry) {
					const tiers = disableMude(ctx.paths, ctx.files, { removeEntry: true });
					out.step("disable", `mude 1.0 is no longer the judge: ${tiers.join(" > ")} again.`);
				}
				await stopServer(ctx.paths);
				rmSync(ctx.paths.root, { recursive: true, force: true });
				out.step("uninstall", `Deleted ${ctx.paths.root}: the model, its Python environment and its key.`);
				break;
			}
			default:
				out.error(`Unknown command: mu judge mude ${command}\n\n${USAGE}`, "usage");
				return 2;
		}
		out.status(await status(ctx));
		return 0;
	} catch (error) {
		const kind = error instanceof DownloadError ? error.kind : undefined;
		out.error(error instanceof Error ? error.message : String(error), kind);
		return 1;
	}
}

/** The files and folders the launcher hands over (planMude in kyrn/bin/mu.mjs), else mu's usual places. */
export function contextFromEnv(env: NodeJS.ProcessEnv = process.env, home = homedir()): Context {
	const muHome = env.MU_MUDE_HOME || join(home, ".mu");
	const agentDir = env.MU_AGENT_DIR || join(muHome, "agent");
	return {
		paths: mudePaths(muHome),
		files: { agentDir, home: muHome, envFile: env.MU_MUDE_ENV_FILE || join(muHome, ".env") },
		lockFile:
			env.MU_MUDE_LOCK ||
			join(import.meta.dirname, "..", "..", "..", "..", "kyrn", "local-judge", "mude-requirements.lock.txt"),
		env,
	};
}
