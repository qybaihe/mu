import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCheckCommand } from "../../checkpoint/mutating.ts";
import { goalMet } from "../../decisions/goal-met.ts";
import { openItems } from "../../frame/frame.ts";
import {
	GOAL_CHECK_SYSTEM,
	type GoalEvidence,
	type GoalJudgement,
	goalCheckRequest,
	parseGoalJudgement,
} from "../../goal/check.ts";
import { type Coded, say } from "../../language.ts";
import type { LlmCompletion } from "../../providers/llm.ts";
import { clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";
import { describeCall } from "./constraints.ts";

/** Stored in the session, so a rewind or a fork brings back the goal of that branch. */
export const GOAL_ENTRY = "kyrn.goal";
export const GOAL_MESSAGE = "kyrn.goal";

const GOAL_LENGTH = 600;
const STATUS_KEY = "mu-goal";
const MAX_STEPS = 16;

export type GoalStatus = "active" | "paused" | "met" | "cleared";

/** Who decided the last check: the model, the judge (Jev), or the facts alone. */
export type GoalCheckedBy = "model" | "jev" | "rules";

export interface GoalState {
	readonly status: GoalStatus;
	/** The condition, in the user's words. */
	readonly text: string;
	/** Why it is not running, or why the last check said what it said, for the user to read. */
	readonly reason?: string;
	/**
	 * Why it paused, as a code for a client that translates (`reason` is the zh/en of it):
	 * interrupted, model_call_failed, needs_user {detail?}, unjudged, idle {runs}, no_progress {runs, detail?},
	 * continuations_used_up {max}, minutes_used_up {minutes}, session_reopened. Unset when `reason` is the model's own.
	 */
	readonly reasonCode?: string;
	readonly reasonParams?: Readonly<Record<string, string | number>>;
	/** Times mu sent the agent back to work since the user last spoke. */
	readonly continuations: number;
	/** The next step the last check named. */
	readonly next?: string;
	readonly checkedBy?: GoalCheckedBy;
}

export function parseGoalEntry(data: unknown): GoalState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const { status, text, reason, reasonCode, reasonParams, continuations, next, checkedBy } = data as Record<
		string,
		unknown
	>;
	if (status !== "active" && status !== "paused" && status !== "met" && status !== "cleared") return undefined;
	if (typeof text !== "string" || !text.trim()) return undefined;
	return {
		status,
		text,
		reason: typeof reason === "string" ? reason : undefined,
		...(typeof reasonCode === "string"
			? {
					reasonCode,
					...(typeof reasonParams === "object" && reasonParams !== null
						? { reasonParams: reasonParams as Record<string, string | number> }
						: {}),
				}
			: {}),
		continuations: typeof continuations === "number" && continuations >= 0 ? Math.floor(continuations) : 0,
		next: typeof next === "string" && next ? next : undefined,
		checkedBy: checkedBy === "model" || checkedBy === "jev" || checkedBy === "rules" ? checkedBy : undefined,
	};
}

/** For the person, in the app's language (MU_LANG): Chinese or English. */
export function describeGoal(goal: GoalState | undefined): string {
	if (!goal || goal.status === "cleared") {
		return say({
			zh: "没有设定目标。/goal <条件> 让代理一直干到条件成立；/goal clear 结束目标。",
			en: "No goal is set. /goal <condition> keeps the agent working until the condition holds; /goal clear ends it.",
		});
	}
	const n = goal.continuations;
	const state =
		goal.status === "active"
			? say({ zh: `进行中（已续跑 ${n} 次）`, en: `running (continued ${n} time${n === 1 ? "" : "s"})` })
			: goal.status === "met"
				? say({ zh: "已达成", en: "met" })
				: say({
						zh: `已暂停：${goal.reason ?? "在等你"}。你发下一条消息就会接着干`,
						en: `paused: ${goal.reason ?? "waiting for you"}. Your next message resumes it`,
					});
	const last =
		goal.status === "active" && goal.reason ? say({ zh: "\n上次检查：", en: "\nlast check: " }) + goal.reason : "";
	const next = goal.status === "active" && goal.next ? say({ zh: "\n下一步：", en: "\nnext: " }) + goal.next : "";
	return `${say({ zh: "目标：", en: "goal: " })}${goal.text}\n${say({ zh: "状态：", en: "status: " })}${state}${last}${next}`;
}

/** What one run did, oldest first, as the goal check reads it: "bash npm test -> error". */
export function stepsOf(messages: readonly unknown[]): { steps: string[]; checks: GoalEvidence["lastCheck"][] } {
	const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
	const steps: string[] = [];
	const checks: GoalEvidence["lastCheck"][] = [];
	for (const raw of messages) {
		const message = raw as { role?: string; content?: unknown; toolCallId?: string; isError?: boolean };
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
				if (block.type === "toolCall" && block.id && block.name) {
					calls.set(block.id, { name: block.name, input: (block.arguments ?? {}) as Record<string, unknown> });
				}
			}
		} else if (message.role === "toolResult" && message.toolCallId) {
			const call = calls.get(message.toolCallId);
			if (!call) continue;
			steps.push(
				`${call.name} ${clip(describeCall(call.name, call.input), 160)} -> ${message.isError ? "error" : "ok"}`,
			);
			const command = isShellTool(call.name) ? String(call.input.command ?? "") : "";
			if (command && isCheckCommand(command)) {
				const output = textOf(message.content);
				checks.push({ command: clip(command, 200), failed: message.isError === true, output: output.slice(-600) });
			}
		}
	}
	return { steps: steps.slice(-MAX_STEPS), checks };
}

/** The check's answer after the facts had their say. */
type Outcome =
	| { readonly kind: "met"; readonly reason?: string }
	| { readonly kind: "continue"; readonly reason?: string; readonly next?: string; readonly stalled: boolean }
	| { readonly kind: "ask"; readonly reason?: string }
	| { readonly kind: "unjudged" };

/**
 * Goal mode. `/goal <condition>` states once what "finished" means, and from
 * then on the agent is not allowed to stop short of it: each time it ends a
 * run, a model reads the goal against what the run did and what the harness
 * knows for a fact (open acceptance items, an edit nothing ran after, the
 * last test run), and the agent is sent back to work with the next step
 * named, until the goal holds.
 *
 * The check is the session's model unless another is set: whether a goal
 * holds is a judgement of evidence, which the fast judge reads too thinly.
 * Jev is the fallback when no model answers, and the facts are the last word
 * either way: work that is provably unfinished goes on.
 *
 * It stops by itself when the agent needs the user, when the user interrupts,
 * when a model call fails, when the agent idles or goes in circles, and when
 * its allowance of continuations or minutes is used up. The user's next
 * message picks a paused goal up again with a fresh allowance.
 */
export function registerGoal(runtime: KyrnRuntime): void {
	const options = runtime.options("goal", {
		enabled: true,
		maxContinuations: 20,
		maxMinutes: 180,
		idleLimit: 2,
		/** Who reads whether the goal holds: "model" (a language model) or "jev" (the fast judge). */
		checker: "model",
		/** "provider/model" for the check; empty: the session's current model. */
		checkModel: "",
		/** Thinking level of the check: off, minimal, low, medium, high. */
		checkThinking: "off",
		checkTimeoutMs: 90000,
		/** Checks in a row that found the agent going round in circles before the goal pauses. */
		stallLimit: 2,
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	let goal: GoalState | undefined;
	/** Runs in a row that ended without a single tool call. */
	let idle = 0;
	/** Checks in a row that found no progress. */
	let stalls = 0;
	let since = Date.now();
	let lastCheck: GoalEvidence["lastCheck"];

	const show = (ctx: ExtensionContext | undefined, text: string, level: "info" | "warning" = "info") => {
		if (ctx?.hasUI) ctx.ui.notify(text, level);
	};
	const status = () => {
		const ctx = runtime.ctx;
		if (!ctx?.hasUI) return;
		const label =
			!goal || goal.status === "cleared"
				? undefined
				: goal.status === "active"
					? `${say({ zh: "目标", en: "goal" })} ${goal.continuations}/${options.maxContinuations}`
					: goal.status === "met"
						? say({ zh: "目标已达成", en: "goal met" })
						: say({ zh: "目标已暂停", en: "goal paused" });
		ctx.ui.setStatus(STATUS_KEY, label);
	};
	const adopt = (next: GoalState | undefined) => {
		goal = next;
		runtime.goalActive = next?.status === "active";
		status();
	};
	/** Only a pause says why in a code: every other state's reason is the model's, so an old code must not linger. */
	const save = (next: GoalState, coded?: Coded) => {
		const { reasonCode: _code, reasonParams: _params, ...rest } = next;
		const stored: GoalState = coded
			? { ...rest, reasonCode: coded.code, ...(coded.params ? { reasonParams: coded.params } : {}) }
			: rest;
		adopt(stored);
		pi.appendEntry<GoalState>(GOAL_ENTRY, stored);
		runtime.present("goal.state", { ...stored, maxContinuations: options.maxContinuations });
	};
	const pause = (ctx: ExtensionContext, reason: string, coded: Coded) => {
		if (!goal) return;
		save({ ...goal, status: "paused", reason, next: undefined }, coded);
		show(
			ctx,
			say({ zh: `mu 目标已暂停：${reason}。\n${goal.text}`, en: `mu goal paused: ${reason}.\n${goal.text}` }),
			"warning",
		);
	};
	const fresh = () => {
		idle = 0;
		stalls = 0;
		since = Date.now();
	};

	const restore = (ctx: ExtensionContext) => {
		runtime.touch(ctx);
		let restored: GoalState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === GOAL_ENTRY) {
				restored = parseGoalEntry(entry.data) ?? restored;
			}
		}
		// A goal that was running when the session closed does not start by itself: the user may be elsewhere now.
		if (restored?.status === "active") {
			const { reasonParams: _params, ...rest } = restored;
			const paused: GoalState = {
				...rest,
				status: "paused",
				reason: say({ zh: "会话重新打开了", en: "the session was reopened" }),
				reasonCode: "session_reopened",
			};
			adopt(paused);
			// The app last heard "active": it hears the pause, though the session keeps its entries as they were.
			runtime.present("goal.state", { ...paused, maxContinuations: options.maxContinuations });
		} else {
			adopt(restored);
		}
		fresh();
		lastCheck = undefined;
	};
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
		"input",
		failOpen((event) => {
			if (event.source === "extension" || !event.text.trim() || event.streamingBehavior) return undefined;
			// A command is not the user picking the work up again. A message may well start with a path, though.
			const command = /^\/(\S+)/.exec(event.text.trim())?.[1];
			if (command && pi.getCommands().some((candidate) => candidate.name === command)) return undefined;
			// The user is back and has seen where things stand: a paused goal goes on, with a fresh allowance.
			if (goal?.status === "paused") save({ ...goal, status: "active", reason: undefined, continuations: 0 });
			if (goal?.status === "active") {
				if (goal.continuations > 0) adopt({ ...goal, continuations: 0 });
				fresh();
			}
			return undefined;
		}),
	);

	/** The model that checks the goal: the one configured for it, else the session's own. */
	const checkerModel = (ctx: ExtensionContext): LlmCompletion | undefined => {
		const thinking = options.checkThinking;
		if (options.checkModel) return runtime.llm(options.checkModel, { thinking });
		return ctx.model ? runtime.llm(`${ctx.model.provider}/${ctx.model.id}`, { thinking }) : undefined;
	};

	const askModel = async (ctx: ExtensionContext, evidence: GoalEvidence): Promise<GoalJudgement | undefined> => {
		const complete = checkerModel(ctx);
		if (!complete) return undefined;
		try {
			const reply = await complete({
				system: GOAL_CHECK_SYSTEM,
				user: goalCheckRequest(evidence),
				signal: AbortSignal.timeout(options.checkTimeoutMs),
			});
			return parseGoalJudgement(reply.text);
		} catch {
			return undefined;
		}
	};

	/** The check, then the facts over it: open items or an unverified edit mean "not yet" whatever was said. */
	const check = async (
		ctx: ExtensionContext,
		evidence: GoalEvidence,
	): Promise<{ outcome: Outcome; by: GoalCheckedBy }> => {
		const provable = evidence.openItems.length > 0 || evidence.unverifiedFiles.length > 0;
		if (options.checker !== "jev") {
			const judged = await askModel(ctx, evidence);
			if (judged) {
				if (judged.verdict === "needs_user")
					return { outcome: { kind: "ask", reason: judged.reason }, by: "model" };
				if (judged.verdict === "met" && !provable)
					return { outcome: { kind: "met", reason: judged.reason }, by: "model" };
				return {
					outcome: {
						kind: "continue",
						reason: judged.verdict === "met" ? undefined : judged.reason,
						next: judged.next,
						stalled: judged.stalled,
					},
					by: "model",
				};
			}
		}
		const decision = await runtime.engine.decide(goalMet, {
			goal: evidence.goal,
			finalMessage: clip(evidence.finalMessage, 800),
			openItems: evidence.openItems.length,
			unverified: evidence.unverifiedFiles.length > 0,
		});
		const by: GoalCheckedBy = decision.source === "judge" ? "jev" : "rules";
		if (decision.outcome === "met") return { outcome: { kind: "met" }, by };
		if (decision.outcome === "ask") return { outcome: { kind: "ask" }, by };
		if (decision.outcome === "unjudged") return { outcome: { kind: "unjudged" }, by };
		return { outcome: { kind: "continue", stalled: false }, by };
	};

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>(async (event, ctx) => {
			runtime.touch(ctx);
			if (goal?.status !== "active") return undefined;
			const last = [...event.messages].reverse().find((message) => message.role === "assistant") as
				| { content?: unknown; stopReason?: string }
				| undefined;
			// Cut by the harness itself, which also sends the model back to work: not an interruption by the user.
			if (runtime.harnessAbort) return undefined;
			if (last?.stopReason === "aborted") {
				pause(ctx, say({ zh: "你打断了这次运行", en: "you interrupted the run" }), { code: "interrupted" });
				return undefined;
			}
			if (!last || last.stopReason === "error") {
				pause(ctx, say({ zh: "一次模型调用失败了", en: "a model call failed" }), { code: "model_call_failed" });
				return undefined;
			}
			const run = stepsOf(event.messages);
			lastCheck = run.checks.at(-1) ?? lastCheck;
			idle = run.steps.length > 0 ? 0 : idle + 1;

			const open = openItems(runtime.frame);
			const turn = runtime.turn;
			const unverified = turn.editedFiles.size > 0 && !turn.ranCommandAfterLastEdit ? [...turn.editedFiles] : [];
			const evidence: GoalEvidence = {
				goal: clip(goal.text, GOAL_LENGTH),
				continuation: goal.continuations + 1,
				maxContinuations: options.maxContinuations,
				previousNext: goal.next,
				openItems: open.map((item) => `${item.id} ${item.text}`),
				unverifiedFiles: unverified,
				lastCheck,
				steps: run.steps,
				finalMessage: clip(textOf(last.content), 1500),
			};
			const checked = goal;
			// A model call at the end of the run: the person sees the agent stop and should know what the pause is.
			runtime.progress(say({ zh: "正在检查目标是否达成", en: "checking whether the goal is met" }), "goal_check");
			const { outcome, by } = await check(ctx, evidence);
			// The goal may have been cleared or replaced while the check was reading: that verdict was about another goal.
			if (goal !== checked || goal?.status !== "active") return undefined;

			if (outcome.kind === "met") {
				save({ ...goal, status: "met", reason: outcome.reason, next: undefined, checkedBy: by });
				const why = outcome.reason ? ` ${outcome.reason}` : "";
				const n = goal.continuations;
				show(
					ctx,
					say({
						zh: `mu 目标已达成（续跑了 ${n} 次）。${why}\n${goal.text}`,
						en: `mu goal met after ${n} continuation${n === 1 ? "" : "s"}.${why}\n${goal.text}`,
					}),
				);
				return undefined;
			}
			if (outcome.kind === "ask") {
				pause(
					ctx,
					outcome.reason
						? say({
								zh: `代理需要你：${outcome.reason}`,
								en: `the agent needs something from you: ${outcome.reason}`,
							})
						: say({ zh: "代理在等你回复", en: "the agent needs something from you" }),
					{ code: "needs_user", ...(outcome.reason ? { params: { detail: outcome.reason } } : {}) },
				);
				return undefined;
			}
			if (outcome.kind === "unjudged") {
				pause(
					ctx,
					say({
						zh: "没有判定器能读出目标是否达成，也没有能证明还没做完的事",
						en: "no judge could tell whether the goal is met, and nothing shows it's unfinished",
					}),
					{ code: "unjudged" },
				);
				return undefined;
			}
			stalls = outcome.stalled ? stalls + 1 : 0;
			if (idle >= options.idleLimit) {
				pause(
					ctx,
					say({
						zh: `代理连续 ${idle} 次什么都没做就停下了`,
						en: `${idle} runs in a row ended without the agent doing anything`,
					}),
					{ code: "idle", params: { runs: idle } },
				);
				return undefined;
			}
			if (stalls >= options.stallLimit) {
				const why = outcome.reason ? ` (${outcome.reason})` : "";
				pause(
					ctx,
					say({
						zh: `连续 ${stalls} 次没有进展${why}，告诉它接下来怎么做`,
						en: `no progress in ${stalls} runs in a row${why}; tell it how to proceed`,
					}),
					{ code: "no_progress", params: { runs: stalls, ...(outcome.reason ? { detail: outcome.reason } : {}) } },
				);
				return undefined;
			}
			if (goal.continuations >= options.maxContinuations) {
				pause(
					ctx,
					say({
						zh: `续跑次数（${options.maxContinuations} 次）用完了`,
						en: `reached the limit of ${options.maxContinuations} continuation${options.maxContinuations === 1 ? "" : "s"}`,
					}),
					{ code: "continuations_used_up", params: { max: options.maxContinuations } },
				);
				return undefined;
			}
			if (Date.now() - since > options.maxMinutes * 60_000) {
				pause(
					ctx,
					say({
						zh: `时间额度（${options.maxMinutes} 分钟）用完了`,
						en: `reached the ${options.maxMinutes}-minute time limit`,
					}),
					{ code: "minutes_used_up", params: { minutes: options.maxMinutes } },
				);
				return undefined;
			}

			const next: GoalState = {
				...goal,
				continuations: goal.continuations + 1,
				reason: outcome.reason,
				next: outcome.next,
				checkedBy: by,
			};
			save(next);
			const facts: string[] = [];
			if (open.length > 0) {
				facts.push(
					`Open acceptance items: ${open.map((item) => `${item.id} ${item.text}`).join("; ")}. Tick each with the todo tool and one line of evidence, or say which no longer apply.`,
				);
			}
			if (unverified.length > 0) {
				facts.push(`You edited ${unverified.join(", ")} and nothing has run since. Verify the change.`);
			}
			pi.sendMessage(
				{
					customType: GOAL_MESSAGE,
					content: [
						`The goal the user set is not met yet: "${clip(goal.text, GOAL_LENGTH)}"`,
						...(outcome.reason ? [`Why not yet: ${outcome.reason}`] : []),
						...(outcome.stalled
							? ["The last run did not bring the goal closer. Do not repeat it: take a different approach."]
							: []),
						...(outcome.next ? [`Next: ${outcome.next}`] : []),
						...facts,
						"Keep working towards it. When it holds, say so plainly and name the evidence. If you cannot go on without the user, say exactly what you need from them and stop.",
						`(continuation ${next.continuations} of ${options.maxContinuations})`,
					].join("\n"),
					display: true,
					details: { continuation: next.continuations, checkedBy: by },
				},
				{ triggerTurn: true },
			);
			return undefined;
		}),
	);

	const begin = (ctx: ExtensionContext, text: string) => {
		save({ status: "active", text, continuations: 0 });
		fresh();
		lastCheck = undefined;
		// The condition is the user's own sentence: the task frame reads it like any other message of theirs.
		runtime.beginTurn(text);
		show(
			ctx,
			say({
				zh: `mu 目标已设定：代理会一直干到它成立为止（最多续跑 ${options.maxContinuations} 次）。`,
				en: `mu goal set. The agent will keep working until it's met (up to ${options.maxContinuations} continuations).`,
			}),
		);
		pi.sendMessage(
			{
				customType: GOAL_MESSAGE,
				content: [
					`The user set a goal: "${clip(text, GOAL_LENGTH)}"`,
					"Work until it holds. When it does, say so plainly and name the evidence. If you cannot go on without the user, say exactly what you need from them and stop.",
				].join("\n"),
				display: true,
				details: { continuation: 0 },
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("goal", {
		description: say({
			zh: "目标模式：让代理一直干到某个条件成立。/goal <条件> 设定，/goal 查看（没有时会问你），/goal clear 结束",
			en: "Keep the agent working until a condition holds: /goal <condition> sets it, /goal shows it (or asks for one), /goal clear ends it",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const text = args.trim();
			if (!text) {
				// Nothing running and someone to ask: /goal alone enters goal mode by asking for the condition.
				if ((!goal || goal.status === "cleared" || goal.status === "met") && ctx.hasUI) {
					const asked = (
						await ctx.ui.input(
							say({
								zh: "mu 目标：做完时什么必须成立？",
								en: "mu goal: what must be true when the work is done?",
							}),
							say({ zh: "比如：packages/x 的测试全部通过", en: "e.g. all tests in packages/x pass" }),
						)
					)?.trim();
					if (asked) begin(ctx, asked);
					else show(ctx, describeGoal(goal));
					return;
				}
				show(ctx, describeGoal(goal));
				return;
			}
			if (["clear", "off", "stop", "none"].includes(text.toLowerCase())) {
				if (goal && goal.status !== "cleared")
					save({ ...goal, status: "cleared", reason: undefined, next: undefined });
				show(ctx, say({ zh: "mu 目标已清除。", en: "mu goal cleared." }));
				return;
			}
			begin(ctx, text);
		},
	});
}
