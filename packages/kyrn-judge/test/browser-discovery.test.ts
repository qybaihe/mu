import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type BrowserHost,
	browserAdvice,
	browserCandidates,
	confinedProfileBase,
	findBrowser,
	findChrome,
	launchChrome,
	planBrowserLaunch,
	windowsSideProblem,
} from "../src/browser/chrome.ts";
import { hostName, isWsl, stopPlan, windowsToWslPath, wslMountRoot, wslToWindowsPath } from "../src/platform.ts";

/**
 * Not run on a real Windows or WSL machine: these tests prove which paths are looked at and which command
 * line would be started, given the platform, the environment and what exists. Whether Chrome then behaves
 * (a profile reached through \\wsl.localhost, a loopback shared by mirrored networking) is not proven here.
 */
function host(
	platform: NodeJS.Platform,
	installed: string[],
	extra: Partial<BrowserHost> & { mode?: string; distro?: string } = {},
): BrowserHost {
	const { mode, distro, ...rest } = extra;
	return {
		platform,
		env: {},
		home: platform === "win32" ? "C:\\Users\\bai" : "/home/bai",
		exists: (path) => installed.includes(path),
		wsl:
			mode === undefined && distro === undefined
				? undefined
				: { distro: distro ?? "Ubuntu", mountRoot: "/mnt/", networkingMode: () => mode },
		...rest,
	};
}

const WINDOWS_ENV = {
	ProgramFiles: "C:\\Program Files",
	"ProgramFiles(x86)": "C:\\Program Files (x86)",
	ProgramW6432: "C:\\Program Files",
	LOCALAPPDATA: "C:\\Users\\bai\\AppData\\Local",
};
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const WSL_EDGE = "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

describe("finding a browser on Windows", () => {
	it("looks under Program Files, Program Files (x86) and the user's own installs: Chrome, Chromium, Edge, Brave", () => {
		const paths = browserCandidates(host("win32", [], { env: WINDOWS_ENV })).map((candidate) => candidate.executable);
		expect(paths).toEqual([
			"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
			"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
			"C:\\Users\\bai\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
			"C:\\Program Files\\Chromium\\Application\\chrome.exe",
			"C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
			"C:\\Users\\bai\\AppData\\Local\\Chromium\\Application\\chrome.exe",
			"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
			EDGE,
			"C:\\Users\\bai\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
			"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
			"C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
			"C:\\Users\\bai\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		]);
	});

	it("takes Edge, which every Windows has, when there is no Chrome, however the variables are capitalised", () => {
		const env = {
			PROGRAMFILES: "C:\\Program Files",
			"PROGRAMFILES(X86)": "C:\\Program Files (x86)",
			localappdata: "C:\\L",
		};
		expect(findBrowser(host("win32", [EDGE], { env }))).toEqual({ executable: EDGE, side: "native" });
		expect(findChrome(env, host("win32", [EDGE], { env }))).toBe(EDGE);
		expect(findBrowser(host("win32", [], { env }))).toBeUndefined();
		expect(browserAdvice(host("win32", []))).toContain("set MU_CHROME to its .exe");
	});

	it("starts it with a Windows profile path and the usual flags", () => {
		const plan = planBrowserLaunch({
			host: host("win32", [EDGE]),
			browser: { executable: EDGE, side: "native" },
			profileDir: "C:\\Users\\bai\\.mu\\browser-profile",
			headless: true,
		});
		expect(plan.command).toBe(EDGE);
		expect(plan.args[0]).toBe("--user-data-dir=C:\\Users\\bai\\.mu\\browser-profile");
		expect(plan.args).toContain("--remote-debugging-port=0");
		expect(plan.args).toContain("--headless=new");
		// Never opened to the network: the port stays on the loopback, which is Chrome's default.
		expect(plan.args.join(" ")).not.toContain("remote-debugging-address");
	});
});

describe("finding a browser on Linux", () => {
	it("prefers a package to a snap to a flatpak, and looks along PATH too", () => {
		const paths = browserCandidates(host("linux", [], { env: { PATH: "/nix/profile/bin:/usr/bin" } })).map(
			(candidate) => candidate.executable,
		);
		expect(paths.indexOf("/usr/bin/google-chrome-stable")).toBe(0);
		expect(paths.indexOf("/usr/bin/microsoft-edge")).toBeGreaterThan(paths.indexOf("/usr/bin/chromium-browser"));
		expect(paths.indexOf("/snap/bin/chromium")).toBeGreaterThan(paths.indexOf("/usr/bin/brave-browser"));
		expect(paths).toContain("/nix/profile/bin/chromium");
		expect(paths).toContain("/var/lib/flatpak/exports/bin/com.google.Chrome");
		expect(paths).toContain("/home/bai/.local/share/flatpak/exports/bin/org.chromium.Chromium");
		expect(paths.indexOf("/var/lib/flatpak/exports/bin/com.google.Chrome")).toBeGreaterThan(
			paths.indexOf("/nix/profile/bin/chromium"),
		);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("lets MU_CHROME, or KYRN_CHROME as before, win over everything found", () => {
		const installed = ["/usr/bin/chromium", "/opt/my/chrome"];
		expect(findBrowser(host("linux", installed))?.executable).toBe("/usr/bin/chromium");
		expect(findBrowser(host("linux", installed, { env: { KYRN_CHROME: "/opt/my/chrome" } }))?.executable).toBe(
			"/opt/my/chrome",
		);
		// Named but not there: the search goes on.
		expect(findBrowser(host("linux", installed, { env: { MU_CHROME: "/nowhere" } }))?.executable).toBe(
			"/usr/bin/chromium",
		);
	});

	it("gives a confined browser a profile where it is allowed to write", () => {
		const linux = host("linux", ["/snap/bin/chromium"]);
		expect(confinedProfileBase("/snap/bin/chromium", linux)).toBe("/home/bai/snap/chromium/common");
		expect(confinedProfileBase("/usr/bin/chromium-browser", linux)).toBe("/home/bai/snap/chromium/common");
		expect(confinedProfileBase("/usr/bin/chromium-browser", host("linux", []))).toBeUndefined();
		expect(confinedProfileBase("/var/lib/flatpak/exports/bin/com.google.Chrome", linux)).toBe(
			"/home/bai/.var/app/com.google.Chrome/data",
		);
		expect(confinedProfileBase("/usr/bin/google-chrome", linux)).toBeUndefined();

		const plan = planBrowserLaunch({
			host: linux,
			browser: { executable: "/snap/bin/chromium", side: "native" },
			profileDir: "/home/bai/.mu/browser-profile",
			headless: false,
		});
		// A snap cannot see ~/.mu (hidden) nor the machine's /tmp.
		expect(plan.profileDir).toBe("/home/bai/snap/chromium/common/mu-browser-profile");
		expect(plan.args[0]).toBe("--user-data-dir=/home/bai/snap/chromium/common/mu-browser-profile");
		expect(plan.args).not.toContain("--headless=new");
	});

	it("says exactly how to install one when there is none", () => {
		const advice = browserAdvice(host("linux", []));
		expect(advice).toContain("google-chrome-stable_current_amd64.deb");
		expect(advice).toContain("sudo dnf install -y chromium");
		expect(browserAdvice(host("darwin", []))).toContain("/Applications");
	});
});

describe("finding a browser under WSL", () => {
	it("prefers a browser inside WSL, whatever the networking", () => {
		const both = ["/usr/bin/google-chrome", WSL_EDGE];
		expect(findBrowser(host("linux", both, { mode: "mirrored" }))).toEqual({
			executable: "/usr/bin/google-chrome",
			side: "native",
		});
		expect(findBrowser(host("linux", both, { mode: "nat" }))?.side).toBe("native");
		// Plain Linux never looks at /mnt/c.
		expect(browserCandidates(host("linux", [])).some((candidate) => candidate.side === "windows")).toBe(false);
	});

	it("uses the Windows browser only with mirrored networking, where Windows' loopback is WSL's too", () => {
		expect(findBrowser(host("linux", [WSL_EDGE], { mode: "mirrored" }))).toEqual({
			executable: WSL_EDGE,
			side: "windows",
		});
		expect(findBrowser(host("linux", [WSL_EDGE], { mode: "nat" }))).toBeUndefined();
		// An old WSL without wslinfo: not known to be safe, so not used.
		expect(findBrowser(host("linux", [WSL_EDGE], { distro: "Ubuntu" }))).toBeUndefined();
		expect(windowsSideProblem(host("linux", [], { mode: "nat" }))).toContain("WSL networking is nat");
		expect(windowsSideProblem(host("linux", [], { mode: "mirrored" }))).toBeUndefined();
	});

	it("starts the Windows browser with the profile in Windows' spelling and reads the port on the Linux side", () => {
		const plan = planBrowserLaunch({
			host: host("linux", [WSL_EDGE], { mode: "mirrored", distro: "Ubuntu-24.04" }),
			browser: { executable: WSL_EDGE, side: "windows" },
			profileDir: "/home/bai/.mu/browser-profile",
			headless: true,
		});
		expect(plan.command).toBe(WSL_EDGE);
		expect(plan.args[0]).toBe("--user-data-dir=\\\\wsl.localhost\\Ubuntu-24.04\\home\\bai\\.mu\\browser-profile");
		expect(plan.profileDir).toBe("/home/bai/.mu/browser-profile");
		expect(plan.cwd).toBe("/mnt/c/Program Files (x86)/Microsoft/Edge/Application");
		expect(plan.args.join(" ")).not.toContain("remote-debugging-address");

		// A profile kept on a Windows drive gets a plain drive path.
		const onDrive = planBrowserLaunch({
			host: host("linux", [WSL_EDGE], { mode: "mirrored" }),
			browser: { executable: WSL_EDGE, side: "windows" },
			profileDir: "/mnt/c/Users/bai/mu-profile",
			headless: true,
		});
		expect(onDrive.args[0]).toBe("--user-data-dir=C:\\Users\\bai\\mu-profile");
	});

	it("refuses the Windows browser under NAT, and says what to do instead of opening the port to the network", async () => {
		const nat = host("linux", [WSL_EDGE], { mode: "nat" });
		const advice = browserAdvice(nat);
		expect(advice).toContain(`${WSL_EDGE} is there, but WSL networking is nat`);
		expect(advice).toContain("google-chrome-stable_current_amd64.deb");
		expect(advice).toContain("networkingMode=mirrored");
		expect(advice).toContain("wsl --shutdown");
		expect(browserAdvice(host("linux", [], { mode: "nat" }))).toContain("none found on the Windows side");

		// Named by hand, it is still not started: nothing listens where WSL could reach it.
		await expect(launchChrome({ host: nat, executable: WSL_EDGE, profileDir: "/tmp/never-created" })).rejects.toThrow(
			/cannot be used: WSL networking is nat/,
		);
		await expect(launchChrome({ host: host("linux", [], { mode: "nat" }) })).rejects.toThrow(/No browser inside WSL/);
		// Each way of failing has a code, for the app to say it in the person's language.
		await expect(
			launchChrome({ host: nat, executable: WSL_EDGE, profileDir: "/tmp/never-created" }),
		).rejects.toMatchObject({ coded: { code: "windows_browser_unusable", params: { executable: WSL_EDGE } } });
		await expect(launchChrome({ host: host("linux", [], { mode: "nat" }) })).rejects.toMatchObject({
			coded: { code: "no_browser", params: { platform: "linux", wsl: 1 } },
		});
	});
});

describe("a browser that does not come up", () => {
	// A shell script stands in for Chrome: it never opens a DevTools port, and when it is ended it takes a moment to go.
	it.skipIf(process.platform === "win32")(
		"is ended and waited for before the timeout is reported, so the next start does not meet it in its profile",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "mu-chrome-port-"));
			try {
				const gone = join(dir, "gone");
				const browser = join(dir, "browser");
				writeFileSync(
					browser,
					`#!/bin/sh\ntrap 'sleep 0.3; echo gone > "${gone}"; exit 0' TERM\nwhile :; do sleep 0.1; done\n`,
					{ mode: 0o755 },
				);
				const failure = await launchChrome({
					executable: browser,
					profileDir: join(dir, "profile"),
					portWaitMs: 300,
				}).catch((error: unknown) => error);
				expect(failure).toMatchObject({ coded: { code: "devtools_port_timeout" } });
				expect(existsSync(gone)).toBe(true);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("telling the platforms apart, and their paths", () => {
	it("names the host", () => {
		expect(hostName({ platform: "darwin", env: {} })).toBe("macOS");
		expect(hostName({ platform: "win32", env: {} })).toBe("Windows");
		expect(hostName({ platform: "linux", env: {} })).toBe("Linux");
		expect(hostName({ platform: "linux", env: { WSL_DISTRO_NAME: "Debian" } })).toBe("WSL");
		expect(
			isWsl({ platform: "linux", env: {}, procVersion: "Linux version 5.15.153.1-microsoft-standard-WSL2" }),
		).toBe(true);
	});

	it("spells a WSL path the way Windows needs it, as wslpath -w would", () => {
		expect(wslToWindowsPath("/mnt/c/Users/bai/AppData/Local")).toBe("C:\\Users\\bai\\AppData\\Local");
		expect(wslToWindowsPath("/mnt/d")).toBe("D:\\");
		expect(wslToWindowsPath("/home/bai/.mu/browser-profile/", { distro: "Ubuntu" })).toBe(
			"\\\\wsl.localhost\\Ubuntu\\home\\bai\\.mu\\browser-profile",
		);
		// /mnt/wsl and friends are not drives.
		expect(wslToWindowsPath("/mnt/wsl/x", { distro: "Ubuntu" })).toBe("\\\\wsl.localhost\\Ubuntu\\mnt\\wsl\\x");
		expect(wslToWindowsPath("/home/bai")).toBeUndefined();
		expect(wslToWindowsPath("relative/path", { distro: "Ubuntu" })).toBeUndefined();
		expect(wslToWindowsPath("/c/Users/bai", { mountRoot: "/" })).toBe("C:\\Users\\bai");
	});

	it("and back, as wslpath -u would", () => {
		expect(windowsToWslPath("C:\\Users\\bai\\AppData")).toBe("/mnt/c/Users/bai/AppData");
		expect(windowsToWslPath("d:/work")).toBe("/mnt/d/work");
		expect(windowsToWslPath("C:\\")).toBe("/mnt/c");
		expect(windowsToWslPath("\\\\server\\share")).toBeUndefined();
		expect(windowsToWslPath("C:\\x", { mountRoot: "/" })).toBe("/c/x");
	});

	it("stops a subagent with a signal, and on Windows with its whole tree", () => {
		expect(stopPlan("darwin", 4242, false)).toEqual({ kind: "signal", signal: "SIGTERM" });
		expect(stopPlan("linux", 4242, true)).toEqual({ kind: "signal", signal: "SIGKILL" });
		expect(stopPlan("win32", 4242, false)).toEqual({
			kind: "command",
			command: "taskkill",
			args: ["/pid", "4242", "/T", "/F"],
		});
		// A child that never got a pid has no tree to take down.
		expect(stopPlan("win32", undefined, false)).toEqual({ kind: "signal", signal: "SIGTERM" });
	});

	it("reads where the drives are mounted from /etc/wsl.conf", () => {
		expect(wslMountRoot(undefined)).toBe("/mnt/");
		expect(wslMountRoot("[boot]\nsystemd=true\n")).toBe("/mnt/");
		expect(wslMountRoot("[automount]\nenabled = true\nroot = /\n")).toBe("/");
		expect(wslMountRoot("[network]\nroot = /nope\n[automount]\nroot=/windir")).toBe("/windir/");
	});
});
