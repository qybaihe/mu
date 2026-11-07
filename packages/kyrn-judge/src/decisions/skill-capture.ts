import { defineDecision } from "../decision.ts";
import { isEscapeOption } from "../policy.ts";

/**
 * After a long run that ended verified: was the work a procedure, one that the same steps would do again for another
 * task of its kind? Then a writer model drafts it as a skill, and the user decides whether to install it
 * (kyrn/docs/features/procedures.md). A lesson is one line for one situation; a skill is the whole sequence: the
 * commands, their order, and the checks that say it worked.
 *
 * The judge only judges. It reads the run's digest and the skills already installed, so a run that followed an
 * installed skill is not drafted again.
 */
export interface CaptureInput {
	/** The run: the request, its steps, the final message (memory/phrasing.ts `turnDigest`). */
	readonly turnDigest: string;
	/** Installed skills, name and description. */
	readonly skills: readonly { readonly name: string; readonly description: string }[];
}

export type CaptureVerdict = "draft" | "skip";

/**
 * How sure the judge has to be that the run is a procedure before a writer is paid to draft it. In the October
 * review, 3 of the 4 wrong drafts scored between .73 and .85, two of them from runs that failed their checks.
 */
export const DRAFT_AT = 0.9;

export const skillCapture = defineDecision({
	id: "skill.capture",
	version: 1,
	cacheImpact: "none",
	latency: "background",
	capabilities: "relate",
	questions: {
		kind: {
			type: "choice",
			instructions: "What is the work in `turn_digest`, given the `skills` already installed?",
			criteria: {
				procedure:
					"A procedure worth keeping: the same sequence of steps would do another task of this kind, in this project or another",
				one_off: "Work for this one task: a fix, an answer or a change that will not come up in this form again",
				covered: "Already covered by one of `skills`",
				unclear: "Cannot tell from what is here",
			},
		},
	},
	// The digest is the long field, so it goes last: a bounded-window judge cuts the tail.
	buildState(input: CaptureInput) {
		const skills =
			input.skills.length > 0
				? input.skills.map((skill) => `- ${skill.name}: ${skill.description.slice(0, 200)}`).join("\n")
				: "(none)";
		return { skills, turn_digest: input.turnDigest };
	},
	policy(answers): CaptureVerdict {
		const { choice, probabilities } = answers.kind;
		if (isEscapeOption(choice) || choice !== "procedure") return "skip";
		const p = probabilities?.[choice];
		return p === undefined || p >= DRAFT_AT ? "draft" : "skip";
	},
	fallback(): CaptureVerdict {
		return "skip";
	},
});
