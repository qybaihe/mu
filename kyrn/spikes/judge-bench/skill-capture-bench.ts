/**
 * Runs skill.capture (packages/kyrn-judge/src/decisions/skill-capture.ts) on the cases in skill-capture-cases.ts, the
 * way mu asks it, through pi's classifier path. Reports each case's choice and the probability of `procedure`, and
 * how many runs would be drafted at several thresholds.
 *
 *   node kyrn/spikes/judge-bench/skill-capture-bench.ts                    Jev 1.13 on OpenCode Zen, free, no key
 *   SET=heldout node kyrn/spikes/judge-bench/skill-capture-bench.ts        the held-out cases
 *
 * Only the cases are sent. Writes results/skill-capture-<model>-<time>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage } from "../../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../../packages/coding-agent/src/core/model-runtime.ts";
import { DecisionEngine } from "../../../packages/kyrn-judge/src/decision.ts";
import { skillCapture } from "../../../packages/kyrn-judge/src/decisions/skill-capture.ts";
import { Judge } from "../../../packages/kyrn-judge/src/judge.ts";
import { ClassifierJudgeProvider } from "../../../packages/kyrn-judge/src/providers/classifier.ts";
import { CASES, HELDOUT } from "./skill-capture-cases.ts";

const modelRef = process.env.MODEL ?? "opencode/jev-1.13-free";
const set = process.env.SET === "heldout" ? HELDOUT : CASES;
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8];

const runtime = await ModelRuntime.create({
	credentials: AuthStorage.inMemory(),
	modelsPath: null,
	allowModelNetwork: false,
});
const slash = modelRef.indexOf("/");
const model = runtime.getModelOfType("classifier", modelRef.slice(0, slash), modelRef.slice(slash + 1));
if (!model) throw new Error(`${modelRef} is not a classifier in the catalog`);
// OpenCode serves its free models with the key "public", as mu does (extension/runtime.ts).
const apiKey = model.provider === "opencode" && model.cost.input === 0 ? "public" : process.env.OPENCODE_API_KEY;

const provider = new ClassifierJudgeProvider({
	model: modelRef,
	call: async ({ state, questions, signal }) => {
		const result = await runtime.classify(
			model,
			{ state: state as never, questions: questions as never },
			{ signal, maxRetries: 1, ...(apiKey ? { apiKey } : {}) },
		);
		return {
			answers: result.answers,
			usage: result.usage ? { input: result.usage.input, output: result.usage.output } : undefined,
			stopReason: result.stopReason,
			errorMessage: result.errorMessage,
		};
	},
});
const engine = new DecisionEngine({
	judge: new Judge({ provider, timeoutMs: 20_000 }),
	defaultMode: "active",
	recordState: true,
});

interface Row {
	id: string;
	label: string;
	choice: string;
	procedure: number | null;
	drafted: boolean;
}

const rows: Row[] = [];
let latency = 0;
for (const item of set) {
	const started = performance.now();
	const decision = await engine.decide(skillCapture, { turnDigest: item.digest, skills: item.skills });
	latency += performance.now() - started;
	if (decision.source !== "judge") console.error(`${item.id}: no verdict (${decision.source})`);
	const answer = (decision as { answers?: { kind?: { choice?: string; probabilities?: Record<string, number> } } })
		.answers?.kind;
	rows.push({
		id: item.id,
		label: item.label,
		choice: answer?.choice ?? "-",
		procedure: answer?.probabilities?.procedure ?? null,
		drafted: decision.source === "judge" && decision.outcome === "draft",
	});
}

const pad = (text: string, width: number) => text.padEnd(width);
console.log(`\n${modelRef}: ${set.length} requests, ${Math.round(latency / set.length)} ms each on average\n`);
console.log(`${pad("case", 22)}${pad("label", 11)}${pad("choice", 11)}${pad("p(proc)", 9)}drafted`);
for (const row of rows) {
	console.log(
		`${pad(row.id, 22)}${pad(row.label, 11)}${pad(row.choice, 11)}${pad(row.procedure === null ? "-" : row.procedure.toFixed(3), 9)}${row.drafted ? "yes" : ""}`,
	);
}
const procedures = rows.filter((row) => row.label === "procedure");
const others = rows.filter((row) => row.label !== "procedure");
console.log("");
for (const threshold of THRESHOLDS) {
	const at = (row: Row) => row.choice === "procedure" && (row.procedure ?? 0) >= threshold;
	console.log(
		`at ${threshold}: drafted ${procedures.filter(at).length} of ${procedures.length} procedures, ${others.filter(at).length} of ${others.length} others`,
	);
}

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, "results"), { recursive: true });
const out = join(
	here,
	"results",
	`skill-capture-${process.env.SET === "heldout" ? "heldout-" : ""}${modelRef.replace(/\W+/g, "-")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
writeFileSync(out, `${JSON.stringify({ model: modelRef, rows }, null, "\t")}\n`);
console.log(`\nwrote ${out}`);
