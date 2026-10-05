import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BIN, MU, removeHome, runPowerShell, runScript, searchPath, WINDOWS_POWERSHELL } from "./fixtures/launcher.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
/** Starting pi needs the repository's dependencies; a bare git worktree has none. */
const installed = existsSync(join(root, "node_modules/.bin/tsx"));
const windows = process.platform === "win32";

const homes: string[] = [];
function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "mu-launcher-"));
	homes.push(dir);
	return dir;
}
afterEach(() => {
	while (homes.length > 0) removeHome(homes.pop() as string);
});

/** `mu` as this platform runs it (mu.cmd on Windows), or another script of kyrn/bin; what it wrote, in one. */
function run(command: string, args: string[], env: Record<string, string>, timeout?: number) {
	const result = runScript(command === "mu" ? MU : join(BIN, command), args, env, timeout);
	return { code: result.code, out: `${result.out}${result.err}` };
}

describe("the mu launcher", () => {
	it("answers to the old command name too", () => {
		const dir = home();
		expect(run("mu", ["help"], { HOME: dir }).out).toContain("mu link | unlink");
		// The old names are bash scripts, which Windows never had.
		if (windows) return;
		expect(run("kyrn", ["help"], { HOME: dir }).out).toContain("mu link | unlink");
		expect(run("kyrn-dev", ["help"], { HOME: dir }).out).toContain("mu link | unlink");
	});

	it("links itself as `mu`, and leaves another program of that name alone", () => {
		const dir = home();
		const links = join(dir, "bin");
		// A link on POSIX; on Windows, where a link to a script cannot be run, a small mu.cmd.
		const linked = join(links, windows ? "mu.cmd" : "mu");
		const other = join(dir, "other");
		mkdirSync(other);
		if (windows) writeFileSync(join(other, "mu.bat"), "@echo maildir-utils\r\n");
		else {
			writeFileSync(join(other, "mu"), "#!/bin/sh\necho maildir-utils\n");
			chmodSync(join(other, "mu"), 0o755);
		}

		const shadowing = run("mu", ["link"], { HOME: dir, MU_LINK_DIR: links, PATH: searchPath(other) });
		expect(shadowing.code).toBe(1);
		expect(shadowing.out).toContain("Another mu is already on your PATH");
		expect(existsSync(linked)).toBe(false);

		expect(run("mu", ["link"], { HOME: dir, MU_LINK_DIR: links }).code).toBe(0);
		if (windows) expect(readFileSync(linked, "utf8")).toContain("mu-link-shim");
		else expect(readlinkSync(linked)).toBe(join(BIN, "mu"));
		// Linking again over its own link is fine; a file that is not a link to it is not replaced.
		expect(run("mu", ["link"], { HOME: dir, MU_LINK_DIR: links, PATH: searchPath(links) }).code).toBe(0);
		rmSync(linked);
		writeFileSync(linked, "someone else's file");
		expect(run("mu", ["link"], { HOME: dir, MU_LINK_DIR: links }).code).toBe(1);
		expect(readFileSync(linked, "utf8")).toBe("someone else's file");
	});

	// mu.ps1 is there so that a prompt reaches mu exactly, which cmd cannot promise. `mu import` repeats an option it
	// does not know word for word, so what it says is what node was given.
	it.runIf(windows)(
		"hands every argument to mu exactly from PowerShell: quotes, &, %, spaces and backslashes",
		() => {
			const dir = home();
			const pwsh = (process.env.PATH ?? "")
				.split(delimiter)
				.map((folder) => join(folder, "pwsh.exe"))
				.find((file) => existsSync(file));
			const runs = [
				{ shell: WINDOWS_POWERSHELL, legacy: false },
				...(pwsh
					? [
							{ shell: pwsh, legacy: false },
							{ shell: pwsh, legacy: true },
						]
					: []),
			];
			for (const { shell, legacy } of runs) {
				for (const option of ['--say "hi" & 100% done', "--dir=C:\\my dir\\", '--quote=a\\"b']) {
					const result = runPowerShell(shell, ["import", option], { HOME: dir }, { legacy });
					const output = `${result.out}${result.err}`;
					const said = output.split(/\r?\n/).find((line) => line.includes("unknown option "));
					const where = `${shell}${legacy ? " (legacy arguments)" : ""}\n${output}`;
					expect(said?.slice(said.indexOf("unknown option ") + "unknown option ".length), where).toBe(option);
					expect(result.code, where).toBe(2);
				}
			}
		},
		180_000,
	);

	// These start pi, through tsx: on GitHub's Windows runners that takes over ten seconds.
	it.skipIf(!installed)(
		"rebuilds an app view that still carries the old name, keeping pi's package name",
		() => {
			const dir = home();
			const app = join(dir, ".mu/app");
			mkdirSync(app, { recursive: true });
			const stale = { name: "@earendil-works/pi-coding-agent", piConfig: { name: "kyrn", configDir: ".kyrn" } };
			writeFileSync(join(app, "package.json"), JSON.stringify(stale));
			// Newer than upstream's package.json, so the age check alone would keep it.
			utimesSync(join(app, "package.json"), new Date("2030-01-01"), new Date("2030-01-01"));

			const version = run("mu", ["--version"], { HOME: dir });

			expect(version.code).toBe(0);
			const rebuilt = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
			expect(rebuilt.piConfig).toEqual({ name: "mu", configDir: ".mu" });
			expect(rebuilt.name).toBe("@earendil-works/pi-coding-agent");
			expect(existsSync(join(dir, ".mu/agent"))).toBe(true);
		},
		60_000,
	);

	it.skipIf(!installed)(
		"stays in ~/.kyrn on a machine whose home has not been moved, without creating ~/.mu",
		() => {
			const dir = home();
			mkdirSync(join(dir, ".kyrn/agent"), { recursive: true });

			expect(run("mu", ["--version"], { HOME: dir }).code).toBe(0);

			expect(existsSync(join(dir, ".mu"))).toBe(false);
			expect(JSON.parse(readFileSync(join(dir, ".kyrn/app/package.json"), "utf8")).piConfig.name).toBe("mu");
		},
		60_000,
	);

	it.skipIf(!installed)(
		"runs pi's own commands instead of prompting pi with them",
		() => {
			const dir = home();

			const list = run("mu", ["list"], { HOME: dir });
			expect(list.code).toBe(0);
			expect(list.out).toContain("No packages installed.");

			// A package command missing its source says so; it does not hand the word to the model as a prompt.
			const install = run("mu", ["install"], { HOME: dir });
			expect(install.code).not.toBe(0);
			expect(install.out).toContain("Missing install source.");
		},
		60_000,
	);
});

describe("mu migrate", () => {
	/** A home from before the rename. The login file is a stand-in: only its bytes and its mode matter here. */
	function oldHome(): string {
		const dir = home();
		mkdirSync(join(dir, ".kyrn/agent"), { recursive: true });
		mkdirSync(join(dir, ".kyrn/acp-sessions"));
		mkdirSync(join(dir, ".kyrn/local-judge"));
		writeFileSync(join(dir, ".kyrn/agent/kyrn.json"), JSON.stringify({ tiers: ["old"] }));
		writeFileSync(join(dir, ".kyrn/agent/auth.json"), "stand-in-login", { mode: 0o600 });
		writeFileSync(
			join(dir, ".kyrn/acp-sessions/a.json"),
			JSON.stringify({ file: join(dir, ".kyrn/agent/sessions/x") }),
		);
		return dir;
	}
	/**
	 * What runs, as the launcher sees it: the machine running the tests may well have a real session open. `running` is
	 * part of the pgrep pattern that finds something. Windows has no pgrep: there the one process that runs is listed in
	 * two files, which a module preloaded into the launcher hands it in place of tasklist's and PowerShell's answers.
	 */
	function processes(dir: string, running: string): Record<string, string> {
		const stubs = join(dir, "stubs");
		mkdirSync(stubs);
		if (!windows) {
			const script = `#!/bin/sh\ncase "$*" in *"${running}"*) echo 4242; exit 0;; esac\nexit 1\n`;
			writeFileSync(join(stubs, "pgrep"), script, { mode: 0o755 });
			return { HOME: dir, PATH: searchPath(stubs) };
		}
		const session = join(root, "packages", "kyrn-judge", "src", "extension", "kyrn-judge.ts");
		const listed: Record<string, [name: string, command: string]> = {
			"kyrn-judge.ts": ["node.exe", `node.exe ${session}`],
			"browser-profile": ["chrome.exe", `chrome.exe --user-data-dir=${join(dir, ".kyrn", "browser-profile")}`],
			aioncore: ["aioncore.exe", "aioncore.exe"],
		};
		const [name, command] = listed[running] ?? ["node.exe", "node.exe server.js"];
		writeFileSync(join(stubs, "tasklist.csv"), `"${name}","4242","Console","1","10,240 K"\r\n`);
		writeFileSync(
			join(stubs, "processes.csv"),
			`"ProcessId","Name","CommandLine"\r\n"4242","${name}","${command}"\r\n`,
		);
		const preload = pathToFileURL(
			join(dirname(fileURLToPath(import.meta.url)), "fixtures", "windows-process-list.mjs"),
		);
		return { HOME: dir, NODE_OPTIONS: `--import=${preload.href}`, MU_TEST_PROCESS_LIST: stubs };
	}
	const isLink = (path: string) => lstatSync(path).isSymbolicLink();

	it("moves the home in one step, leaves the login file as it was, and links the old path to the new", () => {
		const dir = oldHome();
		// A judge that is no longer running left its pid behind: that must not hold anything up.
		writeFileSync(join(dir, ".kyrn/local-judge/judge.pid"), "99999999");

		const moved = run("mu", ["migrate"], processes(dir, "nothing-is-running"));

		expect(moved.code).toBe(0);
		expect(isLink(join(dir, ".mu"))).toBe(false);
		expect(isLink(join(dir, ".kyrn"))).toBe(true);
		// A junction on Windows, whose target comes back with a trailing backslash.
		const target = readlinkSync(join(dir, ".kyrn"));
		expect(windows ? resolve(target) : target).toBe(join(dir, ".mu"));
		expect(JSON.parse(readFileSync(join(dir, ".mu/agent/mu.json"), "utf8"))).toEqual({ tiers: ["old"] });
		expect(existsSync(join(dir, ".mu/agent/kyrn.json"))).toBe(false);
		expect(readFileSync(join(dir, ".mu/agent/auth.json"), "utf8")).toBe("stand-in-login");
		// Windows has no mode bits to keep.
		if (!windows) expect(statSync(join(dir, ".mu/agent/auth.json")).mode & 0o777).toBe(0o600);
		expect(moved.out).not.toContain("stand-in-login");
		// The desktop's session mappings store absolute paths into the old home.
		expect(existsSync(join(dir, ".kyrn/acp-sessions/a.json"))).toBe(true);

		const again = run("mu", ["migrate"], processes(join(dir, ".mu"), "nothing-is-running"));
		expect(again.code).toBe(0);
		expect(again.out).toContain("Nothing to move");
		expect(run("mu", ["migrate"], { HOME: dir }).out).toContain("Already moved");
	});

	it("only says what it would do with --dry-run", () => {
		const dir = oldHome();

		const dry = run("mu", ["migrate", "--dry-run"], processes(dir, "nothing-is-running"));

		expect(dry.code).toBe(0);
		expect(dry.out).toContain("Nothing was changed");
		expect(isLink(join(dir, ".kyrn"))).toBe(false);
		expect(existsSync(join(dir, ".mu"))).toBe(false);
		expect(existsSync(join(dir, ".kyrn/agent/kyrn.json"))).toBe(true);
	});

	it("never merges into or overwrites a ~/.mu that is already there", () => {
		const dir = oldHome();
		mkdirSync(join(dir, ".mu/agent"), { recursive: true });
		writeFileSync(join(dir, ".mu/agent/mu.json"), JSON.stringify({ tiers: ["new"] }));

		const refused = run("mu", ["migrate"], processes(dir, "nothing-is-running"));

		expect(refused.code).toBe(1);
		expect(refused.out).toContain("already exists");
		expect(isLink(join(dir, ".kyrn"))).toBe(false);
		expect(JSON.parse(readFileSync(join(dir, ".kyrn/agent/kyrn.json"), "utf8"))).toEqual({ tiers: ["old"] });
		expect(JSON.parse(readFileSync(join(dir, ".mu/agent/mu.json"), "utf8"))).toEqual({ tiers: ["new"] });
	});

	it.each([
		["the local judge", "mu judge stop", "nothing-is-running", true],
		["a session", "mu sessions", "kyrn-judge.ts", false],
		["the browser", "mu browser", "browser-profile", false],
		["the desktop app", "desktop app", "aioncore", false],
	])("moves nothing while %s is still running", (_what, names, running, judge) => {
		const dir = oldHome();
		// This test's own process stands in for a judge that is alive.
		if (judge) writeFileSync(join(dir, ".kyrn/local-judge/judge.pid"), String(process.pid));

		const refused = run("mu", ["migrate"], processes(dir, running));

		expect(refused.code).toBe(1);
		expect(refused.out).toContain("Nothing was moved");
		expect(refused.out).toContain(names);
		expect(isLink(join(dir, ".kyrn"))).toBe(false);
		expect(existsSync(join(dir, ".mu"))).toBe(false);
	});

	it("sees a session that really runs, in the machine's own list of processes", async () => {
		const dir = oldHome();
		// A process with a session's command line: the judgment layer's extension among its arguments.
		const session = spawn(
			process.execPath,
			[
				"-e",
				"setInterval(() => {}, 1000)",
				join(root, "packages", "kyrn-judge", "src", "extension", "kyrn-judge.ts"),
			],
			{ stdio: "ignore" },
		);
		try {
			await new Promise((started) => session.once("spawn", started));

			// About 30 s on GitHub's Windows runners: with the home moved, the PowerShell call behind it finds no module
			// cache and reads the runner's hundreds of modules again. (0.3 s with the runner's own home.)
			const refused = run("mu", ["migrate", "--dry-run"], { HOME: dir }, 110_000);

			expect(refused.code).toBe(1);
			expect(refused.out).toContain("mu sessions");
			expect(refused.out).toContain(String(session.pid));
		} finally {
			session.kill();
		}
	}, 120_000);
});
