import { describe, expect, it } from "vitest";
import { BUILT_IN_JUDGES, parseConfig } from "../src/config.ts";
import { LogprobJudgeProvider, labelDistribution, renderLabeledPrompt } from "../src/providers/logprob.ts";
import { buildJudge } from "../src/registry.ts";
import type { Questions } from "../src/types.ts";

const questions = {
	edit: { type: "boolean", instructions: "Does `message` ask for a code change?" },
	kind: {
		type: "choice",
		instructions: "What is it?",
		criteria: { chat: "Small talk", task: "Work to do", other: null },
	},
	size: { type: "score", instructions: "How big?", criteria: ["small", "medium", "large"] },
} satisfies Questions;

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
	headers: unknown;
}

/** Answers each request with the first-token alternatives the test gives for its LABELS line. */
function fakeFetch(
	alternatives: (labels: string) => { token: string; logprob: number }[],
	captured: CapturedRequest[] = [],
): typeof fetch {
	return async (input, init) => {
		const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
		captured.push({ url: String(input), body, headers: init?.headers });
		const labels = /LABELS: (.*)$/.exec(body.messages[1].content)?.[1] ?? "";
		return new Response(
			JSON.stringify({
				model: "served-name",
				choices: [{ logprobs: { content: [{ token: "x", logprob: 0, top_logprobs: alternatives(labels) }] } }],
				usage: { prompt_tokens: 100, completion_tokens: 1 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};
}

const answersByLabels = (labels: string) => {
	if (labels === "yes, no")
		return [
			{ token: "yes", logprob: Math.log(0.6) },
			{ token: " Yes", logprob: Math.log(0.2) },
			{ token: "no", logprob: Math.log(0.1) },
			{ token: "The", logprob: Math.log(0.1) },
		];
	if (labels === "A, B, C")
		return [
			{ token: "B", logprob: Math.log(0.7) },
			{ token: "A", logprob: Math.log(0.2) },
			{ token: "C", logprob: Math.log(0.1) },
		];
	return [
		{ token: "2", logprob: Math.log(0.5) },
		{ token: "1", logprob: Math.log(0.5) },
	];
};

describe("renderLabeledPrompt", () => {
	it("gives every answer a one-token label and lists the labels last", () => {
		const choice = renderLabeledPrompt({ message: "fix the bug" }, questions.kind);
		expect(choice.labels).toEqual({ A: "chat", B: "task", C: "other" });
		expect(choice.messages[1].content).toBe(
			'STATE:\n{\n "message": "fix the bug"\n}\n\nQUESTION:\nWhat is it?\nA: chat - Small talk\nB: task - Work to do\nC: other\n\nLABELS: A, B, C',
		);
		expect(renderLabeledPrompt("s", questions.size).labels).toEqual({ "0": "0", "1": "1", "2": "2" });
		expect(renderLabeledPrompt("s", questions.edit).messages[1].content).toBe(
			"STATE:\ns\n\nQUESTION:\nDoes `message` ask for a code change?\n\nLABELS: yes, no",
		);
	});
});

describe("labelDistribution", () => {
	it("sums case variants of yes and no, normalizes over the labels and reports their share", () => {
		const { probabilities, mass } = labelDistribution(answersByLabels("yes, no"), ["yes", "no"]);
		expect(probabilities.yes).toBeCloseTo(8 / 9);
		expect(probabilities.no).toBeCloseTo(1 / 9);
		expect(mass).toBeCloseTo(0.9);
	});
});

describe("LogprobJudgeProvider", () => {
	it("asks one question per request and reads each answer off the first token", async () => {
		const captured: CapturedRequest[] = [];
		const provider = new LogprobJudgeProvider({
			baseUrl: "https://api.tokenfactory.nebius.com/v1/",
			model: "nvidia/Nemotron-3_5-Lightning",
			apiKey: () => "nb_test",
			keyName: "NEBIUS_API_KEY",
			body: { chat_template_kwargs: { enable_thinking: false } },
			fetch: fakeFetch(answersByLabels, captured),
		});

		const response = await provider.evaluate({ state: { message: "fix the bug" }, questions });

		expect(response.answers.edit).toMatchObject({ type: "boolean" });
		expect(response.answers.edit.type === "boolean" && response.answers.edit.probability).toBeCloseTo(8 / 9);
		expect(response.answers.kind).toMatchObject({ type: "choice", choice: "task" });
		expect(response.answers.size).toMatchObject({ type: "score", score: 1.5 });
		expect(response.usage).toEqual({ inputTokens: 300, outputTokens: 3 });
		expect(response.warnings).toBeUndefined();
		expect(provider.id).toBe("api.tokenfactory.nebius.com:nvidia/Nemotron-3_5-Lightning");
		expect(captured).toHaveLength(3);
		expect(captured[0].url).toBe("https://api.tokenfactory.nebius.com/v1/chat/completions");
		expect(captured[0].headers).toMatchObject({ Authorization: "Bearer nb_test" });
		expect(captured[0].body).toMatchObject({
			model: "nvidia/Nemotron-3_5-Lightning",
			max_tokens: 1,
			temperature: 0,
			logprobs: true,
			top_logprobs: 20,
			chat_template_kwargs: { enable_thinking: false },
		});
	});

	it("warns when the labels hold little of the first token, and fails when they hold none", async () => {
		const off = new LogprobJudgeProvider({
			baseUrl: "http://127.0.0.1:8000/v1",
			model: "judge",
			apiKey: () => "k",
			keyName: "K",
			fetch: fakeFetch(() => [
				{ token: "Sure", logprob: Math.log(0.8) },
				{ token: "yes", logprob: Math.log(0.1) },
			]),
		});
		const response = await off.evaluate({ state: "s", questions: { edit: questions.edit } });
		expect(response.answers.edit).toEqual({ type: "boolean", probability: 1 });
		expect(response.warnings).toEqual([
			{ type: "label_mass", questionId: "edit", message: "The labels held 0.10 of the first token" },
		]);

		const none = new LogprobJudgeProvider({
			baseUrl: "http://127.0.0.1:8000/v1",
			model: "judge",
			apiKey: () => "k",
			keyName: "K",
			fetch: fakeFetch(() => [{ token: "<think>", logprob: 0 }]),
		});
		await expect(none.evaluate({ state: "s", questions: { edit: questions.edit } })).rejects.toMatchObject({
			kind: "invalid_response",
			message: 'judge answered "edit" with "<think>", not a label',
		});
	});

	it("needs a key and names the variable it is read from", async () => {
		const provider = new LogprobJudgeProvider({
			baseUrl: "https://api.tokenfactory.nebius.com/v1",
			model: "m",
			apiKey: () => undefined,
			keyName: "NEBIUS_API_KEY",
			fetch: fakeFetch(answersByLabels),
		});
		await expect(provider.evaluate({ state: "s", questions })).rejects.toMatchObject({
			kind: "auth",
			message: "No API key is configured for api.tokenfactory.nebius.com (NEBIUS_API_KEY)",
		});
	});
});

describe("logprob judges in the registry", () => {
	it("builds the built-in Nemotron judge with the Token Factory key", () => {
		expect(BUILT_IN_JUDGES.nemotron).toMatchObject({ type: "logprob", apiKeyEnv: "NEBIUS_API_KEY" });
		const { judge, problems } = buildJudge(parseConfig({ tiers: ["nemotron"] }), { env: { NEBIUS_API_KEY: "k" } });
		expect(problems).toEqual([]);
		expect(judge.id).toBe("api.tokenfactory.nebius.com:nvidia/Nemotron-3_5-Lightning");
	});

	it("reads a logprob judge from mu.json and reports one without an address", () => {
		const config = parseConfig({
			tiers: ["mine", "broken"],
			judges: {
				mine: { type: "logprob", baseUrl: "http://127.0.0.1:8000/v1", model: "mu-judge" },
				broken: { type: "logprob", model: "mu-judge" },
			},
		});
		const { judge, problems } = buildJudge(config, { env: {} });
		expect(judge.id).toBe("127.0.0.1:8000:mu-judge");
		expect(problems).toEqual(['Judge "broken" needs a baseUrl and a model']);
	});
});
