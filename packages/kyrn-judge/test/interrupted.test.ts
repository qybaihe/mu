import { type Context, fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { INTERRUPTED_MESSAGE, interruptedNote, registerInterrupted } from "../src/extension/features/interrupted.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { KyrnRuntime } from "../src/extension/runtime.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

const POINTS = [
	"There are three ways to fix the flaky test.",
	"First, give the server a port of its own instead of 3000.",
	"Second, wait for the ready line before the first request, not a fixed 200 ms.",
	"Third, close the server in afterEach so the next test does not inherit it.",
].join(" ");

describe("a reply the user stopped", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function start(features: Record<string, unknown> = {}): Promise<Harness> {
		const harness = await createHarness({
			tokensPerSecond: 200,
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					config: parseConfig({ features: { memory: false, ...features } }),
					only: ["interrupted"],
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	}

	/** Prompts, and stops the reply once it has written `after` characters of text. */
	async function stopAfter(harness: Harness, after: number): Promise<void> {
		let written = 0;
		let stopped = false;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta" || stopped) return;
			written += event.assistantMessageEvent.delta.length;
			if (written >= after) {
				stopped = true;
				void harness.session.abort();
			}
		});
		await harness.session.prompt("Why is the server test flaky, and how do I fix it?");
		unsubscribe();
	}

	const notes = (harness: Harness) =>
		harness.session.messages.filter(
			(message) =>
				message.role === "custom" && (message as { customType?: string }).customType === INTERRUPTED_MESSAGE,
		);

	it("gives the model back the text the user saw, after the stopped reply, for the model only", async () => {
		const harness = await start();
		let sent: Context | undefined;
		harness.setResponses([
			fauxAssistantMessage([fauxThinking("The port is shared."), fauxText(POINTS)]),
			(context: Context) => {
				sent = context;
				return fauxAssistantMessage("Waiting for the ready line means ...");
			},
		]);
		await stopAfter(harness, 120);
		expect(harness.session.messages.at(-2)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		const [note] = notes(harness);
		expect(note).toMatchObject({ role: "custom", display: false });
		expect(harness.session.messages.at(-1)).toBe(note);
		const said = String((note as { content: unknown }).content);
		expect(said).toContain("There are three ways to fix the flaky test.");
		// Neither its reasoning nor what it had not written yet.
		expect(said).not.toContain("The port is shared.");
		expect(said).not.toContain("Third, close the server");

		await harness.session.prompt("Stop. Expand the second point.");
		const request = JSON.stringify(sent?.messages ?? []);
		expect(request).toContain("The user stopped your last reply before it finished");
		expect(request).toContain("First, give the server a port of its own");
		// It comes before the user's next message.
		expect(request.indexOf("The user stopped your last reply")).toBeLessThan(
			request.indexOf("Expand the second point"),
		);
	});

	it("says nothing of a reply stopped before it wrote, or when turned off", async () => {
		const thinking = await start();
		thinking.setResponses([fauxAssistantMessage([fauxThinking("x".repeat(400)), fauxText("never seen")])]);
		const unsubscribe = thinking.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
				void thinking.session.abort();
			}
		});
		await thinking.session.prompt("Think about it.");
		unsubscribe();
		expect(thinking.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(notes(thinking)).toEqual([]);

		const off = await start({ interrupted: { enabled: false } });
		off.setResponses([fauxAssistantMessage(POINTS)]);
		await stopAfter(off, 60);
		expect(off.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(notes(off)).toEqual([]);
	});

	it("leaves a reply mu cut itself to the feature that cut it", async () => {
		const handlers: ((event: unknown) => unknown)[] = [];
		const sent: unknown[] = [];
		const pi = {
			on: (event: string, handler: (event: unknown) => unknown) => {
				if (event === "message_end") handlers.push(handler);
			},
			sendMessage: (message: unknown) => sent.push(message),
		} as unknown as ExtensionAPI;
		const runtime = new KyrnRuntime(pi, parseConfig({}), new Judge({ provider: new MockJudgeProvider() }));
		registerInterrupted(runtime);
		const stopped = { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "So far." }] };
		runtime.harnessAbort = true;
		for (const handler of handlers) await handler({ type: "message_end", message: stopped });
		expect(sent).toEqual([]);
		runtime.harnessAbort = false;
		for (const handler of handlers) await handler({ type: "message_end", message: stopped });
		expect(sent).toHaveLength(1);
	});

	it("keeps the beginning and the end of a long reply", () => {
		const note = interruptedNote(`${"a".repeat(5000)}${"b".repeat(3000)}`);
		expect(note).toContain(`${"a".repeat(4000)}\n[… 2000 characters …]\n${"b".repeat(2000)}`);
	});
});
