import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonValue } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { type PresentDetails, readPresented, sizeText } from "../src/extension/features/present.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import { attended } from "./attended.ts";

const present = (args: Record<string, JsonValue>) =>
	fauxAssistantMessage([fauxToolCall("present", args, { id: "call-present" })], { stopReason: "toolUse" });

const lastResult = (harness: Harness) => {
	const result = [...harness.session.messages].reverse().find((message) => message.role === "toolResult") as
		| { content: { text?: string }[]; details?: unknown; isError?: boolean }
		| undefined;
	return {
		text: (result?.content ?? []).map((block) => block.text ?? "").join("\n"),
		details: result?.details,
		isError: result?.isError === true,
	};
};

describe("present", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	async function start(only: FeatureName[] = ["present"], features: Record<string, unknown> = {}) {
		const harness = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					config: parseConfig({ features: { memory: false, permissions: { mode: "full" }, ...features } }),
					only,
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
		return harness;
	}

	/** A project folder with a report, a deck and a folder in it. */
	function project(harness: Harness): string {
		const root = harness.tempDir;
		mkdirSync(join(root, "out"), { recursive: true });
		writeFileSync(join(root, "out", "report.pdf"), "x".repeat(2048));
		writeFileSync(join(root, "out", "deck.pptx"), "y".repeat(10));
		return root;
	}

	it("hands the user the files that exist, by name and size, and their paths to a client", async () => {
		const harness = await start();
		const root = project(harness);
		const elsewhere = mkdtempSync(join(tmpdir(), "mu-present-"));
		dirs.push(elsewhere);
		writeFileSync(join(elsewhere, "export.csv"), "a,b\n");
		harness.setResponses([
			present({
				files: [
					{ path: "out/report.pdf" },
					{ path: join(root, "out", "deck.pptx"), label: "Slides for Monday" },
					{ path: join(elsewhere, "export.csv") },
				],
				note: "The report has the numbers you asked for.",
			}),
			fauxAssistantMessage("Here they are."),
		]);
		await harness.session.prompt("Write the report and the slides.");
		const { text, details, isError } = lastResult(harness);
		expect(isError).toBe(false);
		expect(text).toBe(
			[
				"Presented to the user (3 files):",
				"- report.pdf (out/report.pdf, 2.0 KB)",
				`- Slides for Monday (${join("out", "deck.pptx")}, 10 B)`,
				`- export.csv (${join(elsewhere, "export.csv")}, 4 B)`,
			].join("\n"),
		);
		expect(details as PresentDetails).toEqual({
			files: [
				{ path: join(root, "out", "report.pdf"), name: "report.pdf", bytes: 2048 },
				{ path: join(root, "out", "deck.pptx"), name: "Slides for Monday", bytes: 10 },
				{ path: join(elsewhere, "export.csv"), name: "export.csv", bytes: 4 },
			],
			note: "The report has the numbers you asked for.",
		});
	});

	it("leaves out what is not a file and says so, and fails when nothing is left", async () => {
		const harness = await start();
		project(harness);
		harness.setResponses([
			present({ files: [{ path: "out/report.pdf" }, { path: "out" }, { path: "out/missing.txt" }] }),
			present({ files: [{ path: "out" }, { path: "nope.md" }] }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Write the report.");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		const first = (results[0].content as { text: string }[])[0].text;
		expect(first).toContain("- report.pdf (out/report.pdf, 2.0 KB)");
		expect(first).toContain("Left out: out: a folder, not a file; out/missing.txt: no such file.");
		const second = results[1] as { isError?: boolean; content: { text: string }[] };
		expect(second.isError).toBe(true);
		expect(second.content[0].text).toContain(
			"Nothing to present: out: a folder, not a file; nope.md: no such file. Present files that exist, once they are written.",
		);
	});

	it("brings its two guidelines into the system prompt, and is left out of an unattended run", async () => {
		const attendedRun = await start(["catalog", "present"], attended());
		attendedRun.setResponses([fauxAssistantMessage("Hi.")]);
		await attendedRun.session.prompt("Hello.");
		expect(attendedRun.session.getActiveToolNames()).toContain("present");
		const prompt = attendedRun.session.systemPrompt;
		expect(prompt).toContain("Call present once at the end with the files the user asked for");
		expect(prompt).toContain("[api.ts](src/api.ts#L24)");

		const unattended = await createHarness({
			extensionFactories: [
				createKyrnJudgeExtension({
					provider: new MockJudgeProvider(() => ({})),
					config: parseConfig({ features: { memory: false } }),
					only: ["catalog", "present"],
				}),
			],
		});
		harnesses.push(unattended);
		unattended.setResponses([fauxAssistantMessage("Hi.")]);
		await unattended.session.prompt("Hello.");
		expect(unattended.session.getActiveToolNames()).not.toContain("present");
	});
});

describe("readPresented and sizeText", () => {
	it("reads each named file once", () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-present-"));
		try {
			writeFileSync(join(dir, "a.txt"), "hello");
			expect(readPresented([{ path: "a.txt" }, { path: join(dir, "a.txt") }, { path: "  " }], dir)).toEqual({
				files: [{ path: join(dir, "a.txt"), name: "a.txt", bytes: 5 }],
				problems: [],
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("says sizes as a person reads them", () => {
		expect(sizeText(0)).toBe("0 B");
		expect(sizeText(1536)).toBe("1.5 KB");
		expect(sizeText(20 * 1024 * 1024)).toBe("20 MB");
	});
});
