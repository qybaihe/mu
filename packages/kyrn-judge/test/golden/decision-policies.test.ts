import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DecisionEngine } from "../../src/decision.ts";
import { toolApproval } from "../../src/decisions/tool-approval.ts";
import type { JudgeCall, JudgeLike, JudgeResult } from "../../src/judge.ts";
import type { Answer, AnswersFor, JsonValue, Question, Questions } from "../../src/types.ts";
import { GOLDEN_CASES, type GoldenCase, golden } from "./decision-inputs.ts";
import { RecordingJudge, unbumped } from "./golden-support.ts";

/**
 * What every decision does with the judge's answers, kept in `decision-policies.md`: for the input in
 * `decision-inputs.ts`, the outcome as each answer moves across its range, the decision's other answers held high and
 * then low, and the outcome with no answer and with a judge that failed. A change to a policy (a line moved from 0.8 to
 * 0.75, a choice that now does something else) shows up there as a diff.
 *
 * `decision-requests.md` keeps what a decision asks; this file keeps what it does. A policy change needs a new
 * `version` as a request change does: the ledger's records of the old policy were made under it. The test holds the
 * file to that the same way, also with `-u`.
 */
const GOLDEN = fileURLToPath(new URL("./decision-policies.md", import.meta.url));

/** Where a probability is tried: finer around the lines the policies draw, 0.6 to 0.9. */
const PROBABILITIES = [0.01, 0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99];
/** A choice's own probability: below a third another option would be likelier. */
const CHOICE_PROBABILITIES = PROBABILITIES.filter((p) => p >= 0.3);

/**
 * Inputs the judge never sees that change what a decision does, each tried besides the input of `decision-inputs.ts`:
 * a check in the project is approved from 0.7 rather than 0.8.
 */
const POLICY_ONLY: readonly GoldenCase[] = [
	golden(toolApproval, {
		task: "Fix the failing parseDuration test in src/parse.ts; now: check the fix",
		userMessage: "The parseDuration test fails for 1h30m, can you fix it?",
		call: "bash: npm test",
		where: "a program run in the project folder",
		check: true,
	}),
];

/** Answers the same answers to every request, or fails. */
class AnsweringJudge implements JudgeLike {
	readonly id = "golden";
	private readonly answers: Readonly<Record<string, Answer>> | "fail";

	constructor(answers: Readonly<Record<string, Answer>> | "fail") {
		this.answers = answers;
	}

	async evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>> {
		if (this.answers === "fail") throw new Error("the judge failed");
		const answers = Object.fromEntries(
			Object.keys(request.questions)
				.filter((id) => id in (this.answers as object))
				.map((id) => [id, (this.answers as Record<string, Answer>)[id]]),
		);
		return {
			answers: answers as AnswersFor<Qs>,
			usage: {},
			latencyMs: 0,
			requests: 1,
			providerId: this.id,
			warnings: [],
		};
	}
}

/** An answer at the top of its range, or at the bottom: what the other questions say while one moves. */
function held(question: Question, high: boolean): Answer {
	if (question.type === "boolean") return { type: "boolean", probability: high ? 0.95 : 0.05 };
	if (question.type === "choice") {
		const options = Object.keys(question.criteria);
		const choice = (high ? options[0] : options.at(-1)) as string;
		return { type: "choice", choice, probabilities: { [choice]: 0.95 } };
	}
	const top = question.criteria.length - 1;
	return { type: "score", score: high ? top : 0 };
}

/** Each answer a question is tried with, and how it reads in the table. */
function tried(question: Question): { label: string; group: string; answer: Answer }[] {
	if (question.type === "boolean")
		return PROBABILITIES.map((probability) => ({
			group: "p(true)",
			label: String(probability),
			answer: { type: "boolean", probability },
		}));
	if (question.type === "choice")
		return Object.keys(question.criteria).flatMap((choice) => [
			...CHOICE_PROBABILITIES.map((p) => ({
				group: choice,
				label: String(p),
				answer: { type: "choice", choice, probabilities: { [choice]: p } } as Answer,
			})),
			{ group: choice, label: "no p", answer: { type: "choice", choice } as Answer },
		]);
	const levels = question.criteria.length;
	return Array.from({ length: (levels - 1) * 2 + 1 }, (_, step) => ({
		group: "score",
		label: String(step / 2),
		answer: { type: "score", score: step / 2 } as Answer,
	}));
}

/** What the decision did, as the table shows it. */
async function outcome(
	spec: GoldenCase["spec"],
	input: unknown,
	answers: Readonly<Record<string, Answer>> | "fail",
): Promise<string> {
	const engine = new DecisionEngine({
		judge: new AnsweringJudge(answers),
		defaultMode: "active",
		knownSecrets: () => [],
	});
	const decision = await engine.decide(spec, input);
	const said = JSON.stringify(decision.outcome as JsonValue) ?? "undefined";
	return decision.source === "fallback" ? `${said} (fallback)` : said;
}

/** Runs of tried answers with the same outcome: `0.01–0.75 → "unsure"; 0.8–0.99 → "approve"`. */
function runs(results: readonly { label: string; outcome: string }[]): string {
	const merged: { from: string; to: string; outcome: string }[] = [];
	for (const { label, outcome: said } of results) {
		const last = merged.at(-1);
		if (last && last.outcome === said) last.to = label;
		else merged.push({ from: label, to: label, outcome: said });
	}
	return merged
		.map((run) => `${run.from === run.to ? run.from : `${run.from}–${run.to}`} → ${run.outcome}`)
		.join("; ");
}

async function render(): Promise<string> {
	const parts = [
		"# What each decision does with the judge's answers",
		"",
		"Written by `decision-policies.test.ts` from the inputs in `decision-inputs.ts`: the outcome as each answer moves",
		"across its range, the decision's other answers held high (the first option, p 0.95) and then low (the last option,",
		"p 0.05). Do not edit by hand. A section that changes needs a new `version` in its decision; then run the test with",
		"`-u`.",
	];
	for (const { spec, input } of [...GOLDEN_CASES, ...POLICY_ONLY]) {
		const recording = new RecordingJudge();
		await new DecisionEngine({ judge: recording, defaultMode: "active", knownSecrets: () => [] }).decide(spec, input);
		parts.push("", `## ${spec.id} v${spec.version}`, "");
		const questions = recording.call?.questions;
		if (!questions) {
			parts.push("(no questions for this input)");
			continue;
		}
		const ids = Object.keys(questions);
		for (const id of ids) {
			const question = questions[id] as Question;
			const contexts = ids.length > 1 ? (["high", "low"] as const) : ([undefined] as const);
			for (const context of contexts) {
				const others = Object.fromEntries(
					ids
						.filter((other) => other !== id)
						.map((other) => [other, held(questions[other] as Question, context === "high")]),
				);
				parts.push(`- \`${id}\` (${question.type})${context ? `, the others ${context}` : ""}:`);
				const results = await Promise.all(
					tried(question).map(async (each) => ({
						...each,
						outcome: await outcome(spec, input, { ...others, [id]: each.answer }),
					})),
				);
				for (const group of [...new Set(results.map((each) => each.group))]) {
					const mine = results.filter((each) => each.group === group);
					const bare = mine.find((each) => each.label === "no p");
					const ranged = runs(mine.filter((each) => each !== bare));
					parts.push(`  - ${group}: ${ranged}${bare ? `; without p → ${bare.outcome}` : ""}`);
				}
			}
		}
		parts.push(
			`- no answer: ${await outcome(spec, input, {})}`,
			`- the judge failed: ${await outcome(spec, input, "fail")}`,
		);
	}
	return `${parts.join("\n")}\n`;
}

describe("what the decisions do with the judge's answers", () => {
	it("is as recorded, and a decision whose policy changed has a new version", async () => {
		const rendered = await render();
		let recorded = "";
		try {
			recorded = readFileSync(GOLDEN, "utf8");
		} catch {
			// Not written yet: the snapshot below writes it.
		}
		expect(
			unbumped(recorded, rendered),
			"what these do with the answers changed: bump their version, then run with -u",
		).toEqual([]);
		await expect(rendered).toMatchFileSnapshot(GOLDEN);
	});
});
