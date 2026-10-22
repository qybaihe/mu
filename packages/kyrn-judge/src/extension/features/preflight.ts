import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Decision } from "../../decision.ts";
import {
	type Gear,
	inputPreflight,
	type PreflightInput,
	type PreflightOutcome,
} from "../../decisions/input-preflight.ts";
import { failOpen, judgedText, type KyrnRuntime, lastTurnStoppedToAsk, recentTurnDigests } from "../runtime.ts";
import {
	gearLabel,
	renderPending,
	renderVerdict,
	turnLabel,
	VERDICT_ENTRY,
	type VerdictData,
	type VerdictState,
	verdictData,
} from "./preflight-view.ts";
import { isUnattended } from "./unattended.ts";
import { judgeDisplayName } from "./welcome.ts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof LEVELS)[number];

/** The thinking level a gear asks for, never raising a chat turn or lowering a heavy one past the user's own setting. */
export function thinkingForGear(gear: Gear, baseline: Level): Level {
	const at = LEVELS.indexOf(baseline);
	if (gear === "chat" || gear === "light") return LEVELS[Math.min(at, LEVELS.indexOf("low"))];
	if (gear === "heavy") return LEVELS[Math.max(at, LEVELS.indexOf("high"))];
	return baseline;
}

/**
 * The hints the main model can be given, by a stable id a client can translate the shown line by.
 *
 * None of them makes the model stop and ask. The user is the resolver of last resort: a loosely worded
 * request is resolved by looking at the workspace and saying the assumption, a reply to a question is
 * acted on, and a big change is planned aloud and then carried out.
 */
export const PREFLIGHT_HINTS = {
	answered:
		"You stopped to ask the user something, and this message is the reply. Take it as the answer and act on it now. Ask nothing more unless the work truly cannot proceed without it.",
	resolve:
		"The request is loosely worded. Resolve it yourself: look at the workspace, take the most plausible reading, say the assumption in one line and carry on. Ask the user only for what cannot be found here, and only after delivering what does not depend on it.",
	side_question: "This is a side question. Answer it briefly, keep the plan for the main task, then carry on with it.",
	plan_first:
		"This looks like a large or risky change. Write a short plan, state it in a few lines, then carry it out. Pause for the user's go-ahead only before a step that cannot be undone.",
	try_hive:
		"This looks hard. If the cause is unknown or a direct attempt fails, use the hive tool: several investigators on the one problem, from different angles, sharing what they find.",
	try_delegate: "This work splits into independent parts. Consider the delegate tool to run them in parallel.",
} as const;

export type PreflightHintId = keyof typeof PREFLIGHT_HINTS;

/** What the rules know about the turn, next to the judge's verdict. */
export interface HintFlags {
	/** The agent's last turn stopped to ask, and this message is the reply (`lastTurnStoppedToAsk`). */
	readonly repliesToQuestion?: boolean;
}

/**
 * Which hints a verdict calls for. Unsure verdicts say nothing.
 *
 * A reply to the agent's own question is acted on, whatever the judge makes of it: "go and find it
 * yourself" reads as vague, and the one hint it must not get is "ask". A loosely worded request gets
 * the resolve hint only when it is about to change files; a lookup, an explanation or a survey costs
 * nothing to read the wrong way, and the model simply looks.
 */
export function hintIdsFor(
	outcome: PreflightOutcome | undefined,
	tools: readonly string[],
	flags: HintFlags = {},
): PreflightHintId[] {
	const ids: PreflightHintId[] = [];
	if (flags.repliesToQuestion) ids.push("answered");
	if (!outcome) return ids;
	if (!flags.repliesToQuestion && outcome.needsClarification === "yes" && outcome.needsFilesChanged !== "no") {
		ids.push("resolve");
	}
	if (outcome.sideQuestion === "yes") ids.push("side_question");
	if (outcome.planFirst === "yes") ids.push("plan_first");
	if (outcome.gear === "heavy" && tools.includes("hive")) ids.push("try_hive");
	if (outcome.swarmWorthy === "yes" && tools.includes("delegate")) ids.push("try_delegate");
	return ids;
}

/** One line per verdict the main model should know about. */
export function hintsFor(
	outcome: PreflightOutcome | undefined,
	tools: readonly string[],
	flags: HintFlags = {},
): string[] {
	return hintIdsFor(outcome, tools, flags).map((id) => PREFLIGHT_HINTS[id]);
}

/**
 * The footer's line after a verdict, in the verdict line's words: "Jev: multi-step task · full effort · 71 ms".
 * A verdict in shadow mode says it was only recorded, since it changed nothing.
 */
export function statusLine(label: string, decision: Decision<PreflightOutcome>): string {
	const latency = decision.latencyMs === undefined ? "" : ` · ${decision.latencyMs} ms`;
	const cut = decision.warnings?.length ? ` (${decision.warnings.length} warnings)` : "";
	const recorded =
		decision.mode === "active" ? "" : ` · ${decision.mode === "shadow" ? "recorded only" : decision.mode}`;
	const shown = decision.mode === "active" ? decision.outcome : (decision.judged ?? decision.outcome);
	const said =
		shown.turnType === "unknown" && !decision.judged
			? (decision.reason ?? "no verdict")
			: `${turnLabel(shown.turnType)} · ${gearLabel(shown.gear)}`;
	return `${judgeDisplayName(label)}: ${said}${latency}${cut}${recorded}`;
}

const PANEL = "kyrn.preflight";
/** The panel is only a stand-in until the message reaches the chat. If it never does (pi refused the prompt), it goes. */
const PANEL_MAX_MS = 30_000;

/** One user message on its way from the editor to the chat, and what the judge said about it. */
interface Staged {
	turnId: number;
	message: string;
	startedAt: number;
	decision?: Decision<PreflightOutcome>;
	/** Set when the prompt stopped waiting for the judge: verdict in hand, time up, or skipped by the user. */
	waitEndedAt?: number;
	waitEndedBy?: "verdict" | "timeout" | "skipped";
	/** `before_agent_start` has run; a verdict that arrives after this changes nothing. */
	turnStarted: boolean;
	applied: boolean;
	thinking?: { from: string; to: string };
	hints: string[];
	hintIds: string[];
	/** What another feature is working out before the turn starts, as it put it. */
	step?: string;
	/** The user message is in the chat and in the session, so the verdict line can follow it. */
	messageShown: boolean;
	entryShown: boolean;
}

export { judgedText };

/** Who settled the verdict and what became of it. Exported for tests. */
export function verdictStateOf(staged: {
	decision?: Decision<PreflightOutcome>;
	turnStarted: boolean;
	applied: boolean;
}): VerdictState {
	const decision = staged.decision;
	if (!decision) return "none";
	if (decision.mode !== "active") return decision.judged ? "shadow" : "none";
	if (decision.source !== "judge" && decision.outcome.turnType === "unknown") return "none";
	return staged.turnStarted && !staged.applied ? "late" : "applied";
}

/**
 * A1-A7: one batched judgment per user message decides the gear of the turn.
 * In shadow mode it only records; in active mode the prompt waits for it
 * (bounded) and the gear adds one-line hints. With `thinking` on it also sets
 * the turn's thinking level; that is off by default, because most providers
 * drop the prompt cache when the thinking level changes, and a cold read of
 * the whole context costs more than the gear saves (user rule, 2026-09-23).
 *
 * The wait is on screen: the message sits in a panel above the editor while
 * the judge reads it, the verdict shows there the moment it lands, and only
 * then does the message move into the chat, with the verdict as a line under
 * it that expands to every answer the judge gave.
 *
 * An unattended run (`mu --print`, json mode; see `unattended.ts`) is not asked about.
 */
export function registerPreflight(runtime: KyrnRuntime): void {
	const options = runtime.options("preflight", {
		enabled: true,
		/** Set the turn's thinking level from the gear. Off: a change of level loses the prompt cache on most providers. */
		thinking: false,
		hints: true,
		/** Show the wait and the verdict in the terminal UI. */
		show: true,
		waitMs: 4000,
		/**
		 * Ask in a `mu --print` or json run too. Off by default: there the verdict buys a hint that is rarely
		 * followed, for judge tokens and up to `waitMs` before every prompt.
		 */
		unattended: false,
	});
	if (!options.enabled) return;
	const { pi } = runtime;
	if (process.env.KYRN_SWARM_DEPTH) {
		// A sub-agent's turn was routed by its parent: role, model and thinking level are set. A second opinion
		// here would undo that choice, and it costs every sub-agent seconds before it starts.
		pi.on(
			"input",
			failOpen((event, ctx) => {
				runtime.touch(ctx);
				if (event.source !== "extension" && event.text.trim() && !event.streamingBehavior) {
					runtime.beginTurn(event.text);
					runtime.startTurnWork(event.text);
				}
				return { action: "continue" as const };
			}),
		);
		return;
	}
	let baseline: Level | undefined;
	let staged: Staged | undefined;
	let panel: { redraw?: () => void; timer?: ReturnType<typeof setTimeout> } | undefined;

	const data = (turn: Staged): VerdictData => {
		const decision = turn.decision;
		if (!decision) {
			const waited = (turn.waitEndedAt ?? Date.now()) - turn.startedAt;
			const skipped = turn.waitEndedBy === "skipped";
			const seconds = Number((waited / 1000).toFixed(1));
			const reason = skipped ? "skipped" : `no answer after ${seconds.toFixed(1)} s`;
			return verdictData(undefined, {
				by: runtime.judgeLabel,
				state: "none",
				reason,
				reasonCode: skipped ? "skipped" : "no_answer",
				...(skipped ? {} : { reasonParams: { seconds } }),
				waitedMs: waited,
			});
		}
		return verdictData(decision, {
			by: decision.source === "judge" || decision.mode !== "active" ? runtime.judgeLabel : "rule",
			state: verdictStateOf(turn),
			thinking: turn.thinking,
			hints: turn.hints,
			hintIds: turn.hintIds,
		});
	};

	const closePanel = (ctx: ExtensionContext) => {
		if (!panel) return;
		if (panel.timer) clearTimeout(panel.timer);
		panel = undefined;
		ctx.ui.setWidget(PANEL, undefined);
	};

	const openPanel = (ctx: ExtensionContext, turn: Staged) => {
		closePanel(ctx);
		const opened: NonNullable<typeof panel> = {};
		panel = opened;
		ctx.ui.setWidget(PANEL, (tui, theme) => {
			// The spinner and the clock move until the wait is over; after that the panel only changes when told to.
			const spinner = setInterval(() => {
				if (turn.waitEndedAt === undefined) tui.requestRender();
			}, 80);
			spinner.unref?.();
			opened.redraw = () => tui.requestRender();
			return {
				render: (width: number) =>
					renderPending(
						{
							message: turn.message,
							judge: runtime.judgeLabel,
							elapsedMs: (turn.waitEndedAt ?? Date.now()) - turn.startedAt,
							verdict: turn.waitEndedAt === undefined ? undefined : data(turn),
							step: turn.step,
							skipKey: "esc",
						},
						width,
						theme,
					),
				invalidate() {},
				dispose() {
					clearInterval(spinner);
				},
			};
		});
	};

	/** The verdict line goes into the chat once there is a verdict and a message for it to stand under. */
	const showEntry = (turn: Staged) => {
		if (turn.entryShown || !turn.messageShown || !turn.decision || turn.decision.mode === "off") return;
		turn.entryShown = true;
		pi.appendEntry<VerdictData>(VERDICT_ENTRY, data(turn));
		runtime.present("preflight.verdict", data(turn), turn.turnId);
	};

	// Other features say what they are working out before the turn starts; the panel passes it on.
	runtime.onProgress = (step) => {
		if (!panel || !staged) return;
		staged.step = step;
		panel.redraw?.();
	};

	pi.registerEntryRenderer<VerdictData>(VERDICT_ENTRY, (entry, { expanded }, theme) => {
		const verdict = entry.data;
		if (!verdict || verdict.version !== 1) return undefined;
		return { render: (width: number) => renderVerdict(verdict, expanded, width, theme), invalidate() {} };
	});

	pi.on(
		"input",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			if (event.source === "extension" || !event.text.trim()) return { action: "continue" as const };
			// A message typed mid-run belongs to the turn in progress; routing it is the interjection feature's job.
			if (event.streamingBehavior) return { action: "continue" as const };

			runtime.beginTurn(event.text);
			// A rule, settled before the judge is asked: a reply to the agent's own question is acted on.
			runtime.turn.repliesToQuestion = lastTurnStoppedToAsk(ctx);
			// Whatever the last message left on screen or in flight is no longer about the current one.
			closePanel(ctx);
			staged = undefined;
			if (!options.unattended && isUnattended(ctx)) {
				// The turn is still counted, and what else is asked about the message is asked now.
				runtime.startTurnWork(event.text);
				return { action: "continue" as const };
			}
			const judged = judgedText(event.text, pi.getCommands());
			if (judged === undefined) return { action: "continue" as const };
			const input: PreflightInput = {
				userMessage: judged,
				recentTurns: recentTurnDigests(ctx),
				taskFrame: runtime.userTurns > 1 ? runtime.taskFrame() : undefined,
				sessionHasWork: runtime.toolCalls > 0,
			};
			const turn = runtime.turn;
			const active = runtime.mode(inputPreflight.id) === "active";
			const visible = options.show && (ctx.mode === "tui" || ctx.mode === "rpc");
			const turnId = runtime.userTurns;
			const current: Staged = {
				turnId,
				message: event.text,
				startedAt: Date.now(),
				turnStarted: false,
				applied: false,
				hints: [],
				hintIds: [],
				messageShown: false,
				entryShown: false,
			};
			staged = visible ? current : undefined;
			runtime.present(
				"preflight.pending",
				{ judge: runtime.judgeLabel, mode: runtime.mode(inputPreflight.id) },
				turnId,
			);
			// No panel for a prompt pi is about to refuse: its error is the feedback, and nothing would ever take the panel down.
			const willRun = ctx.model !== undefined && ctx.modelRegistry.hasConfiguredAuth(ctx.model);
			if (visible && active && willRun && ctx.mode === "tui") openPanel(ctx, current);

			const pending = runtime.engine.decide(inputPreflight, input, { signal: ctx.signal }).then((decision) => {
				// A fallback that still names a turn type was settled by rule (an obvious chat message), judge or no judge.
				const ruled = decision.mode === "active" && decision.outcome.turnType !== "unknown";
				if (decision.source === "judge" || ruled) turn.preflight = decision.outcome;
				current.decision = decision;
				runtime.present("preflight.verdict", data(current), turnId);
				try {
					runtime.status(statusLine(runtime.judgeLabel, decision));
					// A verdict that outlived its turn has no message left to stand under.
					if (staged === current) showEntry(current);
				} catch {
					// Showing the verdict is a courtesy; failing to must not cost the turn its gear.
				}
			});
			// Preflight's question is on its way: the other per-message questions can follow it now.
			runtime.startTurnWork(event.text);
			if (!active) {
				void pending.catch(() => {});
				return { action: "continue" as const };
			}

			// Bounded, and the user can cut it short: a slow judge costs the turn its gear, never its start.
			let skip: () => void = () => {};
			const skipped = new Promise<"skipped">((resolve) => {
				skip = () => resolve("skipped");
			});
			const unsubscribe = panel
				? ctx.ui.onTerminalInput((keys) => {
						if (!matchesKey(keys, "escape")) return undefined;
						skip();
						return { consume: true };
					})
				: undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), options.waitMs);
			});
			try {
				current.waitEndedBy = await Promise.race([pending.then(() => "verdict" as const), timeout, skipped]);
			} finally {
				if (timer) clearTimeout(timer);
				unsubscribe?.();
				current.waitEndedAt = Date.now();
				runtime.present(
					"preflight.wait_end",
					{ reason: current.waitEndedBy, waitedMs: current.waitEndedAt - current.startedAt },
					turnId,
				);
				if (panel) {
					panel.redraw?.();
					panel.timer = setTimeout(() => closePanel(ctx), PANEL_MAX_MS);
					panel.timer.unref?.();
				}
			}
			return { action: "continue" as const };
		}),
	);

	pi.on(
		"before_agent_start",
		failOpen((_event, ctx) => {
			runtime.touch(ctx);
			const outcome = runtime.turn.preflight;
			const flags: HintFlags = { repliesToQuestion: runtime.turn.repliesToQuestion };
			if (staged) staged.turnStarted = true;
			// The rule's hint needs no verdict; the gear does.
			if (!outcome && !flags.repliesToQuestion) return undefined;
			if (staged && outcome) staged.applied = true;

			if (options.thinking && outcome) {
				const current = pi.getThinkingLevel() as Level;
				const wanted = thinkingForGear(outcome.gear, current);
				if (wanted !== current) {
					baseline = current;
					pi.setThinkingLevel(wanted as never);
					if (staged) staged.thinking = { from: current, to: wanted };
				}
			}
			const hintIds = options.hints ? hintIdsFor(outcome, pi.getActiveTools(), flags) : [];
			const hints = hintIds.map((id) => PREFLIGHT_HINTS[id]);
			if (staged) {
				staged.hints = hints;
				staged.hintIds = hintIds;
			}
			if (hints.length === 0) return undefined;
			// With the verdict line on screen the hints are one keypress away there; without it they show as their own message.
			return { message: { customType: "kyrn.hint", content: hints.join("\n"), display: staged === undefined } };
		}),
	);

	// The agent is starting, so pi is about to put the message in the chat: the stand-in has done its job.
	pi.on(
		"agent_start",
		failOpen((_event, ctx) => {
			closePanel(ctx);
			return undefined;
		}),
	);

	// First model call of the turn: by now the user message is in the chat and in the session.
	pi.on(
		"context",
		failOpen(() => {
			if (staged && !staged.messageShown) {
				staged.messageShown = true;
				showEntry(staged);
			}
			return undefined;
		}),
	);

	pi.on(
		"tool_result",
		failOpen(() => {
			runtime.toolCalls++;
			return undefined;
		}),
	);

	// The gear is per turn: hand the user's own thinking level back when the run ends.
	pi.on(
		"agent_end",
		failOpen(() => {
			if (baseline !== undefined) pi.setThinkingLevel(baseline as never);
			baseline = undefined;
			return undefined;
		}),
	);

	pi.on(
		"session_shutdown",
		failOpen((_event, ctx) => {
			closePanel(ctx);
			staged = undefined;
			return undefined;
		}),
	);
}
