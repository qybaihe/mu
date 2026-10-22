import type { ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { taskFrame } from "../../decisions/task-frame.ts";
import {
	addItem,
	compactFrame,
	createFrame,
	describeFrame,
	EMPTY_STATE,
	type Frame,
	type FrameChange,
	type FrameEntryData,
	type FrameState,
	frameEntry,
	inheritConstraints,
	isStale,
	openQuestionCode,
	parseFrameEntry,
	parseInheritedConstraints,
	renderFrameNote,
	ruleUpdate,
	tickItem,
	type UserText,
	withEntryId,
} from "../../frame/frame.ts";
import { mergeWriterFrame, parseWriterReply, writerRequest } from "../../frame/writer.ts";
import { say } from "../../language.ts";
import { BRIEF_ENV, briefFrame, parseBrief } from "../../swarm/brief.ts";
import { clip, failOpen, judgedText, type KyrnRuntime, recentTurnDigests, textOf, userWords } from "../runtime.ts";

/** Custom session entry: one per frame version, per tick and per failed update. Never sent to the model. */
export const FRAME_ENTRY = "kyrn.frame";
/** Custom message: the note the main model gets when the version changed. */
export const FRAME_MESSAGE = "kyrn.frame";

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
 * Who does what. The judge answers one choice question per user message: does
 * it change the frame, and how. Only on a change does a generative model (the
 * configured writer, else the session's model) write the new frame, and code
 * checks that every hard constraint is the user's own words. With no model at
 * all the rules in `frame.ts` apply. The first message needs neither.
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

	const state = (): FrameState => runtime.frameState ?? EMPTY_STATE;
	const failedOf = (current: FrameState) => current.unmerged.filter((said) => said.reason === "failed");
	const asText = (ask: Ask, change?: FrameChange): UserText => ({
		text: ask.words,
		turn: ask.turn,
		...(ask.entryId ? { entryId: ask.entryId } : {}),
		...(change ? { change } : {}),
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
			const next = unsaved.shift() as Unsaved;
			append(next.state, next.reason);
		}
	};

	/** The frame changed: keep it, store it once its message is in the session, and tell whoever shows it. */
	const commit = (next: FrameState, reason: FrameEntryData["reason"], ask?: Ask) => {
		const current = withKnownIds(next);
		runtime.frameState = current;
		// Order is part of the record, so nothing overtakes an entry that still waits for its message.
		const blocker = unsaved.at(-1)?.ask ?? (ask && !ask.inSession ? ask : undefined);
		if (blocker) unsaved.push({ state: current, reason, ask: blocker });
		else append(current, reason);
		present(reason, ask?.turn);
	};

	const present = (reason: FrameEntryData["reason"] | "restored", turn = runtime.userTurns) => {
		const current = state();
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

	const byRules = (frame: Frame, said: readonly UserText[]): Frame => ({
		...said.reduce(ruleUpdate, frame),
		// One update is one version, however many messages it merges.
		version: frame.version + 1,
	});

	const update = async (ask: Ask, at: number): Promise<void> => {
		const before = state();
		if (!before.frame) {
			if (at === epoch) create(ask);
			return;
		}
		const decision = await runtime.engine.decide(taskFrame, {
			userMessage: clip(judgedText(ask.words, pi.getCommands()) ?? ask.words, 600),
			frame: compactFrame({ frame: before.frame, unmerged: failedOf(before) }) ?? { goal: before.frame.goal },
			recentTurns: runtime.ctx ? recentTurnDigests(runtime.ctx, 2) : [],
		});
		if (at !== epoch) return;

		// Read again: an item may have been ticked while the judge was thinking.
		const current = state();
		const frame = current.frame;
		if (!frame) return;
		const failed = failedOf(current);
		if (decision.source !== "judge") {
			const unjudged = { ...asText(ask), reason: "unjudged" as const };
			// What failed earlier is not carried past the next message: the rules merge it, so staleness is bounded.
			if (failed.length > 0) commit({ frame: byRules(frame, failed), unmerged: [unjudged] }, "updated", ask);
			else runtime.frameState = { frame, unmerged: [unjudged] };
			return;
		}
		const said = decision.outcome === "none" ? failed : [...failed, asText(ask, decision.outcome)];
		if (said.length === 0) {
			runtime.frameState = { frame, unmerged: [] };
			return;
		}

		const model = runtime.ctx?.model;
		const writer =
			runtime.writer() ?? (model ? runtime.llm(`${model.provider}/${model.id}`, { thinking: "off" }) : undefined);
		if (!writer) {
			commit({ frame: byRules(frame, said), unmerged: [] }, "updated", ask);
			return;
		}
		try {
			const reply = await writer({
				...writerRequest(frame, said),
				signal: AbortSignal.timeout(options.writerTimeoutMs),
			});
			const parsed = parseWriterReply(reply.text);
			if (!parsed.ok) throw new Error(parsed.problem);
			if (at !== epoch) return;
			lastFailure = undefined;
			commit({ frame: mergeWriterFrame(state().frame ?? frame, parsed.value, said), unmerged: [] }, "updated", ask);
		} catch (error) {
			if (at !== epoch) return;
			lastFailure = error instanceof Error ? error.message.slice(0, 200) : String(error);
			const latest = state().frame ?? frame;
			// Second failure in a row: the rules take over, word for word, rather than leave the frame stale for good.
			if (failed.length > 0) commit({ frame: byRules(latest, said), unmerged: [] }, "updated", ask);
			else {
				const kept = said.map((each) => ({ ...each, reason: "failed" as const }));
				commit({ frame: latest, unmerged: kept }, "stale", ask);
			}
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

	const begin = (text: string, midRun: boolean): Ask => {
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
			landed: false,
			inSession: false,
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

	runtime.onTurnBegin = (text) => {
		begun = begin(text, false);
	};

	const restore = (ctx: ExtensionContext) => {
		epoch++;
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
				begin(event.text, true);
				return undefined;
			}
			// Preflight counts the turns. Where it is off, nobody has counted this one yet.
			if (begun?.text !== event.text) {
				runtime.beginTurn(event.text);
				runtime.startTurnWork(event.text);
			}
			const ask = begun;
			begun = undefined;
			if (!ask?.pending || runtime.mode(taskFrame.id) !== "active") return undefined;

			runtime.progress("updating the task frame", "frame");
			const at = epoch;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const late = await Promise.race([
				ask.pending.then(() => false),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(true), Math.max(0, options.waitMs - (Date.now() - ask.startedAt)));
				}),
			]);
			if (timer) clearTimeout(timer);
			const current = state();
			if (late && at === epoch && current.frame) {
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

	pi.registerCommand("frame", {
		description: say({
			zh: "任务帧：目标、你的硬约束（原话加出处）、当前子目标、验收条件",
			en: "Show the task frame: the goal, your constraints with their source, the current subgoal and the acceptance criteria",
		}),
		handler: async (_args, ctx) => {
			runtime.touch(ctx);
			const text = describeFrame(state());
			ctx.ui.notify(lastFailure ? `${text}\nlast update failed: ${lastFailure}` : text, "info");
		},
	});
}
