/**
 * Measures a judge's calibration curves from its answers to labelled questions, and prints them as the `calibration`
 * of that judge's `profile` in mu.json (docs/judges.md, "Reading a judge's probabilities").
 *
 *   node packages/kyrn-judge/scripts/fit-calibration.ts answers.jsonl --model llm:anthropic/claude-haiku-4-5
 *
 * `answers.jsonl` has one answer per line, from a replay of requests whose right answers are known:
 *
 *   {"decision": "tool.approval", "question": "verdict", "said": 0.93, "was": true}
 *
 * `said` is what the judge said: the probability of yes for a yes/no question, or that of the option it picked for a
 * choice. `was` is whether the answer was yes, or the pick was right. For questions a decision builds per candidate
 * (`skill_0`, `lesson_3`), give `*` as the question. `--model` is the model the answers came from, as the ledger's
 * `modelId` names it: the curves are then used on that model's answers only. `--per-point <n>` sets how many answers
 * stand behind each point (default 20). What is said about each curve goes to stderr.
 */
import { readFileSync } from "node:fs";
import { checkCalibration } from "../src/calibration.ts";
import { ANSWERS_PER_POINT, fitCurve, type Sample } from "../src/calibration-fit.ts";

const args = process.argv.slice(2);
const valueOf = (flag: string): string | undefined => {
	const at = args.indexOf(flag);
	return at >= 0 ? args[at + 1] : undefined;
};
const file = args.find((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
if (!file) {
	console.error("usage: fit-calibration.ts <answers.jsonl> [--model <model id>] [--per-point <n>]");
	process.exit(2);
}
const perPoint = Number(valueOf("--per-point") ?? ANSWERS_PER_POINT);
if (!Number.isInteger(perPoint) || perPoint < 1) {
	console.error("--per-point takes a whole number of at least 1");
	process.exit(2);
}
const model = valueOf("--model");

// The file is text someone exported: a line that is not an answer is counted and left out.
const samples = new Map<string, Map<string, Sample[]>>();
let unread = 0;
for (const line of readFileSync(file, "utf8").split("\n")) {
	if (!line.trim()) continue;
	let answer: { decision?: unknown; question?: unknown; said?: unknown; was?: unknown };
	try {
		answer = JSON.parse(line);
	} catch {
		unread++;
		continue;
	}
	const { decision, question, said, was } = answer;
	if (
		typeof decision !== "string" ||
		typeof question !== "string" ||
		typeof said !== "number" ||
		!(said >= 0 && said <= 1) ||
		typeof was !== "boolean"
	) {
		unread++;
		continue;
	}
	const questions = samples.get(decision) ?? new Map<string, Sample[]>();
	samples.set(decision, questions);
	questions.set(question, [...(questions.get(question) ?? []), { said, was }]);
}
if (unread > 0) console.error(`${unread} lines are not answers ({decision, question, said, was}) and were left out`);

const round = (value: number) => Number(value.toFixed(4));
const curves: Record<string, Record<string, [number, number][]>> = {};
for (const [decision, questions] of samples) {
	for (const [question, answers] of questions) {
		const curve = fitCurve(answers, perPoint);
		if (!curve) {
			console.error(`${decision} ${question}: ${answers.length} answers, too few for a curve (${2 * perPoint} or more)`);
			continue;
		}
		const points = curve.map(([said, was]): [number, number] => [round(said), round(was)]);
		curves[decision] = { ...curves[decision], [question]: points };
		const flat = points.every(([, was]) => was === points[0][1]);
		console.error(
			`${decision} ${question}: ${answers.length} answers, ${points.length} points${flat ? ", flat: what this judge says here tells nothing" : ""}`,
		);
	}
}

// The same check mu makes when it reads the file: what is printed is what mu will use.
const { calibration, rejected } = checkCalibration({ ...(model ? { model } : {}), curves });
for (const what of rejected) console.error(`left out: ${what}`);
if (!calibration) {
	console.error("no curve could be measured");
	process.exit(1);
}
console.log(JSON.stringify({ calibration }, null, "\t"));
