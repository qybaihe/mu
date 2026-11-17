import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkCalibration, readThrough } from "../src/calibration.ts";
import { fitCurve, type Sample } from "../src/calibration-fit.ts";

/** `count` answers that said `said`, of which `trueCount` were true: the false ones first, as the worst order for a fit. */
const answers = (said: number, count: number, trueCount: number): Sample[] =>
	Array.from({ length: count }, (_, index) => ({ said, was: index >= count - trueCount }));

type Fitted = NonNullable<ReturnType<typeof fitCurve>>;

/** A curve, point by point, to the precision sums of fractions keep. */
function expectCurve(curve: ReturnType<typeof fitCurve>, points: readonly (readonly [number, number])[]): void {
	expect(curve).toHaveLength(points.length);
	for (const [index, [said, was]] of points.entries()) {
		expect((curve as Fitted)[index][0]).toBeCloseTo(said, 10);
		expect((curve as Fitted)[index][1]).toBeCloseTo(was, 10);
	}
}

describe("measuring a curve from labelled answers", () => {
	it("puts a point where the judge's answers stand, at the share of them that was true", () => {
		// A chat model that writes 0.9 or 0.95 for most of what it leans to.
		const curve = fitCurve([...answers(0.5, 40, 8), ...answers(0.9, 40, 24), ...answers(0.95, 40, 32)]);
		expectCurve(curve, [
			[0.5, 0.2],
			[0.9, 0.6],
			[0.95, 0.8],
		]);
		// What it says with 0.9 is then read as 0.6: under the 0.8 a policy acts from.
		const read = readThrough({ type: "boolean", probability: 0.9 }, curve as Fitted);
		expect(read).toMatchObject({ said: 0.9 });
		expect((read as { probability: number }).probability).toBeCloseTo(0.6, 10);
	});

	it("pools neighbours whose surer answers were not more often true, so the curve never falls", () => {
		// 0.8 was true less often than 0.7: as far as these answers show, the two say the same.
		const curve = fitCurve([...answers(0.3, 20, 2), ...answers(0.7, 20, 14), ...answers(0.8, 20, 10)]);
		expectCurve(curve, [
			[0.3, 0.1],
			[0.75, 0.6],
		]);
	});

	it("takes answers that said the same as one place on the scale, in whatever order they come", () => {
		const inOrder = [...answers(0.4, 30, 9), ...answers(0.9, 30, 24)];
		const shuffled = inOrder.map((_, index) => inOrder[(index * 7) % inOrder.length]);
		expectCurve(fitCurve(shuffled), [
			[0.4, 0.3],
			[0.9, 0.8],
		]);
		expect(fitCurve(shuffled)).toEqual(fitCurve(inOrder));
	});

	it("puts no point on fewer answers than asked for: a handful at one probability takes in the ones after it", () => {
		const few = [...answers(0.2, 30, 3), ...answers(0.6, 5, 3), ...answers(0.9, 30, 27)];
		// The five at 0.6 and the thirty at 0.9 are one point: where they stand together, and how many were true.
		expectCurve(fitCurve(few), [
			[0.2, 0.1],
			[(0.6 * 5 + 0.9 * 30) / 35, 30 / 35],
		]);
		// With less asked of each point, the five stand on their own.
		expectCurve(fitCurve(few, 5), [
			[0.2, 0.1],
			[0.6, 0.6],
			[0.9, 0.9],
		]);
		// A handful at the end joins the pool before it.
		expectCurve(fitCurve([...answers(0.2, 30, 3), ...answers(0.7, 30, 18), ...answers(0.99, 4, 4)]), [
			[0.2, 0.1],
			[(0.7 * 30 + 0.99 * 4) / 34, 22 / 34],
		]);
	});

	it("measures nothing from fewer than two points' worth of answers", () => {
		expect(fitCurve(answers(0.9, 39, 30))).toBeUndefined();
		expect(fitCurve([])).toBeUndefined();
		expect(fitCurve(answers(0.9, 4, 3), 2)).toBeDefined();
	});

	it("is flat for a judge whose surer answers were no more often true: nothing it says reads as sure", () => {
		expectCurve(fitCurve([...answers(0.6, 30, 18), ...answers(0.95, 30, 12)]), [
			[0, 0.5],
			[1, 0.5],
		]);
		// One that always says the same number has one place on its scale.
		expectCurve(fitCurve(answers(0.9, 60, 45)), [
			[0, 0.75],
			[1, 0.75],
		]);
	});

	it("gives curves mu.json can hold, in whatever order the answers come", () => {
		const mixed: Sample[] = [];
		// 400 answers over the whole scale, true more often the surer they were, in no order.
		for (let index = 0; index < 400; index++) {
			const said = ((index * 37) % 100) / 100;
			mixed.push({ said, was: (index * 61) % 100 < said * 100 });
		}
		const curve = fitCurve(mixed) as Fitted;
		expect(curve.length).toBeGreaterThan(3);
		expect(checkCalibration({ curves: { "tool.approval": { verdict: curve } } }).rejected).toEqual([]);
		for (const [index, [said, was]] of curve.entries()) {
			if (index === 0) continue;
			expect(said).toBeGreaterThan(curve[index - 1][0]);
			expect(was).toBeGreaterThanOrEqual(curve[index - 1][1]);
		}
	});
});

describe("scripts/fit-calibration.ts", () => {
	const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fit-calibration.ts");
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	it("turns a file of labelled answers into the calibration of a judge's profile, and says what it left out", () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-fit-"));
		dirs.push(dir);
		const file = join(dir, "answers.jsonl");
		const line = (decision: string, question: string, sample: Sample) =>
			JSON.stringify({ decision, question, ...sample });
		writeFileSync(
			file,
			[
				...[...answers(0.5, 40, 8), ...answers(0.95, 40, 32)].map((sample) =>
					line("tool.approval", "verdict", sample),
				),
				...[...answers(0.6, 30, 6), ...answers(0.9, 30, 21)].map((sample) =>
					line("skills.disclosure", "*", sample),
				),
				...answers(0.9, 10, 9).map((sample) => line("tool.risk", "risky", sample)),
				"not json",
				JSON.stringify({ decision: "tool.risk", question: "risky", said: 1.4, was: true }),
			].join("\n"),
		);

		const result = spawnSync(process.execPath, [script, file, "--model", "llm:anthropic/claude-haiku-4-5"], {
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			calibration: {
				model: "llm:anthropic/claude-haiku-4-5",
				curves: {
					"tool.approval": {
						verdict: [
							[0.5, 0.2],
							[0.95, 0.8],
						],
					},
					"skills.disclosure": {
						"*": [
							[0.6, 0.2],
							[0.9, 0.7],
						],
					},
				},
			},
		});
		expect(result.stderr).toContain("2 lines are not answers");
		expect(result.stderr).toContain("tool.risk risky: 10 answers, too few for a curve (40 or more)");
		// What it prints is what mu reads.
		expect(checkCalibration(JSON.parse(result.stdout).calibration).rejected).toEqual([]);
	});

	it("exits with an error when no curve can be measured", () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-fit-"));
		dirs.push(dir);
		const file = join(dir, "answers.jsonl");
		writeFileSync(file, JSON.stringify({ decision: "tool.risk", question: "risky", said: 0.9, was: true }));
		const result = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("no curve could be measured");
	});
});
