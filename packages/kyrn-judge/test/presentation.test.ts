import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";
import { attended } from "./attended.ts";

describe("desktop presentation events", () => {
	it("announces the real pending decision before execution and never inserts UI events into model context", async () => {
		const events: KyrnPresentationEvent[] = [];
		let release: (answers: Record<string, Answer>) => void = () => {};
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(
						() =>
							new Promise((resolve) => {
								release = resolve;
							}),
					),
					mode: "active",
					only: ["preflight"],
					onPresentation: (event) => events.push(event),
					config: parseConfig({ recordState: true, features: attended() }),
				}),
			],
		});
		try {
			let called = false;
			harness.setResponses([
				() => {
					called = true;
					return fauxAssistantMessage("Hello.");
				},
			]);
			const prompt = harness.session.prompt("你好");
			await vi.waitFor(() => expect(events[0]?.kind).toBe("preflight.pending"));
			expect(called).toBe(false);
			release({ turn_type: { type: "choice", choice: "chat", probabilities: { chat: 0.95 } } });
			await prompt;
			expect(events.map((event) => event.kind)).toContain("preflight.verdict");
			expect(events.map((event) => event.kind)).toContain("preflight.wait_end");
			expect(events.find((event) => event.kind === "decision")?.payload).not.toHaveProperty("state");
			expect(events.every((event, index) => event.sequence === index + 1 && event.turnId === 1)).toBe(true);
			expect(JSON.stringify(harness.session.messages)).not.toContain("preflight.pending");
		} finally {
			harness.cleanup();
		}
	});

	it("files a verdict that arrives during the next message under the turn that asked for it", async () => {
		const events: KyrnPresentationEvent[] = [];
		const waiting: ((answers: Record<string, Answer>) => void)[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(
						() =>
							new Promise((resolve) => {
								waiting.push(resolve);
							}),
					),
					mode: "active",
					only: ["preflight"],
					onPresentation: (event) => events.push(event),
					config: parseConfig({ features: attended({ preflight: { waitMs: 20 } }) }),
				}),
			],
		});
		try {
			harness.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
			const chat: Record<string, Answer> = {
				turn_type: { type: "choice", choice: "chat", probabilities: { chat: 0.95 } },
			};
			// The first turn gives up waiting and runs; its judge is still thinking.
			await harness.session.prompt("Refactor the session store");
			expect(events.filter((event) => event.kind === "decision")).toHaveLength(0);

			const second = harness.session.prompt("Now add tests for it");
			await vi.waitFor(() => expect(waiting).toHaveLength(2));
			waiting[0](chat);
			await vi.waitFor(() => expect(events.filter((event) => event.kind === "decision")).toHaveLength(1));
			waiting[1](chat);
			await second;

			const turnsOf = (kind: string) => events.filter((event) => event.kind === kind).map((event) => event.turnId);
			await vi.waitFor(() => expect(turnsOf("decision")).toEqual([1, 2]));
			expect(turnsOf("preflight.verdict")).toEqual([1, 2]);
		} finally {
			harness.cleanup();
		}
	});

	it("ignores a failed presentation listener", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(),
					mode: "active",
					only: ["preflight"],
					onPresentation: () => {
						throw new Error("window closed");
					},
				}),
			],
		});
		try {
			harness.setResponses([fauxAssistantMessage("Still running.")]);
			await harness.session.prompt("hello");
			expect(harness.session.messages.at(-1)?.role).toBe("assistant");
		} finally {
			harness.cleanup();
		}
	});

	it("says which step a progress line is as a code, beside the English", async () => {
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					mode: "active",
					only: ["preflight", "frame"],
					onPresentation: (event) => events.push(event),
					config: parseConfig({ features: { memory: false } }),
				}),
			],
		});
		try {
			harness.setResponses([fauxAssistantMessage("First."), fauxAssistantMessage("Second.")]);
			await harness.session.prompt("Speed up the report page");
			await harness.session.prompt("Only the export button, please");
			const progress = events.filter((event) => event.kind === "progress").map((event) => event.payload);
			expect(progress).toContainEqual({ step: "updating the task frame", code: "frame" });
		} finally {
			harness.cleanup();
		}
	});
});
