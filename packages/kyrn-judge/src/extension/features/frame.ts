import type { ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type TaskFrameOutcome, taskFrame } from "../../decisions/task-frame.ts";
import {
	addItem,
	compactFrame,
	constraintId,
	createFrame,
	describeFrame,
	EMPTY_STATE,
	type Frame,
	type FrameEntryData,
	type FrameState,
	frameEntry,
	inheritConstraints,
	isStale,
	limitQuotes,
	openQuestionCode,
	parseFrameEntry,
	parseInheritedConstraints,
	removeConstraint,
	renderFrameNote,
	ruleUpdate,
	tickItem,
	type UnmergedText,
	type UserText,
	withEntryId,
} from "../../frame/frame.ts";
import { mergeWriterFrame, parseWriterReply, writerRequest } from "../../frame/writer.ts";
import { say } from "../../language.ts";
import { BRIEF_ENV, briefFrame, parseBrief } from "../../swarm/brief.ts";
import {
	askWithin,
	clip,
	failOpen,
	judgedText,
	type KyrnRuntime,
	recentTurnDigests,
	textOf,
	userWords,
	within,
} from "../runtime.ts";

const MAX_LEGACY_RETRIES = 4;

/** Custom session entry: one per frame version, per tick and per failed update. Never sent to the model. */
export const FRAME_ENTRY = "kyrn.frame";
/** Custom message: the note the main model gets when the version changed. */
export const FRAME_MESSAGE = "kyrn.frame";
/** The footer's line about the checklist, while the task has one. */
export const CHECKLIST_STATUS = "mu.checklist";

/** One user message on its way into the frame. */
interface Ask {
	readonly turn: number;
	/** As pi stores it: the frame finds the message in the session by this text. */
	readonly text: string;
	/** The person's own words, without a host's preamble (`userWords`): what the frame and its judge read. */
	readonly words: string;
	/** Typed while the agent was working: it never waits and it is not a turn of its own. */
	readonly midRun: boolean;
	readonly startedAt: number;
	readonly inputContext: ExtensionContext | undefined;
	/** Set only by an input hook that saw a direct user message, never by beginTurn alone. */
	canGrantOnce?: true;
	permissionId?: string;
	/** Resolves when the update is over, whichever way it ended. Absent when nothing had to be asked. */
	pending?: Promise<void>;
	/** pi is about to store the user message. */
	landed: boolean;
	/** The user message is in the session, so an entry written now comes after it. */
	inSession: boolean;
	entryId?: string;
}

interface Unsaved {
	readonly state: FrameState;
	readonly reason: FrameEntryData["reason"];
	readonly ask: Ask;
}

/**
 * FR-02, the task frame: what the user wants, kept current as the conversation
 * moves, and the one thing every "is this relevant to the goal" judgment reads.
 *
 * The judge reads changes to the work and to its limits separately in one request.
 * A writer can select a verbatim new limit only when that change was authorized.
 * Removing a known limit needs no writer. With no writer the rules in `frame.ts`
 * apply. The first message needs neither.
 *
 * Event order, and why. Six features read `runtime.taskFrame()`, and the
 * update is asynchronous. The update starts inside `runtime.beginTurn`, which
 * preflight calls first thing on `input`, so it runs alongside preflight's own
 * judge call rather than after its wait. Preflight itself reads the frame
 * before that update exists, which is right: it asks how the message relates
 * to the task as it stood. This feature's `input` handler, registered right
 * after preflight, then waits for the update, bounded by `waitMs` counted from
 * when the message arrived. An update that is late is not dropped: the turn
 * starts on the previous version plus the raw message (`taskFrame()` shows it,
 * `frameStale` makes goal-based filters hold back), and the update lands when
 * it is ready, stamped with the turn that asked. Updates run one at a time, in
 * order, so a slow one cannot overwrite a newer one.
 *
 * Storage. Every version is a `kyrn.frame` session entry, written only once
 * the user message that caused it is in the session. `/tree` to a user message
 * moves the leaf to that message's parent, so an entry written before its
 * message would survive a rewind to it. The frame is rebuilt from the latest
 * entry on the current branch whenever the session starts or the tree moves.
 *
 * Shadow and off. The frame is infrastructure, so it exists in every mode:
 * version 1 from the first message, and the latest message shown as the
 * current subgoal, which is exactly what the stand-in gave the consumers
 * before. What shadow withholds is everything the judge's verdict would
 * cause: no writer call, no new version, no note. The verdict is recorded.
 */
export function registerFrame(runtime: KyrnRuntime): void {
	const options = runtime.options("frame", {
		enabled: true,
		/** How long a turn waits for its frame, counted from the arrival of the message. */
		waitMs: 3000,
		/** How long the writer model gets for one frame. */
		writerTimeoutMs: 20_000,
		/** Show the note about a new version in the chat, not only to the model. */
		show: true,
		/** Tell the user where the checklist stands when a run has ended and the list changed in it. */
		report: true,
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	runtime.frameState = EMPTY_STATE;

	/** Bumped when the session or the branch changes: a result from before belongs to another history. */
	let epoch = 0;
	let chain: Promise<void> = Promise.resolve();
	let asks: Ask[] = [];
	let unsaved: Unsaved[] = [];
	/** The ask `beginTurn` made for the input being handled right now. */
	let begun: Ask | undefined;
	/** The version the main model was last told about. */
	let notedVersion: number | undefined;
	let lastFailure: string | undefined;
	/** The checklist as the user was last told of it (`marks`): an end of run with the same list says nothing. */
	let reported = "";
	/** Which items a checklist has and which of them are done. */
	const marks = (frame: Frame | undefined): string =>
		(frame?.acceptance ?? []).map((item) => `${item.id}${item.done ? "x" : " "}`).join();

	const state = (): FrameState => runtime.frameState ?? EMPTY_STATE;
	const failedOf = (current: FrameState) => current.unmerged.filter((said) => said.reason === "failed");
	const effectiveFrame = (current: FrameState) => current.frame && failedOf(current).reduce(ruleUpdate, current.frame);
	// Keep /frame positions identical to the judge's target order, even if a pending replacement hides a stored rule.
	const displayedConstraints = (current: FrameState, effective = effectiveFrame(current)) => {
		const stored = current.frame?.constraints ?? [];
		const texts = new Set(stored.map(({ text }) => text));
		return { stored, pending: effective?.constraints.filter(({ text }) => !texts.has(text)) ?? [] };
	};
	const asText = (ask: Ask, verdict?: TaskFrameOutcome): UserText => ({
		text: ask.words,
		turn: ask.turn,
		...(ask.entryId ? { entryId: ask.entryId } : {}),
		...(verdict && verdict.change !== "none" ? { change: verdict.change } : {}),
		...(verdict && verdict.limit.kind !== "none" ? { limit: verdict.limit } : {}),
	});

	const withKnownIds = (current: FrameState): FrameState =>
		asks.reduce(
			(patched, ask) =>
				ask.entryId ? withEntryId(patched, { turn: ask.turn, text: ask.words, entryId: ask.entryId }) : patched,
			current,
		);

	const append = (current: FrameState, reason: FrameEntryData["reason"]) => {
		const data = frameEntry(withKnownIds(current), reason);
		if (data) pi.appendEntry<FrameEntryData>(FRAME_ENTRY, data);
	};

	const flush = () => {
		while (unsaved[0]?.ask.inSession) {
			const [next] = unsaved;
			append(next.state, next.reason);
			unsaved.shift();
		}
	};

	/** The frame changed: keep it, store it once its message is in the session, and tell whoever shows it. */
	const commit = (next: FrameState, reason: FrameEntryData["reason"], ask?: Ask) => {
		const current = withKnownIds(next);
		runtime.frameState = current;
		// Order is part of the record, so nothing overtakes an entry that still waits for its message.
		const blocker = ask && !ask.inSession ? ask : unsaved.at(-1)?.ask;
		if (blocker) unsaved.push({ state: current, reason, ask: blocker });
		else append(current, reason);
		present(reason, ask?.turn);
	};

	/** The footer's line as it was last written, so it is written only when it changes. */
	let footer: string | undefined;
	/**
	 * How much of the checklist is done, in the footer while the task has one: where the work stands is a glance away,
	 * and nobody has to ask the agent or wait for the run to end.
	 */
	const showChecklist = (frame: Frame | undefined): void => {
		const ctx = runtime.ctx;
		if (!ctx?.hasUI) return;
		const list = frame?.acceptance ?? [];
		const done = list.filter((item) => item.done).length;
		const text =
			list.length > 0
				? say({ zh: `清单 ${done}/${list.length}`, en: `Checklist ${done}/${list.length}` })
				: undefined;
		if (text === footer) return;
		footer = text;
		ctx.ui.setStatus(CHECKLIST_STATUS, text);
	};

	const present = (reason: FrameEntryData["reason"] | "restored", turn = runtime.userTurns) => {
		const current = state();
		showChecklist(current.frame);
		if (!current.frame) return;
		// The user's own words and the model's one-line evidence: nothing here is a secret or a raw judge input.
		runtime.present(
			"frame.updated",
			{
				reason,
				stale: isStale(current),
				frame: current.frame,
				unmerged: current.unmerged,
				openQuestionCodes: current.frame.openQuestions.map(openQuestionCode),
			},
			turn,
		);
	};

	const byRules = (frame: Frame, said: readonly UserText[], version = frame.version + 1): Frame => ({
		...said.reduce(ruleUpdate, frame),
		// One update is one version, however many messages it merges.
		version,
	});

	const withoutConstraint = (current: FrameState, id: string, turn: number): FrameState => {
		const frame = current.frame;
		if (!frame) return current;
		const matchesId = (rule: Frame["constraints"][number]) => constraintId(rule.text) === id;
		const target = frame.constraints.find(matchesId) ?? effectiveFrame(current)?.constraints.find(matchesId);
		if (!target) return current;
		const removed = removeConstraint(frame, id);
		// A failed add can hold the only copy. Keep the message for retry, excluding just this quote.
		const unmerged = current.unmerged.map((each) =>
			each.reason === "failed" &&
			(each.limit?.kind === "add" || each.limit?.kind === "replace") &&
			!each.withdrawnQuoteIds?.includes(id) &&
			each.text.includes(target.text)
				? { ...each, withdrawnQuoteIds: [...(each.withdrawnQuoteIds ?? []), id] }
				: each,
		);
		if (removed === frame && unmerged.every((each, index) => each === current.unmerged[index])) return current;
		return {
			frame: { ...removed, version: frame.version + 1, source: "rules", updatedTurn: turn, change: undefined },
			unmerged,
		};
	};

	const recoverLegacy = async (
		frame: Frame,
		failed: readonly UnmergedText[],
		legacy: readonly UnmergedText[],
		neededBy: number,
	) => {
		const view = compactFrame({ frame, unmerged: [] }) ?? { goal: frame.goal };
		const decisions = await Promise.all(
			legacy.map((row) =>
				askWithin(
					(signal) =>
						runtime.engine.decide(
							taskFrame,
							{
								userMessage: userWords(row.text).replace(/\s+/g, " ").trim(),
								frame: view,
								activeConstraints: frame.constraints,
								recentTurns: [], // Today's conversation cannot explain what the older input authorized.
							},
							{ signal, neededBy },
						),
					options.waitMs,
				),
			),
		);
		if (runtime.mode(taskFrame.id) !== "active") return undefined;
		return failed.flatMap((row): UnmergedText[] => {
			const index = legacy.indexOf(row);
			if (index < 0) return [row];
			const decision = decisions[index];
			// Keep an inconclusive attempt unresolved, even when a withdrawal is saved before the writer finishes.
			const unresolved: UnmergedText = { ...row, change: undefined, limit: { kind: "unclear" } };
			if (decision?.source !== "judge") return [unresolved];
			const { change, limit } = decision.outcome;
			if (limit.kind === "none") return [{ ...row, change: undefined }];
			if (limit.kind !== "add") return [unresolved]; // Never replay permission or removal from history.
			const added = { ...row, text: userWords(row.text), change: undefined, limit };
			if (change === "none") return [added];
			// Only recover mixed clauses that can be projected before judging the latest input. Otherwise a
			// writer-only quote could appear after the user had a chance to withdraw it.
			const quotes = limitQuotes({ ...added, change }, new Set(), []);
			return quotes.length > 0 ? quotes.map((text) => ({ ...added, text })) : [unresolved];
		});
	};

	const grantOnce = (ask: Ask) => {
		const { canGrantOnce, inputContext, permissionId } = ask;
		if (
			canGrantOnce &&
			permissionId &&
			inputContext === runtime.framePermissionInput &&
			ask.turn === runtime.userTurns &&
			ask === asks.at(-1)
		) {
			runtime.framePermissionOnce = { id: permissionId, userMessage: ask.words, turn: ask.turn };
		}
	};

	const confirmPermissionInput = (ask: Ask, event: InputEvent, ctx: ExtensionContext) => {
		// pi cannot distinguish a routed interjection from other extension sends, or tell who invoked /goal.
		// Neither grants once. A template description isn't permission either. For direct input, the judge
		// still interprets the user's words in context; this check does not certify that interpretation.
		if (
			ask.inputContext !== ctx ||
			event.source === "extension" ||
			!ask.words.trim() ||
			judgedText(ask.text, pi.getCommands()) !== ask.words
		)
			return;
		ask.canGrantOnce = true;
		grantOnce(ask);
	};

	const update = async (ask: Ask, at: number): Promise<void> => {
		if (at !== epoch) return;
		let prior = state();
		if (!prior.frame) {
			create(ask);
			return;
		}
		const neededBy = ask.startedAt + options.waitMs;
		const failedBefore = failedOf(prior);
		// Try the most recent ambiguous legacy rows in parallel, only when a writer retry is possible.
		const legacy = failedBefore.filter((row) => row.change === "constraint" && !row.limit).slice(-MAX_LEGACY_RETRIES);
		const recovered =
			legacy.length > 0 && runtime.mode(taskFrame.id) === "active" && (runtime.config.writer || runtime.ctx?.model)
				? await recoverLegacy(prior.frame, failedBefore, legacy, neededBy)
				: undefined;
		if (at !== epoch) return;
		if (recovered) prior = { ...prior, unmerged: recovered };
		const before = effectiveFrame(prior);
		if (!before) return;
		const { stored, pending } = displayedConstraints(prior, before);
		const decision = await runtime.engine.decide(
			taskFrame,
			{
				userMessage: (judgedText(ask.text, pi.getCommands()) ?? ask.words).replace(/\s+/g, " ").trim(),
				frame: compactFrame({ frame: before, unmerged: [] }) ?? { goal: before.goal },
				activeConstraints: [...stored, ...pending],
				recentTurns: runtime.ctx ? recentTurnDigests(runtime.ctx, 2) : [],
			},
			// The turn waits for the update until then (the `input` handler below); the update is used whenever it lands.
			{ neededBy },
		);
		if (at !== epoch) return;

		// Read again: an item may have been ticked while the judge was thinking.
		const latestState = state();
		const current =
			recovered && runtime.mode(taskFrame.id) === "active"
				? {
						...latestState,
						unmerged: [...recovered, ...latestState.unmerged.filter((row) => row.reason !== "failed")],
					}
				: latestState;
		if (decision.source === "judge") {
			await applyJudgedUpdate(ask, at, current, decision.outcome);
			return;
		}
		const { frame } = current;
		if (!frame) return;
		const failed = failedOf(current);
		const unjudged = { ...asText(ask), reason: "unjudged" as const };
		// What failed earlier is not carried past the next message: the rules merge it, so staleness is bounded.
		if (failed.length > 0) commit({ frame: byRules(frame, failed), unmerged: [unjudged] }, "updated", ask);
		else runtime.frameState = { frame, unmerged: [unjudged] };
	};

	const applyJudgedUpdate = async (ask: Ask, at: number, current: FrameState, { change, limit }: TaskFrameOutcome) => {
		const { frame } = current;
		if (!frame) return;
		if (limit.kind === "allow_once") {
			ask.permissionId = limit.id;
			grantOnce(ask);
		}
		const withdrawn = limit.kind === "withdraw" ? withoutConstraint(current, limit.id, ask.turn) : current;
		const base = withdrawn.frame ?? frame;
		const failed = failedOf(withdrawn);
		// Neither a grant nor a withdrawal needs the writer. Do not put either back on the retry list.
		const pendingLimit =
			limit.kind === "allow_once" || limit.kind === "withdraw" ? ({ kind: "none" } as const) : limit;
		const said =
			change === "none" && pendingLimit.kind === "none"
				? failed
				: [...failed, asText(ask, { change, limit: pendingLimit })];
		if (said.length === 0) {
			const next = { frame: base, unmerged: [] };
			if (withdrawn !== current) commit(next, "updated", ask);
			else runtime.frameState = next;
			return;
		}

		const model = runtime.ctx?.model;
		const writer =
			runtime.writer() ?? (model ? runtime.llm(`${model.provider}/${model.id}`, { thinking: "off" }) : undefined);
		if (!writer || said.every((each) => !each.change && each.limit?.kind === "withdraw")) {
			commit({ frame: byRules(base, said, frame.version + 1), unmerged: [] }, "updated", ask);
			return;
		}

		// Store the withdrawal before the writer can stall. A new task must not inherit the old checklist
		// if the session closes here. Its rule-built frame is already a complete fallback, not retry work.
		const provisional =
			withdrawn !== current && change === "new_task" ? byRules(base, said, frame.version + 1) : undefined;
		if (provisional) commit({ frame: provisional, unmerged: [] }, "updated", ask);
		else if (withdrawn !== current) commit(withdrawn, "updated", ask);
		// Let the writer refine the reset task, but show pending limits as pending, not already installed.
		const writerBase = provisional ? { ...provisional, constraints: base.constraints } : base;
		try {
			const reply = await askWithin(
				(signal) => writer({ ...writerRequest(writerBase, said), signal }),
				options.writerTimeoutMs,
			);
			if (at !== epoch) return;
			if (!reply) throw new Error("writer timed out");
			const parsed = parseWriterReply(reply.text);
			if (!parsed.ok) throw new Error(parsed.problem);
			lastFailure = undefined;
			const latest = state().frame ?? base;
			// Refine any provisional limits from their original base, not by applying a replacement twice.
			const mergeBase = provisional ? { ...latest, constraints: base.constraints } : latest;
			commit({ frame: mergeWriterFrame(mergeBase, parsed.value, said), unmerged: [] }, "updated", ask);
		} catch (error) {
			if (at !== epoch) return;
			lastFailure = clip(error instanceof Error ? error.message : String(error), 200);
			if (provisional) return;
			const latest = state().frame ?? base;
			// Second failure in a row: the rules take over, word for word, rather than leave the frame stale for good.
			if (failed.length > 0) commit({ frame: byRules(latest, said), unmerged: [] }, "updated", ask);
			else commit({ frame: latest, unmerged: said.map((each) => ({ ...each, reason: "failed" })) }, "stale", ask);
		}
	};

	const create = (ask: Ask) => {
		// A sub-agent starts under what the user told its parent: the constraint gate holds there too.
		const inherited = parseInheritedConstraints(process.env.KYRN_SWARM_CONSTRAINTS);
		// Its goal is its part, not the whole message it was handed, and "done" is what the parent asked of the part.
		const brief = parseBrief(process.env[BRIEF_ENV]);
		const first = brief ? briefFrame(brief, ask.turn) : createFrame(asText(ask));
		commit({ frame: inheritConstraints(first, inherited), unmerged: [] }, "created", ask);
		// The note would only repeat the prompt it rides along with.
		notedVersion = 1;
	};

	const begin = (text: string, midRun: boolean, goalEntryId?: string): Ask => {
		// A message that never reached the session (a refused prompt, a queued message taken back) must not block the ones after it.
		if (!midRun) {
			for (const old of asks) {
				if (!old.landed) old.landed = old.inSession = true;
			}
		}
		const ask: Ask = {
			turn: runtime.userTurns,
			text,
			words: userWords(text),
			midRun,
			startedAt: Date.now(),
			inputContext: runtime.ctx,
			landed: goalEntryId !== undefined,
			inSession: goalEntryId !== undefined,
			entryId: goalEntryId,
		};
		asks = [...asks.slice(-19), ask];
		// Synchronous, so the turn's very first judgment already records frame version 1 as its origin.
		if (!state().frame) create(ask);
		else {
			const at = epoch;
			chain = chain.then(() => update(ask, at)).catch(() => {});
			ask.pending = chain;
		}
		return ask;
	};

	runtime.onTurnBegin = (text, goalEntryId) => {
		const ask = begin(text, false, goalEntryId);
		begun = goalEntryId ? undefined : ask;
	};

	const restore = (ctx: ExtensionContext) => {
		runtime.touch(ctx);
		epoch++;
		runtime.framePermissionOnce = undefined;
		runtime.framePermissionInput = undefined;
		chain = Promise.resolve();
		asks = [];
		unsaved = [];
		begun = undefined;
		lastFailure = undefined;
		let restored: FrameState | undefined;
		let noted: number | undefined;
		let compacted = false;
		let firstUser: UserText | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "compaction") {
				// Whatever the model was told before may be gone from its context.
				noted = undefined;
				compacted = true;
			} else if (entry.type === "custom" && entry.customType === FRAME_ENTRY) {
				restored = parseFrameEntry(entry.data) ?? restored;
			} else if (entry.type === "custom_message" && entry.customType === FRAME_MESSAGE) {
				const version = (entry.details as { version?: unknown } | undefined)?.version;
				if (typeof version === "number") noted = version;
			} else if (!firstUser && entry.type === "message" && entry.message.role === "user") {
				const text = textOf(entry.message.content);
				if (text.trim()) firstUser = { text, turn: 0, entryId: entry.id };
			}
		}
		// A session from before there were frames: its first message is the goal, as the rule has it.
		restored ??= firstUser ? { frame: createFrame(firstUser), unmerged: [] } : EMPTY_STATE;
		if (noted === undefined && !compacted && restored.frame?.source === "first-message")
			noted = restored.frame.version;
		runtime.frameState = restored;
		notedVersion = noted;
		// A session that is opened again has its list as it was left: nothing new to report.
		reported = marks(restored.frame);
		present("restored");
	};
	// A rewind or a fork brings back the frame of that branch: entries follow the tree.
	pi.on(
		"session_start",
		failOpen((_event, ctx) => {
			restore(ctx);
			return undefined;
		}),
	);
	pi.on(
		"session_tree",
		failOpen((_event, ctx) => {
			restore(ctx);
			return undefined;
		}),
	);
	pi.on(
		"session_compact",
		failOpen(() => {
			// mu's own notes do not survive compaction, and the constraints must: the next turn gets the note again.
			notedVersion = undefined;
			return undefined;
		}),
	);
	pi.on(
		"session_shutdown",
		failOpen(() => {
			epoch++;
			runtime.framePermissionOnce = undefined;
			runtime.framePermissionInput = undefined;
			return undefined;
		}),
	);

	pi.on(
		"input",
		failOpen<InputEvent, InputEventResult>(async (event, ctx) => {
			runtime.touch(ctx);
			if (!event.text.trim()) return undefined;
			const midRun = Boolean(event.streamingBehavior);
			// A prompt an extension made is not the user speaking. A mid-run message it re-sent (interjection) is.
			if (event.source === "extension" && !midRun) return undefined;
			if (midRun) {
				confirmPermissionInput(begin(event.text, true), event, ctx);
				return undefined;
			}
			// Preflight counts the turns. Where it is off, nobody has counted this one yet.
			if (begun?.inputContext !== ctx || begun.text !== event.text) {
				runtime.beginTurn(event.text);
				runtime.startTurnWork(event.text);
			}
			const ask = begun;
			begun = undefined;
			if (!ask) return undefined;
			confirmPermissionInput(ask, event, ctx);
			if (!ask.pending || runtime.mode(taskFrame.id) !== "active") return undefined;

			runtime.progress("updating the task frame", "frame");
			const at = epoch;
			const completed = await within(
				ask.pending.then(() => true),
				Math.max(0, ask.startedAt + options.waitMs - Date.now()),
			);
			const current = state();
			if (!completed && at === epoch && current.frame) {
				// The turn starts on the last valid version plus the raw message, and says so.
				runtime.frameState = {
					frame: current.frame,
					unmerged: [...failedOf(current), { ...asText(ask), reason: "late" }],
				};
			}
			return undefined;
		}),
	);

	pi.on(
		"before_agent_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			const current = state();
			if (!current.frame || current.frame.version === notedVersion) return undefined;
			notedVersion = current.frame.version;
			// Not in the system prompt: that would break the prompt cache on every change of task.
			return {
				message: {
					customType: FRAME_MESSAGE,
					content: renderFrameNote(current),
					display: options.show,
					details: { version: current.frame.version },
				},
			};
		}),
	);

	pi.on(
		"message_end",
		failOpen((event) => {
			const message = event.message as { role?: unknown; content?: unknown };
			if (message.role !== "user") return undefined;
			const text = textOf(message.content);
			const waiting = asks.filter((ask) => !ask.landed);
			// A prompt template expands, so its text differs: the prompt being started is then the one that lands.
			const ask = waiting.find((each) => each.text === text) ?? waiting.find((each) => !each.midRun);
			if (ask) ask.landed = true;
			return undefined;
		}),
	);

	/** pi stores a message right after its `message_end` handlers ran, so by the next event it is in the session. */
	const settle = (ctx: ExtensionContext) => {
		const arrived = asks.filter((ask) => ask.landed && !ask.inSession);
		if (arrived.length > 0) {
			const users: { id: string; text: string }[] = [];
			const branch = ctx.sessionManager.getBranch();
			for (let index = branch.length - 1; index >= 0 && users.length < arrived.length + 4; index--) {
				const entry = branch[index];
				if (entry.type === "message" && entry.message.role === "user") {
					users.push({ id: entry.id, text: textOf(entry.message.content) });
				}
			}
			for (const ask of arrived) {
				ask.inSession = true;
				ask.entryId = (
					users.find((user) => user.text === ask.text) ?? (arrived.length === 1 ? users[0] : undefined)
				)?.id;
			}
			runtime.frameState = withKnownIds(state());
			unsaved = unsaved.map((each) => ({ ...each, state: withKnownIds(each.state) }));
		}
		flush();
	};
	pi.on(
		"context",
		failOpen((_event, ctx) => {
			settle(ctx);
			return undefined;
		}),
	);
	pi.on(
		"agent_end",
		failOpen((_event, ctx) => {
			settle(ctx);
			return undefined;
		}),
	);

	// Plan mode puts an approved plan's steps here, as the user's: they approved them (features/plan.ts).
	runtime.addChecklist = (texts) => {
		const current = state();
		let frame = current.frame;
		if (!frame) return 0;
		let added = 0;
		for (const text of texts) {
			const changed = addItem(frame, text, "user");
			if ("error" in changed) continue;
			frame = changed.frame;
			added++;
		}
		if (added > 0) commit({ frame, unmerged: current.unmerged }, "progress");
		return added;
	};

	// The to-do list is the frame's acceptance criteria: one list, so "done" means what the user asked for.
	const checklist = (frame: Frame | undefined): string =>
		frame && frame.acceptance.length > 0
			? frame.acceptance
					.map(
						(item) =>
							`[${item.done ? "x" : " "}] ${item.id} ${item.text}${item.evidence ? ` · ${item.evidence}` : ""}`,
					)
					.join("\n")
			: 'The list is empty. Add what has to be true before the task is finished: todo({ action: "add", text: "…" }).';
	const answer = (action: string, text: string, error = false) => ({
		content: [{ type: "text" as const, text }],
		details: { action, error, items: [...(state().frame?.acceptance ?? [])] },
	});
	pi.registerTool({
		name: "todo",
		label: "To-do",
		description:
			"The checklist of what has to be true before the task is finished, kept in mu's task frame. list shows it. done ticks one item and needs one line of evidence (the command that passed, the file that changed). add records an item you discovered. Tick items as you finish them; do not say the task is done while one is open.",
		parameters: Type.Object({
			action: Type.Unsafe<"list" | "done" | "add">({
				type: "string",
				enum: ["list", "done", "add"],
				description: "list, done or add",
			}),
			id: Type.Optional(Type.String({ description: "Id of the item to tick, such as a2 (done)" })),
			evidence: Type.Optional(Type.String({ description: "One line on what shows the item is met (done)" })),
			text: Type.Optional(Type.String({ description: "What has to be true (add)" })),
		}),
		execute: async (_toolCallId, params) => {
			const current = state();
			const frame = current.frame;
			if (!frame) return answer(params.action, "There is no task yet, so there is nothing to tick.", true);
			if (params.action === "list") return answer("list", checklist(frame));
			const changed =
				params.action === "done"
					? tickItem(frame, params.id ?? "", params.evidence ?? "", "model")
					: params.action === "add"
						? addItem(frame, params.text ?? "", "model")
						: { error: `Unknown action "${String(params.action)}". Use list, done or add.` };
			if ("error" in changed) return answer(params.action, changed.error, true);
			// Progress, not a change of task: same version, stored the same way, so a rewind takes the tick back too.
			commit({ frame: changed.frame, unmerged: current.unmerged }, "progress");
			const verb = params.action === "done" ? "Ticked" : "Added";
			return answer(params.action, `${verb} ${changed.item.id}: ${changed.item.text}\n${checklist(changed.frame)}`);
		},
	});
	runtime.catalog.register({
		id: "tool:todo",
		kind: "tool",
		title: "To-do list",
		description: "The task's acceptance checklist: list it, tick an item with evidence, add one that was discovered.",
		tools: ["todo"],
		exposure: "always",
	});

	// The user who did not watch the run learns what it settled without reading it: each thing that had to be true, and
	// what showed it. Once the run is at rest, so under the answer; a run the user stopped, or one the harness cut and
	// starts again, is not at an end. A sub-agent's list is its parent's to read.
	pi.on(
		"agent_settled",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			const list = state().frame?.acceptance ?? [];
			const now = marks(state().frame);
			if (!options.report || event.aborted || runtime.planMode || list.length === 0 || now === reported) {
				return undefined;
			}
			if (!ctx.hasUI || process.env.KYRN_SWARM_DEPTH) return undefined;
			reported = now;
			const done = list.filter((item) => item.done).length;
			ctx.ui.notify(
				[
					say({
						zh: `mu：这个任务的清单，${list.length} 项完成 ${done} 项${done > 0 ? "（依据是代理自己给的）" : ""}：`,
						en: `mu: this task's checklist, ${done} of ${list.length} done${done > 0 ? " (the evidence is the agent's own)" : ""}:`,
					}),
					...list.map(
						(item) =>
							`  [${item.done ? "x" : " "}] ${clip(item.text, 100)}${item.done && item.evidence ? ` · ${clip(item.evidence, 100)}` : ""}`,
					),
				].join("\n"),
				"info",
			);
			return undefined;
		}),
	);

	pi.registerCommand("frame", {
		description: say({
			zh: "显示任务帧；/frame remove <id> 移除指定的硬约束",
			en: "Show the task frame and its constraint IDs; /frame remove <id> removes one constraint",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const current = state();
			const { stored, pending } = displayedConstraints(current);
			if (!args.trim()) {
				const lines = [describeFrame(current)];
				if (pending.length > 0) {
					lines.push(say({ zh: "等待重试的约束：", en: "Constraints pending retry:" }));
					for (const { text } of pending) lines.push(`  ${constraintId(text)} "${text}"`);
				}
				if (lastFailure) lines.push(`last update failed: ${lastFailure}`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			const prefix = /^remove\s+([\da-f]{1,64})$/i.exec(args.trim())?.[1].toLowerCase();
			if (!prefix) {
				ctx.ui.notify(
					say({
						zh: "用法：/frame remove <id 前几位>。/frame 列出 id。",
						en: "Usage: /frame remove <id prefix>. /frame lists the IDs.",
					}),
					"warning",
				);
				return;
			}
			// Resolve the prefix in the frame the user sees, not in a later writer's frame.
			const matches = [...new Set([...stored, ...pending].map(({ text }) => text))].filter((text) =>
				constraintId(text).startsWith(prefix),
			);
			if (matches.length !== 1) {
				ctx.ui.notify(
					matches.length
						? say({
								zh: "匹配了多条约束。请多给几位 id。",
								en: "That prefix matches more than one constraint. Use more of its ID.",
							})
						: say({
								zh: `没有以 ${prefix} 开头的任务帧约束。`,
								en: `No active frame constraint matches ${prefix}.`,
							}),
					"warning",
				);
				return;
			}
			const [text] = matches;
			const at = epoch;
			const turn = runtime.userTurns;
			const removed = await askWithin((signal) => {
				const removal = chain.then(() => {
					if (signal.aborted || at !== epoch) return false;
					flush();
					if (unsaved.length > 0) return false;
					const latest = state();
					const next = withoutConstraint(latest, constraintId(text), turn);
					if (next !== latest) commit(next, "updated");
					return true;
				});
				chain = removal.then(() => {}).catch(() => {});
				return removal;
			}, options.waitMs);
			if (at !== epoch) return;
			if (!removed) {
				ctx.ui.notify(
					say({
						zh: "任务帧仍在更新。请稍后重试。",
						en: "The frame is still updating. Retry the removal in a moment.",
					}),
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				say({ zh: `任务帧约束已失效：${text}`, en: `Frame constraint no longer active: ${text}` }),
				"info",
			);
		},
	});
}
