import { describe, expect, it } from "vitest";
import { BUILT_IN_JUDGES, parseConfig } from "../src/config.ts";
import { isJudgeError } from "../src/errors.ts";
import {
	type ClassifierCall,
	ClassifierJudgeProvider,
	type ClassifierOutcome,
	type ClassifierWireQuestion,
} from "../src/providers/classifier.ts";
import { buildJudge, type JudgeHost } from "../src/registry.ts";
import type { Questions } from "../src/types.ts";

const questions = {
	edit: { type: "boolean", instructions: "Does `user_message` ask for a code change?" },
	risky: {
		type: "boolean",
		instructions: { rule: "Is the command risky?" },
		criteria: { true: "It deletes or overwrites", false: null },
	},
	kind: { type: "choice", instructions: "What is it?", criteria: { chat: "Small talk", other: null } },
	size: { type: "score", instructions: "How big?", criteria: ["small", "medium", "large"] },
} satisfies Questions;

const answered: ClassifierOutcome = {
	answers: {
		edit: { type: "bool", probability: 0.91 },
		risky: { type: "bool", probability: 0.08 },
		kind: { type: "choice", choice: "chat", probabilities: { chat: 0.8, other: 0.2 }, confidence: 0.6 },
		size: { type: "score", score: 1.4, confidence: 0.7 },
	},
	usage: { input: 120, output: 4 },
	stopReason: "stop",
};

function recording(outcome: ClassifierOutcome) {
	const seen: { questions?: Readonly<Record<string, ClassifierWireQuestion>>; state?: unknown } = {};
	const call: ClassifierCall = async (request) => {
		seen.questions = request.questions;
		seen.state = request.state;
		return outcome;
	};
	return { call, seen };
}

async function failure(provider: ClassifierJudgeProvider) {
	try {
		await provider.evaluate({ state: "s", questions });
	} catch (error) {
		return error;
	}
	throw new Error("expected a failure");
}

describe("ClassifierJudgeProvider", () => {
	it("asks a catalog classifier the kernel's questions and reads its answers back", async () => {
		const { call, seen } = recording(answered);
		const provider = new ClassifierJudgeProvider({ model: "opencode/jev-1.13", call });
		const response = await provider.evaluate({ state: { user_message: "fix it" }, questions });

		expect(provider.id).toBe("classifier:opencode/jev-1.13");
		expect(seen.state).toEqual({ user_message: "fix it" });
		expect(seen.questions).toEqual({
			// No criteria stay no criteria: Jev answers a bare yes/no question differently from one with empty labels.
			edit: { type: "bool", instructions: "Does `user_message` ask for a code change?" },
			risky: {
				type: "bool",
				instructions: '{"rule":"Is the command risky?"}',
				criteria: { true: "It deletes or overwrites", false: "" },
			},
			kind: { type: "choice", instructions: "What is it?", criteria: { chat: "Small talk", other: "" } },
			size: { type: "score", instructions: "How big?", criteria: ["small", "medium", "large"] },
		});
		expect(response.answers).toEqual({
			edit: { type: "boolean", probability: 0.91 },
			risky: { type: "boolean", probability: 0.08 },
			kind: { type: "choice", choice: "chat", probabilities: { chat: 0.8, other: 0.2 }, confidence: 0.6 },
			size: { type: "score", score: 1.4, confidence: 0.7 },
		});
		expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 4 });
		expect(response.modelId).toBe("opencode/jev-1.13");
	});

	it("names what went wrong by kind, and leaves an abort to the kernel", async () => {
		const failing = (errorMessage: string) =>
			new ClassifierJudgeProvider({
				model: "opencode/jev-1.13",
				call: recording({ answers: {}, stopReason: "error", errorMessage }).call,
			});
		const kinds = await Promise.all(
			[
				"No API key for provider: opencode",
				"System One API returned 401: invalid key",
				"System One API returned 402: add credits",
				"System One API returned 429: slow down",
				"System One API returned 503",
				"System One API returned 400: bad question",
				"fetch failed",
				"System One API did not return an answer for edit",
			].map(async (message) => {
				const error = await failure(failing(message));
				return isJudgeError(error) ? error.kind : String(error);
			}),
		);
		expect(kinds).toEqual([
			"auth",
			"auth",
			"payment_required",
			"rate_limited",
			"server",
			"bad_request",
			"unreachable",
			"invalid_response",
		]);

		const aborted = await failure(
			new ClassifierJudgeProvider({ model: "x/y", call: recording({ answers: {}, stopReason: "aborted" }).call }),
		);
		expect((aborted as Error).name).toBe("AbortError");
	});

	it("refuses an answer of the wrong kind or an option that was not offered", async () => {
		const wrong = new ClassifierJudgeProvider({
			model: "x/y",
			call: recording({
				...answered,
				answers: {
					...answered.answers,
					kind: { type: "choice", choice: "poem", probabilities: {}, confidence: 1 },
				},
			}).call,
		});
		const error = await failure(wrong);
		expect(isJudgeError(error) && error.kind).toBe("invalid_response");
	});
});

describe("classifier judges in the registry", () => {
	const host = (env: Record<string, string> = {}): JudgeHost & { asked: string[] } => {
		const asked: string[] = [];
		return {
			env,
			asked,
			classify: (model) => {
				asked.push(model);
				return recording(answered).call;
			},
		};
	};

	it("knows Jev on OpenCode Zen and Cloudflare, and Cloudflare's Clef, by name", () => {
		for (const [name, model] of [
			["jev-opencode", "opencode/jev-1.13"],
			["jev-opencode-free", "opencode/jev-1.13-free"],
			["jev-cloudflare", "cloudflare-workers-ai/typesafe/jev"],
			["clef", "cloudflare-workers-ai/@cf/cloudflare/clef"],
			["clef-flash", "cloudflare-workers-ai/@cf/cloudflare/clef-flash"],
		] as const) {
			expect(BUILT_IN_JUDGES[name]).toEqual({ type: "classifier", model });
			expect(buildJudge(parseConfig({ tiers: [name] }), host()).judge.id).toBe(`classifier:${model}`);
		}
	});

	it("takes any classifier of the catalog inline or by a profile of its own", () => {
		const inline = buildJudge(parseConfig({ tiers: ["classifier:openrouter/liquid/d1"] }), host());
		expect(inline.judge.id).toBe("classifier:openrouter/liquid/d1");
		const named = parseConfig({
			tiers: ["decider"],
			judges: { decider: { type: "classifier", model: "openrouter/perplexity/pplx-decider-v1-27b" } },
		});
		expect(buildJudge(named, host()).judge.id).toBe("classifier:openrouter/perplexity/pplx-decider-v1-27b");
	});

	it("reports a classifier judge without a model, or without a session to reach it", () => {
		const noModel = parseConfig({ tiers: ["c"], judges: { c: { type: "classifier" } } });
		expect(buildJudge(noModel, host()).problems[0]).toBe('Judge "c" needs a model ("provider/model-id")');
		expect(buildJudge(parseConfig({ tiers: ["jev-opencode"] }), { env: {} }).problems[0]).toBe(
			'Judge "jev-opencode": classifier models need a mu session',
		);
	});

	it("lets the jev tier reach Jev on OpenCode or Cloudflare when that is the only key there is", () => {
		const jev = parseConfig({ tiers: ["jev"] });
		expect(buildJudge(jev, host({ OPENCODE_API_KEY: "o" })).judge.id).toBe("classifier:opencode/jev-1.13");
		expect(buildJudge(jev, host({ CLOUDFLARE_API_KEY: "c", CLOUDFLARE_ACCOUNT_ID: "a" })).judge.id).toBe(
			"classifier:cloudflare-workers-ai/typesafe/jev",
		);
		// Cloudflare needs its account as well; without it, as without any key, the gateway is asked.
		expect(buildJudge(jev, host({ CLOUDFLARE_API_KEY: "c" })).judge.id).toBe("gateway:typesafe-ai/jev");
		// A key that reaches Jev already keeps doing so.
		expect(buildJudge(jev, host({ TYPESAFE_API_KEY: "t", OPENCODE_API_KEY: "o" })).judge.id).toBe(
			"typesafe:jev-latest",
		);
		expect(buildJudge(jev, host({ AI_GATEWAY_API_KEY: "g", OPENCODE_API_KEY: "o" })).judge.id).toBe(
			"gateway:typesafe-ai/jev",
		);
	});
});
