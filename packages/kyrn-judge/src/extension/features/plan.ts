import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { say } from "../../language.ts";
import { permissionNeed } from "../../permissions/modes.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";
import { askQuestions, type Question } from "./ask-user.ts";
import { stoppedOn } from "./continuation.ts";

export const PLAN_ENTRY = "kyrn.plan";
export const PLAN_STATUS = "mu.plan";

/** What a `kyrn.plan` entry records: plan mode turned on or off, or a plan the user approved, which ends it. */
export interface PlanRecord {
	readonly state: "on" | "off" | "approved";
	/** How the change came: the user's /plan, or their answer to the approval question. */
	readonly by: "command" | "answer";
	/** An approved plan: how many of its steps went onto the task's checklist. */
	readonly steps?: number;
}

/** The plan's heading: `# Plan`, `## Plan: …`, `# 计划`, `# 方案`. */
const HEADING = /^ {0,3}#{1,3}[ \t]*(?:plan\b|计划|方案)/im;
const STEP = /^ {0,3}(?:[-*+]|\d{1,2}[.)])[ \t]+(.+)$/;
const MAX_STEPS = 12;

const ON_TEXT =
	"[mu: plan mode] The user wants a plan before anything changes. Until they approve one, read, search and ask (ask_user) as much as you need, and change nothing: no edits, no commands that change files or reach beyond this machine, no sub-agents. mu refuses those calls. When the plan is ready, reply with it and stop: start the reply with a line `# Plan`, then the steps as a list, each one what you will do and how you will check it. mu then asks the user to approve it or to keep planning.";
const OFF_TEXT = "[mu: plan mode is off] The user left plan mode without approving a plan: changes are allowed again.";

/** Whether a reply is a plan: it has the heading the plan-mode message asks for. */
export function isPlan(text: string): boolean {
	return HEADING.test(text);
}

/** The top-level list items under the plan's heading, up to the next heading, at most `MAX_STEPS`. */
export function planSteps(text: string): string[] {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => HEADING.test(line));
	if (start < 0) return [];
	const steps: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^ {0,3}#{1,3}[ \t]/.test(line)) break;
		const step = STEP.exec(line);
		if (step) steps.push(step[1].replace(/\*\*/g, "").trim());
		if (steps.length === MAX_STEPS) break;
	}
	return steps.filter(Boolean);
}

/**
 * Plan mode (`/plan`): the agent looks and plans, changes nothing, and starts only once the user approves its plan.
 *
 * Nothing is taken off the model's tool list and the system prompt stays as it is, so the prompt cache holds across
 * the switch: entering plan mode appends one message that says what it means, and the hard part is the permission
 * layer's own reading of a call. In plan mode a call that would need permission in any mode (`permissionNeed`: an
 * edit, a command that is not read-only, a sub-agent, an MCP or browser tool) is refused before anyone is asked, with
 * a reason that says to plan instead. Reading, searching, read-only commands, the to-do list and ask_user go through.
 *
 * A run in plan mode that ends on a reply with a `# Plan` heading is a plan: once the run has settled, mu asks the
 * user with ask_user's dialog (so a client shows it as a question card) whether to approve it. Approving ends plan mode,
 * puts the plan's steps on the task's checklist, and sends "carry it out" as the user's message. Keeping on planning
 * stays in plan mode, and what the user wrote is sent as their message. A message the user types instead of answering
 * closes the question; Esc leaves it to `/plan approve` or a message. While plan mode is on, turn.continue and the
 * completion check do not send the agent back: a plan says what will be done, and that is what it should say.
 *
 * `/plan` turns it on, `/plan <task>` on and sends the task, `/plan off` leaves it, `/plan approve` approves the plan
 * the agent last wrote. It is kept in the session (`kyrn.plan`) and comes back with it. A sub-agent has no plan mode.
 */
export function registerPlan(runtime: KyrnRuntime): void {
	const options = runtime.options("plan", { enabled: true });
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;
	/** The plan the agent last wrote in plan mode, until it is approved or plan mode ends. */
	let plan: string | undefined;
	/** A plan written in the run that is ending, asked about once that run has settled. */
	let toAsk: string | undefined;
	/** The approval question on screen: a message the user types instead closes it. */
	let asking: AbortController | undefined;

	const showStatus = (ctx: ExtensionContext | undefined): void => {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(
			PLAN_STATUS,
			runtime.planMode
				? say({
						zh: "计划模式：批准计划之前不改任何东西（/plan off 退出）",
						en: "Plan mode: nothing changes until you approve a plan (/plan off to leave)",
					})
				: undefined,
		);
	};
	const record = (data: PlanRecord): void => pi.appendEntry(PLAN_ENTRY, data);
	const leave = (ctx: ExtensionContext | undefined): void => {
		runtime.planMode = false;
		plan = undefined;
		toAsk = undefined;
		asking?.abort();
		asking = undefined;
		showStatus(ctx);
	};

	const enter = (ctx: ExtensionContext): boolean => {
		if (runtime.planMode) return false;
		runtime.planMode = true;
		record({ state: "on", by: "command" });
		pi.sendMessage({ customType: PLAN_ENTRY, content: ON_TEXT, display: true });
		showStatus(ctx);
		return true;
	};

	const approve = (ctx: ExtensionContext, written: string, by: PlanRecord["by"]): void => {
		const steps = planSteps(written);
		const added = steps.length > 0 ? (runtime.addChecklist?.(steps) ?? 0) : 0;
		leave(ctx);
		record({ state: "approved", by, steps: added });
		pi.sendUserMessage(
			[
				"I approve the plan. Plan mode is off: carry it out now.",
				...(added > 0
					? [
							`Its ${added === 1 ? "step is" : `${added} steps are`} on the task's checklist (todo list shows them): tick each one as you finish it.`,
						]
					: []),
			].join(" "),
			{ deliverAs: "followUp" },
		);
	};

	/** Asks whether to approve the plan the agent just wrote: approve, keep planning, or the user's own words. */
	const askApproval = async (ctx: ExtensionContext, written: string): Promise<void> => {
		if (!ctx.hasUI) return;
		const controller = new AbortController();
		asking = controller;
		const question: Question = {
			question: say({ zh: "按上面的计划开始做吗？", en: "Start on the plan above?" }),
			header: say({ zh: "计划", en: "Plan" }),
			options: [
				{
					label: say({ zh: "批准，开始做", en: "Approve and start" }),
					description: say({
						zh: "退出计划模式，代理按计划动手；步骤记进任务清单",
						en: "Plan mode ends and the agent carries it out; its steps go on the task's checklist",
					}),
				},
				{
					label: say({ zh: "继续规划", en: "Keep planning" }),
					description: say({
						zh: "留在计划模式；选「都不是」可以写下要改哪里",
						en: 'Stay in plan mode; pick "Something else" to say what to change',
					}),
				},
			],
		};
		const { answers } = await askQuestions(runtime, ctx, [question], { waitMs: 0, signal: controller.signal });
		if (asking === controller) asking = undefined;
		if (controller.signal.aborted || !runtime.planMode || plan !== written) return;
		const answer = answers[0];
		if (!answer) return;
		if (answer.custom !== undefined) {
			pi.sendUserMessage(
				`Not yet. ${answer.custom}\nKeep planning: change the plan and reply with it under # Plan.`,
				{
					deliverAs: "followUp",
				},
			);
			return;
		}
		if (answer.selected[0] === question.options[0].label) approve(ctx, written, "answer");
	};

	pi.registerCommand("plan", {
		description: say({
			zh: "计划模式：先看、先规划，你批准计划后才动手。/plan 进入，/plan <任务> 进入并发出任务，/plan off 退出，/plan approve 批准上一个计划",
			en: "Plan mode: look and plan first, change things only once you approve the plan. /plan enters, /plan <task> enters and sends the task, /plan off leaves, /plan approve approves the last plan",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const words = args.trim();
			if (words === "off") {
				if (!runtime.planMode) {
					ctx.ui.notify(say({ zh: "现在不在计划模式。", en: "Plan mode is off." }), "info");
					return;
				}
				leave(ctx);
				record({ state: "off", by: "command" });
				pi.sendMessage({ customType: PLAN_ENTRY, content: OFF_TEXT, display: true });
				return;
			}
			if (words === "approve") {
				if (!runtime.planMode || !plan) {
					ctx.ui.notify(
						say({ zh: "还没有等你批准的计划。", en: "There is no plan waiting for your approval." }),
						"info",
					);
					return;
				}
				approve(ctx, plan, "command");
				return;
			}
			const entered = enter(ctx);
			if (words) {
				pi.sendUserMessage(words, { deliverAs: "followUp" });
				return;
			}
			if (!entered) ctx.ui.notify(say({ zh: "已经在计划模式里了。", en: "Plan mode is already on." }), "info");
		},
	});

	// Before the permission gate: a call plan mode refuses is not one to ask anybody about.
	pi.on(
		"tool_call",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			if (!runtime.planMode) return undefined;
			const need = permissionNeed(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
			if (!need) return undefined;
			return {
				block: true,
				reason: `mu: plan mode is on, so nothing changes until the user approves a plan, and ${need.summary} could change something. Read, search and ask instead; when the plan is ready, reply with it under # Plan.`,
			};
		}),
		{ final: true },
	);

	pi.on(
		"agent_end",
		failOpen((event: AgentEndEvent, ctx) => {
			runtime.touch(ctx);
			if (!runtime.planMode) return undefined;
			const said = stoppedOn(event);
			if (said && isPlan(said)) {
				plan = said;
				toAsk = said;
			}
			return undefined;
		}),
	);
	pi.on(
		"agent_settled",
		failOpen((event, ctx) => {
			const written = toAsk;
			toAsk = undefined;
			if (!written || event.aborted || !runtime.planMode) return undefined;
			// Not awaited: the run is over, and the question waits for the person as long as it takes.
			void askApproval(ctx, written).catch(() => {});
			return undefined;
		}),
	);
	// What the user types while the question is up is their answer to the plan: the question goes.
	pi.on(
		"before_agent_start",
		failOpen((event) => {
			if (event.messageType === "user" && asking) {
				asking.abort();
				asking = undefined;
			}
			return undefined;
		}),
	);

	const restore = (ctx: ExtensionContext): void => {
		runtime.touch(ctx);
		let on = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== PLAN_ENTRY) continue;
			const state = (entry.data as Partial<PlanRecord> | undefined)?.state;
			if (state === "on") on = true;
			else if (state === "off" || state === "approved") on = false;
		}
		runtime.planMode = on;
		plan = undefined;
		toAsk = undefined;
		showStatus(ctx);
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
}
