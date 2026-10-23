import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { MudePaths } from "./paths.ts";

/**
 * The Python environment mude's server runs in: a uv venv with Python 3.13 (the version the model was tested with)
 * and the packages of the lock that ships with mu (kyrn/local-judge/mude-requirements.lock.txt, every wheel pinned by
 * sha256: `uv pip install --require-hashes`).
 * It holds MLX, transformers and their dependencies, no torch. uv comes from the machine when it has one, else mu
 * downloads one pinned release of it.
 */

export const PYTHON_VERSION = "3.13";

/** The uv release mu downloads when the machine has none: Apple silicon build, checked by its sha256. */
export const UV_RELEASE = {
	version: "0.13.1",
	url: "https://github.com/astral-sh/uv/releases/download/0.13.1/uv-aarch64-apple-darwin.tar.gz",
	sha256: "cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2",
} as const;

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** A uv on PATH or where its installers put it, else the one mu downloaded before. */
export function findUv(paths: MudePaths, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
	const dirs = [
		...(env.PATH ?? "").split(delimiter),
		join(home, ".local", "bin"),
		join(home, ".cargo", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		paths.tools,
	];
	for (const dir of dirs) {
		if (dir && executable(join(dir, "uv"))) return join(dir, "uv");
	}
	return undefined;
}

export interface RunResult {
	readonly code: number | null;
	readonly output: string;
}

/** Runs a program, handing each line of its output to `onLine`, and keeps the last lines for an error message. */
export function run(
	command: string,
	args: readonly string[],
	options: { env?: NodeJS.ProcessEnv; onLine?: (line: string) => void } = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
		const lines: string[] = [];
		let pending = "";
		const take = (chunk: Buffer) => {
			pending += chunk.toString("utf8");
			const parts = pending.split(/\r?\n/);
			pending = parts.pop() ?? "";
			for (const line of parts) {
				if (!line.trim()) continue;
				lines.push(line);
				if (lines.length > 40) lines.shift();
				options.onLine?.(line);
			}
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		child.once("error", (error) => resolve({ code: null, output: error.message }));
		child.once("close", (code) => {
			if (pending.trim()) lines.push(pending);
			resolve({ code, output: lines.slice(-12).join("\n") });
		});
	});
}

/** Downloads the pinned uv into mu's own folder for it. */
export async function downloadUv(
	paths: MudePaths,
	options: { fetch?: typeof fetch; onLine?: (line: string) => void } = {},
): Promise<string> {
	mkdirSync(paths.tools, { recursive: true });
	const archive = "uv.tar.gz";
	options.onLine?.(`Downloading uv ${UV_RELEASE.version}`);
	const response = await (options.fetch ?? fetch)(UV_RELEASE.url, { redirect: "follow" });
	if (!response.ok) throw new Error(`uv could not be downloaded: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== UV_RELEASE.sha256)
		throw new Error("The downloaded uv does not match its pinned sha256; nothing was installed");
	writeFileSync(join(paths.tools, archive), bytes);
	const unpacked = await run("/usr/bin/tar", [
		"-xzf",
		join(paths.tools, archive),
		"-C",
		paths.tools,
		"--strip-components",
		"1",
	]);
	rmSync(join(paths.tools, archive), { force: true });
	if (unpacked.code !== 0 || !executable(join(paths.tools, "uv")))
		throw new Error(`uv could not be unpacked: ${unpacked.output}`);
	return join(paths.tools, "uv");
}

export function lockDigest(lockFile: string): string {
	return createHash("sha256").update(readFileSync(lockFile)).digest("hex");
}

/** Whether the environment is there and was installed from this lock. */
export function venvReady(paths: MudePaths, lockFile: string): boolean {
	if (!existsSync(paths.python)) return false;
	try {
		return readFileSync(paths.venvLock, "utf8").trim() === lockDigest(lockFile);
	} catch {
		return false;
	}
}

/**
 * Makes the environment: a fresh venv, then the lock's packages, each checked against its hash. An environment from
 * another lock (an older mu) is replaced.
 */
export async function ensureVenv(
	paths: MudePaths,
	lockFile: string,
	uv: string,
	options: { onLine?: (line: string) => void; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
	if (venvReady(paths, lockFile)) return;
	rmSync(paths.venv, { recursive: true, force: true });
	const env = { ...(options.env ?? process.env), UV_NO_CONFIG: "1", VIRTUAL_ENV: undefined } as NodeJS.ProcessEnv;
	const made = await run(uv, ["venv", "--python", PYTHON_VERSION, "--no-project", "--quiet", paths.venv], {
		env,
		onLine: options.onLine,
	});
	if (made.code !== 0) throw new Error(`The Python environment could not be made (uv venv):\n${made.output}`);
	const installed = await run(
		uv,
		[
			"pip",
			"install",
			"--python",
			paths.python,
			"--require-hashes",
			"--no-deps",
			"--index-url",
			"https://pypi.org/simple",
			"-r",
			lockFile,
		],
		{ env, onLine: options.onLine },
	);
	if (installed.code !== 0)
		throw new Error(`mude's Python packages could not be installed (uv pip install):\n${installed.output}`);
	writeFileSync(paths.venvLock, `${lockDigest(lockFile)}\n`);
}
