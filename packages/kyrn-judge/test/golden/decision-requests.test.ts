import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DecisionEngine } from "../../src/decision.ts";
import { GOLDEN_CASES } from "./decision-inputs.ts";
import { RecordingJudge, unbumped } from "./golden-support.ts";

/**
 * What every decision asks the judge, kept in `decision-requests.md`: the state, the questions with their wording, and
 * what each question takes to answer, as the engine hands them to the judge. A change to any of them shows up there as
 * a diff in review, and a weekly upstream merge that changes what a judge reads cannot go unseen.
 *
 * A decision whose request changed must also change its `version`, so its ledger records are not mixed with those of
 * the old wording (mubench pins a commit for this reason). The test holds the file to that: a section that changed
 * under the same version fails, also with `-u`. Bump the version, then run the test with `-u` to write the file.
 * What a decision does with the answers is kept beside it, in `decision-policies.md`.
 */
const GOLDEN = fileURLToPath(new URL("./decision-requests.md", import.meta.url));

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
		expect(
			unbumped(recorded, rendered),
			"what these ask the judge changed: bump their version, then run with -u",
		).toEqual([]);
		await expect(rendered).toMatchFileSnapshot(GOLDEN);
	});

	it("covers each decision once", () => {
		const specs = GOLDEN_CASES.map((golden) => golden.spec);
		expect(new Set(specs).size).toBe(specs.length);
	});
});
