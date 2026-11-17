import { describe, expect, it, vi } from "vitest";
import { JudgeError } from "../src/errors.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { JudgeQueue } from "../src/queue.ts";
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

	it("takes the question's own options only, and keeps a choice's probabilities for them that are probabilities", async () => {
		const questions = {
			team: { type: "choice", instructions: "Which team?", criteria: { billing: null, other: null } },
		} as const satisfies Questions;
		for (const choice of ["toString", "constructor", "__proto__"]) {
			const inherited = new Judge({ provider: new MockJudgeProvider(() => ({ team: { type: "choice", choice } })) });
			await expect(inherited.evaluate({ state: "s", questions })).rejects.toMatchObject({
				kind: "invalid_response",
			});
		}

		const noisy = new Judge({
			provider: new MockJudgeProvider(() => ({
				team: {
					type: "choice",
					choice: "billing",
					probabilities: { billing: 0.8, other: Number.NaN, shipping: 0.2, toString: 0.1 },
				},
			})),
		});
		const { answers } = await noisy.evaluate({ state: "s", questions });
		expect(answers.team).toEqual({ type: "choice", choice: "billing", probabilities: { billing: 0.8 } });

		const none = new Judge({
			provider: new MockJudgeProvider(() => ({
				team: { type: "choice", choice: "other", probabilities: { billing: 4, shipping: 1 } },
			})),
		});
		expect((await none.evaluate({ state: "s", questions })).answers.team).toEqual({
			type: "choice",
			choice: "other",
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

/** A server that answers when the test lets it, and says what it was sent, in order, and how many at a time. */
function slowServer() {
	const sent: string[] = [];
	const waiting: (() => void)[] = [];
	let atOnce = 0;
	let most = 0;
	const provider: JudgeProvider = {
		id: "served-here",
		evaluate: (request: JudgeRequest) =>
			new Promise<ProviderResponse>((resolve, reject) => {
				sent.push(String(request.state));
				most = Math.max(most, ++atOnce);
				const answer = () => {
					atOnce--;
					resolve({
						answers: Object.fromEntries(
							Object.keys(request.questions).map((id) => [id, { type: "boolean", probability: 0.9 }]),
						),
					});
				};
				waiting.push(answer);
				request.signal?.addEventListener("abort", () => {
					atOnce--;
					reject(request.signal?.reason);
				});
			}),
	};
	/** Answers the request the server has had longest, once it has one. */
	const answerNext = async () => {
		while (waiting.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1));
		waiting.shift()?.();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	};
	return { provider, sent, answerNext, most: () => most };
}

describe("a judge that answers one request at a time", () => {
	it("is sent one request at a time, what the turn waits for before the rest", async () => {
		const server = slowServer();
		const judge = new Judge({ provider: server.provider, queue: new JudgeQueue(1) });
		const ask = (state: string, latency?: "inline" | "parallel" | "background") =>
			judge.evaluate({ state, questions: { q: yesNo }, latency });

		const all = [
			ask("first to come"),
			ask("board, nobody waits".padEnd(40), "background"),
			ask("a large question of the turn".padEnd(4000)),
			ask("preload, races the opening".padEnd(40), "parallel"),
			ask("a small question of the turn"),
		];
		for (let answered = 0; answered < all.length; answered++) await server.answerNext();
		await Promise.all(all);

		expect(server.sent.map((state) => state.trim())).toEqual([
			"first to come",
			"a small question of the turn",
			"a large question of the turn",
			"preload, races the opening",
			"board, nobody waits",
		]);
		expect(server.most()).toBe(1);
	});

	it("says how long a request stood in line, and nothing for one that went at once", async () => {
		const server = slowServer();
		const judge = new Judge({ provider: server.provider, queue: new JudgeQueue(1) });
		const first = judge.evaluate({ state: "first", questions: { q: yesNo } });
		const second = judge.evaluate({ state: "second", questions: { q: yesNo } });
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
		await server.answerNext();
		await server.answerNext();

		expect((await first).queuedMs).toBeUndefined();
		const waited = await second;
		expect(waited.queuedMs).toBeGreaterThanOrEqual(20);
		// What the asker saw is the wait and the answer together.
		expect(waited.latencyMs).toBeGreaterThanOrEqual(waited.queuedMs as number);
	});

	it("counts the time limit from when a request is sent: standing in line does not use it up", async () => {
		// Each request takes 250 ms, and the judge has 400 ms for one: the second is answered 500 ms after it was asked.
		// On a clock the test moves, so that a busy machine cannot make either request late.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		try {
			const slow: JudgeProvider = {
				id: "slow",
				evaluate: () =>
					new Promise<ProviderResponse>((resolve) => {
						setTimeout(() => resolve({ answers: { q: { type: "boolean", probability: 0.9 } } }), 250);
					}),
			};
			const judge = new Judge({ provider: slow, timeoutMs: 400, queue: new JudgeQueue(1) });
			const both = Promise.all([
				judge.evaluate({ state: "first", questions: { q: yesNo } }),
				judge.evaluate({ state: "second", questions: { q: yesNo } }),
			]);
			await vi.advanceTimersByTimeAsync(250);
			await vi.advanceTimersByTimeAsync(250);
			const [first, second] = await both;
			expect(first).toMatchObject({ latencyMs: 250 });
			expect(first.queuedMs).toBeUndefined();
			expect(second).toMatchObject({ latencyMs: 500, queuedMs: 250 });
			expect(second.answers.q.probability).toBe(0.9);

			// A request that takes longer than the limit once it is sent still fails, however short its wait in line.
			const slower: JudgeProvider = { id: "slower", evaluate: () => new Promise<ProviderResponse>(() => {}) };
			const strict = new Judge({ provider: slower, timeoutMs: 400, queue: new JudgeQueue(1) });
			const failed = strict.evaluate({ state: "never answered", questions: { q: yesNo } }).catch((error) => error);
			await vi.advanceTimersByTimeAsync(400);
			expect(await failed).toMatchObject({
				name: "JudgeError",
				kind: "timeout",
				message: "Judge call exceeded 400 ms",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not send a request that stood in line for as long as the judge has to answer one", async () => {
		const server = slowServer();
		const judge = new Judge({ provider: server.provider, timeoutMs: 40, queue: new JudgeQueue(1) });
		const stuck = judge.evaluate({ state: "stuck", questions: { q: yesNo } });
		const behind = judge.evaluate({ state: "behind", questions: { q: yesNo } });

		await expect(behind).rejects.toMatchObject({ name: "JudgeError", kind: "timeout" });
		await expect(stuck).rejects.toMatchObject({ kind: "timeout" });
		expect(server.sent).toEqual(["stuck"]);
	});

	it("sends the parts of a large question set one at a time too, and drops the rest when one fails", async () => {
		const server = slowServer();
		const judge = new Judge({ provider: server.provider, maxQuestionsPerRequest: 2, queue: new JudgeQueue(1) });
		const questions = { a: yesNo, b: yesNo, c: yesNo, d: yesNo, e: yesNo };
		const whole = judge.evaluate({ state: "skills", questions });
		for (let part = 0; part < 3; part++) await server.answerNext();
		expect(Object.keys((await whole).answers)).toEqual(["a", "b", "c", "d", "e"]);
		expect(server.sent).toEqual(["skills", "skills", "skills"]);
		expect(server.most()).toBe(1);

		const failing: JudgeProvider = {
			id: "failing",
			evaluate: async (request: JudgeRequest) => {
				server.sent.push(`failing: ${Object.keys(request.questions).join(",")}`);
				throw new JudgeError("server", "the model crashed");
			},
		};
		const broken = new Judge({ provider: failing, maxQuestionsPerRequest: 2, queue: new JudgeQueue(1) });
		await expect(broken.evaluate({ state: "skills", questions })).rejects.toMatchObject({ kind: "server" });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(server.sent.filter((state) => state.startsWith("failing"))).toEqual(["failing: a,b"]);
	});

	it("never sends a request that is aborted while it stands in line", async () => {
		const server = slowServer();
		const judge = new Judge({ provider: server.provider, queue: new JudgeQueue(1) });
		const first = judge.evaluate({ state: "first", questions: { q: yesNo } });
		const stop = new AbortController();
		const dropped = judge.evaluate({ state: "dropped", questions: { q: yesNo }, signal: stop.signal });
		stop.abort();
		await expect(dropped).rejects.toMatchObject({ kind: "aborted" });
		await server.answerNext();
		await first;
		expect(server.sent).toEqual(["first"]);
	});

	it("shares its line with every judge that asks the same server", async () => {
		const server = slowServer();
		const queue = new JudgeQueue(1);
		const tiers = new Judge({ provider: server.provider, queue });
		const route = new Judge({ provider: server.provider, queue });
		const all = [
			tiers.evaluate({ state: "from the tiers", questions: { q: yesNo } }),
			route.evaluate({ state: "from a route", questions: { q: yesNo } }),
		];
		await server.answerNext();
		await server.answerNext();
		await Promise.all(all);
		expect(server.most()).toBe(1);
	});
});
