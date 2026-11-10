import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVE_AT, CHECK_APPROVE_AT, LOWEST_APPROVE_AT, toolApproval } from "../src/decisions/tool-approval.ts";
import { suggestApprovalLine } from "../src/evolve/calibrate.ts";
import {
	type AdaptationRow,
	type ApprovalRow,
	activeAdaptation,
	activeAdaptations,
	adaptations,
	attention,
	EvolveStore,
	type GrantRow,
	grantSuggestions,
	medianGap,
	missingCommands,
	openingReads,
	type RunRow,
	rowOf,
} from "../src/evolve/store.ts";
import { missingProgram, replacement } from "../src/extension/features/evolve.ts";

const at = "2026-11-10T00:00:00.000Z";
const cwd = "/work/project";

describe("the evolution store", () => {
	const folders: string[] = [];
	afterEach(() => {
		while (folders.length > 0) rmSync(folders.pop() as string, { recursive: true, force: true });
	});

	it("appends a line per row, reads them back in order and skips what it cannot read", () => {
		const folder = mkdtempSync(join(tmpdir(), "mu-evolve-"));
		folders.push(folder);
		const path = join(folder, "mu", "evolve.jsonl");
		const store = new EvolveStore(path);
		expect(store.rows()).toEqual([]);
		store.append({ type: "command", at, missing: "timeout", instead: "gtimeout" });
		store.append({ type: "gap", cwd, at, gapMs: 42_000 });
		writeFileSync(path, `${readFileSync(path, "utf8")}not json\n{"type":"gap","at":"${at}","cwd":"${cwd}"}\n\n`);
		store.append({ type: "opening", cwd, at, paths: ["src/parse.ts"] });
		expect(store.rows()).toEqual([
			{ type: "command", at, missing: "timeout", instead: "gtimeout" },
			{ type: "gap", cwd, at, gapMs: 42_000 },
			{ type: "opening", cwd, at, paths: ["src/parse.ts"] },
		]);
	});

	it("keeps rows in memory when there is no file to keep them in", () => {
		const store = new EvolveStore(undefined);
		store.append({ type: "gap", cwd, at, gapMs: 1 });
		expect(store.rows()).toHaveLength(1);
	});

	it("takes a row only when its fields are what its type needs", () => {
		expect(rowOf({ type: "approval", cwd, at, probability: 0.7, answer: "once", waitedMs: 900 })).toEqual({
			type: "approval",
			cwd,
			at,
			probability: 0.7,
			check: false,
			answer: "once",
			waitedMs: 900,
		});
		// An answer that was no answer is no label.
		expect(
			rowOf({ type: "approval", cwd, at, probability: 0.7, answer: "dismissed", waitedMs: 900 }),
		).toBeUndefined();
		expect(rowOf({ type: "gap", cwd, at, gapMs: -5 })).toBeUndefined();
		// A run's counts: whole numbers, and none for one that is missing or is no count.
		expect(
			rowOf({ type: "run", cwd, at, permissions: 2, permissionsSame: 1.9, messages: -3, stopped: true }),
		).toEqual({
			type: "run",
			cwd,
			at,
			permissions: 2,
			permissionsSame: 1,
			questions: 0,
			questionsSame: 0,
			unanswered: 0,
			messages: 0,
			status: 0,
			stopped: true,
		});
		expect(rowOf({ type: "run", at })).toBeUndefined();
		expect(
			rowOf({ type: "adaptation", id: "a", kind: "something-else", cwd, value: 0.7, at, status: "active" }),
		).toBeUndefined();
		// An answer a standing grant is read from, and the grant: each needs a permission mode mu knows.
		const grant = { cwd, at, key: "shell:npm test", label: "npm test", mode: "ask" };
		expect(rowOf({ type: "grant", ...grant, answer: "session" })).toEqual({
			type: "grant",
			...grant,
			answer: "session",
		});
		expect(rowOf({ type: "grant", ...grant, answer: "once" })).toBeUndefined();
		expect(rowOf({ type: "grant", ...grant, mode: "sometimes", answer: "deny" })).toBeUndefined();
		expect(rowOf({ type: "adaptation", id: "g1", kind: "grant", ...grant, sessions: 3, status: "active" })).toEqual({
			type: "adaptation",
			id: "g1",
			kind: "grant",
			...grant,
			sessions: 3,
			status: "active",
		});
		expect(rowOf({ type: "adaptation", id: "g1", kind: "grant", cwd, at, status: "active" })).toBeUndefined();
		expect(rowOf({ type: "said", cwd, at, about: "line:0.70" })).toEqual({
			type: "said",
			cwd,
			at,
			about: "line:0.70",
		});
		expect(rowOf({ type: "said", cwd, at })).toBeUndefined();
		expect(rowOf({ type: "unknown", at })).toBeUndefined();
		expect(rowOf("text")).toBeUndefined();
	});

	it("folds adaptations by id, so the last line of one says whether it holds", () => {
		const accepted: AdaptationRow = {
			type: "adaptation",
			id: "a1",
			kind: "approval-line",
			cwd,
			value: 0.7,
			evidence: { allowed: 14, considered: 9, from: 0.8 },
			at,
			status: "active",
		};
		expect(activeAdaptation([accepted], "approval-line", cwd)?.value).toBe(0.7);
		// Another project has its own line.
		expect(activeAdaptation([accepted], "approval-line", "/work/other")).toBeUndefined();
		const rows = [accepted, { ...accepted, status: "undone" as const }];
		expect(adaptations(rows)).toHaveLength(1);
		expect(activeAdaptation(rows, "approval-line", cwd)).toBeUndefined();
	});

	it("suggests a standing grant for a command whose latest answers were all for the session", () => {
		const said = (label: string, answer: GrantRow["answer"], mode: GrantRow["mode"] = "judge"): GrantRow => ({
			type: "grant",
			cwd,
			at,
			key: `shell:${label}`,
			label,
			mode,
			answer,
		});
		const three = [said("npm test", "session"), said("npm test", "session"), said("npm test", "session")];
		expect(grantSuggestions(three.slice(0, 2), cwd, "judge", 3)).toEqual([]);
		expect(grantSuggestions(three, cwd, "judge", 3)).toEqual([
			{ key: "shell:npm test", label: "npm test", mode: "judge", sessions: 3 },
		]);
		// Answers given in one permission mode say nothing for another, nor for another project.
		expect(grantSuggestions(three, cwd, "ask", 3)).toEqual([]);
		expect(grantSuggestions(three, "/work/other", "judge", 3)).toEqual([]);
		// One refusal starts the count again.
		const refused = [...three, said("npm test", "deny"), said("npm test", "session"), said("npm test", "session")];
		expect(grantSuggestions(refused, cwd, "judge", 3)).toEqual([]);
		expect(grantSuggestions([...refused, said("npm test", "session")], cwd, "judge", 3)).toHaveLength(1);
		// Each command has its own count.
		expect(
			grantSuggestions([...three, said("git commit", "session")], cwd, "judge", 3).map((each) => each.label),
		).toEqual(["npm test"]);

		// Once accepted it is in force and no longer suggested; undone, it is suggested again.
		const accepted: AdaptationRow = {
			type: "adaptation",
			id: "g1",
			kind: "grant",
			cwd,
			key: "shell:npm test",
			label: "npm test",
			mode: "judge",
			sessions: 3,
			at,
			status: "active",
		};
		expect(activeAdaptations([...three, accepted], "grant", cwd)).toEqual([accepted]);
		expect(grantSuggestions([...three, accepted], cwd, "judge", 3)).toEqual([]);
		const undone = [...three, accepted, { ...accepted, status: "undone" as const }];
		expect(activeAdaptations(undone, "grant", cwd)).toEqual([]);
		expect(grantSuggestions(undone, cwd, "judge", 3)).toHaveLength(1);
		// A grant is not the project's approval line, and the other way round.
		expect(activeAdaptation([accepted], "approval-line", cwd)).toBeUndefined();
	});

	it("counts what a project's sessions opened with, and leaves out what one of several read once", () => {
		const opening = (paths: string[], where = cwd) => ({ type: "opening" as const, cwd: where, at, paths });
		// A single opening is all there is to go by.
		expect(openingReads([opening(["README.md"])], cwd)).toEqual([{ path: "README.md", count: 1 }]);
		const rows = [
			opening(["package.json", "src/parse.ts", "src/parse.ts"]),
			opening(["package.json", "README.md"]),
			opening(["package.json", "src/parse.ts"]),
			opening(["elsewhere.ts", "elsewhere.ts"], "/work/other"),
		];
		expect(openingReads(rows, cwd)).toEqual([
			{ path: "package.json", count: 3 },
			{ path: "src/parse.ts", count: 2 },
		]);
	});

	it("names each missing program once, with what worked for it last", () => {
		expect(
			missingCommands([
				{ type: "command", at, missing: "timeout", instead: "gtimeout" },
				{ type: "command", at, missing: "python", instead: "python3" },
				{ type: "command", at, missing: "timeout", instead: "perl" },
			]),
		).toEqual([
			{ missing: "timeout", instead: "perl", seen: 2 },
			{ missing: "python", instead: "python3", seen: 1 },
		]);
	});

	it("gives the middle gap of a project once there are enough to say", () => {
		const gaps = (values: number[]) => values.map((gapMs) => ({ type: "gap" as const, cwd, at, gapMs }));
		expect(medianGap(gaps([10, 20, 30, 40]), cwd)).toBeUndefined();
		expect(medianGap(gaps([50, 10, 30, 20, 40]), cwd)).toBe(30);
		expect(medianGap(gaps([10, 20, 30, 40, 50, 60]), cwd)).toBe(35);
		expect(medianGap(gaps([10, 20, 30, 40, 50]), "/work/other")).toBeUndefined();
	});

	it("adds up what a project's latest runs took of the user, once there are enough to say", () => {
		const run = (taken: Partial<RunRow> = {}): RunRow => ({
			type: "run",
			cwd,
			at,
			permissions: 0,
			permissionsSame: 0,
			questions: 0,
			questionsSame: 0,
			unanswered: 0,
			messages: 0,
			status: 0,
			stopped: false,
			...taken,
		});
		const runs = [
			run({ permissions: 3, permissionsSame: 2 }),
			run({ questions: 2, questionsSame: 1, messages: 3, status: 2 }),
			run(),
			// A question nobody answered took nothing of the user: the run counts as a quiet one.
			run({ unanswered: 2 }),
			run({ stopped: true }),
		];
		expect(attention(runs.slice(0, 4), cwd)).toBeUndefined();
		expect(attention(runs, cwd)).toEqual({
			runs: 5,
			quiet: 2,
			stopped: 1,
			permissions: 3,
			permissionsSame: 2,
			questions: 2,
			questionsSame: 1,
			unanswered: 2,
			messages: 3,
			status: 2,
		});
		expect(attention(runs, "/work/other")).toBeUndefined();
		// Only the latest runs count: the first one, with its three questions, is out of the last four.
		expect(attention(runs, cwd, 4, 1)).toMatchObject({ runs: 4, permissions: 0, quiet: 2 });
	});
});

describe("where a project's approval line could be", () => {
	const options = {
		line: APPROVE_AT,
		checkLine: CHECK_APPROVE_AT,
		floor: LOWEST_APPROVE_AT,
		minAnswers: 4,
		consideredMs: 1500,
	};
	const answer = (probability: number, fields: Partial<ApprovalRow> = {}): ApprovalRow => ({
		type: "approval",
		cwd,
		at,
		probability,
		check: false,
		answer: "once",
		waitedMs: 3000,
		...fields,
	});

	it("comes down to the lowest probability above which every asked call was allowed", () => {
		const answers = [answer(0.78), answer(0.74), answer(0.72), answer(0.71), answer(0.66, { answer: "deny" })];
		expect(suggestApprovalLine(answers, APPROVE_AT, options)).toEqual({
			line: 0.7,
			from: 0.8,
			allowed: 4,
			considered: 4,
		});
	});

	it("stays where it is under a refusal, with too few answers, or with answers nobody read", () => {
		// A refusal right under the line.
		expect(
			suggestApprovalLine(
				[answer(0.78, { answer: "deny" }), answer(0.72), answer(0.71), answer(0.7)],
				APPROVE_AT,
				options,
			),
		).toBeUndefined();
		// Three answers where four are needed.
		expect(suggestApprovalLine([answer(0.78), answer(0.76), answer(0.75)], APPROVE_AT, options)).toBeUndefined();
		// Allowed within a second each: clicked, not read.
		const fast = [0.78, 0.77, 0.76, 0.75].map((probability) => answer(probability, { waitedMs: 300 }));
		expect(suggestApprovalLine(fast, APPROVE_AT, options)).toBeUndefined();
		// Half of them read is enough.
		expect(suggestApprovalLine([...fast.slice(0, 2), answer(0.76), answer(0.75)], APPROVE_AT, options)?.line).toBe(
			0.75,
		);
	});

	it("never goes below the floor, and counts a check only under the check's own line", () => {
		const low = [0.78, 0.72, 0.68, 0.62, 0.58, 0.55].map((probability) => answer(probability));
		expect(suggestApprovalLine(low, APPROVE_AT, { ...options, minAnswers: 1 })).toEqual({
			line: 0.6,
			from: 0.8,
			allowed: 4,
			considered: 4,
		});
		// A check at 0.72 ran without a question, so it is no answer; one at 0.66 was asked about.
		const checks = [
			answer(0.76),
			answer(0.71),
			answer(0.72, { check: true }),
			answer(0.66, { check: true }),
			answer(0.67),
			answer(0.68),
		];
		expect(suggestApprovalLine(checks, APPROVE_AT, options)).toEqual({
			line: 0.65,
			from: 0.8,
			allowed: 5,
			considered: 5,
		});
	});

	it("comes down only as far as the answers reach without a gap", () => {
		// Nobody was asked about a call between 0.70 and 0.75: what was allowed under 0.70 does not carry the line past it.
		const gapped = [0.78, 0.77, 0.76, 0.66, 0.67, 0.68].map((probability) => answer(probability));
		expect(suggestApprovalLine(gapped, APPROVE_AT, { ...options, minAnswers: 3 })?.line).toBe(0.75);
	});

	it("starts from the line in force, so an accepted line can come down again on new answers", () => {
		const answers = [answer(0.69), answer(0.68), answer(0.67), answer(0.66), answer(0.78)];
		// Under a line of 0.7, the call at 0.78 was never asked about.
		expect(suggestApprovalLine(answers, 0.7, options)).toEqual({ line: 0.65, from: 0.7, allowed: 4, considered: 4 });
	});
});

describe("the approval decision's line", () => {
	const needed = (probability: number) => ({
		verdict: { type: "choice" as const, choice: "needed" as const, probabilities: { needed: probability } },
	});
	const input = {
		task: "t",
		userMessage: "u",
		call: "bash: npm run build",
		where: "a program run in the project folder",
	};

	it("is the built-in one unless the user accepted a lower one, and never under the lowest", () => {
		expect(toolApproval.policy(needed(0.72), input)).toBe("unsure");
		expect(toolApproval.policy(needed(0.72), { ...input, approveAt: 0.7 })).toBe("approve");
		expect(toolApproval.policy(needed(0.68), { ...input, approveAt: 0.7 })).toBe("unsure");
		// An accepted line cannot raise the built-in one, for a call or for a check.
		expect(toolApproval.policy(needed(0.82), { ...input, approveAt: 0.95 })).toBe("approve");
		expect(toolApproval.policy(needed(0.71), { ...input, check: true, approveAt: 0.75 })).toBe("approve");
		// Nor go under the lowest line, whatever was written to the store.
		expect(toolApproval.policy(needed(0.55), { ...input, approveAt: 0.1 })).toBe("unsure");
		expect(toolApproval.policy(needed(LOWEST_APPROVE_AT), { ...input, approveAt: 0.1 })).toBe("approve");
	});

	it("still sends what the judge reads as beyond the task to the user", () => {
		const beyond = {
			verdict: { type: "choice" as const, choice: "beyond" as const, probabilities: { beyond: 0.9 } },
		};
		expect(toolApproval.policy(beyond, { ...input, approveAt: 0.6 })).toBe("beyond");
	});
});

describe("a program that was not found", () => {
	it("is read from what the shell printed", () => {
		expect(missingProgram("zsh: command not found: timeout")).toBe("timeout");
		expect(missingProgram("bash: line 1: timeout: command not found")).toBe("timeout");
		expect(missingProgram("/bin/sh: 1: python: not found")).toBe("python");
		expect(missingProgram("error: test failed, 3 assertions")).toBeUndefined();
	});

	it("names its stand-in only when the command that worked differs in that one word", () => {
		expect(replacement("timeout 30 npm test", "gtimeout 30 npm test", "timeout")).toBe("gtimeout");
		expect(replacement("cd app && python build.py", "cd app && python3 build.py", "python")).toBe("python3");
		// Rewritten further: nothing learned about the program.
		expect(replacement("timeout 30 npm test", "npm test", "timeout")).toBeUndefined();
		expect(replacement("timeout 30 npm test", "gtimeout 60 npm test", "timeout")).toBeUndefined();
		// The word that changed is not the missing one.
		expect(replacement("timeout 30 npm test", "timeout 30 pnpm test", "timeout")).toBeUndefined();
		// What took its place is not a program's name.
		expect(replacement("timeout 30", "$(which gtimeout) 30", "timeout")).toBeUndefined();
	});
});
