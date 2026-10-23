import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitMissing, type GitRun, shadowEnv, spawnGit, TIMED_OUT } from "../src/checkpoint/git.ts";
import {
	applyRestore,
	diff,
	hasCommit,
	isSafePath,
	isWithin,
	openStore,
	ownFolderPatterns,
	planRestore,
	projectKey,
	prune,
	releaseLocks,
	SnapshotTooLarge,
	scan,
	snapshot,
	sweepProjects,
} from "../src/checkpoint/store.ts";

const temps: string[] = [];
function temp(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	temps.push(dir);
	return dir;
}
afterEach(() => {
	while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

function write(root: string, path: string, content: string | Buffer): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
}
const read = (root: string, path: string): string => readFileSync(join(root, path), "utf8");

/** The user's own git, in a throwaway repository, isolated from this machine's global settings. */
function userGit(cwd: string, ...args: string[]): string {
	const env: Record<string, string> = {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(cwd, "..", "no-global-config"),
	};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
	}
	for (const who of ["AUTHOR", "COMMITTER"]) {
		env[`GIT_${who}_NAME`] = "Test User";
		env[`GIT_${who}_EMAIL`] = "user@example.com";
	}
	return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

async function open(root: string, options: { maxFileBytes?: number; ignore?: string[]; run?: GitRun } = {}) {
	return openStore({ baseDir: temp("mu-shadow-"), root, run: options.run ?? spawnGit(), ...options });
}

describe("checkpoint store", () => {
	it("restores changed, created and deleted files in a folder that is no repository", async () => {
		const root = temp("mu-plain-");
		write(root, "src/app.ts", "v1\n");
		write(root, "docs/old notes.md", "keep me\n");
		write(root, "数据/说明 文件.txt", "原文\n");
		const store = await open(root);
		const first = await snapshot(store, "s/1");

		write(root, "src/app.ts", "v2 broken\n");
		write(root, "src/new/deep/feature.ts", "created by the attempt\n");
		rmSync(join(root, "docs/old notes.md"));
		write(root, "数据/说明 文件.txt", "改坏了\n");

		const plan = await planRestore(store, first.commit, (await scan(store)).tree);
		expect([...plan.restore].sort()).toEqual(["src/app.ts", "数据/说明 文件.txt"]);
		expect(plan.remove).toEqual(["src/new/deep/feature.ts"]);
		expect(plan.bringBack).toEqual(["docs/old notes.md"]);

		const result = await applyRestore(store, plan);
		expect(result.leftAlone).toEqual([]);
		expect(read(root, "src/app.ts")).toBe("v1\n");
		expect(read(root, "docs/old notes.md")).toBe("keep me\n");
		expect(read(root, "数据/说明 文件.txt")).toBe("原文\n");
		// The folders the attempt created go with its file; the folder that was there stays.
		expect(existsSync(join(root, "src/new"))).toBe(false);
		expect(existsSync(join(root, "src"))).toBe(true);
		expect(await diff(store, first.commit, (await scan(store)).tree)).toEqual([]);
		expect(existsSync(join(root, ".git"))).toBe(false);
	});

	it("leaves the user's repository byte for byte as it was: index, HEAD, refs, stash and hooks", async () => {
		const root = temp("mu-repo-");
		userGit(root, "init", "--quiet", "-b", "main");
		write(root, "tracked.txt", "committed\n");
		write(root, ".gitignore", "secret.env\nlogs/\n");
		userGit(root, "add", ".");
		userGit(root, "commit", "--quiet", "-m", "first");
		write(root, "stashed.txt", "stash me\n");
		userGit(root, "add", "stashed.txt");
		userGit(root, "stash", "--quiet");
		// A dirty index the user cares about: one staged edit, one staged new file, one unstaged edit on top.
		write(root, "tracked.txt", "staged edit\n");
		write(root, "staged-new.txt", "staged\n");
		userGit(root, "add", "tracked.txt", "staged-new.txt");
		write(root, "tracked.txt", "staged edit\nplus an unstaged line\n");
		write(root, "untracked.txt", "untracked\n");
		let hookRan = false;
		write(root, ".git/hooks/reference-transaction", "#!/bin/sh\ntouch hook-ran\n");
		chmodSync(join(root, ".git/hooks/reference-transaction"), 0o755);

		const state = () => ({
			status: userGit(root, "status", "--porcelain=v2", "--untracked-files=all"),
			cached: userGit(root, "diff", "--cached"),
			head: userGit(root, "rev-parse", "HEAD"),
			refs: userGit(root, "for-each-ref"),
			stash: userGit(root, "stash", "list"),
		});
		// `git status` itself refreshes the index, so the raw bytes are compared with no user command in between.
		const rawIndex = () => readFileSync(join(root, ".git/index")).toString("base64");
		const before = state();
		const indexBefore = rawIndex();

		// Even an agent started from inside a git hook, where GIT_INDEX_FILE names the real index.
		const store = await openStore({
			baseDir: temp("mu-shadow-"),
			root,
			run: spawnGit(),
			env: { ...process.env, GIT_INDEX_FILE: join(root, ".git/index"), GIT_DIR: join(root, ".git") },
		});
		const first = await snapshot(store, "s/1");
		write(root, "tracked.txt", "the agent rewrote this\n");
		write(root, "agent-file.txt", "new\n");
		rmSync(join(root, "staged-new.txt"));
		const result = await applyRestore(store, await planRestore(store, first.commit, (await scan(store)).tree));
		hookRan = existsSync(join(root, "hook-ran"));
		expect(rawIndex()).toBe(indexBefore);

		expect([...result.restored, ...result.removed, ...result.broughtBack].sort()).toEqual([
			"agent-file.txt",
			"staged-new.txt",
			"tracked.txt",
		]);
		expect(read(root, "tracked.txt")).toBe("staged edit\nplus an unstaged line\n");
		expect(state()).toEqual(before);
		expect(hookRan).toBe(false);
		expect(readdirSync(store.gitDir)).toContain("mu-project.json");
	});

	it("never overwrites or deletes what it did not snapshot: ignored files, oversized files, nested repositories", async () => {
		const root = temp("mu-ignored-");
		write(root, ".gitignore", "private-notes.txt\n");
		write(root, "private-notes.txt", "TOKEN=original\n");
		write(root, "node_modules/pkg/index.js", "module.exports = 1;\n");
		write(root, "big.bin", Buffer.alloc(4096, 1));
		write(root, "small-then.txt", "small\n");
		write(root, "vendor/lib/file.txt", "somebody else's history\n");
		userGit(join(root, "vendor/lib"), "init", "--quiet");
		write(root, "app.ts", "v1\n");
		const store = await open(root, { maxFileBytes: 1024 });
		const first = await snapshot(store, "s/1");
		expect(
			userGit(root, "--git-dir", store.gitDir, "ls-tree", "-r", "--name-only", first.commit)
				.split("\n")
				.filter(Boolean),
		).toEqual([".gitignore", "app.ts", "small-then.txt"]);

		// The attempt un-ignores the secret, shrinks the big file, drops the nested repository's .git, and grows a small file.
		write(root, ".gitignore", "\n");
		write(root, "private-notes.txt", "TOKEN=changed\n");
		write(root, "big.bin", "now small\n");
		rmSync(join(root, "vendor/lib/.git"), { recursive: true });
		write(root, "small-then.txt", Buffer.alloc(4096, 2));
		write(root, "node_modules/pkg/index.js", "module.exports = 2;\n");
		write(root, "app.ts", "v2\n");

		const plan = await planRestore(store, first.commit, (await scan(store)).tree);
		expect(plan.remove).toEqual([]);
		expect(plan.leftAlone.map((entry) => entry.path).sort()).toEqual([
			"big.bin",
			"private-notes.txt",
			"vendor/lib/file.txt",
		]);
		const result = await applyRestore(store, plan);

		expect(read(root, "app.ts")).toBe("v1\n");
		expect(read(root, ".gitignore")).toBe("private-notes.txt\n");
		expect(read(root, "private-notes.txt")).toBe("TOKEN=changed\n");
		expect(read(root, "big.bin")).toBe("now small\n");
		expect(read(root, "vendor/lib/file.txt")).toBe("somebody else's history\n");
		expect(read(root, "node_modules/pkg/index.js")).toBe("module.exports = 2;\n");
		// It grew past the cap, so its current content is in no snapshot: not replaced by the old small one.
		expect(statSync(join(root, "small-then.txt")).size).toBe(4096);
		expect(result.leftAlone.find((entry) => entry.path === "small-then.txt")?.why).toContain("ignored or too large");
	});

	it("keeps secret files out of snapshots, also ones an older mu took in, and keeps the snapshots private", async () => {
		const root = temp("mu-secrets-");
		write(root, "src/app.ts", "v1\n");
		write(root, ".env", "API_KEY=sk-live-1\n");
		write(root, ".env.example", "API_KEY=\n");
		write(root, "config/prod.env", "DB_PASSWORD=hunter2\n");
		write(root, ".env.local", "API_KEY=sk-live-2\n");
		write(root, "certs/server.key", "-----BEGIN PRIVATE KEY-----\n");
		write(root, "deploy/id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
		write(root, "deploy/id_ed25519.pub", "ssh-ed25519 AAAA\n");
		const base = temp("mu-shadow-");
		const files = async (store: Awaited<ReturnType<typeof openStore>>, commit: string) =>
			userGit(root, "--git-dir", store.gitDir, "ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean);

		// An older mu, without the secret rules, took everything in.
		const older = await openStore({ baseDir: base, root, run: spawnGit(), ignore: [] });
		expect(await files(older, (await snapshot(older, "s/1")).commit)).toContain(".env");

		const store = await openStore({ baseDir: base, root, run: spawnGit() });
		write(root, ".env", "API_KEY=sk-live-3\n");
		const now = await snapshot(store, "s/2");
		expect(await files(store, now.commit)).toEqual([".env.example", "deploy/id_ed25519.pub", "src/app.ts"]);
		if (process.platform !== "win32") expect(statSync(store.gitDir).mode & 0o777).toBe(0o700);

		// A secret the attempt changed is left as it is: it is in no snapshot to go back to.
		write(root, ".env", "API_KEY=broken\n");
		write(root, "src/app.ts", "v2\n");
		await applyRestore(store, await planRestore(store, now.commit, (await scan(store)).tree));
		expect(read(root, "src/app.ts")).toBe("v1\n");
		expect(read(root, ".env")).toBe("API_KEY=broken\n");
	});

	it("does not clear a folder that took a file's place, and keeps the files the user asked to keep", async () => {
		const root = temp("mu-obstacle-");
		write(root, "data", "a file\n");
		write(root, "mine.txt", "v1\n");
		write(root, "theirs.txt", "v1\n");
		const store = await open(root, { ignore: ["*.cache"] });
		const first = await snapshot(store, "s/1");

		rmSync(join(root, "data"));
		write(root, "data/keep.cache", "ignored, so in no snapshot\n");
		write(root, "mine.txt", "edited by hand\n");
		write(root, "theirs.txt", "v2\n");
		const plan = await planRestore(store, first.commit, (await scan(store)).tree);
		const result = await applyRestore(store, plan, new Set(["mine.txt"]));

		expect(read(root, "data/keep.cache")).toBe("ignored, so in no snapshot\n");
		expect(read(root, "mine.txt")).toBe("edited by hand\n");
		expect(read(root, "theirs.txt")).toBe("v1\n");
		expect(result.leftAlone.map((entry) => [entry.path, entry.why])).toEqual([
			["mine.txt", "kept as it is, as asked"],
			["data", "a folder is in the way"],
		]);
	});

	it.skipIf(process.platform === "win32")(
		"does not remove through an ancestor symlink, and does not call permission errors removed",
		async () => {
			const root = temp("mu-remove-safe-");
			const outside = temp("mu-remove-outside-");
			write(outside, "secret.txt", "must survive\n");
			symlinkSync(outside, join(root, "link"), "dir");
			const store = await open(root);

			const result = await applyRestore(store, {
				commit: "not-used",
				restore: [],
				remove: ["link/secret.txt"],
				bringBack: [],
				leftAlone: [],
			});
			expect(result.removed).toEqual([]);
			expect(result.leftAlone).toEqual([
				{ path: "link/secret.txt", why: "a file or symlink is where its folder should be" },
			]);
			expect(read(outside, "secret.txt")).toBe("must survive\n");

			write(root, "blocked.txt", "do not remove\n");
			chmodSync(root, 0o555);
			await expect(
				applyRestore(store, {
					commit: "not-used",
					restore: [],
					remove: ["blocked.txt"],
					bringBack: [],
					leftAlone: [],
				}),
			).rejects.toMatchObject({ code: "EACCES" });
			chmodSync(root, 0o755);
			expect(read(root, "blocked.txt")).toBe("do not remove\n");
		},
	);

	it.skipIf(process.platform === "win32")(
		"brings symlinks back as symlinks, and modes and line endings as they were",
		async () => {
			const root = temp("mu-links-");
			write(root, ".gitattributes", "* text=auto eol=lf\n");
			write(root, "windows.txt", "line one\r\nline two\r\n");
			write(root, "run.sh", "#!/bin/sh\necho hi\n");
			chmodSync(join(root, "run.sh"), 0o755);
			write(root, "target dir/inside.txt", "x\n");
			symlinkSync("target dir", join(root, "link to dir"));
			symlinkSync("windows.txt", join(root, "link.txt"));
			const store = await open(root);
			const first = await snapshot(store, "s/1");

			rmSync(join(root, "link to dir"));
			rmSync(join(root, "link.txt"));
			write(root, "link.txt", "now a plain file\n");
			write(root, "windows.txt", "rewritten\n");
			write(root, "run.sh", "rewritten\n");
			chmodSync(join(root, "run.sh"), 0o644);
			await applyRestore(store, await planRestore(store, first.commit, (await scan(store)).tree));

			expect(lstatSync(join(root, "link to dir")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(root, "link to dir"))).toBe("target dir");
			expect(lstatSync(join(root, "link.txt")).isSymbolicLink()).toBe(true);
			expect(readFileSync(join(root, "windows.txt")).toString("latin1")).toBe("line one\r\nline two\r\n");
			expect(statSync(join(root, "run.sh")).mode & 0o111).toBe(0o111);
			expect(read(root, "target dir/inside.txt")).toBe("x\n");
		},
	);

	it("keeps the newest snapshots of a project and drops the ones that are too old", async () => {
		const root = temp("mu-prune-");
		write(root, "a.txt", "1\n");
		const store = await open(root);
		const commits: string[] = [];
		for (let index = 1; index <= 4; index++) {
			write(root, "a.txt", `${index}\n`);
			commits.push((await snapshot(store, `s/${index}`)).commit);
		}
		expect(await prune(store, { keep: 3, maxAgeDays: 14 })).toBeGreaterThanOrEqual(1);
		const refs = userGit(root, "--git-dir", store.gitDir, "for-each-ref", "--format=%(refname)")
			.split("\n")
			.filter(Boolean);
		expect(refs).toHaveLength(3);
		expect(await hasCommit(store, commits[3])).toBe(true);
		expect(await hasCommit(store, "not-a-commit")).toBe(false);
		// Two weeks from now every one of them is too old, however few there are.
		expect(await prune(store, { keep: 3, maxAgeDays: 14, now: Date.now() + 15 * 86_400_000 })).toBe(3);
	});

	it("sweeps the shadow repositories of projects nobody opened for a long time, and nothing else", async () => {
		const root = temp("mu-sweep-");
		write(root, "a.txt", "1\n");
		const store = await open(root);
		const base = dirname(store.gitDir);
		mkdirSync(join(base, "not-ours"));
		writeFileSync(join(base, "not-ours", "data.txt"), "somebody else's folder");

		expect(sweepProjects(base, 30)).toEqual([]);
		expect(sweepProjects(base, 30, Date.now() + 31 * 86_400_000)).toEqual([projectKey(root)]);
		expect(existsSync(store.gitDir)).toBe(false);
		expect(existsSync(join(base, "not-ours", "data.txt"))).toBe(true);

		// A folder that may not be snapshotted any more (a home folder an older mu took in) goes at once.
		const again = await openStore({ baseDir: base, root, run: spawnGit() });
		expect(sweepProjects(base, 30, Date.now(), (project) => project !== root)).toEqual([]);
		expect(sweepProjects(base, 30, Date.now(), (project) => project === root)).toEqual([projectKey(root)]);
		expect(existsSync(again.gitDir)).toBe(false);
		expect(existsSync(join(base, "not-ours", "data.txt"))).toBe(true);
	});

	it("clears a lock a dead process left behind, but not one that is fresh", async () => {
		const root = temp("mu-locks-");
		write(root, "a.txt", "1\n");
		const store = await open(root);
		const lock = join(store.gitDir, "index.lock");
		writeFileSync(lock, "");
		releaseLocks(store, 120_000);
		expect(existsSync(lock)).toBe(true);
		await expect(scan(store)).rejects.toThrow(/index\.lock|lock/i);

		const old = new Date(Date.now() - 600_000);
		utimesSync(lock, old, old);
		await openStore({ baseDir: dirname(store.gitDir), root, run: spawnGit() });
		expect(existsSync(lock)).toBe(false);
		expect((await scan(store)).tree).toMatch(/^[0-9a-f]{40,64}$/);
	});

	it("says that git is missing instead of failing in some other way", async () => {
		const root = temp("mu-nogit-");
		await expect(
			openStore({ baseDir: temp("mu-shadow-"), root, run: spawnGit("mu-test-no-such-git-binary") }),
		).rejects.toBeInstanceOf(GitMissing);
	});

	// mu 0.1.3 run in a home folder: the first snapshot took in ~/.mu, the snapshots themselves among it, so every
	// later snapshot copied the store's own new objects again, and the store grew with every turn that changed a file.
	it("never snapshots mu's own folders, the snapshots among them, and reads their names literally", async () => {
		const root = temp("mu-own-");
		write(root, "src/app.ts", "v1\n");
		write(root, ".mu/agent/sessions/one.jsonl", '{"type":"session"}\n');
		write(root, "[odd] dir/x.txt", "mu's\n");
		// What "[odd] dir" would match as a pattern: it is the user's, and stays in.
		write(root, "o dir/y.txt", "the user's\n");
		const store = await openStore({
			baseDir: join(root, ".mu", "agent", "mu", "checkpoints"),
			root,
			run: spawnGit(),
			ownFolders: [join(root, ".mu"), join(root, "[odd] dir")],
		});
		await snapshot(store, "s/1");
		// The second snapshot sees what the first one wrote into the store.
		write(root, "src/app.ts", "v2\n");
		const second = await snapshot(store, "s/2");
		const listed = await store.run(["ls-tree", "-r", "-z", "--name-only", second.commit], store.env);
		expect(listed.stdout.split("\0").filter(Boolean).sort()).toEqual(["o dir/y.txt", "src/app.ts"]);
	});

	it("stops a scan past its limits before it writes anything, and the listing at the limit", async () => {
		const root = temp("mu-limits-");
		for (let index = 0; index < 40; index++) write(root, `data/file-${index}.txt`, "0123456789\n");
		const store = await open(root);
		const objects = () => readdirSync(join(store.gitDir, "objects")).filter((name) => /^[0-9a-f]{2}$/.test(name));

		const tooMany = await scan(store, { maxFiles: 10, maxBytes: 1024 * 1024 }).catch((error: unknown) => error);
		expect(tooMany).toBeInstanceOf(SnapshotTooLarge);
		expect((tooMany as SnapshotTooLarge).reason).toBe("files");
		const tooBig = await scan(store, { maxFiles: 100, maxBytes: 100 }).catch((error: unknown) => error);
		expect((tooBig as SnapshotTooLarge).reason).toBe("bytes");
		expect(objects()).toEqual([]);

		// git itself is ended once its listing passes the limit, and what it would still print is not kept.
		const list = ["ls-files", "-z", "--others", "--exclude-standard"];
		expect((await spawnGit()(list, store.env, undefined, { maxEntries: 10 })).truncated).toBe(true);
		expect((await spawnGit()(list, store.env, undefined, { maxEntries: 40 })).truncated).toBeUndefined();

		// A listing that outlives the time limit counts as too large, not as one failed turn.
		const slow: GitRun = (args, env, input, limit) =>
			args[0] === "ls-files"
				? Promise.resolve({ code: TIMED_OUT, stdout: "", stderr: "timed out" })
				: spawnGit()(args, env, input, limit);
		const slowReason = await scan({ ...store, run: slow }, { maxFiles: 100, maxBytes: 1024 * 1024 }).catch(
			(error: unknown) => (error as SnapshotTooLarge).reason,
		);
		expect(slowReason).toBe("slow");

		expect((await scan(store, { maxFiles: 40, maxBytes: 1024 * 1024 })).tree).toMatch(/^[0-9a-f]{40,64}$/);
		expect(objects().length).toBeGreaterThan(0);
	});
});

describe("checkpoint paths and environment", () => {
	it("drops every inherited GIT_ variable and points git at the shadow only", () => {
		const env = shadowEnv(
			{
				PATH: "/bin",
				GIT_DIR: "/real/.git",
				GIT_INDEX_FILE: "/real/.git/index",
				git_work_tree: "/real",
				HOME: "/home/u",
			},
			"/shadow",
			"/project",
		);
		expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/u", GIT_DIR: "/shadow", GIT_WORK_TREE: "/project" });
		expect(env.GIT_INDEX_FILE).toBe(join("/shadow", "index"));
		expect(env.git_work_tree).toBeUndefined();
	});

	it("tells which folders lie inside the project, through symlinks, and anchors their patterns at it", () => {
		const root = temp("mu-within-");
		mkdirSync(join(root, "project", ".agent"), { recursive: true });
		symlinkSync(join(root, "project"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
		const project = join(root, "project");
		expect(isWithin(project, project)).toBe(true);
		expect(isWithin(join(root, "link"), join(project, ".agent"))).toBe(true);
		expect(isWithin(project, join(project, "not-yet", "made"))).toBe(true);
		expect(isWithin(project, root)).toBe(false);
		expect(isWithin(project, join(root, "project-2"))).toBe(false);
		// A name that only starts with two dots is a folder like any other.
		expect(isWithin(project, join(project, "..hidden"))).toBe(true);

		expect(
			ownFolderPatterns(join(root, "link"), [
				project,
				join(project, ".agent"),
				join(project, "a [b]", "c*"),
				join(root, "elsewhere"),
			]),
		).toEqual(["/.agent/", "/a \\[b\\]/c\\*/"]);
	});

	it("accepts only relative paths inside the project that are not part of a repository's own folder", () => {
		for (const path of ["src/a.ts", "with space/文件.txt", ".github/workflows/ci.yml", ".gitignore"]) {
			expect(isSafePath(path), path).toBe(true);
		}
		for (const path of [
			"",
			"/etc/passwd",
			"../up.txt",
			"a/../../b",
			"C:/Windows/x",
			"a\\b",
			".git/config",
			"sub/.GIT/hooks/x",
			"GIT~1/config",
			"a//b",
		]) {
			expect(isSafePath(path), path).toBe(false);
		}
	});
});
