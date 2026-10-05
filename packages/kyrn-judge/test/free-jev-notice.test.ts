import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerFreeJevNotice } from "../src/extension/features/free-jev.ts";
import type { KyrnRuntime } from "../src/extension/runtime.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The parts of the runtime the notice uses: the session's UI and the presentation stream. */
function fakeRuntime() {
	const notified: { message: string; type?: string }[] = [];
	const presented: { kind: string; payload: unknown }[] = [];
	const runtime = {
		ctx: { hasUI: true, ui: { notify: (message: string, type?: string) => notified.push({ message, type }) } },
		present: (kind: string, payload: unknown) => presented.push({ kind, payload }),
		onFreeJev: undefined as ((outcome: string) => void) | undefined,
	};
	return { runtime, notified, presented };
}

function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mu-free-jev-"));
	dirs.push(dir);
	return dir;
}

describe("the free Jev notice", () => {
	it("says once a day that the free Jev answers, where its questions go and how to use a key", () => {
		const dir = agentDir();
		const first = fakeRuntime();
		registerFreeJevNotice(first.runtime as unknown as KyrnRuntime, { home: dir, agentDir: dir });
		first.runtime.onFreeJev?.("answered");
		first.runtime.onFreeJev?.("answered");
		expect(first.notified).toHaveLength(1);
		expect(first.notified[0]).toMatchObject({ type: "info" });
		expect(first.notified[0].message).toContain("OpenCode Zen");
		expect(first.notified[0].message).toContain("mu setup");
		expect(first.presented).toEqual([
			{ kind: "judge.notice", payload: { code: "free_jev", message: first.notified[0].message } },
		]);
		expect(JSON.parse(readFileSync(join(dir, "mu", "notices.json"), "utf8")).freeJev).toMatch(/^\d{4}-\d\d-\d\d$/);

		// The next session the same day says nothing.
		const second = fakeRuntime();
		registerFreeJevNotice(second.runtime as unknown as KyrnRuntime, { home: dir, agentDir: dir });
		second.runtime.onFreeJev?.("answered");
		expect(second.notified).toEqual([]);
	});

	it("says once when the free Jev asks for a key or is gone, and nothing for a passing failure", () => {
		const { runtime, notified, presented } = fakeRuntime();
		registerFreeJevNotice(runtime as unknown as KyrnRuntime, undefined);
		runtime.onFreeJev?.("rate_limited");
		runtime.onFreeJev?.("timeout");
		expect(notified).toEqual([]);
		runtime.onFreeJev?.("payment_required");
		runtime.onFreeJev?.("bad_request");
		expect(notified).toHaveLength(1);
		expect(notified[0].type).toBe("warning");
		expect(presented[0]).toMatchObject({
			kind: "judge.notice",
			payload: { code: "free_jev_unavailable", reason: "paid" },
		});
	});
});
