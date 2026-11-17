import { describe, expect, it } from "vitest";
import { DecisionEngine } from "../src/decision.ts";
import { chatByRule, inputPreflight, type PreflightInput } from "../src/decisions/input-preflight.ts";
import { JudgeError } from "../src/errors.ts";
import { Judge } from "../src/judge.ts";
import { pickChoice, threeZone } from "../src/policy.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";

const sideQuestion: PreflightInput = {
	userMessage: "By the way, what does the refreshToken helper do? Just curious.",
	recentTurns: ["user asked to fix a flaky login test", "agent ran the suite: 1 failure in login.spec.ts"],
	taskFrame: { goal: "Fix the flaky login test", currentSubgoal: "find why the session cookie is missing in CI" },
};

function activeEngine(answers: Record<string, Answer>) {
	const provider = new MockJudgeProvider(() => answers);
	return { provider, engine: new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "active" }) };
}

const yes: Answer = { type: "boolean", probability: 0.95 };
const no: Answer = { type: "boolean", probability: 0.04 };

describe("input preflight", () => {
	it("puts a side question about existing code in the chat gear", async () => {
		const { engine, provider } = activeEngine({
			turn_type: { type: "choice", choice: "chat_question", probabilities: { chat_question: 0.88, other: 0.02 } },
			is_side_question: yes,
			needs_clarification: no,
			needs_files_changed: no,
			swarm_worthy: no,
			plan_first: no,
			task_complexity: { type: "score", score: 0.8 },
			reasoning_depth: { type: "score", score: 1.1 },
			tool_complexity: { type: "score", score: 0.9 },
		});

		const decision = await engine.decide(inputPreflight, sideQuestion);

		expect(decision.source).toBe("judge");
		expect(decision.outcome).toMatchObject({
			turnType: "chat_question",
			gear: "chat",
			sideQuestion: "yes",
			swarmWorthy: "no",
		});
		// The judge sees a digest with named fields, never the raw session.
		expect(provider.calls[0].state).toEqual({
			task_frame: {
				goal: "Fix the flaky login test",
				constraints: [],
				current_subgoal: "find why the session cookie is missing in CI",
			},
			recent_turns: sideQuestion.recentTurns,
			current_action: null,
			user_message: sideQuestion.userMessage,
		});
		// A bounded-window judge cuts the tail of the state, so the message being judged leads.
		expect(Object.keys(provider.calls[0].state as object)[0]).toBe("user_message");
	});

	it("never calls the first message of a session a side question", async () => {
		const { engine } = activeEngine({
			turn_type: { type: "choice", choice: "quick_lookup", probabilities: { quick_lookup: 0.9 } },
			is_side_question: yes,
			needs_files_changed: no,
		});

		const decision = await engine.decide(inputPreflight, {
			userMessage: "Which file defines the AgentSession class?",
			recentTurns: [],
		});

		expect(decision.outcome).toMatchObject({ turnType: "quick_lookup", sideQuestion: "no" });
	});

	it("keeps a lookup out of the heavy gear however wide the judge rates its scope", async () => {
		// "Go and find it yourself" was rated as touching the whole codebase and went heavy, hive hint and all.
		const { engine } = activeEngine({
			turn_type: { type: "choice", choice: "quick_lookup", probabilities: { quick_lookup: 0.73, research: 0.23 } },
			needs_clarification: yes,
			needs_files_changed: no,
			task_complexity: { type: "score", score: 2.52 },
		});

		const decision = await engine.decide(inputPreflight, {
			userMessage: "我们的这个工作目录，你自己去找吧。",
			recentTurns: ["user: 深度分析一下 Jev", "assistant: 你说的 Jev 具体指哪个组件？"],
		});

		expect(decision.outcome).toMatchObject({ turnType: "quick_lookup", gear: "standard" });
	});

	it("puts a decomposable migration in the heavy gear and flags it for the swarm", async () => {
		const { engine } = activeEngine({
			turn_type: { type: "choice", choice: "multi_step_task", probabilities: { multi_step_task: 0.9 } },
			is_side_question: no,
			needs_clarification: no,
			needs_files_changed: yes,
			swarm_worthy: yes,
			plan_first: yes,
			task_complexity: { type: "score", score: 2.9 },
			reasoning_depth: { type: "score", score: 2.2 },
			tool_complexity: { type: "score", score: 2.8 },
		});

		const decision = await engine.decide(inputPreflight, {
			userMessage: "把 auth 包从 cookie 会话迁移到 JWT，同时更新所有测试和文档，三个子包可以分开做。",
			recentTurns: [],
		});

		expect(decision.outcome).toMatchObject({ gear: "heavy", swarmWorthy: "yes", planFirst: "yes" });
	});

	it("treats a low-probability or escape pick as an unknown turn type", async () => {
		const { engine } = activeEngine({
			turn_type: { type: "choice", choice: "single_edit", probabilities: { single_edit: 0.34, quick_lookup: 0.33 } },
			needs_files_changed: yes,
		});

		const decision = await engine.decide(inputPreflight, sideQuestion);

		expect(decision.outcome).toMatchObject({ turnType: "unknown", gear: "standard", needsFilesChanged: "yes" });
	});

	it("abstains to stock behavior when nothing readable comes back", async () => {
		const provider = new MockJudgeProvider();
		const engine = new DecisionEngine({ judge: new Judge({ provider }), defaultMode: "active" });

		const decision = await engine.decide(inputPreflight, sideQuestion);

		expect(decision).toMatchObject({ source: "fallback", reason: "abstain" });
		expect(decision.outcome).toMatchObject({ turnType: "unknown", gear: "standard" });
	});

	it("asks every question in a single request, each one about the message and none a forecast", async () => {
		const { engine, provider } = activeEngine({});
		await engine.decide(inputPreflight, sideQuestion);

		expect(provider.calls).toHaveLength(1);
		expect(Object.keys(provider.calls[0].questions)).toEqual([
			"turn_type",
			"is_side_question",
			"needs_clarification",
			"needs_files_changed",
			"swarm_worthy",
			"plan_first",
			"task_complexity",
			"reasoning_depth",
			"tool_complexity",
		]);
	});
});

describe("policy helpers", () => {
	it("reads probabilities in three zones", () => {
		expect(threeZone({ type: "boolean", probability: 0.8 })).toBe("yes");
		expect(threeZone({ type: "boolean", probability: 0.2 })).toBe("no");
		expect(threeZone({ type: "boolean", probability: 0.79 })).toBe("unsure");
		expect(threeZone({ type: "boolean", probability: 0.6 }, { no: 0.4, yes: 0.6 })).toBe("yes");
		expect(() => threeZone({ type: "boolean", probability: 0.5 }, { no: 0.7, yes: 0.3 })).toThrow(RangeError);
	});

	it("declines escape options and weak picks", () => {
		expect(pickChoice({ type: "choice", choice: "other" })).toBeUndefined();
		expect(pickChoice({ type: "choice", choice: "billing", probabilities: { billing: 0.41 } })).toBeUndefined();
		expect(
			pickChoice({ type: "choice", choice: "billing", probabilities: { billing: 0.41 } }, { minProbability: 0.4 }),
		).toBe("billing");
		// No distribution from the provider: trust the pick.
		expect(pickChoice({ type: "choice", choice: "billing" })).toBe("billing");
	});

	it("treats an obvious chat message as chat when the judge has no usable pick, or is down", async () => {
		// What a small local judge really said about "猫和狗有什么区别": "other" at 0.83.
		const { engine } = activeEngine({
			turn_type: { type: "choice", choice: "other", probabilities: { other: 0.83, quick_lookup: 0.07 } },
			needs_files_changed: no,
		});
		const chat: PreflightInput = {
			userMessage: "猫和狗有什么区别",
			recentTurns: ["user: 你好", "assistant: 你好！"],
		};

		const decision = await engine.decide(inputPreflight, chat);
		expect(decision.outcome).toMatchObject({ turnType: "chat", gear: "chat" });

		const down = new DecisionEngine({
			judge: new Judge({
				provider: {
					id: "down",
					evaluate: async () => {
						throw new JudgeError("unreachable", "no sidecar");
					},
				},
			}),
			defaultMode: "active",
		});
		expect((await down.decide(inputPreflight, chat)).outcome).toMatchObject({ turnType: "chat", gear: "chat" });
		expect((await down.decide(inputPreflight, sideQuestion)).outcome.turnType).toBe("unknown");
	});

	it("lets a confident judge overrule the chat rule, and keeps the rule away from steering messages", async () => {
		const { engine } = activeEngine({
			turn_type: { type: "choice", choice: "single_edit", probabilities: { single_edit: 0.97 } },
			needs_files_changed: yes,
		});
		const decision = await engine.decide(inputPreflight, { userMessage: "make it blue", recentTurns: [] });
		expect(decision.outcome.turnType).toBe("single_edit");

		for (const message of [
			"你好",
			"thanks!",
			"猫和狗有什么区别",
			"what's the capital of France?",
			"帮我写一首关于秋天的诗",
		]) {
			expect(chatByRule(message, false), message).toBe(true);
		}
		for (const message of [
			"fix the typo in README",
			"这个函数在哪里定义的？",
			"跑一下测试",
			"why is userId undefined",
			"看看 src/auth.ts",
			"npm install 报错了",
		]) {
			expect(chatByRule(message, false), message).toBe(false);
		}
		// Once work is under way, only greetings and thanks are chat: "one more time" is steering, not small talk.
		expect(chatByRule("one more time, slower", true)).toBe(false);
		expect(chatByRule("谢谢", true)).toBe(true);
	});
});
