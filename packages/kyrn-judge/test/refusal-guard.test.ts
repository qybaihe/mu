import { afterEach, describe, expect, it, vi } from "vitest";
import { JudgeError } from "../src/errors.ts";
import { REFUSED_RETRY_MS, RefusalGuard } from "../src/providers/refusal-guard.ts";
import type { JudgeProvider, JudgeRequest } from "../src/types.ts";

const request: JudgeRequest = { state: "s", questions: { q: { type: "boolean", instructions: "Is it?" } } };

/** A service that answers each call with the next of `outcomes`, the last one from then on. */
function service(outcomes: readonly ("answer" | JudgeError)[]): JudgeProvider & { asked: number } {
	return {
		id: "typesafe:jev-latest",
		asked: 0,
		async evaluate() {
			const outcome = outcomes[Math.min(this.asked, outcomes.length - 1)];
			this.asked++;
			if (outcome !== "answer") throw outcome;
			return { answers: { q: { type: "boolean", probability: 0.9 } } };
		},
	};
}

/** What TypeSafe answers for an account it switched off, and the gateway for an account without a card. */
const deactivated = new JudgeError("auth", "Your organization has been deactivated.", { status: 403 });
const noCard = new JudgeError("payment_required", "AI Gateway requires a valid credit card on file", { status: 403 });

describe("RefusalGuard", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("leaves a service alone after it turned the key down twice, and fails the calls that follow at once", async () => {
		const typesafe = service([deactivated]);
		const heard: JudgeError[] = [];
		const guard = new RefusalGuard(typesafe, (refusal) => heard.push(refusal));
		expect(guard.id).toBe("typesafe:jev-latest");

		await expect(guard.evaluate(request)).rejects.toBe(deactivated);
		// One refusal may be a passing mistake of the service's: nothing is said yet, and it is asked again.
		expect(heard).toEqual([]);
		await expect(guard.evaluate(request)).rejects.toBe(deactivated);
		expect(heard).toEqual([deactivated]);
		expect(typesafe.asked).toBe(2);

		for (let call = 0; call < 20; call++) await expect(guard.evaluate(request)).rejects.toBe(deactivated);
		expect(typesafe.asked).toBe(2);
		expect(heard).toHaveLength(1);
	});

	it("asks again once a minute, with one call, and says nothing more while the refusal stands", async () => {
		vi.useFakeTimers();
		const gateway = service([noCard]);
		const heard: JudgeError[] = [];
		const guard = new RefusalGuard(gateway, (refusal) => heard.push(refusal));
		await expect(guard.evaluate(request)).rejects.toBe(noCard);
		await expect(guard.evaluate(request)).rejects.toBe(noCard);

		vi.advanceTimersByTime(REFUSED_RETRY_MS - 1);
		await expect(guard.evaluate(request)).rejects.toBe(noCard);
		expect(gateway.asked).toBe(2);

		vi.advanceTimersByTime(1);
		// Four questions at the start of a turn: one of them asks the service, the rest get the refusal as before.
		const turn = await Promise.allSettled([1, 2, 3, 4].map(() => guard.evaluate(request)));
		expect(turn.map((call) => call.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
		expect(gateway.asked).toBe(3);
		expect(heard).toHaveLength(1);
	});

	it("goes back to asking every call once the service answers", async () => {
		vi.useFakeTimers();
		const typesafe = service([deactivated, deactivated, "answer", "answer", deactivated]);
		const heard: JudgeError[] = [];
		const guard = new RefusalGuard(typesafe, (refusal) => heard.push(refusal));
		await expect(guard.evaluate(request)).rejects.toBe(deactivated);
		await expect(guard.evaluate(request)).rejects.toBe(deactivated);

		// The account was switched back on: the call that asks again gets an answer, and so does the next one.
		vi.advanceTimersByTime(REFUSED_RETRY_MS);
		expect((await guard.evaluate(request)).answers.q).toMatchObject({ probability: 0.9 });
		expect((await guard.evaluate(request)).answers.q).toMatchObject({ probability: 0.9 });
		expect(typesafe.asked).toBe(4);

		// A refusal after an answer counts from one again.
		await expect(guard.evaluate(request)).rejects.toBe(deactivated);
		expect(typesafe.asked).toBe(5);
		await expect(guard.evaluate(request)).rejects.toBe(deactivated);
		expect(typesafe.asked).toBe(6);
		expect(heard).toHaveLength(2);
	});

	it("keeps asking a service that is slow, down or has no key on this machine", async () => {
		// No status: the key is missing here, and one stored during the session has to be used from the next call on.
		const keyless = new JudgeError("auth", "No AI Gateway API key is configured");
		for (const failure of [
			keyless,
			new JudgeError("timeout", "Judge call exceeded 4000 ms"),
			new JudgeError("unreachable", "Could not reach TypeSafe"),
			new JudgeError("rate_limited", "slow down", { status: 429 }),
			new JudgeError("server", "bad gateway", { status: 502 }),
		]) {
			const failing = service([failure]);
			const heard: JudgeError[] = [];
			const guard = new RefusalGuard(failing, (refusal) => heard.push(refusal));
			for (let call = 0; call < 5; call++) await expect(guard.evaluate(request)).rejects.toBe(failure);
			expect([failure.kind, failing.asked, heard.length]).toEqual([failure.kind, 5, 0]);
		}
	});
});
