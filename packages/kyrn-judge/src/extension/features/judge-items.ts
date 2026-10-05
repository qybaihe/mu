import { Type } from "typebox";
import { type ItemsOutcome, judgeItems } from "../../decisions/judge-items.ts";
import { DEFAULT_THRESHOLDS } from "../../policy.ts";
import { clip, type KyrnRuntime } from "../runtime.ts";

/** What one request may carry in items, so even text in Chinese stays well inside the judge's window. */
const BATCH_STATE_CHARS = 16_000;

const range = (indexes: readonly number[]): string => {
	const parts: string[] = [];
	let start = 0;
	while (start < indexes.length) {
		let end = start;
		while (end + 1 < indexes.length && indexes[end + 1] === indexes[end] + 1) end++;
		parts.push(end === start ? `#${indexes[start]}` : `#${indexes[start]}-${indexes[end]}`);
		start = end + 1;
	}
	return parts.join(", ");
};

/** The answer as the model reads it: the yeses and the unsure ones item by item, the rest by number. */
export function describeAnswers(question: string, items: readonly string[], answers: ItemsOutcome): string {
	const rows = items.map((item, index) => ({ number: index + 1, item, probability: answers[index] }));
	const answered = rows.filter((row) => row.probability !== null);
	const by = (keep: (probability: number) => boolean) =>
		answered
			.filter((row) => keep(row.probability as number))
			.sort((a, b) => (b.probability as number) - (a.probability as number));
	const yes = by((probability) => probability >= DEFAULT_THRESHOLDS.yes);
	const unsure = by((probability) => probability > DEFAULT_THRESHOLDS.no && probability < DEFAULT_THRESHOLDS.yes);
	const no = answered.filter((row) => (row.probability as number) <= DEFAULT_THRESHOLDS.no).map((row) => row.number);
	const missing = rows.filter((row) => row.probability === null).map((row) => row.number);
	const line = (row: (typeof rows)[number]) =>
		`#${row.number}  ${(row.probability as number).toFixed(2)}  ${clip(row.item, 160)}`;
	const out = [`Jev answered ${answered.length} of ${items.length} items: ${clip(question, 200)}`];
	out.push(`yes (p >= ${DEFAULT_THRESHOLDS.yes}): ${yes.length}`, ...yes.map(line));
	if (unsure.length > 0) out.push(`unsure: ${unsure.length}`, ...unsure.map(line));
	out.push(`no (p <= ${DEFAULT_THRESHOLDS.no}): ${no.length}${no.length > 0 ? ` (${range(no)})` : ""}`);
	if (missing.length > 0) out.push(`not answered: ${missing.length} (${range(missing)})`);
	return out.join("\n");
}

/**
 * `judge_items`: the model hands the judge one yes/no question about each of many items and reads back a probability
 * per item (decisions/judge-items.ts). A capability the judge opens when a task needs it, or the model finds with
 * `find_capability`: it is not in every prompt. The model asked for the answer, so it gets it in shadow too; only
 * `off` turns it away.
 */
export function registerJudgeItems(runtime: KyrnRuntime): void {
	const options = runtime.options("judgeItems", { enabled: true, maxItems: 500, itemChars: 1000, concurrency: 4 });
	if (!options.enabled) return;
	const { pi } = runtime;

	pi.registerTool({
		name: "judge_items",
		label: "Judge items",
		description:
			"Ask Jev, a fast yes/no classifier, one question about each of many items at once (file paths, log lines, findings, URLs, short texts); each item gets the probability of yes. For sorting or filtering many items by a plain criterion instead of reading them all yourself; not for reasoning, arithmetic or writing.",
		parameters: Type.Object({
			question: Type.String({ description: "A yes/no question about ONE item, e.g. 'Is this test about login?'" }),
			items: Type.Array(Type.String(), { description: "The items, one string each" }),
			context: Type.Optional(
				Type.String({ description: "What every item should be read with, said once (the goal, a definition)" }),
			),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			runtime.touch(ctx);
			if (runtime.mode(judgeItems.id) === "off") {
				throw new Error("judge_items is switched off (decision judge.items). Read the items yourself.");
			}
			const question = params.question.trim();
			if (!question) throw new Error("Give the question to ask about each item.");
			const items = params.items.slice(0, options.maxItems).map((item) => item.slice(0, options.itemChars));
			if (items.length === 0) throw new Error("Give at least one item.");
			const context = clip(params.context ?? "", 2000);
			const size = Math.max(1, Math.floor(BATCH_STATE_CHARS / Math.max(200, options.itemChars)));
			const batches: { question: string; context: string; items: string[] }[] = [];
			for (let start = 0; start < items.length; start += size) {
				batches.push({ question, context, items: items.slice(start, start + size) });
			}
			const decisions = await runtime.engine.decideMany(judgeItems, batches, {
				signal,
				concurrency: options.concurrency,
			});
			// The judged answers, in shadow as well: the model asked for them.
			const answers = decisions.flatMap((decision, index) => [
				...(decision.judged ?? batches[index].items.map(() => null)),
			]);
			if (answers.every((answer) => answer === null)) {
				throw new Error("Jev did not answer (the judge is unreachable or switched off). Read the items yourself.");
			}
			const cut = params.items.length > items.length ? `\n(only the first ${items.length} items were asked)` : "";
			return {
				content: [{ type: "text", text: `${describeAnswers(question, items, answers)}${cut}` }],
				details: { question, probabilities: answers },
			};
		},
	});

	runtime.catalog.register({
		id: "tool:judge-items",
		kind: "tool",
		title: "Judge many items",
		description:
			"Ask Jev one yes/no question about each of many items (files, log lines, findings, URLs) and get a probability per item, to sort or filter them without reading them all.",
		tools: ["judge_items"],
		exposure: "judged",
	});
}
