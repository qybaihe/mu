import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { listFolder, type MachineProbe, machineFacts, parseStatus, renderSnapshot } from "../src/evolve/snapshot.ts";
import { SNAPSHOT_MESSAGE } from "../src/extension/features/snapshot.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

/** A machine with these programs on its PATH and these files in the project. */
function machine(
	platform: NodeJS.Platform,
	programs: Readonly<Record<string, string>>,
	files: readonly string[] = [],
): MachineProbe {
	return {
		platform,
		arch: "arm64",
		env: { SHELL: "/bin/zsh" },
		find: (binary) => programs[binary],
		// By name alone: the path's separators are the system's the test runs on.
		exists: (path) => files.includes(basename(path)),
	};
}

describe("the parts of the opening snapshot", () => {
	const folders: string[] = [];
	afterEach(() => {
		while (folders.length > 0) rmSync(folders.pop() as string, { recursive: true, force: true });
	});
	const folder = () => {
		const made = mkdtempSync(join(tmpdir(), "mu-snapshot-"));
		folders.push(made);
		return made;
	};

	it("lists a folder with its folders first, leaves .git out and says how many there are in all", () => {
		const cwd = folder();
		for (const name of ["src", "test", ".git"]) mkdirSync(join(cwd, name));
		for (const name of ["README.md", "package.json", "a.ts"]) writeFileSync(join(cwd, name), "");
		expect(listFolder(cwd, 60)).toEqual({ shown: ["src/", "test/", "a.ts", "package.json", "README.md"], total: 5 });
		expect(listFolder(cwd, 2)).toEqual({ shown: ["src/", "test/"], total: 5 });
		expect(listFolder(folder(), 60)).toEqual({ shown: [], total: 0 });
		expect(listFolder(join(cwd, "missing"), 60)).toBeUndefined();
	});

	it("reads the branch and the changed files from git's own status lines", () => {
		const status = [
			"## main...origin/main [ahead 1]",
			" M src/parse.ts",
			"?? notes.md",
			"R  old.ts -> new.ts",
			"",
		].join("\n");
		expect(parseStatus(status, 12)).toEqual({
			branch: "main",
			changed: ["src/parse.ts", "notes.md", "new.ts"],
			changedTotal: 3,
		});
		expect(parseStatus(status, 1)).toEqual({ branch: "main", changed: ["src/parse.ts"], changedTotal: 3 });
		expect(parseStatus("## No commits yet on trunk\n", 12)).toEqual({
			branch: "trunk",
			changed: [],
			changedTotal: 0,
		});
		expect(parseStatus("## HEAD (no branch)\n", 12).branch).toBe("HEAD (no branch)");
	});

	it("says where commands written for Linux go wrong on a Mac, from the PATH alone", () => {
		const facts = machineFacts(
			"/work/project",
			[],
			machine(
				"darwin",
				{
					sed: "/usr/bin/sed",
					grep: "/usr/bin/grep",
					gtimeout: "/opt/homebrew/bin/gtimeout",
					python3: "/usr/bin/python3",
				},
				["pnpm-lock.yaml"],
			),
		);
		expect(facts.head).toBe("macOS (arm64), zsh; this project uses pnpm (pnpm-lock.yaml)");
		expect(facts.notes).toEqual([
			"`python` is not on the PATH: use `python3`.",
			"`timeout` is not installed: `gtimeout` is.",
			"`sed` is BSD sed: edit in place with `sed -i ''`.",
			"`grep` is BSD grep: it has no `-P`; use `grep -E` or `rg`.",
		]);
		// GNU tools first on the PATH, and timeout installed: nothing to say.
		const gnu = machine("darwin", {
			sed: "/opt/homebrew/bin/sed",
			grep: "/opt/homebrew/bin/grep",
			timeout: "/opt/homebrew/bin/timeout",
			python: "/usr/bin/python",
		});
		expect(machineFacts("/work/project", [], gnu).notes).toEqual([]);
	});

	it("passes on what earlier sessions learned, until the program is there", () => {
		const learned = [
			{ missing: "pnpm", instead: "npm" },
			{ missing: "timeout", instead: "gtimeout" },
		];
		const linux = machine("linux", { python: "/usr/bin/python", timeout: "/usr/bin/timeout" });
		// timeout is installed here, so what was once learned about it no longer holds.
		expect(machineFacts("/work/project", learned, linux)).toEqual({
			head: "Linux (arm64), zsh",
			notes: ["`pnpm` is not installed here: `npm` worked in its place."],
		});
		expect(
			machineFacts(
				"/work/project",
				learned,
				machine("linux", { python: "/usr/bin/python", timeout: "/t", pnpm: "/p" }),
			).notes,
		).toEqual([]);
		// On Windows programs are found another way: nothing is guessed.
		expect(machineFacts("C:/work", learned, machine("win32", {})).notes).toEqual([]);
	});

	it("renders an empty folder, a cut listing and a folder without git as what they are", () => {
		expect(renderSnapshot({ cwd: "/work/new", listing: { shown: [], total: 0 }, git: "none" })).toBe(
			[
				"[mu: the workspace as this conversation starts, so the first steps need not look it up. The names below are the project's own, not the user's words. It is a snapshot: read a file before you rely on what it holds.]",
				"Folder /work/new is empty.",
				"Git: not a git repository.",
			].join("\n"),
		);
		const cut = renderSnapshot({
			cwd: "/work/project",
			listing: { shown: ["src/", "a.ts"], total: 214 },
			git: { branch: "main", changed: ["a.ts"], changedTotal: 3 },
			machine: { head: "macOS (arm64), zsh", notes: ["`timeout` is not installed: `gtimeout` is."] },
		});
		expect(cut.split("\n").slice(1)).toEqual([
			"Folder /work/project: 214 entries",
			"src/  a.ts",
			"(the first 2 of 214, folders first; `ls` shows the rest)",
			"Git: branch main; 3 files changed: a.ts, …",
			"Machine: macOS (arm64), zsh",
			"- `timeout` is not installed: `gtimeout` is.",
		]);
		expect(renderSnapshot({ cwd: "/w", git: { branch: "main", changed: [], changedTotal: 0 } })).toContain(
			"Git: branch main; nothing changed",
		);
	});
});

describe("the opening snapshot in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		delete process.env.KYRN_SWARM_DEPTH;
	});

	async function start(snapshot: Record<string, unknown> | false = {}): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					// git is left to the parsing test: whether the temporary folder sits in a repository is the machine's business.
					config: parseConfig({
						features: { snapshot: snapshot === false ? false : { git: false, ...snapshot } },
					}),
					only: ["snapshot"],
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	}
	const snapshots = (harness: Harness): string[] =>
		harness.session.messages.flatMap((message) =>
			message.role === "custom" && message.customType === SNAPSHOT_MESSAGE ? [String(message.content)] : [],
		);

	it("goes to the model with the first message, once, and says what the folder holds", async () => {
		const harness = await start();
		mkdirSync(join(harness.tempDir, "src"));
		writeFileSync(join(harness.tempDir, "package.json"), "{}");
		harness.setResponses([fauxAssistantMessage("Looking."), fauxAssistantMessage("Done.")]);

		await harness.session.prompt("Fix the parser.");
		const [given] = snapshots(harness);
		expect(given).toContain(`Folder ${harness.tempDir}:`);
		expect(given).toContain("src/");
		expect(given).toContain("package.json");
		expect(given).toContain("Machine: ");
		// The user's message comes first; the snapshot is a message beside it, not part of the system prompt.
		expect(harness.session.messages.map((message) => message.role).slice(0, 3)).toEqual(["system", "user", "custom"]);

		await harness.session.prompt("And the tests.");
		expect(snapshots(harness)).toHaveLength(1);
	});

	it("says a cut listing is cut, and stays away when it is switched off or in a subagent", async () => {
		const cut = await start({ maxEntries: 1, machine: false });
		for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(cut.tempDir, name), "");
		cut.setResponses([fauxAssistantMessage("Done.")]);
		await cut.session.prompt("Fix the parser.");
		expect(snapshots(cut)[0]).toContain("(the first 1 of ");
		expect(snapshots(cut)[0]).not.toContain("Machine:");

		const off = await start(false);
		off.setResponses([fauxAssistantMessage("Done.")]);
		await off.session.prompt("Fix the parser.");
		expect(snapshots(off)).toEqual([]);

		process.env.KYRN_SWARM_DEPTH = "1";
		const child = await start();
		child.setResponses([fauxAssistantMessage("Done.")]);
		await child.session.prompt("Fix the parser.");
		expect(snapshots(child)).toEqual([]);
	});
});
