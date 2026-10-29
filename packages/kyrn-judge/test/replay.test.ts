import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "..", "..", "..");
const script = join(repo, "kyrn", "bin", "kyrn-replay");
const demoDir = join(repo, "kyrn", "demo");

/** The replay as a person would see it piped: no colors, no pauses. */
function replay(args: string[], env: Record<string, string> = {}) {
	const home = mkdtempSync(join(tmpdir(), "mu-replay-"));
	return spawnSync(process.execPath, [script, ...args], {
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, NO_COLOR: "1", ...env },
	});
}

describe("mu demo and mu replay", () => {
	it("replays the main demo with nothing configured: each command, the judge's verdict and what it all cost", () => {
		const run = replay(["demo"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("No key and no network");
		expect(run.stdout).toContain("you   The tests in price.test.mjs fail.");
		expect(run.stdout).toMatch(
			/judge ↑ may this command run\? asks you: not part of the task \(needed: 0\.\d\d\) {2}Nemotron 3 Ultra · \d+ ms/,
		);
		expect(run.stdout).toMatch(
			/judge ✓ may this command run\? approved: a step the task needs \(needed: 0\.\d\d\) {2}Nemotron 3 Ultra · \d+ ms/,
		);
		expect(run.stdout).toContain("judge ✓ is the task done? the task is done: the turn ends");
		expect(run.stdout).toContain("4 commands went to the judge: 3 approved without asking you, 1 came back to you.");
		expect(run.stdout).toContain("run touch .agent-was-here: not part of the task");
		expect(run.stdout).toContain("you would have been asked 5 times: for those 4 commands and 1 edit.");
		expect(run.stdout).toMatch(/Judge: [\d,]+ tokens in, [\d,]+ out, \$0\.0\d+\./);
		// --brief keeps the steps and the verdicts and leaves out what each step printed.
		const brief = replay(["demo", "--brief"]);
		expect(brief.stdout).toContain("agent run    touch .agent-was-here");
		expect(brief.stdout).not.toContain("Command exited");
		expect(brief.stdout.split("\n").length).toBeLessThan(run.stdout.split("\n").length);
		const fix = replay(["demo", "fix"]);
		expect(fix.stdout).toContain("6 commands went to the judge: 5 approved without asking you, 1 came back to you.");
	});

	it("lists the demos and shows each, Tavily's searches and pages included", () => {
		const list = replay(["demo", "--list"]);
		const names = [...list.stdout.matchAll(/^ {2}(\S+)/gm)].map((match) => match[1]);
		expect(names).toEqual(
			JSON.parse(readFileSync(join(demoDir, "demos.json"), "utf8")).map((demo: { name: string }) => demo.name),
		);
		const tavily = replay(["demo", "tavily"]);
		expect(tavily.status).toBe(0);
		expect(tavily.stdout).toContain("8 results from Tavily");
		expect(tavily.stdout).toMatch(/judge ✓ screened \d+ passages from Tavily for instructions aimed at the AI: none/);
		expect(replay(["demo", "nothing-here"]).status).toBe(2);
		const local = replay(["demo", "local"]);
		expect(local.stdout).toMatch(
			/judge ↑ may this command run\? asks you: not part of the task \(needed: 0\.\d\d\) {2}the fine-tuned Nemotron 3 Nano 4B, local · \d+ ms/,
		);
		expect(local.stdout).toContain("Judge: 1,");
		expect(local.stdout).toContain("$0 (on this machine)");
	});

	it("names the command as the person runs it: through npx, the package and its version", () => {
		const pkg = mkdtempSync(join(tmpdir(), "mu-replay-pkg-"));
		mkdirSync(join(pkg, "kyrn", "bin"), { recursive: true });
		copyFileSync(script, join(pkg, "kyrn", "bin", "kyrn-replay"));
		cpSync(demoDir, join(pkg, "kyrn", "demo"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "mu-agent", version: "9.9.9" }));
		const run = (env: Record<string, string>) =>
			spawnSync(process.execPath, [join(pkg, "kyrn", "bin", "kyrn-replay"), "demo", "--fast"], {
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", HOME: pkg, NO_COLOR: "1", ...env },
			}).stdout;
		expect(run({ npm_command: "exec" })).toContain("npx -y mu-agent@9.9.9 demo --list shows the other recordings");
		expect(run({})).toContain("\nmu demo --list shows the other recordings");
	});

	it("replays a session file of your own, and says so when there is none", () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-replay-sessions-"));
		const file = join(dir, "s.jsonl");
		const lines = [
			{ type: "session", version: 3, id: "s", timestamp: "2026-10-26T10:00:00.000Z", cwd: "/work/app" },
			{
				type: "model_change",
				provider: "nebius",
				modelId: "nvidia/nemotron-3-super-120b-a12b",
				timestamp: "2026-10-26T10:00:00.000Z",
			},
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "run the tests" }], timestamp: 1793008800000 },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
					usage: { input: 100, output: 10, cost: { total: 0.001 } },
					timestamp: 1793008801000,
				},
			},
			{
				type: "custom",
				customType: "kyrn.decision",
				data: {
					specId: "tool.approval",
					source: "judge",
					providerId: "systemone:http://127.0.0.1:8770/v1#mu-judge-nemotron",
					judged: "approve",
					latencyMs: 70,
					usage: { inputTokens: 300, outputTokens: 1 },
				},
			},
		];
		writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
		const run = replay(["replay", file]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("agent run    npm test");
		expect(run.stdout).toContain("the fine-tuned Nemotron 3 Nano 4B, local · 70 ms");
		expect(run.stdout).toContain("Judge: 300 tokens in, 1 out, $0 (on this machine).");
		const none = replay(["replay"]);
		expect(none.status).toBe(2);
		expect(none.stderr).toContain("Try: mu demo");
	});

	it("ships recordings that name no machine, path or person", () => {
		for (const name of readdirSync(demoDir).filter((file) => file.endsWith(".jsonl"))) {
			const text = readFileSync(join(demoDir, name), "utf8");
			expect(text, name).not.toMatch(/\/Users\/|\/private\/|\/home\/[a-z]|"role":"system"/);
		}
	});
});
