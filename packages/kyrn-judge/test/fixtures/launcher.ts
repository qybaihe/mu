import { spawn, spawnSync } from "node:child_process";
import { lstatSync, rmSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** kyrn/bin of this checkout: the launcher and its scripts. */
export const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../../../kyrn/bin");

const windows = process.platform === "win32";
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";

/** What the launcher needs of the system: cmd, tasklist and PowerShell on Windows, sh and the usual tools elsewhere. */
export const SYSTEM_PATH = windows
	? [join(systemRoot, "System32"), join(systemRoot, "System32", "WindowsPowerShell", "v1.0")]
	: ["/usr/bin", "/bin"];

/** A bare search path: `first`, then the folder of this Node, then the system's own. */
export function searchPath(...first: string[]): string {
	return [...first, dirname(process.execPath), ...SYSTEM_PATH].join(delimiter);
}

/** The launcher as a person runs it: the bash script elsewhere, mu.cmd on Windows. */
export const MU = join(BIN, windows ? "mu.cmd" : "mu");

/** Windows PowerShell 5.1, which every Windows has. */
export const WINDOWS_POWERSHELL = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/**
 * Runs a script of kyrn/bin, or a link or shim to one, the way a shell does: a bash script directly, a `.cmd` through
 * cmd.exe, which is the only way a batch file starts. `args` are plain words. Nothing of the developer's own setup leaks
 * in: no real home, no MU_* or KYRN_* variables. `HOME` is the home on every platform (USERPROFILE on Windows), and
 * Windows also gets the few variables its programs expect to find.
 */
export function runScript(script: string, args: readonly string[], env: Record<string, string>, timeout = 60_000) {
	const options = { encoding: "utf8" as const, input: "", env: scriptEnv(env), timeout, windowsHide: true };
	const result = windows
		? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${script}" ${args.join(" ")}"`], {
				...options,
				windowsVerbatimArguments: true,
			})
		: spawnSync(script, args, options);
	return { code: result.status, out: result.stdout, err: result.stderr };
}

/**
 * runScript without blocking this process, so that a server of the test's own can answer the script meanwhile.
 * `input` is what the script reads on stdin.
 */
export function runScriptAsync(
	script: string,
	args: readonly string[],
	env: Record<string, string>,
	{ input = "", timeout = 60_000 }: { readonly input?: string; readonly timeout?: number } = {},
): Promise<{ code: number | null; out: string; err: string }> {
	const options = { env: scriptEnv(env), timeout, windowsHide: true };
	const child = windows
		? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${script}" ${args.join(" ")}"`], {
				...options,
				windowsVerbatimArguments: true,
			})
		: spawn(script, args, options);
	let out = "";
	let err = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		out += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		err += chunk;
	});
	child.stdin.end(input);
	return new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, out, err }));
	});
}

/**
 * Runs mu.ps1 as a person does at a PowerShell prompt, `& mu.ps1 'one argument' 'another'`: each argument is a string
 * of its own, which reaches the script whole. They travel in variables of their own, so neither Node's quoting nor
 * PowerShell's reading of a command line (`-File` takes `-name:value` apart) comes in between. `shell` is Windows
 * PowerShell 5.1 (powershell.exe, on every Windows) or PowerShell 7 (pwsh.exe). The execution policy is set aside for
 * this run: what is tested is the script.
 *
 * `legacy` asks for the argument passing of PowerShell 7 before 7.3, which a person can still choose
 * ($PSNativeCommandArgumentPassing).
 */
export function runPowerShell(
	shell: string,
	args: readonly string[],
	env: Record<string, string>,
	{ legacy = false, timeout = 60_000 } = {},
) {
	const named = Object.fromEntries(args.map((arg, index) => [`MU_TEST_ARG${index}`, arg]));
	const words = args.map((_arg, index) => `$env:MU_TEST_ARG${index}`).join(" ");
	const passing = legacy ? "$PSNativeCommandArgumentPassing = 'Legacy'; " : "";
	const command = `${passing}& $env:MU_TEST_SCRIPT ${words}; exit $LASTEXITCODE`;
	const flags = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command];
	const result = spawnSync(shell, flags, {
		encoding: "utf8",
		input: "",
		env: scriptEnv({ ...env, ...named, MU_TEST_SCRIPT: join(BIN, "mu.ps1") }),
		timeout,
		windowsHide: true,
	});
	return { code: result.status, out: result.stdout, err: result.stderr };
}

/** A run's variables: `env` on a bare PATH, and on Windows the few variables its programs expect to find. */
function scriptEnv(env: Record<string, string>): Record<string, string | undefined> {
	const base: Record<string, string | undefined> = windows
		? {
				PATH: searchPath(),
				PATHEXT: process.env.PATHEXT,
				ComSpec: process.env.ComSpec,
				SystemDrive: process.env.SystemDrive,
				SystemRoot: systemRoot,
				windir: process.env.windir,
				TEMP: process.env.TEMP,
				TMP: process.env.TMP,
			}
		: { PATH: searchPath() };
	return { ...base, ...env, ...(windows && env.HOME ? { USERPROFILE: env.HOME } : {}) };
}

/**
 * Removes a folder a test gave the launcher as its home. The app view in it leads into this repository (through
 * junctions on Windows): its links go first, one by one, so that removing the rest can never reach the sources.
 */
export function removeHome(home: string): void {
	for (const app of [join(home, ".mu", "app"), join(home, ".kyrn", "app")]) {
		for (const name of ["src", "docs", "examples", "README.md", "CHANGELOG.md"]) {
			try {
				if (lstatSync(join(app, name)).isSymbolicLink()) unlinkSync(join(app, name));
			} catch {
				// Not there, or not a link.
			}
		}
	}
	// A process the launcher started may take a moment to let go of the folder on Windows.
	rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
