import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkLedger, explain, globToRegExp, isUpstreamPath, parseLedger } from "./fork-ledger.mjs";

const script = fileURLToPath(new URL("./fork-ledger.mjs", import.meta.url));

const LEDGER = `# Fork ledger

Intro.

## Entries

### M1 Provider

- **Files**
  - \`packages/ai/src/providers/nebius.ts\`
  - \`packages/ai/src/providers/nebius.models.ts\`
- **Why**: mu offers Nebius.
- **Tests**
  - \`packages/ai/test/nebius-models.test.ts\`

### M3 Issue templates

- **Files**
  - \`.github/ISSUE_TEMPLATE/*\`
- **Why**: mu's own.

## Retired

### M2 Gone

Upstream took it.
`;

const layout = {
	topFiles: new Set(["README.md", "package.json"]),
	topFolders: new Set([".github", "packages", "scripts"]),
	packages: new Set(["ai", "coding-agent"]),
};

test("a ledger path is a glob: * within a folder name, ** across folders", () => {
	assert.ok(globToRegExp(".github/ISSUE_TEMPLATE/*").test(".github/ISSUE_TEMPLATE/bug.yml"));
	assert.ok(!globToRegExp(".github/ISSUE_TEMPLATE/*").test(".github/ISSUE_TEMPLATE/a/bug.yml"));
	assert.ok(globToRegExp("packages/ai/**/nebius*.ts").test("packages/ai/src/providers/nebius.models.ts"));
	assert.ok(globToRegExp("packages/ai/**/nebius*.ts").test("packages/ai/nebius.ts"));
	assert.ok(!globToRegExp("packages/ai/src/index.ts").test("packages/ai/src/indexXts"));
});

test("entries are read from their Files and Tests lists; a retired number stays taken", () => {
	const { entries, problems } = parseLedger(LEDGER);
	assert.deepEqual(problems, []);
	assert.deepEqual(
		entries.map((entry) => [entry.id, entry.title, entry.files.map((f) => f.pattern), entry.tests.map((t) => t.pattern)]),
		[
			[
				"M1",
				"Provider",
				["packages/ai/src/providers/nebius.ts", "packages/ai/src/providers/nebius.models.ts"],
				["packages/ai/test/nebius-models.test.ts"],
			],
			["M3", "Issue templates", [".github/ISSUE_TEMPLATE/*"], []],
		],
	);
	assert.equal(entries[0].text.at(-1), "  - `packages/ai/test/nebius-models.test.ts`");

	const reused = parseLedger(`${LEDGER}\n### M2 Again\n`).problems;
	assert.equal(reused.length, 1);
	assert.match(reused[0], /M2 is taken \(line \d+\); numbers are never reused/);
	const broken = parseLedger("## Entries\n\n### Nebius\n\n### M4 Nothing\n\n- **Why**: no files.\n").problems;
	assert.match(broken[0], /starts with its number/);
	assert.match(broken[1], /M4 lists no files/);
});

test("pi's files are those in folders upstream has; mu's own folders are not", () => {
	assert.ok(isUpstreamPath("packages/ai/src/index.ts", layout));
	assert.ok(isUpstreamPath(".github/workflows/site.yml", layout));
	assert.ok(isUpstreamPath("README.md", layout));
	assert.ok(!isUpstreamPath("packages/kyrn-judge/src/index.ts", layout));
	assert.ok(!isUpstreamPath("kyrn/docs/fork-ledger.md", layout));
	assert.ok(!isUpstreamPath("CHANGELOG.md", layout));
});

test("the check names files no entry covers, and entry paths that cover nothing", () => {
	const { entries } = parseLedger(LEDGER);
	const changes = [
		{ status: "A", path: "packages/ai/src/providers/nebius.ts" },
		{ status: "A", path: "packages/ai/test/nebius-models.test.ts" },
		{ status: "D", path: ".github/ISSUE_TEMPLATE/bug.yml" },
		{ status: "M", path: "packages/coding-agent/src/main.ts" },
	];
	const { uncovered, stale } = checkLedger(changes, entries, layout);
	assert.deepEqual(
		uncovered.map((change) => change.path),
		["packages/coding-agent/src/main.ts"],
	);
	assert.deepEqual(
		stale.map((item) => [item.id, item.pattern]),
		[["M1", "packages/ai/src/providers/nebius.models.ts"]],
	);

	// A test of mu's own that holds a change only has to exist.
	const own = parseLedger(
		"## Entries\n\n### M1 A\n\n- **Files**\n  - `packages/ai/src/a.ts`\n- **Tests**\n  - `packages/kyrn-judge/test/a.test.ts`\n",
	).entries;
	const ownChanges = [{ status: "M", path: "packages/ai/src/a.ts" }];
	assert.deepEqual(checkLedger(ownChanges, own, layout, () => true).stale, []);
	assert.equal(checkLedger(ownChanges, own, layout, () => false).stale[0].pattern, "packages/kyrn-judge/test/a.test.ts");
});

test("explain quotes each entry once, with the files asked about, and names files no entry has", () => {
	const { entries } = parseLedger(LEDGER);
	const text = explain(
		[
			"packages/ai/src/providers/nebius.ts",
			"packages/ai/src/providers/nebius.models.ts",
			"packages/coding-agent/src/main.ts",
		],
		entries,
	);
	assert.equal(text.match(/### M1 Provider/g)?.length, 1);
	assert.match(text, /- \*\*Why\*\*: mu offers Nebius\./);
	assert.match(text, /Here: `packages\/ai\/src\/providers\/nebius\.ts`, `packages\/ai\/src\/providers\/nebius\.models\.ts`/);
	assert.match(text, /Not in the ledger: `packages\/coding-agent\/src\/main\.ts`/);
	assert.doesNotMatch(text, /M3/);
	assert.doesNotMatch(
		explain(["packages/ai/src/providers/nebius.ts", "packages/coding-agent/src/main.ts"], entries, { skipUnlisted: true }),
		/Not in the ledger/,
	);
	assert.equal(explain(["packages/coding-agent/src/main.ts"], entries, { skipUnlisted: true }), "");
});

test("in a repository, the check compares with the last upstream commit merged in", (t) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "mu-fork-ledger-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// Away from the machine's git settings, such as commit signing.
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: devNull,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
	const run = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
	const write = (path, text) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	const commit = (message) => {
		run("add", "--all");
		run("commit", "-q", "-m", message);
		return run("rev-parse", "HEAD");
	};
	const check = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: "utf8" });

	run("init", "-q", "-b", "main");
	write("README.md", "pi\n");
	write("packages/ai/src/a.ts", "a\n");
	write("packages/ai/src/b.ts", "b\n");
	const first = commit("pi 1");

	// mu: changes a.ts, adds its own package, and the ledger.
	write("packages/ai/src/a.ts", "a, mu\n");
	write("packages/kyrn-judge/src/x.ts", "x\n");
	write("kyrn/docs/fork-ledger.md", "## Entries\n\n### M1 A\n\n- **Files**\n  - `packages/ai/src/a.ts`\n");
	commit("mu");

	// pi moves on twice; mu merges only the first.
	run("switch", "-q", "-c", "pi", first);
	write("packages/ai/src/b.ts", "b, pi 2\n");
	const second = commit("pi 2");
	write("packages/ai/src/c.ts", "c, pi 3\n");
	commit("pi 3");
	run("switch", "-q", "main");
	run("merge", "-q", "--no-edit", second);
	run("update-ref", "refs/remotes/upstream/main", "pi");

	const passed = check();
	assert.equal(passed.status, 0, passed.stderr);
	assert.match(passed.stdout, /1 changed files of pi's, all in 1 entries/);
	assert.equal(check("list").stdout, "M\tpackages/ai/src/a.ts\tM1\n");

	write("README.md", "pi, mu\n");
	commit("mu 2");
	const failed = check();
	assert.equal(failed.status, 1);
	assert.match(failed.stderr, /does not say why:\n {2}M README\.md\n/);

	run("update-ref", "-d", "refs/remotes/upstream/main");
	assert.equal(check().status, 0);
	assert.equal(check("--require-upstream").status, 1);
	assert.match(check("explain", "packages/ai/src/a.ts").stdout, /^### M1 A\n/);
	assert.equal(check("explain", "--skip-unlisted", "packages/ai/src/b.ts").stdout, "");
	const piped = spawnSync(process.execPath, [script, "explain", "-"], {
		cwd: dir,
		env,
		encoding: "utf8",
		input: "packages/ai/src/a.ts\nREADME.md\n",
	});
	assert.match(piped.stdout, /Here: `packages\/ai\/src\/a\.ts`\n\nNot in the ledger: `README\.md`\n$/);
});
