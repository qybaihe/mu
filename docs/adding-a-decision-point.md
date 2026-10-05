# Adding a decision point

A decision point is one bounded question a small judge answers about a small state, and the effect its answer has. This guide goes from the idea to a merged pull request. Open a [decision point proposal](https://github.com/qybaihe/mu/issues/new?template=decision_point.yml) first: agreeing on the question and the effect before code saves the most time.

## Is it a good decision point?

- **It comes up often**, and today it costs the big model tokens or attention, or a fixed rule gets it wrong.
- **A small state answers it.** The judge has a 32K window and reads fastest from a few short fields. If the question needs the whole conversation, it is not a judge's question.
- **The answer changes what mu does.** Admit or archive, run or ask, nudge or not. A verdict never makes the model ask the user something.
- **Doing nothing is safe.** When no judge answers, mu behaves as it would without the point.

## 1. Define the decision

Add `packages/kyrn-judge/src/decisions/<name>.ts`:

```ts
import { defineDecision } from "../decision.ts";

export interface ContinueInput {
	userMessage: string;
	finalMessage: string;
}
export type ContinueOutcome = "end" | "promised";

export const turnContinue = defineDecision({
	id: "turn.continue",
	version: 1, // bump whenever the wording or the policy changes, so ledger records stay comparable
	questions: {
		promised: {
			type: "boolean",
			instructions:
				"Does `final_message` say the assistant will now act, continue working, or call a tool, and then end without doing so?",
			criteria: { true: 'Like: "Let me run the tests next."', false: 'Like: "The fix is done and tests pass."' },
		},
	},
	cacheImpact: "append-only", // what acting on it does to the prompt cache: none, append-only or prefix-mutating
	latency: "inline", // inline blocks the agent loop, parallel races other work, background never blocks
	buildState: (input: ContinueInput) => ({ user_message: input.userMessage, final_message: input.finalMessage }),
	policy: (answers) => (answers.promised.probability >= 0.8 ? "promised" : "end"),
	fallback: () => "end",
});
```

(Simplified from the real [`turn-continue.ts`](../packages/kyrn-judge/src/decisions/turn-continue.ts). `capabilities` says what a question takes to answer, so a cascade can skip judges that cannot, such as the local one on questions about the request itself; see `decision.ts`.)

Question types: `boolean` (the probability of yes), `choice` (named answers, each with a description; it must include an escape answer such as `unclear` or `none`) and `score` (ordered levels). For questions over a list whose length is only known at run time (one per file, per lesson), use `questionsFor` and keep one shared state.

**Wording** decides how well a judge answers. What has worked:

- One predicate per question, about what the state says, with the state's fields named in backticks. No lists of conditions, no "and/or", no quantifiers.
- Ask what is needed given what stays, not whether something is on topic.
- Split a compound question in two and combine them in `policy`. `turn.continue` asked "asks for a go-ahead on work the user already asked for" as one question and scored 0.79 on a "how would you fix it?" message; split into `asks_go_ahead` and `work_requested`, it scored 0.29 and 0.38 there and 0.95 where it should.
- Boolean probabilities are compressed (clear cases land near 0.15 and 0.85), choice distributions are sharp: thresholds do not carry over between types. The kernel's usual bars are yes at 0.8 or more, no at 0.2 or less.
- Try the wording on real examples against the judge before writing the feature, and keep the numbers for the pull request.

## 2. Ask it from a feature

Features live in `src/extension/features/`. A feature reads its options, hooks pi's events, asks the decision and acts only in active mode:

```ts
export function registerContinuation(runtime: KyrnRuntime): void {
	const options = runtime.options("continuation", { enabled: true, waitMs: 3000, maxNudges: 2 });
	if (!options.enabled) return;
	runtime.pi.on("agent_end", failOpen(async (event, ctx) => {
		const input = { userMessage: runtime.turn.userMessage, finalMessage: lastText(event) };
		if (runtime.mode(turnContinue.id) !== "active") {
			void runtime.engine.decide(turnContinue, input).catch(() => {}); // shadow: record, change nothing
			return undefined;
		}
		const decision = await within(runtime.engine.decide(turnContinue, input), options.waitMs);
		if (decision?.source !== "judge" || decision.outcome === "end") return undefined;
		// act on the verdict
		return undefined;
	}));
}
```

- Wrap handlers in `failOpen`: a kernel error must never break the agent.
- Bound waits with `within`: a slow judge yields the fallback, not a stall. Batches go through `engine.decideMany`.
- Register the feature in the table in `src/extension/kyrn-judge.ts`. Order matters where handlers of the same event modify the same thing (for example, injection screening runs before admission).
- If the user should see what happened, present it with a code (`runtime.present`), add the kind to `src/extension/presentation.ts`, and document it in [presentation-codes.md](../kyrn/docs/features/presentation-codes.md).

## 3. Settings text

- Add the decision point (id, group, feature, title, summary) and the feature with its options to `src/manifest.ts`, in Chinese and English.
- Add the other languages to `packages/kyrn-judge/i18n/manifest.json` (each entry keeps the English it was translated from).
- Regenerate: `node packages/kyrn-judge/scripts/write-manifest.ts`. `test/manifest.test.ts` fails when a decision id or an option is missing.

## 4. Tests

Test the feature through pi's harness with the mock judge, so the tests need no network:

```ts
const provider = new MockJudgeProvider((request) =>
	"promised" in request.questions ? { promised: { type: "boolean", probability: 0.95 } } : {},
);
const harness = await createHarness({
	extensionFactories: [createKyrnJudgeExtension({ provider, mode: "active", config: parseConfig({}) })],
});
```

Cover: the verdict taking effect in active mode, nothing changing in shadow, the fallback when the judge is silent, and the limits (how often, how long). See `test/continuation.test.ts` and `test/injection.test.ts`.

## 5. The desktop app

In `desktop/packages/desktop/src/renderer/pages/conversation/KyrnPanel/Judge/`:

- `activity.ts`: map the decision id to a stage in `DECISIONS`, and add result facts if the outcome needs more than the default rendering.
- `questions.ts`: list its questions in `JUDGE_QUESTIONS`.
- `eventLine.ts`: a line for its presentation code, if it has one.
- Words in all 13 locales (`renderer/services/i18n/locales/*/common.json`), then `node scripts/generate-i18n-types.js` and `node scripts/check-i18n.js` from `desktop/`.
- `tests/unit/kyrn/judge/activity.test.ts` lists every decision id the app knows: add yours.

## 6. Documentation

- The decision point tables in the README and its translations (`docs/readme/`).
- `node scripts/write-docs-reference.mjs` regenerates [reference/decision-points.md](reference/decision-points.md) and [reference/features.md](reference/features.md) from the manifest.
- [kyrn/docs/04-injection-points.md](../kyrn/docs/04-injection-points.md), the map of where the judge is wired in.

## 7. The pull request

Say what the point decides, show a few real examples with the judge's probabilities, and say which mode it should ship in. New points ship in shadow until real sessions show the verdicts are right.
