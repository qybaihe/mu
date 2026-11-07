import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import {
	DISPATCH_ENTRY,
	interruptedCalls,
	RECOVERY_MESSAGE,
	recoveryNote,
} from "../src/extension/features/recovery.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";

const push = fauxToolCall("bash", { command: "git push origin main" }, { id: "call-push" });
const edit = fauxToolCall("edit", { path: "src/a.ts", oldText: "a", newText: "b" }, { id: "call-edit" });
const look = fauxToolCall("read", { path: "src/a.ts" }, { id: "call-read" });

/** A session whose last turn asked for three calls: mu was killed after the push started. */
function interrupted(): SessionManager {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "user", content: "Ship it.", timestamp: 1 });
	session.appendMessage(fauxAssistantMessage([fauxText("Pushing."), push, edit, look], { stopReason: "toolUse" }));
	session.appendCustomEntry(DISPATCH_ENTRY, { toolCallId: push.id, tool: "bash" });
	return session;
}

const entry = (fields: Record<string, unknown>) =>
	({ id: "x", parentId: null, timestamp: "", ...fields }) as SessionEntry;

describe("calls an interruption left without a result", () => {
	it("are those of the last turn with no result: started, never started, or only reading", () => {
		expect(interruptedCalls(interrupted().getBranch())).toEqual([
			{ id: "call-push", tool: "bash", input: push.arguments, mutating: true, started: true },
			{ id: "call-edit", tool: "edit", input: edit.arguments, mutating: true, started: false },
			{ id: "call-read", tool: "read", input: look.arguments, mutating: false, started: false },
		]);

		const answered = interrupted();
		answered.appendMessage({
			role: "toolResult",
			toolCallId: push.id,
			toolName: "bash",
			content: [{ type: "text", text: "Everything up-to-date" }],
			isError: false,
			timestamp: 2,
		});
		expect(interruptedCalls(answered.getBranch()).map((call) => call.id)).toEqual(["call-edit", "call-read"]);
	});

	it("are none once the user has written, once the note was given, or when the turn was cut off", () => {
		const branch = interrupted().getBranch();
		expect(
			interruptedCalls([
				...branch,
				entry({ type: "message", message: { role: "user", content: "x", timestamp: 3 } }),
			]),
		).toEqual([]);
		expect(
			interruptedCalls([
				...branch,
				entry({ type: "custom_message", customType: RECOVERY_MESSAGE, content: "", display: true }),
			]),
		).toEqual([]);

		const aborted = SessionManager.inMemory();
		aborted.appendMessage({ role: "user", content: "Ship it.", timestamp: 1 });
		aborted.appendMessage(fauxAssistantMessage([push], { stopReason: "aborted" }));
		expect(interruptedCalls(aborted.getBranch())).toEqual([]);
		expect(interruptedCalls([])).toEqual([]);
	});

	it("are named in a note that says to check before running a started one again", () => {
		const note = recoveryNote(interruptedCalls(interrupted().getBranch()));
		expect(note).toContain(
			"- bash `git push origin main`: it started, and whether it took effect is unknown. Before running it again, check whether it did",
		);
		expect(note).toContain("- edit `src/a.ts`: it never started. Run it again if it is still needed.");
		expect(note).toContain("- read `src/a.ts`: it only reads. Run it again if you still need it.");
	});
});

describe("interrupted tool calls in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const start = async (only: FeatureName[], sessionManager?: SessionManager, mode = "full") => {
		const harness = await createHarness({
			...(sessionManager ? { sessionManager } : {}),
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					config: parseConfig({ features: { memory: false, permissions: { mode } } }),
					only,
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "rpc" });
		return harness;
	};
	const customTypes = (harness: Harness) =>
		harness.sessionManager
			.getBranch()
			.map((item) => (item.type === "custom" || item.type === "custom_message" ? item.customType : item.type));

	it("tells the model, when the session opens, what each call left without a result is", async () => {
		const harness = await start(["recovery"], interrupted());
		const note = harness.session.messages.at(-1);
		expect(note).toMatchObject({ role: "custom", customType: RECOVERY_MESSAGE, display: true });
		expect(JSON.stringify(note)).toContain("whether it took effect is unknown");

		let sent: Message[] = [];
		harness.setResponses([
			(context) => {
				sent = context.messages;
				return fauxAssistantMessage("I'll check the remote first.");
			},
		]);
		await harness.session.prompt("Go on.");
		// Right after the turn it is about; pi's providers answer each call "No result provided" in between.
		expect(sent.slice(0, 3).map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(JSON.stringify(sent[2])).toContain("it never started");
		expect(JSON.stringify(sent.at(-1))).toContain("Go on.");

		// Opened again, the session has its note already.
		const again = await start(["recovery"], harness.sessionManager);
		expect(customTypes(again).filter((type) => type === RECOVERY_MESSAGE)).toHaveLength(1);
	});

	it("marks a call that may change something as started just before it runs, and no other", async () => {
		const harness = await start(["recovery"]);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "touch made.txt" }, { id: "call-touch" }),
					fauxToolCall("bash", { command: "ls" }, { id: "call-ls" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Make the file");

		const marks = harness.sessionManager
			.getBranch()
			.filter((item) => item.type === "custom" && item.customType === DISPATCH_ENTRY)
			.map((item) => (item.type === "custom" ? item.data : undefined));
		expect(marks).toEqual([{ toolCallId: "call-touch", tool: "bash" }]);
		const branch = harness.sessionManager.getBranch();
		const marked = branch.findIndex((item) => item.type === "custom" && item.customType === DISPATCH_ENTRY);
		const result = branch.findIndex(
			(item) =>
				item.type === "message" && item.message.role === "toolResult" && item.message.toolCallId === "call-touch",
		);
		expect(marked).toBeGreaterThan(-1);
		expect(marked).toBeLessThan(result);
	});

	it("does not mark a call one of mu's checks stopped: it never ran", async () => {
		const harness = await start(["permissions", "recovery"], undefined, "minimal");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "touch made.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Could not."),
		]);
		await harness.session.prompt("Make the file");
		expect(customTypes(harness)).not.toContain(DISPATCH_ENTRY);
	});
});
