import { describe, expect, it } from "vitest";
import { DecisionEngine } from "../src/decision.ts";
import { HIGH_THINKING_FROM, swarmRouting } from "../src/decisions/swarm-routing.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

const thinkingAt = async (reasoning: number) =>
	(
		await new DecisionEngine({
			judge: new Judge({
				provider: new MockJudgeProvider(() => ({
					difficulty: { type: "score", score: 1 },
					reasoning: { type: "score", score: reasoning },
				})),
			}),
			defaultMode: "active",
		}).decide(swarmRouting, { task: "t" })
	).outcome.thinking;

describe("swarm.routing", () => {
	it("thinks hard only from reasoning 2.4, a little over 'A lot'", async () => {
		expect(HIGH_THINKING_FROM).toBe(2.4);
		expect(await thinkingAt(2.3)).toBe("medium");
		expect(await thinkingAt(2.4)).toBe("high");
		expect(await thinkingAt(1.1)).toBe("medium");
		expect(await thinkingAt(1)).toBe("low");
	});
});
