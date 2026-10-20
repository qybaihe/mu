import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getToolResult, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { decodeStream, SandboxApiError, SandboxClient, type Sleep } from "../src/sandbox/client.ts";
import { sandboxOperations, toSandboxPath } from "../src/sandbox/operations.ts";
import { applyPatchLocally, diffstat, formatDiffstat, projectFiles, seedArchive } from "../src/sandbox/project.ts";
import { SandboxSession, type SandboxSessionOptions } from "../src/sandbox/session.ts";
import { createTar } from "../src/sandbox/tar.ts";
import { FakeContree } from "./fixtures/fake-contree.ts";
import { sh } from "./fixtures/git-repo.ts";

const dirs: string[] = [];
function tempDir(prefix = "mu-sandbox-"): string {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
}

function write(root: string, files: Record<string, string | Buffer>, mode?: number): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content, mode === undefined ? undefined : { mode });
	}
}

/** Waits that return at once and are written down, so polling takes no time and Retry-After is visible. */
function recordingSleep(): { sleep: Sleep; waits: number[] } {
	const waits: number[] = [];
	return {
		waits,
		sleep: async (ms, signal) => {
			waits.push(ms);
			if (signal?.aborted) throw new Error("aborted");
		},
	};
}

function client(fake: FakeContree, sleep: Sleep = async () => {}, apiKey = "test-key"): SandboxClient {
	return new SandboxClient({ apiKey, project: "test-project", fetch: fake.fetch, sleep });
}

function session(fake: FakeContree, root: string, extra: Partial<SandboxSessionOptions> = {}): SandboxSession {
	return new SandboxSession({
		client: client(fake),
		root,
		image: "tag:ubuntu:latest",
		workdir: "/workspace",
		shell: "/bin/bash",
		seedTimeoutS: 900,
		maxSeedBytes: 10 * 1024 * 1024,
		outputBytes: 1_048_576,
		...extra,
	});
}

const text = (result: { content: { type: string; text?: string }[] }) =>
	result.content.map((block) => block.text ?? "").join("\n");

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sandbox client", () => {
	it("spawns, polls after the Retry-After the API asks for, and decodes ascii and base64 output", async () => {
		const fake = new FakeContree();
		const { sleep, waits } = recordingSleep();
		const api = client(fake, sleep);
		fake.handler = (run) =>
			run.command === "binary"
				? { exitCode: 0, stdout: Buffer.from([0, 1, 254, 255]), encoding: "base64", polls: 2 }
				: { exitCode: 3, stdout: "plain out\n", stderr: "plain err\n" };

		const plain = await api.run({ image: "tag:ubuntu:latest", command: "plain", shell: true, disposable: true });
		expect(plain.status).toBe("SUCCESS");
		expect(plain.metadata?.result?.state?.exit_code).toBe(3);
		expect(decodeStream(plain.metadata?.result?.stdout).toString()).toBe("plain out\n");
		expect(decodeStream(plain.metadata?.result?.stderr).toString()).toBe("plain err\n");
		expect(waits).toEqual([2000]);

		fake.retryAfter = undefined;
		const binary = await api.run({ image: "tag:ubuntu:latest", command: "binary", shell: true, disposable: true });
		expect([...decodeStream(binary.metadata?.result?.stdout)]).toEqual([0, 1, 254, 255]);
		// Without a Retry-After the client backs off on its own.
		expect(waits.slice(1)).toEqual([250, 375]);
		const spawn = fake.requests.find((request) => request.path === "/instances");
		expect(spawn?.headers.authorization).toBe("Bearer test-key");
		expect(spawn?.headers.project).toBe("test-project");
	});

	it("retries a spawn the API is too busy for, after its Retry-After", async () => {
		const fake = new FakeContree();
		const { sleep, waits } = recordingSleep();
		fake.busy = 1;
		const done = await client(fake, sleep).run({
			image: "tag:ubuntu:latest",
			command: "x",
			shell: true,
			disposable: true,
		});
		expect(done.status).toBe("SUCCESS");
		expect(waits[0]).toBe(3000);
		expect(fake.spawns).toHaveLength(1);
	});

	it("cancels the operation when the caller aborts while it runs", async () => {
		const fake = new FakeContree();
		fake.handler = () => ({ exitCode: 0, polls: Number.POSITIVE_INFINITY });
		const controller = new AbortController();
		let polls = 0;
		const api = client(fake, async (_ms, signal) => {
			if (++polls === 3) controller.abort();
			if (signal?.aborted) throw new Error("aborted");
		});
		await expect(
			api.run(
				{ image: "tag:ubuntu:latest", command: "sleep 1000", shell: true, disposable: true },
				controller.signal,
			),
		).rejects.toThrow("aborted");
		const cancel = fake.requests.find((request) => request.method === "DELETE");
		expect(cancel?.path).toMatch(/^\/operations\//);
		expect([...fake.operations.values()][0]?.status).toBe("CANCELLED");
	});

	it("polls through a gateway that fails a few times, and cancels the operation when it keeps failing", async () => {
		const fake = new FakeContree();
		fake.failingPolls = 3;
		const done = await client(fake).run({ image: "tag:ubuntu:latest", command: "x", shell: true, disposable: true });
		expect(done.status).toBe("SUCCESS");

		fake.failingPolls = 100;
		await expect(
			client(fake).run({ image: "tag:ubuntu:latest", command: "y", shell: true, disposable: true }),
		).rejects.toThrow(/GET \/operations\/[^ ]+ answered 502: bad gateway/);
		expect(fake.requests.at(-1)?.method).toBe("DELETE");
	});

	it("uploads the same bytes once, and asks the API before uploading again from a new client", async () => {
		const fake = new FakeContree();
		const first = client(fake);
		const uuid = await first.upload(Buffer.from("same bytes"));
		expect(await first.upload(Buffer.from("same bytes"))).toBe(uuid);
		expect(await client(fake).upload(Buffer.from("same bytes"))).toBe(uuid);
		expect(fake.requests.filter((request) => request.method === "POST" && request.path === "/files")).toHaveLength(1);
		expect(fake.requests.filter((request) => request.path.startsWith("/files/"))).toHaveLength(2);
	});

	it("names the endpoint and the status in errors, and never the key", async () => {
		const fake = new FakeContree();
		const error = await client(fake, async () => {}, "wrong-key")
			.whoami()
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SandboxApiError);
		expect((error as SandboxApiError).message).toBe("Nebius sandbox GET /whoami answered 401: bad credentials");
		const leaky = new SandboxClient({
			apiKey: "secret-key",
			project: "p",
			fetch: async () => {
				throw new Error("connect failed for Bearer secret-key");
			},
		});
		const transport = await leaky.whoami().catch((caught: unknown) => caught);
		expect((transport as Error).message).toBe(
			"Nebius sandbox GET /whoami failed: connect failed for Bearer [NEBIUS_API_KEY]",
		);
	});

	it("reads files of an image without a VM, imports images and reports the token", async () => {
		const fake = new FakeContree();
		const api = client(fake);
		const image = await api.importImage("docker://docker.io/library/python:3.12");
		fake.image(image).files.set("/etc/motd", { data: Buffer.from("hi\n"), mode: 0o644 });
		expect((await api.download(image, "/etc/motd"))?.toString()).toBe("hi\n");
		expect(await api.download(image, "/etc/none")).toBeUndefined();
		expect((await api.list(image, "/etc"))?.map((item) => item.path)).toEqual(["motd"]);
		expect((await api.whoami()).permissions.spawn).toBe(true);
	});
});

describe("project archive", () => {
	it("writes a tar that the system's tar extracts with modes, long paths and symlinks", () => {
		const out = tempDir();
		const long = `${"deep/".repeat(25)}file.txt`;
		const tar = createTar([
			{ path: "run.sh", mode: 0o755, mtime: 1_700_000_000, data: Buffer.from("#!/bin/sh\necho hi\n") },
			{ path: long, mode: 0o644, mtime: 1_700_000_000, data: Buffer.from("deep\n") },
			{ path: "名前.txt", mode: 0o644, mtime: 1_700_000_000, data: Buffer.from("utf8\n") },
			{ path: "link", mode: 0o777, mtime: 1_700_000_000, linkTarget: "run.sh" },
		]);
		writeFileSync(join(out, "a.tar"), tar);
		mkdirSync(join(out, "x"));
		execFileSync("tar", ["-xf", join(out, "a.tar"), "-C", join(out, "x")]);
		expect(readFileSync(join(out, "x", "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
		expect(statSync(join(out, "x", "run.sh")).mode & 0o777).toBe(0o755);
		expect(readFileSync(join(out, "x", long), "utf8")).toBe("deep\n");
		expect(readFileSync(join(out, "x", "名前.txt"), "utf8")).toBe("utf8\n");
		expect(lstatSync(join(out, "x", "link")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(out, "x", "link"))).toBe("run.sh");
	});

	it("takes what git tracks plus untracked files it does not ignore, and walks a plain folder without node_modules", async () => {
		const repo = tempDir();
		write(repo, { ".gitignore": "dist/\n", "src/a.ts": "a\n", "dist/out.js": "built\n" });
		sh(repo, "init", "-q");
		sh(repo, "add", "-A");
		sh(repo, "commit", "-qm", "init");
		write(repo, { "new.txt": "untracked\n" });
		expect((await projectFiles(repo)).files.sort()).toEqual([".gitignore", "new.txt", "src/a.ts"]);

		const plain = tempDir();
		write(plain, { "a.txt": "a\n", "node_modules/x/index.js": "x\n", ".git/HEAD": "ref\n" });
		expect(await projectFiles(plain)).toEqual({ files: ["a.txt"], fromGit: false });
		await expect(seedArchive(plain, 1)).rejects.toThrow(/seeding limit/);
	});

	it("counts a patch's changes per file, binary ones included", () => {
		const stats = diffstat(
			[
				"diff --git a/src/a.ts b/src/a.ts",
				"index 1..2 100644",
				"--- a/src/a.ts",
				"+++ b/src/a.ts",
				"@@ -1,2 +1,2 @@",
				"-old",
				"--- a removed line that starts with dashes",
				"+new",
				" same",
				"diff --git a/img.png b/img.png",
				"new file mode 100644",
				"GIT binary patch",
				"literal 4",
				"",
			].join("\n"),
		);
		expect(stats).toEqual([
			{ path: "src/a.ts", added: 1, removed: 2, binary: false },
			{ path: "img.png", added: 0, removed: 0, binary: true },
		]);
		expect(formatDiffstat(stats)).toBe(
			[" src/a.ts | 3 +--", " img.png  | Bin", " 2 files changed, 1 insertion(+), 2 deletions(-)"].join("\n"),
		);
	});

	it("applies a patch all or nothing, in a subfolder of a repository and outside one", async () => {
		const patch = Buffer.from(
			["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-one", "+two", ""].join("\n"),
		);
		const repo = tempDir();
		write(repo, { "sub/a.txt": "one\n", "a.txt": "one\n" });
		sh(repo, "init", "-q");
		expect(await applyPatchLocally(join(repo, "sub"), patch)).toEqual({ ok: true });
		expect(readFileSync(join(repo, "sub", "a.txt"), "utf8")).toBe("two\n");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");

		const plain = tempDir();
		write(plain, { "a.txt": "changed here\n" });
		const refused = await applyPatchLocally(plain, patch);
		expect(refused.ok).toBe(false);
		expect(readFileSync(join(plain, "a.txt"), "utf8")).toBe("changed here\n");
	});
});

describe("sandbox session and tool operations", () => {
	function project(): string {
		const root = tempDir();
		write(root, { "src/app.ts": "export const v = 1;\n", "old.txt": "old\n", "notes/a b.md": "spaced\n" });
		write(root, { "run.sh": "#!/bin/sh\necho hi\n" }, 0o755);
		symlinkSync("src/app.ts", join(root, "link"));
		return root;
	}

	it("seeds the project into /workspace once, from the configured image", async () => {
		const fake = new FakeContree();
		const root = project();
		const sandbox = session(fake, root);
		await Promise.all([sandbox.ready(), sandbox.ready()]);
		expect(fake.spawns).toHaveLength(1);
		const seed = fake.spawns[0] as { image: string; disposable: boolean; files: Record<string, unknown> };
		expect(seed.image).toBe("tag:ubuntu:latest");
		expect(seed.disposable).toBe(false);
		expect(Object.keys(seed.files)).toEqual(["/tmp/mu-sandbox-seed.tgz"]);
		const status = sandbox.status();
		expect(status.state).toBe("ready");
		expect(status.seeded).toEqual({ files: 5, bytes: expect.any(Number), fromGit: false });
		expect(status.pull).toEqual({ base: "mu-base" });
		expect(status.cost).toBe(0.5);
		const files = fake.image(status.head as string).files;
		expect(files.get("/workspace/src/app.ts")?.data.toString()).toBe("export const v = 1;\n");
		expect(files.get("/workspace/run.sh")?.mode).toBe(0o755);
		expect(files.get("/workspace/link")?.link).toBe("src/app.ts");
		expect(files.has("/tmp/mu-sandbox-seed.tgz")).toBe(false);
	});

	it("says why a pull cannot work when the image has no git, and reports a failed seed to every waiter", async () => {
		const fake = new FakeContree();
		fake.gitInImage = false;
		const sandbox = session(fake, project());
		await sandbox.ready();
		expect(sandbox.status().pull).toEqual({ problem: expect.stringContaining("git is not available") });

		const broken = session(new FakeContree(), project(), { image: "tag:missing" });
		await expect(broken.ready()).rejects.toThrow(/answered 400: unknown image tag:missing/);
		expect(broken.status().state).toBe("failed");
	});

	it("runs commands through the bash tool from the head image, in the mapped folder, with exit codes, timeouts and signals", async () => {
		const fake = new FakeContree();
		const root = project();
		const sandbox = session(fake, root);
		const ops = sandboxOperations(sandbox, { defaultTimeoutS: 600 });
		const bash = createBashToolDefinition(root, { operations: ops.bash });
		fake.handler = (run) => {
			if (run.command === "touch made") {
				run.fs.set(`${run.cwd}/made`, { data: Buffer.alloc(0), mode: 0o644 });
				return { exitCode: 0, stdout: `in ${run.cwd}\n` };
			}
			if (run.command === "false") return { exitCode: 3, stderr: "it failed\n" };
			if (run.command === "slow") return { exitCode: null, timedOut: true, stdout: "partial\n" };
			if (run.command === "killed") return { exitCode: null, signal: 9 };
			if (run.command === "big") return { exitCode: 0, stdout: "head of it\n", truncated: true };
			return undefined;
		};

		const made = await bash.execute("1", { command: "touch made" }, undefined, undefined, undefined as never);
		expect(text(made)).toBe("in /workspace\n");
		const head = sandbox.status().head as string;
		expect(fake.image(head).files.has("/workspace/made")).toBe(true);
		expect((fake.spawns.at(-1) as { cwd: string; env: Record<string, string> }).env).toEqual({ SHELL: "/bin/bash" });

		const sub = createBashToolDefinition(join(root, "src"), { operations: ops.bash });
		await sub.execute("2", { command: "true" }, undefined, undefined, undefined as never);
		expect((fake.spawns.at(-1) as { cwd: string; image: string }).cwd).toBe("/workspace/src");
		expect((fake.spawns.at(-1) as { image: string }).image).toBe(head);

		const failed = await bash.execute("3", { command: "false" }, undefined, undefined, undefined as never);
		expect(failed.isError).toBe(true);
		expect(text(failed)).toMatch(/^it failed\n[\s\S]*Command exited with code 3$/);

		await expect(
			bash.execute("4", { command: "slow", timeout: 5 }, undefined, undefined, undefined as never),
		).rejects.toThrow(/partial[\s\S]*Command timed out after 5 seconds/);
		expect((fake.spawns.at(-1) as { timeout: number }).timeout).toBe(5);

		const killed = await bash.execute("5", { command: "killed" }, undefined, undefined, undefined as never);
		expect(text(killed)).toContain("Command exited with code 137");
		expect((fake.spawns.at(-1) as { timeout: number }).timeout).toBe(600);

		const big = await bash.execute("6", { command: "big" }, undefined, undefined, undefined as never);
		expect(text(big)).toContain("[sandbox] stdout was cut at 1048576 bytes by the sandbox");
		// Seed plus six commands, a quarter each as the fake reports it.
		expect(sandbox.status().operations).toBe(7);
		expect(sandbox.status().cost).toBeCloseTo(0.5 + 6 * 0.25);
	});

	it("stages writes and edits for the next command, reads them back at once, and keeps a script executable", async () => {
		const fake = new FakeContree();
		const root = project();
		const sandbox = session(fake, root);
		const ops = sandboxOperations(sandbox, { defaultTimeoutS: 600 });
		await sandbox.ready();
		const spawned = fake.spawns.length;

		await ops.write.writeFile(join(root, "notes", "new.md"), "fresh\n");
		const edit = createEditToolDefinition(root, { operations: ops.edit });
		const edited = await edit.execute(
			"1",
			{ path: "run.sh", edits: [{ oldText: "echo hi", newText: "echo bye" }] },
			undefined,
			undefined,
			undefined as never,
		);
		expect(edited.details?.diff).toContain("echo bye");
		expect(fake.spawns).toHaveLength(spawned);
		expect((await ops.read.readFile(join(root, "notes", "new.md"))).toString()).toBe("fresh\n");
		expect(sandbox.status().staged).toBe(2);

		await ops.bash.exec("true", root, { onData: () => {} });
		const files = (fake.spawns.at(-1) as { files: Record<string, { uuid: string; mode: string }> }).files;
		expect(Object.keys(files).sort()).toEqual(["/workspace/notes/new.md", "/workspace/run.sh"]);
		expect(files["/workspace/run.sh"]?.mode).toBe("0755");
		expect(files["/workspace/notes/new.md"]?.mode).toBe("0644");
		expect(sandbox.status().staged).toBe(0);
		const head = sandbox.status().head as string;
		expect(fake.text(head, "/workspace/run.sh")).toBe("#!/bin/sh\necho bye\n");

		// Now from the image, through /inspect, without a VM.
		const downloads = fake.requests.filter((request) => request.path.endsWith("/download")).length;
		const read = createReadToolDefinition(root, { operations: ops.read });
		const result = await read.execute("2", { path: "notes/new.md" }, undefined, undefined, undefined as never);
		expect(text(result)).toBe("fresh\n");
		expect(fake.requests.filter((request) => request.path.endsWith("/download")).length).toBe(downloads + 1);
		expect(fake.spawns.length).toBe(spawned + 1);
	});

	it("reads the sandbox first, this machine only outside the project, and reports a missing file", async () => {
		const fake = new FakeContree();
		const root = project();
		const outside = tempDir();
		write(outside, { "SKILL.md": "a local skill\n" });
		write(root, { "local-only.txt": "here\n" });
		const sandbox = session(fake, root);
		const ops = sandboxOperations(sandbox, { defaultTimeoutS: 600 });
		await sandbox.ready();
		fake.image(sandbox.status().head as string).files.delete("/workspace/local-only.txt");
		const read = createReadToolDefinition(root, { operations: ops.read });
		expect(
			text(await read.execute("1", { path: join(outside, "SKILL.md") }, undefined, undefined, undefined as never)),
		).toBe("a local skill\n");
		await expect(
			read.execute("2", { path: "local-only.txt" }, undefined, undefined, undefined as never),
		).rejects.toThrow("ENOENT: no such file in the sandbox: /workspace/local-only.txt");
		const edit = createEditToolDefinition(root, { operations: ops.edit });
		await expect(
			edit.execute(
				"3",
				{ path: "local-only.txt", edits: [{ oldText: "here", newText: "there" }] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("Could not edit file: local-only.txt. Error code: ENOENT.");
	});

	it("maps project paths to the workdir and leaves other absolute paths alone", () => {
		expect(toSandboxPath("/home/me/app", "/home/me/app", "/workspace")).toBe("/workspace");
		expect(toSandboxPath("/home/me/app/src/a.ts", "/home/me/app", "/workspace")).toBe("/workspace/src/a.ts");
		expect(toSandboxPath("/home/me/app/..x/a", "/home/me/app", "/workspace")).toBe("/workspace/..x/a");
		expect(toSandboxPath("/home/me/apple/a", "/home/me/app", "/workspace")).toBe("/home/me/apple/a");
		expect(toSandboxPath("/workspace/a", "/home/me/app", "/workspace")).toBe("/workspace/a");
		expect(toSandboxPath("/tmp/x", "/home/me/app", "/workspace")).toBe("/tmp/x");
	});

	it("pulls the sandbox's changes as a patch that applies here, then diffs from there", async () => {
		const fake = new FakeContree();
		const root = tempDir();
		write(root, { "src/app.ts": "export const v = 1;\n", "old.txt": "old\n", ".gitignore": "dist/\n" });
		sh(root, "init", "-q");
		sh(root, "add", "-A");
		sh(root, "commit", "-qm", "init");
		const sandbox = session(fake, root);
		const ops = sandboxOperations(sandbox, { defaultTimeoutS: 600 });
		fake.handler = (run) => {
			if (run.command !== "generate") return undefined;
			run.fs.set("/workspace/gen/out.bin", { data: Buffer.from([0, 1, 2, 255]), mode: 0o644 });
			run.fs.set("/workspace/dist/ignored.js", { data: Buffer.from("x"), mode: 0o644 });
			run.fs.delete("/workspace/old.txt");
			return { exitCode: 0 };
		};
		await ops.edit.writeFile(join(root, "src", "app.ts"), "export const v = 2;\n");
		await ops.bash.exec("generate", root, { onData: () => {} });
		await ops.write.writeFile(join(root, "late.txt"), "staged, not yet run\n");

		// Declined: nothing changes here, and the next pull shows the same.
		const declined = await sandbox.pull(async () => false);
		expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe("export const v = 1;\n");
		expect(sandbox.status().staged).toBe(1);

		let shown = "";
		const plan = await sandbox.pull(async (found) => {
			shown = formatDiffstat(found.stats);
			const applied = await applyPatchLocally(root, found.patch);
			return applied.ok;
		});
		expect(plan.stats.map((stat) => stat.path).sort()).toEqual(declined.stats.map((stat) => stat.path).sort());
		expect(shown).toContain("gen/out.bin | Bin");
		expect(plan.stats.map((stat) => stat.path).sort()).toEqual(["gen/out.bin", "late.txt", "old.txt", "src/app.ts"]);
		expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe("export const v = 2;\n");
		expect([...readFileSync(join(root, "gen", "out.bin"))]).toEqual([0, 1, 2, 255]);
		expect(readFileSync(join(root, "late.txt"), "utf8")).toBe("staged, not yet run\n");
		expect(existsSync(join(root, "old.txt"))).toBe(false);
		expect(existsSync(join(root, "dist"))).toBe(false);
		expect(sandbox.status().staged).toBe(0);
		expect(sandbox.status().pull).toEqual({ base: plan.commit });

		const again = await sandbox.pull(async () => {
			throw new Error("nothing should be asked");
		});
		expect(again.patch.length).toBe(0);
	});
});

describe("sandbox feature", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	const call = (name: string, input: Record<string, string | number>) =>
		fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" });

	async function start(fake: FakeContree, env: Record<string, string>, features: Record<string, unknown> = {}) {
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					config: parseConfig({ features: { sandbox: true, ...features } }),
					only: ["sandbox"],
					sandbox: { fetch: fake.fetch, env, sleep: async () => {} },
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	}

	it("runs the agent's write, bash and read in the sandbox, and brings the result back on /sandbox pull", async () => {
		const fake = new FakeContree();
		fake.handler = (run) =>
			run.command === "cat note.txt" ? { exitCode: 0, stdout: run.fs.get(`${run.cwd}/note.txt`)?.data } : undefined;
		const harness = await start(fake, { NEBIUS_API_KEY: "test-key", NEBIUS_PROJECT_ID: "test-project" });
		harness.setResponses([
			call("write", { path: "note.txt", content: "hello from the sandbox\n" }),
			call("bash", { command: "cat note.txt" }),
			call("read", { path: "note.txt" }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Write a note and show it.");

		expect(getToolResult(harness, "write").isError).toBe(false);
		expect(getToolResult(harness, "bash").content).toEqual([{ type: "text", text: "hello from the sandbox\n" }]);
		expect(getToolResult(harness, "read").content).toEqual([{ type: "text", text: "hello from the sandbox\n" }]);
		expect(existsSync(join(harness.tempDir, "note.txt"))).toBe(false);
		const bash = fake.spawns.find((spawn) => spawn.command === "cat note.txt") as { cwd: string; files: object };
		expect(bash.cwd).toBe("/workspace");
		expect(Object.keys(bash.files)).toEqual(["/workspace/note.txt"]);
		expect(harness.session.systemPrompt).toContain("a VM holding a copy of the project at /workspace");

		const notes: string[] = [];
		const asked: string[] = [];
		const ui = new Proxy(
			{
				notify: (message: string) => notes.push(message),
				confirm: async (_title: string, message: string) => {
					asked.push(message);
					return true;
				},
			} as Record<string, unknown>,
			{ get: (target, key) => (key in target ? target[key as string] : () => undefined) },
		) as unknown as ExtensionUIContext;
		await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		await harness.session.prompt("/sandbox pull");
		expect(asked[0]).toContain("note.txt | 1 +");
		expect(readFileSync(join(harness.tempDir, "note.txt"), "utf8")).toBe("hello from the sandbox\n");
		expect(notes.at(-1)).toContain("Applied the sandbox's changes");

		await harness.session.prompt("/sandbox status");
		expect(notes.at(-1)).toMatch(/Nebius sandbox: ready[\s\S]*operations {3}\d+/);
	});

	it("refuses to run anything, here or there, when the key is missing", async () => {
		const fake = new FakeContree();
		const harness = await start(fake, {});
		harness.setResponses([call("bash", { command: "touch here.txt" }), fauxAssistantMessage("Could not.")]);
		await harness.session.prompt("Touch a file.");
		const result = getToolResult(harness, "bash");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("NEBIUS_API_KEY and NEBIUS_PROJECT_ID are not both set");
		expect(existsSync(join(harness.tempDir, "here.txt"))).toBe(false);
		expect(fake.requests).toHaveLength(0);
	});

	it("stays off unless switched on, and MU_SANDBOX overrides mu.json", async () => {
		const fake = new FakeContree();
		const off = await start(fake, {
			MU_SANDBOX: "off",
			NEBIUS_API_KEY: "test-key",
			NEBIUS_PROJECT_ID: "test-project",
		});
		off.setResponses([call("bash", { command: "echo local" }), fauxAssistantMessage("ok")]);
		await off.session.prompt("Say local.");
		expect(getToolResult(off, "bash").content).toEqual([{ type: "text", text: "local\n" }]);
		expect(fake.requests).toHaveLength(0);
	});
});
