import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { parseConfig } from "../src/config.ts";
import { type EvolveRow, rowOf } from "../src/evolve/store.ts";
import { createKyrnJudgeExtension, type FeatureName } from "../src/extension/kyrn-judge.ts";
import type { KyrnPresentationEvent } from "../src/extension/presentation.ts";
import { LEDGER_ENTRY_TYPE } from "../src/extension/runtime.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { MockJudgeProvider } from "../src/providers/mock.ts";
import type { Answer, JudgeRequest } from "../src/types.ts";

describe("mu adapting to its user", () => {
	const harnesses: Harness[] = [];
	const folders: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (folders.length > 0) rmSync(folders.pop() as string, { recursive: true, force: true });
	});

	/** How sure the judge is that each command is needed. Any other command is plainly needed. */
	const SURENESS: Readonly<Record<string, number>> = {
		"node scripts/a.js": 0.78,
		"node scripts/b.js": 0.72,
		"node scripts/c.js": 0.72,
		"node scripts/d.js": 0.66,
	};

	async function start(setup: {
		only: FeatureName[];
		evolve?: Record<string, unknown>;
		mode?: string;
		bash?: AgentTool;
	}) {
		const agentDir = mkdtempSync(join(tmpdir(), "mu-evolve-agent-"));
		folders.push(agentDir);
		const ran: string[] = [];
		const bash: AgentTool = setup.bash ?? {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async (_id, params) => {
				ran.push(String((params as { command?: unknown }).command));
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const provider = new MockJudgeProvider((request: JudgeRequest): Record<string, Answer> => {
			if (!("verdict" in request.questions)) return {};
			const command = String((request.state as { tool_call?: string }).tool_call).replace(/^bash: /, "");
			return { verdict: { type: "choice", choice: "needed", probabilities: { needed: SURENESS[command] ?? 0.99 } } };
		});
		const events: KyrnPresentationEvent[] = [];
		const harness = await createHarness({
			tools: [bash],
			extensionFactories: [
				createKyrnJudgeExtension({
					provider,
					mode: "active",
					config: parseConfig({
						features: {
							memory: false,
							permissions: { mode: setup.mode ?? "judge" },
							evolve: { minAnswers: 2, consideredMs: 0, ...setup.evolve },
						},
					}),
					only: setup.only,
					onPresentation: (event) => events.push(event),
					roots: { home: agentDir, agentDir },
				}),
			],
		});
		harnesses.push(harness);
		const asked: string[] = [];
		const notes: string[] = [];
		const known: Record<string, unknown> = {
			select: async (title: string, options: string[]) => {
				asked.push(title);
				return options[0];
			},
			notify: (message: string) => notes.push(message),
			setStatus: () => undefined,
		};
		const ui = new Proxy(known, {
			get: (target, key) => (key in target ? target[key as string] : () => undefined),
		}) as unknown as ExtensionUIContext;
		// An interactive session: what it shows is observed. (The harness alone runs in print mode, which observes nothing.)
		await harness.session.bindExtensions({ uiContext: ui, mode: "rpc" });
		const run = async (prompt: string, commands: readonly string[]) => {
			harness.setResponses([
				...commands.map((command) =>
					fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
				),
				fauxAssistantMessage("Done."),
			]);
			await harness.session.prompt(prompt);
		};
		const rows = (): EvolveRow[] => {
			try {
				return readFileSync(join(agentDir, "mu", "evolve.jsonl"), "utf8")
					.split("\n")
					.filter(Boolean)
					.flatMap((line) => rowOf(JSON.parse(line)) ?? []);
			} catch {
				return [];
			}
		};
		const approvals = () =>
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === LEDGER_ENTRY_TYPE)
				.map((entry) => (entry as { data: LedgerRecord }).data)
				.filter((record) => record.specId === "tool.approval");
		return { harness, ran, asked, notes, run, rows, approvals, events };
	}

	it("suggests a lower approval line from the user's answers, applies it once accepted, and takes it back on a wrong mark", async () => {
		const session = await start({ only: ["preflight", "frame", "permissions", "evolve"] });

		// Two commands the judge reads as needed, not surely enough: the user is asked about both, and allows both.
		await session.run("Regenerate the fixtures.", ["node scripts/a.js", "node scripts/b.js"]);
		expect(session.asked).toHaveLength(2);
		expect(session.rows().filter((row) => row.type === "approval")).toEqual([
			expect.objectContaining({ cwd: session.harness.tempDir, probability: 0.78, check: false, answer: "once" }),
			expect.objectContaining({ probability: 0.72, answer: "once" }),
		]);

		await session.harness.session.prompt("/evolve");
		expect(session.notes.at(-1)).toContain("Approval line: 0.80 (built in)");
		expect(session.notes.at(-1)).toContain("You allowed all 2 calls the judge put between 0.70 and 0.80");

		// Nothing changes until the user accepts.
		await session.run("Regenerate them again.", ["node scripts/c.js"]);
		expect(session.asked).toHaveLength(3);

		await session.harness.session.prompt("/evolve accept");
		expect(session.notes.at(-1)).toContain("This project's approval line is now 0.70.");
		const [accepted] = session.rows().filter((row) => row.type === "adaptation");
		expect(accepted).toMatchObject({ kind: "approval-line", value: 0.7, status: "active", evidence: { from: 0.8 } });

		// At 0.72 the command now runs without a question; at 0.66 the user is still asked.
		await session.run("And once more.", ["node scripts/c.js", "node scripts/d.js"]);
		expect(session.asked).toHaveLength(4);
		expect(session.ran.filter((command) => command === "node scripts/c.js")).toHaveLength(2);
		await session.harness.session.prompt("/evolve");
		expect(session.notes.at(-1)).toContain("Approval line: 0.70 (you accepted it; it was 0.80;");

		// The user marks the approval the lower line let through as wrong: the line is back at once.
		const let_through = session
			.approvals()
			.filter((record) => record.outcome === "approve")
			.at(-1);
		await session.harness.session.prompt(`/ledger wrong ${let_through?.id}`);
		expect(session.notes.at(-1)).toContain(
			"The approval line of this project is back at the built-in 0.80 (it was 0.70).",
		);
		expect(
			session
				.rows()
				.filter((row) => row.type === "adaptation")
				.at(-1),
		).toMatchObject({ status: "undone" });
		await session.run("One last time.", ["node scripts/c.js"]);
		expect(session.asked).toHaveLength(5);
	});

	it("says there is nothing to accept before the answers support a line, and undoes on request", async () => {
		const session = await start({ only: ["preflight", "frame", "permissions", "evolve"], evolve: { minAnswers: 3 } });
		await session.run("Regenerate the fixtures.", ["node scripts/a.js", "node scripts/b.js"]);
		await session.harness.session.prompt("/evolve accept");
		expect(session.notes.at(-1)).toBe("Nothing to accept yet. /evolve shows what has been seen so far.");
		await session.harness.session.prompt("/evolve");
		expect(session.notes.at(-1)).toContain(
			"No lower line to suggest yet: 2 answered here so far, and a band needs 3",
		);
		await session.harness.session.prompt("/evolve undo");
		expect(session.notes.at(-1)).toBe("No such adaptation in this project. /evolve lists what there is.");

		await session.run("More.", ["node scripts/c.js"]);
		await session.harness.session.prompt("/evolve accept");
		const id = session.rows().find((row) => row.type === "adaptation")?.id as string;
		await session.harness.session.prompt(`/evolve undo ${id.slice(0, 8)}`);
		expect(session.notes.at(-1)).toBe("Taken back: the approval line is the built-in 0.80 again.");
		await session.run("Again.", ["node scripts/c.js"]);
		// Asked a, b, c before, and c again now that the line is back.
		expect(session.asked).toHaveLength(4);
	});

	it("learns which program is missing here from a command that failed and worked with one word changed", async () => {
		const bash: AgentTool = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async (_id, params) => {
				const command = String((params as { command?: unknown }).command);
				if (/^timeout\b/.test(command)) throw new Error("zsh: command not found: timeout");
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const session = await start({ only: ["evolve"], mode: "full", bash });
		await session.run("Run the tests with a limit.", [
			"timeout 30 npm test",
			"gtimeout 30 npm test",
			"gtimeout 30 npm test",
		]);
		expect(session.rows().filter((row) => row.type === "command")).toEqual([
			expect.objectContaining({ missing: "timeout", instead: "gtimeout" }),
		]);
		await session.harness.session.prompt("/evolve");
		expect(session.notes.at(-1)).toContain(
			"Programs missing on this machine:\n  timeout (gtimeout worked in its place)",
		);

		// A command that was rewritten, not respelled, teaches nothing.
		const other = await start({ only: ["evolve"], mode: "full", bash });
		await other.run("Run the tests with a limit.", ["timeout 30 npm test", "npm test -- --bail"]);
		expect(other.rows().filter((row) => row.type === "command")).toEqual([]);
	});

	it("keeps how long the user stayed away after a run, and nothing after a turn the user cut", async () => {
		const session = await start({ only: ["evolve"], mode: "full" });
		await session.run("First.", []);
		expect(session.rows().filter((row) => row.type === "gap")).toEqual([]);
		await session.run("Second.", []);
		const gaps = session.rows().filter((row) => row.type === "gap");
		expect(gaps).toEqual([expect.objectContaining({ cwd: session.harness.tempDir })]);
		expect(gaps[0].type === "gap" && gaps[0].gapMs).toBeLessThan(60_000);
	});

	it("observes nothing when it is switched off", async () => {
		const session = await start({
			only: ["preflight", "frame", "permissions", "evolve"],
			evolve: { enabled: false },
		});
		await session.run("Regenerate the fixtures.", ["node scripts/a.js"]);
		expect(session.asked).toHaveLength(1);
		expect(session.rows()).toEqual([]);
	});
});
