import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { codedError } from "../language.ts";
import { muEnv, muHome } from "../naming.ts";
import { isWsl, thisHost, wslMountRoot, wslToWindowsPath } from "../platform.ts";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Everything the search for a browser depends on, passed in: there is no Windows machine and no WSL where mu
 * is developed, so what happens there is decided by functions that can be called with those facts on a Mac.
 */
export interface BrowserHost {
	readonly platform: NodeJS.Platform;
	readonly env: Env;
	readonly home: string;
	exists(path: string): boolean;
	/** Set under WSL only. */
	readonly wsl?: {
		readonly distro?: string;
		/** Where the Windows drives are mounted, `/mnt/` by default. */
		readonly mountRoot: string;
		/** What `wslinfo --networking-mode` says: "nat", "mirrored", ... Undefined when it cannot be asked. */
		networkingMode(): string | undefined;
	};
}

export interface FoundBrowser {
	readonly executable: string;
	/** "windows": a Windows program started from inside WSL, which is on the other side of WSL's network. */
	readonly side: "native" | "windows";
}

const MAC: readonly string[] = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

/** Packages first: a snap or a flatpak is confined and needs its profile elsewhere (`confinedProfileBase`). */
const LINUX: readonly string[] = [
	"/usr/bin/google-chrome-stable",
	"/usr/bin/google-chrome",
	"/opt/google/chrome/chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/microsoft-edge-stable",
	"/usr/bin/microsoft-edge",
	"/opt/microsoft/msedge/msedge",
	"/usr/bin/brave-browser",
	"/snap/bin/chromium",
	"/snap/bin/brave",
];
const LINUX_NAMES: readonly string[] = [
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
	"microsoft-edge-stable",
	"microsoft-edge",
	"brave-browser",
];
const FLATPAKS: readonly string[] = [
	"com.google.Chrome",
	"org.chromium.Chromium",
	"com.microsoft.Edge",
	"com.brave.Browser",
];

/** Below Program Files, Program Files (x86) and %LOCALAPPDATA% (an install for one user goes there). */
const WINDOWS: readonly (readonly string[])[] = [
	["Google", "Chrome", "Application", "chrome.exe"],
	["Chromium", "Application", "chrome.exe"],
	["Microsoft", "Edge", "Application", "msedge.exe"],
	["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
];

/** Windows does not care how a variable's name is capitalised; a copy of the environment does. */
function windowsVariable(env: Env, name: string): string | undefined {
	if (env[name]) return env[name];
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted && value) return value;
	return undefined;
}

/** Every place a browser is looked for on this host, best first. */
export function browserCandidates(host: BrowserHost): FoundBrowser[] {
	const native = (paths: readonly string[]): FoundBrowser[] =>
		paths.map((executable) => ({ executable, side: "native" as const }));
	if (host.platform === "darwin") return native(MAC);
	if (host.platform === "win32") {
		const bases = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA"]
			.map((name) => windowsVariable(host.env, name))
			.filter((base): base is string => Boolean(base));
		const unique = [...new Set(bases.map((base) => base.toLowerCase()))].map(
			(folded) => bases.find((base) => base.toLowerCase() === folded) as string,
		);
		return native(WINDOWS.flatMap((parts) => unique.map((base) => win32.join(base, ...parts))));
	}
	const onPath = (host.env.PATH ?? "")
		.split(":")
		.filter(Boolean)
		.flatMap((dir) => LINUX_NAMES.map((name) => posix.join(dir, name)));
	const flatpaks = ["/var/lib/flatpak", posix.join(host.home, ".local/share/flatpak")].flatMap((base) =>
		FLATPAKS.map((id) => posix.join(base, "exports/bin", id)),
	);
	const linux = native([...new Set([...LINUX, ...onPath, ...flatpaks])]);
	if (!host.wsl) return linux;
	// A browser inside WSL comes first: it shares Linux's loopback, and headless needs no display.
	const drive = `${host.wsl.mountRoot}c`;
	const windowsSide = WINDOWS.flatMap((parts) =>
		["Program Files", "Program Files (x86)"].map((base) => ({
			executable: posix.join(drive, base, ...parts),
			side: "windows" as const,
		})),
	);
	return [...linux, ...windowsSide];
}

function sideOf(executable: string, host: BrowserHost): FoundBrowser["side"] {
	return host.wsl && executable.startsWith(host.wsl.mountRoot) && /\.exe$/i.test(executable) ? "windows" : "native";
}

/**
 * The browser mu would start. MU_CHROME (or KYRN_CHROME) wins. From inside WSL a browser on the Windows side
 * only counts when it can be reached: see `windowsSideProblem`.
 */
export function findBrowser(host: BrowserHost): FoundBrowser | undefined {
	const chosen = muEnv("CHROME", host.env);
	if (chosen && host.exists(chosen)) return { executable: chosen, side: sideOf(chosen, host) };
	for (const candidate of browserCandidates(host)) {
		if (!host.exists(candidate.executable)) continue;
		if (candidate.side === "windows" && windowsSideProblem(host)) continue;
		return candidate;
	}
	return undefined;
}

/**
 * Why a Windows browser cannot be driven from this WSL, or undefined when it can.
 *
 * Chrome's debugging port listens on Windows' loopback and has no password. With mirrored networking WSL
 * reaches that loopback as 127.0.0.1 (IPv4 only), so nothing is opened to anyone. With NAT, the default, it
 * does not: Chrome would have to listen on an address the WSL network can reach, which the rest of the
 * network reaches as well, and current Chrome ignores --remote-debugging-address anyway. That is not done.
 */
export function windowsSideProblem(host: BrowserHost): string | undefined {
	const mode = host.wsl?.networkingMode();
	if (mode === "mirrored") return undefined;
	return `WSL networking is ${mode ?? "unknown (wslinfo --networking-mode did not answer)"}, and a browser on the Windows side can only be reached with mirrored networking`;
}

const LINUX_INSTALL = [
	"  Debian, Ubuntu (x64):  wget -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y /tmp/chrome.deb",
	"  Fedora:                sudo dnf install -y chromium",
	"  Arch:                  sudo pacman -S chromium",
].join("\n");

/** What to tell someone whose machine has no browser mu can use. */
export function browserAdvice(host: BrowserHost): string {
	if (host.platform === "darwin") {
		return "No Chrome, Chromium, Edge or Brave found in /Applications. Install one, or set MU_CHROME to a Chromium-based browser's executable.";
	}
	if (host.platform === "win32") {
		return "No Chrome, Chromium, Edge or Brave found under Program Files or %LOCALAPPDATA%. Install one, or set MU_CHROME to its .exe.";
	}
	if (!host.wsl) {
		return `No Chrome, Chromium, Edge or Brave found. Install one, or set MU_CHROME to its executable:\n${LINUX_INSTALL}`;
	}
	const windowsSide = browserCandidates(host).find(
		(candidate) => candidate.side === "windows" && host.exists(candidate.executable),
	);
	return [
		windowsSide
			? `No browser inside WSL. ${windowsSide.executable} is there, but ${windowsSideProblem(host) ?? "it was not chosen"}.`
			: "No browser inside WSL, and none found on the Windows side.",
		"Install one inside WSL (mu runs it headless, so no display is needed):",
		LINUX_INSTALL,
		"or, on Windows 11 22H2 and later, let WSL share Windows' loopback: put these two lines in %USERPROFILE%\\.wslconfig",
		"  [wsl2]",
		"  networkingMode=mirrored",
		"and restart WSL with: wsl --shutdown",
	].join("\n");
}

/**
 * Where a confined browser may keep a profile. A snap sees no hidden folder of the home (so not ~/.mu) and
 * has a /tmp of its own; a flatpak sees its own data folder. Undefined for an ordinary install.
 */
export function confinedProfileBase(executable: string, host: BrowserHost): string | undefined {
	if (host.platform !== "linux") return undefined;
	const snap = /^\/snap\/bin\/([^/]+)$/.exec(executable)?.[1];
	if (snap) return posix.join(host.home, "snap", snap, "common");
	// Ubuntu's chromium-browser package is a wrapper around the snap.
	if (executable === "/usr/bin/chromium-browser" && host.exists("/snap/bin/chromium")) {
		return posix.join(host.home, "snap/chromium/common");
	}
	const flatpak = /\/flatpak\/exports\/bin\/([^/]+)$/.exec(executable)?.[1];
	return flatpak ? posix.join(host.home, ".var/app", flatpak, "data") : undefined;
}

export interface BrowserLaunchPlan {
	readonly command: string;
	readonly args: string[];
	/** The profile folder as this process sees it: DevToolsActivePort is read here. */
	readonly profileDir: string;
	readonly cwd?: string;
}

/** The command line for one browser, or an error that says what to do instead. */
export function planBrowserLaunch(input: {
	host: BrowserHost;
	browser: FoundBrowser;
	profileDir: string;
	headless: boolean;
}): BrowserLaunchPlan {
	const { host, browser, headless } = input;
	let profileDir = input.profileDir;
	let spelled = profileDir;
	let cwd: string | undefined;
	if (browser.side === "windows") {
		const problem = windowsSideProblem(host);
		if (problem)
			throw codedError(`${browser.executable} cannot be used: ${problem}.\n${browserAdvice(host)}`, {
				code: "windows_browser_unusable",
				params: { executable: browser.executable },
			});
		// Chrome is a Windows program: it gets the folder in Windows' spelling (what `wslpath -w` would answer).
		const translated = wslToWindowsPath(profileDir, host.wsl);
		if (!translated)
			throw codedError(`The profile folder ${profileDir} has no Windows path (WSL_DISTRO_NAME isn't set).`, {
				code: "profile_no_windows_path",
				params: { profileDir },
			});
		spelled = translated;
		// A Windows program cannot start in a Linux folder.
		cwd = dirname(browser.executable);
	} else {
		const base = confinedProfileBase(browser.executable, host);
		if (base) profileDir = posix.join(base, `mu-${basename(profileDir)}`);
		spelled = profileDir;
	}
	const args = [
		`--user-data-dir=${spelled}`,
		"--remote-debugging-port=0",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--window-size=1120,780",
	];
	if (headless) args.push("--headless=new");
	return { command: browser.executable, args: [...args, "about:blank"], profileDir, cwd };
}

/** This machine. */
export function thisBrowserHost(env: Env = process.env): BrowserHost {
	let wsl: BrowserHost["wsl"];
	if (isWsl(thisHost(env))) {
		let conf: string | undefined;
		try {
			conf = readFileSync("/etc/wsl.conf", "utf8");
		} catch {}
		wsl = {
			distro: env.WSL_DISTRO_NAME,
			mountRoot: wslMountRoot(conf),
			networkingMode: () => {
				const asked = spawnSync("wslinfo", ["--networking-mode"], { encoding: "utf8", timeout: 3000 });
				return asked.status === 0 ? asked.stdout.trim().toLowerCase() || undefined : undefined;
			},
		};
	}
	return { platform: process.platform, env, home: homedir(), exists: existsSync, wsl };
}

export function findChrome(env: Env = process.env, host: BrowserHost = thisBrowserHost(env)): string | undefined {
	return findBrowser(host)?.executable;
}

export interface LaunchedChrome {
	/** WebSocket URL of the browser-level DevTools endpoint. */
	readonly endpoint: string;
	/** Undefined when an already running mu browser was reused. */
	readonly process?: ChildProcess;
	/** Where the profile really is: not where it was asked for when the browser is confined (snap, flatpak). */
	readonly profileDir: string;
}

function readEndpoint(profileDir: string): string | undefined {
	try {
		const [port, path] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split("\n");
		// 127.0.0.1 and not localhost: WSL's mirrored networking shares the IPv4 loopback only.
		return port && path ? `ws://127.0.0.1:${port}${path}` : undefined;
	} catch {
		return undefined;
	}
}

async function isAlive(endpoint: string): Promise<boolean> {
	const port = /:(\d+)\//.exec(endpoint)?.[1];
	if (!port) return false;
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
		return response.ok;
	} catch {
		return false;
	}
}

export interface LaunchOptions {
	readonly executable?: string;
	/** Default ~/.mu/browser-profile: mu's own profile, never the user's personal one. */
	readonly profileDir?: string;
	readonly headless?: boolean;
	/** The machine to look at. Tests pass one; everything else uses this machine. */
	readonly host?: BrowserHost;
	/** How long Chrome may take to open its DevTools port, in milliseconds: 15 s. Tests shorten it. */
	readonly portWaitMs?: number;
}

/** Resolves once `child` has exited, or after `ms` whatever it does. */
function exitOf(child: ChildProcess, ms: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/**
 * Starts Chrome with a dedicated profile and a DevTools port, or reuses the
 * one mu already started. The user's own Chrome profile, with its cookies
 * and logged-in sessions, is never touched.
 */
export async function launchChrome(options: LaunchOptions = {}): Promise<LaunchedChrome> {
	const host = options.host ?? thisBrowserHost();
	const browser = options.executable
		? { executable: options.executable, side: sideOf(options.executable, host) }
		: findBrowser(host);
	if (!browser)
		throw codedError(browserAdvice(host), {
			code: "no_browser",
			params: { platform: host.platform, wsl: host.wsl ? 1 : 0 },
		});
	const plan = planBrowserLaunch({
		host,
		browser,
		profileDir: options.profileDir ?? join(muHome(), "browser-profile"),
		headless: options.headless !== false,
	});
	const { profileDir } = plan;
	const running = readEndpoint(profileDir);
	if (running && (await isAlive(running))) return { endpoint: running, profileDir };

	mkdirSync(profileDir, { recursive: true });
	rmSync(join(profileDir, "DevToolsActivePort"), { force: true });
	const child = spawn(plan.command, plan.args, { stdio: "ignore", detached: false, cwd: plan.cwd });
	// A browser that cannot be started at all must end up as a message, not as an unhandled 'error' event.
	let failure: Error | undefined;
	child.on("error", (error) => {
		failure = error;
	});

	const deadline = Date.now() + (options.portWaitMs ?? 15_000);
	while (Date.now() < deadline) {
		const endpoint = readEndpoint(profileDir);
		if (endpoint && (await isAlive(endpoint))) return { endpoint, process: child, profileDir };
		if (failure)
			throw codedError(`${plan.command} could not be started: ${failure.message}`, {
				code: "browser_spawn_failed",
				params: { command: plan.command },
			});
		if (child.exitCode !== null)
			throw codedError(`Chrome exited during startup (code ${child.exitCode})`, {
				code: "browser_exited_on_start",
				params: { exitCode: child.exitCode },
			});
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	// Waited for, a while: a Chrome still on its way out holds its profile, so the next start in it (another try, the next
	// browsing step) would find the profile taken, and Windows would not even let its folder be removed.
	child.kill();
	await exitOf(child, 5_000);
	throw codedError("Chrome didn't open its DevTools port in time", { code: "devtools_port_timeout" });
}
