import { describe, expect, it } from "vitest";
import { registerOpenAIKeyNotice } from "../src/extension/features/openai-key.ts";
import type { KyrnRuntime } from "../src/extension/runtime.ts";

/** The parts of the runtime the notice uses: the judges in order, the session's UI and the presentation stream. */
function fakeRuntime(tiers: string[]) {
	const notified: { message: string; type?: string }[] = [];
	const presented: { kind: string; payload: unknown }[] = [];
	const runtime = {
		config: { tiers },
		ctx: { hasUI: true, ui: { notify: (message: string, type?: string) => notified.push({ message, type }) } },
		present: (kind: string, payload: unknown) => presented.push({ kind, payload }),
		onOpenAIKey: undefined as ((problem: "missing" | "rejected") => void) | undefined,
	};
	registerOpenAIKeyNotice(runtime as unknown as KyrnRuntime);
	return { runtime, notified, presented };
}

describe("the OpenAI key notice", () => {
	it("says once per session that the key is gone, how to bring it back, and that mu's fallbacks decide meanwhile", () => {
		const { runtime, notified, presented } = fakeRuntime(["openai"]);
		runtime.onOpenAIKey?.("missing");
		runtime.onOpenAIKey?.("missing");
		runtime.onOpenAIKey?.("rejected");
		expect(notified).toHaveLength(1);
		expect(notified[0].type).toBe("warning");
		expect(notified[0].message).toContain("no API key now");
		expect(notified[0].message).toContain("fallbacks");
		expect(notified[0].message).toContain("Settings → Judges");
		expect(notified[0].message).toContain("/mu judge");
		expect(presented).toEqual([
			{ kind: "judge.notice", payload: { code: "openai_key", reason: "missing", message: notified[0].message } },
		]);
	});

	it("says the next judge answers when OpenAI is not the last one, and words a key OpenAI turned down", () => {
		const { runtime, notified, presented } = fakeRuntime(["openai", "jev"]);
		runtime.onOpenAIKey?.("rejected");
		expect(notified[0].message).toContain("turned down");
		expect(notified[0].message).toContain("the next judge is answering");
		expect(presented[0]).toMatchObject({ payload: { code: "openai_key", reason: "rejected" } });
	});
});
