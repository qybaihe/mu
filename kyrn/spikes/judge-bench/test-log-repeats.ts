/**
 * Runs the `rules` arm of test-log admission over your own shell results and reports what folding exact repeats
 * saves. No judge is called: the judge provider throws if it is ever asked.
 *
 *   node kyrn/spikes/judge-bench/test-log-repeats.ts shell-results.jsonl
 *   BASH_TOOL=1 node kyrn/spikes/judge-bench/test-log-repeats.ts ci-steps.jsonl
 *
 * Input: one JSON object per line, `{"command": "...", "output": "..."}`, the command as the agent ran it and its
 * output as the agent received it. With BASH_TOOL=1 the output is a command's whole output, such as a CI step's log,
 * and is first cut the way mu's bash tool cuts it (the last 2,000 lines or 50 KB, with its notice), since that is
 * the text admission sees. Only results mu would see as test logs count: 4,000 characters or more, a test runner in
 * the command and a run summary in the output (`isTestLog`), the same checks as the admission feature. A record may
 * carry `source` (reported apart) and `run`; with ONE_PER_RUN=1 only the first test log of each run counts, so a
 * failure repeated across a CI matrix counts once.
 *
 * Prints totals per runner and checks that every folded log comes back byte for byte: the line references in its
 * markers are expanded from the original, and any other omitted lines are taken from the archived original.
 * Prints no log text. Needs Node >= 23.6. Writes results/test-log-repeats-<time>.json (counts only).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { truncateTail } from "../../../packages/coding-agent/src/core/tools/truncate.ts";
import { isTestLog, planTestLog, renderTestLog } from "../../../packages/kyrn-judge/src/admission/test-log.ts";
import { DecisionEngine } from "../../../packages/kyrn-judge/src/decision.ts";
import { Judge } from "../../../packages/kyrn-judge/src/judge.ts";
import { MockJudgeProvider } from "../../../packages/kyrn-judge/src/providers/mock.ts";

const MIN_CHARS = 4000;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Where admission writes the original: os.tmpdir()/kyrn-<session id>/<tool call id>.txt. The pointer's length counts.
const archivePath = join(tmpdir(), "kyrn-0192b6f4-7c1e-7a3b-9d2f-5e8a1c4b6d70", "toolu_01Hx7rQ2mVbN8kP4sT6wYzAc.txt");

/** What mu's bash tool returns for a long output: its tail, and a notice saying which lines (tools/bash.ts). */
function asBashTool(output: string): string {
	const cut = truncateTail(output);
	if (!cut.truncated) return output;
	const start = cut.totalLines - cut.outputLines + 1;
	return `${cut.content}\n\n[Showing lines ${start}-${cut.totalLines} of ${cut.totalLines}. Full output: /tmp/pi-bash-0192b6f4.log]`;
}

const engine = new DecisionEngine({
	judge: new Judge({
		provider: new MockJudgeProvider(() => {
			throw new Error("the repeat rule never asks the judge");
		}),
		timeoutMs: 1000,
	}),
	defaultMode: "active",
});

/** The run's format, from its summary: what the command named is often a wrapper like `npm test`. */
function runner(output: string): string {
	const text = output.replace(ANSI, "");
	if (/^\s*Test Files\s/m.test(text)) return "Vitest";
	if (/^Test Suites:/m.test(text)) return "Jest";
	if (/^=+ .*\b(?:passed|failed|errors?|skipped|no tests ran)\b.* in [\d.]+s.*=+$/m.test(text)) return "pytest";
	if (/^(?:TAP version \d|# tests \d|ℹ tests \d)/m.test(text)) return "node:test";
	return "other";
}

function failed(output: string): boolean {
	const text = output.replace(ANSI, "");
	return /\b[1-9]\d* (?:failed|errors?)\b|^(?:# fail|ℹ fail) [1-9]|^FAIL\s/m.test(text);
}

/**
 * The referenced lines put back where each duplicate marker stands, as the unit test does, and the pointer line
 * dropped. renderTestLog ends the text with a line break before its pointer; one the original lacked comes off.
 */
function expandDuplicates(rendered: string, original: string): string {
	const source = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	let text = "";
	for (const line of rendered.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		const list = /^\[mu: omitted \d+ lines: identical to lines (.+) of the full output, kept above\]/.exec(line)?.[1];
		if (line.startsWith("[mu: ") && line.includes("full output: ")) continue;
		if (!list) {
			text += line;
			continue;
		}
		for (const ref of list.split(", ")) {
			const [, from, to, times] = /^(\d+)-(\d+)(?: ×(\d+))?$/.exec(ref) ?? [];
			text += source
				.slice(Number(from) - 1, Number(to))
				.join("")
				.repeat(Number(times ?? 1));
		}
	}
	const eol = original.includes("\r\n") ? "\r\n" : "\n";
	return !original.endsWith("\n") && text.endsWith(eol) ? text.slice(0, -eol.length) : text;
}

interface Row {
	/** The record's optional `source` field, such as the repository a CI log came from. */
	source: string;
	runner: string;
	failed: boolean;
	chars: number;
	netSavedChars: number;
	applied: boolean;
	/** Every omitted line is a back-reference, so the text the model gets expands to the original by itself. */
	selfContained: boolean;
	restored: boolean;
	/** Characters of the omitted units, by kind, in logs where folding applied. */
	omittedByKind: Record<string, number>;
}

const path = process.argv[2];
if (!path) throw new Error("usage: node kyrn/spikes/judge-bench/test-log-repeats.ts shell-results.jsonl");
const rows: Row[] = [];
const seen = new Set<string>();
const runs = new Set<string>();
for (const line of readFileSync(path, "utf8").split("\n")) {
	if (!line.trim()) continue;
	const record = JSON.parse(line) as { command: string; output: string; source?: string; run?: string };
	if (process.env.ONE_PER_RUN === "1" && record.run && runs.has(record.run)) continue;
	const { command } = record;
	const output = process.env.BASH_TOOL === "1" ? asBashTool(record.output) : record.output;
	if (output.length < MIN_CHARS || seen.has(output)) continue;
	const call = `bash: ${command}`.slice(0, 300);
	if (!isTestLog(call, output)) continue;
	seen.add(output);
	if (record.run) runs.add(record.run);
	const plan = await planTestLog({ call, goal: "", intent: "", output }, "rules", engine);
	const rendered = renderTestLog(plan, archivePath);
	const omitted = new Set(plan.omitted);
	const kinds = new Set(plan.units.filter((unit) => omitted.has(unit.id)).map((unit) => unit.kind));
	const selfContained = !rendered.applied || [...kinds].every((kind) => kind === "duplicate");
	// What is not a back-reference comes back from the archive, which holds the original.
	const restored = selfContained
		? expandDuplicates(rendered.text, output) === output
		: plan.units.map((unit) => unit.text).join("") === output;
	const omittedByKind: Record<string, number> = {};
	if (rendered.applied) {
		for (const unit of plan.units) {
			if (omitted.has(unit.id)) omittedByKind[unit.kind] = (omittedByKind[unit.kind] ?? 0) + unit.text.length;
		}
	}
	rows.push({
		source: record.source ?? "",
		runner: runner(output),
		failed: failed(output),
		chars: output.length,
		netSavedChars: rendered.netSavedChars,
		applied: rendered.applied,
		selfContained,
		restored,
		omittedByKind,
	});
}

function total(group: Row[]) {
	const chars = group.reduce((sum, row) => sum + row.chars, 0);
	const saved = group.reduce((sum, row) => sum + row.netSavedChars, 0);
	return {
		logs: group.length,
		failing: group.filter((row) => row.failed).length,
		folded: group.filter((row) => row.applied).length,
		chars,
		netSavedChars: saved,
		netSavedShare: chars ? `${((saved / chars) * 100).toFixed(1)}%` : "-",
	};
}

const runners = [...new Set(rows.map((row) => row.runner))].sort();
const table = Object.fromEntries([
	...runners.map((name) => [name, total(rows.filter((row) => row.runner === name))]),
	["failing runs", total(rows.filter((row) => row.failed))],
	["passing runs", total(rows.filter((row) => !row.failed))],
	["all", total(rows)],
]);
console.table(table);
const sources = [...new Set(rows.map((row) => row.source))].filter(Boolean).sort();
if (sources.length > 0) console.table(Object.fromEntries(sources.map((name) => [name, total(rows.filter((row) => row.source === name))])));
const folded = rows.filter((row) => row.applied);
console.log(
	`${folded.length} of ${rows.length} logs folded; ${folded.filter((row) => row.selfContained).length} by back-references only. ` +
		`Restored byte for byte: ${rows.filter((row) => row.restored).length}/${rows.length}.`,
);
const byKind: Record<string, number> = {};
for (const row of rows) for (const [kind, chars] of Object.entries(row.omittedByKind)) byKind[kind] = (byKind[kind] ?? 0) + chars;
console.log(`Omitted characters by kind: ${JSON.stringify(byKind)}`);
const shares = rows.map((row) => row.netSavedChars / row.chars).sort((a, b) => a - b);
const at = (q: number) => `${((shares[Math.min(shares.length - 1, Math.floor(q * shares.length))] ?? 0) * 100).toFixed(0)}%`;
console.log(`Per-log saving: median ${at(0.5)}, 75th percentile ${at(0.75)}, 90th ${at(0.9)}, largest ${at(1)}.`);

const out = join(dirname(fileURLToPath(import.meta.url)), "results", `test-log-repeats-${Date.now()}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ table, rows }, null, 2)}\n`);
console.log(`Results: ${out}`);
