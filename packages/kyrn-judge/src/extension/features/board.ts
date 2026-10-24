import { join } from "node:path";
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionContext,
	MessageEndEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
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
	type BoardStall,
	type BoardText,
	duration,
	narratorRequest,
	narratorSystem,
	parseBoardText,
	plainBoard,
	rulesHeadline,
	type WriterReply,
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
	stepLine,
} from "../../decisions/board-read.ts";
import { type AppLanguage, appLanguage, count, say, writingLanguage } from "../../language.ts";
import type { LlmCompletion } from "../../providers/llm.ts";
import { environmentSecrets, redactSecrets } from "../../redact.ts";
import { activeRuns, type SwarmSnapshot } from "../../swarm/run.ts";
import { type BeeState, type BeeStatus, isOver, isRunning, reportOf } from "../../swarm/state.ts";
import { clip, failOpen, type KyrnRuntime, textOf, userWords } from "../runtime.ts";
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
/** Mid-run, a board the writer has not written by then is out of date: it gets this long, and no longer. */
const LIVE_TIMEOUT_MS = 20_000;
/** Mid-run the writer's reply is one short JSON object: a runaway one only costs time. */
const LIVE_MAX_TOKENS = 600;
/** A stall is told again at these multiples of `stallMs`: 1, 3 and 10 minutes by default. */
const STALL_STEPS = [1, 3, 10];
/** A subagent this long without a sign of life is said to have had no new output. */
const QUIET_MS = 30_000;
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

/** The first line of a report worth reading: not a warning or a "cut short" note in brackets, no heading marks. */
export function firstLine(text: string): string {
	const line = text
		.split("\n")
		.map((part) =>
			part
				.trim()
				.replace(/^[#*>\s-]+/, "")
				.replace(/\*\*/g, ""),
		)
		.find((part) => part && !/^\(.*\)$/.test(part));
	return line ?? "";
}

/** What a subagent's tool call works on, without the tool's name its summary starts with ("bash npm test"). */
const beeArgs = (tool: { name: string; summary: string }) =>
	tool.summary.startsWith(`${tool.name} `) ? tool.summary.slice(tool.name.length + 1) : tool.summary;
/** What a subagent's tool call works on: the command, or the tool and what it works on. */
const beeWhat = (tool: { name: string; summary: string }) =>
	clip(isShellTool(tool.name) ? beeArgs(tool) : `${tool.name} ${beeArgs(tool)}`, 80);

/** One subagent, as the judge and the writer read it: how it ended, or what it is doing and for how long. */
function describeBee(bee: BeeState, now: number): string {
	const who = bee.role && bee.role !== bee.name ? `${bee.name} (${bee.role})` : bee.name;
	const ran = duration((bee.endedAt ?? now) - (bee.startedAt ?? bee.queuedAt));
	const failures = bee.toolErrors > 0 ? `; ${count(bee.toolErrors, "failed step")}` : "";
	if (bee.status === "done") {
		const report = firstLine(reportOf(bee) || bee.said || "");
		return `${who}: back after ${ran}${report ? `; reported: "${clip(report, 160)}"` : ""}${failures}`;
	}
	if (isOver(bee.status)) {
		const how = bee.status === "timed-out" ? "timed out" : bee.status;
		return `${who}: ${how} after ${ran}${bee.error ? `: ${clip(bee.error, 100)}` : ""}${failures}`;
	}
	if (bee.status === "queued") return `${who}: waiting for a slot`;
	const quiet = now - bee.lastEventAt;
	const silence = quiet >= QUIET_MS ? `; no new output for ${duration(quiet)}` : "";
	if (bee.retry) {
		const { attempt, maxAttempts, message } = bee.retry;
		return `${who}: retrying after an error (attempt ${attempt} of ${maxAttempts}): ${clip(message, 80)}${failures}`;
	}
	if (bee.status === "tool" && bee.tool) {
		return `${who}: running ${bee.tool.name} \`${clip(beeArgs(bee.tool), 80)}\` for ${duration(now - bee.tool.startedAt)}${silence}${failures}`;
	}
	if (bee.status === "wrapping-up") return `${who}: writing its report${silence}${failures}`;
	const said = bee.said ? `; last said: "${clip(bee.said, 80)}"` : "";
	return `${who}: thinking, ${ran} in${said}${silence}${failures}`;
}

/**
 * The subagents at work, for the judge and the writer: a header per run (what kind, sent how long ago, how many
 * are back), then a line per subagent naming it exactly as the writer must, with what it is doing and for how long,
 * how long it has been silent, its failed steps, a retry, or what it reported.
 */
export function describeSwarms(snapshots: readonly SwarmSnapshot[], now = Date.now()): string | undefined {
	if (snapshots.length === 0) return undefined;
	return snapshots
		.map((snapshot) => {
			const bees = snapshot.bees;
			const finished = bees.filter((bee) => isOver(bee.status)).length;
			const kind = snapshot.kind === "hive" ? "hive" : "delegate";
			const header = `${kind}, sent ${duration(now - snapshot.startedAt)} ago, ${count(bees.length, "subagent")} (${finished} finished):`;
			return [header, ...bees.map((bee) => `- ${describeBee(bee, now)}`)].join("\n");
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

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ERROR_LINE =
	/\b(?:error|fail(?:ed|ure|s)?|expected|assert(?:ion)?|exception|traceback|panic(?:ked)?|denied|refused|timed? ?out|not found|cannot)\b|^[×✗✕✖]/i;

/**
 * Why a step failed, as its output says: its first error-like lines (or its last lines when none looks like one),
 * at most 300 characters, credentials taken out. The writer can then say why a check failed, not only that it did.
 */
export function failureExcerpt(result: unknown): string | undefined {
	const text = textOf((result as { content?: unknown } | undefined)?.content).replace(ANSI, "");
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return undefined;
	const errors = lines.filter((line) => ERROR_LINE.test(line) && !/\b0 (?:failed|errors?)\b/i.test(line));
	const picked = (errors.length > 0 ? errors.slice(0, 3) : lines.slice(-2)).join(" | ");
	return clip(redactSecrets(picked, environmentSecrets()), 300);
}

interface LoggedEvent extends BoardEvent {
	readonly sequence: number;
	/** Picked as news for a board that was written. */
	key?: boolean;
}

/** One subagent on the board, by rule: who it is, where it stands, what it is doing and for how long. */
export interface BoardAgent {
	readonly who: string;
	readonly role?: string;
	readonly state: "working" | "waiting" | "done" | "failed" | "stuck";
	/** The writer's words when it gave some for this exact name, else the rules' summary. */
	readonly doing: string;
	/** How long it has been in this state. */
	readonly sinceMs?: number;
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
	/** The subagents at work, built by rules from the live runs: absent without any. The main agent is not listed. */
	readonly agents?: readonly BoardAgent[];
	/** When this board was made (epoch ms), so a client can say how fresh it is. */
	readonly updatedAt?: number;
}

const AGENT_STATES = new Set(["working", "waiting", "done", "failed", "stuck"]);
const paramsOf = (value: unknown): NoteParams | undefined =>
	typeof value === "object" && value !== null
		? (Object.fromEntries(
				Object.entries(value as Record<string, unknown>).filter(
					([, item]) => typeof item === "string" || typeof item === "number",
				),
			) as NoteParams)
		: undefined;

export function parseBoardEntry(data: unknown): BoardUpdate | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const value = data as Record<string, unknown>;
	if (typeof value.now !== "string" || typeof value.progress !== "string") return undefined;
	const text = (key: string) => (typeof value[key] === "string" ? { [key]: value[key] as string } : {});
	const coded = (key: string) => {
		const params = paramsOf(value[`${key}Params`]);
		return typeof value[`${key}Code`] === "string"
			? { [`${key}Code`]: value[`${key}Code`] as string, ...(params ? { [`${key}Params`]: params } : {}) }
			: {};
	};
	const agents = Array.isArray(value.agents)
		? value.agents.flatMap((entry): BoardAgent[] => {
				const agent = (entry ?? {}) as Record<string, unknown>;
				if (typeof agent.who !== "string" || typeof agent.doing !== "string") return [];
				if (typeof agent.state !== "string" || !AGENT_STATES.has(agent.state)) return [];
				return [
					{
						who: agent.who,
						...(typeof agent.role === "string" ? { role: agent.role } : {}),
						state: agent.state as BoardAgent["state"],
						doing: agent.doing,
						...(typeof agent.sinceMs === "number" ? { sinceMs: agent.sinceMs } : {}),
					},
				];
			})
		: [];
	return {
		...text("headline"),
		...coded("headline"),
		progress: value.progress,
		now: value.now,
		...text("blocked"),
		...coded("blocked"),
		...text("next"),
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
		...(agents.length > 0 ? { agents } : {}),
		...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
	};
}

/**
 * The board above the editor of the terminal, three lines at most: the headline, then what waits on the person
 * or what is stuck, then the newest line of the running account (`latest`). `/board` shows the rest. The desktop
 * draws its own panel from the presentation events.
 */
export function boardWidget(board: BoardUpdate, language: BoardLanguage, latest?: BoardNote): string[] {
	const zh = language === "zh";
	const [first, ...more] = board.confirm;
	const second =
		first !== undefined
			? `  ${zh ? "要你确认" : "Needs you"}: ${first}${more.length > 0 ? ` (+${more.length})` : ""}`
			: board.blocked
				? `  ${zh ? "卡在" : "Blocked"}: ${board.blocked}`
				: undefined;
	return [
		`\u03bc ${board.headline || board.now}`,
		...(second ? [second] : []),
		...(latest ? [`  · ${latest.text}`] : []),
	];
}

/** How a subagent that did not finish well ended, in words. */
const ENDINGS: Readonly<Record<string, { zh: string; en: string }>> = {
	failed: { zh: "出错了", en: "failed" },
	"timed-out": { zh: "超时了", en: "timed out" },
	stopped: { zh: "被停了", en: "was stopped" },
};

/**
 * One subagent on the board, by rule. Stuck: in a tool call with no sign of life for `stallMs`. `sinceMs` counts
 * from when it entered its state: queued, ended, gone quiet, or started its tool call or its work.
 */
export function agentOf(bee: BeeState, now: number, stallMs: number, zh: boolean): BoardAgent {
	const quiet = now - bee.lastEventAt;
	const stuck = bee.status === "tool" && stallMs > 0 && quiet >= stallMs;
	const say = (texts: { zh: string; en: string }) => (zh ? texts.zh : texts.en);
	let state: BoardAgent["state"];
	let doing: string;
	let since: number;
	if (bee.status === "done") {
		state = "done";
		doing = clip(firstLine(reportOf(bee) || bee.said || ""), 80) || say({ zh: "做完了", en: "done" });
		since = now - (bee.endedAt ?? now);
	} else if (isOver(bee.status)) {
		state = "failed";
		doing = `${say(ENDINGS[bee.status] ?? ENDINGS.failed)}${bee.error ? `: ${clip(bee.error, 60)}` : ""}`;
		since = now - (bee.endedAt ?? now);
	} else if (bee.status === "queued") {
		state = "waiting";
		doing = say({ zh: "等空位", en: "waiting for a slot" });
		since = now - bee.queuedAt;
	} else if (bee.retry) {
		const { attempt, maxAttempts } = bee.retry;
		state = "waiting";
		doing = say({
			zh: `出错后重试（第 ${attempt}/${maxAttempts} 次）`,
			en: `retrying after an error (${attempt} of ${maxAttempts})`,
		});
		since = now - bee.lastEventAt;
	} else if (bee.tool) {
		state = stuck ? "stuck" : "working";
		doing = beeWhat(bee.tool);
		since = stuck ? quiet : now - bee.tool.startedAt;
	} else {
		state = "working";
		doing =
			bee.status === "wrapping-up"
				? say({ zh: "在写报告", en: "writing its report" })
				: say({ zh: "在想", en: "thinking" });
		since = now - (bee.startedAt ?? now);
	}
	return {
		who: bee.name,
		...(bee.role && bee.role !== bee.name ? { role: bee.role } : {}),
		state,
		doing,
		sinceMs: Math.max(0, since),
	};
}

const AGENT_WORDS: Record<BoardAgent["state"], { zh: string; en: string }> = {
	working: { zh: "在干", en: "working" },
	waiting: { zh: "在等", en: "waiting" },
	done: { zh: "回来了", en: "done" },
	failed: { zh: "出错了", en: "failed" },
	stuck: { zh: "没动静", en: "stuck" },
};

/** For `/board`: everything the widget leaves out, then the latest lines of the account (`account`, else the board's own log). */
export function describeBoard(
	board: BoardUpdate | undefined,
	language: BoardLanguage,
	account?: readonly BoardNote[],
): string {
	if (!board) return language === "zh" ? "看板还没有内容：等代理做一会儿再看。" : "Nothing on the board yet.";
	const zh = language === "zh";
	const lines = [
		...(board.headline && board.headline !== board.now ? [board.headline] : []),
		`${zh ? "正在做" : "Now"}: ${board.now}`,
		...(board.blocked ? [`${zh ? "卡在" : "Blocked"}: ${board.blocked}`] : []),
		...(board.next ? [`${zh ? "接下来" : "Next"}: ${board.next}`] : []),
		...(board.progress ? [`${zh ? "进展" : "Progress"}: ${board.progress}`] : []),
	];
	if (board.agents?.length) {
		lines.push(
			`${zh ? "助手" : "Subagents"}:`,
			...board.agents.map((agent) => {
				const state = AGENT_WORDS[agent.state][zh ? "zh" : "en"];
				const since = agent.sinceMs !== undefined ? `, ${duration(agent.sinceMs)}` : "";
				return `  - ${agent.who} (${state}${since}): ${agent.doing}`;
			}),
		);
	}
	if (board.confirm.length > 0) {
		lines.push(`${zh ? "需要你确认" : "Waiting on you"}:`, ...board.confirm.map((item) => `  - ${item}`));
	}
	const told = (account ?? board.log ?? []).slice(-8);
	if (told.length > 0) lines.push(`${zh ? "它做了什么" : "What it did"}:`, ...told.map((note) => `  · ${note.text}`));
	return lines.join("\n");
}

/**
 * The plain-language board: where the work stands, told like a teammate's quick spoken update to the person
 * coordinating it: who is doing what, what is stuck on what, what comes next. The judge reads the session by
 * multiple choice (the phase, the acceptance item being worked on, whether the user is needed, whether anything
 * changed) every few tool calls and when the agent stops; only when it sees something new does a model that
 * speaks well write the board again. The board is for the person only: nothing of it reaches the working
 * model's context.
 *
 * What the writer is told is picked by the judge too: every step, item ticked and thing the agent said is
 * logged, and at each look the judge sorts what happened since the last board into news and routine. When the
 * run ends, it picks again over the whole run (the news it picked before, and what came after), and the board
 * sums the run up. The writer also sees the board the person sees now, what is in flight and for how long, the
 * subagents' detail, and why a failed step failed, so it tells what changed instead of rewording the last board.
 *
 * The board also keeps a running account, so the person is never left with "done" and no idea what was done:
 * every step becomes one fixed sentence the moment it ends, free of any model call; a subagent back or failed
 * gets a line of its own; and a tool call or a subagent that goes a minute without finishing or a sign of life
 * gets one line that grows in place (1, 3, 10 minutes), with a look each time, so the board says what is stuck
 * while it is stuck. Every time the agent says something the judge is asked at once whether it is news. When it
 * is, the writer retells it for a person, and its telling joins the account.
 *
 * Off by default and switched per project (`/board on`), because every update costs a model call. The first
 * time it is switched on, the person picks the model that writes it (`/board model` changes it later).
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
		/** zh, en, or auto: the writer writes in the language the person writes in, fixed sentences follow the app. */
		language: "auto",
		/** Tool calls between two looks while the agent works. */
		everyTools: 5,
		/** At least this long between two looks while the agent works. */
		minIntervalMs: 20000,
		/** Tool calls the judge sees, for what the agent is doing now. */
		maxSteps: 10,
		/** The writer's time at the end of a run; mid-run it gets 20 s at most (`LIVE_TIMEOUT_MS`). */
		narrateTimeoutMs: 60000,
		/**
		 * A tool call or a subagent's tool call this long without finishing (a subagent: without a sign of life) is
		 * said to be stuck, and again at 3 and 10 times this. 0: never.
		 */
		stallMs: 60000,
		/**
		 * A look whose news was overtaken by more while the judge read leaves the writing to the look after it, unless
		 * the board the person sees is older than this: then it writes anyway, so a chatty agent cannot keep the
		 * board from ever being written.
		 */
		maxStaleMs: 15000,
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
	/** Tool calls in flight: since when, and when they last streamed output. */
	const calls = new Map<
		string,
		{ name: string; input: Record<string, unknown>; startedAt: number; outputAt?: number }
	>();
	let steps: BoardStep[] = [];
	let latest = "";
	/** The person's latest messages, newest last: the language the writer writes in is read from them. */
	let said: string[] = [];
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
	/** When the person's run started (a goal's continuations carry it on). */
	let runStartedAt: number | undefined;
	/** A check ran or an item was ticked: the next look need not wait for `everyTools` more steps. */
	let moment = false;
	/** The chosen model is not usable here: said once per session. */
	let toldUnusable = false;
	let toolsSinceLook = 0;
	let lastLookAt = 0;
	let board: BoardUpdate | undefined;
	/** The last board the writer or the rules wrote and the session keeps; `board` may be a line shown since. */
	let kept: BoardUpdate | undefined;
	/** The running account, oldest first. */
	let notes: BoardNote[] = [];
	/** The line "looked at N files" that grows while the agent reads file after file; anything else ends it. */
	let reading: BoardNote | undefined;
	/** The clock the board looks by while sub-agents work. */
	let following: ReturnType<typeof setInterval> | undefined;
	/** The sub-agents' states (`swarmState`) at the last look. */
	let swarmSeen = "";
	/** Each subagent's status as last seen, so its end is told once: by run and name. */
	let beesSeen = new Map<string, BeeStatus>();
	/** Runs seen live, to tell how each subagent ended when the call that sent them returns. */
	let watched = new Set<{ readonly kind: string; readonly startedAt: number; readonly bees: readonly BeeState[] }>();
	/** The clock that notices a call or a subagent that has gone quiet, while a run is on. */
	let clock: ReturnType<typeof setInterval> | undefined;
	/**
	 * What is stuck now: its account line, how many of `STALL_STEPS` it has crossed, who and what, and since when
	 * (the call's start, or a subagent's last sign of life).
	 */
	const stalls = new Map<string, { note: BoardNote; level: number; who?: string; what: string; since: number }>();
	/** Waits on the judge (a permission review) and on the goal check, since when. */
	const waits = new Map<"judge" | "goal", { what: string; since: number }>();
	/** Background jobs running, by id. */
	const jobs = new Map<string, { command: string; since: number }>();
	/** The person's turn the current run belongs to: a run mu starts itself (a goal continuation, a nudge) carries it on. */
	let turnSeen = -1;
	/** A permission the agent is waiting for, shown the moment it is asked. */
	let pendingAsk: { id: string; summary: string; kind: string; toolCallId?: string; at: number } | undefined;
	/** The headline and phase the board had when a permission was asked, given back once it is answered. */
	let beforeAsk: Pick<BoardUpdate, "phase" | "headline" | "headlineCode" | "headlineParams"> | undefined;
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
	/**
	 * The language the writer writes in: a fixed one, else the one the person writes in (their latest messages,
	 * then the app's language for a message that tells nothing, such as "ok").
	 */
	const writing = (): AppLanguage => {
		if (options.language === "zh") return { code: "zh-CN", wording: "zh", name: "Simplified Chinese" };
		if (options.language === "en") return { code: "en", wording: "en", name: "English" };
		const latestFirst = [...said].reverse();
		const now = runtime.turn.userMessage;
		return writingLanguage(now && latestFirst[0] !== now ? [now, ...latestFirst] : latestFirst);
	};
	/**
	 * The language of the fixed sentences: a fixed one, then the app's (MU_LANG), then the one the person writes in.
	 * A client words them from their codes in its own language anyway.
	 */
	const language = (): BoardLanguage => {
		if (options.language === "zh" || options.language === "en") return options.language;
		return appLanguage()?.wording ?? writing().wording;
	};

	/** The plain-speaking model. A chosen one that cannot be used here (signed out, say) is said once, then stood in for. */
	const writerModel = (ctx: ExtensionContext, ended: boolean): LlmCompletion | undefined => {
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
		return ref ? runtime.llm(ref, { thinking: "off", ...(ended ? {} : { maxTokens: LIVE_MAX_TOKENS }) }) : undefined;
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
			...(step.detail ? { detail: step.detail } : {}),
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
	/** A fixed sentence on the account, when the board is on here; `who` names the subagent it is about. */
	const tell = (kind: NoteKind, code: NoteCode, params: NoteParams, failed = false, who?: string) => {
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
			...(who ? { who } : {}),
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
	/** The account's line for a step, the moment it ended. `failed` counts the subagents that did not finish well. */
	const account = (name: string, input: Record<string, unknown>, step: BoardStep, failed = 0) => {
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
			tell(
				"helpers",
				"helpers_back",
				{ count: swarmParts(name, input)?.count ?? 0, failed },
				step.failed || failed > 0,
			);
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

	/**
	 * A subagent that has ended since it was last seen becomes an event and a line of the account: back, with the
	 * first line of its report, or failed, timed out or stopped. True when one did.
	 */
	const followBees = (
		run: { readonly kind: string; readonly startedAt: number; readonly bees: readonly BeeState[] },
		reports?: readonly unknown[],
	): boolean => {
		let ended = false;
		run.bees.forEach((bee, index) => {
			const key = `${run.kind}:${run.startedAt}:${bee.name}`;
			const before = beesSeen.get(key);
			beesSeen.set(key, bee.status);
			if (!isOver(bee.status) || (before !== undefined && isOver(before))) return;
			ended = true;
			if (bee.status === "done") {
				const report = clip(firstLine(reportOf(bee) || bee.said || String(reports?.[index] ?? "")), 200);
				log({ kind: "step", text: `${bee.name} came back${report ? `, reporting: ${report}` : ""}` });
				tell("helpers", "helper_done", { name: bee.name, summary: clip(report, 120) }, false, bee.name);
				return;
			}
			const reason = bee.status === "timed-out" ? "timed_out" : bee.status === "stopped" ? "stopped" : "failed";
			const why = bee.error ? clip(bee.error, 160) : "";
			const how = reason === "timed_out" ? "timed out" : reason === "stopped" ? "was stopped" : "failed";
			log({ kind: "step", text: `${bee.name} ${how}${why ? `: ${why}` : ""}`, failed: true });
			tell("helpers", "helper_failed", { name: bee.name, reason, ...(why ? { detail: why } : {}) }, true, bee.name);
		});
		if (ended) moment = true;
		return ended;
	};

	/** Each subagent at work, by rule: where it stands, what it is doing (the writer's words for an exact name). */
	const liveAgents = (doing: Readonly<Record<string, string>> = {}): BoardAgent[] => {
		const now = Date.now();
		const zh = language() === "zh";
		return activeRuns().flatMap((run) =>
			run.bees.map((bee) => {
				const agent = agentOf(bee, now, options.stallMs, zh);
				return doing[bee.name] ? { ...agent, doing: doing[bee.name] } : agent;
			}),
		);
	};

	/** What a call in flight works on: the command, or the tool and what it works on. */
	const callWhat = (name: string, input: Record<string, unknown>) =>
		clip(isShellTool(name) ? String(input.command ?? "") : `${name} ${describeCall(name, input)}`, 80);
	/** What is under way and for how long, for the judge and the writer. */
	const inFlight = (now: number): string[] => {
		const lines: string[] = [];
		for (const [id, call] of calls) {
			// Subagents have a section of their own; a call waiting for permission is the person's to answer.
			if (SWARM_TOOLS.has(call.name) || pendingAsk?.toolCallId === id) continue;
			const output =
				call.outputAt !== undefined
					? ` (last output ${duration(now - call.outputAt)} ago)`
					: isShellTool(call.name)
						? " (no output yet)"
						: "";
			lines.push(
				`main agent: ${call.name} \`${callWhat(call.name, call.input)}\` running for ${duration(now - call.startedAt)}${output}`,
			);
		}
		for (const job of jobs.values())
			lines.push(`background job \`${job.command}\`: running ${duration(now - job.since)}`);
		const judge = waits.get("judge");
		if (judge) lines.push(`waiting on the judge: ${judge.what} (${duration(now - judge.since)})`);
		const goal = waits.get("goal");
		if (goal) lines.push(`${goal.what} (${duration(now - goal.since)})`);
		return lines;
	};
	/** The stall that has gone longest, among those that crossed a step, with its minutes as of now. */
	const longestStall = (): BoardStall | undefined => {
		const oldest = [...stalls.values()].sort((a, b) => a.since - b.since)[0];
		if (!oldest) return undefined;
		const minutes = Math.max(1, Math.round((Date.now() - oldest.since) / 60_000));
		return { ...(oldest.who ? { who: oldest.who } : {}), what: oldest.what, minutes };
	};

	/** A stall that crossed its next step: the account line grows in place, the judge hears of it. True when one did. */
	const crossed = (key: string, elapsed: number, now: number, what: string, who?: string): boolean => {
		const level = STALL_STEPS.filter((step) => elapsed >= step * options.stallMs).length;
		const known = stalls.get(key);
		if (level <= (known?.level ?? 0)) return false;
		const minutes = Math.max(1, Math.round(elapsed / 60_000));
		const params = { ...(who ? { who } : {}), what, minutes };
		const note: BoardNote = {
			sequence: known?.note.sequence ?? ++sequence,
			at: known?.note.at ?? now,
			kind: "step",
			text: noteText("still_running", params, language()),
			by: "rules",
			code: "still_running",
			params,
			...(who ? { who } : {}),
		};
		stalls.set(key, { note, level, ...(who ? { who } : {}), what, since: now - elapsed });
		reading = undefined;
		noteNow(note);
		log({
			kind: "step",
			text: who
				? `${who}: \`${what}\` has run ${minutes} min with no new output`
				: `\`${what}\` is still running, ${minutes} min in`,
		});
		return true;
	};
	/**
	 * The stall clock's tick: a tool call of the main agent running past a step of `stallMs`, or a subagent's tool
	 * call with no sign of life for as long. One line each, grown in place, and one look per step crossed.
	 */
	const checkStalls = () => {
		const ctx = runtime.ctx;
		if (!ctx || !on(ctx)) return;
		const now = Date.now();
		const live = new Set<string>();
		let any = false;
		for (const [id, call] of calls) {
			if (SWARM_TOOLS.has(call.name) || pendingAsk?.toolCallId === id) continue;
			live.add(`main:${id}`);
			any = crossed(`main:${id}`, now - call.startedAt, now, callWhat(call.name, call.input)) || any;
		}
		for (const run of activeRuns()) {
			for (const bee of run.bees) {
				if (bee.status !== "tool" || !bee.tool) continue;
				const key = `bee:${run.kind}:${run.startedAt}:${bee.name}:${bee.tool.startedAt}`;
				live.add(key);
				any = crossed(key, now - bee.lastEventAt, now, beeWhat(bee.tool), bee.name) || any;
			}
		}
		for (const key of [...stalls.keys()]) if (!live.has(key)) stalls.delete(key);
		if (!any) return;
		moment = true;
		schedule(ctx, false);
	};
	const startClock = () => {
		if (clock || options.stallMs <= 0) return;
		clock = setInterval(checkStalls, Math.max(1000, Math.min(15_000, Math.floor(options.stallMs / 4))));
		clock.unref?.();
	};
	const stopClock = () => {
		if (clock) clearInterval(clock);
		clock = undefined;
		stalls.clear();
	};

	/** The line a permission the agent waits for puts on the board. */
	const askLine = (ask: { kind: string; summary: string }) => {
		const kind = PERMISSION_KINDS[ask.kind] ?? PERMISSION_KINDS.other;
		return words({
			zh: `mu 想${kind.zh}：${ask.summary}。在等你允许。`,
			en: `mu wants to ${kind.en}: ${ask.summary}. It's waiting for your permission.`,
		});
	};
	const askHeadline = (ask: { summary: string }): Pick<BoardText, "headline" | "headlineCode" | "headlineParams"> => {
		const params = { what: clip(ask.summary, 120) };
		return {
			headline: rulesHeadline("waiting_permission", params, language()),
			headlineCode: "waiting_permission",
			headlineParams: params,
		};
	};
	/** A board as it goes out: the subagents at work, by rule, and when it was made. */
	const finish = (update: BoardUpdate, doing?: Readonly<Record<string, string>>): BoardUpdate => {
		const { agents: _old, ...rest } = update;
		const agents = liveAgents(doing);
		return { ...rest, ...(agents.length > 0 ? { agents } : {}), updatedAt: Date.now() };
	};
	/** Shows a board without keeping it in the session: a line that cannot wait for a look, or a look's first word. */
	const sayNow = (update: BoardUpdate) => {
		board = finish(update);
		runtime.present("board.update", board);
		showWidget(runtime.ctx);
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
		const runs = activeRuns();
		const started = Date.now();
		const swarm = describeSwarms(
			runs.map((run) => run.snapshot()),
			started,
		);
		const flying = ended ? [] : inFlight(started);
		const stall = ended ? undefined : longestStall();
		const input: BoardInput = {
			goal: frame?.goal ?? runtime.turn.userMessage,
			items,
			steps: steps.slice(-options.maxSteps),
			latest,
			ended,
			events: weighed,
			last: board ? { phase: board.phase, focus: board.focus, now: board.now } : undefined,
			...(swarm ? { swarm } : {}),
			...(flying.length > 0 ? { inFlight: flying } : {}),
			...(stall ? { stalled: true } : {}),
		};
		const decision = await runtime.engine.decide(boardRead, input);
		const read = decision.outcome;
		if (at !== epoch) return;
		toolsSinceLook = 0;
		lastLookAt = Date.now();
		// More happened while the judge read: the look queued behind this one covers all of it, and this one would
		// only cost a writer call for a board that is already out of date. Unless the board the person sees is old:
		// an agent that says something every few seconds would otherwise keep the board from being written at all.
		const fresh = board?.updatedAt !== undefined && lastLookAt - board.updatedAt < options.maxStaleMs;
		if (!ended && again !== undefined && fresh) return;
		if (!ended && decision.source === "judge") judged = Math.max(judged, upTo);
		if (!read.update) return;

		const asking = pendingAsk;
		const phase: BoardPhase = asking && !ended ? "waiting" : read.phase;
		const focusItem = read.focus ? items.find((item) => item.id === read.focus) : undefined;
		const news = read.key.flatMap((index) => (weighed[index] ? [weighed[index]] : []));
		const helpers = runs.flatMap((run) => run.bees.map((bee) => bee.name));
		const now = Date.now();
		const facts: BoardFacts = {
			language: language(),
			goal: input.goal,
			...(frame?.currentSubgoal ? { subgoal: frame.currentSubgoal } : {}),
			items,
			phase,
			focus: focusItem?.text,
			needsUser: read.needsUser || asking !== undefined,
			...(asking
				? {
						asking: {
							kind: (PERMISSION_KINDS[asking.kind] ?? PERMISSION_KINDS.other).en,
							summary: asking.summary,
							sinceMs: now - asking.at,
						},
					}
				: {}),
			// With the news picked, the last few steps are enough to say what it is doing now.
			steps: (weighed.length > 0 ? input.steps.slice(-4) : input.steps).map(stepLine),
			latest: clip(latest, 1200),
			...(weighed.length > 0 ? { keyEvents: news.map(describeEvent) } : {}),
			ended,
			...(swarm ? { swarm: swarm.slice(0, 2400), helpers } : {}),
			helpersWorking: runs.reduce((sum, run) => sum + run.bees.filter((bee) => !isOver(bee.status)).length, 0),
			...(notes.length > 0 ? { account: notes.slice(-ACCOUNT_LINES).map((note) => note.text) } : {}),
			...(board ? { previous: { headline: board.headline, now: board.now, blocked: board.blocked } } : {}),
			...(runStartedAt !== undefined ? { runMs: now - runStartedAt } : {}),
			...(board?.updatedAt !== undefined ? { sinceUpdateMs: now - board.updatedAt } : {}),
			...(flying.length > 0 ? { inFlight: flying } : {}),
			...(stall ? { stall } : {}),
			...(frame?.openQuestions.length ? { openQuestions: frame.openQuestions } : {}),
		};
		const rules = plainBoard(facts);
		const meta = {
			phase,
			focus: read.focus ?? undefined,
			...(focusItem ? { focusText: focusItem.text } : {}),
			needsUser: facts.needsUser,
			done: items.filter((item) => item.done).length,
			total: items.length,
			ended,
		};
		const complete = writerModel(ctx, ended);
		// The rules' headline goes out at once when the stage changed or something is stuck, and the writer's
		// replaces it: the person hears "running npm test, 3 min in" now, not in the 3 to 15 s the writer takes.
		if (complete && rules.headline !== board?.headline && (!board || board.phase !== phase || stall || asking)) {
			const headline = {
				headline: rules.headline,
				headlineCode: rules.headlineCode,
				headlineParams: rules.headlineParams,
			};
			sayNow(
				board && !board.ended
					? { ...board, ...headline, ...meta, focusText: meta.focusText }
					: { ...rules, ...meta, by: "rules", ...(notes.length > 0 ? { log: notes.slice(-LOG_LINES) } : {}) },
			);
		}
		const tongue = writing();
		let text: WriterReply | undefined;
		if (complete) {
			try {
				const reply = await complete({
					system: narratorSystem(tongue.wording, tongue.name),
					// The writer tells what the agent did, never the key it did it with.
					user: redactSecrets(narratorRequest(facts), environmentSecrets()),
					signal: AbortSignal.any([
						AbortSignal.timeout(
							ended ? options.narrateTimeoutMs : Math.min(options.narrateTimeoutMs, LIVE_TIMEOUT_MS),
						),
						gone,
					]),
				});
				text = parseBoardText(reply.text, helpers);
			} catch {
				text = undefined;
			}
		}
		if (at !== epoch) return;
		const askNow = pendingAsk;
		// The same headline with nothing new is no update: the person would only see the board flicker.
		if (
			text &&
			!ended &&
			!askNow &&
			news.length === 0 &&
			!text.note &&
			board === kept &&
			text.headline === kept?.headline
		) {
			reported = Math.max(reported, upTo);
			return;
		}
		// The account: the writer's telling of the news, or, when it did not answer, the agent's own last
		// words as a quote; a run that ended gets its last line either way.
		const lastKind = news.at(-1)?.kind;
		const kind: NoteKind = ended ? "ended" : lastKind === "ticked" ? "ticked" : lastKind === "said" ? "said" : "step";
		const quote = [...news].reverse().find((event) => event.kind === "said");
		if (text?.note) tellModel(kind, text.note);
		else if (ended) tell("ended", read.needsUser ? "waiting_reply" : "ended", {});
		else if (complete && quote) tell("said", "said_quote", { text: clip(quote.text, 160) });
		const { doing, ...told } = text ?? { ...rules, doing: undefined };
		// Rules say what is stuck when the writer did not: it may have written before the stall crossed a step.
		const stuck = stall ?? (ended ? undefined : longestStall());
		const blocked =
			text && !text.blocked && stuck
				? {
						blocked: noteText(
							"still_running",
							{ ...(stuck.who ? { who: stuck.who } : {}), what: stuck.what, minutes: stuck.minutes },
							language(),
						),
						blockedCode: "still_running",
						blockedParams: { ...(stuck.who ? { who: stuck.who } : {}), what: stuck.what, minutes: stuck.minutes },
					}
				: {};
		// A permission asked while the writer wrote stays on the board until it is answered: the writer's board
		// would otherwise take "Needs you" off while the picker is still open.
		const ask =
			askNow && !ended
				? {
						confirm: [askLine(askNow)],
						confirmCodes: [null],
						needsUser: true,
						phase: "waiting" as const,
						...(askNow !== asking || !text ? askHeadline(askNow) : {}),
					}
				: {};
		const update: BoardUpdate = {
			...told,
			...blocked,
			...meta,
			by: text ? "model" : "rules",
			...(news.length > 0 ? { news: news.map(describeEvent) } : {}),
			...(notes.length > 0 ? { log: notes.slice(-LOG_LINES) } : {}),
			...ask,
		};
		for (const event of news) event.key = true;
		reported = Math.max(reported, upTo);
		board = finish(update, doing);
		kept = board;
		pi.appendEntry<BoardUpdate>(BOARD_ENTRY, board);
		runtime.present("board.update", board);
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
	 * While sub-agents work, a tick a second: a subagent that came back or failed is told at once, with a look.
	 * Otherwise a look only when one of them started or finished since the last look, and not more often than
	 * `minIntervalMs`. What a bee is doing at the moment (its tool line) changes all the time and is no news: in a
	 * 45-minute run, 65 of 77 looks came from this clock with nothing new, and each cost a writer call.
	 */
	const follow = (ctx: ExtensionContext) => {
		if (following) return;
		following = setInterval(() => {
			const runs = activeRuns();
			if (runs.length === 0) {
				unfollow();
				return;
			}
			let ended = false;
			for (const run of runs) {
				watched.add(run);
				ended = followBees(run) || ended;
			}
			if (!on(ctx)) return;
			const due = Date.now() - lastLookAt >= options.minIntervalMs;
			if (ended || (due && (options.followAlways || swarmState() !== swarmSeen))) schedule(ctx, false);
		}, 1000);
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

	// A permission the agent waits for is the one thing the person must act on: it is on the board the moment it is
	// asked, as what the agent waits on, and stays there until it is answered.
	runtime.observe("permissions.request", (payload) => {
		const ctx = runtime.ctx;
		const ask = payload as { id?: unknown; kind?: unknown; summary?: unknown; toolCallId?: unknown };
		if (!ctx || !on(ctx) || typeof ask.id !== "string" || typeof ask.summary !== "string") return;
		waits.delete("judge");
		pendingAsk = {
			id: ask.id,
			summary: ask.summary,
			kind: String(ask.kind),
			...(typeof ask.toolCallId === "string" ? { toolCallId: ask.toolCallId } : {}),
			at: Date.now(),
		};
		const shown = board ?? emptyBoard();
		beforeAsk = {
			phase: shown.phase,
			headline: shown.headline,
			headlineCode: shown.headlineCode,
			headlineParams: shown.headlineParams,
		};
		sayNow({
			...shown,
			...askHeadline(pendingAsk),
			confirm: [askLine(pendingAsk)],
			confirmCodes: [null],
			needsUser: true,
			phase: "waiting",
			ended: false,
		});
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
		if (board?.needsUser) {
			// The headline and the stage go back to what they were before the ask, unless a look has said more since.
			const restore = board.headlineCode === "waiting_permission" ? beforeAsk : undefined;
			sayNow({ ...board, ...(restore ?? {}), confirm: [], confirmCodes: [], needsUser: false });
		}
		beforeAsk = undefined;
	});
	// The judge reviewing a permission, and the goal check: waits the writer can name.
	runtime.observe("progress", (payload) => {
		const { code, params } = payload as { code?: unknown; params?: { summary?: unknown } };
		if (code === "permission_review") {
			waits.set("judge", {
				what: `reviewing whether to allow ${clip(String(params?.summary ?? ""), 80)}`,
				since: Date.now(),
			});
		} else if (code === "goal_check") {
			waits.set("goal", { what: "the goal check is reading whether the goal is met", since: Date.now() });
		}
	});
	runtime.observe("permissions.approved", () => waits.delete("judge"));
	runtime.observe("background.start", (payload) => {
		const job = payload as { id?: unknown; command?: unknown };
		if (typeof job.id === "string")
			jobs.set(job.id, { command: clip(String(job.command ?? ""), 80), since: Date.now() });
	});
	for (const kind of ["background.exit", "background.stop"] as const) {
		runtime.observe(kind, (payload) => {
			const job = payload as { id?: unknown };
			if (typeof job.id === "string") jobs.delete(job.id);
		});
	}

	// Goal mode: a run mu sends back to work has not ended for the person; what the check said is news.
	runtime.observe("goal.state", (payload) => {
		waits.delete("goal");
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
			stopClock();
			pendingAsk = undefined;
			beforeAsk = undefined;
			board = undefined;
			said = [];
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === BOARD_ENTRY)
					board = parseBoardEntry(entry.data) ?? board;
				if (entry.type === "message" && entry.message.role === "user") {
					const typed = userWords(textOf(entry.message.content)).trim();
					if (typed) said = [...said.slice(-2), typed];
				}
			}
			kept = board;
			calls.clear();
			waits.clear();
			jobs.clear();
			steps = [];
			latest = "";
			events = [];
			notes = board?.log ? [...board.log] : [];
			reading = undefined;
			beesSeen = new Map();
			watched = new Set();
			reported = sequence;
			judged = sequence;
			runStart = sequence;
			runStartedAt = undefined;
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
			stopClock();
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
			calls.set(event.toolCallId, { name: event.toolName, input, startedAt: Date.now() });
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
		"tool_execution_update",
		failOpen<ToolExecutionUpdateEvent, undefined>((event, ctx) => {
			const call = calls.get(event.toolCallId);
			if (call) call.outputAt = Date.now();
			if (!SWARM_TOOLS.has(event.toolName)) return undefined;
			// The swarm tools stream a snapshot of their subagents: one that came back or failed is told at once.
			const snapshot = (event.partialResult as { details?: { snapshot?: SwarmSnapshot } } | undefined)?.details
				?.snapshot;
			if (snapshot?.bees && followBees(snapshot) && announce(ctx)) schedule(ctx, false);
			return undefined;
		}),
	);

	pi.on(
		"tool_execution_end",
		failOpen<ToolExecutionEndEvent, undefined>((event, ctx) => {
			runtime.touch(ctx);
			const call = calls.get(event.toolCallId);
			calls.delete(event.toolCallId);
			stalls.delete(`main:${event.toolCallId}`);
			waits.delete("judge");
			const name = call?.name ?? event.toolName;
			const input = call?.input ?? {};
			let failedBees = 0;
			if (SWARM_TOOLS.has(name)) {
				unfollow();
				// How each subagent ended, before the line that says they are back: from the call's own last snapshot,
				// else from the runs seen while they worked.
				const details = (
					event.result as { details?: { snapshot?: SwarmSnapshot; reports?: unknown[] } } | undefined
				)?.details;
				const runs = details?.snapshot?.bees ? [details.snapshot] : [...watched];
				for (const run of runs) followBees(run, details?.reports);
				failedBees = runs.reduce((sum, run) => sum + run.bees.filter((bee) => bee.status !== "done").length, 0);
				watched = new Set();
			}
			const command = isShellTool(name) ? String(input.command ?? "") : "";
			const detail = event.isError ? failureExcerpt(event.result) : undefined;
			const step: BoardStep = {
				tool: name,
				what: clip(describeSwarmCall(name, input) ?? describeCall(name, input), 160),
				failed: event.isError,
				check: command !== "" && isCheckCommand(command),
				...(detail ? { detail } : {}),
			};
			steps = [...steps.slice(-(options.maxSteps * 2)), step];
			record(name, input, step);
			account(name, input, step, failedBees);
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
			const text = textOf((event.message as { content?: unknown }).content).trim();
			if (!text) return undefined;
			latest = text;
			reading = undefined;
			log({ kind: "said", text: clip(text.replace(/\s+/g, " "), 300) });
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
				runStartedAt = Date.now();
				const typed = runtime.turn.userMessage.trim();
				if (typed) said = [...said.slice(-2), typed];
			}
			waits.delete("goal");
			startClock();
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>((_event, ctx) => {
			runtime.touch(ctx);
			reading = undefined;
			stopClock();
			waits.delete("judge");
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
