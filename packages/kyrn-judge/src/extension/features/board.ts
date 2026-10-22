import { join } from "node:path";
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionContext,
	MessageEndEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	addModelHelp,
	boardModelChoices,
	type ModelLike,
	otherModelChoices,
	RECOMMENDED_BOARD_MODELS,
	refOf,
	SESSION_MODEL,
} from "../../board/model.ts";
import {
	type BoardFacts,
	type BoardLanguage,
	type BoardText,
	languageOf,
	narratorRequest,
	narratorSystem,
	parseBoardText,
	plainBoard,
} from "../../board/narrate.ts";
import {
	type BoardNote,
	type NoteCode,
	type NoteKind,
	type NoteParams,
	noteText,
	parseBoardNote,
	reasonTail,
	shortPath,
} from "../../board/notes.ts";
import { BoardProjects } from "../../board/projects.ts";
import { isCheckCommand } from "../../checkpoint/mutating.ts";
import {
	type BoardEvent,
	type BoardInput,
	type BoardPhase,
	type BoardStep,
	boardRead,
	describeEvent,
	MAX_EVENTS,
	MAX_KEY,
} from "../../decisions/board-read.ts";
import { appLanguage, say } from "../../language.ts";
import type { LlmCompletion } from "../../providers/llm.ts";
import { environmentSecrets, redactSecrets } from "../../redact.ts";
import { activeRuns, type SwarmSnapshot } from "../../swarm/run.ts";
import { type BeeState, type BeeStatus, isOver, isRunning } from "../../swarm/state.ts";
import { clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";
import { describeCall } from "./constraints.ts";
import type { HarnessRoots } from "./inherit.ts";

/** Stored in the session, so a reopened session shows where it stood. */
export const BOARD_ENTRY = "kyrn.board";
const WIDGET_KEY = "mu-board";
/** Events kept: enough for a long run's tail, and for the news picked earlier in it. */
const MAX_LOG = 64;
/** Lines of the running account kept in memory, and sent with each board so a reopened session has them. */
const MAX_NOTES = 200;
const LOG_LINES = 40;
/** The latest account lines the writer is shown, so it adds to them instead of repeating them. */
const ACCOUNT_LINES = 6;
/** Tools that change a file: the account names the file. */
const CHANGE_TOOLS = new Set(["edit", "write", "sg_rewrite", "conflicts_resolve", "apply_patch_from"]);
/** Reading and looking up: when it went fine, nothing a person would hear about. */
const ROUTINE_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"locate",
	"find_skill",
	"find_capability",
	"bg_output",
	"web_search",
	"web_fetch",
]);

/** Tools that send sub-agents out: while they work the agent takes no step of its own, so the board looks on a clock. */
const SWARM_TOOLS = new Set(["delegate", "hive"]);

/** What a permission asks for, in the person's words: the kinds the permissions feature names. */
const PERMISSION_KINDS: Readonly<Record<string, { zh: string; en: string }>> = {
	edit: { zh: "改文件", en: "edit a file" },
	shell: { zh: "运行命令", en: "run a command" },
	run: { zh: "运行程序", en: "run a program" },
	outside: { zh: "改动项目外的文件", en: "change a file outside the project" },
	delegate: { zh: "派出子代理", en: "start subagents" },
	other: { zh: "对外操作", en: "act outside this computer" },
};

/** How many sub-agents a delegation sends out, and for what: the task titles, or the hive's goal. */
export function swarmParts(
	name: string,
	input: Record<string, unknown>,
): { count: number; titles: string } | undefined {
	if (name === "delegate" && Array.isArray(input.tasks)) {
		const titles = input.tasks.map((task) => {
			const title = (task as { title?: unknown } | null)?.title;
			return typeof title === "string" && title.trim() ? title.trim() : "a task";
		});
		return { count: titles.length, titles: titles.join(", ") };
	}
	if (name === "hive" && Array.isArray(input.bees)) {
		return { count: input.bees.length, titles: clip(String(input.goal ?? ""), 120) };
	}
	return undefined;
}

/** A delegation as a person hears of it: how many were sent and for what, not the JSON of the call. */
export function describeSwarmCall(name: string, input: Record<string, unknown>): string | undefined {
	const parts = swarmParts(name, input);
	if (!parts) return undefined;
	if (name === "hive") return `${parts.count} investigator${parts.count === 1 ? "" : "s"} on: ${parts.titles}`;
	return `${parts.count} subagent${parts.count === 1 ? "" : "s"}: ${parts.titles}`;
}

/** The sub-agents at work, a line per run, for the judge and the writer: who is doing what, who is back. */
export function describeSwarms(snapshots: readonly SwarmSnapshot[]): string | undefined {
	if (snapshots.length === 0) return undefined;
	return snapshots
		.map((snapshot) => {
			const bees = snapshot.bees;
			const finished = bees.filter((bee) => isOver(bee.status)).length;
			const each = bees.map((bee) => {
				const who = bee.role ? `${bee.name} (${bee.role})` : bee.name;
				if (bee.status === "done") return `${who}: back${bee.said ? `, said: ${clip(bee.said, 120)}` : ""}`;
				if (isOver(bee.status)) return `${who}: ${bee.status}${bee.error ? ` (${clip(bee.error, 80)})` : ""}`;
				if (bee.status === "queued") return `${who}: waiting for a slot`;
				const doing = bee.tool
					? `${bee.tool.name} ${clip(bee.tool.summary, 60)}`
					: bee.said
						? `said: ${clip(bee.said, 80)}`
						: bee.status;
				return `${who}: ${doing}`;
			});
			const kind = snapshot.kind === "hive" ? "hive" : "delegate";
			return `${kind}, ${bees.length} subagent${bees.length === 1 ? "" : "s"} (${finished} finished): ${each.join("; ")}`;
		})
		.join("\n");
}

/**
 * Where each sub-agent stands, as one string: waiting for a slot, at work, wrapping up, or how it ended. What it
 * is doing at work (thinking, a tool, a retry) is left out.
 */
export function swarmState(runs: readonly { readonly bees: readonly BeeState[] }[] = activeRuns()): string {
	const stand = (status: BeeStatus) => (isRunning(status) && status !== "wrapping-up" ? "working" : status);
	return runs.map((run) => run.bees.map((bee) => `${bee.name}:${stand(bee.status)}`).join(",")).join("|");
}

interface LoggedEvent extends BoardEvent {
	readonly sequence: number;
	/** Picked as news for a board that was written. */
	key?: boolean;
}

export interface BoardUpdate extends BoardText {
	readonly phase?: BoardPhase;
	/** The id of the acceptance item being worked on. */
	readonly focus?: string;
	/** That item's text (the user's or the model's words), so a client can say what is being worked on. */
	readonly focusText?: string;
	readonly needsUser: boolean;
	/** Acceptance items done, and in all. */
	readonly done: number;
	readonly total: number;
	/** Who wrote the words: the plain-speaking model, or the fixed sentences. */
	readonly by: "model" | "rules";
	/** Written when the agent had stopped, rather than while it worked. */
	readonly ended: boolean;
	/**
	 * What the judge picked as news, as the session has it (commands, paths, the agent's words): the plain
	 * words above are the writer's telling of these. Since the last update, or over the whole run once it ended.
	 */
	readonly news?: readonly string[];
	/** The latest lines of the running account, oldest first: what the agent did, as the board told it. */
	readonly log?: readonly BoardNote[];
}

export function parseBoardEntry(data: unknown): BoardUpdate | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const value = data as Record<string, unknown>;
	if (typeof value.now !== "string" || typeof value.progress !== "string") return undefined;
	return {
		progress: value.progress,
		now: value.now,
		confirm: Array.isArray(value.confirm) ? value.confirm.filter((item) => typeof item === "string") : [],
		phase: typeof value.phase === "string" ? (value.phase as BoardPhase) : undefined,
		focus: typeof value.focus === "string" ? value.focus : undefined,
		...(typeof value.focusText === "string" ? { focusText: value.focusText } : {}),
		...(Array.isArray(value.confirmCodes)
			? {
					confirmCodes: value.confirmCodes.map((code) => (typeof code === "string" ? code : null)),
				}
			: {}),
		needsUser: value.needsUser === true,
		done: typeof value.done === "number" ? value.done : 0,
		total: typeof value.total === "number" ? value.total : 0,
		by: value.by === "model" ? "model" : "rules",
		ended: value.ended === true,
		...(Array.isArray(value.news) ? { news: value.news.filter((line) => typeof line === "string") } : {}),
		...(Array.isArray(value.log) ? { log: value.log.flatMap((line) => parseBoardNote(line) ?? []) } : {}),
	};
}

/**
 * The board above the editor of the terminal: the desktop draws its own panel from the presentation events.
 * `latest` is the newest line of the running account, shown under the state.
 */
export function boardWidget(board: BoardUpdate, language: BoardLanguage, latest?: BoardNote): string[] {
	const zh = language === "zh";
	return [
		`${zh ? "\u03bc 看板" : "\u03bc board"} · ${board.progress}`,
		`  ${board.now}`,
		...board.confirm.map((item) => `  ${zh ? "要你确认" : "Needs you"}: ${item}`),
		...(latest ? [`  · ${latest.text}`] : []),
	];
}

/** For `/board`: the state, then the latest lines of the running account (`account`, else the board's own log). */
export function describeBoard(
	board: BoardUpdate | undefined,
	language: BoardLanguage,
	account?: readonly BoardNote[],
): string {
	if (!board) return language === "zh" ? "看板还没有内容：等代理做一会儿再看。" : "Nothing on the board yet.";
	const zh = language === "zh";
	const lines = [`${zh ? "进展" : "Progress"}: ${board.progress}`, `${zh ? "正在做" : "Now"}: ${board.now}`];
	if (board.confirm.length > 0) {
		lines.push(`${zh ? "需要你确认" : "Waiting on you"}:`, ...board.confirm.map((item) => `  - ${item}`));
	}
	const told = (account ?? board.log ?? []).slice(-8);
	if (told.length > 0) lines.push(`${zh ? "它做了什么" : "What it did"}:`, ...told.map((note) => `  · ${note.text}`));
	return lines.join("\n");
}

/**
 * The plain-language board: where the work stands, in words a person who is
 * not a programmer can follow. The judge reads the session by multiple
 * choice (the phase, the acceptance item being worked on, whether the user is
 * needed, whether anything changed) every few tool calls and when the agent
 * stops; only when it sees something new does a model that explains well
 * write the board again. The board is for the person only: nothing of it
 * reaches the working model's context.
 *
 * What the writer is told is picked by the judge too: every step, item
 * ticked and thing the agent said is logged, and at each look the judge sorts
 * what happened since the last board into news and routine. When the run
 * ends, it picks again over the whole run (the news it picked before, and
 * what came after), and the board sums the run up. So the person has two
 * accounts of the same work: the agent's own, in the conversation, and the
 * board's, in plain words.
 *
 * The board also keeps a running account, so the person is never left with
 * "done" and no idea what was done: every step becomes one fixed sentence the
 * moment it ends (a file changed, a check passed or failed, a command run;
 * reading is folded into one growing line), free of any model call, and
 * every time the agent says something the judge is asked at once whether it
 * is news. When it is, the writer retells it for a person, and its telling
 * joins the account. The summing up at the end is the account's last line.
 *
 * Off by default and switched per project (`/board on`), because every
 * update costs a model call. The first time it is switched on, the person
 * picks the model that writes it (`/board model` changes it later).
 */
export function registerBoard(runtime: KyrnRuntime, roots: HarnessRoots | undefined): void {
	const options = runtime.options("board", {
		enabled: true,
		/** For projects nobody switched. Off: every update costs a model call. */
		defaultOn: false,
		/**
		 * The model that writes the board, "provider/model". Empty: the one picked with /board model (kept in
		 * <agentDir>/mu/board.json), else the writer model, else the session's.
		 */
		model: "",
		/** zh, en, or auto: the language the user writes in. */
		language: "auto",
		/** Tool calls between two looks while the agent works. */
		everyTools: 5,
		/** At least this long between two looks while the agent works. */
		minIntervalMs: 20000,
		/** Tool calls the judge sees, for what the agent is doing now. */
		maxSteps: 10,
		narrateTimeoutMs: 60000,
		/**
		 * Also in one-shot runs (`--print`, json mode). Off: nobody watches a board there, the terminal shows none and
		 * the summing up is cut off when the process exits, so every look would only cost judge and writer calls.
		 */
		unattended: false,
		/**
		 * While sub-agents work, look every `minIntervalMs` even when none of them started, finished or failed since
		 * the last look.
		 */
		followAlways: false,
	});
	if (!options.enabled || process.env.KYRN_SWARM_CONTROL) return;
	const { pi } = runtime;
	const projects = new BoardProjects(roots ? join(roots.agentDir, "mu") : undefined);
	const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
	let steps: BoardStep[] = [];
	let latest = "";
	/** What happened, numbered: the candidates the judge picks the news from. */
	let events: LoggedEvent[] = [];
	let sequence = 0;
	/** The last event a written board covered. */
	let reported = 0;
	/**
	 * The last event the judge weighed while the agent worked. What it called routine is not asked about again
	 * at the next look; the summing up at the end weighs the whole run once more.
	 */
	let judged = 0;
	/** The last event before this run started. */
	let runStart = 0;
	/** A check ran or an item was ticked: the next look need not wait for `everyTools` more steps. */
	let moment = false;
	/** The chosen model is not usable here: said once per session. */
	let toldUnusable = false;
	let toolsSinceLook = 0;
	let lastLookAt = 0;
	let board: BoardUpdate | undefined;
	/** The running account, oldest first. */
	let notes: BoardNote[] = [];
	/** The line "looked at N files" that grows while the agent reads file after file; anything else ends it. */
	let reading: BoardNote | undefined;
	/** The clock the board looks by while sub-agents work. */
	let following: ReturnType<typeof setInterval> | undefined;
	/** The sub-agents' states (`swarmState`) at the last look. */
	let swarmSeen = "";
	/** The person's turn the current run belongs to: a run mu starts itself (a goal continuation, a nudge) carries it on. */
	let turnSeen = -1;
	/** A permission the agent is waiting for, shown the moment it is asked. */
	let pendingAsk: { id: string; summary: string } | undefined;
	let looking: Promise<void> | undefined;
	/** A look asked for while another ran: done right after it, once. */
	let again: boolean | undefined;
	/** Bumped when the session ends or another one starts: a look still running then belongs to a session that is gone. */
	let epoch = 0;
	let retired = new AbortController();
	const retire = () => {
		epoch++;
		retired.abort();
		retired = new AbortController();
		again = undefined;
	};

	/** On here: switched on for the project, in a run someone watches (the terminal, the desktop app). */
	const on = (ctx: ExtensionContext) =>
		(options.unattended || ctx.mode === "tui" || ctx.mode === "rpc") && (projects.get(ctx.cwd) ?? options.defaultOn);
	/** The model named in kyrn.json, else the one the person picked: "provider/id", or "session". */
	const chosen = (): string | undefined => options.model || projects.model();
	const usable = (ctx: ExtensionContext, ref: string): boolean => {
		const slash = ref.indexOf("/");
		const model = slash > 0 ? ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
		return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
	};
	/** The model that writes the board now: the chosen one while it is usable, else the writer, else the conversation's. */
	const writerRef = (ctx: ExtensionContext): string | undefined => {
		const picked = chosen();
		if (picked && picked !== SESSION_MODEL && usable(ctx, picked)) return picked;
		if (picked !== SESSION_MODEL && runtime.config.writer) return runtime.config.writer;
		return ctx.model ? refOf(ctx.model) : undefined;
	};
	/** The recommended models, and which of them the person could pick right now. */
	const recommended = (ctx: ExtensionContext) => {
		const available = ctx.modelRegistry.getAvailable();
		return RECOMMENDED_BOARD_MODELS.map((model) => ({
			name: model.name,
			ref: available.map(refOf).find((ref) => model.pattern.test(ref)) ?? null,
		}));
	};
	/** For the panel: a model has to be added (the person asked how), or the chosen one cannot be used here. */
	const modelNeeded = (ctx: ExtensionContext, reason: "add" | "unusable", extra: Record<string, string> = {}) =>
		runtime.present("board.model_needed", { cwd: ctx.cwd, reason, recommended: recommended(ctx), ...extra });
	/** What this process last told the panel. */
	let shown: boolean | undefined;
	/**
	 * Tells the panel whether the board is on here, when it asks or when it changed. Another conversation on the
	 * same project may have switched it: the switch is the project's, so this one follows and says so.
	 */
	const announce = (ctx: ExtensionContext, always = false): boolean => {
		const switched = on(ctx);
		if (always || switched !== shown) {
			shown = switched;
			runtime.present("board.switched", {
				on: switched,
				cwd: ctx.cwd,
				model: writerRef(ctx) ?? null,
				modelChosen: chosen() !== undefined,
			});
			if (!always) showWidget(ctx);
		}
		return switched;
	};
	const showWidget = (ctx: ExtensionContext | undefined) => {
		if (!ctx?.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_KEY, board && on(ctx) ? boardWidget(board, language(), notes.at(-1)) : undefined);
	};
	/** A fixed language first, then the app's (MU_LANG), then the language the user writes in. */
	const language = (): BoardLanguage => {
		if (options.language === "zh" || options.language === "en") return options.language;
		return appLanguage()?.wording ?? languageOf(`${runtime.frame?.goal ?? ""} ${runtime.turn.userMessage}`);
	};
	/** What the writer is told to write in: the app's own language when it has one mu has no wording for. */
	const writeIn = (): string | undefined =>
		options.language === "zh" || options.language === "en" ? undefined : appLanguage()?.name;

	/** The plain-speaking model. A chosen one that cannot be used here (signed out, say) is said once, then stood in for. */
	const writerModel = (ctx: ExtensionContext): LlmCompletion | undefined => {
		const picked = chosen();
		if (picked && picked !== SESSION_MODEL && !usable(ctx, picked) && !toldUnusable) {
			toldUnusable = true;
			modelNeeded(ctx, "unusable", { model: picked });
			if (ctx.hasUI) {
				ctx.ui.notify(
					words({
						zh: `看板选的模型 ${picked} 现在用不了，先用 ${writerRef(ctx) ?? "对话的模型"} 来写。/board model 可以换一个。`,
						en: `The board's model ${picked} isn't available here, so ${writerRef(ctx) ?? "the session's model"} is writing it for now. Use /board model to pick another.`,
					}),
					"warning",
				);
			}
		}
		const ref = writerRef(ctx);
		return ref ? runtime.llm(ref, { thinking: "off" }) : undefined;
	};
	const words = (texts: { readonly zh: string; readonly en: string }) => (language() === "zh" ? texts.zh : texts.en);
	/** Who writes the board, in words: a model, or the conversation's own. */
	const writerName = (ctx: ExtensionContext): string => {
		const ref = writerRef(ctx);
		const picked = chosen();
		if (picked && picked !== SESSION_MODEL && ref === picked) return ref;
		return words({
			zh: `对话用的模型${ref ? `（现在是 ${ref}）` : ""}`,
			en: `the session's model${ref ? ` (currently ${ref})` : ""}`,
		});
	};

	/**
	 * The person picks the board's model: the recommended ones first, then whatever the conversation uses,
	 * then any other they have, or how to add one. Nothing is kept when they close it or want to add one.
	 */
	const chooseModel = async (ctx: ExtensionContext): Promise<string | undefined> => {
		const available: readonly ModelLike[] = ctx.modelRegistry.getAvailable();
		const choices = boardModelChoices(available, ctx.model, language());
		const answer = await ctx.ui.select(
			words({
				zh: "人话看板请哪个模型来讲？每次更新调用它一次。",
				en: "Which model should write the plain-language board? Each update costs one call.",
			}),
			choices.map((choice) => choice.label),
		);
		const choice = choices.find((entry) => entry.label === answer);
		if (!choice) return undefined;
		if (choice.kind === "add") {
			ctx.ui.notify(addModelHelp(language(), choice.recommended), "info");
			modelNeeded(ctx, "add", choice.recommended ? { name: choice.recommended.name } : {});
			return undefined;
		}
		let ref = choice.kind === "model" ? choice.ref : undefined;
		if (choice.kind === "other") {
			const others = otherModelChoices(available);
			const second = await ctx.ui.select(
				words({ zh: "选一个模型", en: "Pick a model" }),
				others.map((other) => other.label),
			);
			ref = others.find((other) => other.label === second)?.ref;
		}
		if (!ref) return undefined;
		projects.setModel(ref);
		return ref;
	};

	const log = (event: BoardEvent) => {
		events = [...events.slice(-(MAX_LOG - 1)), { ...event, sequence: ++sequence }];
	};
	/** Steps worth weighing: reading that went fine tells a person nothing, an item ticked or a check is a moment. */
	const record = (name: string, input: Record<string, unknown>, step: BoardStep) => {
		if (name === "todo" && !step.failed) {
			const action = String(input.action ?? "");
			const item = runtime.frame?.acceptance.find((entry) => entry.id === input.id);
			if (action === "done" && item) {
				log({
					kind: "ticked",
					text: clip(`${item.id} ${item.text}${item.evidence ? ` (${item.evidence})` : ""}`, 300),
				});
				moment = true;
			} else if (action === "add") {
				log({ kind: "step", text: clip(`added to the checklist: ${String(input.text ?? "")}`, 300) });
			}
			return;
		}
		if (!step.failed && ROUTINE_TOOLS.has(name)) return;
		log({
			kind: "step",
			text: `${name} ${step.what} -> ${step.failed ? "error" : "ok"}`,
			...(step.failed ? { failed: true } : {}),
			...(step.check ? { check: true } : {}),
		});
		if (step.check) moment = true;
	};
	/** A line of the account, shown at once; the same line sent again (same sequence and time) replaces itself. */
	const noteNow = (note: BoardNote) => {
		const index = notes.findIndex((known) => known.sequence === note.sequence && known.at === note.at);
		notes =
			index >= 0
				? notes.map((known, at) => (at === index ? note : known))
				: [...notes.slice(-(MAX_NOTES - 1)), note];
		runtime.present("board.note", note);
		showWidget(runtime.ctx);
	};
	/** A fixed sentence on the account, when the board is on here. */
	const tell = (kind: NoteKind, code: NoteCode, params: NoteParams, failed = false) => {
		reading = undefined;
		const ctx = runtime.ctx;
		if (!ctx || !on(ctx)) return;
		noteNow({
			sequence: ++sequence,
			at: Date.now(),
			kind,
			text: noteText(code, params, language()),
			by: "rules",
			code,
			...(Object.keys(params).length > 0 ? { params } : {}),
			...(failed ? { failed: true } : {}),
		});
	};
	/** The writer's own words on the account. */
	const tellModel = (kind: NoteKind, text: string) => {
		reading = undefined;
		noteNow({ sequence: ++sequence, at: Date.now(), kind, text, by: "model" });
	};
	/** Reading that went fine: one line that counts up, not a line per file. */
	const looked = () => {
		const ctx = runtime.ctx;
		if (!ctx || !on(ctx)) return;
		const count = Number(reading?.params?.count ?? 0) + 1;
		const params = { count };
		reading = {
			sequence: reading?.sequence ?? ++sequence,
			at: reading?.at ?? Date.now(),
			kind: "step",
			text: noteText("looked", params, language()),
			by: "rules",
			code: "looked",
			params,
		};
		noteNow(reading);
	};
	/** The account's line for a step, the moment it ended. */
	const account = (name: string, input: Record<string, unknown>, step: BoardStep) => {
		if (!step.failed && ROUTINE_TOOLS.has(name)) {
			looked();
			return;
		}
		if (name === "todo") {
			if (step.failed) return;
			const action = String(input.action ?? "");
			const item = runtime.frame?.acceptance.find((entry) => entry.id === input.id);
			if (action === "done" && item) tell("ticked", "item_done", { item: clip(item.text, 120) });
			else if (action === "add") tell("step", "item_added", { item: clip(String(input.text ?? ""), 120) });
			return;
		}
		if (SWARM_TOOLS.has(name)) {
			tell("helpers", "helpers_back", { count: swarmParts(name, input)?.count ?? 0 }, step.failed);
			return;
		}
		if (isShellTool(name)) {
			const command = clip(String(input.command ?? ""), 80);
			if (step.check) tell("check", step.failed ? "check_failed" : "check_passed", { command }, step.failed);
			else tell("step", step.failed ? "command_failed" : "ran_command", { command }, step.failed);
			return;
		}
		const path = String(input.path ?? input.file_path ?? input.file ?? "");
		if (CHANGE_TOOLS.has(name) && path) {
			tell(
				"step",
				name === "write" ? "wrote_file" : "changed_file",
				{ file: clip(shortPath(path), 80) },
				step.failed,
			);
			return;
		}
		tell("step", "did", { tool: name, what: clip(describeCall(name, input), 80) }, step.failed);
	};
	/**
	 * What the judge picks the news from: what happened since the last board. Once the run ended, the news it
	 * picked earlier in this run as well, so the summing up covers the whole run and not only its tail.
	 */
	const candidates = (ended: boolean): LoggedEvent[] => {
		const earlier = ended
			? events
					.filter((event) => event.key && event.sequence > runStart && event.sequence <= reported)
					.slice(-MAX_KEY)
			: [];
		const since = ended ? Math.max(reported, runStart) : Math.max(reported, judged);
		const fresh = events.filter((event) => event.sequence > since).slice(-(MAX_EVENTS - earlier.length));
		return [...earlier, ...fresh];
	};

	const look = async (ctx: ExtensionContext, ended: boolean): Promise<void> => {
		const at = epoch;
		const gone = retired.signal;
		const upTo = sequence;
		moment = false;
		swarmSeen = swarmState();
		const weighed = candidates(ended);
		const frame = runtime.frame;
		const items = (frame?.acceptance ?? []).map((item) => ({ id: item.id, text: item.text, done: item.done }));
		const swarm = describeSwarms(activeRuns().map((run) => run.snapshot()));
		const input: BoardInput = {
			goal: frame?.goal ?? runtime.turn.userMessage,
			items,
			steps: steps.slice(-options.maxSteps),
			latest,
			ended,
			events: weighed,
			last: board ? { phase: board.phase, focus: board.focus, now: board.now } : undefined,
			...(swarm ? { swarm } : {}),
		};
		const decision = await runtime.engine.decide(boardRead, input);
		const read = decision.outcome;
		if (at !== epoch) return;
		toolsSinceLook = 0;
		lastLookAt = Date.now();
		// More happened while the judge read: the look queued behind this one covers all of it, this one would
		// only cost a writer call for a board that is already out of date.
		if (!ended && again !== undefined) return;
		if (!ended && decision.source === "judge") judged = Math.max(judged, upTo);
		if (!read.update) return;

		const focusItem = read.focus ? items.find((item) => item.id === read.focus) : undefined;
		const news = read.key.flatMap((index) => (weighed[index] ? [weighed[index]] : []));
		const facts: BoardFacts = {
			language: language(),
			goal: input.goal,
			items,
			phase: read.phase,
			focus: focusItem?.text,
			needsUser: read.needsUser,
			// With the news picked, the last few steps are enough to say what it is doing now.
			steps: (weighed.length > 0 ? input.steps.slice(-4) : input.steps).map(
				(step) => `${step.tool} ${step.what} -> ${step.failed ? "error" : "ok"}`,
			),
			latest: clip(latest, 1200),
			...(weighed.length > 0 ? { keyEvents: news.map(describeEvent) } : {}),
			ended,
			...(swarm ? { swarm } : {}),
			...(notes.length > 0 ? { account: notes.slice(-ACCOUNT_LINES).map((note) => note.text) } : {}),
		};
		let text: BoardText | undefined;
		const complete = writerModel(ctx);
		if (complete) {
			try {
				const reply = await complete({
					system: narratorSystem(facts.language, writeIn()),
					// The writer tells what the agent did, never the key it did it with.
					user: redactSecrets(narratorRequest(facts), environmentSecrets()),
					signal: AbortSignal.any([AbortSignal.timeout(options.narrateTimeoutMs), gone]),
				});
				text = parseBoardText(reply.text);
			} catch {
				text = undefined;
			}
		}
		if (at !== epoch) return;
		// The account: the writer's telling of the news, or, when it did not answer, the agent's own last
		// words as a quote; a run that ended gets its last line either way.
		const lastKind = news.at(-1)?.kind;
		const kind: NoteKind = ended ? "ended" : lastKind === "ticked" ? "ticked" : lastKind === "said" ? "said" : "step";
		const said = [...news].reverse().find((event) => event.kind === "said");
		if (text?.note) tellModel(kind, text.note);
		else if (ended) tell("ended", read.needsUser ? "waiting_reply" : "ended", {});
		else if (complete && said) tell("said", "said_quote", { text: clip(said.text, 160) });
		const update: BoardUpdate = {
			...(text ?? plainBoard(facts)),
			phase: read.phase,
			focus: read.focus ?? undefined,
			...(focusItem ? { focusText: focusItem.text } : {}),
			needsUser: read.needsUser,
			done: items.filter((item) => item.done).length,
			total: items.length,
			by: text ? "model" : "rules",
			ended,
			...(news.length > 0 ? { news: news.map(describeEvent) } : {}),
			...(notes.length > 0 ? { log: notes.slice(-LOG_LINES) } : {}),
		};
		for (const event of news) event.key = true;
		reported = Math.max(reported, upTo);
		board = update;
		pi.appendEntry<BoardUpdate>(BOARD_ENTRY, update);
		runtime.present("board.update", update);
		showWidget(runtime.ctx ?? ctx);
	};

	/** One look at a time, in the background: the board never holds up the agent. */
	const schedule = (ctx: ExtensionContext, ended: boolean) => {
		if (looking) {
			again = (again ?? false) || ended;
			return;
		}
		looking = look(ctx, ended)
			.catch(() => undefined)
			.finally(() => {
				looking = undefined;
				const next = again;
				again = undefined;
				if (next !== undefined) schedule(runtime.ctx ?? ctx, next);
			});
	};

	const unfollow = () => {
		if (following) clearInterval(following);
		following = undefined;
	};
	/**
	 * While sub-agents work, a look every interval at what they are doing, until they are back: only when one of
	 * them started, finished or failed since the last look. What a bee is doing at the moment (its tool line)
	 * changes all the time and is no news: in a 45-minute run, 65 of 77 looks came from this clock with nothing
	 * new, and each cost a writer call.
	 */
	const follow = (ctx: ExtensionContext) => {
		if (following) return;
		following = setInterval(
			() => {
				if (activeRuns().length === 0) {
					unfollow();
					return;
				}
				if (on(ctx) && (options.followAlways || swarmState() !== swarmSeen)) schedule(ctx, false);
			},
			Math.max(options.minIntervalMs, 1000),
		);
		following.unref?.();
	};

	/** The board as fixed sentences, for a line that cannot wait for a look: nothing has been said yet. */
	const emptyBoard = (): BoardUpdate => {
		const items = (runtime.frame?.acceptance ?? []).map((item) => ({
			id: item.id,
			text: item.text,
			done: item.done,
		}));
		const text = plainBoard({
			language: language(),
			goal: runtime.frame?.goal ?? runtime.turn.userMessage,
			items,
			needsUser: false,
			steps: [],
			latest: "",
		});
		return {
			...text,
			needsUser: false,
			done: items.filter((item) => item.done).length,
			total: items.length,
			by: "rules",
			ended: false,
			...(notes.length > 0 ? { log: notes.slice(-LOG_LINES) } : {}),
		};
	};
	/** Says something on the board now, without a look: what the person has to act on cannot wait for the next one. */
	const sayNow = (update: BoardUpdate) => {
		board = update;
		runtime.present("board.update", update);
		showWidget(runtime.ctx);
	};

	// A permission the agent waits for is the one thing the person must act on: it is on the board the moment it is asked.
	runtime.observe("permissions.request", (payload) => {
		const ctx = runtime.ctx;
		const ask = payload as { id?: unknown; kind?: unknown; summary?: unknown };
		if (!ctx || !on(ctx) || typeof ask.id !== "string" || typeof ask.summary !== "string") return;
		pendingAsk = { id: ask.id, summary: ask.summary };
		const kind = PERMISSION_KINDS[String(ask.kind)] ?? PERMISSION_KINDS.other;
		const line = words({
			zh: `mu 想${kind.zh}：${ask.summary}。在等你允许。`,
			en: `mu wants to ${kind.en}: ${ask.summary}. It's waiting for your permission.`,
		});
		sayNow({ ...(board ?? emptyBoard()), confirm: [line], confirmCodes: [null], needsUser: true, ended: false });
	});
	runtime.observe("permissions.resolved", (payload) => {
		const answer = payload as { id?: unknown; answer?: unknown };
		if (!pendingAsk || answer.id !== pendingAsk.id) return;
		const { summary } = pendingAsk;
		pendingAsk = undefined;
		const denied = answer.answer === "deny";
		log({
			kind: "step",
			text: `asked the person's permission for: ${summary} -> ${denied ? "not allowed" : "allowed"}`,
			...(denied ? { failed: true } : {}),
		});
		tell("asked", denied ? "permission_denied" : "permission_allowed", { summary: clip(summary, 120) }, denied);
		if (board?.needsUser) sayNow({ ...board, confirm: [], confirmCodes: [], needsUser: false });
	});

	// Goal mode: a run mu sends back to work has not ended for the person; what the check said is news.
	runtime.observe("goal.state", (payload) => {
		const state = payload as {
			status?: unknown;
			text?: unknown;
			reason?: unknown;
			next?: unknown;
			continuations?: unknown;
		};
		const reason = typeof state.reason === "string" && state.reason ? clip(state.reason, 160) : "";
		const tail = reasonTail(reason, language());
		if (state.status === "active" && typeof state.continuations === "number" && state.continuations > 0) {
			const next = typeof state.next === "string" && state.next ? ` (next: ${clip(state.next, 160)})` : "";
			log({
				kind: "step",
				text: `mu sent it back to work, round ${state.continuations}${reason ? `: ${reason}` : ""}${next}`,
			});
			tell("goal", "goal_round", { round: state.continuations, reason: tail });
		} else if (state.status === "met") {
			const text = clip(String(state.text ?? ""), 200);
			log({ kind: "ticked", text: `the goal holds: ${text}` });
			tell("goal", "goal_met", { text });
		} else if (state.status === "paused") {
			log({ kind: "step", text: `the goal is paused${reason ? `: ${reason}` : ""}`, failed: true });
			tell("goal", "goal_paused", { reason: tail }, true);
		} else return;
		moment = true;
		const ctx = runtime.ctx;
		if (ctx && on(ctx)) schedule(ctx, false);
	});

	// The monitor's word that the agent goes in circles is what a person would most want to hear, and at once.
	runtime.onTrouble((kind, detail) => {
		log({
			kind: "step",
			text:
				kind === "loop"
					? `mu noticed it repeating the same step: ${clip(detail, 160)}`
					: `mu noticed: ${clip(detail, 160)}`,
			failed: true,
		});
		tell("trouble", kind === "loop" ? "trouble_loop" : "trouble", { detail: clip(detail, 160) }, true);
		moment = true;
		const ctx = runtime.ctx;
		if (ctx && on(ctx)) schedule(ctx, false);
	});

	pi.on(
		"session_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			retire();
			unfollow();
			pendingAsk = undefined;
			board = undefined;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === BOARD_ENTRY)
					board = parseBoardEntry(entry.data) ?? board;
			}
			steps = [];
			latest = "";
			events = [];
			notes = board?.log ? [...board.log] : [];
			reading = undefined;
			reported = sequence;
			judged = sequence;
			runStart = sequence;
			moment = false;
			toldUnusable = false;
			toolsSinceLook = 0;
			// A panel opening with the session learns whether the board is on here, and what it said last.
			const switched = announce(ctx, true);
			if (board && switched) runtime.present("board.update", { ...board, restored: true });
			showWidget(ctx);
			return undefined;
		}),
	);

	pi.on(
		"session_shutdown",
		failOpen(() => {
			retire();
			unfollow();
			return undefined;
		}),
	);

	pi.on(
		"tool_execution_start",
		failOpen<ToolExecutionStartEvent, undefined>((event, ctx) => {
			const input = (typeof event.args === "object" && event.args !== null ? event.args : {}) as Record<
				string,
				unknown
			>;
			calls.set(event.toolCallId, { name: event.toolName, input });
			if (SWARM_TOOLS.has(event.toolName)) {
				log({ kind: "step", text: `sent out ${describeSwarmCall(event.toolName, input) ?? "subagents"}` });
				const parts = swarmParts(event.toolName, input);
				tell("helpers", "helpers_sent", { count: parts?.count ?? 0, titles: parts?.titles ?? "" });
				moment = true;
				if (announce(ctx)) follow(ctx);
			}
			return undefined;
		}),
	);

	pi.on(
		"tool_execution_end",
		failOpen<ToolExecutionEndEvent, undefined>((event, ctx) => {
			runtime.touch(ctx);
			const call = calls.get(event.toolCallId);
			calls.delete(event.toolCallId);
			const name = call?.name ?? event.toolName;
			const input = call?.input ?? {};
			if (SWARM_TOOLS.has(name)) unfollow();
			const command = isShellTool(name) ? String(input.command ?? "") : "";
			const step: BoardStep = {
				tool: name,
				what: clip(describeSwarmCall(name, input) ?? describeCall(name, input), 160),
				failed: event.isError,
				check: command !== "" && isCheckCommand(command),
			};
			steps = [...steps.slice(-(options.maxSteps * 2)), step];
			record(name, input, step);
			account(name, input, step);
			toolsSinceLook++;
			if (!announce(ctx)) return undefined;
			// A moment (a check, an item ticked, helpers sent or back) is looked at right away; plain steps every
			// few, and not too often.
			if (moment || (toolsSinceLook >= options.everyTools && Date.now() - lastLookAt >= options.minIntervalMs)) {
				schedule(ctx, false);
			}
			return undefined;
		}),
	);

	pi.on(
		"message_end",
		failOpen<MessageEndEvent, undefined>((event, ctx) => {
			if (event.message.role !== "assistant") return undefined;
			const said = textOf((event.message as { content?: unknown }).content).trim();
			if (!said) return undefined;
			latest = said;
			reading = undefined;
			log({ kind: "said", text: clip(said.replace(/\s+/g, " "), 300) });
			// What the agent says is the jargon the board exists to retell: the judge is asked at once whether it
			// is news, and the writer speaks only when it is. A message that ends the run is covered by the look
			// the end brings a moment later.
			if (event.message.stopReason === "toolUse" && announce(ctx)) schedule(ctx, false);
			return undefined;
		}),
	);

	pi.on(
		"agent_start",
		failOpen<AgentStartEvent, undefined>(() => {
			// A run mu starts itself (a goal continuation, a nudge) carries the person's turn on: one summing up covers it all.
			if (runtime.userTurns !== turnSeen) {
				turnSeen = runtime.userTurns;
				runStart = sequence;
			}
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>((_event, ctx) => {
			runtime.touch(ctx);
			reading = undefined;
			// With a goal still running, the goal check has just sent the agent back: nothing has ended for the person.
			if (announce(ctx)) schedule(ctx, !runtime.goalActive);
			return undefined;
		}),
	);

	pi.registerCommand("board", {
		description: say({
			zh: "人话看板：/board 查看，/board on、/board off 为这个项目打开或关闭，/board model 换个模型来讲",
			en: "Show the plain-language board; /board on|off turns it on or off for this project, /board model picks the model that writes it",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const [first = "", ...rest] = args.trim().split(/\s+/);
			const word = first.toLowerCase();
			const zh = language() === "zh";
			if (word === "model") {
				const ref = rest.join(" ").trim();
				if (ref) {
					if (ref !== SESSION_MODEL && !usable(ctx, ref)) {
						if (ctx.hasUI) {
							ctx.ui.notify(
								`${words({ zh: `${ref} 现在用不了。`, en: `${ref} isn't available here.` })}\n${addModelHelp(language())}`,
								"warning",
							);
						}
						return;
					}
					projects.setModel(ref);
				} else if (!ctx.hasUI || !(await chooseModel(ctx))) {
					return;
				}
				toldUnusable = false;
				announce(ctx, true);
				if (ctx.hasUI) {
					ctx.ui.notify(
						words({
							zh: `看板现在由 ${writerName(ctx)} 来讲。`,
							en: `The board is now written by ${writerName(ctx)}.`,
						}),
						"info",
					);
				}
				return;
			}
			if (word === "on" || word === "off") {
				projects.set(ctx.cwd, word === "on");
				announce(ctx, true);
				showWidget(ctx);
				// The first time: who should speak for the board. Closing the picker leaves it to the conversation's model.
				if (word === "on" && ctx.hasUI && chosen() === undefined && (await chooseModel(ctx))) announce(ctx, true);
				if (ctx.hasUI) {
					ctx.ui.notify(
						word === "on"
							? zh
								? `这个项目的人话看板已打开：代理每做一步，看板就记一行；它说的话、发现的事，由 ${writerName(ctx)} 用大白话讲给你。每讲一次调用一次模型。`
								: `The plain-language board is on for this project. Each step adds a line, and ${writerName(ctx)} retells what the agent says or finds in plain words. Each retelling costs one model call.`
							: zh
								? "这个项目的人话看板已关闭。"
								: "The plain-language board is off for this project.",
						"info",
					);
				}
				// Switched on in the middle of things: the first board need not wait for the next tool call. Switched on
				// once the agent stopped (the desktop's switch waits for that), it sums the run up as ended.
				if (word === "on" && on(ctx) && (steps.length > 0 || latest))
					schedule(ctx, ctx.isIdle() && !runtime.goalActive);
				return;
			}
			if (!ctx.hasUI) return;
			if (!on(ctx)) {
				ctx.ui.notify(
					zh
						? "这个项目没有打开人话看板。/board on 打开。"
						: "The board is off for this project. Turn it on with /board on.",
					"info",
				);
				return;
			}
			ctx.ui.notify(describeBoard(board, zh ? "zh" : "en", notes), "info");
		},
	});
}
