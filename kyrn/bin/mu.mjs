#!/usr/bin/env node
// mu command line: everything the launcher does, in plain Node so that it runs on macOS, Linux, WSL and Windows.
// (`mu help` prints the commands: see USAGE below.)
//
// Who starts this file:
// - kyrn/bin/mu      (bash) on macOS, Linux and WSL. It only finds a Node >= 22.19, from PATH or from nvm: a
//                    machine whose default Node is older cannot be trusted to run this file at all.
// - kyrn/bin/mu.cmd  on Windows, with whatever `node` is on PATH (mu.ps1 is the same for PowerShell).
// - npm's own `mu` command, in the npm package mu-agent (kyrn/npm/build.mjs). The package is laid out like the
//   repository, so this file is at kyrn/bin/mu.mjs there too, and the root is two folders up in both.
//
// No dependency and no TypeScript here: this runs before anything that could run TypeScript has been found.
//
// Every decision is an exported function that takes the platform, the environment and the file system as
// parameters and returns what would be done. There is no Windows machine where this is developed, so the
// Windows and WSL behaviour is proven by calling these functions with win32 and linux parameters
// (packages/kyrn-judge/test/launcher-platforms.test.ts); `main` only carries the plans out.
//
// What the launcher sets up:
// - mu's own home, ~/.mu/agent (auth, sessions, settings), apart from a stock pi in ~/.pi.
//   A machine that still has ~/.kyrn and no ~/.mu keeps using ~/.kyrn until that folder is moved (`mu migrate`).
// - mu's name on the agent: PI_PACKAGE_DIR points at ~/.mu/app, a view of packages/coding-agent whose
//   package.json carries piConfig {name: mu, configDir: .mu}. No upstream file is edited.
// - the judgment layer (packages/kyrn-judge), with judges from ~/.mu/agent/mu.json or MU_JUDGE
//   (e.g. "laya", "laya,luna", "laya,jev", "off"). When "laya" is among them the sidecar is started (macOS only).
//   kyrn.json and every KYRN_* variable are still read when the mu spelling is absent.
// - the repo-root .env (the Jev key), read as data and handed to the agent without ever being printed.
//   The npm package reads ~/.mu/.env instead: there is no repository around it.
import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	constants as fsConstants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, constants as osConstants } from "node:os";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** pi's minimum. */
export const MIN_NODE = [22, 19];

/** True when a Node version such as "24.16.0" or "v22.19.0" can run pi. */
export function nodeVersionOk(version) {
	const [major, minor] = String(version).replace(/^v/, "").split(".").map(Number);
	if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
	return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** `node:path` for the platform in question, so that win32 paths can be computed (and tested) on macOS. */
export function pathFor(platform) {
	return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** `MU_<name>`, or the `KYRN_<name>` spelling from before the rename when the new one is unset or empty. */
export function muEnv(name, env) {
	return env[`MU_${name}`] || env[`KYRN_${name}`] || undefined;
}

/**
 * ~/.mu, or ~/.kyrn on a machine whose home has not been moved yet. Nothing here ever creates ~/.mu beside
 * ~/.kyrn: two homes would mean two logins and two session lists.
 */
export function muHome({ home, platform, isDir }) {
	const path = pathFor(platform);
	const current = path.join(home, ".mu");
	return isDir(current) || !isDir(path.join(home, ".kyrn")) ? current : path.join(home, ".kyrn");
}

/** WSL is Linux to the launcher. It matters to the browser and to what `mu doctor` reports. */
export function detectWsl({ platform, env, procVersion }) {
	if (platform !== "linux") return false;
	return Boolean(env.WSL_DISTRO_NAME) || /microsoft/i.test(procVersion ?? "");
}

export function platformName({ platform, wsl }) {
	if (platform === "darwin") return "macOS";
	if (platform === "win32") return "Windows";
	if (platform === "linux") return wsl ? "WSL" : "Linux";
	return platform;
}

export function usage(platform) {
	const linkDir = platform === "win32" ? "%USERPROFILE%\\.local\\bin" : "~/.local/bin";
	return [
		"mu command line. (The project was called KYRN until 2026-09-21; the old spellings below still work.)",
		"",
		"  mu                       interactive session in the current directory",
		'  mu "prompt"              interactive, starting with this prompt',
		'  mu -p "prompt"           one-shot: print the answer and exit',
		"  mu -c | -r               continue the last session | pick one to resume",
		"  mu setup                 connect a model (an API key, or a service from a list) and choose the judge",
		"                           (mu setup --help: scripts, a key from stdin, the services it knows)",
		"  mu judge <cmd>           the local judge (Laya): setup | start | stop | status | run",
		"  mu ledger [n] [--json]   what the judge decided in the last n sessions",
		"  mu import --list | <file>...   bring Claude Code and Codex conversations into mu (mu import --help)",
		"  mu doctor                check the installation",
		"  mu auth <cmd>            subscription sign-in for the desktop app, as JSON lines:",
		"                           status | login <provider> | logout <provider>",
		`  mu link | unlink         put the \`mu\` command on your PATH (${linkDir}) | remove it`,
		"  mu migrate [--dry-run]   once: move the home from before the rename, ~/.kyrn, to ~/.mu",
		"  mu help | version",
		"",
		"Everything else goes to the agent unchanged: `mu --help` lists every flag,",
		"and `mu install|remove|update|list|config` manage pi packages.",
	].join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------------------------------------

/**
 * Reads KEY=VALUE lines. The file is data, not a script: nothing in it is executed or expanded, which is
 * what makes it work without a shell (the bash launcher used to source it).
 *
 * Understood: blank lines, `# comments`, an `export ` prefix, single quotes (literal), double quotes (with
 * \" \\ \$ \` and a value that continues over several lines), and ` # comment` after an unquoted value.
 * A line that is none of these is skipped and only its line NUMBER is reported: its text may be a secret.
 */
export function parseEnvFile(text) {
	const entries = [];
	const problems = [];
	const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) {
			problems.push(index + 1);
			continue;
		}
		const [, key, rest] = match;
		const quote = rest[0];
		if (quote !== '"' && quote !== "'") {
			entries.push([key, rest.replace(/\s+#.*$/, "").trim()]);
			continue;
		}
		// A quoted value ends at the matching quote, which may be some lines further down.
		let body = rest.slice(1);
		let end = closingQuote(body, quote);
		const startedAt = index;
		while (end < 0 && index + 1 < lines.length) {
			body += `\n${lines[++index]}`;
			end = closingQuote(body, quote);
		}
		if (end < 0) {
			// Never closed: only that line is given up, the lines after it are still read.
			problems.push(startedAt + 1);
			index = startedAt;
			continue;
		}
		const value = body.slice(0, end);
		entries.push([key, quote === '"' ? value.replace(/\\(["\\$`])/g, "$1") : value]);
	}
	return { entries, problems };
}

function closingQuote(text, quote) {
	for (let index = 0; index < text.length; index++) {
		if (quote === '"' && text[index] === "\\") index++;
		else if (text[index] === quote) return index;
	}
	return -1;
}

/**
 * What the file adds to the environment: only the variables that are not already there. The real environment
 * wins, also with an empty value (`AI_GATEWAY_API_KEY= mu` is how one run goes without the key).
 * Windows treats variable names without regard to case.
 */
export function envFileAdditions({ env, entries, platform }) {
	const fold = (name) => (platform === "win32" ? name.toUpperCase() : name);
	const taken = new Set(Object.keys(env).map(fold));
	const added = {};
	for (const [key, value] of entries) {
		if (taken.has(fold(key))) continue;
		taken.add(fold(key));
		added[key] = value;
	}
	return added;
}

// ---------------------------------------------------------------------------------------------------------
// The app view: <home>/app
// ---------------------------------------------------------------------------------------------------------

/**
 * <home>/app is packages/coding-agent seen through links, plus a package.json that names the app. It lives
 * outside the repository on purpose: a linked source tree inside it makes biome skip the real one.
 *
 * Symbolic links need a privilege on Windows (or Developer Mode). Directory junctions do not, so folders
 * become junctions there; a junction cannot point at a file, so the two files become copies.
 */
export function appViewPlan(platform) {
	const folder = platform === "win32" ? "junction" : "symlink";
	const file = platform === "win32" ? "copy" : "symlink";
	return [
		{ name: "src", kind: folder },
		{ name: "docs", kind: folder },
		{ name: "examples", kind: folder },
		{ name: "README.md", kind: file },
		{ name: "CHANGELOG.md", kind: file },
	];
}

/** Its package name stays pi's: pi updates itself by that name, and `mu` on npm is someone else's package. */
export function appPackageJson(upstreamText) {
	const pkg = JSON.parse(upstreamText);
	pkg.piConfig = { name: "mu", configDir: ".mu" };
	return `${JSON.stringify(pkg, null, "\t")}\n`;
}

const realFs = {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
};

function lstatOrUndefined(fs, target) {
	try {
		return fs.lstatSync(target);
	} catch {
		return undefined;
	}
}

/**
 * Brings the view up to date and returns what it did, one line per change. Only links and files are ever
 * replaced, with `unlink`: nothing here deletes recursively, because through a junction that would reach
 * the real source tree.
 */
export function ensureAppView({ platform, app, upstream, fs = realFs }) {
	const path = pathFor(platform);
	const same = (a, b) => {
		const [left, right] = [path.resolve(a), path.resolve(b)];
		return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
	};
	const done = [];
	fs.mkdirSync(app, { recursive: true });
	for (const { name, kind } of appViewPlan(platform)) {
		const source = path.join(upstream, name);
		const target = path.join(app, name);
		const stat = lstatOrUndefined(fs, target);
		if (kind === "copy") {
			if (!fs.existsSync(source)) continue;
			const stale =
				!stat ||
				!stat.isFile() ||
				stat.size !== fs.statSync(source).size ||
				stat.mtimeMs < fs.statSync(source).mtimeMs;
			if (!stale) continue;
			if (stat?.isDirectory()) continue;
			if (stat) fs.unlinkSync(target);
			fs.copyFileSync(source, target);
			done.push(`copy ${name}`);
			continue;
		}
		if (stat?.isSymbolicLink()) {
			let current;
			try {
				current = fs.readlinkSync(target);
			} catch {}
			if (current !== undefined && same(current, source)) continue;
		}
		// A real folder here was put there by hand. It is left alone rather than emptied.
		if (stat?.isDirectory()) continue;
		if (stat) fs.unlinkSync(target);
		if (kind === "junction") fs.symlinkSync(source, target, "junction");
		else fs.symlinkSync(source, target);
		done.push(`${kind} ${name}`);
	}
	// Rebuilt when upstream moved on, and when the view still names the app something else (a home from before the rename).
	const manifest = path.join(app, "package.json");
	const upstreamManifest = path.join(upstream, "package.json");
	const current = lstatOrUndefined(fs, manifest);
	const rebuild =
		!current ||
		fs.statSync(upstreamManifest).mtimeMs > current.mtimeMs ||
		!fs.readFileSync(manifest, "utf8").includes('"name": "mu"');
	if (rebuild) {
		fs.writeFileSync(manifest, appPackageJson(fs.readFileSync(upstreamManifest, "utf8")));
		done.push("package.json");
	}
	return done;
}

// ---------------------------------------------------------------------------------------------------------
// Starting pi
// ---------------------------------------------------------------------------------------------------------

/**
 * Where this mu comes from: "repo", a checkout that runs the TypeScript sources (sourceRuntime), or "package", the
 * npm package mu-agent, which carries pi's bundle (dist/bundle/cli.js) and the judgment layer built to
 * JavaScript (judge/dist/kyrn-judge.js). A checkout without its dependencies is still a checkout.
 */
export function layoutOf({ root, platform, exists }) {
	const path = pathFor(platform);
	if (exists(path.join(root, "packages", "coding-agent", "package.json"))) return "repo";
	return exists(path.join(root, "dist", "bundle", "cli.js")) ? "package" : "repo";
}

/**
 * The files the npm package runs: pi, the judgment layer, the sign-in of `mu auth`, the importer of `mu import` and the
 * wizard of `mu setup`.
 */
export function packageEntries({ root, platform }) {
	const path = pathFor(platform);
	return {
		cli: path.join(root, "dist", "bundle", "cli.js"),
		extension: path.join(root, "judge", "dist", "kyrn-judge.js"),
		auth: path.join(root, "judge", "dist", "auth.js"),
		import: path.join(root, "judge", "dist", "import.js"),
		setup: path.join(root, "judge", "dist", "setup.js"),
	};
}

/** The .env the launcher reads: the checkout's, or for the npm package the one in mu's home. */
export function envFilePath({ layout, root, muDir, platform }) {
	return pathFor(platform).join(layout === "package" ? muDir : root, ".env");
}

/**
 * The JavaScript file behind the `tsx` command. node_modules/.bin/tsx is a `.cmd` shim on Windows, and a shim
 * can only be started through a shell, where a prompt with quotes or `&` in it is re-parsed. Running the real
 * entry with the Node that runs this file avoids the shell on every platform.
 */
export function resolveTsx({ root, platform, exists, readFile }) {
	const path = pathFor(platform);
	// Looked for the way Node resolves an import: here, then in every parent. A git worktree of this repository
	// kept under the main checkout (as the agent worktrees are) has no node_modules of its own and runs on the
	// main checkout's, exactly as its imports do.
	for (let dir = root; ; dir = path.dirname(dir)) {
		const entry = tsxEntry(path.join(dir, "node_modules", "tsx"), path, exists, readFile);
		if (entry) return entry;
		if (path.dirname(dir) === dir) return undefined;
	}
}

function tsxEntry(dir, path, exists, readFile) {
	let bin;
	try {
		bin = JSON.parse(readFile(path.join(dir, "package.json"))).bin;
	} catch {
		return undefined;
	}
	const relative = typeof bin === "string" ? bin : bin?.tsx;
	if (typeof relative !== "string") return undefined;
	const entry = path.join(dir, ...relative.split("/").filter((part) => part && part !== "."));
	return exists(entry) ? entry : undefined;
}

export function installHint({ root, platform }) {
	const steps = [`cd ${root}`, "npm ci --ignore-scripts", "npm run hydrate:model-data"];
	// Windows PowerShell 5 has no `&&`.
	return platform === "win32"
		? `mu's dependencies are not installed. Run:\n${steps.map((step) => `  ${step}`).join("\n")}`
		: `mu's dependencies are not installed. Run:  ${steps.join(" && ")}`;
}

/**
 * Node's arguments for running a checkout's TypeScript, up to the entry file. A Node that strips types itself (on
 * by default from 22.18) runs the sources as they are, with pi's own source resolver
 * (packages/coding-agent/src/experimental/source-resolver.ts: each workspace package resolves to its sources, as
 * tsconfig.json's paths say) and Node's compile cache (compile-cache.mjs). tsx runs its loader on a thread of its
 * own and hands every file over from there: pi with the judgment layer took 2 s to start that way, about 0.85 s
 * this way, and a checkout starts mu for every conversation the desktop app opens. A runtime that does not strip
 * types (`stripsTypes` false; an Electron that runs mu as Node may not), or a checkout from before the resolver,
 * still goes through tsx. tsx is one of the checkout's dependencies either way: without it they are not installed.
 */
export function sourceRuntime({ root, platform, stripsTypes, exists, readFile }) {
	const path = pathFor(platform);
	const tsx = resolveTsx({ root, platform, exists, readFile });
	if (!tsx) return { error: installHint({ root, platform }) };
	const resolver = path.join(root, "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
	if (!stripsTypes || !exists(resolver)) return { args: [tsx, "--tsconfig", path.join(root, "tsconfig.json")] };
	// As URLs: `--import` reads a Windows path such as C:\... as a URL whose scheme is c:.
	const url = (file) => pathToFileURL(file, { windows: platform === "win32" }).href;
	return {
		args: [
			"--disable-warning=ExperimentalWarning",
			"--import",
			url(path.join(root, "kyrn", "bin", "compile-cache.mjs")),
			"--import",
			url(resolver),
		],
	};
}

/**
 * pi reads <APP NAME>_CODING_AGENT_DIR and nothing else, so with the app named mu that export decides the
 * home. The pi and KYRN spellings are exported too, for scripts that still read them.
 */
export function agentDirFor({ env, muDir, platform }) {
	return (
		muEnv("AGENT_DIR", env) || muEnv("CODING_AGENT_DIR", env) || pathFor(platform).join(muDir, "agent")
	);
}

/** Whether the configuration asks for the local judge. */
export function wantsLaya({ env, agentDir, platform, readFile }) {
	const judges = muEnv("JUDGE", env);
	if (judges) return `,${judges},`.includes(",laya");
	const path = pathFor(platform);
	for (const name of ["mu.json", "kyrn.json"]) {
		let text;
		try {
			text = readFile(path.join(agentDir, name));
		} catch {
			continue;
		}
		// Like the file itself: kyrn.json is only looked at when there is no mu.json.
		return text.includes('"laya');
	}
	return false;
}

/** The Core ML sidecar exists for macOS only. Anything else needs a server of its own behind MU_LOCAL_JUDGE_URL. */
export function localJudgeSupport({ platform, env, wsl = false }) {
	if (platform === "darwin") return { runs: true };
	const url = muEnv("LOCAL_JUDGE_URL", env);
	const where = platformName({ platform, wsl });
	return {
		runs: false,
		url,
		message: [
			`The local judge (Laya) is a Core ML sidecar: it runs on macOS with Apple Silicon only, not on ${where}.`,
			"mu works without it: use Jev (TYPESAFE_API_KEY or AI_GATEWAY_API_KEY) or an llm judge in mu.json;",
			"the desktop app's own local judge is being built. Decisions without a judge fall back to pi's behaviour.",
			"A server that speaks the same contract (GET /health, POST /evaluate) can be used from here:",
			"  MU_LOCAL_JUDGE_URL=http://host:port",
		].join("\n"),
	};
}

/** exec replaces this process, as the bash launcher did; spawn is what Windows has. MU_LAUNCH forces either. */
export function launchStrategy({ platform, env, canExec }) {
	const forced = muEnv("LAUNCH", env);
	if (platform === "win32" || !canExec || forced === "spawn") return "spawn";
	return "exec";
}

/**
 * Everything about starting pi, decided without touching anything: the command, its arguments as an array
 * (never a shell string) and the child's whole environment.
 *
 * `fs` is { exists, isDir, readFile }. Returns { error } when pi cannot be started.
 */
export function planLaunch({
	platform,
	env,
	argv,
	root,
	home,
	execPath,
	fs,
	canExec = false,
	wsl = false,
	stripsTypes = true,
}) {
	const path = pathFor(platform);
	const layout = layoutOf({ root, platform, exists: fs.exists });
	let entry;
	if (layout === "package") {
		const files = packageEntries({ root, platform });
		if (!fs.exists(files.extension)) {
			return { error: `This mu-agent package is incomplete (${files.extension} is missing). Reinstall it: npm i -g mu-agent` };
		}
		entry = [files.cli, "-e", files.extension];
	} else {
		const runtime = sourceRuntime({ root, platform, stripsTypes, exists: fs.exists, readFile: fs.readFile });
		if (runtime.error) return { error: runtime.error };
		entry = [
			...runtime.args,
			path.join(root, "packages", "coding-agent", "src", "experimental", "cli.ts"),
			"-e",
			path.join(root, "packages", "kyrn-judge", "src", "extension", "kyrn-judge.ts"),
		];
	}

	const muDir = muHome({ home, platform, isDir: fs.isDir });
	// The package names itself mu in its own package.json; a checkout needs the view at <home>/app for that.
	const appDir = layout === "package" ? root : muEnv("APP_DIR", env) || path.join(muDir, "app");
	const agentDir = agentDirFor({ env, muDir, platform });

	const notes = [];
	let fromFile = {};
	let envText;
	try {
		envText = fs.readFile(envFilePath({ layout, root, muDir, platform }));
	} catch {}
	if (envText !== undefined) {
		const parsed = parseEnvFile(envText);
		fromFile = envFileAdditions({ env, entries: parsed.entries, platform });
		// Line numbers only: the text of a line that did not parse may well be a secret.
		if (parsed.problems.length > 0) notes.push(`mu: .env: skipped line ${parsed.problems.join(", ")} (not KEY=VALUE)`);
	}

	const childEnv = {};
	for (const [key, value] of Object.entries({ ...fromFile, ...env })) {
		if (typeof value === "string") childEnv[key] = value;
	}
	childEnv.PI_PACKAGE_DIR = appDir;
	childEnv.MU_CODING_AGENT_DIR = agentDir;
	childEnv.KYRN_CODING_AGENT_DIR = agentDir;
	childEnv.PI_CODING_AGENT_DIR = agentDir;
	// pi's release check asks pi.dev about pi's versions, which say nothing about mu's: a checkout follows
	// upstream through git, and the package through npm.
	childEnv.PI_SKIP_VERSION_CHECK = childEnv.PI_SKIP_VERSION_CHECK || "1";
	// pi reports a fresh install to pi.dev with its version. mu-agent is not a pi install; asked for, it still can be.
	if (layout === "package" && childEnv.PI_TELEMETRY === undefined) childEnv.PI_TELEMETRY = "0";

	let startJudge = false;
	if (wantsLaya({ env: childEnv, agentDir, platform, readFile: fs.readFile })) {
		const support = localJudgeSupport({ platform, env: childEnv, wsl });
		if (support.runs) startJudge = true;
		else if (!support.url) {
			notes.push(
				`mu: the configuration asks for the local judge (laya), which runs on macOS only; on ${platformName({ platform, wsl })} its decisions fall back to the next judge or to pi's behaviour (mu judge status)`,
			);
		}
	}

	return {
		command: execPath,
		args: [...entry, ...argv],
		env: childEnv,
		strategy: launchStrategy({ platform, env, canExec }),
		layout,
		muDir,
		appDir,
		agentDir,
		startJudge,
		notes,
		preface: argv[0] === "-h" || argv[0] === "--help" ? `${usage(platform)}\n\nAgent flags:\n` : undefined,
	};
}

/**
 * Everything about running pi inside a process of another program, such as the desktop app's runtime host, decided
 * as planLaunch decides it and without touching anything: the module to import pi's `setupCli` and `main` from, the
 * Node flags that process starts with, pi's arguments (the judgment layer, then `argv`) and its whole environment.
 * The app's pi and the command line's are then one: the same files, settings, sign-ins and keys.
 *
 * A checkout runs in such a process only on a Node that strips TypeScript types itself, with pi's source resolver:
 * tsx cannot be put in front of a module another program imports. Returns { error } otherwise.
 */
export function planHost({ platform, env, argv, root, home, fs, wsl = false, stripsTypes = true }) {
	const path = pathFor(platform);
	const launch = planLaunch({ platform, env, argv, root, home, execPath: "", fs, wsl, stripsTypes });
	if (launch.error !== undefined) return { error: launch.error };
	const common = {
		env: launch.env,
		layout: launch.layout,
		muDir: launch.muDir,
		appDir: launch.appDir,
		agentDir: launch.agentDir,
		startJudge: launch.startJudge,
		notes: launch.notes,
	};
	if (launch.layout === "package") {
		return {
			...common,
			module: path.join(root, "dist", "bundle", "index.js"),
			execArgv: [],
			args: ["-e", packageEntries({ root, platform }).extension, ...argv],
		};
	}
	const resolver = path.join(root, "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
	if (!stripsTypes || !fs.exists(resolver)) {
		return {
			error: `pi's sources run inside another program only on a Node that strips TypeScript types itself (22.18 or newer), with pi's source resolver (${resolver})`,
		};
	}
	const runtime = sourceRuntime({ root, platform, stripsTypes, exists: fs.exists, readFile: fs.readFile });
	if (runtime.error) return { error: runtime.error };
	return {
		...common,
		module: path.join(root, "packages", "coding-agent", "src", "index.ts"),
		execArgv: runtime.args,
		args: ["-e", path.join(root, "packages", "kyrn-judge", "src", "extension", "kyrn-judge.ts"), ...argv],
	};
}

/** What mu says when the local judge does not come up. */
const LOCAL_JUDGE_NOT_STARTED =
	"mu: the local judge did not start (mu judge status); decisions fall back to pi's behaviour";

/** The part of the preparation that is files: the app view of a checkout, mu's agent folder, the configuration's notes. */
function prepareFiles({ plan, platform, root, err }) {
	const path = pathFor(platform);
	if (plan.layout === "repo") {
		ensureAppView({ platform, app: plan.appDir, upstream: path.join(root, "packages", "coding-agent") });
	}
	mkdirSync(plan.agentDir, { recursive: true });
	for (const note of plan.notes) err(note);
}

/**
 * What is done before pi starts, for the command line and the desktop app's runtime host alike: the app view that
 * names a checkout mu, mu's agent folder, the configuration's notes (to `err`), and the local judge when the
 * configuration asks for it. `bin` is this launcher's folder. The local judge is one shared sidecar: starting it is
 * idempotent and never blocks pi.
 */
export function prepareLaunch({ plan, platform, root, bin, err }) {
	prepareFiles({ plan, platform, root, err });
	if (plan.startJudge) {
		const started = spawnSync(pathFor(platform).join(bin, "kyrn-judge-local"), ["start"], {
			stdio: "ignore",
			env: plan.env,
		});
		if (started.status !== 0) err(LOCAL_JUDGE_NOT_STARTED);
	}
}

/**
 * prepareLaunch for a program that must not stop while the local judge starts, such as the desktop app's main process:
 * the same steps and notes, with the local judge started through a child process it waits for without blocking.
 */
export async function prepareLaunchAsync({ plan, platform, root, bin, err }) {
	prepareFiles({ plan, platform, root, err });
	if (!plan.startJudge) return;
	const status = await new Promise((resolve) => {
		const child = spawn(pathFor(platform).join(bin, "kyrn-judge-local"), ["start"], {
			stdio: "ignore",
			env: plan.env,
		});
		child.once("error", () => resolve(null));
		child.once("close", (code) => resolve(code));
	});
	if (status !== 0) err(LOCAL_JUDGE_NOT_STARTED);
}

// ---------------------------------------------------------------------------------------------------------
// mu auth
// ---------------------------------------------------------------------------------------------------------

/** What `mu auth` answers itself. Every other `auth` command (check, print-api-key, ...) is pi's own. */
export const AUTH_COMMANDS = ["status", "login", "logout"];

/**
 * `mu auth status | login <provider> | logout <provider>`: the sign-in the desktop app runs, with pi's own OAuth
 * flows and credential store (packages/kyrn-judge/src/auth). It is pi's code, so it runs the way pi does here:
 * from its sources in a checkout (sourceRuntime), built in the package. It reads no key, so no .env is read for it.
 */
export function planAuth({ platform, env, argv, root, home, execPath, fs, canExec = false, stripsTypes = true }) {
	const path = pathFor(platform);
	let entry;
	if (layoutOf({ root, platform, exists: fs.exists }) === "package") {
		const { auth } = packageEntries({ root, platform });
		if (!fs.exists(auth)) {
			return { error: `This mu-agent package is incomplete (${auth} is missing). Reinstall it: npm i -g mu-agent` };
		}
		entry = [auth];
	} else {
		const runtime = sourceRuntime({ root, platform, stripsTypes, exists: fs.exists, readFile: fs.readFile });
		if (runtime.error) return { error: runtime.error };
		entry = [...runtime.args, path.join(root, "packages", "kyrn-judge", "src", "auth", "main.ts")];
	}
	const agentDir = agentDirFor({ env, muDir: muHome({ home, platform, isDir: fs.isDir }), platform });
	const childEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") childEnv[key] = value;
	}
	childEnv.MU_AGENT_DIR = agentDir;
	const strategy = launchStrategy({ platform, env, canExec });
	return { command: execPath, args: [...entry, ...argv], env: childEnv, strategy, agentDir };
}

// ---------------------------------------------------------------------------------------------------------
// mu judge
// ---------------------------------------------------------------------------------------------------------

/** What `mu judge <cmd>` does here: the macOS script, a look at a server of one's own, or a plain explanation. */
export function planJudge({ platform, env, argv, bin, wsl = false }) {
	const args = argv.length > 0 ? argv : ["status"];
	const support = localJudgeSupport({ platform, env, wsl });
	if (support.runs) return { kind: "script", command: pathFor(platform).join(bin, "kyrn-judge-local"), args };
	if (args[0] === "status" && support.url) return { kind: "health", url: `${support.url.replace(/\/+$/, "")}/health` };
	return { kind: "unsupported", message: support.message };
}

// ---------------------------------------------------------------------------------------------------------
// mu import
// ---------------------------------------------------------------------------------------------------------

/**
 * `mu import`: Claude Code and Codex conversations into mu's sessions (packages/kyrn-judge/src/import). The importer
 * needs nothing but Node: the npm package runs its build, judge/dist/import.js, and a checkout its TypeScript with
 * Node's own type stripping (on by default from 22.18). A runtime that does not strip types (`stripsTypes` false;
 * an Electron that runs mu as Node may not) takes the sources through tsx, as pi runs in a checkout.
 */
export function planImport({ platform, env, argv, root, home, execPath, fs, stripsTypes = true }) {
	const path = pathFor(platform);
	let entry;
	if (layoutOf({ root, platform, exists: fs.exists }) === "package") {
		const built = packageEntries({ root, platform }).import;
		if (!fs.exists(built)) {
			return { error: `This mu-agent package has no mu import (${built} is missing). Update it: npm i -g mu-agent` };
		}
		entry = [built];
	} else {
		const source = path.join(root, "packages", "kyrn-judge", "src", "import", "cli.ts");
		if (!fs.exists(source)) return { error: `mu import is missing from this checkout (${source})` };
		if (stripsTypes) entry = ["--disable-warning=ExperimentalWarning", source];
		else {
			const tsx = resolveTsx({ root, platform, exists: fs.exists, readFile: fs.readFile });
			if (!tsx) return { error: installHint({ root, platform }) };
			entry = [tsx, "--tsconfig", path.join(root, "tsconfig.json"), source];
		}
	}
	const agentDir = agentDirFor({ env, muDir: muHome({ home, platform, isDir: fs.isDir }), platform });
	const childEnv = {};
	for (const [key, value] of Object.entries(env)) if (typeof value === "string") childEnv[key] = value;
	childEnv.MU_CODING_AGENT_DIR = agentDir;
	childEnv.KYRN_CODING_AGENT_DIR = agentDir;
	childEnv.PI_CODING_AGENT_DIR = agentDir;
	return { command: execPath, args: [...entry, ...argv], env: childEnv, agentDir };
}

// ---------------------------------------------------------------------------------------------------------
// mu setup
// ---------------------------------------------------------------------------------------------------------

/** What a "no" to the first-start question leaves in the agent folder (packages/kyrn-judge/src/setup/wizard.ts). */
export const SETUP_DECLINED_FILE = "setup-declined";

/** How `mu setup` says: set up, and start a session now. */
export const SETUP_EXIT_START = 3;

/** How `mu setup` says it was cancelled (ctrl+c): a first start then goes no further. */
export const SETUP_EXIT_CANCELLED = 130;

/** The options of `mu setup` that take a value (wizard.ts keeps the same list): the word after one is not a key. */
export const SETUP_VALUE_FLAGS = ["--service", "--model", "--base-url", "--api", "--name", "--judge"];

/**
 * The environment variables that give pi a model on their own: packages/ai/src/env-api-keys.ts, which a test holds this
 * list to, and AWS_BEARER_TOKEN_BEDROCK, which is there for nothing else. TYPESAFE_API_KEY is left out, as pi's
 * typesafe provider has classifiers only (the key is Jev's). So are AWS profiles and Google Cloud's default
 * credentials: many machines have them for other work.
 */
export const MODEL_KEY_VARIABLES = [
	"COPILOT_GITHUB_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"ANT_LING_API_KEY",
	"QWEN_TOKEN_PLAN_API_KEY",
	"QWEN_TOKEN_PLAN_CN_API_KEY",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"NVIDIA_API_KEY",
	"DEEPSEEK_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"RADIUS_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MOONSHOT_API_KEY",
	"HF_TOKEN",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"BASETEN_API_KEY",
	"OPENCODE_API_KEY",
	"KIMI_API_KEY",
	"META_API_KEY",
	"CLOUDFLARE_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
];

/**
 * `mu setup`: the wizard that connects a model and chooses the judge (packages/kyrn-judge/src/setup). It is pi's code,
 * so it runs the way `mu auth` runs: from the sources in a checkout, built in the package. A key on the command line
 * (`mu setup <key>`) goes to the wizard in the environment, MU_SETUP_KEY, never in its argv, which every process on
 * the machine can read. The launcher waits for the wizard, since a finished setup may go on into a session.
 */
export function planSetup({ platform, env, argv, root, home, execPath, fs, stripsTypes = true }) {
	const path = pathFor(platform);
	const layout = layoutOf({ root, platform, exists: fs.exists });
	let entry;
	if (layout === "package") {
		const { setup } = packageEntries({ root, platform });
		if (!fs.exists(setup)) {
			return { error: `This mu-agent package has no mu setup (${setup} is missing). Update it: npm i -g mu-agent` };
		}
		entry = [setup];
	} else {
		const runtime = sourceRuntime({ root, platform, stripsTypes, exists: fs.exists, readFile: fs.readFile });
		if (runtime.error) return { error: runtime.error };
		entry = [...runtime.args, path.join(root, "packages", "kyrn-judge", "src", "setup", "main.ts")];
	}
	const args = [];
	let key;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (SETUP_VALUE_FLAGS.includes(arg)) {
			args.push(arg);
			if (index + 1 < argv.length) args.push(argv[++index]);
		} else if (arg.startsWith("-") || arg === "help") args.push(arg);
		else if (key === undefined) key = arg;
		else return { error: "mu setup takes one key at most (mu setup --help)", code: 2 };
	}
	const muDir = muHome({ home, platform, isDir: fs.isDir });
	const agentDir = agentDirFor({ env, muDir, platform });
	const childEnv = {};
	for (const [name, value] of Object.entries(env)) if (typeof value === "string") childEnv[name] = value;
	if (key !== undefined) childEnv.MU_SETUP_KEY = key;
	childEnv.MU_AGENT_DIR = agentDir;
	childEnv.MU_CODING_AGENT_DIR = agentDir;
	childEnv.KYRN_CODING_AGENT_DIR = agentDir;
	childEnv.PI_CODING_AGENT_DIR = agentDir;
	childEnv.MU_SETUP_HOME = muDir;
	// The .env a session gets: the wizard writes the Jev key there, and reads a proxy from it.
	childEnv.MU_SETUP_ENV_FILE = envFilePath({ layout, root, muDir, platform });
	return { command: execPath, args: [...entry, ...args], env: childEnv, strategy: "spawn", agentDir, keyGiven: key !== undefined };
}

/** pi's own commands: none of them starts a session. */
const PI_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth"]);
/** Options for a run without a person (-p, --mode rpc), one that ends at once, or one that names its model itself. */
const NO_SETUP_FLAGS = new Set([
	"-p",
	"--print",
	"--mode",
	"-h",
	"--help",
	"-v",
	"--version",
	"--list-models",
	"--export",
	"--api-key",
	"--provider",
	"--model",
	"--models",
]);

/**
 * Whether `mu` offers to set up a model before a session: only to a person at a terminal (stdin and stdout) who starts
 * a session, on a machine where nothing gives mu a model yet, and who has not answered no before (SETUP_DECLINED_FILE)
 * or turned the question off (MU_NO_SETUP=1). Nothing gives a model: no credential in auth.json, no provider in
 * models.json, no default provider in settings.json, no key of MODEL_KEY_VARIABLES in the environment or the .env.
 * A file that cannot be read counts as set up: the question is for an empty home, never for a broken one.
 *
 * `fs` is { exists, readFile }; `envText` is the .env the launcher reads, when there is one.
 */
export function planFirstRun({ platform, env, argv, interactive, agentDir, envText, fs }) {
	if (!interactive) return false;
	const off = muEnv("NO_SETUP", env);
	if (off && off !== "0" && off.toLowerCase() !== "false") return false;
	if (argv[0] !== undefined && PI_COMMANDS.has(argv[0])) return false;
	if (argv.some((arg) => NO_SETUP_FLAGS.has(arg.split("=")[0]))) return false;
	const path = pathFor(platform);
	if (fs.exists(path.join(agentDir, SETUP_DECLINED_FILE))) return false;
	const read = (name) => {
		const file = path.join(agentDir, name);
		if (!fs.exists(file)) return {};
		try {
			const text = fs.readFile(file).replace(/^﻿/, "");
			const value = text.trim() ? JSON.parse(text) : {};
			return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
		} catch {
			return undefined;
		}
	};
	const auth = read("auth.json");
	if (!auth || Object.keys(auth).length > 0) return false;
	const models = read("models.json");
	const providers = models?.providers;
	if (!models || (providers && typeof providers === "object" && Object.keys(providers).length > 0)) return false;
	const settings = read("settings.json");
	if (!settings || settings.defaultProvider) return false;
	if (MODEL_KEY_VARIABLES.some((name) => env[name])) return false;
	if (envText !== undefined) {
		const { entries } = parseEnvFile(envText);
		if (entries.some(([name, value]) => value && MODEL_KEY_VARIABLES.includes(name))) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------------------------------------
// mu link | unlink
// ---------------------------------------------------------------------------------------------------------

export function linkPath({ platform, env, home }) {
	const path = pathFor(platform);
	const dir = muEnv("LINK_DIR", env) || path.join(home, ".local", "bin");
	return path.join(dir, platform === "win32" ? "mu.cmd" : "mu");
}

const SHIM_MARK = "rem mu-link-shim: written by `mu link`, removed by `mu unlink`.";

/**
 * The file `mu link` writes on Windows, where a link to a script cannot be run. It names mu.cmd relative to
 * itself when both are on one drive: cmd reads a batch file in the console's code page, so a path written
 * out in full breaks under a non-ASCII user name, while %~dp0 is filled in by cmd itself.
 */
export function shimContent({ linkDir, bin }) {
	const path = nodePath.win32;
	const target = path.join(bin, "mu.cmd");
	const relative = path.relative(linkDir, target);
	const named = path.isAbsolute(relative) ? target : `%~dp0${relative}`;
	return ["@echo off", SHIM_MARK, `"${named}" %*`, ""].join("\r\n");
}

/** The first `name` a shell would run. `isFile` answers for a path that exists, is a file and may be executed. */
export function findOnPath({ name, platform, env, isFile }) {
	const path = pathFor(platform);
	const raw = (platform === "win32" ? (env.PATH ?? env.Path ?? env.path) : env.PATH) ?? "";
	const extensions =
		platform === "win32"
			? (env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
			: [""];
	for (const dir of raw.split(path.delimiter)) {
		if (!dir) continue;
		for (const extension of extensions) {
			const candidate = path.join(dir, `${name}${extension.toLowerCase()}`);
			if (isFile(candidate)) return candidate;
		}
	}
	return undefined;
}

export function onPath({ dir, platform, env }) {
	const path = pathFor(platform);
	const raw = (platform === "win32" ? (env.PATH ?? env.Path ?? env.path) : env.PATH) ?? "";
	const fold = (value) => {
		const trimmed = value.length > 3 ? value.replace(/[\\/]+$/, "") : value;
		return platform === "win32" ? trimmed.toLowerCase() : trimmed;
	};
	return raw.split(path.delimiter).some((entry) => entry && fold(entry) === fold(dir));
}

/**
 * Homebrew's maildir-utils is also called `mu`. A command that is not this one is never replaced, and never
 * shadowed silently. `fs` is { realPath, exists, isFile, readFile }: realPath follows links the way a shell
 * does, also through a link whose target is gone.
 */
export function planLink({ platform, env, home, bin, argv, fs }) {
	const path = pathFor(platform);
	const link = linkPath({ platform, env, home });
	const linkDir = path.dirname(link);
	const windows = platform === "win32";
	const mine = path.join(bin, windows ? "mu.cmd" : "mu");
	const content = windows ? shimContent({ linkDir, bin }) : undefined;
	const same = (a, b) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
	const isThisMu = (candidate) => {
		if (same(fs.realPath(candidate), mine)) return true;
		if (!windows) return false;
		try {
			return fs.readFile(candidate) === content;
		} catch {
			return false;
		}
	};

	if (fs.exists(link) && !isThisMu(link)) {
		return {
			action: "refuse",
			errors: [
				`${link} already exists and is not this mu; it was left alone. Choose another folder: MU_LINK_DIR=<dir> mu link`,
			],
		};
	}
	const other = findOnPath({ name: "mu", platform, env, isFile: fs.isFile });
	if (other && !isThisMu(other) && argv[0] !== "--force") {
		return {
			action: "refuse",
			errors: [
				`Another mu is already on your PATH: ${other}`,
				"Nothing was linked. To put this one first anyway: mu link --force (or MU_LINK_DIR=<dir> mu link)",
			],
		};
	}
	const notes = [];
	if (!onPath({ dir: linkDir, platform, env })) {
		notes.push(`Note: ${linkDir} is not on your PATH yet.`);
		if (windows) {
			// The user's own PATH, never `setx PATH "%PATH%;..."`: that copies the machine's PATH into it and cuts it at 1024 characters.
			notes.push(
				"Add it for your user in PowerShell, then open a new terminal:",
				`  [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";${linkDir}", "User")`,
			);
		}
	}
	if (windows && /[^\x00-\x7f]/.test(content)) {
		notes.push(
			"Note: the path from that folder to this repository has non-ASCII characters in it, and cmd reads a batch file in the",
			"console's code page. If `mu` then cannot find its target, choose a folder on the same drive (MU_LINK_DIR), or put",
			`${bin} on your PATH instead.`,
		);
	}
	return { action: "link", link, target: mine, content, message: `mu -> ${mine}`, notes };
}

export function planUnlink({ platform, env, home, fs }) {
	const link = linkPath({ platform, env, home });
	if (platform === "win32") {
		let text;
		try {
			text = fs.readFile(link);
		} catch {}
		return text?.includes(SHIM_MARK)
			? { remove: link, message: `removed ${link}` }
			: { message: `${link} is not a shim written by mu link; nothing removed` };
	}
	return fs.isLink(link)
		? { remove: link, message: `removed ${link}` }
		: { message: `${link} is not a link; nothing removed` };
}

/** What `mu doctor` says about the command. */
export function linkState({ platform, link, bin, fs }) {
	if (platform === "win32") {
		try {
			return fs.readFile(link).includes(SHIM_MARK) ? `${link} -> ${pathFor(platform).join(bin, "mu.cmd")}` : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		return `${link} -> ${fs.readlink(link)}`;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------------------------------------
// mu migrate
// ---------------------------------------------------------------------------------------------------------

/** Minimal CSV, as `tasklist /FO CSV` and PowerShell's ConvertTo-Csv write it: quoted fields, "" for a quote. */
export function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false;
	const source = String(text).replace(/^\uFEFF/, "");
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (quoted) {
			if (char === '"' && source[index + 1] === '"') {
				field += '"';
				index++;
			} else if (char === '"') quoted = false;
			else field += char;
		} else if (char === '"') quoted = true;
		else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && source[index + 1] === "\n") index++;
			row.push(field);
			field = "";
			if (row.some((cell) => cell !== "")) rows.push(row);
			row = [];
		} else field += char;
	}
	row.push(field);
	if (row.some((cell) => cell !== "")) rows.push(row);
	return rows;
}

/** `tasklist /FO CSV /NH`: "Image Name","PID","Session Name","Session#","Mem Usage". */
export function parseTasklist(text) {
	return parseCsv(text)
		.map(([name, pid]) => ({ name: name ?? "", pid: Number(pid), command: "" }))
		.filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
}

/** `Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Csv -NoTypeInformation`. */
export function parseWindowsProcesses(text) {
	const [header, ...rows] = parseCsv(text);
	if (!header) return [];
	const column = (title) => header.findIndex((cell) => cell.toLowerCase() === title);
	const [pid, name, command] = [column("processid"), column("name"), column("commandline")];
	if (pid < 0) return [];
	return rows
		.map((row) => ({ pid: Number(row[pid]), name: row[name] ?? "", command: row[command] ?? "" }))
		.filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
}

const SESSION_MARK = "kyrn-judge/src/extension/kyrn-judge.ts";

/**
 * Who is still using the old home, from a process list ({ pid, name, command }). Windows paths are compared
 * with forward slashes and without regard to case.
 */
export function busyFromProcesses({ processes, old, platform, self }) {
	const fold = (value) => (platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value);
	const others = processes.filter((entry) => entry.pid !== self);
	const pids = (match) => others.filter(match).map((entry) => entry.pid);
	const profile = fold(pathFor(platform).join(old, "browser-profile"));
	return {
		sessions: pids((entry) => fold(entry.command).includes(SESSION_MARK)),
		browser: pids((entry) => fold(entry.command).includes(profile)),
		desktop: pids((entry) => /^aioncore(\.exe)?$/i.test(entry.name)),
	};
}

/**
 * Looks at what is running. POSIX asks pgrep, exactly as the bash launcher did. Windows has no pgrep:
 * tasklist gives the names and one PowerShell call gives the command lines. `run(command, args)` returns
 * stdout, or undefined when the command could not be run.
 */
export function findBusy({ platform, old, run, self }) {
	if (platform !== "win32") {
		const pgrep = (args) =>
			(run("pgrep", args) ?? "")
				.split(/\s+/)
				.filter(Boolean)
				.map(Number)
				.filter((pid) => pid !== self);
		return {
			sessions: pgrep(["-f", SESSION_MARK]),
			browser: pgrep(["-f", pathFor(platform).join(old, "browser-profile")]),
			desktop: pgrep(["-x", "aioncore"]),
		};
	}
	const names = run("tasklist", ["/FO", "CSV", "/NH"]);
	const commands = run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Csv -NoTypeInformation",
	]);
	// Without a process list nothing can be ruled out, and then nothing is moved.
	if (names === undefined || commands === undefined) return undefined;
	return busyFromProcesses({
		processes: [...parseTasklist(names), ...parseWindowsProcesses(commands)],
		old,
		platform,
		self,
	});
}

/**
 * ~/.kyrn becomes ~/.mu: one rename of the whole folder, so nothing inside is opened, copied or rewritten,
 * and the login files keep their permissions. The old path stays behind as a link (a junction on Windows),
 * because the desktop app's session mappings store absolute paths into it.
 *
 * `fs` is { isLink, isDir, exists, readlink, readFile, rename, link(target, at, kind) }. Returns the exit code.
 */
export function migrate({ platform, home, argv, fs, run, alive, self, out, err }) {
	const path = pathFor(platform);
	const old = path.join(home, ".kyrn");
	const next = path.join(home, ".mu");
	const dry = argv[0] === "--dry-run";
	if (fs.isLink(old)) {
		out(`Already moved: ${old} is a link to ${fs.readlink(old)}.`);
		return 0;
	}
	if (!fs.isDir(old)) {
		out(`Nothing to move: there is no ${old}.`);
		return 0;
	}
	if (fs.exists(next) || fs.isLink(next)) {
		err(`${next} already exists, so nothing was moved. Two homes are never merged or overwritten here:`);
		err("look at both folders and decide which one is the real one.");
		return 1;
	}
	// Whatever is running would write into the gap between the rename and the link, and split the home in two.
	const busy = [];
	let pid = 0;
	try {
		pid = Number.parseInt(fs.readFile(path.join(old, "local-judge", "judge.pid")).trim(), 10);
	} catch {}
	if (pid > 0 && alive(pid)) busy.push(`  the local judge (pid ${pid}). Stop it: mu judge stop`);
	const found = findBusy({ platform, old, run, self });
	if (!found) {
		err("Nothing was moved: the list of running processes could not be read (tasklist, powershell), so it is not known whether mu is still running.");
		return 1;
	}
	const list = (pids) => pids.join(" ");
	if (found.sessions.length > 0) {
		busy.push(`  mu sessions, in a terminal or behind the desktop app (pid ${list(found.sessions)}). Close them.`);
	}
	if (found.browser.length > 0) busy.push(`  the mu browser (pid ${list(found.browser)}). Close it.`);
	if (found.desktop.length > 0) {
		busy.push(`  the desktop app's backend (pid ${list(found.desktop)}). Quit the desktop app.`);
	}
	if (busy.length > 0) {
		err(`Nothing was moved, because these are still using ${old}:`);
		for (const line of busy) err(line);
		return 1;
	}
	const config = path.join("agent", "kyrn.json");
	const renameConfig = fs.exists(path.join(old, config)) && !fs.exists(path.join(old, "agent", "mu.json"));
	if (dry) {
		out(`Would move   ${old} -> ${next}`);
		if (renameConfig) out(`Would rename ${path.join(next, config)} -> mu.json`);
		out(`Would link   ${old} -> ${next}`);
		out("Nothing was changed.");
		return 0;
	}
	fs.rename(old, next);
	// A junction needs no privilege on Windows; elsewhere the kind of link is ignored.
	fs.link(next, old, platform === "win32" ? "junction" : "dir");
	out(`moved    ${old} -> ${next}`);
	if (renameConfig) {
		fs.rename(path.join(next, config), path.join(next, "agent", "mu.json"));
		out(`renamed  ${path.join(next, config)} -> mu.json`);
	}
	out(`linked   ${old} -> ${next} (paths stored from before the rename keep working)`);
	out("Check it: mu doctor");
	return 0;
}

// ---------------------------------------------------------------------------------------------------------
// Carrying the plans out
// ---------------------------------------------------------------------------------------------------------

function isDir(target) {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function isLink(target) {
	try {
		return lstatSync(target).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Where a path really is, through any chain of links, also when the last target is gone. */
function realPath(target) {
	let current = target;
	for (let hops = 0; hops < 40 && isLink(current); hops++) {
		const dir = nodePath.dirname(current);
		let physical = dir;
		try {
			physical = realpathSync(dir);
		} catch {}
		current = nodePath.resolve(physical, readlinkSync(current));
	}
	try {
		return nodePath.join(realpathSync(nodePath.dirname(current)), nodePath.basename(current));
	} catch {
		return current;
	}
}

function isRunnableFile(target) {
	try {
		if (!statSync(target).isFile()) return false;
		if (process.platform !== "win32") accessSync(target, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Synchronous on purpose: whatever is printed must be out before the agent, which shares the descriptor, writes. */
function write(fd, text) {
	try {
		writeSync(fd, `${text}\n`);
	} catch {
		(fd === 2 ? console.error : console.log)(text);
	}
}
const out = (text) => write(1, text);
const err = (text) => write(2, text);

/** Runs a command to its end and gives back its exit code, replacing this process where that is possible. */
function handOver({ command, args, env, strategy }) {
	if (strategy === "exec") {
		try {
			process.execve(command, [command, ...args], env);
		} catch {
			// Not available after all (a permission model, an exotic platform): start it as a child instead.
		}
	}
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "inherit", env });
		// A terminal delivers ctrl+c to the child by itself. On Windows `kill` cannot deliver a signal, it only
		// ends the process, so there this process just stays alive until the child has dealt with it.
		const relay = (signal) => {
			if (process.platform !== "win32") child.kill(signal);
		};
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => relay(signal));
		if (process.platform === "win32") process.on("SIGBREAK", () => {});
		child.on("error", (error) => {
			err(`mu: could not start ${command}: ${error.message}`);
			resolve(1);
		});
		child.on("exit", (code, signal) => resolve(code ?? 128 + (osConstants.signals[signal] ?? 0)));
	});
}

export async function main(argv = process.argv.slice(2)) {
	const platform = process.platform;
	const env = process.env;
	const home = homedir();
	const path = pathFor(platform);
	const bin = realpathSync(nodePath.dirname(fileURLToPath(import.meta.url)));
	const root = path.resolve(bin, "..", "..");
	const canExec = typeof process.execve === "function";
	const strategy = launchStrategy({ platform, env, canExec });
	const readText = (target) => readFileSync(target, "utf8");
	let procVersion = "";
	try {
		if (platform === "linux") procVersion = readText("/proc/version");
	} catch {}
	const wsl = detectWsl({ platform, env, procVersion });
	const layout = layoutOf({ root, platform, exists: existsSync });

	if (!nodeVersionOk(process.versions.node)) {
		err(`mu needs Node >= ${MIN_NODE.join(".")} (found ${process.version}). Try: nvm install 24`);
		return 1;
	}

	const [command, ...rest] = argv;
	if (command === "help") {
		out(usage(platform));
		return 0;
	}
	if (command === "auth" && AUTH_COMMANDS.includes(rest[0])) {
		const plan = planAuth({
			platform,
			env,
			argv: rest,
			root,
			home,
			execPath: process.execPath,
			canExec,
			stripsTypes: Boolean(process.features.typescript),
			fs: { exists: existsSync, isDir, readFile: readText },
		});
		if (plan.error) {
			// The one reader is the desktop app, which reads stdout line by line.
			out(JSON.stringify({ type: "error", message: plan.error }));
			return 1;
		}
		// A fresh home has no agent folder yet, and the credential store is written into it.
		mkdirSync(plan.agentDir, { recursive: true });
		return handOver(plan);
	}
	if (command === "migrate") {
		return migrate({
			platform,
			home,
			argv: rest,
			self: process.pid,
			out,
			err,
			alive: (pid) => {
				try {
					return process.kill(pid, 0);
				} catch {
					return false;
				}
			},
			run: (file, args) => {
				const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true });
				return result.error ? undefined : result.stdout;
			},
			fs: {
				isLink,
				isDir,
				exists: existsSync,
				readlink: readlinkSync,
				readFile: readText,
				rename: renameSync,
				link: (target, at, kind) => symlinkSync(target, at, kind),
			},
		});
	}
	if (command === "judge") {
		const plan = planJudge({ platform, env, argv: rest, bin, wsl });
		if (plan.kind === "script") return handOver({ command: plan.command, args: plan.args, env, strategy });
		if (plan.kind === "unsupported") {
			err(plan.message);
			return 1;
		}
		try {
			const response = await fetch(plan.url, { signal: AbortSignal.timeout(2000) });
			out(await response.text());
			return 0;
		} catch {
			out(`the judge server does not answer at ${plan.url}`);
			return 1;
		}
	}
	if (command === "ledger") {
		return handOver({ command: process.execPath, args: [path.join(bin, "kyrn-ledger"), ...rest], env, strategy });
	}
	if (command === "import") {
		const plan = planImport({
			platform,
			env,
			argv: rest,
			root,
			home,
			execPath: process.execPath,
			stripsTypes: Boolean(process.features.typescript),
			fs: { exists: existsSync, isDir, readFile: readText },
		});
		if (plan.error) {
			err(plan.error);
			return 1;
		}
		return handOver({ command: plan.command, args: plan.args, env: plan.env, strategy });
	}
	// What the session gets, when there is one: after a `mu setup` that ends in "start mu now", a plain session.
	let sessionArgv = argv;
	if (command === "setup") {
		const plan = planSetup({
			platform,
			env,
			argv: rest,
			root,
			home,
			execPath: process.execPath,
			stripsTypes: Boolean(process.features.typescript),
			fs: { exists: existsSync, isDir, readFile: readText },
		});
		if (plan.error) {
			err(plan.error);
			return plan.code ?? 1;
		}
		// The key leaves this process's own command line too, as far as the platform lets a process rewrite it.
		if (plan.keyGiven) process.title = "mu setup";
		mkdirSync(plan.agentDir, { recursive: true });
		const code = await handOver(plan);
		if (code !== SETUP_EXIT_START) return code;
		sessionArgv = [];
	}
	if (command === "doctor") {
		const link = linkPath({ platform, env, home });
		return handOver({
			command: process.execPath,
			args: [path.join(bin, "kyrn-doctor"), root, link, ...rest],
			env,
			strategy,
		});
	}
	if ((command === "link" || command === "unlink") && layout === "package") {
		out("This mu was installed with npm, which already put `mu` on your PATH (npm i -g mu-agent); nothing to link.");
		return 0;
	}
	if (command === "link") {
		const plan = planLink({
			platform,
			env,
			home,
			bin,
			argv: rest,
			fs: { realPath, exists: (target) => existsSync(target) || isLink(target), isFile: isRunnableFile, readFile: readText },
		});
		if (plan.action === "refuse") {
			for (const line of plan.errors) err(line);
			return 1;
		}
		mkdirSync(path.dirname(plan.link), { recursive: true });
		if (platform === "win32") writeFileSync(plan.link, plan.content);
		else {
			if (isLink(plan.link)) unlinkSync(plan.link);
			symlinkSync(plan.target, plan.link);
		}
		out(plan.message);
		for (const line of plan.notes) err(line);
		return 0;
	}
	if (command === "unlink") {
		const plan = planUnlink({ platform, env, home, fs: { isLink, readFile: readText } });
		if (plan.remove) unlinkSync(plan.remove);
		out(plan.message);
		return 0;
	}

	if (layout === "package" && command === "version") {
		const pkg = JSON.parse(readText(path.join(root, "package.json")));
		out(`mu ${pkg.version} (pi ${pkg.muBuild?.pi ?? "?"}, npm package ${pkg.name})`);
		return 0;
	}
	// Asked before `version` too, as it always was: a checkout without its dependencies says so at the first command.
	if (layout === "repo" && !resolveTsx({ root, platform, exists: existsSync, readFile: readText })) {
		err(installHint({ root, platform }));
		return 1;
	}
	if (command === "version") {
		// mu's version is the one this tree is released as; the judgment layer's own package.json is never released.
		const version = (file) => JSON.parse(readText(path.join(root, ...file.split("/")))).version;
		out(`mu ${version("kyrn/npm/package.template.json")} (pi ${version("packages/coding-agent/package.json")})`);
		return 0;
	}

	// A first start with nothing to work with: one question, and the wizard, before the session (`mu setup`). Never
	// right after `mu setup` itself: its subscription route leaves nothing written, and the person was just asked.
	const muDir = muHome({ home, platform, isDir });
	let envText;
	try {
		envText = readText(envFilePath({ layout, root, muDir, platform }));
	} catch {}
	const firstRun = command !== "setup" && planFirstRun({
		platform,
		env,
		argv: sessionArgv,
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		agentDir: agentDirFor({ env, muDir, platform }),
		envText,
		fs: { exists: existsSync, readFile: readText },
	});
	if (firstRun) {
		const setup = planSetup({
			platform,
			env,
			argv: ["--first-run"],
			root,
			home,
			execPath: process.execPath,
			stripsTypes: Boolean(process.features.typescript),
			fs: { exists: existsSync, isDir, readFile: readText },
		});
		if (!setup.error) {
			mkdirSync(setup.agentDir, { recursive: true });
			// Whatever the wizard ends with, the session follows (pi says itself when there is no model), unless it was cancelled.
			if ((await handOver(setup)) === SETUP_EXIT_CANCELLED) return SETUP_EXIT_CANCELLED;
		}
	}

	// Planned after the wizard: what it wrote into the .env (the Jev key) goes to the session too.
	const plan = planLaunch({
		platform,
		env,
		argv: sessionArgv,
		root,
		home,
		execPath: process.execPath,
		canExec,
		wsl,
		stripsTypes: Boolean(process.features.typescript),
		fs: { exists: existsSync, isDir, readFile: readText },
	});
	if (plan.error) {
		err(plan.error);
		return 1;
	}

	prepareLaunch({ plan, platform, root, bin, err });
	if (plan.preface) out(plan.preface);
	return handOver(plan);
}

function isMain() {
	if (!process.argv[1]) return false;
	try {
		const [invoked, self] = [realpathSync(process.argv[1]), fileURLToPath(import.meta.url)];
		return process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
	} catch {
		return false;
	}
}

if (isMain()) {
	main().then(
		// Everything was written synchronously, so nothing is cut off; an idle keep-alive socket must not hold the exit up.
		(code) => process.exit(code),
		(error) => {
			err(`mu: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		},
	);
}
