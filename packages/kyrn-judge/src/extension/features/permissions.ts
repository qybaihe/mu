import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionContext,
	type ToolCallEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { isCheckChain, shellStart } from "../../checkpoint/mutating.ts";
import { type Decision, digestOf } from "../../decision.ts";
import { toolApproval } from "../../decisions/tool-approval.ts";
import { toolRisk } from "../../decisions/tool-risk.ts";
import { say } from "../../language.ts";
import { muEnv } from "../../naming.ts";
import {
	MODE_TEXT,
	PERMISSION_MODES,
	PermissionDefaults,
	type PermissionKind,
	type PermissionMode,
	type PermissionNeed,
	parseMode,
	permissionNeed,
	protectedSpellings,
	toolPath,
} from "../../permissions/modes.ts";
import { threeZone } from "../../policy.ts";
import { environmentSecrets, redactSecrets } from "../../redact.ts";
import { subAgentUserGoal } from "../../swarm/brief.ts";
import type { JsonValue } from "../../types.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";
import {
	carriesCredential,
	commandLines,
	FLAG_CODES,
	FLAG_ZH,
	RISK_COMMAND_CHARS,
	RISK_CONFIRM_CHARS,
	readWhole,
	riskExcerpt,
	riskFlag,
	SENDS_CREDENTIAL,
} from "./guard.ts";
import type { HarnessRoots } from "./inherit.ts";

/** Session entry: the mode this conversation was switched to. A reopened conversation keeps it. */
export const PERMISSIONS_ENTRY = "mu.permissions";
/** Session entry: what the user answered when asked to allow a call (`PermissionOutcome`). */
export const OUTCOME_ENTRY = "kyrn.outcome";
/** Custom message: what the user answered with /approve about calls whose question had waited out its time. */
export const APPROVED_MESSAGE = "kyrn.approval";

/**
 * What the user answered when asked to allow a call, kept in the session. When a judge was asked first, `ledgerId`
 * is its record's id (a `kyrn.decision` entry): the judge said `judged`, the user chose `answer`. These are labels
 * from real work, for calibrating the approval lines, and the record of who allowed what. No state is kept here: the
 * ledger record holds it when the engine records states.
 */
export interface PermissionOutcome {
	readonly kind: "permission";
	readonly toolCallId: string;
	readonly tool: string;
	readonly mode: PermissionMode;
	/** Why the user was asked. */
	readonly reason: AskReason;
	readonly flagCode?: string;
	/** The judge's record this answer labels, and what the judge said. Absent when no judge was asked. */
	readonly ledgerId?: string;
	readonly specId?: string;
	readonly judged?: JsonValue;
	/**
	 * `dismissed`: the question was closed or cancelled. `none`: nobody could be asked, so the call was refused.
	 * `timeout`: nobody answered within the wait, so the call did not run and waits for /approve.
	 */
	readonly answer: "once" | "session" | "deny" | "dismissed" | "none" | "timeout";
	/** What "for this session" allowed, when that was the answer. */
	readonly grant?: string;
	/** How long the question waited for the answer. */
	readonly waitedMs: number;
	/** The call asked to run outside the write sandbox (`outside: true`). */
	readonly outsideFloor?: true;
	/** The answer came through /approve, after the question had waited out its time. */
	readonly late?: true;
}

/**
 * The user's mark on one of the judge's records: it judged wrong (`/ledger wrong`, or the app's button), with why when
 * they said. Kept in the session as a `kyrn.outcome` entry beside the permission answers, and joined on `ledgerId` the
 * same way: a label for a judgment that sent nobody a question too, such as a skill the judge left out.
 */
export interface JudgmentMark {
	readonly kind: "mark";
	readonly ledgerId: string;
	readonly specId: string;
	readonly specVersion: number;
	/** What the judge said, as its record has it. */
	readonly judged?: JsonValue;
	readonly mark: "wrong";
	readonly note?: string;
}

/** What the judge said about a call before the user was asked, for the user's answer to label. */
interface JudgeSaid {
	readonly ledgerId?: string;
	readonly specId: string;
	readonly judged?: JsonValue;
	/**
	 * For a command in the project the approval judge read as needed: the probability it gave, and whether the command
	 * was a check. The user's answer to such a call is what a project's approval line is read from (features/evolve.ts).
	 */
	readonly needed?: { readonly probability: number; readonly check: boolean };
}
const MODE_STATUS = "mu.permissions";
const PENDING_STATUS = "mu.permissions.pending";

/**
 * Why the user is being asked. `nojudge` and `judgedown` are judge mode without a verdict: no judge can answer yet
 * (no usable key or credit, or none trusted with approvals, so every step asks), or the judge did not answer this
 * time (down, too slow, a broken answer). `long`: the call is too long for the judge to read whole (`approvalCall`).
 */
export type AskReason =
	| "ask"
	| "unsure"
	| "beyond"
	| "unrelated"
	| "flagged"
	| "protected"
	| "nojudge"
	| "judgedown"
	| "long";

/** A call's permission question: what the picker shows, and what the answer is recorded against. */
interface Question {
	/** `permission-<n>`, as the `permissions.request` and `permissions.resolved` frames name it. */
	readonly id: string;
	readonly toolCallId: string;
	readonly tool: string;
	readonly need: PermissionNeed;
	readonly reason: AskReason;
	readonly flag?: string;
	readonly said?: JudgeSaid;
	readonly leaving: boolean;
	/** What "for this conversation" would cover. Undefined: this call can only be allowed once. */
	readonly grant?: NonNullable<PermissionNeed["grant"]>;
	/** The picker's text under its first line: the call, and why mu asks. */
	readonly body: string;
	/** The call itself (`callKey`): an answer given after the wait holds for this call and no other. */
	readonly key: string;
	readonly cwd: string;
	readonly askedAt: number;
}

/** How a question ended. `timeout`: nobody answered within the wait. `dismissed`: closed, or the run was stopped. */
type Picked = "once" | "session" | "deny" | "dismissed" | "timeout";

/** A call as itself: the tool and its whole input. */
const callKey = (event: ToolCallEvent): string => digestOf([event.toolName, event.input]);

/** What the model is told about a call whose question nobody has answered yet. */
const pendingReason = (need: PermissionNeed): string =>
	`The user has not answered yet whether to allow this (${need.summary}). This is pending: not permission, and not a refusal. Do not try another way around it. Carry on with work that does not depend on it, and say at the end what still waits for them. If they allow it later you are told, and can make this call again.`;

const KIND_TEXT: Readonly<Record<PermissionKind, { zh: string; en: string }>> = {
	edit: { zh: "改文件", en: "edit a file" },
	shell: { zh: "运行命令", en: "run a command" },
	run: { zh: "运行程序", en: "run a program" },
	outside: { zh: "改动项目外的文件", en: "change a file outside the project" },
	delegate: { zh: "派出子代理", en: "start subagents" },
	other: { zh: "对外操作", en: "act outside this computer" },
};

/** What a command that asks out of the write sandbox wants to do. */
const LEAVING_TEXT = { zh: "在写入沙箱外运行命令", en: "run a command outside the write sandbox" };

const REASON_TEXT: Readonly<Record<Exclude<AskReason, "flagged">, { zh: string; en: string }>> = {
	ask: {
		zh: "最小权限模式：改文件、跑命令、对外操作都先问你。",
		en: "Ask first: mu asks you before every edit, command and action outside this computer.",
	},
	unsure: { zh: "判定器拿不准这一步是不是你要的。", en: "The judge isn't sure this step is what you want." },
	beyond: { zh: "判定器认为这一步超出了你的要求。", en: "The judge thinks this goes beyond what you asked for." },
	unrelated: { zh: "判定器认为这一步和当前任务无关。", en: "The judge thinks this isn't part of the task." },
	protected: {
		zh: "这会动到 mu 自己的设置，只能由你决定。",
		en: "This touches mu's own settings; only you can allow it.",
	},
	nojudge: {
		zh: "还没有可用的判定器，所以每一步都先问你。",
		en: "No judge is available yet, so mu asks you about every step.",
	},
	judgedown: { zh: "判定器这次没有回答，所以先问你。", en: "The judge didn't answer this time, so mu is asking you." },
	long: {
		zh: "这一步太长，判定器读不全，所以先问你。",
		en: "This step is too long for the judge to read in full, so mu is asking you.",
	},
};

/**
 * How much of a call the approval judge reads: all of it, up to here. Cut at 400 characters and run into one line as it
 * was, a script passed on its first lines while all of it ran: `npm ci && npm test` up front, `npm publish` or
 * `curl -d @.env …` on the last line. In mubench's real captures, 539 of the 2,333 calls put to the judge had been cut;
 * in 963 commands of mu's own sessions, none was longer than this. A longer call is not put to the judge.
 */
export const APPROVAL_CALL_CHARS = 4000;

/**
 * A call as the approval judge reads it, and whether that is all of it: a command as its lines (`commandLines`), any
 * other call as its whole input, since a field the judge is not shown (an MCP tool's `to`) runs too.
 */
export function approvalCall(toolName: string, input: unknown): { text: string; whole: boolean } {
	const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	const shell = isShellTool(toolName) || toolName === "bg_start";
	const text = `${toolName}: ${shell ? commandLines(String(record.command ?? "")) : JSON.stringify(record)}`;
	if (text.length <= APPROVAL_CALL_CHARS) return { text, whole: true };
	return { text: `${text.slice(0, APPROVAL_CALL_CHARS - 1)}…`, whole: false };
}

/**
 * Where a command that asks out of the write sandbox acts, for the judge. The model's reason is not shown to it: the
 * model wrote it, and only the user's words vouch for a call.
 */
export const OUTSIDE_FLOOR_WHERE =
	"outside the write sandbox: a command that can write anywhere this computer lets it, not only in the project folder";

/** The answers, fixed so a client can draw them as buttons. */
export const ANSWERS = {
	once: { zh: "允许这一次", en: "Allow once" },
	session: { zh: "这次对话都允许", en: "Allow for this session" },
	deny: { zh: "不允许", en: "Don't allow" },
} as const;

export function modeLabel(mode: PermissionMode): string {
	return say({ zh: MODE_TEXT[mode].zh, en: MODE_TEXT[mode].en });
}

/**
 * Why no judge looked at a step, when none did. Its answer then says "unsure", which would tell the user the judge
 * weighed the step. `nojudge`: none will look at the next step either (no usable key, no credit, or only judges not
 * trusted with this kind of question, like a local judge alone). `judgedown`: one failed this time.
 */
function unanswered(decision: Decision<unknown>): "nojudge" | "judgedown" | undefined {
	if (decision.reason === "error:auth" || decision.reason === "error:payment_required") return "nojudge";
	if (decision.reason?.startsWith("error:")) return "judgedown";
	const judges = Object.values(decision.answers ?? {}).map((answer) => answer.judge);
	if (judges.length > 0 && judges.every((judge) => judge === "untrusted")) return "nojudge";
	return judges.includes("unavailable") ? "judgedown" : undefined;
}

/** The judge's record of a decision, for the user's answer about the same call to label. */
function saidBy(decision: Decision<unknown>, specId: string): JudgeSaid {
	return {
		...(decision.ledgerId ? { ledgerId: decision.ledgerId } : {}),
		specId,
		...(decision.judged !== undefined ? { judged: decision.judged as JsonValue } : {}),
	};
}

/** Where mu keeps its own settings, as a command may spell it, and where it really is: a call touching it is the user's to allow. */
function protectedPaths(roots: HarnessRoots | undefined): string[] {
	if (!roots) return [];
	const spelled = protectedSpellings(roots.agentDir, homedir(), process.platform);
	const real = toolPath(roots.agentDir, roots.agentDir);
	return real && real !== roots.agentDir ? [...spelled, real] : spelled;
}

/** The project's own mu folder (`.mu`, a stock pi's `.pi`): its settings and extensions run inside mu. */
function projectSettings(cwd: string): string[] {
	const spelled = join(resolve(cwd), CONFIG_DIR_NAME);
	const real = toolPath(cwd, CONFIG_DIR_NAME) ?? spelled;
	return [...new Set([spelled, real])].map((path) => `${path}${sep}`);
}

/**
 * Three permission modes, one switch (`/permissions`). The mode is per
 * conversation: a new one starts in the mode last chosen, a reopened one in
 * the mode it was in, a sub-agent in its parent's (MU_PERMISSIONS).
 *
 * Asking is one picker with fixed answers and a status line while it waits,
 * so the terminal shows it in its footer and the desktop as a prompt in its
 * status bar. Without anyone to ask (print mode, a sub-agent), what would be
 * asked is refused with a reason the model can report.
 *
 * A question does not hold the run for long. It waits `waitMs` (0: until
 * answered); when nobody answers in that time the call does not run, the model
 * is told it is pending and carries on with what does not depend on it, and
 * `/approve` asks again. What the user allows there holds for that same call,
 * made again. While nobody has answered, later questions wait with the first
 * at once: a person who is away is not waited for a second time.
 *
 * The risk guard's rules are part of this: in judge mode a flagged command runs
 * only when the judge is sure the user asked for it; in the other modes the flag is
 * shown with the question, or, in full access, nothing is asked at all.
 */
export function registerPermissions(runtime: KyrnRuntime, roots: HarnessRoots | undefined): void {
	const options = runtime.options("permissions", {
		enabled: true,
		/** The mode of a new conversation until the user picks one with /permissions. */
		mode: "judge",
		/** A chain of read-only commands (`pwd && ls; git status`) only looks, as one read-only command does. */
		readOnlyChains: true,
		/** How long a permission question waits before the call is set aside for /approve. 0: until answered. */
		waitMs: 120_000,
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	const waitMs = Math.max(0, Math.floor(Number(options.waitMs) || 0));
	const defaults = new PermissionDefaults(roots ? join(roots.agentDir, "mu") : undefined);
	const guarded = protectedPaths(roots);
	const initial = (): PermissionMode =>
		parseMode(muEnv("PERMISSIONS")) ?? defaults.get() ?? parseMode(options.mode) ?? "judge";
	let mode: PermissionMode = initial();
	/** What the user allowed "for this conversation": `shell:npm test`, `edit`, `tool:browse`. */
	let grants = new Set<string>();
	let asked = 0;
	/** Questions nobody answered in time, oldest first: their calls did not run, and /approve asks each again. */
	let waiting: Question[] = [];
	/** Calls the user allowed with /approve (`callKey`): each runs once when the model makes it again. */
	let allowedLate = new Set<string>();
	/** Nobody answered the last question: the next ones wait with it, until the user writes or answers something. */
	let away = false;
	runtime.permissionMode = () => mode;

	/** The status line about permission questions as it stands, so it is written only when it changes. */
	let pendingStatus: string | undefined;
	const setPending = (ctx: ExtensionContext | undefined, text: string | undefined) => {
		if (!ctx?.hasUI || text === pendingStatus) return;
		pendingStatus = text;
		ctx.ui.setStatus(PENDING_STATUS, text);
	};

	/** The status line and the count other features read, as the waiting questions stand. */
	const showWaiting = (ctx: ExtensionContext | undefined) => {
		runtime.permissionsWaiting = waiting.length;
		setPending(
			ctx,
			waiting.length === 0
				? undefined
				: say({
						zh: `${waiting.length} 步在等你授权：输入 /approve`,
						en:
							waiting.length === 1
								? "1 step is waiting for your permission: type /approve"
								: `${waiting.length} steps are waiting for your permission: type /approve`,
					}),
		);
	};

	/** What was asked or allowed under one mode, or in one conversation, does not carry over to the next. */
	const forgetAnswers = (ctx: ExtensionContext | undefined) => {
		grants = new Set();
		allowedLate = new Set();
		waiting = [];
		away = false;
		showWaiting(ctx);
	};

	const show = (ctx: ExtensionContext | undefined) => {
		if (ctx?.hasUI)
			ctx.ui.setStatus(MODE_STATUS, say({ zh: `权限：${modeLabel(mode)}`, en: `Permissions: ${modeLabel(mode)}` }));
		runtime.present("permissions.mode", {
			mode,
			label: modeLabel(mode),
			// `/permissions <mode> --here` is understood: it switches this conversation and leaves the default alone.
			conversationSwitch: true,
			modes: PERMISSION_MODES.map((each) => ({
				id: each,
				label: modeLabel(each),
				description: say({ zh: MODE_TEXT[each].zhDescription, en: MODE_TEXT[each].enDescription }),
			})),
		});
	};

	/** `here`: this conversation only, as when the app puts a conversation back in the mode it had there. */
	const switchTo = (next: PermissionMode, ctx: ExtensionContext, here = false) => {
		mode = next;
		// Allowed under one mode is not allowed under another: a switch to fewer permissions must ask again.
		forgetAnswers(ctx);
		pi.appendEntry(PERMISSIONS_ENTRY, { mode: next });
		if (!here) {
			try {
				defaults.set(next);
			} catch {
				// The next conversation then starts in the old default; this one has switched all the same.
			}
		}
		show(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		runtime.touch(ctx);
		let restored: PermissionMode | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PERMISSIONS_ENTRY)
				restored = parseMode((entry.data as { mode?: unknown } | undefined)?.mode) ?? restored;
		}
		mode = restored ?? initial();
		forgetAnswers(ctx);
		show(ctx);
	});

	// The user is here: a message of theirs, typed mid-run or not, ends the waiting that began when nobody answered.
	pi.on(
		"input",
		failOpen((event) => {
			if (event.source !== "extension" && event.text.trim()) away = false;
			return undefined;
		}),
	);
	// A new message of the user's says what they want now: the questions of the run before it are no longer waited on.
	pi.on(
		"before_agent_start",
		failOpen((event, ctx) => {
			if (event.messageType !== "user" || waiting.length === 0) return undefined;
			waiting = [];
			showWaiting(ctx);
			return undefined;
		}),
	);

	const approvedBy = (event: ToolCallEvent, need: PermissionNeed, by: "judge" | "grant" | "user") => {
		runtime.present("permissions.approved", {
			toolCallId: event.toolCallId,
			tool: event.toolName,
			kind: need.kind,
			summary: need.summary,
			by,
		});
		return undefined;
	};

	/** Asks the judge. True when it approves. */
	const judgeApproves = async (
		event: ToolCallEvent,
		need: PermissionNeed,
		flag: string | undefined,
		ctx: ExtensionContext,
		leaving = false,
	): Promise<{ approved: boolean; reason: AskReason; said?: JudgeSaid }> => {
		// The judge vouches only for what it read, and what runs is the whole call: one too long to read is the user's.
		// Starting subagents is the exception, as their every step is put to the judge again.
		const call = approvalCall(event.toolName, event.input);
		const readAll = need.kind !== "delegate";
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (flag ? commandLines(command).length > RISK_COMMAND_CHARS : !call.whole && readAll)
			return { approved: false, reason: flag ? "flagged" : "long" };
		// In a sub-agent the message and the frame are what the parent's model wrote: only the user's goal vouches.
		const inherited = subAgentUserGoal();
		const userMessage = clip(inherited ?? runtime.turn.userMessage, 400);
		runtime.progress(
			say({
				zh: `判定器在审批：${clip(need.summary, 60)}`,
				en: `The judge is reviewing: ${clip(need.summary, 60)}`,
			}),
			"permission_review",
			{ summary: clip(need.summary, 60) },
		);
		if (flag) {
			const decision = await runtime.engine.decide(
				toolRisk,
				{ command: commandLines(command), userMessage, flag },
				{ signal: ctx.signal },
			);
			// The user chose the judge to decide, so its verdict counts in shadow too; no verdict means asking. A rule
			// flagged the call, so only the judge being sure the user asked for it runs it.
			const requested = decision.answers?.requested;
			const asked = requested?.type === "boolean" && threeZone(requested) === "yes";
			const allowed = asked && (decision.judged ?? decision.outcome) === "allow";
			return { approved: allowed && readWhole(decision), reason: "flagged", said: saidBy(decision, toolRisk.id) };
		}
		const frame = runtime.frame;
		const input = event.input as Record<string, unknown>;
		const powershell =
			event.toolName === "powershell" || (event.toolName === "bg_start" && process.platform === "win32");
		const check =
			!leaving &&
			need.kind === "shell" &&
			isCheckChain(String(input.command ?? ""), powershell, ctx.cwd, shellStart(event.toolName, input, ctx.cwd));
		// A line the user accepted holds for what it was read from: commands run in the project, inside the sandbox.
		const inProject = !leaving && (need.kind === "shell" || need.kind === "run");
		const approveAt = inProject ? runtime.evolve?.approvalLine(ctx.cwd) : undefined;
		const decision = await runtime.engine.decide(
			toolApproval,
			{
				task: clip(
					inherited ?? ([frame?.goal, frame?.currentSubgoal].filter(Boolean).join(" / now: ") || userMessage),
					600,
				),
				userMessage,
				call: call.text,
				where: leaving
					? OUTSIDE_FLOOR_WHERE
					: need.kind === "outside"
						? "outside the project folder"
						: need.kind === "shell" || need.kind === "run"
							? "a program run in the project folder"
							: need.kind === "delegate"
								? "subagents working on the project"
								: "an action outside this computer or program, such as a web page or a connected service",
				check,
				...(approveAt !== undefined ? { approveAt } : {}),
			},
			{ signal: ctx.signal },
		);
		const verdict = decision.judged ?? decision.outcome;
		const read = decision.answers?.verdict;
		const probability = read?.type === "choice" && read.choice === "needed" ? read.probabilities?.needed : undefined;
		const said: JudgeSaid = {
			...saidBy(decision, toolApproval.id),
			...(inProject && probability !== undefined ? { needed: { probability, check } } : {}),
		};
		// A judge with a bounded window that cut the state did not read the whole call either.
		if (verdict === "approve")
			return readWhole(decision) || !readAll
				? { approved: true, reason: "ask", said }
				: { approved: false, reason: "long", said };
		return { approved: false, reason: unanswered(decision) ?? verdict, said };
	};

	const record = (
		question: Omit<Question, "id">,
		answer: PermissionOutcome["answer"],
		extra: { grantKey?: string; late?: true } = {},
	) => {
		const { reason, flag, said } = question;
		const outcome: PermissionOutcome = {
			kind: "permission",
			toolCallId: question.toolCallId,
			tool: question.tool,
			mode,
			reason,
			...(flag ? { flagCode: FLAG_CODES[flag] ?? flag } : {}),
			...(said?.ledgerId ? { ledgerId: said.ledgerId } : {}),
			...(said ? { specId: said.specId } : {}),
			...(said?.judged !== undefined ? { judged: said.judged } : {}),
			answer,
			...(extra.grantKey ? { grant: extra.grantKey } : {}),
			waitedMs: Date.now() - question.askedAt,
			...(question.leaving ? { outsideFloor: true as const } : {}),
			...(extra.late ? { late: true as const } : {}),
		};
		pi.appendEntry(OUTCOME_ENTRY, outcome);
		// Needed, the judge read, but not surely enough: the user's answer says where the line could be.
		if (reason === "unsure" && said?.needed && (answer === "once" || answer === "session" || answer === "deny")) {
			runtime.evolve?.approvalAnswered({ cwd: question.cwd, ...said.needed, answer, waitedMs: outcome.waitedMs });
		}
	};

	/** The answers a question offers, in the picker's order. */
	const answersOf = (question: Question) => {
		const { grant } = question;
		return {
			once: say(ANSWERS.once),
			session: grant
				? `${say(ANSWERS.session)}${say({ zh: `（${grant.label}）`, en: ` (${grant.label})` })}`
				: undefined,
			deny: say(ANSWERS.deny),
		};
	};

	const announce = (question: Question) => {
		const { need, flag, grant } = question;
		const { once, session, deny } = answersOf(question);
		runtime.present("permissions.request", {
			id: question.id,
			// The call this is about, here and in `permissions.resolved`: a client marks that call's own row by it, in
			// its own words. The model is still told in English why a refused call did not run.
			toolCallId: question.toolCallId,
			mode,
			tool: question.tool,
			kind: need.kind,
			summary: need.summary,
			reason: question.reason,
			...(flag ? { flag, flagCode: FLAG_CODES[flag] ?? flag } : {}),
			...(grant ? { grant } : {}),
			answers: [once, ...(session ? [session] : []), deny],
			// The same answers by id, in the same order: what `permissions.resolved` reports back.
			answerIds: ["once", ...(session ? ["session"] : []), "deny"],
		});
	};

	/** Opens the picker for a question and waits `wait` ms for the answer (0: until there is one). */
	const pick = async (
		question: Question,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		wait: number,
	): Promise<Picked> => {
		const { need } = question;
		const { once, session, deny } = answersOf(question);
		announce(question);
		setPending(
			ctx,
			say({
				zh: `等你授权：${clip(need.summary, 60)}`,
				en: `Waiting for your permission: ${clip(need.summary, 60)}`,
			}),
		);
		const openedAt = Date.now();
		let picked: string | undefined;
		try {
			picked = await ctx.ui.select(
				[
					say({
						zh: `mu 想${(question.leaving ? LEAVING_TEXT : KIND_TEXT[need.kind]).zh}，需要你授权`,
						en: `mu wants to ${(question.leaving ? LEAVING_TEXT : KIND_TEXT[need.kind]).en}`,
					}),
					question.body,
				].join("\n"),
				[once, ...(session ? [session] : []), deny],
				{ signal, ...(wait > 0 ? { timeout: wait } : {}) },
			);
		} catch (error) {
			showWaiting(ctx);
			throw error;
		}
		if (picked === once) return "once";
		if (session && picked === session) return "session";
		if (picked !== undefined) return "deny";
		// Nothing was picked: the wait ran out, or the picker was closed (Esc, or the run was stopped).
		return !signal?.aborted && wait > 0 && Date.now() - openedAt >= wait - 50 ? "timeout" : "dismissed";
	};

	/** Records an answer and says so. True when the call may run. */
	const settle = (question: Question, answer: Exclude<Picked, "timeout">, late?: true): boolean => {
		const { grant } = question;
		record(question, answer, {
			...(answer === "session" && grant ? { grantKey: grant.key } : {}),
			...(late ? { late } : {}),
		});
		runtime.present("permissions.resolved", {
			id: question.id,
			toolCallId: question.toolCallId,
			answer: answer === "dismissed" ? "deny" : answer,
		});
		if (answer === "session" && grant) grants.add(grant.key);
		return answer === "once" || answer === "session";
	};

	/** Nobody answered: the call does not run, and its question waits for /approve. */
	const setAside = (question: Question, ctx: ExtensionContext): ToolCallEventResult => {
		record(question, "timeout");
		away = true;
		waiting.push(question);
		runtime.present("permissions.resolved", {
			id: question.id,
			toolCallId: question.toolCallId,
			answer: "pending",
		});
		showWaiting(ctx);
		return { block: true, reason: pendingReason(question.need) };
	};

	const askUser = async (
		event: ToolCallEvent,
		need: PermissionNeed,
		reason: AskReason,
		flag: string | undefined,
		ctx: ExtensionContext,
		said?: JudgeSaid,
		leaving = false,
	): Promise<ToolCallEventResult | undefined> => {
		const why =
			reason === "flagged"
				? say({ zh: `危险操作：${FLAG_ZH[flag ?? ""] ?? flag}。`, en: `Risky: ${flag}.` })
				: say(REASON_TEXT[reason]);
		// A flagged, protected or long call is decided each time: a grant for its first word would cover what comes next.
		const grant = flag || need.protected || reason === "long" ? undefined : need.grant;
		const command = (event.input as { command?: unknown }).command;
		const asking: Omit<Question, "id"> = {
			toolCallId: event.toolCallId,
			tool: event.toolName,
			need,
			reason,
			...(flag ? { flag } : {}),
			...(said ? { said } : {}),
			leaving,
			...(grant ? { grant } : {}),
			body: [
				// A flagged command shows the parts its flag is about, which a summary cut at a fixed length can leave out,
				// and a long command as much of itself as a person reads at once.
				(flag && flag !== SENDS_CREDENTIAL) || (reason === "long" && typeof command === "string")
					? riskExcerpt(String(command ?? ""), RISK_CONFIRM_CHARS)
					: need.summary,
				why,
			].join("\n"),
			key: callKey(event),
			cwd: ctx.cwd,
			askedAt: Date.now(),
		};
		if (!ctx.hasUI) {
			record(asking, "none");
			return {
				block: true,
				reason: `mu: this needs the user's permission (${modeLabel(mode)}: ${why}), and there is nobody to ask here. Do not try another way around it; say what you needed.`,
			};
		}
		const at = waiting.findIndex((each) => each.key === asking.key);
		if (at >= 0) {
			// The same call again while nobody has answered about it: the answer is the same, with no second wait.
			if (away) return { block: true, reason: pendingReason(need) };
			// The user is back: this call asks them now, in place of /approve.
			waiting.splice(at, 1);
		}
		const question: Question = { ...asking, id: `permission-${++asked}` };
		if (away && waitMs > 0) {
			announce(question);
			return setAside(question, ctx);
		}
		const answer = await pick(question, ctx, ctx.signal, waitMs);
		if (answer === "timeout") return setAside(question, ctx);
		away = false;
		showWaiting(ctx);
		if (settle(question, answer)) return undefined;
		return {
			block: true,
			reason: `The user did not allow this (${need.summary}). Do not try another way around it: ask them, or carry on without it.`,
		};
	};

	/** A call that asks to run outside the write sandbox (`outside: true`), while the sandbox is on. */
	const leavesFloor = (event: ToolCallEvent) => runtime.floorExit?.asks(event.toolName, event.input) === true;

	const gate = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		// The way out of the write sandbox is decided in full access too: allowed without a question, the sandbox would
		// bound nothing.
		const leaving = leavesFloor(event);
		if (mode === "full" && !leaving) return undefined;
		const input = event.input as Record<string, unknown>;
		const why = leaving ? String(input.reason ?? "").trim() : "";
		if (leaving && !why)
			return {
				block: true,
				reason:
					"mu: outside: true needs a reason: say why this command must write outside the write sandbox. Nothing ran.",
			};
		const found = permissionNeed(
			event.toolName,
			input,
			ctx.cwd,
			[...guarded, ...projectSettings(ctx.cwd)],
			options.readOnlyChains,
		);
		const command = isShellTool(event.toolName) || event.toolName === "bg_start" ? String(input.command ?? "") : "";
		// A call that would carry a credential away is the user's to allow, each time, even one that only looks (a
		// `web_fetch` with the key in its address). The person reads it with the credential taken out.
		const leaking = carriesCredential(event.toolName, input);
		const asked: PermissionNeed | undefined = leaking
			? {
					kind: found?.kind ?? (command ? "shell" : "other"),
					summary: redactSecrets(
						found?.summary ?? clip(`${event.toolName} ${JSON.stringify(input)}`, 300),
						environmentSecrets(),
					),
					...(found?.protected ? { protected: found.protected } : {}),
				}
			: found;
		// A command that only looks runs inside the sandbox, which lets it read everything: nothing to let out.
		if (!asked) return undefined;
		// Out of the sandbox, a command may change files anywhere: allowed once each time, with the model's reason shown.
		const need: PermissionNeed = leaving
			? {
					kind: "outside",
					summary: `${asked.summary}${say({ zh: `（在写入沙箱外运行：`, en: " (outside the write sandbox: " })}${redactSecrets(clip(why, 200), environmentSecrets())}${say({ zh: "）", en: ")" })}`,
					...(asked.protected ? { protected: asked.protected } : {}),
				}
			: asked;
		const flag = leaking ? SENDS_CREDENTIAL : command ? riskFlag(command) : undefined;
		// Allowed with /approve after its question had waited out its time: this same call runs, once.
		if (allowedLate.delete(callKey(event))) return letOut(event, approvedBy(event, need, "user"));
		if (!need.protected && !flag && need.grant && grants.has(need.grant.key)) return approvedBy(event, need, "grant");
		let reason: AskReason = need.protected ? "protected" : flag ? "flagged" : "ask";
		let said: JudgeSaid | undefined;
		// The way out goes to the judge first in full access as well; minimal permissions ask the user about it, as about
		// everything else.
		if ((mode === "judge" || (leaving && mode === "full")) && !need.protected && flag !== SENDS_CREDENTIAL) {
			// Editing the project is the task itself, and a checkpoint can take it back.
			if (need.kind === "edit" && need.inProject && !flag) return undefined;
			const verdict = await judgeApproves(event, need, flag, ctx, leaving);
			if (verdict.approved) return letOut(event, approvedBy(event, need, "judge"));
			reason = verdict.reason;
			said = verdict.said;
		}
		return letOut(event, await askUser(event, need, reason, flag, ctx, said, leaving));
	};

	/** A call that asked out of the write sandbox and was allowed goes out, this once. */
	const letOut = (event: ToolCallEvent, result: ToolCallEventResult | undefined) => {
		if (!result?.block && leavesFloor(event)) runtime.floorExit?.allow(event.toolCallId, event.input);
		return result;
	};

	// A gate that failed must not open: an error asks the user, or refuses where nobody can be asked.
	pi.on(
		"tool_call",
		async (event, ctx) => {
			runtime.touch(ctx);
			try {
				return await gate(event, ctx);
			} catch (error) {
				if (mode === "full" && !leavesFloor(event)) return undefined;
				const problem = error instanceof Error ? error.message : String(error);
				if (ctx.signal?.aborted) return { block: true, reason: "Canceled." };
				if (ctx.hasUI) {
					const allowed = await ctx.ui
						.confirm(
							say({ zh: "mu 需要你授权", en: "mu needs your permission" }),
							`${event.toolName}\n\n${problem}`,
						)
						.catch(() => false);
					if (allowed) return letOut(event, undefined);
				}
				return { block: true, reason: `mu could not check permission for this call: ${problem}` };
			}
		},
		// What is allowed is what runs: mu loads before the user's extensions, and one of theirs may still change the call.
		{ final: true },
	);

	pi.registerCommand("permissions", {
		description: say({
			zh: "mu 不问你就能做多少事：/permissions full（完全访问）| judge（判定模式）| ask（最小权限），不带参数就弹出选择；/permissions reset 忘掉这次对话里允许过的操作",
			en: "Set how much mu can do without asking: /permissions full | judge | ask (no argument opens a picker); /permissions reset clears what you've allowed so far",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const words = args.trim().split(/\s+/).filter(Boolean);
			// The app switching a conversation on its own: this conversation only, said nowhere but in the switch itself.
			const here = words.includes("--here");
			const word = words.filter((each) => each !== "--here").join(" ");
			if (here) {
				const next = parseMode(word);
				// Already so: nothing to switch, and what the user allowed stays allowed.
				if (next && next !== mode) switchTo(next, ctx, true);
				else show(ctx);
				return;
			}
			if (word === "reset") {
				grants = new Set();
				allowedLate = new Set();
				ctx.ui.notify(
					say({
						zh: "已清空这次对话里“都允许”过的操作。",
						en: "Cleared everything you allowed for this session.",
					}),
					"info",
				);
				return;
			}
			let next = parseMode(word);
			if (!word && ctx.hasUI) {
				const labels = PERMISSION_MODES.map(
					(each) =>
						`${modeLabel(each)}${each === mode ? say({ zh: "（当前）", en: " (current)" }) : ""} — ${say({ zh: MODE_TEXT[each].zhDescription, en: MODE_TEXT[each].enDescription })}`,
				);
				const picked = await ctx.ui.select(say({ zh: "权限模式", en: "Permission mode" }), labels, {
					initialIndex: PERMISSION_MODES.indexOf(mode),
				});
				next = picked === undefined ? undefined : PERMISSION_MODES[labels.indexOf(picked)];
				if (!next) return;
			}
			if (!next) {
				const allowed = [...grants].join(", ");
				ctx.ui.notify(
					[
						say({ zh: `权限：${modeLabel(mode)}`, en: `Permissions: ${modeLabel(mode)}` }),
						say({ zh: MODE_TEXT[mode].zhDescription, en: MODE_TEXT[mode].enDescription }),
						...(allowed
							? [say({ zh: `这次对话都允许：${allowed}`, en: `Allowed for this session: ${allowed}` })]
							: []),
						say({
							zh: "切换：/permissions full | judge | ask",
							en: "To switch: /permissions full | judge | ask",
						}),
					].join("\n"),
					word ? "warning" : "info",
				);
				return;
			}
			switchTo(next, ctx);
			ctx.ui.notify(
				say({
					zh: `权限已切换为「${modeLabel(next)}」：${MODE_TEXT[next].zhDescription}`,
					en: `Permissions set to ${modeLabel(next)}. ${MODE_TEXT[next].enDescription}`,
				}),
				"info",
			);
		},
	});

	pi.registerCommand("approve", {
		description: say({
			zh: "回答还在等你授权的步骤：没人及时回答的权限提问，逐个再问一遍",
			en: "Answer the steps still waiting for your permission",
		}),
		handler: async (_args, ctx) => {
			runtime.touch(ctx);
			away = false;
			if (waiting.length === 0) {
				ctx.ui.notify(say({ zh: "没有等你授权的步骤。", en: "No steps are waiting for your permission." }), "info");
				return;
			}
			const allowed: string[] = [];
			const refused: string[] = [];
			while (waiting.length > 0) {
				const question = waiting[0];
				const answer = await pick(question, ctx, undefined, waitMs);
				// Nobody answered this time either: it waits on, with the ones after it.
				if (answer === "timeout") {
					away = true;
					break;
				}
				waiting.shift();
				if (settle(question, answer, true)) {
					allowedLate.add(question.key);
					allowed.push(question.need.summary);
				} else refused.push(question.need.summary);
			}
			showWaiting(ctx);
			if (allowed.length + refused.length === 0) return;
			// Not the user's own words: mu reports what they picked, so nothing reads it as a new task or a rule of theirs.
			pi.sendMessage(
				{
					customType: APPROVED_MESSAGE,
					content: [
						"[mu: the user answered about the steps that were waiting for their permission]",
						...allowed.map(
							(summary) =>
								`- Allowed: ${summary}. If you still need it, make that same call again; the permission holds for exactly that call, once.`,
						),
						...refused.map((summary) => `- Not allowed: ${summary}. Do not try another way around it.`),
					].join("\n"),
					display: true,
				},
				// Steered into a run that is going. With none going, an allowed call is work to go back to and starts one; a
				// refusal alone is only something to know, and is there when the next run starts.
				{ deliverAs: "steer", ...(allowed.length > 0 ? { triggerTurn: true } : {}) },
			);
		},
	});
}
