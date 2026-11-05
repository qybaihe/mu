import { existsSync } from "node:fs";
import { join, win32 } from "node:path";
import { getAgentDir, getPowerShellConfig, getShellConfig, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * A background command runs in the shell the foreground tools use: pi's own
 * resolution (`/bin/bash`, Git Bash on Windows, the legacy WSL launcher that
 * takes its command on stdin, the user's `shellPath`), not Node's `shell: true`,
 * which would be `cmd.exe` on Windows and `/bin/sh` elsewhere.
 *
 * Everything that differs per platform takes the platform as a parameter, so
 * the Windows paths are tested on a Mac.
 */
export interface ShellLike {
	readonly shell: string;
	readonly args: readonly string[];
	readonly commandTransport?: "argv" | "stdin";
}

export type ShellKind = "bash" | "powershell";

/** pi's PowerShell tool starts every command with this, so that non-ASCII output arrives as UTF-8. */
const POWERSHELL_UTF8 = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/** PowerShell only where it is the user's one shell tool (`defaultTools` without `bash`, on Windows). */
export function shellKind(activeTools: readonly string[], platform: NodeJS.Platform): ShellKind {
	return platform === "win32" && activeTools.includes("powershell") && !activeTools.includes("bash")
		? "powershell"
		: "bash";
}

export function resolveShell(kind: ShellKind, shellPath?: string): ShellLike {
	return kind === "powershell" ? getPowerShellConfig() : getShellConfig(shellPath);
}

export interface ShellSettings {
	readonly shellPath?: string;
	readonly commandPrefix?: string;
}

/**
 * `shellPath` and `shellCommandPrefix` as the foreground bash tool gets them. The project's
 * settings only count in a trusted project: a repository must not pick the binary that runs.
 */
export function readShellSettings(
	cwd: string,
	agentDir: string = getAgentDir(),
	projectTrusted = false,
): ShellSettings {
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
	return { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() };
}

export interface SpawnPlan {
	readonly file: string;
	readonly args: readonly string[];
	/** Set when the shell reads its command from stdin. */
	readonly stdin?: string;
	/** A process group of its own, which is what makes killing the whole tree possible on POSIX. */
	readonly detached: boolean;
	/**
	 * Windows with Git Bash: the job's bash writes its MSYS pid, which is its process group, to `file`, and `ps` lists
	 * the group's processes with their Windows pids (process-tree.ts, msysGroup).
	 */
	readonly group?: { readonly ps: string; readonly file: string };
}

/**
 * `groupFile`: where a job's bash on Windows writes its process group (see SpawnPlan.group). Only for Git Bash's or
 * another MSYS bash, which has a `ps.exe` beside it or in ../usr/bin; not for PowerShell or the WSL launcher.
 */
export function planSpawn(
	command: string,
	shell: ShellLike,
	options: {
		kind?: ShellKind;
		prefix?: string;
		platform: NodeJS.Platform;
		groupFile?: string;
		exists?: (path: string) => boolean;
	},
): SpawnPlan {
	const prefixed = options.prefix ? `${options.prefix}\n${command}` : command;
	const ps =
		options.groupFile &&
		options.platform === "win32" &&
		options.kind !== "powershell" &&
		shell.commandTransport !== "stdin"
			? msysPs(shell.shell, options.exists ?? existsSync)
			: undefined;
	const group = ps && options.groupFile ? { ps, file: options.groupFile } : undefined;
	const written = group
		? `printf '%s' "$$" > ${bashQuote(group.file.replaceAll("\\", "/"))} 2>/dev/null\n${prefixed}`
		: prefixed;
	const script = options.kind === "powershell" ? `${POWERSHELL_UTF8}${written}` : written;
	const detached = options.platform !== "win32";
	const plan =
		shell.commandTransport === "stdin"
			? { file: shell.shell, args: [...shell.args], stdin: script, detached }
			: { file: shell.shell, args: [...shell.args, script], detached };
	return group ? { ...plan, group } : plan;
}

/** MSYS's ps.exe for a bash.exe: beside it (usr\bin\bash.exe), or in ..\usr\bin (Git's bin\bash.exe launcher). */
function msysPs(bash: string, exists: (path: string) => boolean): string | undefined {
	const dir = win32.dirname(bash);
	return [win32.join(dir, "ps.exe"), win32.join(dir, "..", "usr", "bin", "ps.exe")].find(exists);
}

const bashQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** The foreground tools' environment: the agent's own bin directory comes first on PATH. */
export function shellEnv(env: NodeJS.ProcessEnv, binDir: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const separator = platform === "win32" ? ";" : ":";
	const entries = (env[pathKey] ?? "").split(separator).filter(Boolean);
	return entries.includes(binDir) ? { ...env } : { ...env, [pathKey]: [binDir, ...entries].join(separator) };
}

// Moved to a module without pi imports, so the packs' runner can end a process tree too.
export { groupAlive, type KillStep, killAllPlan, killPlan, msysGroup, runKillStep } from "../process-tree.ts";

export function agentBinDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "bin");
}
