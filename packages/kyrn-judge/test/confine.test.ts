import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import {
	bwrapArgs,
	CACHE_FOLDERS,
	confinedCommand,
	confinement,
	type Floor,
	floorFor,
	prepareFloor,
	refusalNote,
	refusedWrites,
	seatbeltProfile,
	shellQuote,
} from "../src/confine/floor.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

const dirs: string[] = [];
const folder = (name: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `mu-floor-${name}-`)));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Runs a command under the floor as the confined bash tool does: in a shell that gives its process to the runner. */
const runConfined = (floor: Floor, command: string) => {
	const how = confinement(floor);
	if (!how) throw new Error("no floor on this platform");
	return spawnSync("/bin/bash", ["-c", confinedCommand(how, "/bin/bash", ["-c"], command)], {
		cwd: floor.project,
		encoding: "utf8",
	});
};

describe("the write floor", () => {
	it("covers the project, the temporary folders and the caches that exist, never the home folder or ~/.mu", () => {
		const home = folder("home");
		const project = join(home, "work", "app");
		mkdirSync(join(project, ".git"), { recursive: true });
		mkdirSync(join(home, ".npm"));
		mkdirSync(join(home, ".mu"));
		const tmp = folder("tmp");
		const floor = floorFor(project, {
			home,
			tmp: [tmp],
			extra: [home, join(home, ".mu", "agent"), join(home, "data")],
		});
		expect(floor).toEqual({
			project,
			// ~/data does not exist; the home folder and ~/.mu are never added, whoever asks.
			writable: [project, tmp, join(home, ".npm")],
			readOnly: [join(project, ".git", "hooks"), join(project, ".git", "config")],
		});
		expect(CACHE_FOLDERS).toContain("Library/Caches");
	});

	it("is no floor for a project that holds the home folder", () => {
		const home = folder("home");
		expect(floorFor(home, { home, tmp: [] })).toEqual({ problem: expect.stringContaining("holds the home folder") });
		expect(floorFor("/", { home, tmp: [] })).toEqual({ problem: expect.stringContaining("holds the home folder") });
		expect(floorFor(join(home, "missing"), { home, tmp: [] })).toEqual({
			problem: expect.stringContaining("does not exist"),
		});
	});

	it("writes a Seatbelt profile that denies writing, allows the floor's folders, and denies the read-only parts last", () => {
		const floor: Floor = {
			project: '/work/my "app"',
			writable: ['/work/my "app"', "/private/tmp"],
			readOnly: ['/work/my "app"/.git/hooks', '/work/my "app"/.git/config'],
		};
		const profile = seatbeltProfile(floor);
		expect(profile.indexOf("(deny file-write*)")).toBeLessThan(profile.indexOf("(allow file-write*"));
		expect(profile).toContain('(subpath "/work/my \\"app\\"")');
		expect(profile).toContain('(subpath "/private/tmp")');
		expect(profile.lastIndexOf("(deny file-write*")).toBeGreaterThan(profile.indexOf('(subpath "/private/tmp")'));
		expect(profile).toContain('(subpath "/work/my \\"app\\"/.git/config")');
	});

	it("gives bubblewrap the system read-only, the floor writable, and a process namespace of its own", () => {
		const args = bwrapArgs({ project: "/w", writable: ["/w", "/tmp"], readOnly: ["/w/.git/hooks"] });
		expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
		expect(args.join(" ")).toContain("--bind /w /w --bind /tmp /tmp --ro-bind-try /w/.git/hooks /w/.git/hooks");
		expect(args).toContain("--unshare-pid");
		expect(confinement({ project: "/w", writable: ["/w"], readOnly: [] }, "linux")?.args.at(-1)).toBe("--");
		expect(confinement({ project: "/w", writable: ["/w"], readOnly: [] }, "win32")).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")(
		"quotes the command whole, so the shell inside reads it as it was written",
		() => {
			expect(shellQuote("it's")).toBe(`'it'\\''s'`);
			const line = confinedCommand(
				{ runner: "/usr/bin/env", args: [] },
				"/bin/bash",
				["-c"],
				`printf '%s\\n' "a b" "it's" $'tab\\there'`,
			);
			expect(spawnSync("/bin/bash", ["-c", line], { encoding: "utf8" }).stdout).toBe("a b\nit's\ntab\there\n");
		},
	);

	// POSIX paths: there is no write sandbox on Windows.
	it.skipIf(process.platform === "win32")("finds the writes it refused in a command's output, as macOS and Linux tools word them", () => {
		const floor: Floor = {
			project: "/w/app",
			writable: ["/w/app", "/tmp-real"],
			readOnly: ["/w/app/.git/hooks", "/w/app/.git/config"],
		};
		// As measured under Seatbelt (bash, touch, node, python, git) and as bubblewrap's read-only binds give them.
		const output = [
			"/bin/bash: /home/u/.zshrc: Operation not permitted",
			"touch: /home/u/a.txt: Operation not permitted",
			"Error: EPERM: operation not permitted, open '/home/u/d.txt'",
			"PermissionError: [Errno 1] Operation not permitted: '/home/u/e.txt'",
			"error: could not write config file .git/config: Operation not permitted",
			"touch: cannot touch '/home/u/f.txt': Read-only file system",
			"OSError: [Errno 30] Read-only file system: '/home/u/g.txt'",
			// Inside the floor: something else refused it.
			"chmod: /w/app/locked: Operation not permitted",
			// No refusal on the line.
			"wrote /home/u/h.txt",
		].join("\n");
		expect(refusedWrites(output, floor, "/w/app")).toEqual([
			{ path: "/home/u/.zshrc", readOnly: false },
			{ path: "/home/u/a.txt", readOnly: false },
			{ path: "/home/u/d.txt", readOnly: false },
			{ path: "/home/u/e.txt", readOnly: false },
			{ path: "/w/app/.git/config", readOnly: true },
			{ path: "/home/u/f.txt", readOnly: false },
			{ path: "/home/u/g.txt", readOnly: false },
		]);
		expect(refusedWrites("all fine", floor, "/w/app")).toEqual([]);
	});

	// POSIX paths: there is no write sandbox on Windows.
	it.skipIf(process.platform === "win32")("says which writes it refused and what to do instead, the project's paths as the project names them", () => {
		const floor: Floor = { project: "/w/app", writable: ["/w/app"], readOnly: ["/w/app/.git/config"] };
		expect(refusalNote([], floor)).toBeUndefined();
		const note = refusalNote(
			[
				{ path: "/home/u/.zshrc", readOnly: false },
				{ path: "/w/app/.git/config", readOnly: true },
			],
			floor,
		);
		expect(note).toBe(
			[
				"[mu write sandbox: /home/u/.zshrc is outside what commands may write here (this project, the temporary folders and package caches), so the write was refused. Do the work inside the project, or tell the user which folder the task needs: they can allow it with features.confine.writable.]",
				"[mu write sandbox: .git/config is read-only here, as .git/hooks and .git/config always are, so the write was refused. Commands such as git config and git remote add need the user: tell them what to run.]",
			].join("\n"),
		);
		const many = ["a", "b", "c", "d", "e"].map((name) => ({ path: `/home/u/${name}`, readOnly: false }));
		expect(refusalNote(many, floor)).toContain("/home/u/a, /home/u/b, /home/u/c and 2 more are outside");
	});

	it("refuses to start where it cannot, and says why", async () => {
		const project = folder("project");
		expect(await prepareFloor(project, { platform: "win32", tmp: [] })).toEqual({
			ok: false,
			reason: "mu has no write sandbox on win32",
		});
		expect(
			await prepareFloor(project, { platform: "linux", tmp: [] }, async () => ({ ok: false, reason: "no bwrap" })),
		).toEqual({ ok: false, reason: "no bwrap" });
	});

	it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
		"on macOS, a command can write the project and its temporary folder, and nothing else",
		() => {
			const project = folder("project");
			mkdirSync(join(project, ".git", "hooks"), { recursive: true });
			writeFileSync(join(project, ".git", "config"), "");
			const outside = folder("outside");
			const floor = floorFor(project, { home: folder("home"), tmp: [] });
			if ("problem" in floor) throw new Error(floor.problem);

			const inside = runConfined(floor, `echo ok > ${shellQuote(join(project, "a.txt"))} && cat a.txt`);
			expect(inside.stdout).toBe("ok\n");
			for (const target of [
				join(outside, "b.txt"),
				join(project, ".git", "hooks", "pre-commit"),
				join(project, ".git", "config"),
			]) {
				const refused = runConfined(
					floor,
					`node -e 'require("fs").appendFileSync(process.argv[1], "x")' ${shellQuote(target)}`,
				);
				expect(refused.status, target).not.toBe(0);
				expect(refused.stderr, target).toMatch(/EPERM|not permitted/);
			}
			expect(existsSync(join(outside, "b.txt"))).toBe(false);
			expect(readFileSync(join(project, ".git", "config"), "utf8")).toBe("");
		},
	);

	it.skipIf(process.platform !== "linux" || spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status !== 0)(
		"on Linux with a working bubblewrap, a write outside the project is refused",
		() => {
			const project = folder("project");
			const outside = folder("outside");
			const floor = floorFor(project, { home: folder("home"), tmp: [] });
			if ("problem" in floor) throw new Error(floor.problem);
			expect(runConfined(floor, "echo ok > a.txt && cat a.txt").stdout).toBe("ok\n");
			expect(runConfined(floor, `echo x > ${shellQuote(join(outside, "b.txt"))}`).status).not.toBe(0);
			expect(existsSync(join(outside, "b.txt"))).toBe(false);
		},
	);
});

describe("the write floor in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const start = async (
		probe: () => Promise<{ ok: true } | { ok: false; reason: string }>,
		platform?: NodeJS.Platform,
	) => {
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					config: parseConfig({
						features: { memory: false, permissions: { mode: "full" }, confine: { enabled: true } },
					}),
					only: ["permissions", "background", "confine"],
					confine: { probe, tmp: [], ...(platform ? { platform } : {}) },
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	};
	const results = (harness: Harness) =>
		harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => JSON.stringify(message));

	it("refuses every command when the floor cannot start, rather than running it unconfined", async () => {
		const harness = await start(
			async () => ({ ok: false, reason: "bwrap: setting up uid map: Permission denied" }),
			"linux",
		);
		const marker = join(harness.tempDir, "ran.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bg_start", { command: `touch ${marker}` })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Could not."),
		]);
		await harness.session.prompt("Make the file");

		expect(existsSync(marker)).toBe(false);
		const [bash, background] = results(harness);
		expect(bash).toContain(
			"the write sandbox is on but cannot start here (bwrap: setting up uid map: Permission denied)",
		);
		expect(background).toContain("the write sandbox is on but cannot start here");
	});

	it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
		"on macOS, the agent's bash command writes the project and is refused outside it",
		async () => {
			const harness = await start(async () => ({ ok: true }));
			const outside = folder("outside");
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command: `echo ok > inside.txt; echo x > ${shellQuote(join(outside, "b.txt"))}`,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Done."),
			]);
			await harness.session.prompt("Write the files");

			expect(readFileSync(join(harness.tempDir, "inside.txt"), "utf8")).toBe("ok\n");
			expect(existsSync(join(outside, "b.txt"))).toBe(false);
			expect(results(harness)[0]).toContain("Operation not permitted");
			// The model is told why, so it does not look for another way to write there.
			expect(results(harness)[0]).toContain(
				`[mu write sandbox: ${join(outside, "b.txt")} is outside what commands may write here`,
			);
		},
	);
});
