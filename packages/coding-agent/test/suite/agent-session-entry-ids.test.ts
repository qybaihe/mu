import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * message_end fires before its message is saved, so the entry id is reserved first and travels on the event. An app that
 * shows a live conversation names its messages (to fork from one, to hide a retried attempt) by the ids the session
 * file uses, without waiting for the file.
 */
describe("AgentSession: entry ids on message_end", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("gives each saved message the id of its session entry", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		const ended = harness.eventsOfType("message_end");
		const roles = ended.map((event) => event.message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");

		const savedByRole = new Map(
			harness.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "message" ? [[entry.id, entry.message.role] as const] : [])),
		);
		for (const event of ended) {
			expect(event.entryId, `a ${event.message.role} message_end`).toBeTypeOf("string");
			expect(savedByRole.get(event.entryId as string)).toBe(event.message.role);
		}
		expect(new Set(ended.map((event) => event.entryId)).size).toBe(ended.length);
	});

	it("names tool results too, and every id belongs to the entry that holds that message", async () => {
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const entries = new Map(harness.sessionManager.getEntries().map((entry) => [entry.id, entry] as const));
		const ended = harness.eventsOfType("message_end");
		expect(ended.map((event) => event.message.role)).toContain("toolResult");
		for (const event of ended) {
			const entry = entries.get(event.entryId as string);
			expect(entry?.type).toBe("message");
			if (entry?.type === "message") expect(entry.message).toBe(event.message);
		}
	});

	it("keeps the order the rest of pi relies on: message_end reaches listeners before its message is saved", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		const branchesSeen: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				branchesSeen.push(harness.sessionManager.getBranch().length);
			}
		});

		await harness.session.prompt("hi");

		// The assistant message is not in the branch yet when listeners see its message_end, and it is afterwards.
		const before = branchesSeen[0];
		expect(before).toBeGreaterThan(0);
		expect(harness.sessionManager.getBranch().length).toBe(before + 1);
	});

	it("does not let a reserved id be taken by another entry before its message is written", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const reserved = harness.sessionManager.reserveEntryId();

		const other = harness.sessionManager.appendCustomEntry("test.other", {});
		expect(other).not.toBe(reserved);

		const written = harness.sessionManager.appendCustomMessageEntry("test.note", "hello", true, undefined, reserved);
		expect(written).toBe(reserved);
		expect(harness.sessionManager.getEntry(reserved)?.type).toBe("custom_message");

		// A reserved id is spent once; asking for it again gets a new one.
		const again = harness.sessionManager.appendCustomMessageEntry("test.note", "again", true, undefined, reserved);
		expect(again).not.toBe(reserved);
	});
});
