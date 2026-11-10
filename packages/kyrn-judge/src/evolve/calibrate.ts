// Where the approval line of a project could be, read from the user's own answers.
import type { ApprovalRow } from "./store.ts";

export interface LineOptions {
	/** The built-in line for a call (`APPROVE_AT`), and the lower one for a check (`CHECK_APPROVE_AT`). */
	readonly line: number;
	readonly checkLine: number;
	/** No suggestion goes below this, whatever the answers say. */
	readonly floor: number;
	/** Answers the band has to hold before it says anything. */
	readonly minAnswers: number;
	/** An answer that waited at least this long counts as read; half of `minAnswers` have to be. */
	readonly consideredMs: number;
}

export interface LineSuggestion {
	/** The line the answers support: the lowest one above which the user allowed every call they were asked about. */
	readonly line: number;
	/** The line in force now. */
	readonly from: number;
	/** Calls between the two lines that the user was asked about, all of which they allowed. */
	readonly allowed: number;
	/** How many of those answers waited long enough to have been read. */
	readonly considered: number;
}

const STEP = 5;
const hundredths = (value: number): number => Math.round(value * 100);

/**
 * The judge asks the user about a call it reads as needed with a probability under the line. When the user then allows
 * every such call down to some probability, the questions in that band told nobody anything: the line can come down to
 * there. One refusal in the band stops it: the line stays above the refused call. So does a stretch of five
 * hundredths with no answer in it: the line comes down only as far as the answers reach without a gap.
 *
 * `current` is the line in force (the built-in one, or an accepted adaptation). A check is held against its own lower
 * line, so an answer about a check counts only below that. Undefined when the answers do not support a lower line:
 * too few of them, too few that were read, or a refusal right under the line.
 */
export function suggestApprovalLine(
	answers: readonly ApprovalRow[],
	current: number,
	options: LineOptions,
): LineSuggestion | undefined {
	const top = hundredths(current);
	const floor = hundredths(options.floor);
	/** The line an answer was asked under: nothing at or above it was ever put to the user. */
	const askedUnder = (answer: ApprovalRow) =>
		Math.min(top, hundredths(answer.check ? options.checkLine : options.line));
	const asked = answers.filter((answer) => hundredths(answer.probability) < askedUnder(answer));
	let best: LineSuggestion | undefined;
	for (let line = top - STEP; line >= floor; line -= STEP) {
		const band = asked.filter((answer) => hundredths(answer.probability) >= line);
		// Each step down has to be answered for: a step nobody was asked in says nothing about the steps under it.
		const step = band.filter((answer) => hundredths(answer.probability) < line + STEP);
		if (step.length === 0 || step.some((answer) => answer.answer === "deny")) break;
		const considered = band.filter((answer) => answer.waitedMs >= options.consideredMs).length;
		if (band.length >= options.minAnswers && considered >= Math.ceil(options.minAnswers / 2)) {
			best = { line: line / 100, from: current, allowed: band.length, considered };
		}
	}
	return best;
}
