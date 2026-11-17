// How a calibration curve is measured: from a judge's answers to questions whose right answer is known.
import type { Curve } from "./calibration.ts";

/** One answer a judge gave to a question whose right answer is known. */
export interface Sample {
	/** What the judge said: for a yes/no question the probability of yes, for a choice that of the option it picked. */
	readonly said: number;
	/** What was true: the answer was yes, or the pick was the right one. */
	readonly was: boolean;
}

/** Answers that said about the same, taken together: where they stand on the judge's scale, and how many were true. */
interface Block {
	saidSum: number;
	trueCount: number;
	count: number;
}

/** Answers behind each point of a curve, unless the caller says otherwise: with fewer, a point is mostly noise. */
export const ANSWERS_PER_POINT = 20;

/**
 * The curve these answers measure (`Curve` in calibration.ts), or undefined when there are fewer than two points'
 * worth of them: nothing can be said from that.
 *
 * The answers are put in order of what the judge said, and neighbours are pooled until the share that was true never
 * falls as what was said rises (isotonic regression, by pooling adjacent violators). A pool of fewer than `perPoint`
 * answers then takes in the ones after it, and the last one joins the one before it. A judge whose surer answers were
 * not more often true ends as one pool: its curve is flat at the share of all its answers that were true, so nothing
 * it says reads as sure.
 */
export function fitCurve(samples: readonly Sample[], perPoint: number = ANSWERS_PER_POINT): Curve | undefined {
	if (samples.length < 2 * perPoint) return undefined;
	const pooled: Block[] = [];
	const rate = (block: Block) => block.trueCount / block.count;
	const absorb = (into: Block, other: Block) => {
		into.saidSum += other.saidSum;
		into.trueCount += other.trueCount;
		into.count += other.count;
	};
	const ordered = [...samples].sort((a, b) => a.said - b.said);
	for (let index = 0; index < ordered.length; ) {
		// Answers that said the very same thing are one place on the scale, whatever came of each: taken whole, so
		// the order they come in changes nothing.
		const said = ordered[index].said;
		const block: Block = { saidSum: 0, trueCount: 0, count: 0 };
		for (; index < ordered.length && ordered[index].said === said; index++) {
			block.trueCount += ordered[index].was ? 1 : 0;
			block.count++;
		}
		block.saidSum = said * block.count;
		pooled.push(block);
		// Surer and less often true than the pool before it: the two say the same, as far as these answers show.
		while (pooled.length > 1 && rate(pooled[pooled.length - 2]) > rate(pooled[pooled.length - 1])) {
			absorb(pooled[pooled.length - 2], pooled.pop() as Block);
		}
	}
	// Pooling neighbours of a rising row keeps it rising, so a small pool can take in the ones after it.
	const blocks: Block[] = [];
	for (const block of pooled) {
		const before = blocks.at(-1);
		if (before && before.count < perPoint) absorb(before, block);
		else blocks.push(block);
	}
	const last = blocks.at(-1);
	if (blocks.length > 1 && last && last.count < perPoint) absorb(blocks[blocks.length - 2], blocks.pop() as Block);
	if (blocks.length === 1) {
		return [
			[0, rate(blocks[0])],
			[1, rate(blocks[0])],
		];
	}
	return blocks.map((block): [number, number] => [block.saidSum / block.count, rate(block)]);
}
