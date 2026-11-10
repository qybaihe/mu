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
		/** How long a permission question waits, in ms. */
		waitMs?: number;
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
							permissions: {
								mode: setup.mode ?? "judge",
								...(setup.waitMs === undefined ? {} : { waitMs: setup.waitMs }),
							},
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
		/**
		 * What the user picks in the selects to come, oldest first: the option at that place (-1: the last one), or
		 * "nobody" to let the question run out of time. With none left they pick the first option.
		 */
		const picks: (number | "nobody")[] = [];
		const known: Record<string, unknown> = {
			select: async (title: string, options: string[], dialog?: { timeout?: number }) => {
				asked.push(title);
				const pick = picks.shift();
				if (pick !== "nobody") return options.at(pick ?? 0);
				await new Promise((resolve) => setTimeout(resolve, dialog?.timeout ?? 0));
				return undefined;
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
		return { harness, ran, asked, notes, picks, run, rows, approvals, events };
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

		// The run those answers were given in has ended: mu says there is something to accept, before anyone types /evolve.
		const told = () => session.notes.filter((note) => note.startsWith("mu: you allowed all"));
		expect(told()).toEqual([
			"mu: you allowed all 2 calls here that the judge wasn't sure enough of. /evolve shows the lower approval line this suggests, and /evolve accept takes it. mu won't bring this up again.",
		]);
		await session.harness.session.prompt("/evolve");
		expect(session.notes.at(-1)).toContain("Approval line: 0.80 (built in)");
		expect(session.notes.at(-1)).toContain("You allowed all 2 calls the judge put between 0.70 and 0.80");

		// Nothing changes until the user accepts, and the same suggestion is not said a second time.
		await session.run("Regenerate them again.", ["node scripts/c.js"]);
		expect(session.asked).toHaveLength(3);
		expect(told()).toHaveLength(1);

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

	it("keeps what each run took of the user, and /evolve adds it up", async () => {
		// A shell whose commands can stand for the user: one writes into the run, one stops it.
		const user: { harness?: Harness } = {};
		const bash: AgentTool = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async (_id, params) => {
				const command = String((params as { command?: unknown }).command);
				if (command === "sleep 1") {
					await user.harness?.session.prompt("Use the staging file.", { streamingBehavior: "steer" });
				}
				if (command === "sleep 2") void user.harness?.session.abort();
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const session = await start({ only: ["permissions", "askUser", "evolve"], waitMs: 80, bash });
		user.harness = session.harness;
		const runs = () => session.rows().filter((row) => row.type === "run");
		const ask = (id: string) =>
			fauxAssistantMessage(
				[
					fauxToolCall(
						"ask_user",
						{ questions: [{ question: "Tabs or spaces?", options: [{ label: "Tabs" }, { label: "Spaces" }] }] },
						{ id },
					),
				],
				{ stopReason: "toolUse" },
			);

		// A call the user allows, then one they refuse.
		await session.run("Regenerate the fixtures.", ["node scripts/a.js"]);
		session.picks.push(-1);
		await session.run("And the others.", ["node scripts/b.js"]);
		// A question of the model's answered with the option it put first, then one answered with another.
		session.harness.setResponses([ask("ask-1"), fauxAssistantMessage("Tabs it is.")]);
		await session.harness.session.prompt("Format the file.");
		session.picks.push(1);
		session.harness.setResponses([ask("ask-2"), fauxAssistantMessage("Spaces it is.")]);
		await session.harness.session.prompt("Format the other file.");
		// A run that needs nothing, one the user writes into, and one they stop.
		await session.run("List the fixtures.", ["ls fixtures"]);
		session.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Used the staging file."),
		]);
		await session.harness.session.prompt("Load the fixtures.");
		await session.run("Wait for the server.", ["sleep 2"]);
		// A permission question nobody answers: it takes nothing of the user, and the run goes on.
		session.picks.push("nobody");
		await session.run("Regenerate once more.", ["node scripts/c.js"]);

		const nothing = {
			permissions: 0,
			permissionsSame: 0,
			questions: 0,
			questionsSame: 0,
			unanswered: 0,
			messages: 0,
			status: 0,
		};
		expect(runs().map(({ type, cwd, at, ...taken }) => taken)).toEqual([
			{ ...nothing, permissions: 1, permissionsSame: 1, stopped: false },
			{ ...nothing, permissions: 1, stopped: false },
			{ ...nothing, questions: 1, questionsSame: 1, stopped: false },
			{ ...nothing, questions: 1, stopped: false },
			{ ...nothing, stopped: false },
			{ ...nothing, messages: 1, stopped: false },
			{ ...nothing, stopped: true },
			{ ...nothing, unanswered: 1, stopped: false },
		]);

		await session.harness.session.prompt("/evolve");
		expect(session.notes.at(-1)).toContain(
			[
				"What the last 8 runs here took of you:",
				"  2 needed nothing from you.",
				"  mu asked you 4 times: 2 permission questions, 2 questions from the model.",
				"  You wrote into a run 1 time.",
				"  You stopped 1 run.",
				"  Permission questions: 1 of 2 changed nothing (you allowed the call).",
				"  Questions from the model: 1 of 2 changed nothing (you picked the option it had put first, or skipped the question).",
				"  1 question got no answer in time, and the run went on.",
			].join("\n"),
		);
	});

	it("keeps a command allowed in the project once the user accepts it, and asks again when it is taken back", async () => {
		// Ask first: every command asks, with no judge in between. The second answer is "Allow for this session".
		const session = await start({ only: ["permissions", "evolve"], mode: "ask" });
		const approved = () =>
			session.events
				.filter((event) => event.kind === "permissions.approved")
				.map((event) => (event.payload as { by?: string }).by);
		/** One conversation's worth: the command asks, the user allows it for the session, and the session's grants go. */
		const allowForSession = async () => {
			session.picks.push(1);
			await session.run("Run the tests.", ["npm test"]);
			await session.harness.session.prompt("/permissions reset");
		};

		await allowForSession();
		await allowForSession();
		await session.harness.session.prompt("/evolve");
		expect(session.notes.at(-1)).not.toContain("npm test");
		await session.harness.session.prompt("/evolve accept npm test");
		expect(session.notes.at(-1)).toBe('No suggestion for "npm test" here. /evolve lists what there is.');

		await allowForSession();
		expect(session.asked).toHaveLength(3);
		expect(session.rows().filter((row) => row.type === "grant")).toEqual([
			expect.objectContaining({ key: "shell:npm test", label: "npm test", mode: "ask", answer: "session" }),
			expect.objectContaining({ answer: "session" }),
			expect.objectContaining({ answer: "session" }),
		]);
		await session.harness.session.prompt("/evolve");
		expect(session.notes.at(-1)).toContain(
			"  npm test: you allowed it for the session 3 times in a row. /evolve accept npm test keeps it allowed in this project, and mu stops asking.",
		);
		// Nothing changes until the user accepts, and accepting takes the command's name.
		await session.run("Run the tests.", ["npm test"]);
		expect(session.asked).toHaveLength(4);
		await session.harness.session.prompt("/evolve accept");
		expect(session.notes.at(-1)).toBe("Name the command to accept: /evolve accept npm test");

		await session.harness.session.prompt("/evolve accept npm test");
		expect(session.notes.at(-1)).toContain("npm test now runs in this project without asking, in Ask first.");
		const [grant] = session.rows().filter((row) => row.type === "adaptation");
		expect(grant).toMatchObject({ kind: "grant", key: "shell:npm test", mode: "ask", sessions: 3, status: "active" });

		// The command runs with any arguments, with no question and nobody's answer.
		await session.run("Run them again.", ["npm test -- --bail", "npm test"]);
		expect(session.asked).toHaveLength(4);
		expect(session.ran.slice(-2)).toEqual(["npm test -- --bail", "npm test"]);
		expect(approved().slice(-2)).toEqual(["project", "project"]);
		// What a grant for the session does not cover, this does not cover: another command, a chain, a flagged call.
		await session.run("And more.", ["npm publish", "npm test && git push --force"]);
		expect(session.asked).toHaveLength(6);
		await session.harness.session.prompt("/evolve");
		expect(session.notes.at(-1)).toContain(
			`Commands that run in this project without asking (you accepted them; /evolve undo <id> takes one back):\n  ${grant.type === "adaptation" ? grant.id.slice(0, 8) : ""} · npm test (Ask first)`,
		);

		// Taken back: the command asks again.
		await session.harness.session.prompt(`/evolve undo ${grant.type === "adaptation" ? grant.id.slice(0, 8) : ""}`);
		expect(session.notes.at(-1)).toBe("Taken back: mu asks about npm test in this project again.");
		await session.run("Once more.", ["npm test"]);
		expect(session.asked).toHaveLength(7);
	});

	it("says a command it could keep allowed once, when the run that made it one has ended", async () => {
		const session = await start({ only: ["permissions", "evolve"], mode: "ask" });
		const told = () => session.notes.filter((note) => note.startsWith("mu: you allowed npm test"));
		for (let round = 0; round < 3; round++) {
			expect(told()).toEqual([]);
			session.picks.push(1);
			await session.run("Run the tests.", ["npm test"]);
			await session.harness.session.prompt("/permissions reset");
		}
		expect(told()).toEqual([
			"mu: you allowed npm test for the session 3 times in a row here. /evolve accept npm test keeps it allowed in this project. mu won't bring this up again.",
		]);
		// Kept in the store, so a later session of the project does not say it again either.
		expect(session.rows().filter((row) => row.type === "said")).toEqual([
			expect.objectContaining({ cwd: session.harness.tempDir, about: "grant:ask:shell:npm test" }),
		]);
		session.picks.push(1);
		await session.run("And again.", ["npm test"]);
		expect(told()).toHaveLength(1);
		// It waits in /evolve all the same.
		await session.harness.session.prompt("/evolve");
		expect(session.notes.at(-1)).toContain("/evolve accept npm test keeps it allowed in this project");
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
