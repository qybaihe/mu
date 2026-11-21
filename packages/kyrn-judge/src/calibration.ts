// How a judge's probabilities are read: the curves measured for it, by decision point and question.
import type { Answer } from "./types.ts";

/**
 * What a judge said against what was true, as `[said, was]` pairs with `said` rising. For a yes/no question: the
 * probability it gave, and the share of such answers that were yes when they were measured. For a choice: the
 * picked option's probability (or confidence if no probability was given), and the share of such picks that were
 * right. Between two points the reading follows the straight line; before the first and after the last it stays at
 * theirs, since nothing was measured there.
 */
export type Curve = readonly (readonly [said: number, was: number])[];

/**
 * How one judge's probabilities are read (`JudgeProfile.calibration`). Two judges that say 0.9 do not mean the same
 * thing: a model trained to give a probability may be right nine times in ten there, and a chat model that writes one
 * down says 0.9 or 0.95 for most things it leans to (docs/nebius.md). A decision's policy has one line for all of them
 * (`threeZone`: yes from 0.8). That line says how sure the decision has to be, not how a judge talks. So an answer is
 * first read through the curve measured for its judge, and the policy gets the reading.
 *
 * Curves are measured, never guessed: replay labelled requests through the judge, and for each question take the
 * share that were true at each probability it gave. mu has none built in yet.
 */
export interface Calibration {
	/**
	 * The model the curves were measured on, as the judge reports it (`modelId` in the ledger). They are used only on
	 * that model's answers, so a hosted judge that moves to a new version is read as it speaks until that one is
	 * measured. Not set: the curves are used whatever model answers.
	 */
	readonly model?: string;
	/**
	 * By decision point, then by question. `*` in place of a question is for that decision's questions with no curve
	 * of their own. The questions a decision builds per candidate (a skill, a file, a lesson) can only be named so.
	 */
	readonly curves: Readonly<Record<string, Readonly<Record<string, Curve>>>>;
}

/** Stands for every question of a decision point that has no curve of its own. */
const ANY_QUESTION = "*";

/** The curve an answer is read through, or undefined when its judge has none for it. */
export function curveOf(
	calibration: Calibration | undefined,
	asked: { readonly decision: string | undefined; readonly question: string; readonly model: string | undefined },
): Curve | undefined {
	if (!calibration || asked.decision === undefined) return undefined;
	if (calibration.model !== undefined && calibration.model !== asked.model) return undefined;
	// Ids index what mu.json holds: only its own keys count, not what every object has ("constructor").
	if (!Object.hasOwn(calibration.curves, asked.decision)) return undefined;
	const curves = calibration.curves[asked.decision];
	if (Object.hasOwn(curves, asked.question)) return curves[asked.question];
	return Object.hasOwn(curves, ANY_QUESTION) ? curves[ANY_QUESTION] : undefined;
}

/**
 * An answer as `curve` reads it: a yes/no answer's probability, or a choice's picked probability (falling back to
 * confidence). What the judge said stays on the answer as `said`. A score is a place on a rubric, not a probability,
 * and is left as it is.
 */
export function readThrough(answer: Answer, curve: Curve): Answer {
	if (answer.type === "boolean") {
		return { ...answer, probability: readingAt(curve, answer.probability), said: answer.probability };
	}
	if (answer.type !== "choice") return answer;
	const probability = answer.probabilities?.[answer.choice];
	if (probability !== undefined) {
		return {
			...answer,
			probabilities: { ...answer.probabilities, [answer.choice]: readingAt(curve, probability) },
			said: probability,
		};
	}
	const said = answer.confidence;
	return said === undefined ? answer : { ...answer, confidence: readingAt(curve, said), said };
}

function readingAt(curve: Curve, said: number): number {
	const first = curve[0];
	const last = curve[curve.length - 1];
	if (said <= first[0]) return first[1];
	if (said >= last[0]) return last[1];
	const after = curve.findIndex(([at]) => at >= said);
	const [fromSaid, fromWas] = curve[after - 1];
	const [toSaid, toWas] = curve[after];
	return fromWas + ((said - fromSaid) / (toSaid - fromSaid)) * (toWas - fromWas);
}

/** What `checkCalibration` kept of a `calibration` written in mu.json, and what it could not use. */
export interface CheckedCalibration {
	/** The curves that can be read; undefined when none is left. */
	readonly calibration: Calibration | undefined;
	/** What was left out, each as the rest of a sentence about the judge ("the curve for tool.approval verdict …"). */
	readonly rejected: readonly string[];
}

/**
 * A judge's `calibration` as mu.json has it, which is text someone wrote: only curves that can be read are kept. A
 * curve needs two points or more, every number between 0 and 1, `said` rising from one point to the next, and `was`
 * never falling: a curve that falls would read the judge's surer answers as the less likely ones.
 */
export function checkCalibration(value: unknown): CheckedCalibration {
	if (value === undefined) return { calibration: undefined, rejected: [] };
	if (!isRecord(value) || !isRecord(value.curves)) {
		return { calibration: undefined, rejected: ["its calibration has no `curves` by decision point"] };
	}
	const rejected: string[] = [];
	const curves: Record<string, Record<string, Curve>> = {};
	for (const [decision, questions] of Object.entries(value.curves)) {
		if (!isRecord(questions)) {
			rejected.push(`the curves for ${decision} are not listed by question`);
			continue;
		}
		const kept = Object.entries(questions).filter(([question, curve]) => {
			if (isCurve(curve)) return true;
			rejected.push(
				`the curve for ${decision} ${question} is not a list of [said, was] pairs between 0 and 1, with said rising and was not falling`,
			);
			return false;
		});
		if (kept.length > 0) curves[decision] = Object.fromEntries(kept) as Record<string, Curve>;
	}
	if (value.model !== undefined && typeof value.model !== "string")
		rejected.push("its calibration's `model` is not text");
	const model = typeof value.model === "string" ? value.model : undefined;
	// A model that could not be read would make the curves hold for every model: none is used then.
	const usable = Object.keys(curves).length > 0 && (value.model === undefined || model !== undefined);
	return { calibration: usable ? { ...(model === undefined ? {} : { model }), curves } : undefined, rejected };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCurve(value: unknown): value is Curve {
	if (!Array.isArray(value) || value.length < 2) return false;
	const inRange = (part: unknown): part is number => typeof part === "number" && part >= 0 && part <= 1;
	return value.every((point, index) => {
		if (!Array.isArray(point) || point.length !== 2 || !inRange(point[0]) || !inRange(point[1])) return false;
		if (index === 0) return true;
		const before = value[index - 1] as readonly [number, number];
		return point[0] > before[0] && point[1] >= before[1];
	});
}
