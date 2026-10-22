import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { type Capability, CapabilityCatalog } from "../src/catalog/catalog.ts";
import { parseConfig } from "../src/config.ts";
import type { DecisionMode } from "../src/decision.ts";
import { CAPABILITY_ENTRY } from "../src/extension/features/catalog.ts";
import { createKyrnJudgeExtension } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer } from "../src/types.ts";
import { attended } from "./attended.ts";

const yes: Answer = { type: "boolean", probability: 0.96 };
const no: Answer = { type: "boolean", probability: 0.03 };
const unsure: Answer = { type: "boolean", probability: 0.5 };

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async () => ({ content: [{ type: "text", text: `${name} ran` }], details: {} }),
	};
}

function pack(id: string, tools: string[], extra: Partial<Capability> = {}): Capability {
	return { id, kind: "pack", title: id, description: `what ${id} is for`, tools, exposure: "judged", ...extra };
}

describe("capability catalog", () => {
	it("hides the tools of closed capabilities, but never one that an open capability shares", async () => {
		const catalog = new CapabilityCatalog();
		catalog.register(pack("pack:debugger", ["debug_start", "shared"]));
		catalog.register(pack("pack:search", ["sg_search", "shared"]));
		catalog.register(pack("tool:web", ["web_fetch"], { exposure: "always" }));

		expect([...catalog.hiddenTools()].sort()).toEqual(["debug_start", "sg_search", "shared"]);
		expect(await catalog.open("pack:search", "judge", 1)).toBe(true);
		expect([...catalog.hiddenTools()]).toEqual(["debug_start"]);
		expect(await catalog.open("pack:search", "judge", 2)).toBe(false);
		expect(await catalog.open("pack:unknown", "judge", 2)).toBe(false);
		expect(catalog.history()).toEqual([{ id: "pack:search", by: "judge", turn: 1 }]);
		expect(catalog.search("debug").map((capability) => capability.id)).toEqual(["pack:debugger"]);
	});

	it("starts what backs a capability once, and leaves it closed when that fails", async () => {
		const catalog = new CapabilityCatalog();
		let starts = 0;
		let broken = true;
		catalog.register(
			pack("mcp:files", ["files_read"], {
				activate: () => {
					starts++;
					if (broken) throw new Error("server did not start");
				},
			}),
		);

		await expect(catalog.open("mcp:files", "requested", 1)).rejects.toThrow("server did not start");
		expect(catalog.isOpen("mcp:files")).toBe(false);
		broken = false;
		expect(await catalog.open("mcp:files", "requested", 1)).toBe(true);
		expect(starts).toBe(2);
		expect(catalog.isOpen("mcp:files")).toBe(true);
	});
});

describe("capability disclosure", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const capabilities = [
		pack("pack:debugger", ["debug_start"]),
		pack("pack:search", ["sg_search"]),
		pack("tool:web", ["web_fetch"], { exposure: "always" }),
	];

	async function start(responder: MockResponder, mode: DecisionMode = "active"): Promise<Harness> {
		const harness = await createHarness({
			tools: [tool("debug_start"), tool("sg_search"), tool("web_fetch")],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(responder),
					mode,
					config: parseConfig({ features: attended({ memory: false }) }),
					// Preflight is what counts user turns.
					only: ["preflight", "catalog"],
					capabilities,
				}),
			],
		});
		harnesses.push(harness);
		return harness;
	}
	/** Answers the disclosure questions in catalog order: debugger, then search. */
	const disclose =
		(...answers: Answer[]): MockResponder =>
		(request) =>
			Object.fromEntries(
				Object.keys(request.questions)
					.filter((id) => id.startsWith("capability_"))
					.map((id, index) => [id, answers[index] ?? no]),
			);
	const active = (harness: Harness) => harness.session.getActiveToolNames();

	it("opens what the judge is sure the task needs and keeps the rest out of the tool list", async () => {
		const harness = await start(disclose(yes, unsure));
		harness.setResponses([fauxAssistantMessage("On it.")]);

		await harness.session.prompt("The server crashes on startup, step through it.");

		expect(active(harness)).toContain("debug_start");
		expect(active(harness)).not.toContain("sg_search");
		expect(active(harness)).toContain("web_fetch");
		expect(active(harness)).toContain("find_capability");
	});

	it("lets the model find and open a hidden capability, and records that it had to ask", async () => {
		const harness = await start(disclose(no, no));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find_capability", { query: "search" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("find_capability", { open: "pack:search" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Found it."),
		]);

		await harness.session.prompt("Rename every call of foo() to bar().");

		const results = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((m) => JSON.stringify(m));
		expect(results[0]).toContain("pack:search");
		expect(results[0]).not.toContain("pack:debugger");
		expect(results[1]).toContain("sg_search");
		expect(active(harness)).toContain("sg_search");
		expect(active(harness)).not.toContain("debug_start");
		const entries = harness.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === CAPABILITY_ENTRY)
			.map((entry) => (entry as { data?: unknown }).data);
		expect(entries).toEqual([{ id: "pack:search", by: "requested", turn: 1 }]);
	});

	it("tells the model when its tool list grows after the first turn", async () => {
		let turn = 0;
		const harness = await start((request) => disclose(turn === 2 ? yes : no, no)(request));
		harness.setResponses([fauxAssistantMessage("Hello."), fauxAssistantMessage("Stepping through it.")]);

		turn = 1;
		await harness.session.prompt("Hi.");
		expect(active(harness)).not.toContain("debug_start");
		turn = 2;
		await harness.session.prompt("Now debug the crash.");

		expect(active(harness)).toContain("debug_start");
		const notes = harness.session.messages.filter(
			(message) =>
				message.role === "custom" && (message as { customType?: string }).customType === "kyrn.capabilities",
		);
		expect(notes).toHaveLength(1);
		expect(JSON.stringify(notes[0])).toContain("debug_start");
	});

	it("only records the verdict in shadow mode, and hides nothing when the decision is off", async () => {
		const shadow = await start(disclose(yes, yes), "shadow");
		shadow.setResponses([fauxAssistantMessage("ok")]);
		await shadow.session.prompt("Debug it.");
		expect(active(shadow)).not.toContain("debug_start");
		expect(active(shadow)).toContain("find_capability");

		const off = await start(disclose(no, no), "off");
		off.setResponses([fauxAssistantMessage("ok")]);
		await off.session.prompt("Debug it.");
		expect(active(off)).toEqual(expect.arrayContaining(["debug_start", "sg_search", "web_fetch"]));
	});
});
