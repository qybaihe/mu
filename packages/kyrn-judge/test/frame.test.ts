import { describe, expect, it } from "vitest";
import {
	addItem,
	compactFrame,
	constraintId,
	createFrame,
	describeFrame,
	type Frame,
	type FrameState,
	frameEntry,
	isStale,
	limitClauses,
	openItems,
	openQuestionCode,
	parseFrameEntry,
	removeConstraint,
	renderFrameNote,
	ruleUpdate,
	tickItem,
	type UnmergedText,
	withEntryId,
} from "../src/frame/frame.ts";
import { findVerbatim, mergeWriterFrame, parseWriterReply, writerRequest } from "../src/frame/writer.ts";

const first = createFrame({ text: "Add pagination to the users API", turn: 1 });
const PRD_EXAMPLE = "保留原方案，但取消数据库变更";
const rename = "Rename notes.md to NOTES.md.";
const fixtureRule = "Do not edit the fixture.";
const publishRule = "Never publish the draft.";

function withItems(frame: Frame, ...texts: string[]): Frame {
	return texts.reduce((current, text) => {
		const added = addItem(current, text, "model");
		if ("error" in added) throw new Error(added.error);
		return added.frame;
	}, frame);
}

describe("task frame model", () => {
	it("makes version 1 from the first message, with nothing invented", () => {
		expect(first).toMatchObject({
			version: 1,
			goal: "Add pagination to the users API",
			constraints: [],
			acceptance: [],
			openQuestions: [],
			updatedTurn: 1,
			source: "first-message",
		});
	});

	it("rules: an explicit limit is kept word for word with its source and deduped", () => {
		const next = ruleUpdate(first, { text: fixtureRule, turn: 3, entryId: "e3", limit: { kind: "add" } });
		expect(next.version).toBe(2);
		expect(next.goal).toBe(first.goal);
		expect(next.constraints).toEqual([{ text: fixtureRule, source: { turn: 3, entryId: "e3" } }]);
		expect(next).toMatchObject({ source: "rules", updatedTurn: 3 });
		expect(ruleUpdate(next, { text: fixtureRule, turn: 4, limit: { kind: "add" } }).constraints).toEqual(
			next.constraints,
		);
	});

	it("rules: a new task replaces goal and checklist but keeps the constraints", () => {
		const constrained = ruleUpdate(withItems(first, "pages are stable"), {
			text: "never commit without asking",
			turn: 2,
			limit: { kind: "add" },
		});
		const next = ruleUpdate(constrained, { text: "Now fix the CSS of the header", turn: 3, change: "new_task" });
		expect(next.goal).toBe("Now fix the CSS of the header");
		expect(next.acceptance).toEqual([]);
		expect(next.constraints.map((constraint) => constraint.text)).toEqual(["never commit without asking"]);
		// Ids are not handed out twice, even after the list was cleared.
		expect(withItems(next, "header is aligned").acceptance[0].id).toBe("a2");
	});

	it("rules: a subgoal is set, and an unclear change becomes a question instead of replacing the goal", () => {
		expect(ruleUpdate(first, { text: "start with the SQL query", turn: 2, change: "subgoal" }).currentSubgoal).toBe(
			"start with the SQL query",
		);
		const unclear = ruleUpdate(first, { text: "and the admin page?", turn: 2, change: "unclear" });
		expect(unclear.goal).toBe(first.goal);
		expect(unclear.openQuestions).toEqual(['How does this change the task: "and the admin page?"?']);
		// The rules' question has a code for a client that translates; a question the writer wrote is its own words.
		expect(unclear.openQuestions.map(openQuestionCode)).toEqual([
			{ code: "unclear_change", params: { message: "and the admin page?" } },
		]);
		expect(openQuestionCode("Which database should the importer use?")).toBeNull();
	});

	it("does not cut a long limit and discard its exception", () => {
		const long = `Do not touch ${"tables, ".repeat(160)}except the temporary tables.`;
		const [constraint] = ruleUpdate(first, { text: long, turn: 2, limit: { kind: "add" } }).constraints;
		expect(constraint.text).toBe(long);
		expect(constraint.partial).toBeUndefined();
	});

	it("ticks and adds without bumping the version, and refuses what it cannot do", () => {
		const frame = withItems(first, "tests pass", "docs updated");
		const ticked = tickItem(frame, "A1", "vitest: 12 passed", "model");
		if ("error" in ticked) throw new Error(ticked.error);
		expect(ticked.frame.version).toBe(1);
		expect(ticked.item).toMatchObject({ id: "a1", done: true, doneBy: "model", evidence: "vitest: 12 passed" });
		expect(openItems(ticked.frame).map((item) => item.id)).toEqual(["a2"]);
		expect(tickItem(frame, "a9", "x", "model")).toEqual({ error: expect.stringContaining("Known ids: a1, a2") });
		expect(tickItem(frame, "a1", " ", "model")).toEqual({ error: expect.stringContaining("evidence") });
		expect(addItem(frame, "tests pass", "model")).toEqual({ error: expect.stringContaining("a1") });
		expect(addItem(frame, "  ", "model")).toHaveProperty("error");
	});

	it("compact view: what nobody judged shows as the latest message, exactly like the old stand-in", () => {
		expect(compactFrame({ unmerged: [] })).toBeUndefined();
		expect(compactFrame({ frame: first, unmerged: [] })).toEqual({
			goal: "Add pagination to the users API",
			currentSubgoal: undefined,
		});
		const unjudged: FrameState = {
			frame: first,
			unmerged: [{ text: "write the SQL first", turn: 2, reason: "unjudged" }],
		};
		expect(compactFrame(unjudged)).toEqual({ goal: first.goal, currentSubgoal: "write the SQL first" });
		expect(isStale(unjudged)).toBe(false);
		// The first message said again is not a subgoal of itself.
		expect(
			compactFrame({ frame: first, unmerged: [{ text: first.goal, turn: 2, reason: "unjudged" }] })?.currentSubgoal,
		).toBeUndefined();
	});

	it("compact view: a failed update keeps the last version and shows the new words the way the rules would", () => {
		const state: FrameState = {
			frame: first,
			unmerged: [{ text: PRD_EXAMPLE, turn: 3, change: "correction", reason: "failed" }],
		};
		expect(isStale(state)).toBe(true);
		expect(state.frame?.version).toBe(1);
		expect(compactFrame(state)).toEqual({ goal: first.goal, currentSubgoal: PRD_EXAMPLE });
		expect(isStale({ frame: first, unmerged: [{ text: "x", turn: 2, reason: "late" }] })).toBe(true);
		expect(renderFrameNote(state)).toContain("not merged into the frame yet");
		expect(describeFrame(state)).toContain("STALE");
	});

	it("renders a short note and a full description", () => {
		const ticked = tickItem(withItems(first, "tests pass"), "a1", "12 passed", "model");
		if ("error" in ticked) throw new Error(ticked.error);
		const frame = ruleUpdate(ticked.frame, { text: fixtureRule, turn: 3, entryId: "abc", limit: { kind: "add" } });
		const note = renderFrameNote({ frame, unmerged: [] });
		expect(note).toContain("[mu task frame v2]");
		expect(note).toContain(`- "${fixtureRule}" (turn 3)`);
		expect(note).toContain("- [x] a1 tests pass");
		const text = describeFrame({ frame, unmerged: [] });
		expect(text).toContain("task frame v2 · updated at turn 3 · rules");
		expect(text).toContain(`${constraintId(fixtureRule)} "${fixtureRule}"`);
		expect(text).toContain("(turn 3, entry abc)");
		expect(text).toContain("12 passed (model)");
		expect(describeFrame({ unmerged: [] })).toContain("No task frame yet");
	});

	it("fills in the entry id of the message a constraint was taken from", () => {
		const frame = ruleUpdate(first, { text: "never commit", turn: 2, limit: { kind: "add" } });
		const state: FrameState = { frame, unmerged: [{ text: "more", turn: 2, reason: "failed", change: "subgoal" }] };
		const other = withEntryId(state, { turn: 2, text: "something else entirely", entryId: "zz" });
		expect(other.frame?.constraints[0].source.entryId).toBeUndefined();
		const patched = withEntryId(state, { turn: 2, text: "please never commit, ok", entryId: "e2" });
		expect(patched.frame?.constraints[0].source).toEqual({ turn: 2, entryId: "e2" });
		expect(withEntryId(state, { turn: 2, text: "more", entryId: "e9" }).unmerged[0].entryId).toBe("e9");
	});

	it("stores what failed but not what is merely late, and refuses entries it did not write", () => {
		const state: FrameState = {
			frame: first,
			unmerged: [
				{ text: "a", turn: 2, reason: "failed", change: "constraint" },
				{ text: "b", turn: 3, reason: "late" },
			],
		};
		const entry = frameEntry(state, "stale");
		expect(entry?.unmerged.map((said) => said.text)).toEqual(["a"]);
		expect(parseFrameEntry(JSON.parse(JSON.stringify(entry)))).toEqual({ frame: first, unmerged: entry?.unmerged });
		expect(frameEntry({ unmerged: [] }, "created")).toBeUndefined();
		for (const broken of [
			null,
			"frame",
			{ schema: 3, frame: first },
			{ schema: 1, frame: { ...first, goal: 7 } },
			{ schema: 1, frame: { ...first, constraints: [{ text: "x" }] } },
			{ schema: 1, frame: { ...first, version: 0 } },
		]) {
			expect(parseFrameEntry(broken)).toBeUndefined();
		}
	});
});

describe("work and limit updates", () => {
	const legacy: Frame = {
		...first,
		change: "constraint",
		constraints: [publishRule, fixtureRule, fixtureRule].map((text) => ({ text, source: { turn: 1 } })),
	};
	const id = constraintId(fixtureRule);
	const base = { goal: first.goal, constraints: [], acceptance: [], openQuestions: [] };

	it("a one-time correction never becomes a limit, even when the writer quotes it", () => {
		const said = { text: rename, turn: 2, change: "correction" as const };
		expect(ruleUpdate(first, said).constraints).toEqual([]);
		const merged = mergeWriterFrame(first, { ...base, constraints: [rename], currentSubgoal: rename }, [said]);
		expect(merged.constraints).toEqual([]);
		expect(merged.currentSubgoal).toBe(rename);
	});

	it("keeps separately quoted affirmative and negative limits, and a clear prohibition the writer omits", () => {
		const keep = "Keep the filename uppercase.";
		const said = {
			text: `${rename} ${keep} ${fixtureRule}`,
			turn: 2,
			change: "subgoal" as const,
			limit: { kind: "add" as const },
		};
		const written = mergeWriterFrame(
			first,
			{ ...base, currentSubgoal: rename, constraints: [rename, keep, fixtureRule] },
			[said],
		);
		expect(written.constraints.map(({ text }) => text)).toEqual([keep, fixtureRule]);
		expect(
			mergeWriterFrame(first, base, [{ text: fixtureRule, turn: 2, limit: { kind: "add" } }]).constraints.map(
				({ text }) => text,
			),
		).toEqual([fixtureRule]);
		const mixed = mergeWriterFrame(first, { ...base, constraints: ["取消数据库变更"] }, [
			{ ...said, text: PRD_EXAMPLE },
		]);
		expect(mixed.constraints.map(({ text }) => text)).toEqual(["取消数据库变更"]);
	});

	it("a single prohibition can correct the proposed work and impose a limit at the same time", () => {
		const rule = "Do not edit the glossary.";
		const said = { text: rule, turn: 2, change: "correction" as const, limit: { kind: "add" as const } };
		for (const frame of [
			ruleUpdate(first, said),
			mergeWriterFrame(first, { ...base, constraints: [rule], currentSubgoal: rule }, [said]),
		])
			expect(frame.constraints.map(({ text }) => text)).toEqual([rule]);
	});

	it.each([", but you may correct typos in it.", ". Typo fixes are fine.", ".\n\nThat does not apply to typos."])(
		"preserves a user's exception even if the writer omits it: %s",
		(exception) => {
			const prefix = "Do not edit the glossary";
			const text = prefix + exception;
			const said = { text, turn: 2, limit: { kind: "add" as const } };
			for (const frame of [
				ruleUpdate(first, said),
				...[[], [text], [prefix]].map((constraints) => mergeWriterFrame(first, { ...base, constraints }, [said])),
			])
				expect(frame.constraints.map((rule) => rule.text)).toEqual([text]);
		},
	);

	it("keeps a leading exception even if the writer selects only the prohibition", () => {
		const text = "Except for typo fixes, do not edit the glossary.";
		const said = { text, turn: 2, limit: { kind: "add" as const } };
		for (const frame of [
			ruleUpdate(first, said),
			mergeWriterFrame(first, { ...base, constraints: ["do not edit the glossary."] }, [said]),
		]) {
			expect(frame.constraints.map((rule) => rule.text)).toEqual([text]);
		}
	});

	it("does not promote exact quotes on unclear limit verdicts", () => {
		const said = { text: fixtureRule, turn: 2, change: "unclear" as const, limit: { kind: "unclear" as const } };
		for (const frame of [
			ruleUpdate(first, said),
			mergeWriterFrame(first, { ...base, constraints: [fixtureRule] }, [said]),
		]) {
			expect(frame.constraints).toEqual([]);
			expect(frame.openQuestions.join("\n")).toContain(fixtureRule);
		}
	});

	it.each([
		[`${rename} ${fixtureRule}`, fixtureRule],
		[`${rename.slice(0, -1)}, but ${fixtureRule}`, fixtureRule],
	])("isolates an independently authorized rule from the work in a mixed turn: %s", (text, exactRule) => {
		const said = { text, turn: 2, change: "subgoal" as const, limit: { kind: "add" as const } };
		const rules = ruleUpdate(first, said);
		const written = mergeWriterFrame(
			first,
			{ ...base, currentSubgoal: rename, constraints: [said.text, rename, fixtureRule] },
			[said],
		);
		for (const frame of [rules, written]) {
			expect(frame.currentSubgoal?.replace(/\.$/, "")).toBe(rename.slice(0, -1));
			expect(frame.constraints).toEqual([{ text: exactRule, source: { turn: 2 } }]);
		}
	});

	it.each([
		["Rename the file and keep the public API unchanged", "keep the public API unchanged", "Rename the notes file."],
		["更新安装文档，但不要改动命令示例。", "不要改动命令示例。", "补充安装步骤和依赖项。"],
		["修复帮助页，并保持命令示例不变。", "保持命令示例不变。", "纠正帮助页中的错误。"],
	])("separates a stand-alone limit from work with a paraphrased subgoal: %s", (text, rule, currentSubgoal) => {
		const said = { text, turn: 2, entryId: "e2", change: "subgoal", limit: { kind: "add" } } as const;
		const written = mergeWriterFrame(first, { ...base, constraints: [rule], currentSubgoal }, [said]);
		expect(written.currentSubgoal).toBe(currentSubgoal);
		for (const frame of [written, ruleUpdate(first, said)]) {
			expect(frame.constraints).toEqual([{ text: rule, source: { turn: 2, entryId: "e2" } }]);
		}
	});

	it("can use the exact new goal to separate work without recognizing the verb", () => {
		const goal = "Alphabetize the index";
		const rule = "preserve the link targets.";
		const said = { text: `${goal} and ${rule}`, turn: 2, change: "new_task", limit: { kind: "add" } } as const;
		const frame = mergeWriterFrame(first, { ...base, goal, constraints: [rule] }, [said]);
		expect(frame.goal).toBe(goal);
		expect(frame.constraints.map(({ text }) => text)).toEqual([rule]);
	});

	it("splits following work only when the writer identifies it, not by assuming 'but' ends the rule", () => {
		const quote = fixtureRule.slice(0, -1);
		const said = {
			text: `${quote}, but ${rename}`,
			turn: 2,
			change: "subgoal" as const,
			limit: { kind: "add" as const },
		};
		const written = mergeWriterFrame(first, { ...base, currentSubgoal: rename, constraints: [quote] }, [said]);
		expect(written.currentSubgoal).toBe(rename);
		expect(written.constraints.map(({ text }) => text)).toEqual([quote]);
		// No writer identified a separate action: the trailing words could instead qualify the limit.
		const fallback = ruleUpdate(first, said);
		expect(fallback.constraints).toEqual([]);
		expect(fallback.openQuestions.join(" ")).toContain(said.text);
	});

	it("does not turn an unquoted or paraphrased mixed message into an enforceable limit", () => {
		const said = {
			text: `${rename} Keep this pass free of fixture edits.`,
			turn: 2,
			change: "correction" as const,
			limit: { kind: "add" as const },
		};
		for (const frame of [
			ruleUpdate(first, said),
			mergeWriterFrame(first, { ...base, constraints: ["Do not edit the fixture"] }, [said]),
		]) {
			expect(frame.constraints).toEqual([]);
			expect(frame.openQuestions.join("\n")).toContain(said.text);
		}
	});
	it.each([
		"During review, do not edit the glossary, but typo fixes are fine.",
		"Keep the API stable, but additions are fine.",
		"构建时只能修改文档，但示例除外。",
	])("keeps the complete writer-selected limit regardless of how the work is summarized: %s", (rule) => {
		const said = { text: `${rule} ${rename}`, turn: 2, change: "subgoal", limit: { kind: "add" } } as const;
		for (const currentSubgoal of [rename, "Uppercase the notes filename.", undefined]) {
			const merged = mergeWriterFrame(first, { ...base, constraints: [rule], currentSubgoal }, [said]);
			expect(merged.constraints.map(({ text }) => text)).toEqual([rule]);
		}
	});

	it("keeps both directives under the user's original generated-files restriction", () => {
		const rule = "For generated files only, do not change the timestamps and do not change the mode.";
		const said = { text: `Fix the links. ${rule}`, turn: 2, change: "subgoal", limit: { kind: "add" } } as const;
		for (const frame of [
			ruleUpdate(first, said),
			mergeWriterFrame(first, { ...base, constraints: [rule], currentSubgoal: "Repair broken links." }, [said]),
		]) {
			expect(frame.constraints.map(({ text }) => text)).toEqual([rule]);
		}
	});

	it("does not detach a prohibition from its leading scope or trailing exception", () => {
		const scoped = "For the review only, inspect the file but do not edit it, but typo fixes are fine.";
		const said = { text: `${rename} ${scoped}`, turn: 2, change: "subgoal", limit: { kind: "add" } } as const;
		for (const frame of [
			ruleUpdate(first, said),
			mergeWriterFrame(first, { ...base, constraints: ["do not edit it"] }, [said]),
		]) {
			expect(frame.constraints.every(({ text }) => text === scoped)).toBe(true);
			if (!frame.constraints.length) expect(frame.openQuestions.join(" ")).toContain(scoped);
		}
	});

	it.each([
		[
			"Rename the file if the tests pass and keep the API unchanged.",
			"keep the API unchanged.",
			"Rename the file if the tests pass",
		],
		["重命名后不要再改 `AGENTS.md`。", "不要再改 `AGENTS.md`。", "把文件名改成大写。"],
	])("does not promote a fragment that omits its condition: %s", (text, fragment, currentSubgoal) => {
		const said = { text, turn: 2, change: "subgoal", limit: { kind: "add" } } as const;
		const withPartial = mergeWriterFrame(first, { ...base, constraints: [fragment], currentSubgoal }, [said]);
		expect(withPartial.constraints.every((rule) => rule.text === text)).toBe(true);
		const withFull = mergeWriterFrame(first, { ...base, constraints: [text], currentSubgoal }, [said]);
		expect(withFull.constraints.map((rule) => rule.text)).toEqual([text]);
	});

	it.each([
		["Do not edit the glossary.", "\n\nFix typos if needed."],
		["Keep the public API unchanged.", " Experimental methods are exempt."],
	])("retains an omitted or reworded cross-sentence exception in a mixed turn: %s", (rule, exception) => {
		const said = {
			text: `${rename} ${rule}${exception}`,
			turn: 2,
			change: "subgoal",
			limit: { kind: "add" },
		} as const;
		for (const frame of [
			ruleUpdate(first, said),
			...[[], [rule], [rule, "The exception is allowed."]].map((constraints) =>
				mergeWriterFrame(first, { ...base, constraints, currentSubgoal: rename }, [said]),
			),
		]) {
			expect(frame.currentSubgoal).toBe(rename);
			expect(frame.constraints.map(({ text }) => text)).toEqual([rule + exception]);
		}
	});

	it("does not infer a limit from an incidental fact or instruction in a mixed turn", () => {
		const fact = "Only one test fails.";
		const work = "Keep checking the logs.";
		const said = {
			text: `${rename} ${fact} ${work} ${fixtureRule}`,
			turn: 2,
			change: "subgoal",
			limit: { kind: "add" },
		} as const;
		for (const frame of [
			ruleUpdate(first, said),
			mergeWriterFrame(first, { ...base, constraints: [fixtureRule] }, [said]),
		])
			expect(frame.constraints.map(({ text }) => text)).toEqual([fixtureRule]);

		const trailing = { ...said, text: `${rename} ${fixtureRule} ${fact}` };
		for (const frame of [
			ruleUpdate(first, trailing),
			mergeWriterFrame(first, { ...base, constraints: [fixtureRule] }, [trailing]),
		])
			expect(frame.constraints.every(({ text }) => !text.includes(fact))).toBe(true);
	});

	it("uses exact boundaries for other corrections that keep the plan but skip part of it", () => {
		const rule = "跳过截图更新。";
		const said = {
			text: `继续完善安装指南，但是${rule}`,
			turn: 2,
			change: "correction",
			limit: { kind: "add" },
		} as const;
		const next = mergeWriterFrame(first, { ...base, currentSubgoal: "完善安装指南。", constraints: [rule] }, [said]);
		expect(next.constraints.map(({ text }) => text)).toEqual([rule]);
	});

	it("recovers the original PRD sentence for the paraphrasing writer from HEAD without selecting adjacent work", () => {
		const said = {
			text: `这个方案可以。${PRD_EXAMPLE}。另外记得跑测试。`,
			turn: 3,
			entryId: "e3",
			change: "correction",
			limit: { kind: "add" },
		} as const;
		const merged = mergeWriterFrame(first, { ...base, constraints: ["不要修改数据库"] }, [said]);
		expect(merged.constraints).toEqual([{ text: `${PRD_EXAMPLE}。`, source: { turn: 3, entryId: "e3" } }]);
		const work = { ...said, text: "更新数据库。然后跑测试。" };
		expect(mergeWriterFrame(first, { ...base, constraints: ["不要修改数据库"] }, [work]).constraints).toEqual([]);
	});

	it("retrying a failed mixed add can still record a writer-identified sibling", () => {
		const keep = "Keep the filename uppercase.";
		const said = {
			text: `${rename} ${keep} ${fixtureRule}`,
			turn: 3,
			change: "subgoal",
			limit: { kind: "add" },
			withdrawnQuoteIds: [id],
		} as const;
		const merged = mergeWriterFrame(first, { ...base, constraints: [keep, fixtureRule], currentSubgoal: rename }, [
			said,
		]);
		expect(merged.constraints.map(({ text }) => text)).toEqual([keep]);
	});

	it.each(["new_task", "subgoal"] as const)(
		"keeps fallback work on a %s with a simultaneous targeted change",
		(change) => {
			for (const kind of ["withdraw", "replace"] as const) {
				const text =
					kind === "withdraw"
						? "Drop the fixture rule and fix the CSS."
						: "Fix the CSS and replace the fixture rule with: Never publish CSS.";
				const frame = ruleUpdate(withItems(legacy, "pagination works"), {
					text,
					change,
					turn: 3,
					limit: { kind, id },
				});
				expect(change === "new_task" ? frame.goal : frame.currentSubgoal).toMatch(/fix the CSS/i);
				expect(frame.acceptance).toHaveLength(change === "new_task" ? 0 : 1);
			}
		},
	);

	it("switches tasks and withdraws a named limit without dropping the new work", () => {
		const goal = "Fix the CSS for the header.";
		const said = {
			text: `Lift the fixture rule. ${goal}`,
			turn: 3,
			change: "new_task",
			limit: { kind: "withdraw", id },
		} as const;
		const previous = withItems(legacy, "pagination works");
		const written = mergeWriterFrame(previous, { ...base, goal, constraints: [fixtureRule] }, [said]);
		expect(written.goal).toBe(goal);
		for (const frame of [written, ruleUpdate(previous, said)]) {
			expect(frame.goal).toContain(goal);
			expect(frame.acceptance).toEqual([]);
			expect(frame.constraints).toEqual([legacy.constraints[0]]);
		}
	});

	it("allow_once is not a frame mutation or a durable grant, even on a failed work update", () => {
		const said: UnmergedText = {
			text: rename,
			change: "subgoal",
			limit: { kind: "allow_once", id },
			turn: 2,
			reason: "failed",
		};
		const entry = frameEntry({ frame: legacy, unmerged: [said] }, "stale");
		expect(JSON.stringify(entry)).not.toContain("allow_once");
		expect(parseFrameEntry(entry)?.unmerged[0]).toMatchObject({ change: "subgoal", text: rename });
		for (const frame of [
			ruleUpdate(legacy, said),
			mergeWriterFrame(legacy, { ...base, constraints: [rename], currentSubgoal: rename }, [said]),
		]) {
			expect(frame.constraints).toEqual(legacy.constraints);
			expect(frame.currentSubgoal).toBe(rename);
		}
	});

	it("displays one stable ID per legacy quote and removes only that ID", () => {
		const text = describeFrame({ frame: legacy, unmerged: [] });
		expect(text.split(id)).toHaveLength(2);
		expect(id).toMatch(/^[a-f0-9]{64}$/);
		expect(constraintId(`${fixtureRule} Except the old copy.`)).not.toBe(id);
		expect(removeConstraint(legacy, id.slice(0, 8))).toBe(legacy);
		const removed = removeConstraint(legacy, id);
		expect(removed.constraints).toEqual([legacy.constraints[0]]);
		expect(removed.version).toBe(legacy.version);
		expect(legacy.constraints).toHaveLength(3);
	});

	it("withdraws exactly one rule with no writer, with a forgetful writer, or on retry after a failure", () => {
		const said: UnmergedText = {
			text: `${rename} I'm lifting the ban on editing the fixture.`,
			turn: 2,
			change: "subgoal",
			limit: { kind: "withdraw", id },
			reason: "failed",
		};
		const fallback = ruleUpdate(legacy, said);
		expect(fallback.currentSubgoal).toContain(rename);
		const written = mergeWriterFrame(legacy, { ...base, currentSubgoal: rename, constraints: [fixtureRule] }, [said]);
		expect(written.currentSubgoal).toBe(rename);
		for (const frame of [fallback, written]) expect(frame.constraints).toEqual([legacy.constraints[0]]);

		const entry = frameEntry({ frame: legacy, unmerged: [said] }, "stale");
		const state = parseFrameEntry(JSON.parse(JSON.stringify(entry)));
		expect(state?.unmerged).toEqual([said]);
		if (!state?.frame) throw new Error("frame was not restored");
		expect(compactFrame(state)?.constraints).toEqual([publishRule]);
		const alreadyRemoved = removeConstraint(state.frame, id);
		expect(mergeWriterFrame(alreadyRemoved, base, state.unmerged).constraints).toEqual([legacy.constraints[0]]);
	});

	it("replaces one target with a different exact limit; invalid quotes never remove it", () => {
		const newRule = "Do not edit generated fixtures.";
		const said = {
			text: `Replace the fixture rule with: ${newRule}`,
			turn: 2,
			limit: { kind: "replace", id } as const,
		};
		const rules = ruleUpdate(legacy, said);
		const written = mergeWriterFrame(legacy, { ...base, constraints: [newRule] }, [said]);
		for (const frame of [rules, written]) {
			expect(frame.constraints).toEqual([legacy.constraints[0], { text: newRule, source: { turn: 2 } }]);
		}
		for (const constraints of [[], ["Avoid the generated fixtures"], [said.text]]) {
			const unresolved = mergeWriterFrame(legacy, { ...base, constraints }, [said]);
			expect(unresolved.constraints).toEqual(legacy.constraints);
			expect(unresolved.openQuestions.join("\n")).toContain(said.text);
		}
	});

	it("withdrawing a pending replacement does not restore the original rule", () => {
		const rule = "Do not edit generated fixtures.";
		const replacement = `${rule}\n\nYou can still remove obsolete entries.`;
		const said: UnmergedText = {
			text: `Replace the fixture rule with: ${replacement}`,
			turn: 2,
			limit: { kind: "replace", id },
			reason: "failed",
		};
		const pending: FrameState = { frame: legacy, unmerged: [said] };
		expect(compactFrame(pending)?.constraints).toEqual([publishRule, replacement.replace(/\s+/g, " ")]);
		expect(pending.frame?.constraints).toEqual(legacy.constraints);

		const withdrawn = { ...said, withdrawnQuoteIds: [constraintId(replacement)] };
		const restored = parseFrameEntry(frameEntry({ frame: legacy, unmerged: [withdrawn] }, "updated"));
		if (!restored?.frame) throw new Error("missing stored frame");
		expect(compactFrame(restored)?.constraints).toEqual([publishRule]);
		expect(ruleUpdate(restored.frame, restored.unmerged[0]).constraints).toEqual([legacy.constraints[0]]);
		for (const constraints of [[replacement], [], [rule]]) {
			const merged = mergeWriterFrame(restored.frame, { ...base, constraints }, restored.unmerged);
			expect(merged.constraints).toEqual([legacy.constraints[0]]);
		}

		// A withdrawal of some other quote is not evidence that this replacement was valid.
		const unrelated = { ...said, withdrawnQuoteIds: [constraintId(publishRule)] };
		expect(mergeWriterFrame(legacy, base, [unrelated]).constraints).toEqual(legacy.constraints);
	});

	it("does not drop a replacement rule's follow-up exception", () => {
		const rule = "Do not edit generated fixtures.";
		const exception = " You can still remove obsolete entries.";
		const said = {
			text: `Replace the fixture rule with: ${rule}${exception}`,
			turn: 2,
			limit: { kind: "replace", id },
		} as const;
		const written = mergeWriterFrame(legacy, { ...base, constraints: [rule, "Obsolete entries can be deleted."] }, [
			said,
		]);
		for (const frame of [written, ruleUpdate(legacy, said)]) {
			expect(frame.constraints).toEqual([legacy.constraints[0], { text: rule + exception, source: { turn: 2 } }]);
		}
	});

	it.each([fixtureRule, "Keep the public API unchanged. Experimental methods are exempt."])(
		"recovers a genuine failed v1 constraint with its entry id, in projection and retry: %s",
		(text) => {
			const stored = {
				schema: 1,
				frame: first,
				unmerged: [{ text, change: "constraint", entryId: "e3", turn: 3, reason: "failed" }],
			};
			const state = parseFrameEntry(stored);
			if (!state?.frame) throw new Error("missing v1 frame");
			expect(compactFrame(state)?.constraints).toEqual([text]);
			expect(mergeWriterFrame(state.frame, base, state.unmerged).constraints).toEqual([
				{ text, source: { turn: 3, entryId: "e3" } },
			]);
		},
	);

	it("does not interpret a persisted v1 one-time rename as authorization for a new rule", () => {
		const entry = frameEntry(
			{
				frame: legacy,
				unmerged: [{ text: rename, turn: 2, entryId: "e2", change: "constraint", reason: "failed" }],
			},
			"stale",
		);
		const restored = parseFrameEntry({ ...entry, schema: 1 });
		expect(restored?.frame).toEqual(legacy);
		expect(compactFrame(restored ?? { unmerged: [] })?.constraints).not.toContain(rename);
	});
});

describe("task frame writer contract", () => {
	const reply = (value: unknown) => JSON.stringify(value);
	const base = { goal: first.goal, constraints: [], current_subgoal: null, acceptance: [], open_questions: [] };

	it("shows the writer the frame and how the judge read the message", () => {
		const request = writerRequest(first, [{ text: PRD_EXAMPLE, turn: 3, change: "correction" }]);
		expect(request.system).toContain("WORD FOR WORD");
		expect(request.user).toContain('"goal": "Add pagination to the users API"');
		expect(request.user).toContain(`turn 3, work: correction, limit: none):\n${PRD_EXAMPLE}`);
	});

	it("parses a fenced reply and refuses everything malformed", () => {
		const parsed = parseWriterReply(
			`\`\`\`json\n${reply({ ...base, acceptance: ["a", { id: "a1", text: "b" }] })}\n\`\`\``,
		);
		expect(parsed).toEqual({
			ok: true,
			value: {
				goal: first.goal,
				constraints: [],
				currentSubgoal: undefined,
				acceptance: [{ text: "a" }, { id: "a1", text: "b" }],
				openQuestions: [],
			},
		});
		for (const bad of [
			"I updated the frame.",
			'{"goal": "x", "constraints": [',
			reply({ ...base, goal: "  " }),
			reply({ ...base, constraints: "none" }),
			reply({ ...base, constraints: [1] }),
			reply({ ...base, current_subgoal: 4 }),
			reply({ ...base, acceptance: [{ id: "a1" }] }),
			reply({ ...base, acceptance: [{ id: 3, text: "x" }] }),
			reply({ goal: "x", constraints: [], acceptance: [] }),
		]) {
			expect(parseWriterReply(bad).ok, bad).toBe(false);
		}
	});

	it("finds the user's words despite line breaks, quotes and a final full stop, and nothing else", () => {
		const said = "Looks good.\nKeep the public  API\nas it is, please.";
		expect(findVerbatim(said, '"Keep the public API as it is."')).toBe("Keep the public  API\nas it is");
		expect(findVerbatim(said, "Do not change the public API")).toBeUndefined();
		expect(findVerbatim(PRD_EXAMPLE, "取消数据库变更。")).toBe("取消数据库变更");
		expect(limitClauses("Use v2.1 of src/a.ts. Then run it!\n好的。先别改")).toEqual([
			"Use v2.1 of src/a.ts.",
			"Then run it!",
			"好的。",
			"先别改",
		]);
	});

	it("stores the user's complete verbatim limit, not the writer's spelling or a fragment", () => {
		const text = "Do not edit the fixture, but only if\nthe test fails.";
		const said = [{ text, turn: 2, entryId: "e2", limit: { kind: "add" } as const }];
		const quotes = [
			"Do not edit the fixture",
			"edit the fixture",
			'"Do not edit the fixture, but only if the test fails."',
		];
		const merged = mergeWriterFrame(
			first,
			{ goal: "Writer changed the goal", constraints: quotes, acceptance: [], openQuestions: [] },
			said,
		);
		expect(merged.goal).toBe(first.goal);
		expect(merged.constraints).toEqual([{ text, source: { turn: 2, entryId: "e2" } }]);
		expect(merged.openQuestions).toEqual([]);
	});

	it("preserves constraints on all work changes, and preserves checklist retention on a subgoal", () => {
		const frame = ruleUpdate(withItems(first, "tests pass", "docs updated"), {
			text: "never commit without asking",
			turn: 2,
			limit: { kind: "add" },
		});
		const ticked = tickItem(frame, "a1", "12 passed", "model");
		if ("error" in ticked) throw new Error(ticked.error);
		const forgetful = { goal: frame.goal, constraints: [], acceptance: [], openQuestions: [] };

		const subgoal = mergeWriterFrame(ticked.frame, { ...forgetful, currentSubgoal: "the SQL query" }, [
			{ text: "start with the SQL query", turn: 3, change: "subgoal" },
		]);
		expect(subgoal.constraints.map((constraint) => constraint.text)).toEqual(["never commit without asking"]);
		expect(subgoal.acceptance.map((item) => [item.id, item.done])).toEqual([
			["a1", true],
			["a2", false],
		]);
		expect(subgoal.currentSubgoal).toBe("the SQL query");

		const replaced = mergeWriterFrame(ticked.frame, { ...forgetful, goal: "Fix the header CSS" }, [
			{ text: "forget that, fix the header CSS", turn: 3, change: "new_task" },
		]);
		expect(replaced.constraints).toEqual(ticked.frame.constraints);
		expect(replaced.acceptance).toEqual([]);
	});

	it("keeps ticks on items the writer kept, resets a reworded one, and numbers new ones onwards", () => {
		const ticked = tickItem(withItems(first, "tests pass", "docs updated"), "a1", "12 passed", "model");
		if ("error" in ticked) throw new Error(ticked.error);
		const redone = tickItem(ticked.frame, "a2", "README changed", "model");
		if ("error" in redone) throw new Error(redone.error);
		const merged = mergeWriterFrame(
			redone.frame,
			{
				goal: first.goal,
				constraints: [],
				acceptance: [
					{ id: "a1", text: "tests pass" },
					{ id: "a2", text: "docs and changelog updated" },
					{ text: "cursor is opaque" },
					{ id: "a7", text: "limit is capped at 100" },
				],
				openQuestions: [],
			},
			[{ text: "also make the cursor opaque", turn: 4, change: "subgoal" }],
		);
		expect(merged.acceptance).toEqual([
			{ id: "a1", text: "tests pass", done: true, doneBy: "model", evidence: "12 passed", addedBy: "model" },
			{ id: "a2", text: "docs and changelog updated", done: false, addedBy: "model" },
			{ id: "a3", text: "cursor is opaque", done: false, addedBy: "writer" },
			{ id: "a4", text: "limit is capped at 100", done: false, addedBy: "writer" },
		]);
		expect(merged.nextItem).toBe(5);
	});
});
