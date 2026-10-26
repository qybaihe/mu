import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionContext,
	type ToolCallEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { isCheckChain, shellStart } from "../../checkpoint/mutating.ts";
import type { Decision } from "../../decision.ts";
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
import { subAgentUserGoal } from "../../swarm/brief.ts";
import { clip, type KyrnRuntime } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";
import { describeCall } from "./constraints.ts";
import { FLAG_CODES, FLAG_ZH, RISK_CONFIRM_CHARS, riskExcerpt, riskFlag } from "./guard.ts";
import type { HarnessRoots } from "./inherit.ts";

/** Session entry: the mode this conversation was switched to. A reopened conversation keeps it. */
export const PERMISSIONS_ENTRY = "mu.permissions";
const MODE_STATUS = "mu.permissions";
const PENDING_STATUS = "mu.permissions.pending";

/**
 * Why the user is being asked. `nojudge` and `judgedown` are judge mode without a verdict: no judge can answer yet
 * (no usable key or credit, or none trusted with approvals, so every step asks), or the judge did not answer this
 * time (down, too slow, a broken answer).
 */
export type AskReason = "ask" | "unsure" | "beyond" | "unrelated" | "flagged" | "protected" | "nojudge" | "judgedown";

const KIND_TEXT: Readonly<Record<PermissionKind, { zh: string; en: string }>> = {
	edit: { zh: "改文件", en: "edit a file" },
	shell: { zh: "运行命令", en: "run a command" },
	run: { zh: "运行程序", en: "run a program" },
	outside: { zh: "改动项目外的文件", en: "change a file outside the project" },
	delegate: { zh: "派出子代理", en: "start subagents" },
	other: { zh: "对外操作", en: "act outside this computer" },
};

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
};

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
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	const defaults = new PermissionDefaults(roots ? join(roots.agentDir, "mu") : undefined);
	const guarded = protectedPaths(roots);
	const initial = (): PermissionMode =>
		parseMode(muEnv("PERMISSIONS")) ?? defaults.get() ?? parseMode(options.mode) ?? "judge";
	let mode: PermissionMode = initial();
	/** What the user allowed "for this conversation": `shell:npm test`, `edit`, `tool:browse`. */
	let grants = new Set<string>();
	let asked = 0;
	runtime.permissionMode = () => mode;

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
		grants = new Set();
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
		grants = new Set();
		show(ctx);
	});

	const approvedBy = (event: ToolCallEvent, need: PermissionNeed, by: "judge" | "grant") => {
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
	): Promise<{ approved: boolean; reason: AskReason }> => {
		const call = `${event.toolName}: ${clip(describeCall(event.toolName, event.input), 400)}`;
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
				// The whole command, or every part a rule flagged: the judge cannot weigh what it cannot see.
				{ command: riskExcerpt(String((event.input as { command?: unknown }).command ?? "")), userMessage, flag },
				{ signal: ctx.signal },
			);
			// The user chose the judge to decide, so its verdict counts in shadow too; no verdict means asking. A rule
			// flagged the call, so only the judge being sure the user asked for it runs it.
			const requested = decision.answers?.requested;
			const asked = requested?.type === "boolean" && threeZone(requested) === "yes";
			return { approved: asked && (decision.judged ?? decision.outcome) === "allow", reason: "flagged" };
		}
		const frame = runtime.frame;
		const input = event.input as Record<string, unknown>;
		const powershell =
			event.toolName === "powershell" || (event.toolName === "bg_start" && process.platform === "win32");
		const check =
			need.kind === "shell" &&
			isCheckChain(String(input.command ?? ""), powershell, ctx.cwd, shellStart(event.toolName, input, ctx.cwd));
		const decision = await runtime.engine.decide(
			toolApproval,
			{
				task: clip(
					inherited ?? ([frame?.goal, frame?.currentSubgoal].filter(Boolean).join(" / now: ") || userMessage),
					600,
				),
				userMessage,
				call,
				where:
					need.kind === "outside"
						? "outside the project folder"
						: need.kind === "shell" || need.kind === "run"
							? "a program run in the project folder"
							: need.kind === "delegate"
								? "subagents working on the project"
								: "an action outside this computer or program, such as a web page or a connected service",
				check,
			},
			{ signal: ctx.signal, about: call },
		);
		const verdict = decision.judged ?? decision.outcome;
		if (verdict === "approve") return { approved: true, reason: "ask" };
		return { approved: false, reason: unanswered(decision) ?? verdict };
	};

	const askUser = async (
		event: ToolCallEvent,
		need: PermissionNeed,
		reason: AskReason,
		flag: string | undefined,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> => {
		const why =
			reason === "flagged"
				? say({ zh: `危险操作：${FLAG_ZH[flag ?? ""] ?? flag}。`, en: `Risky: ${flag}.` })
				: say(REASON_TEXT[reason]);
		// A flagged or protected call is decided each time: a grant for its first word would cover what comes next.
		const grant = flag || need.protected ? undefined : need.grant;
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `mu: this needs the user's permission (${modeLabel(mode)}: ${why}), and there is nobody to ask here. Do not try another way around it; say what you needed.`,
			};
		}
		const id = `permission-${++asked}`;
		const once = say(ANSWERS.once);
		const session = grant
			? `${say(ANSWERS.session)}${say({ zh: `（${grant.label}）`, en: ` (${grant.label})` })}`
			: undefined;
		const deny = say(ANSWERS.deny);
		runtime.present("permissions.request", {
			id,
			// The call this is about, here and in `permissions.resolved`: a client marks that call's own row by it, in
			// its own words. The model is still told in English why a refused call did not run.
			toolCallId: event.toolCallId,
			mode,
			tool: event.toolName,
			kind: need.kind,
			summary: need.summary,
			reason,
			...(flag ? { flag, flagCode: FLAG_CODES[flag] ?? flag } : {}),
			...(grant ? { grant } : {}),
			answers: [once, ...(session ? [session] : []), deny],
			// The same answers by id, in the same order: what `permissions.resolved` reports back.
			answerIds: ["once", ...(session ? ["session"] : []), "deny"],
		});
		ctx.ui.setStatus(
			PENDING_STATUS,
			say({
				zh: `等你授权：${clip(need.summary, 60)}`,
				en: `Waiting for your permission: ${clip(need.summary, 60)}`,
			}),
		);
		let picked: string | undefined;
		try {
			picked = await ctx.ui.select(
				[
					say({ zh: `mu 想${KIND_TEXT[need.kind].zh}，需要你授权`, en: `mu wants to ${KIND_TEXT[need.kind].en}` }),
					// A flagged command shows the parts its flag is about, which a summary cut at a fixed length can leave out.
					flag
						? riskExcerpt(String((event.input as { command?: unknown }).command ?? ""), RISK_CONFIRM_CHARS)
						: need.summary,
					why,
				].join("\n"),
				[once, ...(session ? [session] : []), deny],
				{ signal: ctx.signal },
			);
		} finally {
			ctx.ui.setStatus(PENDING_STATUS, undefined);
		}
		const answer = picked === once ? "once" : session && picked === session ? "session" : "deny";
		runtime.present("permissions.resolved", { id, toolCallId: event.toolCallId, answer });
		if (answer === "session" && grant) grants.add(grant.key);
		if (answer !== "deny") return undefined;
		return {
			block: true,
			reason: `The user did not allow this (${need.summary}). Do not try another way around it: ask them, or carry on without it.`,
		};
	};

	const gate = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		if (mode === "full") return undefined;
		const input = event.input as Record<string, unknown>;
		const need = permissionNeed(
			event.toolName,
			input,
			ctx.cwd,
			[...guarded, ...projectSettings(ctx.cwd)],
			options.readOnlyChains,
		);
		if (!need) return undefined;
		const command = isShellTool(event.toolName) || event.toolName === "bg_start" ? String(input.command ?? "") : "";
		const flag = command ? riskFlag(command) : undefined;
		if (!need.protected && !flag && need.grant && grants.has(need.grant.key)) return approvedBy(event, need, "grant");
		let reason: AskReason = need.protected ? "protected" : flag ? "flagged" : "ask";
		if (mode === "judge" && !need.protected) {
			// Editing the project is the task itself, and a checkpoint can take it back.
			if (need.kind === "edit" && need.inProject && !flag) return undefined;
			const verdict = await judgeApproves(event, need, flag, ctx);
			if (verdict.approved) return approvedBy(event, need, "judge");
			reason = verdict.reason;
		}
		return askUser(event, need, reason, flag, ctx);
	};

	// A gate that failed must not open: an error asks the user, or refuses where nobody can be asked.
	pi.on("tool_call", async (event, ctx) => {
		runtime.touch(ctx);
		try {
			return await gate(event, ctx);
		} catch (error) {
			if (mode === "full") return undefined;
			const problem = error instanceof Error ? error.message : String(error);
			if (ctx.signal?.aborted) return { block: true, reason: "Canceled." };
			if (ctx.hasUI) {
				const allowed = await ctx.ui
					.confirm(say({ zh: "mu 需要你授权", en: "mu needs your permission" }), `${event.toolName}\n\n${problem}`)
					.catch(() => false);
				if (allowed) return undefined;
			}
			return { block: true, reason: `mu could not check permission for this call: ${problem}` };
		}
	});

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
}
