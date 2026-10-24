import { describe, expect, it } from "vitest";
import { JudgeError } from "../src/errors.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { JudgeProvider, JudgeRequest, ProviderResponse, Questions } from "../src/types.ts";

const yesNo = { type: "boolean", instructions: "Is it?" } as const;

describe("Judge", () => {
	it("returns typed answers, usage and the provider id", async () => {
		const provider = new MockJudgeProvider(() => ({ urgent: { type: "boolean", probability: 0.93 } }));
		const judge = new Judge({ provider });

		const result = await judge.evaluate({ state: "ticket text", questions: { urgent: yesNo } });

		expect(result.answers.urgent.probability).toBe(0.93);
		expect(result.requests).toBe(1);
		expect(result.providerId).toBe("mock");
	});

	it("fans out question sets above the per-request limit and merges the answers", async () => {
		const provider = new MockJudgeProvider();
		const judge = new Judge({ provider, maxQuestionsPerRequest: 32 });
		const questions: Record<string, typeof yesNo> = {};
		for (let index = 0; index < 70; index++) questions[`q${index}`] = yesNo;

		const result = await judge.evaluate({ state: "s", questions });

		expect(result.requests).toBe(3);
		expect(provider.calls.map((call) => Object.keys(call.questions).length)).toEqual([32, 32, 6]);
		expect(Object.keys(result.answers)).toHaveLength(70);
		// Every chunk judges the same shared state.
		expect(new Set(provider.calls.map((call) => call.state))).toEqual(new Set(["s"]));
	});

	it("classifies a slow provider as a timeout", async () => {
		const slow: JudgeProvider = {
			id: "slow",
			evaluate: (request: JudgeRequest) =>
				new Promise<ProviderResponse>((_resolve, reject) => {
					request.signal?.addEventListener("abort", () => reject(request.signal?.reason));
				}),
		};
		const judge = new Judge({ provider: slow, timeoutMs: 20 });

		await expect(judge.evaluate({ state: "s", questions: { q: yesNo } })).rejects.toMatchObject({
			name: "JudgeError",
			kind: "timeout",
		});
	});

	it("times out a provider that ignores AbortSignal", async () => {
		const stuck: JudgeProvider = {
			id: "stuck",
			evaluate: () => new Promise<ProviderResponse>(() => {}),
		};
		const judge = new Judge({ provider: stuck, timeoutMs: 10 });

		await expect(judge.evaluate({ state: "s", questions: { q: yesNo } })).rejects.toMatchObject({
			kind: "timeout",
		});
	});

	it("classifies a caller abort as aborted, not as a timeout", async () => {
		const hanging: JudgeProvider = {
			id: "hanging",
			evaluate: (request: JudgeRequest) =>
				new Promise<ProviderResponse>((_resolve, reject) => {
					request.signal?.addEventListener("abort", () => reject(request.signal?.reason));
				}),
		};
		const judge = new Judge({ provider: hanging, timeoutMs: 5000 });
		const controller = new AbortController();
		const pending = judge.evaluate({ state: "s", questions: { q: yesNo }, signal: controller.signal });
		controller.abort();

		await expect(pending).rejects.toMatchObject({ kind: "aborted" });
	});

	it("rejects answers that do not match the question", async () => {
		const questions = {
			team: { type: "choice", instructions: "Which team?", criteria: { billing: null, other: null } },
			level: { type: "score", instructions: "How bad?", criteria: ["fine", "bad"] },
		} as const satisfies Questions;

		const unknownOption = new Judge({
			provider: new MockJudgeProvider(() => ({ team: { type: "choice", choice: "shipping" } })),
		});
		await expect(unknownOption.evaluate({ state: "s", questions })).rejects.toMatchObject({
			kind: "invalid_response",
		});

		const outOfRange = new Judge({
			provider: new MockJudgeProvider(() => ({ level: { type: "score", score: 4 } })),
		});
		await expect(outOfRange.evaluate({ state: "s", questions })).rejects.toBeInstanceOf(JudgeError);

		const wrongType = new Judge({
			provider: new MockJudgeProvider(() => ({ level: { type: "boolean", probability: 0.5 } })),
		});
		await expect(wrongType.evaluate({ state: "s", questions })).rejects.toMatchObject({
			kind: "invalid_response",
		});
	});

	it("refuses malformed question sets before any I/O", async () => {
		const provider = new MockJudgeProvider();
		const judge = new Judge({ provider });

		await expect(judge.evaluate({ state: "s", questions: {} })).rejects.toBeInstanceOf(TypeError);
		await expect(
			judge.evaluate({ state: "s", questions: { level: { type: "score", instructions: "?", criteria: ["only"] } } }),
		).rejects.toBeInstanceOf(TypeError);
		expect(provider.calls).toHaveLength(0);
	});
});
