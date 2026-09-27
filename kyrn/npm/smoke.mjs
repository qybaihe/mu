#!/usr/bin/env node
// After `npm i -g mu-agent`: does the installed `mu` run, does it load the judgment layer, do `mu auth`,
// `mu import` and `mu setup` answer?
//
//   node kyrn/npm/smoke.mjs [the mu command]
//
// Runs in a throwaway home with no keys, so nothing is read from or written to the real ~/.mu and no model can
// be called. The judgment layer is checked over RPC: its commands, prompt templates and skills are listed
// without a turn being taken.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mu = process.argv[2] ?? "mu";
const windows = process.platform === "win32";
const home = mkdtempSync(join(tmpdir(), "mu-smoke-"));
const env = { PATH: process.env.PATH ?? process.env.Path, HOME: home, USERPROFILE: home, TERM: "dumb", PI_OFFLINE: "1" };
// What Windows itself needs to start programs, and where `mu doctor` looks for a browser there.
for (const name of [
	"SystemRoot",
	"SYSTEMROOT",
	"ComSpec",
	"PATHEXT",
	"TEMP",
	"TMP",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"ProgramW6432",
]) {
	if (process.env[name]) env[name] = process.env[name];
}
// npm's `mu` is a .cmd shim on Windows, which only a shell can start; every argument here is fixed.
const options = { env, cwd: home, encoding: "utf8", shell: windows, timeout: 120_000 };

const failures = [];
function check(name, ok, detail) {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

const version = spawnSync(mu, ["version"], options);
check("mu version", version.status === 0 && /^mu \d+\.\d+\.\d+ \(pi \d/.test(version.stdout), version.stdout.trim() || version.stderr.trim());

const help = spawnSync(mu, ["--help"], options);
check("mu --help", help.status === 0 && help.stdout.includes("mu command line") && help.stdout.includes("Agent flags"));

// Without a login, doctor has something to fix and says so with exit code 1; the package row must be fine.
const doctor = spawnSync(mu, ["doctor"], options);
console.log(doctor.stdout.trimEnd().replace(/^/gm, "     "));
check("mu doctor", /^\s*ok\s+package\s/m.test(doctor.stdout), doctor.stderr.trim());

// The desktop app's sign-in: one JSON line that offers pi's own subscriptions, and nobody signed in yet.
const auth = spawnSync(mu, ["auth", "status"], options);
let status;
try {
	status = JSON.parse(auth.stdout.trim().split("\n").at(-1));
} catch {}
check(
	"mu auth status",
	auth.status === 0 &&
		status?.type === "status" &&
		["openai-codex", "anthropic", "xai"].every((provider) => status.offered.includes(provider)) &&
		status.signedIn.length === 0,
	auth.stdout.trim() || auth.stderr.trim(),
);

// The importer runs on Node alone; the throwaway home has no Claude Code or Codex conversation to list.
const imports = spawnSync(mu, ["import", "--list", "--json"], options);
let found;
try {
	found = JSON.parse(imports.stdout);
} catch {}
check(
	"mu import --list",
	imports.status === 0 && Array.isArray(found?.conversations) && found.conversations.length === 0,
	imports.stderr.trim() || imports.stdout.trim().slice(0, 300),
);

// The setup wizard starts with pi's bundle behind it; its help tells scripts to give the key on stdin. No key is checked.
const setupHelp = spawnSync(mu, ["setup", "--help"], options);
check(
	"mu setup --help",
	setupHelp.status === 0 && setupHelp.stdout.includes("--key-stdin"),
	setupHelp.stderr.trim() || setupHelp.stdout.trim().slice(0, 300),
);

// Within the heap of a 1 GB server. mu 0.1.3 transpiled the judgment layer with Babel at every start, which took
// more than 500 MB, and there V8 aborted before the first frame. A transpiled copy is cached in the temp folder, and
// with one from an earlier run 0.1.3 passed here, so the temp folder is a new one.
const temp = join(home, "tmp");
mkdirSync(temp);
const heapCap = { ...env, NODE_OPTIONS: "--max-old-space-size=200", TMPDIR: temp, TMP: temp, TEMP: temp };
const rpc = await new Promise((resolve) => {
	const child = spawn(mu, ["--mode", "rpc", "--no-session"], { ...options, env: heapCap, stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	let err = "";
	const seen = {};
	// Later calls change nothing: the promise is settled by the first.
	const done = (result) => {
		clearTimeout(timer);
		child.kill();
		resolve(result);
	};
	const timer = setTimeout(() => done({ ...seen, error: `no answer in 90 s. stderr: ${err.slice(-800)}` }), 90_000);
	child.stdout.on("data", (data) => {
		out += data;
		const lines = out.split("\n");
		out = lines.pop() ?? "";
		for (const line of lines) {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (message.id === "smoke") {
				if (!message.success) return done({ error: message.error });
				seen.names = message.data.commands.map((command) => `${command.source}:${command.name}`);
			}
			// /help answers with a notice whose first line names mu's version and pi's, as the welcome screen does.
			if (message.type === "extension_ui_request" && message.method === "notify" && String(message.message).includes("judgment-first")) {
				seen.help = String(message.message).split("\n")[0];
			}
			if (seen.names && seen.help) return done(seen);
		}
	});
	child.stderr.on("data", (data) => {
		err += data;
	});
	child.on("error", (error) => done({ error: error.message }));
	child.on("close", (code, signal) => {
		const heap = /Reached heap limit|heap out of memory/.test(err) ? ", out of heap" : "";
		done({ ...seen, error: `exited (${code ?? signal}${heap}) without an answer. stderr: ${err.slice(-800)}` });
	});
	child.stdin.write(`${JSON.stringify({ id: "smoke", type: "get_commands" })}\n`);
	child.stdin.write(`${JSON.stringify({ id: "help", type: "prompt", message: "/help" })}\n`);
});
const names = rpc.names ?? [];
const expected = ["extension:board", "extension:goal", "extension:permissions", "prompt:implement", "skill:skill:mu-browser"];
check(
	"judgment layer loaded in a 200 MB heap (RPC get_commands)",
	rpc.names !== undefined && expected.every((name) => names.includes(name)),
	rpc.names === undefined
		? rpc.error
		: `${names.length} commands, ${expected.filter((name) => !names.includes(name)).join(", ") || "all expected ones"} ${expected.every((name) => names.includes(name)) ? "present" : "missing"}`,
);
// mu 0.1.3 said "mu 0.1.0 · …, built on pi 0.1.3": its judgment layer's own version, and pi's, read from mu-agent's folder.
const versions = /^mu (\S+) \(pi ([^,)]+)/.exec(version.stdout.trim());
const greeting = versions ? `mu ${versions[1]} · judgment-first coding agent, built on pi ${versions[2]}` : undefined;
check("/help names mu's version and pi's, as mu version does", greeting !== undefined && rpc.help === greeting, rpc.help ?? rpc.error);

try {
	rmSync(home, { recursive: true, force: true });
} catch {
	// Windows may still hold a file the agent just closed; the folder is a temporary one.
}
if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("\nThe installed mu runs and loads the judgment layer.");
