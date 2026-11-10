import { type TSchema, Type } from "typebox";

/**
 * Every custom entry and custom message kyrn writes into a session, with who writes it and who reads it. A session file
 * outlives the code that wrote it, and other programs read some of these: the desktop app shows judgments, goals,
 * checkpoints and permission modes from them, and `mu ledger` reads the judge's records and the user's answers. So an
 * entry another program reads has a schema here, and its `version` goes up whenever the schema changes;
 * `test/golden/entries.md` holds the schemas, and its test fails on a change without a new version.
 * `test/entries.test.ts` fails on a type written in `src` that is not listed here.
 */
export interface EntryType {
	readonly type: string;
	/**
	 * `entry`: `pi.appendEntry`, kept in the session file and never sent to the model. `message`: a custom message,
	 * which the model reads; the user sees it too when it is written with `display: true`.
	 */
	readonly kind: "entry" | "message";
	readonly version: number;
	/** The files that write it, from this package's folder. */
	readonly writers: readonly string[];
	/** What reads it besides its writers: another program, or another feature of kyrn. */
	readonly readers: readonly string[];
	readonly summary: string;
	/** What it holds, for an entry another program reads. Extra fields are allowed: a new optional field is additive. */
	readonly schema?: TSchema;
}

const DESKTOP_REDUCER = "desktop: nativeHost/reducer.ts";
const LEDGER_CLI = "mu ledger: kyrn/bin/kyrn-ledger";

const signals = {
	confidence: Type.Optional(Type.Number()),
	judge: Type.Optional(Type.String()),
};

/** A judge's answer to one question (`Answer` in types.ts). */
const AnswerSchema = Type.Union([
	Type.Object({ type: Type.Literal("boolean"), probability: Type.Number(), ...signals }),
	Type.Object({
		type: Type.Literal("choice"),
		choice: Type.String(),
		probabilities: Type.Optional(Type.Record(Type.String(), Type.Number())),
		...signals,
	}),
	Type.Object({
		type: Type.Literal("score"),
		score: Type.Number(),
		probabilities: Type.Optional(Type.Record(Type.String(), Type.Number())),
		...signals,
	}),
]);

/** `LedgerRecord` in ledger.ts. */
const DecisionSchema = Type.Object({
	id: Type.String(),
	timestamp: Type.String(),
	origin: Type.Optional(Type.Unknown()),
	specId: Type.String(),
	specVersion: Type.Number(),
	mode: Type.Union([Type.Literal("shadow"), Type.Literal("active")]),
	providerId: Type.String(),
	modelId: Type.Optional(Type.String()),
	outcome: Type.Unknown(),
	source: Type.Union([Type.Literal("judge"), Type.Literal("fallback")]),
	reason: Type.Optional(Type.String()),
	judged: Type.Optional(Type.Unknown()),
	answers: Type.Optional(Type.Record(Type.String(), AnswerSchema)),
	latencyMs: Type.Optional(Type.Number()),
	usage: Type.Optional(
		Type.Object({
			inputTokens: Type.Optional(Type.Number()),
			outputTokens: Type.Optional(Type.Number()),
			cachedInputTokens: Type.Optional(Type.Number()),
			cacheWriteTokens: Type.Optional(Type.Number()),
		}),
	),
	warnings: Type.Optional(
		Type.Array(
			Type.Object({
				type: Type.String(),
				message: Type.Optional(Type.String()),
				questionId: Type.Optional(Type.String()),
			}),
		),
	),
	tiers: Type.Optional(
		Type.Array(
			Type.Object({
				judgeId: Type.String(),
				asked: Type.Number(),
				kept: Type.Number(),
				latencyMs: Type.Optional(Type.Number()),
				error: Type.Optional(Type.String()),
			}),
		),
	),
	batch: Type.Optional(
		Type.Object({
			size: Type.Number(),
			failures: Type.Number(),
			answers: Type.Optional(Type.Array(Type.Union([Type.Record(Type.String(), AnswerSchema), Type.Null()]))),
			digests: Type.Optional(Type.Array(Type.String())),
		}),
	),
	stateDigest: Type.String(),
	state: Type.Optional(Type.Unknown()),
	questions: Type.Optional(Type.Unknown()),
});

const PermissionModeSchema = Type.Union([Type.Literal("full"), Type.Literal("judge"), Type.Literal("ask")]);

/**
 * `PermissionOutcome` and `JudgmentMark` in permissions.ts, `NudgeFollowed` in nudge-outcome.ts, `Refetched` in
 * recall.ts, `Returned` in warming.ts and `PreloadRead` in preload.ts.
 */
const OutcomeSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("permission"),
		toolCallId: Type.String(),
		tool: Type.String(),
		mode: PermissionModeSchema,
		reason: Type.Union(
			["ask", "unsure", "beyond", "unrelated", "flagged", "protected", "nojudge", "judgedown", "long"].map(
				(reason) => Type.Literal(reason),
			),
		),
		flagCode: Type.Optional(Type.String()),
		ledgerId: Type.Optional(Type.String()),
		specId: Type.Optional(Type.String()),
		judged: Type.Optional(Type.Unknown()),
		answer: Type.Union(
			["once", "session", "deny", "dismissed", "none", "timeout"].map((answer) => Type.Literal(answer)),
		),
		grant: Type.Optional(Type.String()),
		waitedMs: Type.Number(),
		outsideFloor: Type.Optional(Type.Literal(true)),
		late: Type.Optional(Type.Literal(true)),
	}),
	Type.Object({
		kind: Type.Literal("mark"),
		ledgerId: Type.String(),
		specId: Type.String(),
		specVersion: Type.Number(),
		judged: Type.Optional(Type.Unknown()),
		mark: Type.Literal("wrong"),
		note: Type.Optional(Type.String()),
	}),
	Type.Object({
		kind: Type.Literal("followed"),
		ledgerId: Type.String(),
		specId: Type.String(),
		judged: Type.Optional(Type.Unknown()),
		followed: Type.Union([Type.Literal("acted"), Type.Literal("ended")]),
		calls: Type.Number(),
	}),
	Type.Object({
		kind: Type.Literal("refetch"),
		source: Type.Union([Type.Literal("archive"), Type.Literal("page"), Type.Literal("session")]),
		tool: Type.String(),
		ledgerId: Type.Optional(Type.String()),
		specId: Type.Optional(Type.String()),
		chars: Type.Number(),
	}),
	Type.Object({
		kind: Type.Literal("returned"),
		ledgerId: Type.String(),
		specId: Type.String(),
		judged: Type.Optional(Type.Unknown()),
		afterMs: Type.Number(),
	}),
	Type.Object({
		kind: Type.Literal("preload"),
		ledgerId: Type.String(),
		specId: Type.String(),
		predicted: Type.Number(),
		given: Type.Number(),
		read: Type.Number(),
		hits: Type.Number(),
	}),
]);

/** `VerdictData` in preflight-view.ts. */
const VerdictSchema = Type.Object({
	version: Type.Literal(1),
	by: Type.String(),
	state: Type.Union(["applied", "shadow", "late", "none"].map((state) => Type.Literal(state))),
	turnType: Type.String(),
	gear: Type.Union(["chat", "light", "standard", "heavy"].map((gear) => Type.Literal(gear))),
	latencyMs: Type.Optional(Type.Number()),
	reason: Type.Optional(Type.String()),
	reasonCode: Type.Optional(Type.String()),
	reasonParams: Type.Optional(Type.Record(Type.String(), Type.Number())),
	thinking: Type.Optional(Type.Object({ from: Type.String(), to: Type.String() })),
	hints: Type.Array(Type.String()),
	hintIds: Type.Optional(Type.Array(Type.String())),
	answers: Type.Array(Type.Tuple([Type.String(), Type.String()])),
	answerValues: Type.Optional(Type.Record(Type.String(), AnswerSchema)),
});

/** `GoalState` in goal.ts. */
const GoalSchema = Type.Object({
	status: Type.Union(["active", "paused", "met", "cleared"].map((status) => Type.Literal(status))),
	text: Type.String(),
	reason: Type.Optional(Type.String()),
	reasonCode: Type.Optional(Type.String()),
	reasonParams: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]))),
	continuations: Type.Number(),
	next: Type.Optional(Type.String()),
	checkedBy: Type.Optional(Type.Union(["model", "jev", "rules"].map((by) => Type.Literal(by)))),
});

/** `CheckpointEntry` in checkpoint.ts. */
const CheckpointSchema = Type.Object({
	id: Type.Integer(),
	turn: Type.Number(),
	commit: Type.String(),
	entryId: Type.Optional(Type.String()),
	label: Type.String(),
	at: Type.Number(),
});

/** `SubagentSessionEntry` in swarm/sessions.ts. */
const SubagentSessionSchema = Type.Object({
	toolCallId: Type.String(),
	kind: Type.Union([Type.Literal("delegate"), Type.Literal("hive")]),
	name: Type.String(),
	session: Type.String(),
});

/** The drift check's reading (in shadow mode, what it would have said), or the loop rule's steer, in monitor.ts. */
const MonitorSchema = Type.Union([
	Type.Object({
		kind: Type.Union([Type.Literal("drift"), Type.Literal("loop")]),
		judged: Type.Literal(true),
		shadow: Type.Optional(Type.Literal(true)),
		content: Type.String(),
	}),
	Type.Object({
		kind: Type.Literal("loop"),
		action: Type.String(),
		times: Type.Number(),
		refused: Type.Optional(Type.Literal(true)),
	}),
]);

const features = (name: string) => `src/extension/features/${name}.ts`;

export const ENTRY_TYPES: readonly EntryType[] = [
	{
		type: "kyrn.decision",
		kind: "entry",
		version: 1,
		writers: ["src/extension/runtime.ts"],
		readers: [DESKTOP_REDUCER, LEDGER_CLI, `/ledger: ${features("commands")}`, "replay: src/providers/replay.ts"],
		summary: "One record of the judge's ledger: what a decision asked, the answers, what mu acted on.",
		schema: DecisionSchema,
	},
	{
		type: "kyrn.outcome",
		kind: "entry",
		version: 4,
		writers: [
			features("permissions"),
			features("commands"),
			features("nudge-outcome"),
			features("recall"),
			features("warming"),
			features("preload"),
		],
		readers: [DESKTOP_REDUCER, LEDGER_CLI, `/ledger: ${features("commands")}`],
		summary:
			"What became of a judgment: the user's answer to the question it sent them, their mark that it was wrong, what the agent did with the nudge it sent, a left-out part the model read back, when the user returned after a warming verdict, or what a conversation's opening read against what was forecast.",
		schema: OutcomeSchema,
	},
	{
		type: "kyrn.approval",
		kind: "message",
		version: 1,
		writers: [features("permissions")],
		readers: [],
		summary:
			"Tells the model what the user answered with /approve about calls whose permission question had waited out its time.",
	},
	{
		type: "kyrn.verdict",
		kind: "entry",
		version: 1,
		writers: [features("preflight")],
		readers: [DESKTOP_REDUCER],
		summary: "The preflight verdict on a user message, as the verdict line under it shows it.",
		schema: VerdictSchema,
	},
	{
		type: "kyrn.goal",
		kind: "entry",
		version: 1,
		writers: [features("goal")],
		readers: [DESKTOP_REDUCER],
		summary: "The goal of the conversation and where it stands; the latest on the branch holds.",
		schema: GoalSchema,
	},
	{
		type: "kyrn.goal",
		kind: "message",
		version: 1,
		writers: [features("goal")],
		readers: [],
		summary: "Sends the agent back to work towards the goal, or tells it the goal is paused or met.",
	},
	{
		type: "kyrn.checkpoint",
		kind: "entry",
		version: 1,
		writers: [features("checkpoint")],
		readers: [DESKTOP_REDUCER],
		summary:
			"A checkpoint taken before the first change of a user turn: the snapshot commit and the message it goes back to.",
		schema: CheckpointSchema,
	},
	{
		type: "mu.permissions",
		kind: "entry",
		version: 1,
		writers: [features("permissions")],
		readers: ["desktop: nativeHost/settings.ts"],
		summary:
			"The conversation's permission mode after a switch; the latest on the branch holds when it is opened again.",
		schema: Type.Object({ mode: PermissionModeSchema }),
	},
	{
		type: "kyrn.subagent-session",
		kind: "entry",
		version: 1,
		writers: [features("swarm")],
		readers: [],
		summary:
			"Ties a sub-agent's own session file to the delegate or hive call that started it (kyrn/docs/features/subagent-sessions.md).",
		schema: SubagentSessionSchema,
	},
	{
		type: "kyrn.monitor",
		kind: "entry",
		version: 1,
		writers: [features("monitor")],
		readers: [],
		summary:
			"What the drift check or the loop rule said, or in shadow mode would have said: the record a shadow run is judged by.",
		schema: MonitorSchema,
	},
	{
		type: "kyrn.board",
		kind: "entry",
		version: 1,
		writers: [features("board")],
		readers: [],
		summary: "The plain-language board after an update, so a reopened session shows it again.",
	},
	{
		type: "kyrn.capability",
		kind: "entry",
		version: 1,
		writers: [features("catalog"), features("packs")],
		readers: [],
		summary:
			"A capability opened, and who opened it: one the model had to ask for is the label the disclosure decision is measured by.",
	},
	{
		type: "kyrn.skill-read",
		kind: "entry",
		version: 1,
		writers: [features("skills")],
		readers: [],
		summary:
			"The model read a skill's file: how mu had shown it that skill, and what the first skill-disclosure verdict said of it. A skill the judge kept out and the model read is a miss.",
	},
	{
		type: "kyrn.capabilities",
		kind: "message",
		version: 1,
		writers: [features("catalog")],
		readers: [],
		summary: "Tells the model, after the first turn, which capabilities were opened for the request.",
	},
	{
		type: "kyrn.rewound",
		kind: "entry",
		version: 1,
		writers: [features("checkpoint")],
		readers: [],
		summary: "A rewind that happened, with the snapshot that undoes it.",
	},
	{
		type: "kyrn.rewind",
		kind: "message",
		version: 1,
		writers: [features("checkpoint")],
		readers: [],
		summary: "The lesson of a rewind, for the model to start over with.",
	},
	{
		type: "kyrn.steer",
		kind: "message",
		version: 1,
		writers: [features("checkpoint"), features("monitor")],
		readers: [],
		summary:
			"A short correction while the agent works: it loops or drifts, its approach looks like a dead end, or the files are back at a checkpoint.",
	},
	{
		type: "kyrn.nudge",
		kind: "message",
		version: 1,
		writers: [features("continuation"), features("completion")],
		readers: [],
		summary: "Sends a run that stopped short, or left a change unverified, back to work.",
	},
	{
		type: "kyrn.deadline",
		kind: "message",
		version: 1,
		writers: [features("deadline")],
		readers: [],
		summary: "How much of the run's time budget is left.",
	},
	{
		type: "kyrn.diagnostics",
		kind: "message",
		version: 1,
		writers: [features("lsp")],
		readers: [],
		summary: "Errors the language servers found in what the agent changed.",
	},
	{
		type: "kyrn.tool-dispatch",
		kind: "entry",
		version: 1,
		writers: [features("recovery")],
		readers: [],
		summary: "A call that may change something started: after an interruption its outcome is unknown.",
	},
	{
		type: "kyrn.recovery",
		kind: "message",
		version: 1,
		writers: [features("recovery")],
		readers: [],
		summary: "Which calls an interruption left without a result, and what to check before running them again.",
	},
	{
		type: "kyrn.interrupted",
		kind: "message",
		version: 1,
		writers: [features("interrupted")],
		readers: [],
		summary: "The text of a reply the user stopped, which pi leaves out of the next request, for the model only.",
	},
	{
		type: "kyrn.prefix",
		kind: "entry",
		version: 1,
		writers: [features("prefix")],
		readers: [],
		summary:
			"A request to the model that no longer starts with the one before it: what changed, and what mu decided in between.",
	},
	{
		type: "kyrn.frame",
		kind: "entry",
		version: 1,
		writers: [features("frame")],
		readers: [],
		summary: "The task frame: the goal, the user's constraints and the checklist.",
	},
	{
		type: "kyrn.frame",
		kind: "message",
		version: 1,
		writers: [features("frame")],
		readers: [],
		summary: "The task frame as the model reads it.",
	},
	{
		type: "kyrn.full-output",
		kind: "entry",
		version: 1,
		writers: ["src/extension/full-output.ts"],
		readers: [`recall: ${features("recall")}`],
		summary: "Where the whole of a tool output mu cut is kept, for recall to read the rest.",
	},
	{
		type: "kyrn.plan",
		kind: "entry",
		version: 1,
		writers: [features("plan")],
		readers: [],
		summary:
			"Plan mode turned on or off, or a plan the user approved, with how many of its steps went on the checklist (kyrn/docs/features/plan-mode.md).",
	},
	{
		type: "kyrn.plan",
		kind: "message",
		version: 1,
		writers: [features("plan")],
		readers: [],
		summary: "What plan mode means, given to the model when it is turned on, and that it is off when it is left.",
	},
	{
		type: "kyrn.feature-offer",
		kind: "entry",
		version: 1,
		writers: [features("feature-offers")],
		readers: [],
		summary:
			"The user's answer to turning on a feature that is off by default: on, declined or unanswered (kyrn/docs/features/feature-offers.md).",
	},
	{
		type: "kyrn.question",
		kind: "entry",
		version: 1,
		writers: [features("ask-user")],
		readers: [],
		summary:
			"How questions the model asked with ask_user ended: answered, skipped or pending, and a late answer (kyrn/docs/features/ask-user.md).",
	},
	{
		type: "kyrn.hive",
		kind: "message",
		version: 1,
		writers: [features("hive")],
		readers: [],
		summary: "What the hive passes to one of its bees while it works.",
	},
	{
		type: "kyrn.hive-request",
		kind: "message",
		version: 1,
		writers: [features("hive")],
		readers: [],
		summary: "What a `/hive` the user typed asks for, given to the model with that turn only.",
	},
	{
		type: "kyrn.swarm",
		kind: "message",
		version: 1,
		writers: [features("swarm-child")],
		readers: [],
		summary: "Asks a sub-agent to wrap up and report.",
	},
	{
		type: "kyrn.forgetting.state",
		kind: "entry",
		version: 1,
		writers: [features("forgetting")],
		readers: [],
		summary: "Which tool outputs the model no longer reads, so a reopened session forgets the same ones.",
	},
	{
		type: "kyrn.ttsr",
		kind: "message",
		version: 1,
		writers: [features("ttsr")],
		readers: [],
		summary: "Why a reply was cut while it broke one of the user's rules, and what to do instead.",
	},
	{
		type: "kyrn.usage",
		kind: "entry",
		version: 1,
		writers: [features("swarm"), features("watchdog")],
		readers: ["usage totals: src/swarm/state.ts"],
		summary: "Spend the session's own messages do not report: sub-agents, and a reply the watchdog cut.",
	},
	{
		type: "kyrn.watchdog",
		kind: "message",
		version: 1,
		writers: [features("watchdog")],
		readers: [],
		summary: "A reply that only thought too long was cut: where its reasoning got to, and to act on it.",
	},
	{
		type: "kyrn.lessons",
		kind: "message",
		version: 1,
		writers: [features("memory")],
		readers: [],
		summary: "Lessons of this project that apply to the task.",
	},
	{
		type: "kyrn.notice",
		kind: "message",
		version: 1,
		writers: [features("notify")],
		readers: [],
		summary: "An event the notify feature passes on to the model, now or with the next turn.",
	},
	{
		type: "kyrn.snapshot",
		kind: "message",
		version: 1,
		writers: [features("snapshot")],
		readers: [],
		summary: "The folder, git's state and the machine as a conversation starts, given once with its first message.",
	},
	{
		type: "kyrn.preload",
		kind: "message",
		version: 1,
		writers: [features("preload")],
		readers: [],
		summary: "Files the judge was sure the task needs, given with the first message of a conversation.",
	},
	{
		type: "kyrn.hint",
		kind: "message",
		version: 1,
		writers: [features("preflight")],
		readers: [],
		summary: "What the preflight verdict tells the model about the message: a side question, a plan first.",
	},
	{
		type: "kyrn.skills",
		kind: "message",
		version: 1,
		writers: [features("skills")],
		readers: [],
		summary: "The skills that apply to the task.",
	},
	{
		type: "kyrn.skills-changed",
		kind: "message",
		version: 1,
		writers: [features("skills")],
		readers: [],
		summary: "Skills installed or removed during the session, which the system prompt's list does not show.",
	},
	{
		type: "mu.import",
		kind: "message",
		version: 1,
		writers: ["src/import/session.ts"],
		readers: [],
		summary: "The first message of a conversation brought in from another tool: where it came from.",
	},
	{
		type: "mu.import.context",
		kind: "message",
		version: 1,
		writers: ["src/import/session.ts"],
		readers: [],
		summary: "What the imported conversation held that was not a message there, for the model only.",
	},
];

/** The registered entry of `type` and `kind`, if there is one. */
export function entryType(type: string, kind: EntryType["kind"]): EntryType | undefined {
	return ENTRY_TYPES.find((entry) => entry.type === type && entry.kind === kind);
}
