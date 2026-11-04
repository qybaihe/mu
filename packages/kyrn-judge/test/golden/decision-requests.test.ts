import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DecisionEngine } from "../../src/decision.ts";
import type { JudgeCall, JudgeLike, JudgeResult } from "../../src/judge.ts";
import type { AnswersFor, Questions } from "../../src/types.ts";
import { GOLDEN_CASES } from "./decision-inputs.ts";

/**
 * What every decision asks the judge, kept in `decision-requests.md`: the state, the questions with their wording, and
 * what each question takes to answer, as the engine hands them to the judge. A change to any of them shows up there as
 * a diff in review, and a weekly upstream merge that changes what a judge reads cannot go unseen.
 *
 * A decision whose request changed must also change its `version`, so its ledger records are not mixed with those of
 * the old wording (mubench pins a commit for this reason). The test holds the file to that: a section that changed
 * under the same version fails, also with `-u`. Bump the version, then run the test with `-u` to write the file.
 * A change to a decision's policy alone does not show here and still needs its own bump.
 */
const GOLDEN = fileURLToPath(new URL("./decision-requests.md", import.meta.url));
const HEADING = /^## (\S+) v(\d+)$/;

/** Hands back no answers, and keeps what it was asked. */
class RecordingJudge implements JudgeLike {
	readonly id = "golden";
	call: JudgeCall<Questions> | undefined;

	async evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>> {
		this.call = request;
		return {
			answers: {} as AnswersFor<Qs>,
			usage: {},
			latencyMs: 0,
			requests: 1,
			providerId: this.id,
			warnings: [],
		};
	}
}

interface Section {
	readonly id: string;
	readonly version: number;
	readonly body: string;
}

/** Each decision's section of the file, by id and by its place among the sections with that id. */
function sections(text: string): Map<string, Section> {
	const found = new Map<string, Section>();
	const seen = new Map<string, number>();
	let current: { id: string; version: number; lines: string[] } | undefined;
	const close = () => {
		if (!current) return;
		const nth = seen.get(current.id) ?? 0;
		seen.set(current.id, nth + 1);
		found.set(`${current.id}#${nth}`, {
			id: current.id,
			version: current.version,
			body: current.lines.join("\n").trim(),
		});
	};
	for (const line of text.split("\n")) {
		const heading = HEADING.exec(line);
		if (heading) {
			close();
			current = { id: heading[1], version: Number(heading[2]), lines: [] };
		} else current?.lines.push(line);
	}
	close();
	return found;
}

async function render(): Promise<string> {
	const parts = [
		"# What each decision asks the judge",
		"",
		"Written by `decision-requests.test.ts` from the inputs in `decision-inputs.ts`: the state, the questions and what",
		"each question takes to answer, as the decision engine hands them to the judge. Do not edit by hand. A section that",
		"changes needs a new `version` in its decision; then run the test with `-u`.",
	];
	for (const { spec, input } of GOLDEN_CASES) {
		const judge = new RecordingJudge();
		const engine = new DecisionEngine({ judge, defaultMode: "active", knownSecrets: () => [] });
		await engine.decide(spec, input);
		const asked = judge.call
			? { state: judge.call.state, questions: judge.call.questions, capabilities: judge.call.capabilities ?? null }
			: "(no questions for this input)";
		parts.push("", `## ${spec.id} v${spec.version}`, "", "```json", JSON.stringify(asked, null, "\t"), "```");
	}
	return `${parts.join("\n")}\n`;
}

describe("what the decisions ask the judge", () => {
	it("is as recorded, and a decision whose request changed has a new version", async () => {
		const rendered = await render();
		let recorded = "";
		try {
			recorded = readFileSync(GOLDEN, "utf8");
		} catch {
			// Not written yet: the snapshot below writes it.
		}
		const before = sections(recorded);
		const unbumped = [...sections(rendered)]
			.filter(([key, now]) => {
				const then = before.get(key);
				return then !== undefined && then.version === now.version && then.body !== now.body;
			})
			.map(([, now]) => `${now.id} v${now.version}`);
		expect(unbumped, "what these ask the judge changed: bump their version, then run with -u").toEqual([]);
		await expect(rendered).toMatchFileSnapshot(GOLDEN);
	});

	it("covers each decision once", () => {
		const specs = GOLDEN_CASES.map((golden) => golden.spec);
		expect(new Set(specs).size).toBe(specs.length);
	});
});
