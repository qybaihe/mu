#!/usr/bin/env node
// mu's fork ledger (kyrn/docs/fork-ledger.md): every file where mu differs from pi upstream, and why.
//
//   node scripts/fork-ledger.mjs [--upstream <ref>] [--require-upstream]
//       Checks that each file mu changes in pi's folders is in an entry, and that no entry names a file mu no
//       longer changes. Compares with the last upstream commit merged into HEAD (merge-base with the upstream ref).
//       Without the ref it says so and passes, unless --require-upstream (CI).
//   node scripts/fork-ledger.mjs list [--upstream <ref>]
//       Each changed file, its status, and the entries that cover it.
//   node scripts/fork-ledger.mjs explain [--skip-unlisted] <file>... | -
//       The ledger entries for these files (or for the files on standard input, one a line), as Markdown, for the
//       upstream-sync workflow's issue and PR. It also names the files no entry has, unless --skip-unlisted (for a
//       merge's changed files, most of which mu never touches).
//
// A file is pi's when its first folder (its package, under packages/) exists in upstream at that commit, or when it
// is a file at the top that upstream has. Everything else (packages/kyrn-judge, kyrn/, desktop/, site/, …) is mu's
// own and needs no entry.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LEDGER = "kyrn/docs/fork-ledger.md";

/** A ledger path as a regular expression: `*` is any part of one folder name, `**` any number of folders. */
export function globToRegExp(pattern) {
	let source = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "*" && pattern[index + 1] === "*") {
			source += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*";
			index += pattern[index + 2] === "/" ? 2 : 1;
		} else if (char === "*") source += "[^/]*";
		else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/**
 * The entries of the ledger. An entry is a `### M<n> <title>` heading under `## Entries`; its paths are the
 * backquoted ones in its `- **Files**` and `- **Tests**` lists. Entries under `## Retired` keep their number taken.
 */
export function parseLedger(markdown) {
	const entries = [];
	const problems = [];
	const seen = new Map();
	let section = "";
	let entry;
	let list = false;
	const lines = markdown.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const lineNumber = index + 1;
		const sectionHeading = /^## (.+)$/.exec(line);
		if (sectionHeading) {
			section = sectionHeading[1].trim();
			entry = undefined;
			list = false;
			continue;
		}
		const heading = /^### (\S+)(?:\s+(.*))?$/.exec(line);
		if (heading) {
			list = false;
			entry = undefined;
			const [, id, title] = heading;
			if (section !== "Entries" && section !== "Retired") continue;
			if (!/^M[1-9]\d*$/.test(id)) {
				problems.push(`${LEDGER}:${lineNumber}: an entry's heading starts with its number, M1, M2, …: "${line}"`);
				continue;
			}
			if (seen.has(id)) {
				problems.push(`${LEDGER}:${lineNumber}: ${id} is taken (line ${seen.get(id)}); numbers are never reused`);
				continue;
			}
			seen.set(id, lineNumber);
			if (section === "Retired") continue;
			entry = { id, title: (title ?? "").trim(), line: lineNumber, files: [], tests: [], text: [line] };
			entries.push(entry);
			continue;
		}
		if (!entry) continue;
		entry.text.push(line);
		const listStart = /^- \*\*(Files|Tests)\*\*/.exec(line);
		if (listStart) {
			list = listStart[1] === "Files" ? entry.files : entry.tests;
			continue;
		}
		if (/^- /.test(line) || (line.trim() !== "" && !/^\s+/.test(line))) list = false;
		if (list && /^\s+- /.test(line)) {
			for (const match of line.matchAll(/`([^`]+)`/g)) list.push({ pattern: match[1], line: lineNumber });
		}
	}
	for (const found of entries) {
		while (found.text.length > 1 && found.text.at(-1).trim() === "") found.text.pop();
		if (found.files.length === 0) problems.push(`${LEDGER}:${found.line}: ${found.id} lists no files`);
	}
	return { entries, problems };
}

/** Whether a path is in pi's folders, given the folders and top files upstream has. */
export function isUpstreamPath(path, upstream) {
	const parts = path.split("/");
	if (parts.length === 1) return upstream.topFiles.has(path);
	if (parts[0] === "packages") return parts.length > 2 && upstream.packages.has(parts[1]);
	return upstream.topFolders.has(parts[0]);
}

/**
 * Which changed files no entry covers, and which entry paths cover none. A path in mu's own folders, such as a test
 * of mu's that holds the change, only has to exist.
 */
export function checkLedger(changes, entries, upstream, exists = () => true) {
	const patterns = entries.flatMap((entry) =>
		[...entry.files, ...entry.tests].map((item) => ({ ...item, id: entry.id, regexp: globToRegExp(item.pattern) })),
	);
	const uncovered = changes.filter((change) => !patterns.some((item) => item.regexp.test(change.path)));
	const stale = patterns.filter((item) => {
		if (changes.some((change) => item.regexp.test(change.path))) return false;
		if (isUpstreamPath(item.pattern.replace(/\*.*$/, "x"), upstream)) return true;
		return !item.pattern.includes("*") && !exists(item.pattern);
	});
	return { uncovered, stale };
}

/** The entries that cover a file. */
export function entriesFor(path, entries) {
	return entries.filter((entry) =>
		[...entry.files, ...entry.tests].some((item) => globToRegExp(item.pattern).test(path)),
	);
}

/** The ledger entries for some files, as Markdown: each entry once, with the files it was asked about. */
export function explain(paths, entries, { skipUnlisted = false } = {}) {
	const matched = new Map();
	const missing = [];
	for (const path of paths) {
		const found = entriesFor(path, entries);
		if (found.length === 0) missing.push(path);
		for (const entry of found) {
			const files = matched.get(entry) ?? [];
			files.push(path);
			matched.set(entry, files);
		}
	}
	const out = [];
	for (const [entry, files] of matched) {
		out.push(entry.text.join("\n"), "", `Here: ${files.map((file) => `\`${file}\``).join(", ")}`, "");
	}
	if (missing.length > 0 && !skipUnlisted) {
		out.push(`Not in the ledger: ${missing.map((file) => `\`${file}\``).join(", ")}`, "");
	}
	return out.join("\n").trimEnd();
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** The last upstream commit merged into HEAD, or undefined when the upstream ref is not here. */
export function upstreamBase(ref, cwd) {
	try {
		git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
	} catch {
		return undefined;
	}
	return git(["merge-base", "HEAD", ref], cwd).trim();
}

/** The folders and top files upstream has at a commit. */
export function upstreamLayout(base, cwd) {
	const top = git(["ls-tree", base], cwd)
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
	const packages = git(["ls-tree", "--name-only", `${base}:packages`], cwd).split("\n").filter(Boolean);
	return {
		topFiles: new Set(top.filter(([meta]) => meta.includes(" blob ")).map(([, name]) => name)),
		topFolders: new Set(top.filter(([meta]) => meta.includes(" tree ")).map(([, name]) => name)),
		packages: new Set(packages),
	};
}

/** The files mu changes in pi's folders since that commit: `{ status, path }`, status A, M or D. */
export function upstreamChanges(base, upstream, cwd) {
	return git(["diff", "--no-renames", "--name-status", base, "HEAD"], cwd)
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [status, path] = line.split("\t");
			return { status: status[0], path };
		})
		.filter((change) => isUpstreamPath(change.path, upstream));
}

function main(argv) {
	const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
	const args = [...argv];
	const command = args[0] && !args[0].startsWith("--") ? args.shift() : "check";
	const option = (name) => {
		const index = args.indexOf(name);
		if (index === -1) return undefined;
		const [, value] = args.splice(index, 2);
		return value;
	};
	const upstreamRef = option("--upstream") ?? "upstream/main";
	const requireUpstream = args.includes("--require-upstream");
	const { entries, problems } = parseLedger(readFileSync(join(root, LEDGER), "utf8"));

	if (command === "explain") {
		const skipUnlisted = args.includes("--skip-unlisted");
		let files = args.filter((arg) => arg !== "--skip-unlisted");
		if (files.length === 1 && files[0] === "-") files = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
		const text = explain(files, entries, { skipUnlisted });
		if (text) process.stdout.write(`${text}\n`);
		return problems.length === 0 ? 0 : 1;
	}

	const base = upstreamBase(upstreamRef, root);
	if (!base) {
		const said = `fork ledger: no ${upstreamRef} here, so nothing to compare with. Add pi as a remote: git remote add upstream https://github.com/earendil-works/pi.git && git fetch upstream`;
		console.log(said);
		return requireUpstream ? 1 : 0;
	}
	const upstream = upstreamLayout(base, root);
	const changes = upstreamChanges(base, upstream, root);

	if (command === "list") {
		for (const change of changes) {
			const ids = entriesFor(change.path, entries).map((entry) => entry.id);
			console.log(`${change.status}\t${change.path}\t${ids.join(",") || "-"}`);
		}
		return 0;
	}
	if (command !== "check") {
		console.error(`fork ledger: unknown command ${command}`);
		return 2;
	}

	const { uncovered, stale } = checkLedger(changes, entries, upstream, (path) => existsSync(join(root, path)));
	const short = git(["log", "-1", "--format=%h (%cs)", base], root).trim();
	for (const problem of problems) console.error(problem);
	if (uncovered.length > 0) {
		console.error(`\nmu changes these files of pi's, and ${LEDGER} does not say why:`);
		for (const change of uncovered) console.error(`  ${change.status} ${change.path}`);
		console.error(
			`\nAdd them to the entry for the change they belong to, or a new entry (the next free M number). Say why mu changes the file and what to keep when an upstream merge touches it.`,
		);
	}
	if (stale.length > 0) {
		console.error(`\nThese ledger paths match no file mu still changes (or, in mu's own folders, no file):`);
		for (const item of stale) console.error(`  ${LEDGER}:${item.line}: ${item.id} \`${item.pattern}\``);
		console.error(
			`\nTake the path out. When an entry has no files left, move it under "## Retired" with a line on why; its number is not reused.`,
		);
	}
	const failed = problems.length > 0 || uncovered.length > 0 || stale.length > 0;
	if (failed) {
		console.error(
			`\nCompared with ${upstreamRef} at its last commit merged into HEAD, ${short}. If that ref is older than mu's last upstream merge, run git fetch upstream first.`,
		);
		return 1;
	}
	console.log(
		`fork ledger: ${changes.length} changed files of pi's, all in ${entries.length} entries (upstream ${short}).`,
	);
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = main(process.argv.slice(2));
}
