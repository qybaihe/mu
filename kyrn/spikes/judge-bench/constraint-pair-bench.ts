/**
 * Paired production-policy evaluation of tool.constraint and task.frame on manufactured, hand-labeled cases.
 * Run from the repo root; only --live makes network requests. No session, auth store, replay, or result files.
 *
 *   node kyrn/spikes/judge-bench/constraint-pair-bench.ts --requests  # inspect both versions' requests offline
 *   node kyrn/spikes/judge-bench/constraint-pair-bench.ts --live      # Jev 1.13 on OpenCode Zen, free by default
 *
 * Set CASE to select one case by ID. For an approved System One endpoint set BENCH_JUDGE_URL (full POST URL),
 * BENCH_JUDGE_MODEL (pinned ID), and BENCH_JUDGE_API_KEY (or BENCH_JUDGE_FREE=1 for a documented free route).
 * Both arms use that same endpoint and model.
 */
import { type DecisionSpec, DecisionEngine } from "../../../packages/kyrn-judge/src/decision.ts";
import { taskFrame } from "../../../packages/kyrn-judge/src/decisions/task-frame.ts";
import { toolConstraint } from "../../../packages/kyrn-judge/src/decisions/tool-constraint.ts";
import { constraintInput } from "../../../packages/kyrn-judge/src/extension/features/constraints.ts";
import { createJudgeFetch } from "../../../packages/kyrn-judge/src/extension/judge-fetch.ts";
import { constraintId } from "../../../packages/kyrn-judge/src/frame/frame.ts";
import { Judge } from "../../../packages/kyrn-judge/src/judge.ts";
import { TypeSafeJudgeProvider } from "../../../packages/kyrn-judge/src/providers/typesafe.ts";
import type { Answer, JudgeInput, JsonValue, Questions } from "../../../packages/kyrn-judge/src/types.ts";
import { FRAME_CASES, GUARD_CASES } from "./constraint-pair-cases.ts";
import { taskFrameV1, toolConstraintV1 } from "./constraint-pair-v1.ts";

type Label =
	| { readonly verdict: "allow" | "block"; readonly broken: readonly number[]; readonly work?: never }
	| { readonly verdict: string; readonly work: string; readonly broken?: never };

type Observation =
	| { readonly kind: "answered"; readonly label: Label; readonly answers?: Readonly<Record<string, Answer>> }
	| { readonly kind: "unanswered"; readonly reason?: string };

interface Arm {
	readonly request: { readonly version: number; readonly state: JudgeInput; readonly questions: Questions };
	run(engine: DecisionEngine): Promise<Observation>;
}

interface Pair {
	readonly id: string;
	readonly suite: "tool.constraint" | "task.frame";
	readonly set: "regression" | "heldout";
	readonly expected: Label;
	readonly v1: Arm;
	readonly candidate: Arm;
}

function arm<In, Qs extends Questions, Out extends JsonValue>(
	spec: DecisionSpec<In, Qs, Out>,
	input: In,
	label: (outcome: Out) => Label,
): Arm {
	return {
		request: {
			version: spec.version,
			state: spec.buildState(input),
			questions: spec.questionsFor ? spec.questionsFor(input) : spec.questions,
		},
		async run(engine) {
			const result = await engine.decide(spec, input);
			return result.source === "judge"
				? { kind: "answered", label: label(result.outcome), answers: result.answers }
				: { kind: "unanswered", reason: result.reason };
		},
	};
}

function pairs(): Pair[] {
	const guardLabel = ({ broken }: { readonly broken: readonly number[] }): Label => ({
		verdict: broken.length ? "block" : "allow",
		broken,
	});
	const guards = GUARD_CASES.map(
		({ id, set, expectedBroken, path, edits, constraints }): Pair => ({
			id,
			set,
			suite: "tool.constraint",
			expected: guardLabel({ broken: expectedBroken }),
			v1: arm(toolConstraintV1, { path, constraints }, guardLabel),
			candidate: arm(toolConstraint, constraintInput("edit", { path, edits }, constraints), guardLabel),
		}),
	);
	const frames = FRAME_CASES.map(({ id, set, input, expected, work }): Pair => {
		const activeConstraints = (input.frame.constraints ?? []).map((text, index) => ({
			text,
			source: { turn: index + 1 },
		}));
		return {
			id,
			set,
			suite: "task.frame",
			expected: {
				verdict: typeof expected === "string" ? expected : "once" in expected ? `allow_once:${expected.once}` : `withdraw:${expected.withdraw}`,
				work,
			},
			v1: arm(taskFrameV1, input, (change) => ({
				// V1 mergeWriterFrame forced an admission for either verdict. It had no targeted-withdraw signal.
				verdict: change === "constraint" || change === "correction" ? "add" : "none",
				work: change === "constraint" ? "none" : change,
			})),
			candidate: arm(taskFrame, { ...input, activeConstraints }, ({ change, limit }) => ({
				verdict:
					limit.kind === "withdraw" || limit.kind === "allow_once"
						? `${limit.kind}:${activeConstraints.find(({ text }) => constraintId(text) === limit.id)?.text}`
						: limit.kind,
				work: change,
			})),
		};
	});
	return [...guards, ...frames];
}

type Side = "v1" | "candidate";
type Row = Pick<Pair, "id" | "set" | "suite" | "expected"> &
	Record<Side, Observation> & { readonly versions: Record<Side, number> };

function report(rows: readonly Row[]) {
	for (const suite of ["tool.constraint", "task.frame"] as const) {
		for (const set of ["all", "regression", "heldout"] as const) {
			const group = rows.filter((row) => row.suite === suite && (set === "all" || row.set === set));
			if (group.length === 0) continue;
			const complete = group.filter((row) => row.v1.kind === "answered" && row.candidate.kind === "answered").length;
			console.log(`\n${suite}/${set}: ${complete}/${group.length} complete pairs`);
			console.table(
				(["v1", "candidate"] as const).map((side) => {
					const version = `${side === "candidate" ? "candidate " : ""}v${group[0].versions[side]}`;
					const answered = group.flatMap((row) => {
						const obs = row[side];
						return obs.kind === "answered" ? [{ expected: row.expected, actual: obs.label }] : [];
					});
					const unanswered = group.length - answered.length;
					if (suite === "tool.constraint") {
						const allows = answered.filter(({ expected }) => expected.verdict === "allow");
						const blocks = answered.filter(({ expected }) => expected.verdict === "block");
						const wrongRuleSet = answered.filter(({ expected, actual }) => {
							const want = expected.broken;
							const got = actual.broken;
							return !want || !got || want.length !== got.length || want.some((index) => !got.includes(index));
						}).length;
						return {
							version,
							wrongRuleSet: `${wrongRuleSet}/${answered.length}`,
							falseBlocks: `${allows.filter(({ actual }) => actual.verdict === "block").length}/${allows.length}`,
							missedViolations: `${blocks.filter(({ actual }) => actual.verdict === "allow").length}/${blocks.length}`,
							unanswered,
							unansweredViolations:
								group.filter((row) => row.expected.verdict === "block").length - blocks.length,
						};
					}
					return {
						version,
						wrongLimit: `${answered.filter(({ expected, actual }) => expected.verdict !== actual.verdict).length}/${answered.length}`,
						wrongWork: `${answered.filter(({ expected, actual }) => expected.work !== actual.work).length}/${answered.length}`,
						unclearLimit: answered.filter(({ actual }) => actual.verdict === "unclear").length,
						unanswered,
					};
				}),
			);
		}
	}
}

const flag = process.argv[2];
if (flag !== "--requests" && flag !== "--live") throw new Error("Use --requests (offline) or --live (one paired run)");
const set = process.env.SET ?? "all";
if (set !== "all" && set !== "regression" && set !== "heldout")
	throw new Error("SET must be all, regression, or heldout");
const caseId = process.env.CASE;
const selected = pairs().filter((pair) => (set === "all" || pair.set === set) && (!caseId || pair.id === caseId));
if (selected.length === 0) throw new Error("No cases match CASE and SET");
if (flag === "--requests") {
	console.log(
		JSON.stringify(
			selected.map(({ v1, candidate, ...label }) => ({ ...label, v1: v1.request, candidate: candidate.request })),
			null,
			2,
		),
	);
} else {
	await live(selected);
}

async function live(selected: readonly Pair[]) {
	const customUrl = process.env.BENCH_JUDGE_URL;
	const customModel = process.env.BENCH_JUDGE_MODEL;
	if (Boolean(customUrl) !== Boolean(customModel)) throw new Error("Set both BENCH_JUDGE_URL and BENCH_JUDGE_MODEL");
	const customKey = customUrl ? process.env.BENCH_JUDGE_API_KEY : undefined;
	if (customUrl && !customKey && process.env.BENCH_JUDGE_FREE !== "1") {
		throw new Error("Set BENCH_JUDGE_API_KEY or explicitly opt in to a documented free route with BENCH_JUDGE_FREE=1");
	}
	const url = customUrl ?? "https://opencode.ai/inference/systemone/v1/systemone";
	if (!URL.canParse(url)) throw new Error("BENCH_JUDGE_URL must be an absolute URL");
	const endpoint = new URL(url);
	const local = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
	if (
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash ||
		(endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:"))
	) {
		throw new Error("Use an HTTPS endpoint or a local HTTP endpoint without embedded credentials or a query");
	}
	const model = customModel ?? "jev-1.13-free";
	const socket = createJudgeFetch();
	let status: number | undefined;
	const provider = new TypeSafeJudgeProvider({
		model,
		baseUrl: endpoint.href,
		apiKey: customUrl ? (customKey ?? "") : "public",
		keyOptional: true,
		fetch: async (input, options) => {
			const response = await socket.fetch(input, { ...options, redirect: "error" });
			status = response.status;
			return response;
		},
	});
	const timeoutMs = 5_000;
	const engine = new DecisionEngine({
		judge: new Judge({ provider, timeoutMs }),
		defaultMode: "active",
		knownSecrets: () => [],
	});
	const rows: Row[] = [];
	console.log(`${endpoint.origin} / ${model}; ${selected.length} pairs, ${timeoutMs} ms timeout, no retries`);
	try {
		for (const [index, { v1, candidate, ...label }] of selected.entries()) {
			const order = index % 2 === 0 ? [v1, candidate] : [candidate, v1];
			const results = [];
			for (const arm of order) {
				status = undefined;
				const result = await arm.run(engine);
				// Do not log provider error bodies; they may include connection details or echoed data.
				results.push({
					...result,
					...(result.kind === "unanswered" && status !== undefined ? { httpStatus: status } : {}),
				});
			}
			const row = {
				...label,
				versions: { v1: v1.request.version, candidate: candidate.request.version },
				v1: results[index % 2],
				candidate: results[1 - (index % 2)],
			};
			rows.push(row);
			console.log(JSON.stringify(row));
		}
	} finally {
		await socket.close();
	}
	report(rows);
	if (rows.some((row) => row.v1.kind === "unanswered" || row.candidate.kind === "unanswered")) process.exitCode = 1;
}
