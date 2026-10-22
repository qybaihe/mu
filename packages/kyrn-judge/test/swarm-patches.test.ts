import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyPatch,
	describeRecord,
	fileSection,
	type PatchRecord,
	PatchStore,
	patchPreview,
	readPatch,
	statLines,
} from "../src/swarm/patches.ts";
import { checkRepo, collectPatch, createWorktree, removeWorktree, runGit } from "../src/swarm/worktree.ts";
import { makeRepo, sh, tempArea } from "./fixtures/git-repo.ts";

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop() ?? "", { recursive: true, force: true });
});

function area(): string {
	const made = tempArea("kyrn-patch-test-");
	roots.push(made.root);
	return made.dir;
}

const lines = (count: number) => `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
const edit = (path: string, change: (text: string) => string) =>
	writeFileSync(path, change(readFileSync(path, "utf8")));

let counter = 0;
/** One isolated worker from start to end: checkout, its changes, the patch in the store, checkout gone. */
async function work(
	store: PatchStore,
	root: string,
	repo: string,
	change: (dir: string) => void,
): Promise<PatchRecord> {
	const check = await checkRepo(runGit, repo);
	if (!check.ok) throw new Error(check.message);
	const index = counter++;
	const made = await createWorktree(runGit, {
		repo: check.repo,
		dir: join(root, "kyrn-swarm-t", `w${index}`),
		branch: `mu/agent-t-${index}`,
		carry: true,
	});
	if (!made.ok) throw new Error(made.message);
	change(made.worktree.dir);
	const collected = await collectPatch(runGit, made.worktree);
	if (!collected.ok) throw new Error(collected.message);
	expect(await removeWorktree(runGit, made.worktree)).toEqual([]);
	return store.save(join(root, "kyrn-swarm-t", "patches"), collected.patch, {
		task: `task ${index}`,
		role: "worker",
		repoRoot: repo,
		summary: collected.summary,
	});
}

const apply = (root: string, record: PatchRecord, onConflict: "abort" | "markers" = "abort") =>
	applyPatch(runGit, {
		repoRoot: record.repoRoot,
		patchPath: record.path,
		files: record.summary.files,
		onConflict,
		scratchDir: join(root, "kyrn-swarm-t", "scratch"),
	});

/** Everything a user would notice: what git reports, and the bytes of every file it names. */
function fingerprint(repo: string): string {
	const status = sh(repo, "status", "--porcelain", "--untracked-files=all");
	const staged = sh(repo, "diff", "--cached");
	return `${status}\n${staged}`;
}

describe("applying a subagent's patch", () => {
	it("brings new, deleted, renamed, binary and CRLF changes into the working tree and leaves the index alone", async () => {
		const root = area();
		const repo = makeRepo(root, {
			"a.txt": lines(6),
			"gone.txt": "bye\n",
			"old name.txt": "same\ncontent\nhere\n",
			"bin.dat": Buffer.from([0, 1, 2, 255]),
			"win.txt": "alpha\r\nbeta\r\n",
			"mine.txt": "m\n",
		});
		// Half of the user's next commit is staged. It has to be exactly that afterwards.
		writeFileSync(join(repo, "mine.txt"), "staged by the user\n");
		sh(repo, "add", "mine.txt");
		const stagedBefore = sh(repo, "diff", "--cached");

		const record = await work(new PatchStore(), root, repo, (dir) => {
			edit(join(dir, "a.txt"), (text) => text.replace("line 2", "line 2, by the worker"));
			writeFileSync(join(dir, "新文件.txt"), "new\n");
			rmSync(join(dir, "gone.txt"));
			sh(dir, "mv", "old name.txt", "new name.txt");
			writeFileSync(join(dir, "bin.dat"), Buffer.from([9, 0, 9]));
			edit(join(dir, "win.txt"), (text) => text.replace("beta", "beta, changed"));
		});

		expect(await apply(root, record)).toEqual({
			status: "applied",
			files: record.summary.files.map((file) => file.path),
		});
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toContain("line 2, by the worker");
		expect(readFileSync(join(repo, "新文件.txt"), "utf8")).toBe("new\n");
		expect(existsSync(join(repo, "gone.txt"))).toBe(false);
		expect(existsSync(join(repo, "old name.txt"))).toBe(false);
		expect(readFileSync(join(repo, "new name.txt"), "utf8")).toBe("same\ncontent\nhere\n");
		expect([...readFileSync(join(repo, "bin.dat"))]).toEqual([9, 0, 9]);
		expect(readFileSync(join(repo, "win.txt"), "utf8")).toBe("alpha\r\nbeta, changed\r\n");
		// Nothing of the worker's is staged, nothing of the user's is unstaged, no scratch file is left.
		expect(sh(repo, "diff", "--cached")).toBe(stagedBefore);
		expect(sh(repo, "status", "--porcelain")).toContain(" M a.txt");
		expect(existsSync(join(root, "kyrn-swarm-t", "scratch"))).toBe(true);
		expect(sh(repo, "status", "--porcelain")).not.toContain("index-");

		expect(await apply(root, record)).toEqual({ status: "already-applied" });
	});

	it("merges a second worker's patch into the same file, and refuses as a whole when the same lines changed", async () => {
		const root = area();
		const repo = makeRepo(root, { "a.txt": lines(20), "other.txt": "o\n" });
		const store = new PatchStore();
		// Three workers started from the same state, as parallel workers do.
		const one = await work(store, root, repo, (dir) =>
			edit(join(dir, "a.txt"), (text) => text.replace("line 2\n", "line 2, by ONE\n")),
		);
		const two = await work(store, root, repo, (dir) => {
			edit(join(dir, "a.txt"), (text) => text.replace("line 2\n", "line 2, by TWO\n"));
			writeFileSync(join(dir, "other.txt"), "o\nby TWO\n");
		});
		const three = await work(store, root, repo, (dir) =>
			edit(join(dir, "a.txt"), (text) => text.replace("line 18\n", "line 18, by THREE\n")),
		);

		expect((await apply(root, one)).status).toBe("applied");
		expect((await apply(root, three)).status).toBe("applied");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toContain("line 18, by THREE");

		const before = fingerprint(repo);
		const content = readFileSync(join(repo, "a.txt"), "utf8");
		expect(await apply(root, two)).toEqual({ status: "conflicts", files: ["a.txt"] });
		// All or nothing: not even the file that would have applied cleanly was touched.
		expect(fingerprint(repo)).toBe(before);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe(content);
		expect(readFileSync(join(repo, "other.txt"), "utf8")).toBe("o\n");
		expect(readPatch(two)?.length).toBeGreaterThan(0);

		// Asked for: what merges goes in, and the rest carries markers. The user's index still has no conflict state.
		expect(await apply(root, two, "markers")).toEqual({
			status: "applied-with-conflicts",
			conflicted: ["a.txt"],
			clean: ["other.txt"],
		});
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toMatch(
			/<<<<<<< ours\nline 2, by ONE\n=======\nline 2, by TWO\n>>>>>>> theirs/,
		);
		expect(readFileSync(join(repo, "other.txt"), "utf8")).toBe("o\nby TWO\n");
		expect(sh(repo, "ls-files", "-u")).toBe("");
	});

	it("keeps what the parent changed in the same file after the worker had started", async () => {
		const root = area();
		const repo = makeRepo(root, { "a.txt": lines(20) });
		const record = await work(new PatchStore(), root, repo, (dir) =>
			edit(join(dir, "a.txt"), (text) => text.replace("line 3\n", "line 3, by the worker\n")),
		);
		edit(join(repo, "a.txt"), (text) => text.replace("line 17\n", "line 17, by the parent\n"));

		expect((await apply(root, record)).status).toBe("applied");
		const merged = readFileSync(join(repo, "a.txt"), "utf8");
		expect(merged).toContain("line 3, by the worker");
		expect(merged).toContain("line 17, by the parent");
	});

	it("says which file stops a patch that cannot apply at all, and changes nothing", async () => {
		const root = area();
		const repo = makeRepo(root, { "a.txt": lines(6), "b.txt": "b\n" });
		const record = await work(new PatchStore(), root, repo, (dir) => {
			edit(join(dir, "a.txt"), (text) => text.replace("line 2", "line 2, by the worker"));
			writeFileSync(join(dir, "b.txt"), "b\nmore\n");
		});
		rmSync(join(repo, "a.txt"));
		const before = fingerprint(repo);

		const result = await apply(root, record);
		expect(result.status).toBe("failed");
		expect(result.status === "failed" && result.reasons.join("\n")).toContain("a.txt");
		expect(fingerprint(repo)).toBe(before);
		expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("b\n");
	});

	it.each([
		// The usual Windows setting: LF in the repository, CRLF on disk. The file keeps its CRLF.
		["core.autocrlf=true", { "core.autocrlf": "true" }, "\r\n"],
		// `input` checks files out with LF, so a file git rewrites comes back with LF: git's own rule, not ours.
		// What matters here is that safecrlf=true, which makes hashing a CRLF file fatal, stops nothing.
		["core.autocrlf=input with safecrlf", { "core.autocrlf": "input", "core.safecrlf": "true" }, "\n"],
	])("round-trips CRLF files under %s", async (_name, config, eol) => {
		const root = area();
		const repo = makeRepo(root, { "win.txt": "alpha\r\nbeta\r\ngamma\r\n" }, config);
		edit(join(repo, "win.txt"), (text) => text.replace("gamma", "gamma (parent)"));
		const record = await work(new PatchStore(), root, repo, (dir) => {
			edit(join(dir, "win.txt"), (text) => text.replace("alpha", "alpha (worker)"));
			writeFileSync(join(dir, "fresh.txt"), "new\r\nfile\r\n");
		});

		expect((await apply(root, record)).status).toBe("applied");
		expect(readFileSync(join(repo, "win.txt"), "utf8")).toBe(
			["alpha (worker)", "beta", "gamma (parent)", ""].join(eol),
		);
		expect(readFileSync(join(repo, "fresh.txt"), "utf8")).toBe(["new", "file", ""].join(eol));
	});
});

describe("looking at a patch before applying it", () => {
	it("lists the files, cuts one file's diff out, and never shows binary content", async () => {
		const root = area();
		const repo = makeRepo(root, { "src/a.txt": lines(4), "bin.dat": Buffer.from([0, 1, 2, 255]) });
		const store = new PatchStore();
		const record = await work(store, root, repo, (dir) => {
			edit(join(dir, "src/a.txt"), (text) => text.replace("line 2", "line 2, changed"));
			writeFileSync(join(dir, "文档 notes.md"), "# 标题\n");
			writeFileSync(join(dir, "bin.dat"), Buffer.from([7, 7, 0]));
		});
		const patch = readPatch(record) ?? Buffer.alloc(0);

		expect(statLines(record.summary)).toEqual(["M bin.dat (binary)", "M src/a.txt +1 -1", "A 文档 notes.md +1 -0"]);
		expect(describeRecord(record)).toBe(`${record.id} ready · task ${counter - 1} (worker) · 3 files changed, +2 -1`);
		const section = fileSection(patch, { path: "src/a.txt" }) ?? "";
		expect(section).toContain("+line 2, changed");
		expect(section).not.toContain("标题");
		expect(fileSection(patch, { path: "文档 notes.md" })).toContain("+# 标题");
		expect(fileSection(patch, { path: "bin.dat" })).toContain("(binary content, not shown)");
		expect(fileSection(patch, { path: "nope.txt" })).toBeUndefined();
		const preview = patchPreview(patch, record.summary.files, 8);
		expect(preview.split("\n")).toHaveLength(9);
		expect(preview).toContain("more lines");

		// The record sits beside the patch for people and the desktop app, and follows the status.
		store.setStatus(record.id, "applied");
		expect(JSON.parse(readFileSync(record.path.replace(/\.patch$/, ".json"), "utf8"))).toMatchObject({
			id: record.id,
			status: "applied",
		});
		expect(store.get(` ${record.id} `)?.status).toBe("applied");
		expect(store.list()).toHaveLength(1);
	});
});
