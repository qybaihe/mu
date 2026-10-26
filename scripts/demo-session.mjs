#!/usr/bin/env node
// Turn a real mu session file into one `mu demo` can ship: kyrn/demo/<name>.jsonl.
//
//   node scripts/demo-session.mjs <session.jsonl> <name>
//
// The project folder becomes ~/<name>, the home folder ~, and the user name "you"; the system prompt (which
// describes this machine) is left out. Everything else stays as it was recorded. It refuses to write a file that
// still names this machine's paths or user.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const [source, name] = process.argv.slice(2);
if (!source || !/^[a-z0-9-]+$/.test(name ?? "")) {
	console.error("usage: node scripts/demo-session.mjs <session.jsonl> <name>");
	process.exit(2);
}
const lines = readFileSync(source, "utf8").split("\n").filter((line) => line.trim());
const cwd = JSON.parse(lines[0]).cwd;
const user = userInfo().username;
// Longest first: the project folder sits inside the home folder (or under /private/tmp, which macOS also calls /tmp).
const swaps = [
	[cwd, `~/${name}`],
	[cwd.replace(/^\/private/, ""), `~/${name}`],
	[homedir(), "~"],
	[user, "you"],
];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clean = (text) => swaps.reduce((out, [from, to]) => out.replace(new RegExp(escape(from), "g"), to), text);

const kept = lines.filter((line) => JSON.parse(line).message?.role !== "system").map(clean);
const leaks = kept.filter((line) => /\/Users\/|\/private\/tmp|\/home\/[a-z]/.test(line) || line.includes(user));
if (leaks.length > 0) {
	console.error(`${leaks.length} lines still name this machine, e.g.:\n${leaks[0].slice(0, 300)}`);
	process.exit(1);
}
const target = join(import.meta.dirname, "..", "kyrn", "demo", `${name}.jsonl`);
writeFileSync(target, `${kept.join("\n")}\n`);
console.log(`${target}: ${kept.length} entries`);
