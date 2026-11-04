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

	it("refuses to start where it cannot, and says why", async () => {
		const project = folder("project");
		expect(await prepareFloor(project, { platform: "win32", tmp: [] })).toEqual({
			ok: false,
			reason: "mu has no write floor on win32",
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
			"the write floor is on but cannot start here (bwrap: setting up uid map: Permission denied)",
		);
		expect(background).toContain("the write floor is on but cannot start here");
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
		},
	);
});
