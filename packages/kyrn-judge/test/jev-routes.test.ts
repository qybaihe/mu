import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { isJudgeError, JudgeError } from "../src/errors.ts";
import type { ClassifierCall, ClassifierOutcome } from "../src/providers/classifier.ts";
import { JevRoutes } from "../src/providers/jev-routes.ts";
import { buildJudge, type JudgeHost, type JudgeRefusal } from "../src/registry.ts";
import type { JudgeProvider, Questions } from "../src/types.ts";

const questions = {
	edit: { type: "boolean", instructions: "Does `user_message` ask for a code change?" },
} satisfies Questions;

const TYPESAFE = "https://api.typesafe.ai/v1/systemone";
const OPENROUTER = "https://openrouter.ai/api/v1/systemone";
const GATEWAY = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";

/** What TypeSafe answers with a key of an account it switched off (seen 2026-11-16). */
const DEACTIVATED = {
	status: 403,
	body: {
		detail: {
			error_type: "authentication_error",
			message: "Your organization has been deactivated. Please contact TypeSafe AI",
		},
	},
};
const NO_CARD = { status: 403, body: { error: { message: "AI Gateway requires a valid credit card on file" } } };
const SYSTEM_ONE = { status: 200, body: { answers: { edit: { noul: 0.9 } } } };
const GATEWAY_ANSWER = { status: 200, body: { answers: { edit: { type: "boolean", probability: 0.8 } } } };

type Reply = { status: number; body: unknown } | "down";

/** Jev's services by address, and every request that reached one: where it went and with which key. */
function services(replies: Readonly<Record<string, Reply>>) {
	const requests: { url: string; key: string | null }[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(url), key: new Headers(init?.headers).get("authorization") });
		const reply = replies[String(url)];
		if (!reply || reply === "down") throw new TypeError("fetch failed");
		return new Response(JSON.stringify(reply.body), { status: reply.status });
	}) as typeof fetch;
	return { requests, fetch: fetchImpl, asked: (url: string) => requests.filter((each) => each.url === url).length };
}

/** A mu session's side of the host: the free Jev of the catalog, and what the notices would hear. */
function session(free: "answers" | "ended" = "answers") {
	const heard: { free: string[]; refused: JudgeRefusal[]; freeAsked: number } = {
		free: [],
		refused: [],
		freeAsked: 0,
	};
	const outcome: ClassifierOutcome =
		free === "answers"
			? { answers: { edit: { type: "bool", probability: 0.7 } }, stopReason: "stop" }
			: { answers: {}, stopReason: "error", errorMessage: "OpenCode System One error (402): add credits" };
	const call: ClassifierCall = async () => {
		heard.freeAsked++;
		return outcome;
	};
	const host: Pick<JudgeHost, "classify" | "freeJev" | "refused"> = {
		classify: () => call,
		freeJev: (outcome) => heard.free.push(outcome),
		refused: (refusal) => heard.refused.push(refusal),
	};
	return { host, heard };
}

const jev = parseConfig({ tiers: ["jev"] });

describe("the jev judge when a service turns its key down", () => {
	it("hands the call to Jev's next service, and after two refusals stops asking the first one", async () => {
		const net = services({ [TYPESAFE]: DEACTIVATED, [OPENROUTER]: SYSTEM_ONE });
		const refused: JudgeRefusal[] = [];
		const built = buildJudge(jev, {
			env: { TYPESAFE_API_KEY: "ts-key", MU_JUDGE_OPENROUTER_API_KEY: "or-key" },
			fetch: net.fetch,
			refused: (refusal) => refused.push(refusal),
		});
		// Named by the route the keys point to until a call says otherwise.
		expect(built.judge.id).toBe("typesafe:jev-latest");

		const first = await built.judge.evaluate({ state: "s", questions });
		expect(first.answers.edit).toMatchObject({ probability: 0.9 });
		expect(built.judge.id).toBe("openrouter.ai:~typesafe/jev-latest");
		expect(refused).toEqual([]);

		await built.judge.evaluate({ state: "s", questions });
		expect(refused).toEqual([
			{
				judge: "jev",
				service: "typesafe:jev-latest",
				kind: "auth",
				// TypeSafe says why under `detail.message`: without it this read "TypeSafe responded with HTTP 403".
				message: "Your organization has been deactivated. Please contact TypeSafe AI",
			},
		]);

		for (let call = 0; call < 5; call++) await built.judge.evaluate({ state: "s", questions });
		expect([net.asked(TYPESAFE), net.asked(OPENROUTER)]).toEqual([2, 7]);
		expect(refused).toHaveLength(1);
		// Each key went to its own service and to no other.
		expect(new Set(net.requests.map((each) => `${each.url} ${each.key}`))).toEqual(
			new Set([`${TYPESAFE} Bearer ts-key`, `${OPENROUTER} Bearer or-key`]),
		);
	});

	it("falls back to the free Jev in a mu session, as it does with no key at all", async () => {
		const net = services({ [TYPESAFE]: DEACTIVATED });
		const { host, heard } = session();
		const built = buildJudge(jev, { ...host, env: { TYPESAFE_API_KEY: "ts-key" }, fetch: net.fetch });

		const result = await built.judge.evaluate({ state: "s", questions });
		expect(result.answers.edit).toMatchObject({ probability: 0.7 });
		expect(built.judge.id).toBe("classifier:opencode/jev-1.13-free");
		// The free Jev's notice says where the questions go now.
		expect(heard.free).toEqual(["answered"]);
		// The gateway had no key, so nothing was sent to it: the TypeSafe key least of all.
		expect(net.requests).toEqual([{ url: TYPESAFE, key: "Bearer ts-key" }]);

		await built.judge.evaluate({ state: "s", questions });
		expect(heard.refused.map((refusal) => refusal.service)).toEqual(["typesafe:jev-latest"]);
	});

	it("goes on past a gateway account without a card too, and leaves the free Jev's end to its own notice", async () => {
		const net = services({ [TYPESAFE]: DEACTIVATED, [GATEWAY]: NO_CARD });
		const { host, heard } = session("ended");
		const built = buildJudge(jev, {
			...host,
			env: { TYPESAFE_API_KEY: "ts-key", AI_GATEWAY_API_KEY: "vck" },
			fetch: net.fetch,
		});

		for (let call = 0; call < 4; call++) {
			const error = await built.judge.evaluate({ state: "s", questions }).catch((caught: unknown) => caught);
			// Of everything that refused, the first is the route the user set up: that is what `/status` shows.
			expect(isJudgeError(error) && [error.kind, error.message]).toEqual([
				"auth",
				"Your organization has been deactivated. Please contact TypeSafe AI",
			]);
		}
		expect(heard.refused.map((refusal) => [refusal.service, refusal.kind])).toEqual([
			["typesafe:jev-latest", "auth"],
			["gateway:typesafe-ai/jev", "payment_required"],
		]);
		expect(heard.free).toEqual(["payment_required", "payment_required", "payment_required", "payment_required"]);
		// Two refusals each, then none of the three is asked again: a call costs no round trip any more.
		expect([net.asked(TYPESAFE), net.asked(GATEWAY), heard.freeAsked]).toEqual([2, 2, 2]);
		expect(net.requests.filter((each) => each.url === GATEWAY).every((each) => each.key === "Bearer vck")).toBe(true);
	});

	it("does not move on from a service that is slow or down", async () => {
		const net = services({ [TYPESAFE]: "down", [OPENROUTER]: SYSTEM_ONE });
		const { host, heard } = session();
		const built = buildJudge(jev, {
			...host,
			env: { TYPESAFE_API_KEY: "ts-key", MU_JUDGE_OPENROUTER_API_KEY: "or-key" },
			fetch: net.fetch,
		});
		const error = await built.judge.evaluate({ state: "s", questions }).catch((caught: unknown) => caught);
		expect(isJudgeError(error) && error.kind).toBe("unreachable");
		expect([net.asked(OPENROUTER), heard.freeAsked]).toEqual([0, 0]);
		expect(built.judge.id).toBe("typesafe:jev-latest");
	});
});

describe("the jev judge as the desktop app writes it", () => {
	// Settings → Judges writes the automatic profile with TypeSafe's key variable and an empty address.
	const auto = parseConfig({
		tiers: ["jev"],
		judges: { jev: { type: "jev", model: "jev-latest", baseUrl: "", apiKeyEnv: "TYPESAFE_API_KEY" } },
	});

	it("reaches the gateway with the gateway's own key, which the judge's key variable used to hide", async () => {
		const net = services({ [GATEWAY]: GATEWAY_ANSWER });
		const { host, heard } = session();
		const signedIn = buildJudge(auto, { ...host, env: {}, fetch: net.fetch, gatewayApiKey: () => "stored-vck" });
		const result = await signedIn.judge.evaluate({ state: "s", questions });
		expect(result.answers.edit).toMatchObject({ probability: 0.8 });
		expect(net.requests).toEqual([{ url: GATEWAY, key: "Bearer stored-vck" }]);
		expect(heard.freeAsked).toBe(0);

		const fromEnv = services({ [GATEWAY]: GATEWAY_ANSWER });
		const keyed = buildJudge(auto, { env: { AI_GATEWAY_API_KEY: "env-vck" }, fetch: fromEnv.fetch });
		await keyed.judge.evaluate({ state: "s", questions });
		expect(fromEnv.requests).toEqual([{ url: GATEWAY, key: "Bearer env-vck" }]);
	});

	it("never sends a TypeSafe key that was turned down to the gateway", async () => {
		const net = services({ [TYPESAFE]: DEACTIVATED, [GATEWAY]: GATEWAY_ANSWER });
		const { host } = session();
		const built = buildJudge(auto, {
			...host,
			env: { TYPESAFE_API_KEY: "ts-key" },
			fetch: net.fetch,
			gatewayApiKey: () => "stored-vck",
		});
		await built.judge.evaluate({ state: "s", questions });
		expect(net.requests).toEqual([
			{ url: TYPESAFE, key: "Bearer ts-key" },
			{ url: GATEWAY, key: "Bearer stored-vck" },
		]);
	});
});

describe("JevRoutes", () => {
	const fixed = (id: string, outcome: "answer" | JudgeError): JudgeProvider & { asked: number } => ({
		id,
		asked: 0,
		async evaluate() {
			this.asked++;
			if (outcome !== "answer") throw outcome;
			return { answers: {}, modelId: id };
		},
	});

	it("says what a service answered a key with, when none can answer", async () => {
		const keyless = fixed("gateway:typesafe-ai/jev", new JudgeError("auth", "No AI Gateway API key is configured"));
		const refusing = fixed("typesafe:jev-latest", new JudgeError("auth", "bad key", { status: 401 }));
		const ended = fixed("classifier:opencode/jev-1.13-free", new JudgeError("payment_required", "add credits"));
		// A service that refused a key the user set says more than the services nobody set a key for.
		await expect(
			new JevRoutes([keyless, refusing, ended], refusing).evaluate({ state: "s", questions }),
		).rejects.toThrow("bad key");
		// With no key anywhere, the last service's reason stands: the free Jev's.
		await expect(new JevRoutes([keyless, ended], ended).evaluate({ state: "s", questions })).rejects.toThrow(
			"add credits",
		);
		expect([keyless.asked, refusing.asked, ended.asked]).toEqual([2, 1, 2]);
	});
});
