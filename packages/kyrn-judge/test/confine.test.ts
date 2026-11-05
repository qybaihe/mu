import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
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
import { OUTCOME_ENTRY, OUTSIDE_FLOOR_WHERE } from "../src/extension/features/permissions.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

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
	it.skipIf(process.platform === "win32")(
		"finds the writes it refused in a command's output, as macOS and Linux tools word them",
		() => {
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
			// Under bubblewrap, git renames its lock file over .git/config, a read-only bind of its own: EBUSY. A busy path
			// anywhere else is not the floor's.
			expect(
				refusedWrites("error: could not write config file .git/config: Device or resource busy", floor, "/w/app"),
			).toEqual([{ path: "/w/app/.git/config", readOnly: true }]);
			expect(
				refusedWrites("umount: /home/u/disk: target is busy (Device or resource busy)", floor, "/w/app"),
			).toEqual([]);
		},
	);

	// POSIX paths: there is no write sandbox on Windows.
	it.skipIf(process.platform === "win32")(
		"says which writes it refused and what to do instead, the project's paths as the project names them",
		() => {
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
			// With the permission gate there to decide it, the line names the way out instead of sending the model to the user.
			const out = refusalNote(
				[
					{ path: "/home/u/.zshrc", readOnly: false },
					{ path: "/w/app/.git/config", readOnly: true },
				],
				floor,
				true,
			)?.split("\n");
			expect(out?.[0]).toContain(
				"Do the work inside the project if you can. If the task needs this write, run the command again with outside: true and a reason: it then runs outside the sandbox, once, if the judge or the user allows it. A folder the task keeps needing, the user can allow with features.confine.writable.]",
			);
			expect(out?.[1]).toBe(
				"[mu write sandbox: .git/config is read-only here, as .git/hooks and .git/config always are, so the write was refused. If the task needs this write, run the command again with outside: true and a reason: it then runs outside the sandbox, once, if the judge or the user allows it.]",
			);
		},
	);

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
		"on macOS, a background job's refused write is said so where its output is read",
		async () => {
			const harness = await start(async () => ({ ok: true }));
			const target = join(folder("outside"), "job.txt");
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bg_start", { command: `echo x > ${shellQuote(target)}` })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall("bg_output", { id: "bg-1", timeout: 10 })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Done."),
			]);
			await harness.session.prompt("Write it in the background");

			expect(existsSync(target)).toBe(false);
			const output = results(harness)[1];
			expect(output).toContain("Operation not permitted");
			expect(output).toContain(`[mu write sandbox: ${target} is outside what commands may write here`);
			// mu's own line, above the job's output, which is marked as not to be trusted.
			expect(output.indexOf("[mu write sandbox:")).toBeLessThan(output.indexOf("Operation not permitted"));
		},
	);

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

/**
 * The way out of the floor, through the permission gate. The floor here is another platform's, whose runner this
 * machine does not have: a command run inside it does not start, one let out runs. So these tests show where a command
 * ran on any machine, without a real sandbox.
 */
describe.skipIf(process.platform === "win32")("the way out of the write floor", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});
	const elsewhere: NodeJS.Platform = process.platform === "darwin" ? "linux" : "darwin";
	const verdict = (option: string): Answer => ({ type: "choice", choice: option, probabilities: { [option]: 0.95 } });

	interface Setup {
		mode: "full" | "judge" | "ask";
		/** Picks an answer. Left out, nobody can be asked. */
		pick?: (options: string[], title: string) => string | undefined;
		/** The permission gate on, as it is by default. */
		permissions?: boolean;
		/** This machine's own floor, a real sandbox, in place of another platform's. */
		real?: boolean;
	}

	async function start(responder: MockResponder, setup: Setup) {
		const judged: Record<string, unknown>[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider((request) => {
						if ("verdict" in request.questions) judged.push(request.state as Record<string, unknown>);
						return responder(request);
					}),
					mode: "active",
					config: parseConfig({
						features: { memory: false, permissions: { mode: setup.mode }, confine: { enabled: true } },
					}),
					only: [
						...(setup.permissions === false ? [] : ["preflight", "frame", "permissions"]),
						"confine",
					] as never,
					confine: setup.real ? { tmp: [] } : { probe: async () => ({ ok: true }), tmp: [], platform: elsewhere },
				}),
			],
		});
		harnesses.push(harness);
		const asked: { title: string; options: string[] }[] = [];
		if (setup.pick) {
			const pick = setup.pick;
			const known: Record<string, unknown> = {
				select: async (title: string, options: string[]) => {
					asked.push({ title, options });
					return pick(options, title);
				},
				setStatus: () => undefined,
				notify: () => undefined,
			};
			const ui = new Proxy(known, {
				get: (target, key) => (key in target ? target[key as string] : () => undefined),
			}) as unknown as ExtensionUIContext;
			await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		}
		const results = () =>
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => JSON.stringify(message));
		const outcomes = () =>
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === OUTCOME_ENTRY)
				.map((entry) => (entry as { data: Record<string, unknown> }).data);
		return { harness, judged, asked, results, outcomes };
	}

	const bash = (args: Record<string, string | boolean>, id?: string) =>
		fauxAssistantMessage([fauxToolCall("bash", args, id ? { id } : undefined)], { stopReason: "toolUse" });
	const reason = "the task adds the git remote, and git writes it to .git/config";

	it("Judge mode: the judge decides the way out from the call and the user's words, not the model's reason, and only that call goes out", async () => {
		const { harness, judged } = await start(() => ({ verdict: verdict("needed") }), { mode: "judge" });
		const out = join(harness.tempDir, "out.txt");
		const inside = join(harness.tempDir, "inside.txt");
		harness.setResponses([
			bash({ command: `echo x > ${shellQuote(out)}`, outside: true, reason }),
			bash({ command: `echo x > ${shellQuote(inside)}` }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Add the remote");

		expect(existsSync(out)).toBe(true);
		// The judge approved it as well, but it asked nothing of the floor: it ran inside, which does not start here.
		expect(existsSync(inside)).toBe(false);
		expect(judged).toEqual([
			expect.objectContaining({ tool_call: `bash: echo x > ${shellQuote(out)}`, where: OUTSIDE_FLOOR_WHERE }),
			expect.objectContaining({ where: "a program run in the project folder" }),
		]);
		expect(JSON.stringify(judged)).not.toContain("git writes it");
	});

	it("Judge mode: what the judge doubts, the user allows once, never for the session, shown the model's reason", async () => {
		const answers = ["Allow once", "Don't allow"];
		const { harness, asked, results, outcomes } = await start(() => ({ verdict: verdict("beyond") }), {
			mode: "judge",
			pick: () => answers.shift(),
		});
		const first = join(harness.tempDir, "first.txt");
		const second = join(harness.tempDir, "second.txt");
		harness.setResponses([
			bash({ command: `echo x > ${shellQuote(first)}`, outside: true, reason }, "call-first"),
			bash({ command: `echo x > ${shellQuote(second)}`, outside: true, reason }, "call-second"),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Add the remote");

		expect(existsSync(first)).toBe(true);
		expect(existsSync(second)).toBe(false);
		expect(asked).toHaveLength(2);
		expect(asked[0].options).toEqual(["Allow once", "Don't allow"]);
		const [what, call, why] = asked[0].title.split("\n");
		expect(what).toBe("mu wants to run a command outside the write sandbox");
		expect(call).toBe(`echo x > ${shellQuote(first)} (outside the write sandbox: ${reason})`);
		expect(why).toBe("The judge thinks this goes beyond what you asked for.");
		expect(results()[1]).toContain("The user did not allow this");
		expect(outcomes()).toEqual([
			expect.objectContaining({ toolCallId: "call-first", answer: "once", outsideFloor: true }),
			expect.objectContaining({ toolCallId: "call-second", answer: "deny", outsideFloor: true }),
		]);
	});

	it("full access: the way out still goes to the judge, then to the user, and with nobody to ask it is refused", async () => {
		const { harness, judged, results } = await start(() => ({ verdict: verdict("unclear") }), { mode: "full" });
		const out = join(harness.tempDir, "out.txt");
		harness.setResponses([
			bash({ command: `echo x > ${shellQuote(out)}`, outside: true, reason }),
			bash({ command: "echo hi" }),
			fauxAssistantMessage("Could not."),
		]);
		await harness.session.prompt("Add the remote");

		expect(existsSync(out)).toBe(false);
		// The other command was asked about by nobody, as in full access every command is.
		expect(judged).toHaveLength(1);
		expect(results()[0]).toContain("there is nobody to ask here");
	});

	it("minimal permissions: the user decides the way out, no judge", async () => {
		const { harness, judged, asked } = await start(() => ({ verdict: verdict("needed") }), {
			mode: "ask",
			pick: (options) => options[0],
		});
		const out = join(harness.tempDir, "out.txt");
		harness.setResponses([
			bash({ command: `echo x > ${shellQuote(out)}`, outside: true, reason }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Add the remote");

		expect(existsSync(out)).toBe(true);
		expect(judged).toEqual([]);
		expect(asked[0].title).toContain("Ask first");
	});

	it("needs a reason; a command that only looks runs inside; without the permission gate nothing goes out", async () => {
		const looked = await start(() => ({ verdict: verdict("needed") }), {
			mode: "judge",
			pick: (options) => options[0],
		});
		const out = join(looked.harness.tempDir, "out.txt");
		looked.harness.setResponses([
			bash({ command: `echo x > ${shellQuote(out)}`, outside: true }),
			bash({ command: "ls", outside: true, reason }),
			fauxAssistantMessage("Done."),
		]);
		await looked.harness.session.prompt("Look around");
		expect(existsSync(out)).toBe(false);
		expect(looked.results()[0]).toContain("outside: true needs a reason");
		// Nothing to let out: it ran inside the floor, which does not start here, and nobody was asked.
		expect(looked.results()[1]).toMatch(/exited with code 12[67]/);
		expect(looked.asked).toEqual([]);
		expect(looked.judged).toEqual([]);

		const ungated = await start(() => ({}), { mode: "full", permissions: false });
		const marker = join(ungated.harness.tempDir, "marker.txt");
		ungated.harness.setResponses([
			bash({ command: `echo x > ${shellQuote(marker)}`, outside: true, reason }),
			fauxAssistantMessage("Done."),
		]);
		await ungated.harness.session.prompt("Write it");
		expect(existsSync(marker)).toBe(false);
		expect(ungated.results()[0]).toContain(
			"outside: true needs mu's permission check, which is off here, so the command ran inside the sandbox.",
		);
	});

	it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
		"on macOS, a command let out writes outside the project, and the same one kept inside is refused and told of the way out",
		async () => {
			const { harness, results } = await start(() => ({ verdict: verdict("needed") }), {
				mode: "judge",
				real: true,
			});
			const elsewhereDir = realpathSync(mkdtempSync(join(tmpdir(), "mu-floor-away-")));
			try {
				// This floor has no temporary folders: a folder beside the project is outside it.
				const away = join(elsewhereDir, "out.txt");
				const kept = join(elsewhereDir, "kept.txt");
				harness.setResponses([
					bash({ command: `echo x > ${shellQuote(away)}`, outside: true, reason }),
					bash({ command: `echo x > ${shellQuote(kept)}` }),
					fauxAssistantMessage("Done."),
				]);
				await harness.session.prompt("Write it");
				expect(readFileSync(away, "utf8")).toBe("x\n");
				expect(existsSync(kept)).toBe(false);
				expect(results()[1]).toContain(`[mu write sandbox: ${kept} is outside what commands may write here`);
				expect(results()[1]).toContain("run the command again with outside: true and a reason");
			} finally {
				rmSync(elsewhereDir, { recursive: true, force: true });
			}
		},
	);
});
