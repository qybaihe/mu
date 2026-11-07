import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNUSABLE_TEXT } from "../src/checkpoint/git.ts";
import {
	checkRepo,
	collectPatch,
	createWorktree,
	describeSummary,
	type GitRun,
	gitArgs,
	gitRunner,
	type Marker,
	markerPath,
	parseNameStatus,
	parseNumstat,
	type Repo,
	removeWorktree,
	runGit,
	sweepStaleWorktrees,
	writeMarker,
} from "../src/swarm/worktree.ts";
import { makeRepo, sh, tempArea } from "./fixtures/git-repo.ts";

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop() ?? "", { recursive: true, force: true });
});

function area(): string {
	const made = tempArea();
	roots.push(made.root);
	return made.dir;
}

async function repoOf(cwd: string): Promise<Repo> {
	const check = await checkRepo(runGit, cwd);
	if (!check.ok) throw new Error(check.message);
	return check.repo;
}

async function open(repo: string, dir: string, branch = "mu/agent-t-0") {
	const made = await createWorktree(runGit, { repo: await repoOf(repo), dir, branch, carry: true });
	if (!made.ok) throw new Error(made.message);
	return made;
}

describe("worktree: where it can be used", () => {
	it("says why a directory cannot host one: no repository, no commit, bare, an operation in progress, no git", async () => {
		const root = area();
		expect(await checkRepo(runGit, root)).toMatchObject({ ok: false, problem: "not-a-repo" });

		const empty = join(root, "empty");
		mkdirSync(empty);
		sh(empty, "init", "-q", ".");
		expect(await checkRepo(runGit, empty)).toMatchObject({ ok: false, problem: "no-commit" });

		const bare = join(root, "bare.git");
		mkdirSync(bare);
		sh(bare, "init", "-q", "--bare", ".");
		expect(await checkRepo(runGit, bare)).toMatchObject({ ok: false, problem: "bare" });

		const repo = makeRepo(root, { "src/a.txt": "a\n" });
		expect(await checkRepo(runGit, join(repo, ".git"))).toMatchObject({ ok: false, problem: "not-a-repo" });
		const fine = await checkRepo(runGit, join(repo, "src"));
		expect(fine).toMatchObject({ ok: true, repo: { prefix: "src/" } });
		// As git writes them: with forward slashes on Windows.
		expect(fine.ok && [resolve(fine.repo.root), resolve(fine.repo.gitDir)]).toEqual([repo, join(repo, ".git")]);

		writeFileSync(join(repo, ".git", "MERGE_HEAD"), "0".repeat(40));
		expect(await checkRepo(runGit, repo)).toMatchObject({
			ok: false,
			problem: "busy",
			message: expect.stringContaining("a merge"),
		});

		const noGit: GitRun = async () => ({
			code: -1,
			stdout: Buffer.alloc(0),
			stderr: "spawn git ENOENT",
			missing: true,
		});
		expect(await checkRepo(noGit, repo)).toMatchObject({ ok: false, problem: "no-git" });
	});

	// Found with the QA fixes, 2026-09-25: a subagent's checkout started git on a Mac without the developer tools,
	// whose /usr/bin/git only opens their installer, and read the Xcode license's exit as "not a repository".
	it("never starts a Mac's git without the developer tools, and says why git cannot run", async () => {
		const repo = makeRepo(area(), { "a.txt": "a\n" });
		let asked = 0;
		const stub = gitRunner({
			platform: "darwin",
			find: () => "/usr/bin/git",
			hasDeveloperTools: async () => {
				asked++;
				return false;
			},
		});
		// Started, git would find the repository.
		for (let run = 0; run < 2; run++) {
			expect(await checkRepo(stub, repo)).toEqual({
				ok: false,
				problem: "no-git",
				message: UNUSABLE_TEXT.developer_tools_missing,
			});
		}
		expect(asked).toBe(1);
	});

	it.skipIf(process.platform === "win32")(
		"reads git held back by the Xcode license as git that cannot run",
		async () => {
			const repo = makeRepo(area(), { "a.txt": "a\n" });
			const bin = area();
			writeFileSync(
				join(bin, "git"),
				`#!/bin/sh\necho "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'." >&2\nexit 69\n`,
				{ mode: 0o755 },
			);
			const run = gitRunner();
			const held: GitRun = (args, options) => run(args, { ...options, env: { PATH: bin } });
			expect(await held(["status"], { cwd: repo })).toMatchObject({
				code: 69,
				missing: true,
				unusable: "xcode_license",
			});
			expect(await checkRepo(held, repo)).toEqual({
				ok: false,
				problem: "no-git",
				message: UNUSABLE_TEXT.xcode_license,
			});
		},
	);

	it("adds the long-path switch on Windows only, and never lets safecrlf make hashing fatal", () => {
		expect(gitArgs(["status"], "win32")).toContain("core.longpaths=true");
		expect(gitArgs(["status"], "linux")).not.toContain("core.longpaths=true");
		expect(gitArgs(["status"], "darwin").slice(0, 2)).toEqual(["-c", "core.safecrlf=false"]);
		expect(gitArgs(["status"], "linux").at(-1)).toBe("status");
	});
});

describe("worktree: one task's isolated checkout", () => {
	it("is made outside the repository on its own branch, and is gone afterwards with its branch", async () => {
		const root = area();
		const repo = makeRepo(root, { "a.txt": "one\n" });
		const dir = join(root, "kyrn-swarm-t", "w0");
		const { worktree } = await open(repo, dir);

		expect(worktree).toMatchObject({ dir, cwd: dir, branch: "mu/agent-t-0" });
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n");
		expect(sh(repo, "branch", "--list", "mu/agent-*")).toContain("mu/agent-t-0");
		// The user's view of their own tree is what it was.
		expect(sh(repo, "status", "--porcelain")).toBe("");

		expect(await removeWorktree(runGit, worktree)).toEqual([]);
		expect(existsSync(dir)).toBe(false);
		expect(sh(repo, "branch", "--list", "mu/agent-*")).toBe("");
		expect(sh(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
	});

	it("shows the subagent the parent's uncommitted state, and keeps that state out of the patch", async () => {
		const root = area();
		const repo = makeRepo(root, { "src/a.txt": "one\ntwo\n", "staged.txt": "s\n", ".gitignore": "ignored/\n" });
		writeFileSync(join(repo, "src/a.txt"), "one\ntwo, edited by the parent\n");
		writeFileSync(join(repo, "staged.txt"), "staged by the parent\n");
		sh(repo, "add", "staged.txt");
		mkdirSync(join(repo, "notes 笔记"));
		writeFileSync(join(repo, "notes 笔记/新 file.txt"), "untracked\n");
		mkdirSync(join(repo, "ignored"));
		writeFileSync(join(repo, "ignored/secret.env"), "KEY=1\n");
		const before = sh(repo, "status", "--porcelain");

		const made = await createWorktree(runGit, {
			repo: await repoOf(join(repo, "src")),
			dir: join(root, "kyrn-swarm-t", "w0"),
			branch: "mu/agent-t-0",
			carry: true,
		});
		if (!made.ok) throw new Error(made.message);
		const { worktree, carried } = made;
		expect(carried).toEqual({ tracked: true, untracked: 1, skipped: [] });
		// It starts where the parent stands inside the repository.
		expect(worktree.cwd).toBe(join(worktree.dir, "src/"));
		expect(readFileSync(join(worktree.dir, "src/a.txt"), "utf8")).toContain("edited by the parent");
		expect(readFileSync(join(worktree.dir, "notes 笔记/新 file.txt"), "utf8")).toBe("untracked\n");
		expect(existsSync(join(worktree.dir, "ignored"))).toBe(false);
		expect(sh(worktree.dir, "status", "--porcelain")).toBe(before.replace("M  staged.txt", " M staged.txt"));

		writeFileSync(join(worktree.dir, "src/a.txt"), "one\ntwo, edited by the parent\nthree, by the worker\n");
		const collected = await collectPatch(runGit, worktree);
		if (!collected.ok) throw new Error(collected.message);
		expect(collected.summary.files).toEqual([
			{ path: "src/a.txt", status: "modified", insertions: 1, deletions: 0, binary: false },
		]);
		expect(collected.patch.toString()).not.toContain("untracked");
		expect(sh(repo, "status", "--porcelain")).toBe(before);
		await removeWorktree(runGit, worktree);
	});

	it("collects new, deleted, renamed, binary and CRLF files in one patch, committed by the worker or not", async () => {
		const root = area();
		const repo = makeRepo(root, {
			"keep.txt": "k\n",
			"gone.txt": "bye\n",
			"old name.txt": "same content\nline 2\nline 3\n",
			"bin.dat": Buffer.from([0, 1, 2, 255]),
			"win.txt": "alpha\r\nbeta\r\n",
		});
		const { worktree } = await open(repo, join(root, "kyrn-swarm-t", "w0"));
		const at = (path: string) => join(worktree.dir, path);
		writeFileSync(at("新文件.txt"), "new\n");
		rmSync(at("gone.txt"));
		sh(worktree.dir, "mv", "old name.txt", "new name.txt");
		writeFileSync(at("bin.dat"), Buffer.from([9, 0, 9]));
		writeFileSync(at("win.txt"), "alpha\r\nbeta, changed\r\n");
		// A worker that commits on its branch changes nothing about what comes back.
		sh(worktree.dir, "add", "-A");
		sh(worktree.dir, "commit", "-qm", "worker's own commit");
		writeFileSync(at("keep.txt"), "k\nafter the commit\n");

		const collected = await collectPatch(runGit, worktree);
		if (!collected.ok) throw new Error(collected.message);
		const byPath = Object.fromEntries(collected.summary.files.map((file) => [file.path, file]));
		expect(Object.keys(byPath).sort()).toEqual([
			"bin.dat",
			"gone.txt",
			"keep.txt",
			"new name.txt",
			"win.txt",
			"新文件.txt",
		]);
		expect(byPath["新文件.txt"]).toMatchObject({ status: "added", insertions: 1 });
		expect(byPath["gone.txt"]).toMatchObject({ status: "deleted", deletions: 1 });
		expect(byPath["new name.txt"]).toMatchObject({ status: "renamed", from: "old name.txt" });
		expect(byPath["bin.dat"]).toMatchObject({ status: "modified", binary: true });
		expect(describeSummary(collected.summary)).toBe("6 files changed, +3 -2");
		const patch = collected.patch.toString("latin1");
		expect(patch).toContain("GIT binary patch");
		expect(patch).toContain("+beta, changed\r\n");
		await removeWorktree(runGit, worktree);
	});

	it("works in a repository where safecrlf would make hashing a CRLF file fatal", async () => {
		const root = area();
		const repo = makeRepo(
			root,
			{ "win.txt": "alpha\r\nbeta\r\n" },
			{ "core.autocrlf": "input", "core.safecrlf": "true" },
		);
		writeFileSync(join(repo, "win.txt"), "alpha\r\nbeta\r\ngamma\r\n");
		const { worktree } = await open(repo, join(root, "kyrn-swarm-t", "w0"));
		writeFileSync(join(worktree.dir, "fresh.txt"), "new\r\nfile\r\n");
		const collected = await collectPatch(runGit, worktree);
		expect(collected).toMatchObject({ ok: true, summary: { files: [{ path: "fresh.txt", status: "added" }] } });
		await removeWorktree(runGit, worktree);
	});

	it("works when the parent is itself a linked worktree on a detached HEAD, as an agent's checkout is", async () => {
		const root = area();
		const repo = makeRepo(root, { "a.txt": "one\n" });
		const parent = join(root, "parent checkout");
		sh(repo, "worktree", "add", "--detach", parent, "HEAD");
		writeFileSync(join(parent, "a.txt"), "one\nparent's uncommitted line\n");

		const check = await checkRepo(runGit, parent);
		expect(check.ok && resolve(check.repo.root)).toBe(parent);
		// Its own git directory, where a merge or rebase of THIS checkout would leave its files.
		expect(check.ok && resolve(check.repo.gitDir)).toContain(join(".git", "worktrees"));

		const { worktree } = await open(parent, join(root, "kyrn-swarm-t", "w0"));
		expect(readFileSync(join(worktree.dir, "a.txt"), "utf8")).toContain("parent's uncommitted line");
		writeFileSync(join(worktree.dir, "b.txt"), "b\n");
		const collected = await collectPatch(runGit, worktree);
		expect(collected).toMatchObject({ ok: true, summary: { files: [{ path: "b.txt", status: "added" }] } });
		expect(await removeWorktree(runGit, worktree)).toEqual([]);
		// The parent checkout is still registered; ours is not.
		expect(sh(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
	});

	it("reports a checkout that cannot be made and leaves nothing behind", async () => {
		const root = area();
		const repo = makeRepo(root, { "a.txt": "one\n" });
		const first = await open(repo, join(root, "kyrn-swarm-t", "w0"));
		// The branch is taken: git refuses, and the directory of the second one must not linger.
		const second = await createWorktree(runGit, {
			repo: await repoOf(repo),
			dir: join(root, "kyrn-swarm-t", "w1"),
			branch: "mu/agent-t-0",
			carry: true,
		});
		expect(second).toMatchObject({ ok: false, message: expect.stringContaining("git worktree add failed") });
		expect(existsSync(join(root, "kyrn-swarm-t", "w1"))).toBe(false);
		await removeWorktree(runGit, first.worktree);
	});
});

describe("worktree: what a crash leaves behind", () => {
	async function leak(root: string, repo: string, index: number, patch: Partial<Marker> = {}): Promise<Marker> {
		const dir = join(root, "kyrn-swarm-dead", `w${index}`);
		const marker: Marker = {
			repoRoot: repo,
			dir,
			branch: `mu/agent-dead-${index}`,
			pid: 999_999,
			createdAt: 1000,
			...patch,
		};
		await writeMarker(marker);
		const made = await createWorktree(runGit, { repo: await repoOf(repo), dir, branch: marker.branch, carry: false });
		if (!made.ok) throw new Error(made.message);
		return marker;
	}

	it("sweeps the checkouts of dead sessions and leaves those of live ones alone", async () => {
		const root = area();
		const repo = makeRepo(root, { "a.txt": "one\n" });
		const dead = await leak(root, repo, 0);
		const live = await leak(root, repo, 1, { pid: 4242 });
		const released = await leak(root, repo, 2, { pid: 4242, released: true });
		// Somebody cleaned the temp directory by hand: git still has the registration and the branch.
		const halfGone = await leak(root, repo, 3);
		rmSync(halfGone.dir, { recursive: true, force: true });

		const swept = await sweepStaleWorktrees(runGit, { area: root, isAlive: (pid) => pid === 4242, now: 2000 });

		expect(swept.map((marker) => marker.dir).sort()).toEqual([dead.dir, released.dir, halfGone.dir].sort());
		expect(existsSync(dead.dir)).toBe(false);
		expect(existsSync(markerPath(dead.dir))).toBe(false);
		expect(existsSync(live.dir)).toBe(true);
		expect(sh(repo, "branch", "--format=%(refname:short)", "--list", "mu/agent-*").trim()).toBe("mu/agent-dead-1");
		expect(sh(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);

		// A recycled pid keeps nothing alive forever.
		const old = await sweepStaleWorktrees(runGit, { area: root, isAlive: () => true, now: 1000 + 25 * 3600_000 });
		expect(old.map((marker) => marker.dir)).toEqual([live.dir]);
		expect(sh(repo, "branch", "--list", "mu/agent-*")).toBe("");
	});

	it("never follows a marker that points somewhere else", async () => {
		const root = area();
		const repo = makeRepo(root, { "a.txt": "one\n" });
		const precious = join(root, "precious");
		mkdirSync(precious);
		mkdirSync(join(root, "kyrn-swarm-evil"));
		writeFileSync(
			join(root, "kyrn-swarm-evil", "w0.json"),
			JSON.stringify({ repoRoot: repo, dir: precious, branch: "main", pid: 1, createdAt: 0 }),
		);
		expect(await sweepStaleWorktrees(runGit, { area: root, isAlive: () => false })).toEqual([]);
		expect(existsSync(precious)).toBe(true);
		expect(sh(repo, "branch", "--list", "main")).toContain("main");
	});
});

describe("worktree: reading git's machine output", () => {
	it("reads statuses and line counts, renames and binary files included", () => {
		expect(parseNameStatus(["M", "a.txt", "R100", "old.txt", "new.txt", "A", "b c.txt", "D", "gone"])).toEqual([
			{ status: "modified", path: "a.txt" },
			{ status: "renamed", from: "old.txt", path: "new.txt" },
			{ status: "added", path: "b c.txt" },
			{ status: "deleted", path: "gone" },
		]);
		const counts = parseNumstat(["3\t1\ta.txt", "-\t-\tbin.dat", "0\t0\t", "old.txt", "new.txt", ""]);
		expect(counts.get("a.txt")).toEqual({ insertions: 3, deletions: 1, binary: false });
		expect(counts.get("bin.dat")).toEqual({ insertions: 0, deletions: 0, binary: true });
		expect(counts.get("new.txt")).toEqual({ insertions: 0, deletions: 0, binary: false });
	});
});
