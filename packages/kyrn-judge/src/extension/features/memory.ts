import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isCheckCommand } from "../../checkpoint/mutating.ts";
import {
	type LessonText,
	type MergeVerdict,
	memoryApplied,
	memoryCapture,
	memoryMerge,
	memoryOutcome,
	memoryRecall,
	memoryRecallForTask,
	memoryWorth,
	type WorthVerdict,
} from "../../decisions/memory.ts";
import { say } from "../../language.ts";
import { lessonLinesOf, lessonText, parsePhrase, turnDigest } from "../../memory/phrasing.ts";
import {
	inScope,
	type LessonKind,
	type LessonOrigin,
	type LessonStatus,
	LessonStore,
	neighbours,
	rankForRecall,
	type StoredLesson,
	sameText,
} from "../../memory/store.ts";
import type { LlmCompletion } from "../../providers/llm.ts";
import { clip, failOpen, type KyrnRuntime, textOf, userWords, within } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";
import { describeCall } from "./admission.ts";
import type { HarnessRoots } from "./inherit.ts";
import { isUnattended } from "./unattended.ts";

const CORRECTION_PROMPT = `You turn a user's correction into one reusable lesson for a coding agent.
Reply with one JSON object and nothing else: {"trigger": "<the situation in which the lesson applies, one short sentence>", "lesson": "<what to do, one imperative sentence>"}`;

const WAY_OUT_PROMPT = `A coding agent got stuck, then found a way out. You turn what happened into one reusable lesson for the next time it meets the same situation.
Reply with one JSON object and nothing else: {"trigger": "<the situation or the error in which the lesson applies, one short sentence>", "lesson": "<what to do instead, one imperative sentence>"}`;

/** Steps of one turn kept for its digest: the first ones stay, the middle gives way to the latest. */
const MAX_KEPT_STEPS = 48;
const HEAD_KEPT = 6;
/** Lessons taken from one delegate or hive result, at most. */
const MAX_REPORT_LESSONS = 8;
/** How long a model gets to put one lesson into words. */
const WRITER_TIMEOUT_MS = 20_000;
/** The project's instructions as the worth question reads them. */
const INSTRUCTIONS_CHARS = 6000;

/** Where a lesson was learned: the project, the session and the user turn. */
interface Place {
	readonly cwd: string;
	readonly session?: string;
	readonly turn: number;
}

interface Candidate extends LessonText {
	readonly kind: LessonKind;
	readonly origin: LessonOrigin;
}

/** What became of a new lesson: stored, the same as one kept already, or outranked by a kept one it contradicts. */
export type Kept =
	| { readonly kind: "stored"; readonly lesson: StoredLesson; readonly replaced: readonly StoredLesson[] }
	| { readonly kind: "same"; readonly existing: StoredLesson }
	| { readonly kind: "outranked"; readonly existing: StoredLesson };

const KIND_WORDS: Readonly<Record<LessonKind, { zh: string; en: string }>> = {
	correction: { zh: "纠正", en: "correction" },
	preference: { zh: "规则", en: "rule" },
	pitfall: { zh: "坑", en: "pitfall" },
	workaround: { zh: "绕过办法", en: "workaround" },
	fact: { zh: "事实", en: "fact" },
};

const STATUS_WORDS: Readonly<Record<LessonStatus, { zh: string; en: string }>> = {
	active: { zh: "在用", en: "active" },
	retired: { zh: "已退役", en: "retired" },
	superseded: { zh: "已被替代", en: "superseded" },
};

function sessionOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId() || undefined;
	} catch {
		return undefined;
	}
}

/** The project's instruction files as the agent is given them, for "is this known already". */
function projectInstructions(files: readonly { path: string; content: string }[] | undefined): string {
	return (files ?? [])
		.map((file) => `${basename(file.path)}:\n${file.content.trim()}`)
		.join("\n\n")
		.slice(0, INSTRUCTIONS_CHARS);
}

/** A delegate or hive result's reports: each sub-agent's last words, or the whole text when there are none. */
function reportsOf(event: { content: unknown; details?: unknown }): string[] {
	const reports = (event.details as { reports?: unknown } | undefined)?.reports;
	if (Array.isArray(reports)) return reports.filter((report): report is string => typeof report === "string");
	return [textOf(event.content)];
}

/**
 * A5 + D2, the agent's experience (kyrn/docs/features/experience-library.md). A lesson is a trigger
 * the judge matches against what comes next, and one line that gets injected when it does.
 *
 * It learns from five places: the user correcting the agent or setting a rule, the agent getting out
 * of a loop it was stuck in, the model's own `remember` calls, the `Lesson:` lines of sub-agents'
 * reports, and `/remember`. Every new lesson is held against the most similar kept ones first, so
 * the same thing is not kept twice and the user's latest word replaces what it contradicts. At the end
 * of a turn the judge says whether the lessons brought into it were followed, and one recalled many
 * times and never followed is retired.
 *
 * The judge never writes: the configured writer model phrases a correction (without one the user's
 * own words are kept), and a way out is phrased by the writer or the conversation's model.
 *
 * An unattended run (`mu --print`, json mode) reads the kept lessons and learns nothing new: no one-shot run on a
 * machine that may be thrown away should pay for lessons nobody will read. The `remember` tool is left out of its
 * request by the catalog (`catalog.unattendedHidden`).
 */
export function registerMemory(runtime: KyrnRuntime, roots?: HarnessRoots): void {
	const options = runtime.options("memory", {
		enabled: true,
		path: "",
		maxCandidates: 24,
		maxInjected: 5,
		/** How long the turn waits for the recall verdict, counted from the arrival of the message. */
		waitMs: 4000,
		/** A lesson recalled this many times that the judge never saw followed is retired. 0 keeps every lesson. */
		retireAfter: 8,
		/** Kept lessons a new one is compared with before it is stored: those sharing the most words with it. */
		mergeNeighbours: 6,
		/** Learn from a turn that went in circles and still ended with a passing check or the goal met. */
		outcome: true,
		/** Ask at the end of a turn whether the lessons brought into it were followed. */
		applied: true,
		/** Learn from corrections, ways out and sub-agents' reports in a `mu --print` or json run too. */
		unattendedWrites: false,
	});
	// A sub-agent keeps no lessons: its brief brings the ones that apply, and what it learned goes back in its report.
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;
	/** Whether this run may learn new lessons: not an unattended one, unless `unattendedWrites` says so. */
	const learns = (ctx: ExtensionContext | undefined): boolean => options.unattendedWrites || !isUnattended(ctx);
	// A caller that owns the setup and named no home gets a store that lasts as long as the session.
	const store = new LessonStore(options.path || (roots ? join(roots.agentDir, "mu", "lessons.jsonl") : undefined));
	const now = () => new Date().toISOString();
	const placeOf = (ctx: ExtensionContext): Place => ({
		cwd: ctx.cwd,
		session: sessionOf(ctx),
		turn: runtime.userTurns,
	});
	/** The project's instructions, as the last turn was given them. */
	let instructions = "";

	const setStatus = (id: string, status: "retired" | "superseded") => store.write({ id, status, updated: now() });
	const retire = (id: string, reason: "unused" | "contradicted" | "forgotten", turn: number) => {
		setStatus(id, "retired");
		runtime.present("memory.retired", { id, reason }, turn);
	};
	/** Use accounting reads the lessons as they are now: another session may have counted since the turn began. */
	const countUses = (ids: readonly string[], change: (uses: StoredLesson["uses"]) => StoredLesson["uses"]) => {
		const current = new Map(store.all().map((lesson) => [lesson.id, lesson]));
		for (const id of ids) {
			const lesson = current.get(id);
			if (lesson) store.write({ id, uses: change(lesson.uses) });
		}
	};

	/**
	 * Every new lesson, whatever it came from, is held against the kept lessons most like it before it is
	 * written. The same lesson is not stored twice; a sharper one replaces the old; and a contradiction
	 * retires the old lesson only when the new one is the user's word. What the model or a sub-agent
	 * concluded does not outvote a kept lesson, and two lessons that cannot both hold are not kept side by side.
	 */
	const keep = async (candidate: Candidate, place: Place, signal?: AbortSignal): Promise<Kept> => {
		const id = randomUUID();
		const all = store.all();
		const confirm = (existing: StoredLesson): Kept => {
			store.write({ id: existing.id, updated: now() });
			runtime.present("memory.merged", { id, into: existing.id, how: "same" }, place.turn);
			return { kind: "same", existing };
		};
		// A rule first: a lesson kept word for word needs no judge.
		const twin = all.find(
			(lesson) =>
				lesson.status === "active" && inScope(lesson, place.cwd) && sameText(lesson.lesson, candidate.lesson),
		);
		if (twin) return confirm(twin);

		const near = neighbours(candidate, all, place.cwd, options.mergeNeighbours);
		const decision =
			near.length > 0
				? await runtime.engine.decide(
						memoryMerge,
						{ candidate: { trigger: candidate.trigger, lesson: candidate.lesson }, existing: near },
						{ signal },
					)
				: undefined;
		const verdicts = decision?.source === "judge" ? decision.outcome : [];
		const having = (verdict: MergeVerdict) => near.filter((_, index) => verdicts[index] === verdict);
		const [same] = having("same");
		const contradicted = having("contradicts");
		const usersWord = candidate.origin === "user" || candidate.origin === "command";
		if (contradicted.length > 0 && !usersWord) {
			runtime.present("memory.merged", { id, into: contradicted[0].id, how: "contradicts" }, place.turn);
			return { kind: "outranked", existing: contradicted[0] };
		}
		// The user's latest word wins: what it contradicts is retired, without asking.
		for (const old of contradicted) {
			runtime.present("memory.merged", { id: old.id, into: same?.id ?? id, how: "contradicts" }, place.turn);
			retire(old.id, "contradicted", place.turn);
		}
		if (same) return confirm(same);

		const refined = having("refines");
		const at = now();
		const lesson: StoredLesson = {
			id,
			kind: candidate.kind,
			trigger: candidate.trigger,
			lesson: candidate.lesson,
			scope: { cwd: place.cwd },
			source: { origin: candidate.origin, ...(place.session ? { session: place.session } : {}), turn: place.turn },
			status: "active",
			...(refined[0] ? { supersedes: refined[0].id } : {}),
			uses: { recalled: 0, applied: 0 },
			created: at,
			updated: at,
		};
		store.write(lesson);
		runtime.present("memory.stored", lesson, place.turn);
		for (const old of refined) {
			setStatus(old.id, "superseded");
			runtime.present("memory.merged", { id: old.id, into: id, how: "refines" }, place.turn);
		}
		return { kind: "stored", lesson, replaced: [...contradicted, ...refined] };
	};

	// What the current user turn has done: the steps for its digest, what the monitor saw, and the last check.
	let turnOf = -1;
	let steps: string[] = [];
	let dropped = 0;
	let stepCount = 0;
	let trouble: { detail: string[]; step: number } | undefined;
	let lastCheck: { step: number; failed: boolean } | undefined;
	let lastRun: { finalMessage: string } | undefined;
	let outcomeAsked = false;
	/** The lessons brought into this turn, until the judge has said whether they were followed. */
	let injected: readonly string[] | undefined;
	const sync = () => {
		if (turnOf === runtime.userTurns) return;
		turnOf = runtime.userTurns;
		steps = [];
		dropped = 0;
		stepCount = 0;
		trouble = undefined;
		lastCheck = undefined;
		lastRun = undefined;
		outcomeAsked = false;
		injected = undefined;
	};
	const digest = (finalMessage: string) =>
		turnDigest({ request: runtime.turn.userMessage, steps, dropped, finalMessage });

	// Read side ------------------------------------------------------------------------------------------

	const candidates = (cwd: string): StoredLesson[] => rankForRecall(store.all(), cwd, options.maxCandidates);
	const recall = (words: string, lessons: readonly StoredLesson[], signal?: AbortSignal) =>
		runtime.engine.decide(memoryRecall, { userMessage: clip(words, 400), lessons }, { signal });
	/** The recall asked the moment the message arrived, alongside preflight. */
	let early: { turn: number; lessons: StoredLesson[]; decision: ReturnType<typeof recall> } | undefined;
	runtime.atTurnStart((words) => {
		const cwd = runtime.ctx?.cwd;
		if (!cwd || runtime.mode(memoryRecall.id) === "off") return;
		const lessons = candidates(cwd);
		if (lessons.length === 0) return;
		const decision = recall(words, lessons);
		decision.catch(() => {});
		early = { turn: runtime.userTurns, lessons, decision };
	});

	pi.on(
		"before_agent_start",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			sync();
			instructions = projectInstructions(event.systemPromptOptions.contextFiles);
			if (event.messageType === "custom") return undefined;
			const started = early?.turn === runtime.userTurns ? early : undefined;
			early = undefined;
			if (runtime.turn.preflight?.needsMemory === "no") return undefined;
			const lessons = started?.lessons ?? candidates(ctx.cwd);
			if (lessons.length === 0) return undefined;
			const pending = started?.decision ?? recall(userWords(event.prompt), lessons, ctx.signal);
			// Shadow records the verdict; only an active one is worth holding the turn for.
			if (runtime.mode(memoryRecall.id) !== "active") {
				void pending.catch(() => {});
				return undefined;
			}

			runtime.progress("checking lessons from earlier sessions", "lessons");
			const decision = await runtime.untilTurnDeadline(pending, options.waitMs);
			if (!decision || decision.source !== "judge") return undefined;
			// The candidates are ranked, the most followed first: those are the ones that get the places.
			const chosen = lessons
				.filter((lesson) => decision.outcome.apply.includes(lesson.id))
				.slice(0, options.maxInjected);
			if (chosen.length === 0) return undefined;
			injected = chosen.map((lesson) => lesson.id);
			const recalledAt = now();
			countUses(injected, (uses) => ({ ...uses, recalled: uses.recalled + 1, lastRecalled: recalledAt }));
			runtime.present("memory.recalled", { ids: injected, turn: runtime.userTurns });
			return {
				message: {
					customType: "kyrn.lessons",
					content: `Lessons from earlier sessions that apply here:\n${chosen.map((lesson) => `- ${lesson.lesson}`).join("\n")}`,
					display: true,
				},
			};
		}),
	);

	/** Once per turn, in the background: were the lessons brought into it followed? The rule that retires a lesson reads the answer. */
	const judgeApplied = (finalMessage: string): void => {
		const ids = injected;
		injected = undefined;
		if (!options.applied || !ids || ids.length === 0) return;
		const lessons = ids.flatMap((id) => {
			const lesson = store.get(id);
			return lesson ? [lesson] : [];
		});
		if (lessons.length === 0) return;
		const turn = runtime.userTurns;
		void runtime.engine
			.decide(memoryApplied, { lessons, turnDigest: digest(finalMessage) })
			.then((decision) => {
				if (decision.source !== "judge") return;
				const { applied, notApplied } = decision.outcome;
				countUses(applied, (uses) => ({ ...uses, applied: uses.applied + 1 }));
				if (applied.length > 0) runtime.present("memory.applied", { ids: applied }, turn);
				if (options.retireAfter <= 0) return;
				for (const id of notApplied) {
					const lesson = store.get(id);
					// A rule, not a question: recalled that often and never followed, it only holds a place another lesson could use.
					if (
						lesson?.status === "active" &&
						lesson.uses.applied === 0 &&
						lesson.uses.recalled >= options.retireAfter
					) {
						retire(id, "unused", turn);
					}
				}
			})
			.catch(() => {});
	};

	/** For each sub-agent task, the lessons that apply to it: the "known lessons" of its brief. No use accounting. */
	runtime.knownLessons = async (tasks, signal) => {
		const none = tasks.map((): readonly string[] => []);
		const cwd = runtime.ctx?.cwd;
		if (!cwd || tasks.length === 0) return none;
		const lessons = candidates(cwd);
		if (lessons.length === 0) return none;
		const pending = runtime.engine.decideMany(
			memoryRecallForTask,
			tasks.map((task) => ({ task: clip(task, 600), lessons })),
			{ signal },
		);
		// Shadow records what it would have given; only an active verdict is worth holding the sub-agents for.
		if (runtime.mode(memoryRecallForTask.id) !== "active") {
			void pending.catch(() => {});
			return none;
		}
		const decisions = await within(
			pending.catch(() => undefined),
			options.waitMs,
		);
		if (!decisions) return none;
		const turn = runtime.userTurns;
		return decisions.map((decision, index) => {
			if (decision.source !== "judge") return [];
			const chosen = lessons
				.filter((lesson) => decision.outcome.apply.includes(lesson.id))
				.slice(0, options.maxInjected);
			if (chosen.length > 0) {
				runtime.present("memory.recalled", {
					ids: chosen.map((lesson) => lesson.id),
					turn,
					task: clip(tasks[index], 120),
				});
			}
			return chosen.map((lesson) => lesson.lesson);
		});
	};

	// Write side: the user --------------------------------------------------------------------------------

	// The capture reads what the agent said last. Admission keeps it too; memory must not depend on that being on.
	pi.on(
		"message_end",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			const message = event.message as { role?: unknown; content?: unknown };
			if (message.role !== "assistant") return undefined;
			const text = textOf(message.content);
			if (text.trim()) runtime.lastAssistantText = text;
			return undefined;
		}),
	);

	/** The writer phrases a correction as a lesson. Without one, the user's own words are kept. */
	const phraseCorrection = async (words: string, previous: string): Promise<LessonText> => {
		const writer = runtime.writer();
		if (writer) {
			try {
				const reply = await writer({
					system: CORRECTION_PROMPT,
					user: `Assistant said:\n${clip(previous, 600)}\n\nUser replied:\n${clip(words, 600)}`,
					signal: AbortSignal.timeout(WRITER_TIMEOUT_MS),
				});
				const phrased = parsePhrase(reply.text);
				if (phrased) return phrased;
			} catch {
				// Keep the user's own words.
			}
		}
		return lessonText(words, words);
	};

	pi.on(
		"input",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			if (event.source === "extension" || event.streamingBehavior || !event.text.trim()) return undefined;
			const previous = runtime.lastAssistantText;
			if (!previous || !learns(ctx)) return undefined;
			// What the person typed, without a host's preamble: that is what a lesson in their words keeps.
			const words = userWords(event.text);
			const place = placeOf(ctx);
			void runtime.engine
				.decide(memoryCapture, {
					userMessage: clip(words, 400),
					previousAssistantMessage: clip(previous, 400),
				})
				.then(async (decision) => {
					if (decision.source !== "judge" || decision.outcome === "skip") return;
					const phrased = await phraseCorrection(words, previous);
					await keep({ ...phrased, kind: decision.outcome, origin: "user" }, place);
				})
				.catch(() => {});
			return undefined;
		}),
	);

	// Write side: the agent's own way out -----------------------------------------------------------------

	runtime.onTrouble((kind, detail) => {
		// Drift is a judge's guess about the course and names no failing call: there is no way out of it to learn.
		if (kind === "drift") return;
		sync();
		trouble ??= { detail: [], step: stepCount };
		// The latest trouble counts: a check that passed before it is no way out of it.
		trouble.step = stepCount;
		if (trouble.detail.length < 3) trouble.detail.push(`${kind}: ${detail}`);
	});

	/** Who puts a way out into words, which nobody said: the writer model, else the conversation's own. */
	const phraser = (ctx: ExtensionContext): LlmCompletion | undefined =>
		runtime.writer() ??
		(ctx.model ? runtime.llm(`${ctx.model.provider}/${ctx.model.id}`, { thinking: "off" }) : undefined);

	/** At most once per turn, and only after trouble that the turn got out of. Adds nothing to an ordinary turn. */
	const learnFromOutcome = (ctx: ExtensionContext): void => {
		if (!options.outcome || outcomeAsked || !trouble || !lastRun || !learns(ctx)) return;
		const phrase = phraser(ctx);
		// Nobody could write the lesson down, so there is nothing to ask about.
		if (!phrase) return;
		outcomeAsked = true;
		const place = placeOf(ctx);
		const what = trouble.detail.join("\n");
		const happened = digest(lastRun.finalMessage);
		void (async () => {
			const decision = await runtime.engine.decide(memoryOutcome, { trouble: what, turnDigest: happened });
			if (decision.source !== "judge" || decision.outcome !== "learn") return;
			const reply = await phrase({
				system: WAY_OUT_PROMPT,
				user: `The agent ran into this:\n${what}\n\nWhat happened, oldest first:\n${happened}`,
				signal: AbortSignal.timeout(WRITER_TIMEOUT_MS),
			});
			const phrased = parsePhrase(reply.text);
			if (phrased) await keep({ ...phrased, kind: "workaround", origin: "outcome" }, place);
		})().catch(() => {});
	};

	// Write side: sub-agents' reports ---------------------------------------------------------------------

	/** `Lesson:` lines of the reports that came back, judged together, kept one at a time. */
	const learnFromReports = (reports: readonly string[], place: Place): void => {
		const found = reports.flatMap((report) => lessonLinesOf(report)).slice(0, MAX_REPORT_LESSONS);
		if (found.length === 0) return;
		const known = instructions;
		void (async () => {
			const decision = await runtime.engine.decide(memoryWorth, { lessons: found, projectInstructions: known });
			if (decision.source !== "judge") return;
			// One after the other: two sub-agents that learned the same thing store it once.
			for (const [index, lesson] of found.entries()) {
				if (decision.outcome[index] === "reusable")
					await keep({ ...lesson, kind: "fact", origin: "subagent" }, place);
			}
		})().catch(() => {});
	};

	pi.on(
		"tool_result",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			sync();
			const toolName = "toolName" in event ? String(event.toolName) : "tool";
			const input = (event.input ?? {}) as Record<string, unknown>;
			stepCount++;
			steps.push(`${describeCall(toolName, input)} -> ${event.isError ? "error" : "ok"}`);
			if (steps.length > MAX_KEPT_STEPS) {
				steps.splice(HEAD_KEPT, 1);
				dropped++;
			}
			const command = isShellTool(toolName) ? String(input.command ?? "") : "";
			if (command && isCheckCommand(command)) lastCheck = { step: stepCount, failed: event.isError };
			if ((toolName === "delegate" || toolName === "hive") && !event.isError && learns(ctx)) {
				learnFromReports(reportsOf(event), placeOf(ctx));
			}
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>((event, ctx) => {
			runtime.touch(ctx);
			sync();
			const last = [...event.messages].reverse().find((message) => message.role === "assistant") as
				| { content?: unknown; stopReason?: string }
				| undefined;
			// Cut short by the user or by an error: nothing to judge about how it ended.
			if (!last || last.stopReason === "aborted" || last.stopReason === "error") return undefined;
			lastRun = { finalMessage: textOf(last.content) };
			judgeApplied(lastRun.finalMessage);
			// The turn ended with a passing check after the last trouble: the agent found a way out.
			if (trouble && lastCheck && !lastCheck.failed && lastCheck.step > trouble.step) learnFromOutcome(ctx);
			return undefined;
		}),
	);

	// Or the goal holds: the goal's own check runs after this feature's end of run, and says so here.
	runtime.observe("goal.state", (payload) => {
		if ((payload as { status?: unknown } | undefined)?.status !== "met") return;
		sync();
		const ctx = runtime.ctx;
		if (ctx && trouble) learnFromOutcome(ctx);
	});

	// Write side: the model -------------------------------------------------------------------------------

	const notKept = (verdict: "one_off" | "already_known"): string =>
		verdict === "one_off"
			? "Not stored: the judge read it as mattering for this task only."
			: "Not stored: the judge read it as known already, from the project's instructions or as common practice.";

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description:
			"Keep a lesson for later sessions in this project: something you learned that will help again, such as a trap and the way around it, or a fact about the project that is written down nowhere. Say when it applies (trigger) and what to do then (lesson), one sentence each. A judgment model turns it down when it only matters for this task or is known already, and folds it into a kept lesson that says the same.",
		parameters: Type.Object({
			trigger: Type.String({ description: "When the lesson applies: the situation or the error, one sentence" }),
			lesson: Type.String({ description: "What to do then: one imperative sentence" }),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			runtime.touch(ctx);
			const answer = (text: string, details: Record<string, string | boolean>) => ({
				content: [{ type: "text" as const, text }],
				details,
			});
			const candidate = lessonText(params.trigger ?? "", params.lesson ?? "");
			if (!candidate.trigger || !candidate.lesson) {
				return answer("Not stored: say both when it applies (trigger) and what to do then (lesson).", {
					stored: false,
				});
			}
			const decision = await runtime.engine.decide(
				memoryWorth,
				{ lessons: [candidate], projectInstructions: instructions },
				{ signal },
			);
			const verdict: WorthVerdict = decision.source === "judge" ? (decision.outcome[0] ?? "unclear") : "unclear";
			// The model's call is a vote already: only a judge that read the lesson as not worth keeping turns it down.
			// Without a verdict, or with "cannot tell", it is kept; the merge and the retire rule clean up after it.
			if (verdict === "one_off" || verdict === "already_known") {
				return answer(notKept(verdict), { stored: false, verdict });
			}
			const kept = await keep({ ...candidate, kind: "fact", origin: "model" }, placeOf(ctx), signal);
			if (kept.kind === "same") {
				return answer(`Already kept: a lesson says the same. ${kept.existing.lesson}`, {
					stored: false,
					verdict,
					id: kept.existing.id,
				});
			}
			if (kept.kind === "outranked") {
				return answer(`Not stored: it contradicts a kept lesson, which stands. ${kept.existing.lesson}`, {
					stored: false,
					verdict,
					id: kept.existing.id,
				});
			}
			const replaced = kept.replaced.map((old) => old.lesson);
			return answer(
				`Stored: ${kept.lesson.lesson}${replaced.length > 0 ? `\nIt replaces: ${replaced.join(" | ")}` : ""}`,
				{ stored: true, verdict, id: kept.lesson.id },
			);
		},
	});
	runtime.catalog.register({
		id: "tool:remember",
		kind: "tool",
		title: "Remember",
		description:
			"Keep a lesson for later sessions in this project, judged worth keeping and merged with the kept ones.",
		tools: ["remember"],
		exposure: "always",
	});

	// Commands --------------------------------------------------------------------------------------------

	const describe = (lesson: StoredLesson): string => {
		const marks = [
			...(lesson.status === "active" ? [] : [say(STATUS_WORDS[lesson.status])]),
			...(lesson.scope.cwd === undefined ? [say({ zh: "到处适用", en: "global" })] : []),
		];
		const said = `${lesson.id.slice(0, 8)} · ${say(KIND_WORDS[lesson.kind])} · ${lesson.uses.recalled}/${lesson.uses.applied} · ${lesson.lesson}`;
		return marks.length > 0 ? `${said} (${marks.join(", ")})` : said;
	};
	/** This project's own active lessons; with `all`, also those for everywhere and the retired ones. The most followed first. */
	const listing = (cwd: string, all: boolean): string => {
		const shown = store
			.all()
			.filter((lesson) => (all ? inScope(lesson, cwd) : lesson.status === "active" && lesson.scope.cwd === cwd))
			.sort(
				(a, b) =>
					Number(b.status === "active") - Number(a.status === "active") ||
					b.uses.applied - a.uses.applied ||
					b.updated.localeCompare(a.updated),
			);
		if (shown.length === 0) {
			return all
				? say({ zh: "这个项目没有经验。", en: "No lessons for this project." })
				: say({
						zh: "这个项目还没有经验。/lessons all 连到处适用的和已退役的一起看。",
						en: "No lessons for this project yet. /lessons all also shows global and retired lessons.",
					});
		}
		const header = say({ zh: "id · 类型 · 召回/照做 · 经验", en: "id · kind · recalled/followed · lesson" });
		return [header, ...shown.map(describe)].join("\n");
	};

	pi.registerCommand("remember", {
		description: say({
			zh: "给这个项目记一条经验，以后的会话都会用上：/remember <该怎么做>",
			en: "Save a lesson for later work in this project: /remember <what to do>",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const text = args.trim();
			if (!text) {
				ctx.ui.notify(listing(ctx.cwd, false), "info");
				return;
			}
			// The user's own word: no judge decides whether it is worth keeping, only whether it is kept already.
			const kept = await keep({ ...lessonText(text, text), kind: "preference", origin: "command" }, placeOf(ctx));
			if (kept.kind === "stored") {
				const replaced = kept.replaced.map((old) => `- ${old.lesson}`);
				ctx.ui.notify(
					replaced.length > 0
						? `${say({ zh: "记下了，它替代了：", en: "Saved. It replaces:" })}\n${replaced.join("\n")}`
						: say({ zh: "记下了。", en: "Saved." }),
					"info",
				);
				return;
			}
			ctx.ui.notify(
				say({ zh: `已经记着了：${kept.existing.lesson}`, en: `Already saved: ${kept.existing.lesson}` }),
				"info",
			);
		},
	});

	pi.registerCommand("lessons", {
		description: say({
			zh: "这个项目的经验：/lessons 列出 id · 类型 · 召回/照做次数 · 经验，/lessons all 连到处适用的和已退役的一起列",
			en: "List this project's lessons (id · kind · recalled/followed · lesson); /lessons all adds global and retired lessons",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			ctx.ui.notify(listing(ctx.cwd, args.trim().toLowerCase() === "all"), "info");
		},
	});

	pi.registerCommand("forget", {
		description: say({
			zh: "让一条经验退役，以后不再召回：/forget <id 前几位>（id 见 /lessons）",
			en: "Retire a lesson so it's no longer recalled: /forget <id prefix> (find IDs with /lessons)",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const prefix = args.trim().toLowerCase();
			if (!prefix) {
				ctx.ui.notify(
					say({
						zh: "用法：/forget <id 前几位>。/lessons 列出 id。",
						en: "Usage: /forget <id prefix>. /lessons lists the ids.",
					}),
					"info",
				);
				return;
			}
			const matches = store
				.all()
				.filter((lesson) => inScope(lesson, ctx.cwd) && lesson.id.toLowerCase().startsWith(prefix));
			const [only] = matches;
			if (!only) {
				ctx.ui.notify(
					say({
						zh: `这个项目没有以 ${prefix} 开头的经验。`,
						en: `No lesson in this project starts with ${prefix}.`,
					}),
					"warning",
				);
				return;
			}
			if (matches.length > 1) {
				ctx.ui.notify(
					`${say({ zh: `有 ${matches.length} 条以 ${prefix} 开头，多给几位：`, en: `${matches.length} lessons start with ${prefix}; type more of the id:` })}\n${matches.map(describe).join("\n")}`,
					"warning",
				);
				return;
			}
			if (only.status !== "active") {
				ctx.ui.notify(
					say({ zh: `它已经不在用了：${describe(only)}`, en: `That lesson isn't active: ${describe(only)}` }),
					"info",
				);
				return;
			}
			retire(only.id, "forgotten", runtime.userTurns);
			ctx.ui.notify(say({ zh: `已退役：${only.lesson}`, en: `Retired: ${only.lesson}` }), "info");
		},
	});
}
