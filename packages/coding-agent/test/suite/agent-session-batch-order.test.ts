import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";
import { createHarness, type Harness } from "./harness.ts";

// mu (fork ledger M50): a file change is a barrier in its batch of tool calls.
describe("AgentSession batches with a file change", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("declares edit and write sequential", () => {
		expect(createWriteToolDefinition(process.cwd()).executionMode).toBe("sequential");
		expect(createEditToolDefinition(process.cwd()).executionMode).toBe("sequential");
	});

	it("runs a call after a write once the file is written, and the calls around it in parallel", async () => {
		const seen: string[] = [];
		let running = 0;
		let overlapped = false;
		const harness = await createHarness({
			initialActiveToolNames: ["write", "look"],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "look",
						label: "look",
						description: "Say whether a file is there.",
						parameters: Type.Object({ path: Type.String() }),
						execute: async (_id, { path }, _signal, _onUpdate, ctx) => {
							running++;
							if (running > 1) overlapped = true;
							const file = join(ctx.cwd, path);
							seen.push(existsSync(file) ? readFileSync(file, "utf8") : "missing");
							await new Promise((resolve) => setTimeout(resolve, 20));
							running--;
							return { content: [{ type: "text", text: "looked" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("look", { path: "run.sh" }),
					fauxToolCall("look", { path: "other.txt" }),
					fauxToolCall("write", { path: "run.sh", content: "echo hi\n" }),
					fauxToolCall("look", { path: "run.sh" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Write run.sh and check it.");

		// The two looks before the write ran together and saw no file; the one after it saw the file written.
		expect(overlapped).toBe(true);
		expect(seen).toEqual(["missing", "missing", "echo hi\n"]);
		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(results.map((result) => result.toolName)).toEqual(["look", "look", "write", "look"]);
	});
});
