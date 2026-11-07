import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/openai-completions.ts";
import type { Model, OpenAICompletionsCompat } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Drives the real OpenAI SDK through a fake fetch, so the SDK's own error objects reach the
// fallback. No network, no keys.

type RequestBody = {
	messages: Array<{ role: string; content: unknown }>;
	max_tokens?: number;
	max_completion_tokens?: number;
	reasoning_effort?: string;
	store?: boolean;
	stream_options?: unknown;
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
};

type FakeResponse = { status: number; body: unknown };

function sseResponse(): Response {
	const chunks = [
		{
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 0,
			model: "m",
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
		},
		{
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 0,
			model: "m",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
	];
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A fetch that answers with `responses` in order, then with a stream, and records each request body. */
function fakeFetch(responses: FakeResponse[] = []) {
	const bodies: RequestBody[] = [];
	const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		bodies.push(JSON.parse(String(init?.body)) as RequestBody);
		const next = responses.shift();
		if (!next) return sseResponse();
		return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
			status: next.status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch: fetch as typeof globalThis.fetch, bodies };
}

let modelCount = 0;

/** A reasoning model on a third-party endpoint. Each gets its own id: what an endpoint teaches is kept per model. */
function relayModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	modelCount++;
	return {
		id: `relay-model-${modelCount}`,
		name: "Relay model",
		api: "openai-completions",
		provider: "relay",
		baseUrl: "https://relay.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	};
}

async function send(
	model: Model<"openai-completions">,
	fetch: typeof globalThis.fetch,
	options: { cacheRetention?: "short" | "long"; sessionId?: string } = {},
) {
	return streamSimple(
		model,
		normalizeContext({
			systemPrompt: "Follow instructions.",
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		}),
		{ apiKey: "test", fetch, reasoning: "high", ...options },
	).result();
}

// The error the owner saw: a gateway wrapping its upstream's 400 in a 502.
const wrappedUnknownDeveloperRole: FakeResponse = {
	status: 502,
	body: {
		error: {
			message:
				'upstream 400: {"error":{"code":"invalid_request","message":"unknown role developer. invalid messages. bad request","type":"invalid_request_error"},"gd_id":"gd-6i97p8ov1b"}',
			type: "invalid_request_error",
			code: "invalid_request",
		},
	},
};

const developerCompat: OpenAICompletionsCompat = { supportsDeveloperRole: true };

describe("openai-completions defaults for third-party endpoints", () => {
	it("sends system messages, max_tokens, and no store to a custom base URL", async () => {
		const { fetch, bodies } = fakeFetch();
		const result = await send(relayModel(), fetch);

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(1);
		expect(bodies[0].messages[0].role).toBe("system");
		expect(bodies[0].max_tokens).toBe(8192);
		expect(bodies[0].max_completion_tokens).toBeUndefined();
		expect(bodies[0].store).toBeUndefined();
		expect(bodies[0].reasoning_effort).toBe("high");
		expect(bodies[0].stream_options).toEqual({ include_usage: true });
	});

	it("keeps developer messages, max_completion_tokens, and store on api.openai.com", async () => {
		const { fetch, bodies } = fakeFetch();
		await send(relayModel({ provider: "openai", baseUrl: "https://api.openai.com/v1" }), fetch);

		expect(bodies[0].messages[0].role).toBe("developer");
		expect(bodies[0].max_completion_tokens).toBe(8192);
		expect(bodies[0].max_tokens).toBeUndefined();
		expect(bodies[0].store).toBe(false);
	});

	it("keeps the OpenAI request shape on Azure OpenAI hosts", async () => {
		const { fetch, bodies } = fakeFetch();
		await send(relayModel({ provider: "azure", baseUrl: "https://my-resource.openai.azure.com/openai/v1" }), fetch);

		expect(bodies[0].messages[0].role).toBe("developer");
		expect(bodies[0].max_completion_tokens).toBe(8192);
		expect(bodies[0].store).toBe(false);
	});

	it("keeps developer messages and max_completion_tokens on Xiaomi MiMo, as its docs describe", async () => {
		const { fetch, bodies } = fakeFetch();
		await send(relayModel({ provider: "xiaomi", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" }), fetch);

		expect(bodies[0].messages[0].role).toBe("developer");
		expect(bodies[0].max_completion_tokens).toBe(8192);
		expect(bodies[0].store).toBeUndefined();
	});

	it("lets explicit compat override the detected defaults", async () => {
		const custom = fakeFetch();
		await send(
			relayModel({
				compat: { supportsDeveloperRole: true, maxTokensField: "max_completion_tokens", supportsStore: true },
			}),
			custom.fetch,
		);
		expect(custom.bodies[0].messages[0].role).toBe("developer");
		expect(custom.bodies[0].max_completion_tokens).toBe(8192);
		expect(custom.bodies[0].store).toBe(false);

		const openai = fakeFetch();
		await send(
			relayModel({
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens", supportsStore: false },
			}),
			openai.fetch,
		);
		expect(openai.bodies[0].messages[0].role).toBe("system");
		expect(openai.bodies[0].max_tokens).toBe(8192);
		expect(openai.bodies[0].store).toBeUndefined();
	});
});

describe("openai-completions compat fallback", () => {
	it("retries once with system messages when a wrapped 400 rejects the developer role, and remembers it", async () => {
		const model = relayModel({ compat: developerCompat });
		const first = fakeFetch([wrappedUnknownDeveloperRole]);
		const result = await send(model, first.fetch);

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(first.bodies.map((body) => body.messages[0].role)).toEqual(["developer", "system"]);
		// Only the role changed.
		expect({ ...first.bodies[1], messages: undefined }).toEqual({ ...first.bodies[0], messages: undefined });

		const later = fakeFetch();
		await send(model, later.fetch);
		expect(later.bodies.map((body) => body.messages[0].role)).toEqual(["system"]);
	});

	it("recognizes other wordings of a developer role rejection", async () => {
		const rejections: FakeResponse[] = [
			{
				status: 400,
				body: {
					error: {
						message:
							"Invalid value: 'developer'. Supported values are: 'system', 'assistant', 'user', 'function', and 'tool'.",
						type: "invalid_request_error",
						param: "messages[0].role",
						code: "invalid_value",
					},
				},
			},
			{
				status: 400,
				body: {
					error: {
						message: JSON.stringify({
							detail: [
								{
									type: "union_tag_invalid",
									loc: ["body", "messages", 0],
									msg: "Input tag 'developer' found using 'role' does not match any of the expected tags: 'system', 'user', 'assistant', 'tool'",
									input: { role: "developer", content: "Follow instructions." },
								},
							],
						}),
					},
				},
			},
			{
				status: 422,
				body: {
					error: "Failed to deserialize the JSON body: messages[0]: unknown variant `developer`, expected one of `system`, `user`, `assistant`, `tool`",
				},
			},
		];
		for (const rejection of rejections) {
			const { fetch, bodies } = fakeFetch([rejection]);
			const result = await send(relayModel({ compat: developerCompat }), fetch);
			expect(result.stopReason).toBe("stop");
			expect(bodies.map((body) => body.messages[0].role)).toEqual(["developer", "system"]);
		}
	});

	it("does not retry a 400 that is about something else", async () => {
		const model = relayModel({ compat: developerCompat });
		const { fetch, bodies } = fakeFetch([
			{
				status: 400,
				body: {
					error: { message: "This model's maximum context length is 8192 tokens.", type: "invalid_request_error" },
				},
			},
		]);
		const result = await send(model, fetch);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("maximum context length");
		expect(bodies).toHaveLength(1);

		const later = fakeFetch();
		await send(model, later.fetch);
		expect(later.bodies[0].messages[0].role).toBe("developer");
	});

	it("does not retry an authentication error that mentions the developer role", async () => {
		const { fetch, bodies } = fakeFetch([
			{ status: 401, body: { error: { message: "Invalid API key for the developer role", type: "auth_error" } } },
		]);
		const result = await send(relayModel({ compat: developerCompat }), fetch);

		expect(result.stopReason).toBe("error");
		expect(bodies).toHaveLength(1);
	});

	it("stops after one retry when the system role is rejected too", async () => {
		const { fetch, bodies } = fakeFetch([wrappedUnknownDeveloperRole, wrappedUnknownDeveloperRole]);
		const result = await send(relayModel({ compat: developerCompat }), fetch);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("unknown role developer");
		expect(bodies).toHaveLength(2);
	});

	it("never second-guesses api.openai.com", async () => {
		const { fetch, bodies } = fakeFetch([wrappedUnknownDeveloperRole]);
		const result = await send(relayModel({ provider: "openai", baseUrl: "https://api.openai.com/v1" }), fetch);

		expect(result.stopReason).toBe("error");
		expect(bodies).toHaveLength(1);
	});

	it("switches max_completion_tokens to max_tokens when it is rejected, and remembers it", async () => {
		const model = relayModel({ compat: { maxTokensField: "max_completion_tokens" } });
		const { fetch, bodies } = fakeFetch([
			{
				status: 400,
				body: {
					error: {
						message: "Unrecognized request argument supplied: max_completion_tokens",
						type: "invalid_request_error",
					},
				},
			},
		]);
		const result = await send(model, fetch);

		expect(result.stopReason).toBe("stop");
		expect(bodies[0].max_completion_tokens).toBe(8192);
		expect(bodies[1].max_completion_tokens).toBeUndefined();
		expect(bodies[1].max_tokens).toBe(8192);

		const later = fakeFetch();
		await send(model, later.fetch);
		expect(later.bodies[0].max_tokens).toBe(8192);
		expect(later.bodies[0].max_completion_tokens).toBeUndefined();
	});

	it("switches max_tokens to max_completion_tokens for a relay to OpenAI's reasoning models", async () => {
		const { fetch, bodies } = fakeFetch([
			{
				status: 400,
				body: {
					error: {
						message:
							"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
						type: "invalid_request_error",
						param: "max_tokens",
						code: "unsupported_parameter",
					},
				},
			},
		]);
		const result = await send(relayModel(), fetch);

		expect(result.stopReason).toBe("stop");
		expect(bodies[0].max_tokens).toBe(8192);
		expect(bodies[1].max_tokens).toBeUndefined();
		expect(bodies[1].max_completion_tokens).toBe(8192);
	});

	it("does not switch the max tokens field when only its value is rejected", async () => {
		const { fetch, bodies } = fakeFetch([
			{
				status: 400,
				body: {
					error: {
						message: "max_tokens is too large: 8192. This model supports at most 4096 completion tokens.",
						type: "invalid_request_error",
						param: "max_tokens",
						code: "invalid_value",
					},
				},
			},
		]);
		const result = await send(relayModel(), fetch);

		expect(result.stopReason).toBe("error");
		expect(bodies).toHaveLength(1);
	});

	it("drops reasoning_effort when it is rejected, and remembers it", async () => {
		const model = relayModel();
		const { fetch, bodies } = fakeFetch([
			{
				status: 400,
				body: { error: { message: "Unknown parameter: 'reasoning_effort'.", type: "invalid_request_error" } },
			},
		]);
		const result = await send(model, fetch);

		expect(result.stopReason).toBe("stop");
		expect(bodies[0].reasoning_effort).toBe("high");
		expect(bodies[1]).not.toHaveProperty("reasoning_effort");

		const later = fakeFetch();
		await send(model, later.fetch);
		expect(later.bodies[0]).not.toHaveProperty("reasoning_effort");
	});

	it("keeps reasoning_effort when only its value is rejected", async () => {
		const { fetch, bodies } = fakeFetch([
			{
				status: 400,
				body: {
					error: {
						message: "Unsupported value: 'reasoning_effort' does not support 'high' with this model.",
						type: "invalid_request_error",
						param: "reasoning_effort",
						code: "unsupported_value",
					},
				},
			},
		]);
		const result = await send(relayModel(), fetch);

		expect(result.stopReason).toBe("error");
		expect(bodies).toHaveLength(1);
	});

	it("drops stream_options when a strict server forbids it, and remembers it", async () => {
		const model = relayModel();
		const { fetch, bodies } = fakeFetch([
			{
				status: 422,
				body: {
					error: {
						message: JSON.stringify({
							detail: [
								{
									type: "extra_forbidden",
									loc: ["body", "stream_options"],
									msg: "Extra inputs are not permitted",
									input: { include_usage: true },
								},
							],
						}),
					},
				},
			},
		]);
		const result = await send(model, fetch);

		expect(result.stopReason).toBe("stop");
		expect(bodies[0].stream_options).toEqual({ include_usage: true });
		expect(bodies[1]).not.toHaveProperty("stream_options");

		const later = fakeFetch();
		await send(model, later.fetch);
		expect(later.bodies[0]).not.toHaveProperty("stream_options");
	});

	it("drops store when it is rejected", async () => {
		const { fetch, bodies } = fakeFetch([
			{ status: 400, body: { error: { message: 'json: unknown field "store"', type: "invalid_request_error" } } },
		]);
		const result = await send(relayModel({ compat: { supportsStore: true } }), fetch);

		expect(result.stopReason).toBe("stop");
		expect(bodies[0].store).toBe(false);
		expect(bodies[1]).not.toHaveProperty("store");
	});

	it("drops the prompt cache fields when they are rejected", async () => {
		const { fetch, bodies } = fakeFetch([
			{
				status: 400,
				body: { error: { message: "prompt_cache_retention is not supported", type: "invalid_request_error" } },
			},
		]);
		const result = await send(relayModel(), fetch, { cacheRetention: "long", sessionId: "session-1" });

		expect(result.stopReason).toBe("stop");
		expect(bodies[0].prompt_cache_key).toBe("session-1");
		expect(bodies[0].prompt_cache_retention).toBe("24h");
		expect(bodies[1]).not.toHaveProperty("prompt_cache_key");
		expect(bodies[1]).not.toHaveProperty("prompt_cache_retention");
	});

	it("fixes several rejected fields in turn, each once", async () => {
		const { fetch, bodies } = fakeFetch([
			wrappedUnknownDeveloperRole,
			{
				status: 400,
				body: { error: { message: "Unknown parameter: 'reasoning_effort'.", type: "invalid_request_error" } },
			},
		]);
		const result = await send(relayModel({ compat: developerCompat }), fetch);

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(3);
		expect(bodies[2].messages[0].role).toBe("system");
		expect(bodies[2]).not.toHaveProperty("reasoning_effort");
	});

	it("does not take a field named in an echo of the request for the one refused", async () => {
		const { fetch, bodies } = fakeFetch([
			{
				status: 400,
				body: {
					error: {
						message:
							"unknown field `tool_stream`, expected one of `model`, `messages`, `max_tokens`, `stream_options`, `reasoning_effort`",
						type: "invalid_request_error",
					},
				},
			},
		]);
		const result = await send(relayModel(), fetch);

		expect(result.stopReason).toBe("error");
		expect(bodies).toHaveLength(1);
	});
});
