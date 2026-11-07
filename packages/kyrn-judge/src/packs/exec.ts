import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { codedError } from "../language.ts";
import { killPlan, runKillStep } from "../process-tree.ts";

/**
 * Running the external programs the packs lean on (git, ast-grep) without a
 * shell. Nothing here throws: a program that is not installed is a result
 * (`missing`), because every caller turns it into an install hint.
 */
export interface RunOptions {
	readonly cwd?: string;
	/** Written to the program's standard input. */
	readonly input?: string | Buffer;
	/** Added to the environment of this process. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	/**
	 * `latin1` maps every byte to one character and back, so output in any
	 * encoding survives a round trip. Patches are read this way.
	 */
	readonly encoding?: "utf8" | "latin1";
	/**
	 * Called for every complete line of standard output instead of collecting it.
	 * Returning false stops the program: enough has been read.
	 */
	readonly onLine?: (line: string) => boolean | undefined;
	readonly platform?: NodeJS.Platform;
}

export interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	/** The program could not be started because it does not exist. */
	readonly missing: boolean;
	/** Stopped by the timeout, the abort signal, or an `onLine` that had read enough. */
	readonly stopped: boolean;
}

export type Runner = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

const STDERR_LIMIT = 64 * 1024;
/** How long a stopped program has to end before it is ended outright. */
const KILL_GRACE_MS = 2000;
/** How long after the program exits its output may stay open (held by something it started) before mu stops waiting. */
const PIPE_GRACE_MS = 500;

export const run: Runner = (command, args, options = {}) =>
	new Promise((resolve) => {
		const platform = options.platform ?? process.platform;
		const env = { ...process.env, ...options.env };
		const invocation = invocationFor(command, args, { platform, env });
		if (!invocation) {
			resolve({ code: 127, stdout: "", stderr: "", missing: true, stopped: false });
			return;
		}
		const encoding = options.encoding ?? "utf8";
		const chunks: Buffer[] = [];
		let carry = "";
		let stderr = "";
		let stopped = false;
		let settled = false;

		// Its own process group outside Windows, so that stopping it also stops what it started (git's hooks).
		const host = process.platform;
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			env,
			shell: false,
			detached: host !== "win32",
			windowsHide: true,
			windowsVerbatimArguments: invocation.verbatim,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let exited = false;
		let force: NodeJS.Timeout | undefined;
		let late: NodeJS.Timeout | undefined;

		const stop = () => {
			if (stopped) return;
			stopped = true;
			const pid = child.pid;
			if (pid === undefined) {
				child.kill();
				return;
			}
			runKillStep(killPlan(pid, false, host));
			force = setTimeout(() => {
				if (!exited) runKillStep(killPlan(pid, true, host));
			}, KILL_GRACE_MS);
		};
		const timer = options.timeoutMs ? setTimeout(stop, options.timeoutMs) : undefined;
		options.signal?.addEventListener("abort", stop, { once: true });
		if (options.signal?.aborted) stop();

		const finish = (code: number, missing: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (force && exited) clearTimeout(force);
			if (late) clearTimeout(late);
			options.signal?.removeEventListener("abort", stop);
			if (options.onLine && carry && !stopped) options.onLine(carry);
			resolve({ code, stdout: Buffer.concat(chunks).toString(encoding), stderr, missing, stopped });
		};

		if (options.onLine) {
			// The stream decoder keeps a character that straddles two chunks whole.
			child.stdout?.setEncoding(encoding);
			child.stdout?.on("data", (text: string) => {
				if (stopped) return;
				const lines = (carry + text).split("\n");
				carry = lines.pop() ?? "";
				for (const line of lines) {
					if (options.onLine?.(line) === false) {
						stop();
						return;
					}
				}
			});
		} else {
			child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		}
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8");
		});
		child.on("error", (error: NodeJS.ErrnoException) => finish(127, error.code === "ENOENT"));
		child.on("close", (code) => finish(code ?? 1, false));
		child.on("exit", (code) => {
			exited = true;
			// Something it started in the background may hold its output open: that is not the program any more.
			late = setTimeout(() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
				finish(code ?? 1, false);
			}, PIPE_GRACE_MS);
		});
		if (options.input !== undefined) {
			// A program that exits without reading its input is reported by its exit code, not by EPIPE.
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.input);
		}
	});

interface Invocation {
	command: string;
	args: string[];
	verbatim: boolean;
}

interface Lookup {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly isFile?: (path: string) => boolean;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Where a program is on PATH. On Windows the extensions of PATHEXT are tried in
 * order; elsewhere the name is taken as it is. A name with a directory in it is
 * checked, not searched for.
 */
export function findOnPath(name: string, lookup: Lookup): string | undefined {
	const exists = lookup.isFile ?? isFile;
	const windows = lookup.platform === "win32";
	const path = windows ? win32 : posix;
	const get = (key: string) =>
		windows
			? Object.entries(lookup.env).find(([candidate]) => candidate.toUpperCase() === key)?.[1]
			: lookup.env[key];
	const extensions = windows
		? path.extname(name)
			? [""]
			: (get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
		: [""];
	const named = name.includes("/") || (windows && name.includes("\\"));
	const directories = named ? [""] : (get("PATH") ?? "").split(path.delimiter).filter(Boolean);
	for (const directory of directories) {
		for (const extension of extensions) {
			const candidate = directory ? path.join(directory, name + extension) : name + extension;
			if (exists(candidate)) return candidate;
		}
	}
	return undefined;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument, quoted so that it survives cmd.exe and then the program's own
 * argument parsing (the algorithm of https://qntm.org/cmd). A `.cmd` shim hands
 * its arguments to cmd.exe a second time, hence `twice`.
 */
export function quoteForCmd(argument: string, twice: boolean): string {
	const quoted = `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	const escaped = quoted.replace(CMD_META, "^$1");
	return twice ? escaped.replace(CMD_META, "^$1") : escaped;
}

/**
 * How to start a program without a shell. Node refuses to spawn `.cmd` and
 * `.bat` files directly (they need cmd.exe), and that is how npm installs its
 * command line tools on Windows. Undefined means the program is not installed.
 */
export function invocationFor(command: string, args: readonly string[], lookup: Lookup): Invocation | undefined {
	if (lookup.platform !== "win32") return { command, args: [...args], verbatim: false };
	const found = findOnPath(command, lookup);
	if (!found) return undefined;
	if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args: [...args], verbatim: false };
	const line = [found.replace(CMD_META, "^$1"), ...args.map((argument) => quoteForCmd(argument, true))].join(" ");
	const shell = Object.entries(lookup.env).find(([key]) => key.toUpperCase() === "COMSPEC")?.[1] ?? "cmd.exe";
	return { command: shell, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

export type Binary = "ast-grep" | "git" | "gh";

/** The error a pack throws when its program is missing: the install hint, coded `missing_program`. */
export function missingProgram(binary: Binary, platform: NodeJS.Platform): Error {
	return codedError(installHint(binary, platform), { code: "missing_program", params: { program: binary } });
}

/**
 * What to tell someone whose machine lacks a program a pack needs. mu installs
 * nothing itself. The commands are the ones each project documents.
 */
export function installHint(binary: Binary, platform: NodeJS.Platform): string {
	if (binary === "ast-grep") {
		const ways =
			platform === "darwin"
				? ["brew install ast-grep", "npm install --global @ast-grep/cli", "cargo install ast-grep --locked"]
				: platform === "win32"
					? [
							"scoop install main/ast-grep",
							"npm install --global @ast-grep/cli",
							"cargo install ast-grep --locked",
						]
					: [
							"npm install --global @ast-grep/cli",
							"cargo install ast-grep --locked",
							"brew install ast-grep",
							"pip install ast-grep-cli",
						];
		return `ast-grep is not installed. Install it with: ${ways[0]} (or: ${ways.slice(1).join(", ")}).`;
	}
	if (binary === "gh") {
		const ways =
			platform === "darwin"
				? ["brew install gh"]
				: platform === "win32"
					? ["winget install --id GitHub.cli --source winget", "scoop install gh"]
					: ["see https://github.com/cli/cli/blob/trunk/docs/install_linux.md", "brew install gh"];
		return `gh (the GitHub CLI) is not installed. Install it with: ${ways[0]}${ways.length > 1 ? ` (or: ${ways.slice(1).join(", ")})` : ""}, then run gh auth login.`;
	}
	const ways =
		platform === "darwin"
			? ["brew install git", "xcode-select --install"]
			: platform === "win32"
				? ["winget install --id Git.Git -e --source winget", "scoop install git"]
				: ["sudo apt install git", "sudo dnf install git"];
	return `git is not installed. Install it with: ${ways[0]} (or: ${ways.slice(1).join(", ")}).`;
}
