import { describe, expect, it } from "vitest";
import { DecisionEngine } from "../src/decision.ts";
import { type TaskFrameInput, taskFrame } from "../src/decisions/task-frame.ts";
import { constraintId } from "../src/frame/frame.ts";
import { Judge } from "../src/judge.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const rule = "Do not edit the fixture.";
const input: TaskFrameInput = {
	userMessage: "Rename notes.md to NOTES.md, but never commit the changes.",
	frame: { goal: "Tidy the project notes" },
	activeConstraints: [{ text: rule, source: { turn: 2 } }],
	recentTurns: ["assistant: The notes have been reviewed."],
};
const pick = (choice: string, probabilities?: Record<string, number>, confidence?: number): Answer => ({
	type: "choice",
	choice,
	probabilities,
	confidence,
});

async function decide(answers: Record<string, Answer>, state = input, mode: "active" | "shadow" | "off" = "active") {
	const provider = new MockJudgeProvider(() => answers);
	const engine = new DecisionEngine({ judge: new Judge({ provider }), defaultMode: mode });
	return { decision: await engine.decide(taskFrame, state), provider };
}

describe("task.frame decision", () => {
	it("asks two independent questions in one request about the same message", async () => {
		const { decision, provider } = await decide({ change: pick("subgoal"), limit: pick("add", { add: 0.6 }) });
		expect(provider.calls).toHaveLength(1);
		const [call] = provider.calls;
		expect(Object.keys(call.questions)).toEqual(["change", "limit"]);
		expect(call.questions.change).toMatchObject({
			type: "choice",
			criteria: {
				new_task: expect.any(String),
				correction: expect.any(String),
				subgoal: expect.any(String),
				none: expect.any(String),
			},
		});
		expect(call.questions.change.type === "choice" && Object.keys(call.questions.change.criteria)).not.toContain(
			"constraint",
		);
		expect(call.questions.limit).toMatchObject({
			type: "choice",
			criteria: {
				add: expect.any(String),
				none: expect.any(String),
				unclear: expect.any(String),
				withdraw_1: expect.any(String),
				replace_1: expect.any(String),
				once_1: expect.any(String),
			},
		});
		expect(Object.keys(call.state as object)).toEqual(["user_message", "task_frame", "recent_turns"]);
		expect(call.state).toMatchObject({
			user_message: input.userMessage,
			task_frame: { goal: input.frame.goal, constraints: [{ position: 1, text: rule }] },
		});
		expect(taskFrame).toMatchObject({ version: 7, capabilities: "relate" });
		expect(decision.outcome).toEqual({ change: "subgoal", limit: { kind: "add" } });
	});

	it.each(["withdraw", "replace"] as const)("resolves a %s target against deduped full rule text", async (kind) => {
		const other = "Never publish the draft.";
		const activeConstraints = [
			{ text: other, source: { turn: 1 } },
			{ text: rule, source: { turn: 2 } },
			{ text: rule, source: { turn: 3 } },
		];
		const { decision, provider } = await decide(
			{ change: pick("correction", { correction: 0.91 }), limit: pick(`${kind}_2`, { [`${kind}_2`]: 0.9 }) },
			{ ...input, activeConstraints, frame: { ...input.frame, constraints: ["a compact summary"] } },
		);
		expect(provider.calls[0].state).toMatchObject({
			task_frame: {
				constraint_count: 2,
				constraints: [
					{ position: 1, text: other },
					{ position: 2, text: rule },
				],
			},
		});
		expect(provider.calls[0].questions.limit).toMatchObject({
			criteria: {
				[`${kind}_1`]: expect.stringContaining("rule 1"),
				[`${kind}_2`]: expect.stringContaining("rule 2"),
			},
		});
		expect(decision.outcome).toEqual({ change: "correction", limit: { kind, id: constraintId(rule) } });
	});

	it.each([
		{ choice: "add", supported: { kind: "add" } },
		{ choice: "withdraw_1", supported: { kind: "withdraw", id: constraintId(rule) } },
		{ choice: "replace_1", supported: { kind: "replace", id: constraintId(rule) } },
		{ choice: "once_1", supported: { kind: "allow_once", id: constraintId(rule) } },
	])("requires explicit evidence for $choice", async ({ choice, supported }) => {
		const cases = [
			{ answer: pick(choice), expected: { kind: "unclear" } },
			{ answer: pick(choice, undefined, 0.6), expected: supported },
			{ answer: pick(choice, { none: 0.4 }, 0.6), expected: supported },
			{ answer: pick(choice, { [choice]: 0.59 }, 0.99), expected: { kind: "unclear" } },
		];
		for (const { answer, expected } of cases) {
			const { decision } = await decide({ change: pick("none"), limit: answer });
			expect(decision).toMatchObject({ source: "judge", outcome: { change: "none", limit: expected } });
		}
	});

	it("does not mistake the first shown target for the first rule in /frame", async () => {
		const activeConstraints = [..."ABCDEFGHI"].map((file, index) => ({
			text: `Do not edit file ${file}.`,
			source: { turn: index },
		}));
		const provider = new MockJudgeProvider(({ questions }) => {
			const limit = questions.limit;
			const first = limit.type === "choice" && Object.hasOwn(limit.criteria, "withdraw_1");
			return { change: pick("subgoal"), limit: pick(first ? "withdraw_1" : "unclear", undefined, 1) };
		});
		const engine = new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "active" });
		const full = {
			...input,
			userMessage: "Retire the first rule in /frame, and update the notes.",
			activeConstraints,
		};
		const recent = activeConstraints.slice(1);
		const bounded = await engine.decide(taskFrame, full);
		const onlyRecent = await engine.decide(taskFrame, { ...full, activeConstraints: recent });
		expect(provider.calls[0].state).toMatchObject({
			task_frame: {
				constraint_count: 9,
				omitted_constraint_count: 1,
				constraints: recent.map(({ text }, index) => ({ position: index + 2, text })),
			},
		});
		expect(provider.calls[1].state).toMatchObject({
			task_frame: {
				constraint_count: 8,
				omitted_constraint_count: 0,
				constraints: recent.map(({ text }, index) => ({ position: index + 1, text })),
			},
		});
		expect(bounded.outcome).toEqual({ change: "subgoal", limit: { kind: "unclear" } });
		expect(onlyRecent.outcome).toEqual({
			change: "subgoal",
			limit: { kind: "withdraw", id: constraintId(recent[0].text) },
		});
		const second = await decide(
			{ change: pick("none"), limit: pick("withdraw_2", { withdraw_2: 1 }) },
			{ ...full, userMessage: "Retire the second rule." },
		);
		expect(second.decision.outcome.limit).toEqual({ kind: "withdraw", id: constraintId(recent[0].text) });
		const missing = await decide({ change: pick("none"), limit: pick("withdraw_1", { withdraw_1: 1 }) }, full);
		expect(missing.decision).toMatchObject({ source: "fallback", reason: "error:invalid_response" });
	});

	it("retains positions for partial and overlong rows and numbers exact duplicates only once", async () => {
		const partial = { text: "Never publish the draft unless", partial: true, source: { turn: 1 } };
		const complete = { text: rule, source: { turn: 2 } };
		const long = { text: `Avoid editing ${"that file ".repeat(120)}`, source: { turn: 3 } };
		const last = { text: "Never publish the draft unless I approve.", source: { turn: 4 } };
		const activeConstraints = [partial, complete, long, { ...partial, partial: false }, complete, last];
		const { decision, provider } = await decide(
			{ change: pick("none"), limit: pick("replace_4", { replace_4: 0.9 }) },
			{ ...input, activeConstraints },
		);
		const { state, questions } = provider.calls[0];
		expect(state).toMatchObject({
			task_frame: {
				constraint_count: 4,
				omitted_constraint_count: 2,
				constraints: [
					{ position: 2, text: complete.text },
					{ position: 4, text: last.text },
				],
			},
		});
		expect(questions.limit.type === "choice" && Object.keys(questions.limit.criteria)).toEqual([
			"none",
			"add",
			"unclear",
			"withdraw_2",
			"replace_2",
			"once_2",
			"withdraw_4",
			"replace_4",
			"once_4",
		]);
		expect(decision.outcome.limit).toEqual({ kind: "replace", id: constraintId(last.text) });
	});

	it.each([
		{ text: "Always ask me before committing.", choice: "once_1", kind: "allow_once" },
		{ text: "Hold this commit until I approve it.", choice: "withdraw_1", kind: "withdraw" },
	])("keeps the requested work alongside $kind", async ({ text, choice, kind }) => {
		const { decision, provider } = await decide(
			{ change: pick("subgoal", { subgoal: 0.9 }), limit: pick(choice, { [choice]: 0.9 }) },
			{
				...input,
				userMessage: "I approve this commit once. Also add a test for the empty input.",
				activeConstraints: [{ text, source: { turn: 2 } }],
			},
		);
		expect(provider.calls[0].questions.limit).toMatchObject({
			instructions: expect.stringContaining("is `once_N`, not `withdraw_N`"),
			criteria: {
				once_1: expect.stringContaining("keep the rule"),
				withdraw_1: expect.stringContaining("until approval"),
			},
		});
		expect(decision.outcome).toEqual({ change: "subgoal", limit: { kind, id: constraintId(text) } });
	});

	it.each(["withdraw_1", "once_1"])(
		"doesn't act on %s when the judge read only part of the instruction",
		async (choice) => {
			const { decision, provider } = await decide(
				{ change: pick("correction"), limit: pick(choice, { [choice]: 1 }) },
				{
					...input,
					userMessage: `Drop the rule ${"for this example ".repeat(50)}but keep enforcing it on real edits.`,
				},
			);
			expect(provider.calls[0].state).toMatchObject({ user_message: expect.stringMatching(/…$/) });
			expect(decision.outcome.limit).toEqual({ kind: "unclear" });
		},
	);

	it("redacts rule text before it reaches the provider or the recorded request", async () => {
		const namedValue = "dummy-named-6128";
		const knownName = 'dummy-known-name\\with"quotes\nand a newline';
		const knownValue = 'dummy-known-value\\with"quotes\nand a newline';
		const longRuleMarker = "dummy-overlong-only";
		const longRuleSecret = `${longRuleMarker}-and-the-rest-8734`;
		const text = `Do not log this config:\n{"password": "${namedValue}", "${knownName}": "${knownValue}"}\nKeep the cache private.`;
		// The secret straddles the rule cap, so clipping to a prefix would defeat whole-value redaction.
		const long = `Do not log ${"x".repeat(965)} ${longRuleSecret}, even for tests.`;
		const ledger = new MemoryLedger();
		const provider = new MockJudgeProvider(() => ({ limit: pick("once_1", { once_1: 1 }) }));
		const engine = new DecisionEngine({
			judge: new Judge({ provider }),
			ledger,
			defaultMode: "active",
			recordState: true,
			knownSecrets: () => [knownName, knownValue, longRuleSecret],
		});
		const decision = await engine.decide(taskFrame, {
			...input,
			userMessage: "You can log that config once for this test.",
			activeConstraints: [
				{ text, source: { turn: 1 } },
				{ text: long, source: { turn: 2 } },
			],
		});
		const [call] = provider.calls;
		expect(call.state).toMatchObject({
			task_frame: {
				constraint_count: 2,
				omitted_constraint_count: 1,
				constraints: [
					{
						position: 1,
						text: 'Do not log this config:\n{"password": "[redacted]", "[redacted]": "[redacted]"}\nKeep the cache private.',
					},
				],
			},
		});
		expect(decision.outcome.limit).toEqual({ kind: "allow_once", id: constraintId(text) });
		expect(ledger.records).toHaveLength(1);
		expect(ledger.records[0]).toMatchObject({ state: call.state, questions: call.questions });
		for (const request of [call, ledger.records[0]]) {
			const encoded = JSON.stringify(request);
			// Check both literal and escaped forms by matching a distinctive part of each dummy secret.
			for (const marker of [namedValue, "dummy-known-name", "dummy-known-value", longRuleMarker]) {
				expect(encoded).not.toContain(marker);
			}
			expect(JSON.stringify(request.questions)).not.toContain("Keep the cache private");
		}
	});

	it("does not pool correction with limits or promote a weak limit pick", async () => {
		const { decision } = await decide({
			change: pick("correction", { correction: 0.92 }),
			limit: pick("add", { add: 0.49, withdraw_1: 0.38, none: 0.13 }),
		});
		expect(decision.outcome).toEqual({ change: "correction", limit: { kind: "unclear" } });
		const torn = await decide({
			change: pick("new_task", { new_task: 0.45, subgoal: 0.4, none: 0.15 }),
			limit: pick("none"),
		});
		expect(torn.decision.outcome).toEqual({ change: "unclear", limit: { kind: "none" } });
	});

	it("shadow records both verdicts; off asks nothing; a missing answer doesn't lift a rule", async () => {
		const answers = { change: pick("correction"), limit: pick("withdraw_1", { withdraw_1: 0.9 }) };
		const shadow = await decide(answers, input, "shadow");
		const fallback = { change: "none", limit: { kind: "none" } };
		expect(shadow.decision).toMatchObject({
			outcome: fallback,
			source: "fallback",
			judged: { change: "correction", limit: { kind: "withdraw", id: constraintId(rule) } },
		});
		const off = await decide(answers, input, "off");
		expect(off.decision).toMatchObject({ outcome: fallback, source: "fallback", reason: "off" });
		expect(off.provider.calls).toHaveLength(0);
		expect((await decide({})).decision.outcome).toEqual(fallback);
	});
});
