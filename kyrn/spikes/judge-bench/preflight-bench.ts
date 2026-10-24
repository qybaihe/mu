/**
 * Runs the real `input.preflight` decision against a real judge and compares
 * the verdicts with hand-written labels.
 *
 *   KYRN_JUDGE=gateway node --env-file=.env kyrn/spikes/judge-bench/preflight-bench.ts   (default)
 *   KYRN_JUDGE=http KYRN_JUDGE_URL=http://host:port node kyrn/spikes/judge-bench/preflight-bench.ts
 *                      (a judge server that takes {state, questions} at /evaluate)
 *
 * Needs Node >= 23.6 (runs TypeScript directly). Writes results/preflight-<judge>-<time>.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DecisionEngine,
	GatewayJudgeProvider,
	HttpJudgeProvider,
	inputPreflight,
	Judge,
	type JudgeProvider,
	MemoryLedger,
	type PreflightOutcome,
} from "../../../packages/kyrn-judge/src/index.ts";
import { type Scenario, scenarios } from "./scenarios.ts";

const backend = process.env.KYRN_JUDGE ?? "gateway";
const provider: JudgeProvider =
	backend === "http"
		? new HttpJudgeProvider({ baseUrl: process.env.KYRN_JUDGE_URL ?? "http://127.0.0.1:8000" })
		: new GatewayJudgeProvider({ apiKey: () => process.env.AI_GATEWAY_API_KEY });

const ledger = new MemoryLedger();
const engine = new DecisionEngine({
	judge: new Judge({ provider, timeoutMs: 20_000 }),
	ledger,
	defaultMode: "active",
});

type Field = keyof Scenario["expect"];

function check(field: Field, scenario: Scenario, judged: PreflightOutcome): boolean | undefined {
	const expected = scenario.expect[field];
	if (expected === undefined) return undefined;
	const actual = judged[field];
	return Array.isArray(expected) ? expected.includes(actual as never) : expected === actual;
}

const fields: Field[] = [
	"turnType",
	"gear",
	"needsFilesChanged",
	"sideQuestion",
	"needsClarification",
	"swarmWorthy",
	"planFirst",
];
const tally = new Map<Field, { right: number; wrong: number; unsure: number }>();
for (const field of fields) tally.set(field, { right: 0, wrong: 0, unsure: 0 });

const rows = [];
const latencies: number[] = [];

for (const scenario of scenarios) {
	const decision = await engine.decide(inputPreflight, scenario.input);
	const judged = decision.judged;
	if (decision.latencyMs !== undefined) latencies.push(decision.latencyMs);

	const misses: string[] = [];
	if (judged) {
		for (const field of fields) {
			const ok = check(field, scenario, judged);
			if (ok === undefined) continue;
			const counts = tally.get(field);
			if (!counts) continue;
			const actual = judged[field];
			if (ok) counts.right++;
			else if (actual === "unsure" || actual === "unknown") counts.unsure++;
			else counts.wrong++;
			if (!ok) misses.push(`${field}=${String(actual)} (want ${JSON.stringify(scenario.expect[field])})`);
		}
	}

	const summary = judged
		? `${judged.turnType} -> ${judged.gear} | files=${judged.needsFilesChanged} side=${judged.sideQuestion} clarify=${judged.needsClarification} swarm=${judged.swarmWorthy} plan=${judged.planFirst} | c=${judged.complexity.task.toFixed(1)}/${judged.complexity.reasoning.toFixed(1)}/${judged.complexity.tools.toFixed(1)}`
		: `NO VERDICT (${decision.reason})`;
	console.log(`${misses.length === 0 && judged ? "ok  " : "MISS"} ${scenario.id.padEnd(20)} ${summary}`);
	for (const miss of misses) console.log(`       - ${miss}`);
	for (const warning of decision.warnings ?? []) console.log(`       ! ${warning.type} ${warning.questionId ?? ""}`);

	rows.push({
		id: scenario.id,
		lang: scenario.lang,
		expect: scenario.expect,
		judged,
		reason: decision.reason,
		misses,
		latencyMs: decision.latencyMs,
		usage: decision.usage,
		warnings: decision.warnings,
		answers: decision.answers,
	});
}

console.log(`\njudge: ${engine.providerId}   scenarios: ${scenarios.length}   failures: ${engine.stats.failures}`);
console.log("field                right  unsure  wrong");
for (const [field, counts] of tally) {
	console.log(
		`${field.padEnd(20)} ${String(counts.right).padStart(5)} ${String(counts.unsure).padStart(7)} ${String(counts.wrong).padStart(6)}`,
	);
}
const sorted = [...latencies].sort((a, b) => a - b);
if (sorted.length > 0) {
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	console.log(
		`latency per preflight (10 questions): p50 ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${sorted[sorted.length - 1]} ms`,
	);
}
console.log(`input tokens total: ${engine.stats.inputTokens}`);
if (engine.stats.lastError) console.log(`last error: ${engine.stats.lastError.kind} - ${engine.stats.lastError.message}`);

const out = join(dirname(fileURLToPath(import.meta.url)), "results", `preflight-${backend}-${Date.now()}.json`);
await mkdir(dirname(out), { recursive: true });
await writeFile(
	out,
	JSON.stringify({ judge: engine.providerId, spec: inputPreflight.version, tally: [...tally], rows }, null, "\t"),
);
console.log(`saved ${out}`);
