import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	appViewPlan,
	busyFromProcesses,
	detectWsl,
	ensureAppView,
	envFileAdditions,
	envFilePath,
	findBusy,
	findOnPath,
	type LaunchPlan,
	launchStrategy,
	layoutOf,
	linkPath,
	migrate,
	muHome,
	nodeVersionOk,
	packageEntries,
	parseCsv,
	parseEnvFile,
	parseTasklist,
	parseWindowsProcesses,
	planAuth,
	planHost,
	planImport,
	planJudge,
	planLaunch,
	planLink,
	planUnlink,
	platformName,
	prepareLaunch,
	prepareLaunchAsync,
	resolveTsx,
	shimContent,
	sourceRuntime,
	usage,
} from "../../../kyrn/bin/mu.mjs";
import { isWsl } from "../src/platform.ts";
import { MU, removeHome, runScript, SYSTEM_PATH } from "./fixtures/launcher.ts";

/**
 * There is no Windows machine and no WSL where this is developed. What the launcher would do there is proven
 * here by calling its decisions with win32 and linux parameters and an in-memory file system. The tests that build
 * the app view and run the launcher for real also run on GitHub's Windows runners (.github/workflows/windows-tests.yml),
 * where they go through mu.cmd in cmd.exe and make junctions on NTFS. What neither proves (a real console, WSL) is
 * listed in kyrn/docs/features/windows-and-wsl.md.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "mu-platforms-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	// Some are homes the launcher really ran in, with an app view that leads into this repository.
	while (dirs.length > 0) removeHome(dirs.pop() as string);
});

/** A file system that is a list of paths: files carry text, folders are named with a trailing separator. */
function disk(files: Record<string, string>, folders: string[] = []) {
	return {
		exists: (path: string) => path in files || folders.includes(path),
		isDir: (path: string) => folders.includes(path),
		readFile: (path: string) => {
			if (!(path in files)) throw new Error(`ENOENT ${path}`);
			return files[path];
		},
	};
}

const WIN_ROOT = "C:\\Users\\bai\\code\\KYRN";
const WIN_HOME = "C:\\Users\\bai";
const WIN_TSX = `${WIN_ROOT}\\node_modules\\tsx`;
const winInstalled = {
	[`${WIN_TSX}\\package.json`]: JSON.stringify({ bin: "./dist/cli.mjs" }),
	[`${WIN_TSX}\\dist\\cli.mjs`]: "",
	[`${WIN_ROOT}\\packages\\coding-agent\\src\\experimental\\source-resolver.ts`]: "",
};
const POSIX_ROOT = "/home/bai/KYRN";
const posixInstalled = {
	[`${POSIX_ROOT}/node_modules/tsx/package.json`]: JSON.stringify({ bin: { tsx: "./dist/cli.mjs" } }),
	[`${POSIX_ROOT}/node_modules/tsx/dist/cli.mjs`]: "",
	[`${POSIX_ROOT}/packages/coding-agent/src/experimental/source-resolver.ts`]: "",
};
/** How Node runs a checkout's TypeScript itself: pi's source resolver and Node's compile cache (sourceRuntime). */
const POSIX_NATIVE = [
	"--disable-warning=ExperimentalWarning",
	"--import",
	`file://${POSIX_ROOT}/kyrn/bin/compile-cache.mjs`,
	"--import",
	`file://${POSIX_ROOT}/packages/coding-agent/src/experimental/source-resolver.ts`,
];
const POSIX_TSX = [`${POSIX_ROOT}/node_modules/tsx/dist/cli.mjs`, "--tsconfig", `${POSIX_ROOT}/tsconfig.json`];

function launch(overrides: Partial<Parameters<typeof planLaunch>[0]>): LaunchPlan {
	const plan = planLaunch({
		platform: "linux",
		env: {},
		argv: [],
		root: POSIX_ROOT,
		home: "/home/bai",
		execPath: "/usr/bin/node",
		canExec: true,
		fs: disk(posixInstalled),
		...overrides,
	});
	if (plan.error !== undefined) throw new Error(plan.error);
	return plan;
}

describe("the launcher's decisions, per platform", () => {
	it("accepts pi's minimum Node and nothing older", () => {
		expect(["22.19.0", "v22.19.0", "24.16.0", "23.0.0"].map(nodeVersionOk)).toEqual([true, true, true, true]);
		expect(["22.18.9", "20.20.1", "v18.0.0", "", "none"].map(nodeVersionOk)).toEqual([
			false,
			false,
			false,
			false,
			false,
		]);
	});

	it("keeps the old home until it has been moved, with Windows paths on Windows", () => {
		const at = (folders: string[]) =>
			muHome({ home: WIN_HOME, platform: "win32", isDir: (path) => folders.includes(path) });
		expect(at([])).toBe("C:\\Users\\bai\\.mu");
		expect(at(["C:\\Users\\bai\\.kyrn"])).toBe("C:\\Users\\bai\\.kyrn");
		expect(at(["C:\\Users\\bai\\.kyrn", "C:\\Users\\bai\\.mu"])).toBe("C:\\Users\\bai\\.mu");
		expect(muHome({ home: "/home/bai", platform: "linux", isDir: (path) => path === "/home/bai/.kyrn" })).toBe(
			"/home/bai/.kyrn",
		);
	});

	it("recognises WSL by its variable or its kernel, and only on Linux", () => {
		const kernel = "Linux version 5.15.167.4-microsoft-standard-WSL2 (root@f9c826d3017f)";
		expect(detectWsl({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } })).toBe(true);
		expect(detectWsl({ platform: "linux", env: {}, procVersion: kernel })).toBe(true);
		expect(
			detectWsl({ platform: "linux", env: {}, procVersion: "Linux version 6.8.0-45-generic (buildd@lcy02)" }),
		).toBe(false);
		expect(detectWsl({ platform: "darwin", env: { WSL_DISTRO_NAME: "Ubuntu" }, procVersion: kernel })).toBe(false);
		expect(detectWsl({ platform: "win32", env: { WSL_DISTRO_NAME: "Ubuntu" } })).toBe(false);
		expect(
			[
				platformName({ platform: "darwin" }),
				platformName({ platform: "linux" }),
				platformName({ platform: "linux", wsl: true }),
				platformName({ platform: "win32" }),
			].join(),
		).toBe("macOS,Linux,WSL,Windows");
		// The harness has its own copy of the rule (src/platform.ts): both must say the same.
		for (const env of [{ WSL_DISTRO_NAME: "Ubuntu" }, {}]) {
			for (const procVersion of [kernel, "Linux version 6.8.0-45-generic", undefined]) {
				for (const platform of ["linux", "darwin", "win32"] as const) {
					expect(isWsl({ platform, env, procVersion })).toBe(detectWsl({ platform, env, procVersion }));
				}
			}
		}
	});

	it("names the folder `mu link` uses on each platform", () => {
		expect(usage("win32")).toContain("%USERPROFILE%\\.local\\bin");
		expect(usage("darwin")).toContain("(~/.local/bin)");
		expect(usage("linux")).toContain("mu link | unlink");
	});
});

describe("the app view", () => {
	it("is links on POSIX, and junctions plus copies on Windows, where a link needs a privilege", () => {
		expect(appViewPlan("darwin").map((entry) => entry.kind)).toEqual([
			"symlink",
			"symlink",
			"symlink",
			"symlink",
			"symlink",
		]);
		expect(appViewPlan("linux")).toEqual(appViewPlan("darwin"));
		expect(appViewPlan("win32")).toEqual([
			{ name: "src", kind: "junction" },
			{ name: "docs", kind: "junction" },
			{ name: "examples", kind: "junction" },
			{ name: "README.md", kind: "copy" },
			{ name: "CHANGELOG.md", kind: "copy" },
		]);
	});

	it("is built for real with links, and rebuilt only where something changed", () => {
		const dir = temp();
		const upstream = join(dir, "coding-agent");
		for (const name of ["src", "docs", "examples"]) mkdirSync(join(upstream, name), { recursive: true });
		writeFileSync(join(upstream, "README.md"), "readme");
		writeFileSync(join(upstream, "CHANGELOG.md"), "changes");
		writeFileSync(
			join(upstream, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0" }),
		);
		const app = join(dir, "home/app");
		// This machine's own kind of view: links, or on Windows junctions and copies.
		const platform = process.platform;
		const windows = platform === "win32";

		expect(ensureAppView({ platform, app, upstream })).toHaveLength(6);
		// A junction's target comes back with a trailing backslash.
		const target = readlinkSync(join(app, "src"));
		expect(windows ? resolve(target) : target).toBe(join(upstream, "src"));
		if (windows) expect(readFileSync(join(app, "README.md"), "utf8")).toBe("readme");
		else expect(readlinkSync(join(app, "README.md"))).toBe(join(upstream, "README.md"));
		const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
		expect(manifest).toMatchObject({
			name: "@earendil-works/pi-coding-agent",
			piConfig: { name: "mu", configDir: ".mu" },
		});
		expect(ensureAppView({ platform, app, upstream })).toEqual([]);

		// A link that is gone comes back; a folder someone put there by hand is never emptied.
		unlinkSync(join(app, "docs"));
		mkdirSync(join(app, "docs"));
		writeFileSync(join(app, "docs/mine.md"), "keep");
		unlinkSync(join(app, "src"));
		expect(ensureAppView({ platform, app, upstream })).toEqual([windows ? "junction src" : "symlink src"]);
		expect(readFileSync(join(app, "docs/mine.md"), "utf8")).toBe("keep");
	});

	it("on Windows asks for junctions, copies the two files, refreshes a stale copy and never deletes a folder", () => {
		const upstream = "C:\\repo\\packages\\coding-agent";
		const app = "C:\\Users\\bai\\.mu\\app";
		type Node = { kind: "file" | "dir" | "link"; text?: string; mtimeMs: number; target?: string };
		const nodes = new Map<string, Node>([
			[`${upstream}\\README.md`, { kind: "file", text: "new readme", mtimeMs: 200 }],
			[`${upstream}\\CHANGELOG.md`, { kind: "file", text: "changes", mtimeMs: 100 }],
			[`${upstream}\\package.json`, { kind: "file", text: JSON.stringify({ name: "pi" }), mtimeMs: 100 }],
			// From an earlier run: a copy that is older than its source, and a junction into another checkout.
			[`${app}\\README.md`, { kind: "file", text: "old readme", mtimeMs: 150 }],
			[`${app}\\src`, { kind: "link", target: "C:\\old\\packages\\coding-agent\\src\\", mtimeMs: 1 }],
			[`${app}\\examples`, { kind: "dir", mtimeMs: 1 }],
		]);
		const calls: string[] = [];
		const stat = (path: string) => {
			const node = nodes.get(path);
			if (!node) throw new Error(`ENOENT ${path}`);
			return {
				isFile: () => node.kind === "file",
				isDirectory: () => node.kind === "dir",
				isSymbolicLink: () => node.kind === "link",
				size: node.text?.length ?? 0,
				mtimeMs: node.mtimeMs,
			};
		};
		const fs = {
			mkdirSync: () => undefined,
			existsSync: (path: string) => nodes.has(path),
			lstatSync: stat,
			statSync: stat,
			readlinkSync: (path: string) => nodes.get(path)?.target as string,
			readFileSync: (path: string) => nodes.get(path)?.text as string,
			unlinkSync: (path: string) => {
				calls.push(`unlink ${path}`);
				nodes.delete(path);
			},
			symlinkSync: (target: string, path: string, type?: string) => {
				calls.push(`link ${path} -> ${target} (${type})`);
				nodes.set(path, { kind: "link", target, mtimeMs: 300 });
			},
			copyFileSync: (from: string, to: string) => {
				calls.push(`copy ${to}`);
				nodes.set(to, { ...(nodes.get(from) as Node), mtimeMs: 300 });
			},
			writeFileSync: (path: string, text: string) => {
				calls.push(`write ${path}`);
				nodes.set(path, { kind: "file", text, mtimeMs: 300 });
			},
		};

		ensureAppView({ platform: "win32", app, upstream, fs });

		expect(calls).toEqual([
			`unlink ${app}\\src`,
			`link ${app}\\src -> ${upstream}\\src (junction)`,
			`link ${app}\\docs -> ${upstream}\\docs (junction)`,
			// examples is a real folder: left as it is, and nothing is ever removed recursively.
			`unlink ${app}\\README.md`,
			`copy ${app}\\README.md`,
			`copy ${app}\\CHANGELOG.md`,
			`write ${app}\\package.json`,
		]);
		expect(JSON.parse(nodes.get(`${app}\\package.json`)?.text as string).piConfig).toEqual({
			name: "mu",
			configDir: ".mu",
		});
		// Junctions read back with a trailing backslash and in any case: that is still the same place.
		nodes.set(`${app}\\src`, { kind: "link", target: `${upstream.toUpperCase()}\\SRC\\`, mtimeMs: 300 });
		calls.length = 0;
		ensureAppView({ platform: "win32", app, upstream, fs });
		expect(calls).toEqual([]);
	});
});

describe("starting pi", () => {
	it("finds the JavaScript behind the tsx command instead of its shim", () => {
		expect(resolveTsx({ root: WIN_ROOT, platform: "win32", ...disk(winInstalled) })).toBe(
			`${WIN_TSX}\\dist\\cli.mjs`,
		);
		expect(resolveTsx({ root: POSIX_ROOT, platform: "linux", ...disk(posixInstalled) })).toBe(
			`${POSIX_ROOT}/node_modules/tsx/dist/cli.mjs`,
		);
		expect(resolveTsx({ root: POSIX_ROOT, platform: "linux", ...disk({}) })).toBeUndefined();
		// A worktree under the main checkout runs on the main checkout's dependencies, as its imports do.
		expect(
			resolveTsx({ root: `${POSIX_ROOT}/.claude/worktrees/one`, platform: "linux", ...disk(posixInstalled) }),
		).toBe(`${POSIX_ROOT}/node_modules/tsx/dist/cli.mjs`);
		expect(
			resolveTsx({ root: `${WIN_ROOT}\\.claude\\worktrees\\one`, platform: "win32", ...disk(winInstalled) }),
		).toBe(`${WIN_TSX}\\dist\\cli.mjs`);
		// The real one, when this checkout has its dependencies.
		const real = resolveTsx({
			root: repo,
			platform: process.platform,
			exists: existsSync,
			readFile: (path) => readFileSync(path, "utf8"),
		});
		if (existsSync(join(repo, "node_modules/tsx"))) expect(real).toBe(join(repo, "node_modules/tsx/dist/cli.mjs"));
	});

	it("says how to install when the dependencies are missing, without `&&` on Windows", () => {
		const windows = planLaunch({
			platform: "win32",
			env: {},
			argv: [],
			root: WIN_ROOT,
			home: WIN_HOME,
			execPath: "node.exe",
			fs: disk({}),
		});
		expect(windows.error).toContain("npm ci --ignore-scripts");
		expect(windows.error).not.toContain("&&");
		const linux = planLaunch({
			platform: "linux",
			env: {},
			argv: [],
			root: POSIX_ROOT,
			home: "/home/bai",
			execPath: "node",
			fs: disk({}),
		});
		expect(linux.error).toContain(`cd ${POSIX_ROOT} && npm ci --ignore-scripts && npm run hydrate:model-data`);
	});

	it("on Windows runs node with an argument array: no shell, no .cmd shim, the prompt untouched", () => {
		const prompt = 'say "hi" & del %USERPROFILE% | more';
		const plan = launch({
			platform: "win32",
			root: WIN_ROOT,
			home: WIN_HOME,
			execPath: "C:\\Program Files\\nodejs\\node.exe",
			argv: ["-p", prompt],
			fs: disk(winInstalled),
		});

		expect(plan.command).toBe("C:\\Program Files\\nodejs\\node.exe");
		expect(plan.args).toEqual([
			"--disable-warning=ExperimentalWarning",
			// As URLs: `--import` reads C:\... as a URL whose scheme is c:.
			"--import",
			"file:///C:/Users/bai/code/KYRN/kyrn/bin/compile-cache.mjs",
			"--import",
			"file:///C:/Users/bai/code/KYRN/packages/coding-agent/src/experimental/source-resolver.ts",
			`${WIN_ROOT}\\packages\\coding-agent\\src\\experimental\\cli.ts`,
			"-e",
			`${WIN_ROOT}\\packages\\kyrn-judge\\src\\extension\\kyrn-judge.ts`,
			"-p",
			prompt,
		]);
		expect(plan.args.join(" ")).not.toMatch(/\.cmd|\.bin/);
		expect(plan.strategy).toBe("spawn");
		expect(plan.env).toMatchObject({
			PI_PACKAGE_DIR: "C:\\Users\\bai\\.mu\\app",
			MU_CODING_AGENT_DIR: "C:\\Users\\bai\\.mu\\agent",
			KYRN_CODING_AGENT_DIR: "C:\\Users\\bai\\.mu\\agent",
			PI_CODING_AGENT_DIR: "C:\\Users\\bai\\.mu\\agent",
			PI_SKIP_VERSION_CHECK: "1",
		});
	});

	it("runs a checkout's TypeScript with Node itself, and through tsx where Node cannot or the checkout is older", () => {
		expect(launch({ argv: ["--mode", "rpc"] }).args).toEqual([
			...POSIX_NATIVE,
			`${POSIX_ROOT}/packages/coding-agent/src/experimental/cli.ts`,
			"-e",
			`${POSIX_ROOT}/packages/kyrn-judge/src/extension/kyrn-judge.ts`,
			"--mode",
			"rpc",
		]);
		// A runtime that does not strip types: an Electron that runs mu as Node may not.
		expect(launch({ stripsTypes: false }).args.slice(0, 3)).toEqual(POSIX_TSX);
		// A checkout from before pi's source resolver.
		const older = Object.entries(posixInstalled).filter(([file]) => !file.endsWith("source-resolver.ts"));
		expect(launch({ fs: disk(Object.fromEntries(older)) }).args.slice(0, 3)).toEqual(POSIX_TSX);
		// Node strips types, but the dependencies are not installed: that is still said, not left to a failed import.
		expect(sourceRuntime({ root: POSIX_ROOT, platform: "linux", stripsTypes: true, ...disk({}) }).error).toContain(
			"npm ci --ignore-scripts",
		);
		// A user name with a space or beyond ASCII is escaped in the URL, and the file is still found.
		const root = "C:\\Users\\白鹤 Li\\KYRN";
		const tsx = `${root}\\node_modules\\tsx`;
		const named = sourceRuntime({
			root,
			platform: "win32",
			stripsTypes: true,
			...disk({
				[`${tsx}\\package.json`]: JSON.stringify({ bin: "./dist/cli.mjs" }),
				[`${tsx}\\dist\\cli.mjs`]: "",
				[`${root}\\packages\\coding-agent\\src\\experimental\\source-resolver.ts`]: "",
			}),
		});
		expect(named.error === undefined && named.args[4]).toBe(
			"file:///C:/Users/%E7%99%BD%E9%B9%A4%20Li/KYRN/packages/coding-agent/src/experimental/source-resolver.ts",
		);
	});

	it("replaces itself where the system can (as the bash launcher did), and starts a child where it cannot", () => {
		expect(launchStrategy({ platform: "darwin", env: {}, canExec: true })).toBe("exec");
		expect(launchStrategy({ platform: "linux", env: {}, canExec: true })).toBe("exec");
		expect(launchStrategy({ platform: "linux", env: {}, canExec: false })).toBe("spawn");
		expect(launchStrategy({ platform: "linux", env: { MU_LAUNCH: "spawn" }, canExec: true })).toBe("spawn");
		expect(launchStrategy({ platform: "win32", env: { MU_LAUNCH: "exec" }, canExec: true })).toBe("spawn");
	});

	it("under WSL behaves as Linux, and stays in a home from before the rename", () => {
		const plan = launch({
			wsl: true,
			env: { WSL_DISTRO_NAME: "Ubuntu", PI_SKIP_VERSION_CHECK: "0", KYRN_AGENT_DIR: "" },
			fs: disk(posixInstalled, ["/home/bai/.kyrn"]),
		});
		expect(plan.muDir).toBe("/home/bai/.kyrn");
		expect(plan.env.MU_CODING_AGENT_DIR).toBe("/home/bai/.kyrn/agent");
		expect(plan.env.PI_SKIP_VERSION_CHECK).toBe("0");
		expect(plan.strategy).toBe("exec");
		expect(launch({ env: { KYRN_AGENT_DIR: "/data/agent", MU_APP_DIR: "/data/app" } }).env).toMatchObject({
			MU_CODING_AGENT_DIR: "/data/agent",
			PI_PACKAGE_DIR: "/data/app",
		});
	});

	it("prints the launcher's own help before the agent's", () => {
		expect(launch({ argv: ["--help"] }).preface).toContain("Agent flags:");
		expect(launch({ argv: ["-h"] }).preface).toContain("mu link | unlink");
		expect(launch({ argv: ["-p", "--help"] }).preface).toBeUndefined();
	});
});

describe("pi inside another program (the desktop app's runtime host)", () => {
	const WIN_PACKAGE = "C:\\Program Files\\mu\\resources\\harness\\mu-agent";
	const winPackage = {
		[`${WIN_PACKAGE}\\dist\\bundle\\cli.js`]: "",
		[`${WIN_PACKAGE}\\judge\\dist\\kyrn-judge.js`]: "",
	};
	const rpc = ["--mode", "rpc"];

	it("imports pi's bundle and runs the built judgment layer from the package, in the launcher's environment", () => {
		const input = {
			platform: "win32" as const,
			env: { Path: "C:\\Windows" },
			argv: rpc,
			root: WIN_PACKAGE,
			home: WIN_HOME,
			fs: disk({ ...winPackage, "C:\\Users\\bai\\.mu\\.env": "TYPESAFE_API_KEY=from-home\n" }),
		};
		const host = planHost(input);
		if (host.error !== undefined) throw new Error(host.error);
		expect(host).toMatchObject({
			module: `${WIN_PACKAGE}\\dist\\bundle\\index.js`,
			execArgv: [],
			args: ["-e", `${WIN_PACKAGE}\\judge\\dist\\kyrn-judge.js`, "--mode", "rpc"],
			layout: "package",
			appDir: WIN_PACKAGE,
			agentDir: "C:\\Users\\bai\\.mu\\agent",
		});
		// The command line's pi and the app's are one: the same home, settings, sign-ins and keys.
		expect(host.env).toEqual(launch({ ...input, execPath: "node.exe" }).env);
		expect(host.env.TYPESAFE_API_KEY).toBe("from-home");
	});

	it("runs a checkout's sources on Node's own type stripping, with pi's source resolver", () => {
		const host = planHost({
			platform: "linux",
			env: {},
			argv: rpc,
			root: POSIX_ROOT,
			home: "/home/bai",
			fs: disk(posixInstalled),
		});
		if (host.error !== undefined) throw new Error(host.error);
		expect(host).toMatchObject({
			module: `${POSIX_ROOT}/packages/coding-agent/src/index.ts`,
			execArgv: POSIX_NATIVE,
			args: ["-e", `${POSIX_ROOT}/packages/kyrn-judge/src/extension/kyrn-judge.ts`, "--mode", "rpc"],
			layout: "repo",
			appDir: "/home/bai/.mu/app",
		});
		expect(host.env).toEqual(launch({ argv: rpc }).env);
	});

	it("does not put tsx in front of a checkout it cannot run on the host's own Node", () => {
		const input = { platform: "linux" as const, env: {}, argv: rpc, root: POSIX_ROOT, home: "/home/bai" };
		expect(planHost({ ...input, stripsTypes: false, fs: disk(posixInstalled) }).error).toContain(
			"strips TypeScript types",
		);
		const noResolver = Object.fromEntries(
			Object.entries(posixInstalled).filter(([path]) => !path.endsWith("source-resolver.ts")),
		);
		expect(planHost({ ...input, fs: disk(noResolver) }).error).toContain("source resolver");
	});
});

describe("preparing a launch, for the command line and for a program that must not stop", () => {
	const posix = process.platform !== "win32";
	const NOT_STARTED = "the local judge did not start";

	/** A launcher folder whose local judge is a script that runs `script`, and an agent folder to prepare. */
	function prepared(script: string | undefined, startJudge: boolean) {
		const root = temp();
		const bin = join(root, "bin");
		mkdirSync(bin);
		if (script !== undefined) writeFileSync(join(bin, "kyrn-judge-local"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
		const notes: string[] = [];
		const input = {
			plan: {
				layout: "package" as const,
				appDir: root,
				agentDir: join(root, "agent"),
				notes: ["a note from the configuration"],
				startJudge,
				env: { PATH: "/usr/bin:/bin" },
			},
			platform: process.platform,
			root,
			bin,
			err: (message: string) => notes.push(message),
		};
		return { root, input, notes };
	}

	it("makes the agent folder and passes the configuration's notes on, whichever way it is called", async () => {
		const sync = prepared(undefined, false);
		prepareLaunch(sync.input);
		const later = prepared(undefined, false);
		await prepareLaunchAsync(later.input);
		for (const each of [sync, later]) {
			expect(existsSync(join(each.root, "agent"))).toBe(true);
			expect(each.notes).toEqual(["a note from the configuration"]);
		}
	});

	it.skipIf(!posix)("starts the local judge through its script, and says nothing when it starts", async () => {
		const { root, input, notes } = prepared('echo "$1" > "$(dirname "$0")/started"', true);
		await prepareLaunchAsync(input);
		expect(readFileSync(join(root, "bin", "started"), "utf8").trim()).toBe("start");
		expect(notes).toEqual(["a note from the configuration"]);
	});

	it.skipIf(!posix)("does not stop the process while the local judge starts", async () => {
		const { input } = prepared("sleep 0.5", true);
		let ticks = 0;
		const timer = setInterval(() => ticks++, 25);
		try {
			await prepareLaunchAsync(input);
		} finally {
			clearInterval(timer);
		}
		// spawnSync would hold the event loop for the whole half second: no timer could have run.
		expect(ticks).toBeGreaterThanOrEqual(5);
	});

	it.skipIf(!posix)("says the same when the local judge fails or is missing, blocking or not", async () => {
		for (const script of ["exit 3", undefined]) {
			const sync = prepared(script, true);
			prepareLaunch(sync.input);
			const later = prepared(script, true);
			await prepareLaunchAsync(later.input);
			expect(sync.notes.at(-1)).toContain(NOT_STARTED);
			expect(later.notes).toEqual(sync.notes);
		}
	});
});

describe("the npm package (mu-agent)", () => {
	const WIN_PACKAGE = "C:\\Users\\bai\\AppData\\Roaming\\npm\\node_modules\\mu-agent";
	const winPackage = {
		[`${WIN_PACKAGE}\\dist\\bundle\\cli.js`]: "",
		[`${WIN_PACKAGE}\\judge\\dist\\kyrn-judge.js`]: "",
	};
	const POSIX_PACKAGE = "/usr/local/lib/node_modules/mu-agent";
	const posixPackage = {
		[`${POSIX_PACKAGE}/dist/bundle/cli.js`]: "",
		[`${POSIX_PACKAGE}/judge/dist/kyrn-judge.js`]: "",
	};

	it("is told apart from a checkout, also from one without its dependencies", () => {
		const exists = (files: Record<string, string>) => (path: string) => path in files;
		expect(layoutOf({ root: POSIX_PACKAGE, platform: "linux", exists: exists(posixPackage) })).toBe("package");
		expect(layoutOf({ root: WIN_PACKAGE, platform: "win32", exists: exists(winPackage) })).toBe("package");
		expect(
			layoutOf({
				root: POSIX_ROOT,
				platform: "linux",
				exists: exists({ [`${POSIX_ROOT}/packages/coding-agent/package.json`]: "" }),
			}),
		).toBe("repo");
		expect(layoutOf({ root: POSIX_ROOT, platform: "linux", exists: exists({}) })).toBe("repo");
	});

	it("runs pi's bundle with the built judgment layer: no tsx, and the package names the app itself", () => {
		const prompt = 'say "hi" & del %USERPROFILE% | more';
		const plan = launch({
			platform: "win32",
			root: WIN_PACKAGE,
			home: WIN_HOME,
			execPath: "C:\\Program Files\\nodejs\\node.exe",
			argv: ["-p", prompt],
			fs: disk(winPackage),
		});
		expect(plan.layout).toBe("package");
		expect(plan.args).toEqual([
			`${WIN_PACKAGE}\\dist\\bundle\\cli.js`,
			"-e",
			`${WIN_PACKAGE}\\judge\\dist\\kyrn-judge.js`,
			"-p",
			prompt,
		]);
		expect(plan.strategy).toBe("spawn");
		expect(plan.env).toMatchObject({
			PI_PACKAGE_DIR: WIN_PACKAGE,
			MU_CODING_AGENT_DIR: "C:\\Users\\bai\\.mu\\agent",
			PI_SKIP_VERSION_CHECK: "1",
			// pi's install report goes to pi.dev; mu-agent is not a pi install.
			PI_TELEMETRY: "0",
		});
		expect(plan.appDir).toBe(WIN_PACKAGE);
	});

	it("reads the Jev key from ~/.mu/.env, not from a .env beside the package, and keeps a telemetry choice", () => {
		const plan = launch({
			root: POSIX_PACKAGE,
			env: { PI_TELEMETRY: "1" },
			fs: disk({
				...posixPackage,
				"/home/bai/.mu/.env": "AI_GATEWAY_API_KEY=from-home\n",
				[`${POSIX_PACKAGE}/.env`]: "TYPESAFE_API_KEY=beside-the-package\n",
			}),
		});
		expect(plan.env.AI_GATEWAY_API_KEY).toBe("from-home");
		expect(plan.env.TYPESAFE_API_KEY).toBeUndefined();
		expect(plan.env.PI_TELEMETRY).toBe("1");
		expect(envFilePath({ layout: "repo", root: POSIX_ROOT, muDir: "/home/bai/.mu", platform: "linux" })).toBe(
			`${POSIX_ROOT}/.env`,
		);
		// A checkout keeps reporting nothing new: its telemetry is pi's own business, as before.
		expect(launch({}).env.PI_TELEMETRY).toBeUndefined();
	});

	it("says to reinstall when the package lost its judgment layer", () => {
		const plan = planLaunch({
			platform: "linux",
			env: {},
			argv: [],
			root: POSIX_PACKAGE,
			home: "/home/bai",
			execPath: "node",
			fs: disk({ [`${POSIX_PACKAGE}/dist/bundle/cli.js`]: "" }),
		});
		expect(plan.error).toContain("npm i -g mu-agent");
		expect(packageEntries({ root: POSIX_PACKAGE, platform: "linux" }).extension).toBe(
			`${POSIX_PACKAGE}/judge/dist/kyrn-judge.js`,
		);
	});

	it("signs in with `mu auth` from the package's built sign-in, in mu's agent folder, and reads no key for it", () => {
		const plan = planAuth({
			platform: "win32",
			env: { Path: "C:\\Windows", TYPESAFE_API_KEY: undefined },
			argv: ["login", "openai-codex"],
			root: WIN_PACKAGE,
			home: WIN_HOME,
			execPath: "C:\\Program Files\\mu\\mu.exe",
			fs: disk({
				...winPackage,
				[`${WIN_PACKAGE}\\judge\\dist\\auth.js`]: "",
				"C:\\Users\\bai\\.mu\\.env": "TYPESAFE_API_KEY=x\n",
			}),
		});
		if (plan.error !== undefined) throw new Error(plan.error);
		expect(plan.command).toBe("C:\\Program Files\\mu\\mu.exe");
		expect(plan.args).toEqual([`${WIN_PACKAGE}\\judge\\dist\\auth.js`, "login", "openai-codex"]);
		expect(plan.strategy).toBe("spawn");
		expect(plan.env).toEqual({ Path: "C:\\Windows", MU_AGENT_DIR: "C:\\Users\\bai\\.mu\\agent" });
		expect(plan.agentDir).toBe("C:\\Users\\bai\\.mu\\agent");
		// A package that lost its sign-in says so.
		const broken = planAuth({
			platform: "linux",
			env: {},
			argv: ["status"],
			root: POSIX_PACKAGE,
			home: "/home/bai",
			execPath: "node",
			fs: disk(posixPackage),
		});
		expect(broken.error).toContain(`${POSIX_PACKAGE}/judge/dist/auth.js is missing`);
		expect(packageEntries({ root: POSIX_PACKAGE, platform: "linux" }).auth).toBe(
			`${POSIX_PACKAGE}/judge/dist/auth.js`,
		);
	});
});

describe("mu auth in a checkout", () => {
	it("runs the sign-in's sources the way pi runs, in the agent folder mu uses everywhere else", () => {
		const plan = planAuth({
			platform: "linux",
			env: { MU_AGENT_DIR: "/srv/mu-agent" },
			argv: ["status"],
			root: POSIX_ROOT,
			home: "/home/bai",
			execPath: "/usr/bin/node",
			canExec: true,
			fs: disk(posixInstalled),
		});
		if (plan.error !== undefined) throw new Error(plan.error);
		expect(plan.args).toEqual([...POSIX_NATIVE, `${POSIX_ROOT}/packages/kyrn-judge/src/auth/main.ts`, "status"]);
		expect(plan.strategy).toBe("exec");
		expect(plan.env.MU_AGENT_DIR).toBe("/srv/mu-agent");
		// Before the rename the home was ~/.kyrn; a machine that still has only that one keeps it.
		const legacy = planAuth({
			platform: "linux",
			env: {},
			argv: ["status"],
			root: POSIX_ROOT,
			home: "/home/bai",
			execPath: "node",
			fs: disk(posixInstalled, ["/home/bai/.kyrn"]),
		});
		expect(legacy.error === undefined && legacy.env.MU_AGENT_DIR).toBe("/home/bai/.kyrn/agent");
		const bare = planAuth({
			platform: "linux",
			env: {},
			argv: ["status"],
			root: POSIX_ROOT,
			home: "/home/bai",
			execPath: "node",
			fs: disk({}),
		});
		expect(bare.error).toContain("npm ci --ignore-scripts");
	});
});

describe("the repo-root .env", () => {
	const FIXTURE = [
		"# the key for Jev",
		"export TYPESAFE_API_KEY=fixture-direct-key",
		'AI_GATEWAY_API_KEY="fixture gateway \\"key\\" with $dollar"   # trailing comment',
		"SINGLE='literal \\n $HOME #not-a-comment'",
		"PLAIN = spaced value   # comment",
		"HASH=abc#def",
		"EMPTY=",
		'PEM="-----BEGIN-----',
		"line two",
		'-----END-----"',
		"this line is a secret without a name",
		"AFTER=still-read",
	].join("\r\n");

	it("reads KEY=VALUE lines as data: quotes, comments, the export prefix, values over several lines", () => {
		const { entries, problems } = parseEnvFile(FIXTURE);
		expect(Object.fromEntries(entries)).toEqual({
			TYPESAFE_API_KEY: "fixture-direct-key",
			AI_GATEWAY_API_KEY: 'fixture gateway "key" with $dollar',
			SINGLE: "literal \\n $HOME #not-a-comment",
			PLAIN: "spaced value",
			HASH: "abc#def",
			EMPTY: "",
			PEM: "-----BEGIN-----\nline two\n-----END-----",
			AFTER: "still-read",
		});
		expect(problems).toEqual([11]);
		// A quote that never closes costs that one line only.
		expect(parseEnvFile('BROKEN="no end\nNEXT=1')).toEqual({ entries: [["NEXT", "1"]], problems: [1] });
	});

	it("lets the real environment win, also with an empty value, and on Windows whatever the case", () => {
		const entries = parseEnvFile("TYPESAFE_API_KEY=from-file\nOther=from-file").entries;
		expect(envFileAdditions({ env: { TYPESAFE_API_KEY: "" }, entries, platform: "linux" })).toEqual({
			Other: "from-file",
		});
		expect(envFileAdditions({ env: { other: "real" }, entries, platform: "linux" })).toHaveProperty("Other");
		expect(
			envFileAdditions({ env: { other: "real", typesafe_api_key: "real" }, entries, platform: "win32" }),
		).toEqual({});
	});

	it("hands the values to the agent and never prints one, not even from a line it could not read", () => {
		const plan = launch({
			env: { AFTER: "from-the-shell" },
			fs: disk({
				...posixInstalled,
				[`${POSIX_ROOT}/.env`]: `${FIXTURE}\nMU_CODING_AGENT_DIR=/from/file\nMU_JUDGE=laya`,
			}),
		});

		expect(plan.env.TYPESAFE_API_KEY).toBe("fixture-direct-key");
		expect(plan.env.AFTER).toBe("from-the-shell");
		// What the launcher decides is not the file's to change.
		expect(plan.env.MU_CODING_AGENT_DIR).toBe("/home/bai/.mu/agent");
		expect(plan.notes.join("\n")).toContain("skipped line 11");
		const said = JSON.stringify([plan.notes, plan.preface, plan.args]);
		for (const secret of ["fixture-direct-key", "fixture gateway", "secret without a name", "BEGIN"]) {
			expect(said).not.toContain(secret);
		}
		// The file can name the judges, as it could when it was sourced.
		expect(plan.notes.join("\n")).toContain("local judge (laya)");
	});
});

describe("the local judge away from macOS", () => {
	it("is started by the launcher on macOS only", () => {
		const files = { ...posixInstalled, "/home/bai/.mu/agent/mu.json": '{ "tiers": ["laya", "jev"] }' };
		expect(launch({ platform: "darwin", fs: disk(files) })).toMatchObject({ startJudge: true, notes: [] });

		const linux = launch({ fs: disk(files) });
		expect(linux.startJudge).toBe(false);
		expect(linux.notes[0]).toMatch(/local judge \(laya\), which runs on macOS only; on Linux/);
		expect(launch({ wsl: true, fs: disk(files) }).notes[0]).toContain("on WSL");

		// A server of one's own is the way out, and then there is nothing to say.
		expect(launch({ env: { MU_LOCAL_JUDGE_URL: "http://10.0.0.5:47823" }, fs: disk(files) })).toMatchObject({
			startJudge: false,
			notes: [],
		});
		// MU_JUDGE decides before the file; kyrn.json is only read when there is no mu.json.
		expect(launch({ env: { MU_JUDGE: "jev" }, fs: disk(files) }).notes).toEqual([]);
		expect(launch({ env: { KYRN_JUDGE: "jev,laya" }, fs: disk(posixInstalled) }).notes).toHaveLength(1);
		const legacy = {
			...posixInstalled,
			"/home/bai/.mu/agent/mu.json": "{}",
			"/home/bai/.mu/agent/kyrn.json": '{"tiers":["laya"]}',
		};
		expect(launch({ fs: disk(legacy) }).notes).toEqual([]);
	});

	it("explains itself instead of failing: `mu judge start` on Windows, Linux and WSL", () => {
		expect(planJudge({ platform: "darwin", env: {}, argv: [], bin: "/repo/kyrn/bin" })).toEqual({
			kind: "script",
			command: "/repo/kyrn/bin/kyrn-judge-local",
			args: ["status"],
		});
		for (const [platform, wsl, name] of [
			["win32", false, "Windows"],
			["linux", false, "Linux"],
			["linux", true, "WSL"],
		] as const) {
			const plan = planJudge({ platform, wsl, env: {}, argv: ["start"], bin: "bin" });
			if (plan.kind !== "unsupported") throw new Error(`expected an explanation, got ${plan.kind}`);
			expect(plan.message).toContain(`macOS with Apple Silicon only, not on ${name}`);
			expect(plan.message).toContain("Jev");
			expect(plan.message).toContain("desktop app");
			expect(plan.message).toContain("MU_LOCAL_JUDGE_URL");
		}
		const env = { MU_LOCAL_JUDGE_URL: "http://10.0.0.5:47823/" };
		expect(planJudge({ platform: "linux", env, argv: [], bin: "bin" })).toEqual({
			kind: "health",
			url: "http://10.0.0.5:47823/health",
		});
		expect(planJudge({ platform: "win32", env, argv: ["start"], bin: "bin" }).kind).toBe("unsupported");
	});
});

describe("mu import", () => {
	const importArgs = { env: {}, argv: ["--list"], home: "/home/bai", execPath: "/usr/bin/node" };

	it("runs the importer's TypeScript with Node itself in a checkout, the built one in the npm package", () => {
		const source = `${POSIX_ROOT}/packages/kyrn-judge/src/import/cli.ts`;
		const checkout = planImport({ ...importArgs, platform: "linux", root: POSIX_ROOT, fs: disk({ [source]: "" }) });
		expect(checkout).toMatchObject({
			command: "/usr/bin/node",
			args: ["--disable-warning=ExperimentalWarning", source, "--list"],
			agentDir: "/home/bai/.mu/agent",
		});
		expect(checkout.error === undefined && checkout.env.MU_CODING_AGENT_DIR).toBe("/home/bai/.mu/agent");

		expect(planImport({ ...importArgs, platform: "linux", root: POSIX_ROOT, fs: disk({}) }).error).toContain(
			"mu import is missing from this checkout",
		);

		const pkg = "/usr/local/lib/node_modules/mu-agent";
		const built = `${pkg}/judge/dist/import.js`;
		expect(packageEntries({ root: pkg, platform: "linux" }).import).toBe(built);
		const installed = { [`${pkg}/dist/bundle/cli.js`]: "", [`${pkg}/judge/dist/kyrn-judge.js`]: "" };
		expect(
			planImport({ ...importArgs, platform: "linux", root: pkg, fs: disk({ ...installed, [built]: "" }) }),
		).toMatchObject({ command: "/usr/bin/node", args: [built, "--list"], agentDir: "/home/bai/.mu/agent" });
		// A package built before mu import says to update, instead of passing `import` to pi as a message.
		expect(planImport({ ...importArgs, platform: "linux", root: pkg, fs: disk(installed) }).error).toContain(
			"npm i -g mu-agent",
		);
	});

	it("builds Windows paths on Windows, and follows MU_AGENT_DIR", () => {
		const source = `${WIN_ROOT}\\packages\\kyrn-judge\\src\\import\\cli.ts`;
		const plan = planImport({
			...importArgs,
			platform: "win32",
			root: WIN_ROOT,
			home: WIN_HOME,
			execPath: "node.exe",
			env: { MU_AGENT_DIR: "D:\\mu-test" },
			fs: disk({ [source]: "" }),
		});
		expect(plan).toMatchObject({
			command: "node.exe",
			args: ["--disable-warning=ExperimentalWarning", source, "--list"],
		});
		expect(plan.error === undefined && plan.env.MU_CODING_AGENT_DIR).toBe("D:\\mu-test");
	});

	it("takes a checkout's sources through tsx on a runtime that does not strip types, as the app's Electron may not", () => {
		const source = `${WIN_ROOT}\\packages\\kyrn-judge\\src\\import\\cli.ts`;
		const electron = {
			...importArgs,
			platform: "win32" as const,
			root: WIN_ROOT,
			home: WIN_HOME,
			execPath: "C:\\Program Files\\mu\\mu.exe",
			stripsTypes: false,
		};
		expect(planImport({ ...electron, fs: disk({ ...winInstalled, [source]: "" }) })).toMatchObject({
			command: "C:\\Program Files\\mu\\mu.exe",
			args: [`${WIN_TSX}\\dist\\cli.mjs`, "--tsconfig", `${WIN_ROOT}\\tsconfig.json`, source, "--list"],
		});
		expect(planImport({ ...electron, fs: disk({ [source]: "" }) }).error).toContain("npm ci --ignore-scripts");
	});

	it("imports through the launcher without tsx", () => {
		const dir = temp();
		const transcript = join(dir, "claude", "projects", "p", "0b9c6f7e-1111-4222-8333-444455556666.jsonl");
		mkdirSync(dirname(transcript), { recursive: true });
		const base = {
			parentUuid: null,
			isSidechain: false,
			cwd: "/tmp/mu-import-fixture/project",
			sessionId: "0b9c6f7e-1111-4222-8333-444455556666",
			timestamp: "2026-01-02T03:04:05.000Z",
		};
		writeFileSync(
			transcript,
			[
				{ ...base, type: "user", uuid: "u1", message: { role: "user", content: "Say hello" } },
				{
					...base,
					parentUuid: "u1",
					type: "assistant",
					uuid: "a1",
					message: {
						id: "m1",
						role: "assistant",
						model: "claude-test-1",
						content: [{ type: "text", text: "Hello." }],
					},
				},
			]
				.map((line) => JSON.stringify(line))
				.join("\n"),
		);
		const agentDir = join(dir, "mu-agent");
		const result = runScript(MU, ["import", "--json", transcript], {
			HOME: dir,
			MU_AGENT_DIR: agentDir,
			CLAUDE_CONFIG_DIR: join(dir, "claude"),
		});
		expect(result.err).toBe("");
		expect(result.code).toBe(0);
		const [imported] = (JSON.parse(result.out) as { results: { status: string; sessionFile: string }[] }).results;
		expect(imported.status).toBe("imported");
		expect(imported.sessionFile.startsWith(join(agentDir, "sessions"))).toBe(true);
		expect(readFileSync(imported.sessionFile, "utf8")).toContain('"customType":"mu.import"');
	});
});

describe("mu link on Windows", () => {
	const BIN = `${WIN_ROOT}\\kyrn\\bin`;
	const LINKS = "C:\\Users\\bai\\.local\\bin";
	const ours = shimContent({ linkDir: LINKS, bin: BIN });
	function link(files: Record<string, string>, env: Record<string, string>, argv: string[] = []) {
		return planLink({
			platform: "win32",
			env,
			home: WIN_HOME,
			bin: BIN,
			argv,
			fs: {
				realPath: (path) => path,
				exists: (path) => path in files,
				isFile: (path) => path in files,
				readFile: (path) => {
					if (!(path in files)) throw new Error("ENOENT");
					return files[path];
				},
			},
		});
	}

	it("writes a shim that finds mu.cmd from where it is, in CRLF and ASCII", () => {
		expect(linkPath({ platform: "win32", env: {}, home: WIN_HOME })).toBe(`${LINKS}\\mu.cmd`);
		expect(linkPath({ platform: "win32", env: { KYRN_LINK_DIR: "D:\\tools" }, home: WIN_HOME })).toBe(
			"D:\\tools\\mu.cmd",
		);
		expect(ours.split("\r\n")).toEqual([
			"@echo off",
			"rem mu-link-shim: written by `mu link`, removed by `mu unlink`.",
			'"%~dp0..\\..\\code\\KYRN\\kyrn\\bin\\mu.cmd" %*',
			"",
		]);
		// Another drive has no relative path: the target is written out.
		expect(shimContent({ linkDir: "D:\\tools", bin: BIN })).toContain(`"${BIN}\\mu.cmd" %*`);
	});

	it("links, and says how to put the folder on PATH without touching PATH itself", () => {
		const plan = link({}, { Path: "C:\\Windows\\System32" });
		if (plan.action !== "link") throw new Error("expected a link");
		expect(plan).toMatchObject({ link: `${LINKS}\\mu.cmd`, content: ours, message: `mu -> ${BIN}\\mu.cmd` });
		expect(plan.notes.join("\n")).toContain("is not on your PATH yet");
		expect(plan.notes.join("\n")).toContain('GetEnvironmentVariable("Path", "User")');
		expect(plan.notes.join("\n")).not.toContain("setx");
		// Already there, in another case and with a trailing backslash: nothing to say.
		expect(link({}, { PATH: `C:\\Windows;${LINKS.toUpperCase()}\\` })).toMatchObject({ action: "link", notes: [] });
	});

	it("leaves another program's mu alone: neither replaced nor shadowed without --force", () => {
		const replaced = link({ [`${LINKS}\\mu.cmd`]: "@echo off\r\nsomeone else's\r\n" }, { PATH: LINKS });
		expect(replaced).toMatchObject({ action: "refuse" });
		expect(JSON.stringify(replaced)).toContain("is not this mu");

		const other = { "C:\\tools\\mu.exe": "MZ" };
		const env = { PATH: `C:\\tools;${LINKS}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
		expect(link(other, env)).toMatchObject({
			action: "refuse",
			errors: ["Another mu is already on your PATH: C:\\tools\\mu.exe", expect.any(String)],
		});
		expect(link(other, env, ["--force"]).action).toBe("link");
		// Its own shim, and this repository's bin folder on PATH, are not "another mu".
		expect(link({ [`${LINKS}\\mu.cmd`]: ours }, { PATH: LINKS }).action).toBe("link");
		expect(link({ [`${BIN}\\mu.cmd`]: "the real one" }, { PATH: BIN }).action).toBe("link");
	});

	it("warns when the shim cannot be ASCII, and unlinks only a shim it wrote", () => {
		const plan = planLink({
			platform: "win32",
			env: { PATH: "C:\\Users\\白鹤\\.local\\bin" },
			home: "C:\\Users\\白鹤",
			bin: "C:\\Users\\白鹤\\KYRN\\kyrn\\bin",
			argv: [],
			fs: { realPath: (path) => path, exists: () => false, isFile: () => false, readFile: () => "" },
		});
		// Same drive: the user name cancels out of the relative path, so the shim stays ASCII.
		expect(plan).toMatchObject({ action: "link", notes: [] });
		const far = planLink({
			platform: "win32",
			env: { PATH: "D:\\tools", MU_LINK_DIR: "D:\\tools" },
			home: "C:\\Users\\白鹤",
			bin: "C:\\Users\\白鹤\\KYRN\\kyrn\\bin",
			argv: [],
			fs: { realPath: (path) => path, exists: () => false, isFile: () => false, readFile: () => "" },
		});
		expect(JSON.stringify(far)).toContain("non-ASCII");

		const unlink = (text: string | undefined) =>
			planUnlink({
				platform: "win32",
				env: {},
				home: WIN_HOME,
				fs: {
					isLink: () => false,
					readFile: () => {
						if (text === undefined) throw new Error("ENOENT");
						return text;
					},
				},
			});
		expect(unlink(ours).remove).toBe(`${LINKS}\\mu.cmd`);
		expect(unlink("@echo off\r\nsomeone else's").remove).toBeUndefined();
		expect(unlink(undefined).message).toContain("nothing removed");
	});

	it("searches PATH the way each system does", () => {
		const files = ["/opt/bin/mu", "C:\\tools\\mu.bat"];
		const isFile = (path: string) => files.includes(path);
		expect(findOnPath({ name: "mu", platform: "linux", env: { PATH: "/usr/bin::/opt/bin" }, isFile })).toBe(
			"/opt/bin/mu",
		);
		expect(findOnPath({ name: "mu", platform: "win32", env: { Path: "C:\\Windows;C:\\tools" }, isFile })).toBe(
			"C:\\tools\\mu.bat",
		);
		expect(
			findOnPath({ name: "mu", platform: "win32", env: { Path: "C:\\tools", PATHEXT: ".EXE" }, isFile }),
		).toBeUndefined();
	});
});

describe("mu migrate without pgrep", () => {
	const TASKLIST = [
		'"System Idle Process","0","Services","0","8 K"',
		'"aioncore.exe","7312","Console","1","48,120 K"',
		'"node.exe","9100","Console","1","91,004 K"',
	].join("\r\n");
	const CIM = [
		'"ProcessId","Name","CommandLine"',
		'"9100","node.exe","""C:\\Program Files\\nodejs\\node.exe"" C:\\code\\KYRN\\packages\\kyrn-judge\\src\\extension\\kyrn-judge.ts, --mode rpc"',
		'"9200","chrome.exe","chrome.exe --user-data-dir=c:\\users\\BAI\\.kyrn\\browser-profile --headless=new"',
		'"9300","node.exe","node mu.mjs migrate"',
		'"4","System",',
	].join("\r\n");

	it("reads the two lists Windows gives: names from tasklist, command lines from PowerShell", () => {
		expect(parseCsv('a,"b ""q"", c"\r\n\r\n"multi\nline",2')).toEqual([
			["a", 'b "q", c'],
			["multi\nline", "2"],
		]);
		expect(parseTasklist(TASKLIST)).toEqual([
			{ name: "aioncore.exe", pid: 7312, command: "" },
			{ name: "node.exe", pid: 9100, command: "" },
		]);
		expect(parseWindowsProcesses(CIM)[0]).toEqual({
			pid: 9100,
			name: "node.exe",
			command:
				'"C:\\Program Files\\nodejs\\node.exe" C:\\code\\KYRN\\packages\\kyrn-judge\\src\\extension\\kyrn-judge.ts, --mode rpc',
		});
		expect(parseWindowsProcesses("")).toEqual([]);
	});

	it("finds what still uses the old home, whatever the slashes and the case", () => {
		const processes = [...parseTasklist(TASKLIST), ...parseWindowsProcesses(CIM)];
		expect(busyFromProcesses({ processes, old: "C:\\Users\\bai\\.kyrn", platform: "win32", self: 9300 })).toEqual({
			sessions: [9100],
			browser: [9200],
			desktop: [7312],
		});
		const ran: string[] = [];
		const busy = findBusy({
			platform: "win32",
			old: "C:\\Users\\bai\\.kyrn",
			self: 9300,
			run: (command) => {
				ran.push(command);
				return command === "tasklist" ? TASKLIST : CIM;
			},
		});
		expect(ran).toEqual(["tasklist", "powershell.exe"]);
		expect(busy?.desktop).toEqual([7312]);
		// POSIX keeps asking pgrep, with the same three questions as before.
		const asked: string[][] = [];
		findBusy({
			platform: "darwin",
			old: "/Users/bai/.kyrn",
			self: 1,
			run: (_command, args) => {
				asked.push(args);
				return "41 42\n";
			},
		});
		expect(asked).toEqual([
			["-f", "kyrn-judge/src/extension/kyrn-judge.ts"],
			["-f", "/Users/bai/.kyrn/browser-profile"],
			["-x", "aioncore"],
		]);
	});

	function windowsHome(run: (command: string) => string | undefined) {
		const folders = new Set(["C:\\Users\\bai\\.kyrn"]);
		const files = new Set(["C:\\Users\\bai\\.kyrn\\agent\\kyrn.json"]);
		const done: string[] = [];
		const lines: string[] = [];
		const code = migrate({
			platform: "win32",
			home: WIN_HOME,
			argv: [],
			self: 9300,
			run,
			alive: () => false,
			out: (line) => lines.push(line),
			err: (line) => lines.push(line),
			fs: {
				isLink: () => false,
				isDir: (path) => folders.has(path),
				exists: (path) => folders.has(path) || files.has(path),
				readlink: () => "",
				readFile: () => {
					throw new Error("ENOENT");
				},
				rename: (from, to) => done.push(`rename ${from} -> ${to}`),
				link: (target, at, kind) => done.push(`${kind} ${at} -> ${target}`),
			},
		});
		return { code, done, said: lines.join("\n") };
	}

	it("on Windows moves the folder and leaves a junction, which needs no privilege", () => {
		const moved = windowsHome((command) =>
			command === "tasklist" ? '"node.exe","9300","Console","1","1 K"' : '"ProcessId","Name","CommandLine"',
		);
		expect(moved.code).toBe(0);
		expect(moved.done).toEqual([
			"rename C:\\Users\\bai\\.kyrn -> C:\\Users\\bai\\.mu",
			"junction C:\\Users\\bai\\.kyrn -> C:\\Users\\bai\\.mu",
			"rename C:\\Users\\bai\\.mu\\agent\\kyrn.json -> C:\\Users\\bai\\.mu\\agent\\mu.json",
		]);
	});

	it("moves nothing while something runs, nor when it cannot find out what runs", () => {
		const busy = windowsHome((command) => (command === "tasklist" ? TASKLIST : CIM));
		expect(busy).toMatchObject({ code: 1, done: [] });
		expect(busy.said).toContain("mu sessions");
		expect(busy.said).toContain("the mu browser (pid 9200)");
		expect(busy.said).toContain("desktop app's backend (pid 7312)");

		const blind = windowsHome(() => undefined);
		expect(blind).toMatchObject({ code: 1, done: [] });
		expect(blind.said).toContain("could not be read");
	});
});

describe("the launcher, run for real on this machine", () => {
	const installed = existsSync(join(repo, "node_modules/.bin/tsx"));
	const windows = process.platform === "win32";
	const run = (args: string[], env: Record<string, string>) => runScript(MU, args, env);
	/** A search path without the Node that runs these tests: `first`, then the system's own folders. */
	const bare = (...first: string[]) => [...first, ...SYSTEM_PATH].join(delimiter);

	it.skipIf(windows)("refuses a Node that is too old before any JavaScript runs", () => {
		const dir = temp();
		writeFileSync(join(dir, "node"), '#!/bin/sh\necho "v20.20.1"\n', { mode: 0o755 });
		const refused = run(["help"], { HOME: dir, PATH: bare(dir) });
		expect(refused.code).toBe(1);
		expect(refused.err).toContain("mu needs Node >= 22.19 (found v20.20.1)");

		// An nvm under the home is where a newer one is looked for.
		const nvm = join(dir, ".nvm/versions/node/v24.0.0/bin");
		mkdirSync(nvm, { recursive: true });
		writeFileSync(join(nvm, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
		expect(run(["help"], { HOME: dir, PATH: bare(dir) })).toMatchObject({ code: 0 });
	});

	// mu.cmd's own check, which cmd runs. Windows has no nvm to look in.
	it.runIf(windows)("refuses a Node that is too old, or none at all, before any JavaScript runs, in cmd too", () => {
		const dir = temp();
		const none = run(["help"], { HOME: dir, PATH: bare(dir) });
		expect(none.code).toBe(1);
		expect(none.err).toContain("no node was found on PATH");

		writeFileSync(join(dir, "node.cmd"), "@echo v20.20.1\r\n");
		const refused = run(["help"], { HOME: dir, PATH: bare(dir) });
		expect(refused.code).toBe(1);
		expect(refused.err).toContain("mu needs Node.js 22.19 or newer, found 20.20.");
	});

	it("unlinks what it linked, and nothing else", () => {
		const dir = temp();
		const links = join(dir, "bin");
		// A link on POSIX; on Windows, where a link to a script cannot be run, a small mu.cmd.
		const linked = join(links, windows ? "mu.cmd" : "mu");
		expect(run(["link"], { HOME: dir, MU_LINK_DIR: links }).code).toBe(0);
		if (!windows) expect(lstatSync(linked).isSymbolicLink()).toBe(true);
		// Through the link, as a user would call it.
		expect(runScript(linked, ["help"], { HOME: dir }).out).toContain("mu link | unlink");
		expect(run(["unlink"], { HOME: dir, MU_LINK_DIR: links }).out).toContain("removed");
		expect(existsSync(linked)).toBe(false);
		writeFileSync(linked, "a file");
		expect(run(["unlink"], { HOME: dir, MU_LINK_DIR: links }).out).toContain(
			windows ? "is not a shim written by mu link; nothing removed" : "is not a link; nothing removed",
		);
	});

	it.runIf(windows)("reaches mu.cmd through the shim `mu link` writes, below a user name that is not ASCII", () => {
		// cmd reads a batch file in the console's code page: the shim names mu.cmd relative to itself, through %~dp0,
		// which cmd fills in itself.
		const dir = join(temp(), "白鹤");
		const bin = join(dir, "code", "mu", "kyrn", "bin");
		const links = join(dir, ".local", "bin");
		mkdirSync(bin, { recursive: true });
		mkdirSync(links, { recursive: true });
		writeFileSync(join(bin, "mu.cmd"), "@echo reached %*\r\n");
		const shim = shimContent({ linkDir: links, bin });
		expect(shim).toContain('"%~dp0..\\..\\code\\mu\\kyrn\\bin\\mu.cmd" %*');
		writeFileSync(join(links, "mu.cmd"), shim);

		const reached = runScript(join(links, "mu.cmd"), ["help"], { HOME: dir });

		expect(reached.code).toBe(0);
		expect(reached.out).toContain("reached help");
	});

	// Three starts of pi from its sources: on GitHub's Windows runners each took over ten seconds through tsx.
	it.skipIf(!installed)(
		"starts pi as a child too, the way Windows has to, and passes its exit code on",
		() => {
			const dir = temp();
			const child = run(["--version"], { HOME: dir, MU_LAUNCH: "spawn" });
			const replaced = run(["--version"], { HOME: dir });

			expect(child).toMatchObject({ code: 0, out: replaced.out });
			expect(child.out).toMatch(/^\d+\.\d+\.\d+/);
			// An exit code that is not zero comes through as well: a home without a login makes the doctor exit with 1.
			const doctor = run(["doctor"], { HOME: dir, MU_LAUNCH: "spawn" });
			expect(doctor.out).toContain("login");
			expect(doctor.code).toBe(1);
		},
		120_000,
	);
});
