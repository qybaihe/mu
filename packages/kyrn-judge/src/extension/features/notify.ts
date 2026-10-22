import { type NotifyFn, type NotifyOutcome, notifyRouting } from "../../decisions/notify-routing.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";
import { offWhenUnattended } from "./unattended.ts";

/**
 * B8: events from outside the conversation go through one router, which
 * decides whether the model hears about them now, at the next turn, or never.
 * The first source is the context budget; file watchers and background tasks
 * plug in through `notify`.
 *
 * The decision is in shadow by default, and then each source's own rule delivers
 * (`unjudged`) at once, without waiting for the verdict it records. A `next_turn`
 * notice is read only when another run starts, which a one-shot run never does:
 * the sources that matter (a job's end, the context budget) say `now`.
 *
 * An unattended run (`mu --print`, json mode) does not ask: the verdict, recorded in shadow, is read by nobody
 * there, and each source's own rule delivers as it would anyway. `unattended: true` asks there too.
 */
export function registerNotify(runtime: KyrnRuntime): NotifyFn {
	const options = runtime.options("notify", {
		enabled: true,
		budgetThresholds: [70, 85],
		/** When the model hears of a budget level without a verdict on it: "now", "next_turn" or "drop". */
		unjudged: "now" as NotifyOutcome,
		/** Ask the judge in a `mu --print` or json run too. */
		unattended: false,
	});
	const { pi } = runtime;
	const announced = new Set<number>();
	/** Verdicts still on their way. Nobody needs them once the session ends, and they must not keep mu running. */
	const asking = new Set<AbortController>();

	const ask = (event: string) => {
		const controller = new AbortController();
		asking.add(controller);
		return runtime.engine
			.decide(
				notifyRouting,
				{ event, goal: runtime.taskFrame()?.goal ?? "", currentAction: clip(runtime.lastAssistantText, 300) },
				{ signal: controller.signal },
			)
			.finally(() => asking.delete(controller));
	};

	const notify: NotifyFn = async (event, extra = {}) => {
		if (!options.enabled) return "drop";
		let outcome = extra.unjudged ?? "drop";
		if (runtime.mode(notifyRouting.id) === "active") {
			const decision = await ask(event);
			if (decision.source === "judge") outcome = decision.outcome;
		} else {
			// Shadow records what the judge would have said; the rule does not wait for it.
			void ask(event).catch(() => {});
		}
		if (outcome === "drop") return outcome;
		const message = { customType: "kyrn.notice", content: extra.content ?? event, display: true };
		if (outcome === "next_turn") pi.sendMessage(message, { deliverAs: "nextTurn" });
		// Steering an idle agent only appends the message; waking it is for the source to allow.
		else if (extra.wake && (runtime.ctx?.isIdle() ?? false)) pi.sendMessage(message, { triggerTurn: true });
		else pi.sendMessage(message, { deliverAs: "steer" });
		return outcome;
	};
	// Background jobs, file watchers and the like plug in here.
	runtime.notify = notify;

	if (options.enabled) {
		if (!options.unattended) offWhenUnattended(runtime, notifyRouting.id);
		pi.on(
			"turn_end",
			failOpen((_event, ctx) => {
				runtime.touch(ctx);
				const usage = ctx.getContextUsage();
				if (!usage || usage.percent === null || usage.tokens === null) return undefined;
				const crossed = options.budgetThresholds.find(
					(level) => usage.percent !== null && usage.percent >= level && !announced.has(level),
				);
				if (crossed === undefined) return undefined;
				for (const level of options.budgetThresholds) if (level <= crossed) announced.add(level);
				void notify(
					`The context window is ${Math.round(usage.percent)}% full (${usage.tokens} of ${usage.contextWindow} tokens). Prefer targeted reads and short outputs; finish the current subgoal before starting another.`,
					// Once per threshold, so at most twice a session: worth hearing while the run that fills it goes on.
					{ unjudged: options.unjudged },
				).catch(() => {});
				return undefined;
			}),
		);
		pi.on("session_shutdown", () => {
			for (const controller of asking) controller.abort();
			asking.clear();
		});
	}
	return notify;
}
