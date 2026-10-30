import { defineDecision } from "../decision.ts";
import type { NoteKind, Relation } from "../hive/board.ts";
import { pickChoice, threeZone } from "../policy.ts";

/**
 * H1/H2, the hive's two gates. Bees work in separate context windows, which
 * is what lets a hard problem be attacked from several sides at once, and
 * also why swarms duplicate work and contradict each other: nothing one bee
 * learns reaches the others. Sharing everything floods every context; letting
 * each bee's main model decide what to share is slow, costly, and forgotten.
 *
 * So the judge does it, once per step, like the judges of a waggle dance:
 * H1 decides whether what a bee just said or saw is news for the hive, and
 * H2 decides, per bee, whether a piece of news matters to what that bee is doing.
 */
export interface PublishInput {
	readonly goal: string;
	/** What this bee was asked to look into. */
	readonly focus: string;
	/** Word for word what the bee said, or the beginning of what a tool returned. */
	readonly note: string;
	readonly source: string;
}

export type PublishOutcome = { readonly publish: boolean; readonly kind: NoteKind | null; readonly score: number };

export const hivePublish = defineDecision({
	id: "hive.publish",
	version: 1,
	cacheImpact: "none",
	latency: "background",
	capabilities: { share_worthy: "relate", kind: "classify" },
	questions: {
		share_worthy: {
			type: "boolean",
			instructions: "Would `note` help other workers on `goal` who have not seen it?",
		},
		kind: {
			type: "choice",
			instructions: "What is `note`?",
			criteria: {
				finding: "A fact discovered about the problem",
				dead_end: "An approach that failed or was ruled out",
				decision: "A choice made that the other workers must respect",
				blocker: "Something that stops progress",
				other: "Routine progress or something else",
			},
		},
	},
	buildState(input: PublishInput) {
		return { note: input.note, source: input.source, goal: input.goal, this_worker_focus: input.focus };
	},
	policy(answers): PublishOutcome {
		const kind = answers.kind.choice === "other" ? null : (answers.kind.choice as NoteKind);
		const worthy = threeZone(answers.share_worthy) === "yes";
		// Routine progress is not news, however relevant it sounds.
		return { publish: worthy && kind !== null, kind, score: answers.share_worthy.probability };
	},
	fallback(): PublishOutcome {
		return { publish: false, kind: null, score: 0 };
	},
});

export interface DeliverInput {
	/** What the receiving bee is working on. */
	readonly focus: string;
	readonly note: string;
	readonly kind: NoteKind;
	readonly from: string;
}

export type DeliverOutcome = { readonly deliver: boolean; readonly score: number };

export const hiveDeliver = defineDecision({
	id: "hive.deliver",
	// 2: the fallback delivers. 3: so does an unsure answer; only a confident no holds a note back.
	version: 3,
	// A delivered note is appended to the receiving bee's context, nothing before it changes.
	cacheImpact: "append-only",
	latency: "background",
	capabilities: "relate",
	questions: {
		useful: { type: "boolean", instructions: "Is `note` useful for the work described in `focus`?" },
	},
	buildState(input: DeliverInput) {
		return { note: input.note, focus: input.focus, note_kind: input.kind, from_worker: input.from };
	},
	policy(answers, input): DeliverOutcome {
		// A decision binds everyone, whatever they are working on. That takes no judgment.
		if (input.kind === "decision") return { deliver: true, score: 1 };
		// The note goes unless the judge is sure it is of no use to this bee. A note the bee did not need costs it a
		// line; one it needed and never heard costs it the work of finding it again, or a wrong turn. The judge is
		// rarely sure either way about a note from a bee on the same problem, and holding back every unsure one
		// delivered fewer of the notes the bees needed than asking no judge at all (the fallback below). The delivery
		// cap still bounds what a bee hears.
		return { deliver: threeZone(answers.useful) !== "no", score: answers.useful.probability };
	},
	// Without a judge every note goes to every bee, up to the delivery cap: they all work on one problem, and a
	// hive whose bees hear nothing from each other is only isolated sub-agents (51 of 58 notes were delivered when
	// the judge was asked).
	fallback(): DeliverOutcome {
		return { deliver: true, score: 0 };
	},
});

export interface RelateInput {
	readonly goal: string;
	readonly earlier: { readonly bee: string; readonly kind: NoteKind; readonly text: string };
	readonly later: { readonly bee: string; readonly kind: NoteKind; readonly text: string };
}

export type RelateOutcome = { readonly relation: Relation | null; readonly score: number };

/**
 * How sure the judge must be that one investigator's note replaces another's. Calibrated 2026-09-24 on 153
 * hand-labelled note pairs from 11 real hives: across investigators no "supersedes" reading was right (0 of 6 at
 * the 0.6 bar, the highest at 0.87; the later note agreed and added, or was about something else), and each
 * one takes another bee's finding off the board and tells everyone who heard it that it no longer holds. A bee
 * revising its own note is routine and keeps the common bar (5 of 12 right there).
 */
const ACROSS_BEES_SUPERSEDES = 0.9;

/**
 * H3, the board's memory. A board that only grows keeps a conclusion after
 * it stopped being true: "the tests cannot run" stays up next to "they run
 * once the inherited env is cleared", and whoever heard the first keeps
 * acting on it. So every note that passes H1 is held against the earlier
 * notes it shares words with, and the judge says what it does to each of
 * them. It never says who is right: a note that contradicts another without
 * explaining it away leaves both standing, for a worker to settle.
 */
export const hiveRelate = defineDecision({
	id: "hive.relate",
	version: 2,
	cacheImpact: "none",
	latency: "background",
	capabilities: "classify",
	questions: {
		relation: {
			type: "choice",
			instructions: "`earlier` was posted first, `later` after it. What does `later` say about `earlier`?",
			criteria: {
				supersedes:
					"`later` corrects or replaces `earlier`: the situation `earlier` describes has changed or was mistaken, and `later` says why (an environment that was fixed, a cause that was ruled out, a newer measurement)",
				contradicts:
					"`later` states the opposite of `earlier` and does not explain `earlier` away: both stand as reported and cannot both be true",
				supports: "`later` confirms `earlier` or adds evidence for it",
				none: "`later` is about something else, or neither adds to nor takes from `earlier`",
			},
		},
	},
	buildState(input: RelateInput) {
		return {
			goal: input.goal,
			earlier: `${input.earlier.bee} (${input.earlier.kind}): ${input.earlier.text}`,
			later: `${input.later.bee} (${input.later.kind}): ${input.later.text}`,
		};
	},
	policy(answers, input): RelateOutcome {
		const choice = pickChoice(answers.relation);
		const score = answers.relation.probabilities?.[answers.relation.choice] ?? 1;
		if (!choice) return { relation: null, score };
		const ownNote = input.earlier.bee === input.later.bee;
		// A worker that now says the opposite of what it said before has changed its mind: its later word
		// replaces its earlier one. Nobody votes on which of its own words to keep.
		if (choice === "contradicts" && ownNote) return { relation: "supersedes", score };
		if (choice === "supersedes" && !ownNote && score < ACROSS_BEES_SUPERSEDES) return { relation: null, score };
		return { relation: choice, score };
	},
	fallback(): RelateOutcome {
		return { relation: null, score: 0 };
	},
});
