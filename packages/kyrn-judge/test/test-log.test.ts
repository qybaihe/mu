import { describe, expect, it } from "vitest";
import {
	anchorTerms,
	isTestLog,
	planTestLog,
	renderTestLog,
	segmentTestLog,
	type TestLogStrategy,
	type TestLogWording,
} from "../src/admission/test-log.ts";
import { DecisionEngine, type DecisionMode } from "../src/decision.ts";
import { JudgeError } from "../src/errors.ts";
import { Judge } from "../src/judge.ts";
import { MockJudgeProvider, type MockResponder } from "../src/providers/mock.ts";
import type { Answer, JudgeProvider } from "../src/types.ts";
import { edgeCases, logCases, type TestLogCase, testLogCases } from "./fixtures/test-log-cases.ts";

const ARCHIVE = "/tmp/kyrn-test/archive.txt";

/** Answers every question with the option or probability that authorizes an omission. */
const alwaysOmit: MockResponder = (request) =>
	Object.fromEntries(
		Object.entries(request.questions).map(([id, question]): [string, Answer] => {
			if (question.type !== "choice") throw new Error(`unexpected ${question.type} question`);
			const choice = "omit" in question.criteria ? "omit" : "not_needed";
			return [id, { type: "choice", choice, probabilities: { [choice]: 0.99 } }];
		}),
	);

function engineWith(provider: JudgeProvider, mode: DecisionMode = "active"): DecisionEngine {
	return new DecisionEngine({ judge: new Judge({ provider }), defaultMode: mode });
}

async function run(
	testCase: TestLogCase,
	strategy: TestLogStrategy,
	provider: JudgeProvider = new MockJudgeProvider(alwaysOmit),
	options: { mode?: DecisionMode; wording?: TestLogWording; anchors?: boolean; signal?: AbortSignal } = {},
) {
	const plan = await planTestLog(testCase, strategy, engineWith(provider, options.mode), options);
	return { plan, rendered: renderTestLog(plan, ARCHIVE) };
}

const byId = (id: string): TestLogCase => {
	const found = testLogCases.find((testCase) => testCase.id === id);
	if (!found) throw new Error(`no case ${id}`);
	return found;
};

describe("test-log segmentation", () => {
	it("rebuilds every log byte for byte, with ANSI codes and CRLF intact", () => {
		for (const testCase of testLogCases) {
			const units = segmentTestLog(testCase.output, anchorTerms(testCase.goal, testCase.intent));
			expect(units.map((unit) => unit.text).join(""), testCase.id).toBe(testCase.output);
			expect(
				units.reduce((sum, unit) => sum + unit.lines, 0),
				testCase.id,
			).toBe((testCase.output.match(/[^\n]*\n|[^\n]+$/g) ?? []).length);
		}
	});

	it("offers passing tests per file, captured output and repeats, and protects the rest", () => {
		const units = segmentTestLog(byId("vv-verdict-only").output);
		const candidates = units.filter((unit) => unit.kind !== "protected");
		expect(candidates.map((unit) => unit.kind)).toEqual([
			"output",
			"output",
			"repeat",
			"repeat",
			"pass",
			"pass",
			"pass",
		]);
		expect(candidates.map((unit) => unit.label)).toContain("passing tests (test/cache.test.ts)");
		// More than half of this log is status the parser recognizes.
		const offered = candidates.reduce((sum, unit) => sum + unit.text.length, 0);
		expect(offered / byId("vv-verdict-only").output.length).toBeGreaterThan(0.6);
	});

	it("protects the output of a failed test, the first of a repeated warning, and a slow test", () => {
		const units = segmentTestLog(byId("vv-verdict-only").output);
		const why = (needle: string) => units.find((unit) => unit.text.includes(needle));
		expect(why("exp=50 now=100")).toMatchObject({ kind: "protected", why: "failed-test" });
		expect(why("caches lookup a\nWARN cache directory")).toMatchObject({ kind: "protected", why: "signal" });
		expect(why("rebuilds the search index 430ms")).toMatchObject({ kind: "protected", why: "slow" });
	});

	it("reads a status line by its marker, not by words in the test name", () => {
		const units = segmentTestLog(byId("keyword-in-passing-name").output);
		const passing = units.find((unit) => unit.kind === "pass");
		expect(passing?.lines).toBe(4);
		expect(passing?.text).toContain("handles error responses without throwing");
		// A check mark inside a failure message or inside captured output is not a passing test.
		for (const id of ["failure-stack-with-checkmark", "checkmark-inside-captured-output"]) {
			expect(
				segmentTestLog(byId(id).output).filter((unit) => unit.kind === "pass"),
				id,
			).toEqual([]);
		}
	});

	it("keeps a TAP test point together with its diagnostics, and a failing one protected", () => {
		const units = segmentTestLog(byId("tap-debug-cjk").output);
		const passing = units.filter((unit) => unit.kind === "pass");
		expect(passing).toHaveLength(1);
		expect(passing[0].text).toContain("# Subtest: preserves number 29");
		expect(passing[0].text).toContain("duration_ms: 0.73675");
		expect(passing[0].text).not.toContain("not ok");
		expect(passing[0].text).not.toContain("keeps CJK characters");
	});

	it("treats a near-duplicate as new text", () => {
		const units = segmentTestLog(byId("warning-first-and-repeat").output);
		expect(units.filter((unit) => unit.kind === "repeat")).toEqual([]);
	});

	it("protects lines that mention an identifier or a quoted phrase from the goal", () => {
		expect(
			anchorTerms("Why does `pads minute 17` fail in test/format.test.ts?", "Check formatDate and PCT50."),
		).toEqual(expect.arrayContaining(["pads minute 17", "test/format.test.ts", "formatdate", "pct50"]));
		expect(anchorTerms("Find out why the login test fails.", "Run the session tests.")).toEqual([]);

		const output = byId("ansi-verdict").output;
		const anchored = segmentTestLog(output, ["pads minute 17 "]);
		const kept = anchored.find((unit) => unit.text.includes("pads minute 17"));
		expect(kept).toMatchObject({ kind: "protected", why: "anchor", lines: 1 });
		expect(anchored.filter((unit) => unit.kind === "pass")).toHaveLength(2);
	});

	it("recognizes runner output only", () => {
		expect(isTestLog("bash: npx vitest --run", " Test Files  1 passed (1)")).toBe(true);
		expect(isTestLog("bash: python -m pytest -q", "===== 3 passed in 0.12s =====")).toBe(true);
		expect(isTestLog("bash: node --test a.mjs", "ℹ tests 3")).toBe(true);
		expect(isTestLog("bash: cat notes.txt", " Test Files  1 passed (1)")).toBe(false);
		expect(isTestLog("bash: npm test", "compiled 12 files")).toBe(false);
	});
});

describe("test-log arms", () => {
	it("full returns every case untouched and asks nobody", async () => {
		for (const testCase of testLogCases) {
			const provider = new MockJudgeProvider(alwaysOmit);
			const { plan, rendered } = await run(testCase, "full", provider);
			expect(rendered.text, testCase.id).toBe(testCase.output);
			expect(rendered.applied).toBe(false);
			expect(plan.source).toBe("full");
			expect(provider.calls).toHaveLength(0);
		}
	});

	it("rules omit exact repeats without a judge and keep passing tests", async () => {
		const provider = new MockJudgeProvider(alwaysOmit);
		const { plan, rendered } = await run(byId("vv-verdict-only"), "rules", provider);
		expect(provider.calls).toHaveLength(0);
		expect(plan.source).toBe("rules");
		const kinds = plan.units.filter((unit) => plan.omitted.includes(unit.id)).map((unit) => unit.kind);
		expect(new Set(kinds)).toEqual(new Set(["repeat"]));
		// Eight repeated warnings are under a tenth of this log, so by default the original stays.
		expect(rendered.applied).toBe(false);
		const forced = renderTestLog(plan, ARCHIVE, { minNetChars: 0, minNetShare: 0 });
		expect(forced.applied).toBe(true);
		expect(forced.text).toContain("pads minute 17 0ms");
		expect(forced.text).toContain("stderr | test/cache.test.ts > cache > caches lookup a");
		expect(forced.text).not.toContain("stderr | test/cache.test.ts > cache > caches lookup b");
		expect(forced.text).toContain("[mu: omitted 18 lines: stderr repeating an earlier block]");
	});

	it("an always-omit judge cannot remove protected evidence from any case", async () => {
		for (const wording of ["suffices", "policy"] as const) {
			for (const testCase of testLogCases) {
				const { plan, rendered } = await run(testCase, "jev", new MockJudgeProvider(alwaysOmit), { wording });
				let from = 0;
				for (const unit of plan.units.filter((unit) => unit.kind === "protected")) {
					const at = rendered.text.indexOf(unit.text, from);
					expect(at, `${wording} ${testCase.id} ${unit.id}`).toBeGreaterThanOrEqual(0);
					from = at + unit.text.length;
				}
			}
		}
	});

	it("keeps what a failure needs even when the judge would omit everything", async () => {
		for (const id of [
			"vv-debug-expired-token",
			"vd-debug-snapshot",
			"tap-debug-cjk",
			"spec-debug-cjk",
			"py-debug-pct50",
			"injection-inside-candidate",
			"untrusted-log-text",
		]) {
			const { rendered } = await run(byId(id), "jev");
			for (const required of byId(id).required) expect(rendered.text, `${id}: ${required}`).toContain(required);
		}
	});

	it("omits what the judge is sure about and saves net of markers and pointer", async () => {
		const testCase = byId("vv-verdict-only");
		const { plan, rendered } = await run(testCase, "jev");
		expect(plan.source).toBe("judge");
		expect(rendered.applied).toBe(true);
		for (const required of testCase.required) expect(rendered.text).toContain(required);
		for (const optional of testCase.optional) expect(rendered.text).not.toContain(optional);
		expect(rendered.netSavedChars).toBe(testCase.output.length - rendered.text.length);
		expect(rendered.netSavedChars).toBeGreaterThan(testCase.output.length * 0.5);
		expect(rendered.omittedChars).toBeGreaterThan(rendered.netSavedChars);
		expect(rendered.text.match(/full output: /g)).toHaveLength(1);
		expect(rendered.text.trimEnd().endsWith(`full output: ${ARCHIVE}]`)).toBe(true);
		// Neighboring omissions share one marker.
		expect(rendered.text).toContain(
			"[mu: omitted 58 lines: passing tests (test/format.test.ts, …); passing tests (test/auth.test.ts)]",
		);
	});

	it("sends the judge the goal, the intent and the candidates, not the protected text", async () => {
		const provider = new MockJudgeProvider(alwaysOmit);
		const { plan } = await run(byId("vv-debug-expired-token"), "jev", provider);
		expect(provider.calls).toHaveLength(1);
		const state = provider.calls[0].state as Record<string, unknown>;
		expect(Object.keys(state)).toEqual(["goal", "intent", "call", "run", "candidates"]);
		expect(Object.keys(state.candidates as object)).toEqual(plan.asked);
		expect(Object.keys(provider.calls[0].questions)).toEqual(plan.asked);
		expect(String(state.run)).toContain("rejects an expired token");
		expect(JSON.stringify(state)).not.toContain("- Expected");
		expect(JSON.stringify(state).length).toBeLessThanOrEqual(14_000);
	});

	it("shows the judge the text of a candidate that is one long line", async () => {
		const dump = JSON.stringify({ rows: Array.from({ length: 300 }, (_, id) => ({ id, name: `row-${id}` })) });
		const testCase: TestLogCase = {
			id: "one-long-line",
			goal: "Make the rows test print less.",
			intent: "Run the rows test to see what it prints.",
			call: "bash: npx vitest --run src/rows.test.ts",
			output: [
				" RUN  v3.2.4 /repo",
				"",
				"stdout | src/rows.test.ts > rows > parses rows",
				dump,
				"",
				" ✓ src/rows.test.ts (1 test) 12ms",
				"",
				" Test Files  1 passed (1)",
				"      Tests  1 passed (1)",
				"",
			].join("\n"),
			required: [],
			optional: [],
		};
		const provider = new MockJudgeProvider(alwaysOmit);
		await run(testCase, "jev", provider);
		const candidates = (provider.calls[0].state as { candidates: Record<string, { text: string }> }).candidates;
		const view = Object.values(candidates).find((candidate) => candidate.text.includes("stdout | src/rows.test.ts"));
		// Cut at line ends, the view was the header and a marker: none of the 8,000 characters the judge could omit.
		expect(view?.text).toContain(dump.slice(0, 200));
		expect(view?.text).toContain(dump.slice(-150));
		expect(view?.text).toMatch(/\[\d+ more characters not shown\]/);
		expect(view?.text.length).toBeLessThanOrEqual(800);
	});

	it("ignores verdicts on ids it did not offer", async () => {
		const testCase = byId("vv-debug-expired-token");
		const protectedIds = segmentTestLog(testCase.output)
			.filter((unit) => unit.kind === "protected")
			.map((unit) => unit.id);
		const provider = new MockJudgeProvider(() =>
			Object.fromEntries(
				[...protectedIds, "part_999"].map((id): [string, Answer] => [
					id,
					{ type: "choice", choice: "not_needed", probabilities: { not_needed: 1 } },
				]),
			),
		);
		const { plan, rendered } = await run(testCase, "jev", provider);
		expect(plan.omitted).toEqual([]);
		expect(rendered.text).toBe(testCase.output);
	});

	it("keeps everything unless the verdict is sure and carries a number", async () => {
		const testCase = byId("vv-verdict-only");
		const answers: Record<string, Answer> = {
			unsure: { type: "choice", choice: "not_needed", probabilities: { not_needed: 0.89 } },
			noNumber: { type: "choice", choice: "not_needed" },
			unclear: { type: "choice", choice: "unclear", probabilities: { unclear: 0.99 } },
			needed: { type: "choice", choice: "needed", probabilities: { needed: 0.99 } },
		};
		for (const [name, answer] of Object.entries(answers)) {
			const provider = new MockJudgeProvider((request) =>
				Object.fromEntries(Object.keys(request.questions).map((id) => [id, answer])),
			);
			const { plan, rendered } = await run(testCase, "jev", provider);
			expect(plan.omitted, name).toEqual([]);
			expect(rendered.text, name).toBe(testCase.output);
		}
		// A provider that reports confidence instead of a distribution is accepted at the same bar.
		const confident = new MockJudgeProvider((request) =>
			Object.fromEntries(
				Object.keys(request.questions).map((id): [string, Answer] => [
					id,
					{ type: "choice", choice: "not_needed", confidence: 0.95 },
				]),
			),
		);
		expect((await run(testCase, "jev", confident)).plan.omitted.length).toBeGreaterThan(0);
		// The neutral mock answers every choice with its escape option.
		expect((await run(testCase, "jev", new MockJudgeProvider())).rendered.text).toBe(testCase.output);
	});

	it("keeps everything when the judge fails, the call is aborted, or the decision is off or in shadow", async () => {
		const testCase = byId("vv-verdict-only");
		const failing: JudgeProvider = {
			id: "failing",
			evaluate: async () => {
				throw new JudgeError("server", "boom");
			},
		};
		const failed = await run(testCase, "jev", failing);
		expect(failed.plan).toMatchObject({ source: "fallback", reason: "error:server", omitted: [] });
		expect(failed.rendered.text).toBe(testCase.output);

		const controller = new AbortController();
		controller.abort();
		const aborted = await run(testCase, "jev", new MockJudgeProvider(alwaysOmit), { signal: controller.signal });
		expect(aborted.plan).toMatchObject({ reason: "aborted", omitted: [] });

		const shadowProvider = new MockJudgeProvider(alwaysOmit);
		const shadow = await run(testCase, "jev", shadowProvider, { mode: "shadow" });
		expect(shadowProvider.calls).toHaveLength(1);
		expect(shadow.plan).toMatchObject({ source: "fallback", reason: "shadow", omitted: [] });
		expect(shadow.rendered.text).toBe(testCase.output);

		const offProvider = new MockJudgeProvider(alwaysOmit);
		const off = await run(testCase, "jev", offProvider, { mode: "off" });
		expect(offProvider.calls).toHaveLength(0);
		expect(off.rendered.text).toBe(testCase.output);
	});

	it("bypasses the judge without an intent, for a full-log request and for an unknown format", async () => {
		const testCase = byId("vv-verdict-only");
		const provider = new MockJudgeProvider(alwaysOmit);
		const expectBypass = async (changed: Partial<TestLogCase>, reason: string) => {
			const { plan, rendered } = await run({ ...testCase, ...changed }, "jev", provider);
			expect(plan.reason).toBe(reason);
			expect(rendered.text).toBe(changed.output ?? testCase.output);
		};
		await expectBypass({ intent: "  " }, "missing-intent");
		await expectBypass({ goal: "Paste the full log verbatim into the issue." }, "full-log-request");
		await expectBypass({ call: "bash: ./bin/check-widget --brief" }, "unsupported-log");
		await expectBypass(byId("unknown-runner-format"), "unsupported-log");
		await expectBypass(byId("failure-stack-with-checkmark"), "no-candidates");
		expect(provider.calls).toHaveLength(0);
	});

	it("asks about the largest candidates first and keeps what does not fit the budget", async () => {
		const blocks = Array.from(
			{ length: 40 },
			(_, index) =>
				`stdout | test/big.test.ts > case ${index}\n${`payload line for case ${index} `.repeat(20 + index)}\n\n ✓ test/big.test.ts > case ${index} 1ms\n × test/big.test.ts > broken ${index} 1ms\n`,
		).join("");
		const output = `${blocks}\n Test Files  1 failed (1)\n      Tests  40 failed | 40 passed (80)\n`;
		const provider = new MockJudgeProvider(alwaysOmit);
		const { plan } = await run(
			{
				id: "big",
				goal: "Why is it red?",
				intent: "Run it.",
				call: "npx vitest --run",
				output,
				required: [],
				optional: [],
			},
			"jev",
			provider,
		);
		const candidates = plan.units.filter((unit) => unit.kind !== "protected");
		expect(candidates.length).toBeGreaterThan(24);
		expect(plan.asked.length).toBeLessThanOrEqual(24);
		expect(JSON.stringify(provider.calls[0].state).length).toBeLessThanOrEqual(14_000);
		const smallestAsked = Math.min(
			...plan.asked.map((id) => candidates.find((unit) => unit.id === id)?.text.length ?? 0),
		);
		const largestSkipped = Math.max(
			...candidates.filter((unit) => !plan.asked.includes(unit.id)).map((unit) => unit.text.length),
		);
		expect(smallestAsked).toBeGreaterThanOrEqual(largestSkipped);
		expect(plan.omitted.every((id) => plan.asked.includes(id))).toBe(true);
	});
});

/**
 * The shape of real failing runs: a targeted run with the default reporter, where each failing
 * test prints the same DOM dump and the same stack again. Synthetic text, real structure.
 */
function repetitiveFailures(): string {
	const dom = Array.from(
		{ length: 14 },
		(_, n) => `    <div class="row row-${n}" data-testid="sider-item-${n}">item ${n}</div>\n`,
	).join("");
	const stack = Array.from(
		{ length: 7 },
		(_, n) => ` ❯ node_modules/@testing-library/dom/dist/query-helpers.js:${20 + n}:${5 + n}\n`,
	).join("");
	const element = `+   {\n+     "content": "hello from the fixture message, long enough that a single repeated element is already worth its own back-reference marker",\n+     "role": "user",\n+     "timestamp": 1,\n+     "kind": "message",\n+   },\n`;
	const failure = (name: string) =>
		` FAIL  test/sider.dom.test.tsx > sider > ${name}\nTestingLibraryElementError: Unable to find an element with the text: ${name}\n\n<body>\n${dom}</body>\n${stack}\n`;
	return [
		"\n RUN  v4.1.9 /tmp/synthetic\n\n",
		" ❯ test/sider.dom.test.tsx (4 tests | 3 failed) 40ms\n",
		"⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯\n\n",
		failure("shows the wordmark"),
		failure("links to the home route"),
		` FAIL  test/sider.dom.test.tsx > sider > lists every message\nAssertionError: expected [] to deeply equal [ …(5) ]\n\n- Expected\n+ Received\n\n${element.repeat(5)}\n`,
		" Test Files  1 failed (1)\n      Tests  3 failed | 1 passed (4)\n",
	].join("");
}

/** Puts the referenced lines of the full output back where a duplicate marker stands. */
function expandDuplicates(rendered: string, original: string): string {
	const source = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	let text = "";
	for (const line of rendered.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		const list = /^\[mu: omitted \d+ lines: identical to lines (.+) of the full output, kept above\]/.exec(line)?.[1];
		if (line.startsWith("[mu: ") && line.includes("full output: ")) continue;
		if (!list) {
			text += line;
			continue;
		}
		for (const ref of list.split(", ")) {
			const [, from, to, times] = /^(\d+)-(\d+)(?: ×(\d+))?$/.exec(ref) ?? [];
			text += source
				.slice(Number(from) - 1, Number(to))
				.join("")
				.repeat(Number(times ?? 1));
		}
	}
	return text;
}

describe("test-log duplicate runs", () => {
	const testCase: TestLogCase = {
		id: "repetitive-failures",
		goal: "Three sider tests fail. Find out why.",
		intent: "Run the sider tests to read the failures.",
		call: "bash: npx vitest --run test/sider.dom.test.tsx",
		output: repetitiveFailures(),
		required: [],
		optional: [],
	};

	it("omits a run that repeats kept text and says exactly which lines, in order and with counts", async () => {
		const provider = new MockJudgeProvider(alwaysOmit);
		const { plan, rendered } = await run(testCase, "rules", provider);
		expect(provider.calls).toHaveLength(0);
		const duplicates = plan.units.filter((unit) => unit.kind === "duplicate");
		// The second failure repeats the DOM dump and the stack; the third repeats one array element four times.
		expect(duplicates.map((unit) => unit.lines)).toEqual([25, 6, 6, 6, 6]);
		expect(new Set(duplicates.slice(1).map((unit) => unit.source?.join("-"))).size).toBe(1);
		expect(rendered.applied).toBe(true);
		expect(rendered.text.match(/×4 of the full output, kept above\]/g)).toHaveLength(1);
		// Every failure keeps its own header and message; only the repeated body goes.
		for (const name of ["shows the wordmark", "links to the home route", "lists every message"]) {
			expect(rendered.text).toContain(`FAIL  test/sider.dom.test.tsx > sider > ${name}`);
		}
		expect(rendered.text).toContain("Unable to find an element with the text: links to the home route");
		expect(rendered.text.match(/data-testid="sider-item-3"/g)).toHaveLength(1);
	});

	it("loses nothing: putting the referenced lines back restores the log byte for byte", async () => {
		const { plan, rendered } = await run(testCase, "rules");
		expect(expandDuplicates(rendered.text, testCase.output)).toBe(testCase.output);
		// A source is text that stays: never a line that was itself omitted.
		const omitted = new Set<number>();
		let line = 1;
		for (const unit of plan.units) {
			if (unit.kind === "duplicate") for (let n = 0; n < unit.lines; n++) omitted.add(line + n);
			line += unit.lines;
		}
		for (const unit of plan.units) {
			for (let n = unit.source?.[0] ?? 1; n <= (unit.source?.[1] ?? 0); n++) expect(omitted.has(n)).toBe(false);
		}
	});

	it("needs no judge when duplicates are all there is, and the judge arm omits them too", async () => {
		const provider = new MockJudgeProvider(alwaysOmit);
		const { plan, rendered } = await run(testCase, "jev", provider);
		expect(provider.calls).toHaveLength(0);
		expect(plan).toMatchObject({ source: "rules", reason: "no-judge-candidates", asked: [] });
		expect(rendered.text).toBe((await run(testCase, "rules")).rendered.text);
		// Shadow and a missing intent stop the judge, not the rule.
		expect((await run(testCase, "jev", provider, { mode: "shadow" })).rendered.applied).toBe(true);
		expect((await run({ ...testCase, intent: "" }, "jev", provider)).rendered.applied).toBe(true);
		// Someone who asks for the full log gets it.
		const verbatim = await run({ ...testCase, goal: "Paste the full log verbatim into the issue." }, "jev", provider);
		expect(verbatim.rendered.text).toBe(testCase.output);
	});

	it("leaves short repeats and repeated candidates alone", () => {
		const short = ` FAIL  a.test.ts > one\nError: boom\n ❯ a.test.ts:1:1\n ❯ b.ts:2:2\n\n FAIL  a.test.ts > two\nError: boom\n ❯ a.test.ts:1:1\n ❯ b.ts:2:2\n\n Tests  2 failed (2)\n`;
		expect(segmentTestLog(short).filter((unit) => unit.kind === "duplicate")).toEqual([]);
		// Passing lines are the judge's to decide, never a source and never a duplicate.
		const passing = ` ✓ test/a.test.ts > same name 0ms\n`.repeat(40);
		const kinds = new Set(segmentTestLog(`${passing}\n Tests  40 passed (40)\n`).map((unit) => unit.kind));
		expect(kinds.has("duplicate")).toBe(false);
	});
});

describe("test-log rendering", () => {
	it("returns the original when markers and pointer would eat the saving", async () => {
		// Short logs: whatever the judge says, there is nothing worth a pointer.
		for (const testCase of edgeCases) {
			const { rendered } = await run(testCase, "jev");
			expect(rendered.text, testCase.id).toBe(testCase.output);
			expect(rendered.applied, testCase.id).toBe(false);
		}
		const { plan } = await run(byId("vv-verdict-only"), "jev");
		expect(renderTestLog(plan, ARCHIVE, { minNetChars: 1_000_000 }).applied).toBe(false);
	});

	it("writes markers with the line ending of the log and never inside kept text", async () => {
		const lines = Array.from(
			{ length: 30 },
			(_, index) => `\u001b[32mok ${index + 1} - joins path segment number ${index + 1}\u001b[0m\r\n`,
		);
		const output = `TAP version 13\r\n${lines.join("")}1..30\r\n# tests 30\r\n\u001b[32m# pass 30\u001b[0m\r\n# fail 0\r\n`;
		const { rendered } = await run(
			{
				id: "crlf",
				goal: "Did it pass?",
				intent: "Run it.",
				call: "node --test a.mjs",
				output,
				required: [],
				optional: [],
			},
			"jev",
		);
		expect(rendered.applied).toBe(true);
		expect(rendered.text.replace(/\r\n/g, "")).not.toContain("\n");
		expect(rendered.text).toContain("TAP version 13\r\n[mu: omitted 30 lines: passing tests]\r\n1..30\r\n");
		expect(rendered.text).toContain("\u001b[32m# pass 30\u001b[0m\r\n");
	});

	it("every kept line is an original line, in order", async () => {
		for (const testCase of logCases) {
			const { rendered } = await run(testCase, "jev");
			const original: string[] = testCase.output.match(/[^\n]*\n|[^\n]+$/g) ?? [];
			let from = 0;
			for (const line of rendered.text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
				if (line.startsWith("[mu: ")) continue;
				const at = original.indexOf(line, from);
				expect(at, `${testCase.id}: ${line}`).toBeGreaterThanOrEqual(0);
				from = at + 1;
			}
		}
	});
});
