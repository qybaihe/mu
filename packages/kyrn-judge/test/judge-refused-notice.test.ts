import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { registerJudgeRefusedNotice } from "../src/extension/features/judge-refused.ts";
import type { KyrnRuntime } from "../src/extension/runtime.ts";
import type { JudgeRefusal } from "../src/registry.ts";

/** The parts of the runtime the notice uses: the configuration, the session's UI and the presentation stream. */
function fakeRuntime(config: Record<string, unknown> = {}) {
	const notified: { message: string; type?: string }[] = [];
	const presented: { kind: string; payload: unknown }[] = [];
	const runtime = {
		config: parseConfig(config),
		ctx: { hasUI: true, ui: { notify: (message: string, type?: string) => notified.push({ message, type }) } },
		present: (kind: string, payload: unknown) => presented.push({ kind, payload }),
		onJudgeRefused: undefined as ((refusal: JudgeRefusal, tiers: readonly string[]) => void) | undefined,
	};
	registerJudgeRefusedNotice(runtime as unknown as KyrnRuntime);
	return { runtime, notified, presented };
}

const deactivated: JudgeRefusal = {
	judge: "jev",
	service: "typesafe:jev-latest",
	kind: "auth",
	message: "Your organization has been deactivated. Please contact TypeSafe AI",
};

describe("the notice of a judge whose key was turned down", () => {
	it("says once per session which service refused, in its words, that Jev's next service answers and how to fix it", () => {
		const { runtime, notified, presented } = fakeRuntime();
		runtime.onJudgeRefused?.(deactivated, ["jev"]);
		// The same service again, from the judge of another route: said once.
		runtime.onJudgeRefused?.(deactivated, ["jev"]);
		expect(notified).toHaveLength(1);
		expect(notified[0].type).toBe("warning");
		expect(notified[0].message).toBe(
			'mu: typesafe:jev-latest turned down the key of the jev judge ("Your organization has been deactivated. Please contact TypeSafe AI"), so mu is asking Jev through its next service. To bring it back, set a working key with mu setup or in the desktop app under Settings → Judges, or pick another judge with /mu judge.',
		);
		expect(presented).toEqual([
			{
				kind: "judge.notice",
				payload: {
					code: "judge_refused",
					reason: "auth",
					judge: "jev",
					service: "typesafe:jev-latest",
					said: "Your organization has been deactivated. Please contact TypeSafe AI",
					message: notified[0].message,
				},
			},
		]);

		// Another of Jev's services is another notice.
		runtime.onJudgeRefused?.(
			{ judge: "jev", service: "gateway:typesafe-ai/jev", kind: "payment_required", message: "needs a card" },
			["jev"],
		);
		expect(notified).toHaveLength(2);
		expect(notified[1].message).toContain("can't charge the account behind the jev judge");
		expect(notified[1].message).toContain("add a payment method or credit there");
		expect(presented[1]).toMatchObject({ payload: { code: "judge_refused", reason: "payment_required" } });
	});

	it("says who decides meanwhile by what comes after the judge in its own order", () => {
		const relay = { judge: "relay", service: "10.0.0.5:8000:jev-latest", kind: "auth", message: "bad key" } as const;
		const config = { judges: { relay: { type: "typesafe", baseUrl: "http://10.0.0.5:8000/v1/systemone" } } };

		const first = fakeRuntime(config);
		first.runtime.onJudgeRefused?.(relay, ["relay", "mude"]);
		expect(first.notified[0].message).toContain("so the next judge is answering for it");

		// The last judge of its order, as the only judge of a route is: nothing answers in its place.
		const last = fakeRuntime(config);
		last.runtime.onJudgeRefused?.(relay, ["mude", "relay"]);
		expect(last.notified[0].message).toContain("so mu is using its fallbacks");
		const routed = fakeRuntime({ ...config, tiers: ["mude"] });
		routed.runtime.onJudgeRefused?.(relay, ["relay"]);
		expect(routed.notified[0].message).toContain("so mu is using its fallbacks");
	});

	it("quotes a short, flat piece of what the service said, without control characters", () => {
		const { runtime, notified, presented } = fakeRuntime();
		const message = `denied\u001b[2J\u0007\nfor this key ${"x".repeat(400)}`;
		runtime.onJudgeRefused?.({ judge: "jev-direct", service: "typesafe:jev-latest", kind: "auth", message }, [
			"jev-direct",
		]);
		const said = (presented[0].payload as { said: string }).said;
		expect(said.startsWith("denied [2J for this key xxx")).toBe(true);
		expect(said.length).toBeLessThanOrEqual(160);
		expect(notified[0].message).not.toMatch(/[\u0000-\u001f]/);
	});
});
