import { muEnv } from "../../naming.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

export const DEADLINE_MESSAGE = "kyrn.deadline";

/** How far into the budget, in percent, the model is told how much time is left. The last one asks for the result. */
const NOTICE_AT = [50, 80] as const;

/** setTimeout's longest delay. A longer wait fires early, finds the time not yet reached and waits again. */
const MAX_DELAY_MS = 2_147_483_647;

/** A positive number of seconds, from a number or a string; anything else is no budget. */
function budgetSeconds(value: unknown): number | undefined {
	const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : undefined;
}

/**
 * When the run has to be done, in epoch milliseconds: `startedAt` plus the budget from `MU_TIME_BUDGET_S`, or else from
 * the option. Undefined when neither holds a positive number of seconds.
 */
export function runDeadline(fromEnv: string | undefined, fromOption: unknown, startedAt: number): number | undefined {
	const budget = budgetSeconds(fromEnv) ?? budgetSeconds(fromOption);
	return budget === undefined ? undefined : startedAt + budget * 1000;
}

function timeLeft(ms: number): string {
	const whole = Math.floor(ms / 60_000);
	return whole < 1 ? "less than a minute" : whole === 1 ? "1 minute" : `${whole} minutes`;
}

/** What the model reads once `percent` of the budget has passed with `leftMs` to go. */
export function deadlineNotice(percent: number, leftMs: number): string {
	const said = `Time check: ${percent}% of this run's time budget is gone, ${timeLeft(leftMs)} left.`;
	return percent < NOTICE_AT[NOTICE_AT.length - 1]
		? said
		: `${said} Make sure the requested result is in place (files written, services running) before you polish anything.`;
}

/**
 * A deadline mu knows about: `MU_TIME_BUDGET_S` (or its `KYRN_` spelling), else `features.deadline.budgetS`, is the
 * run's time budget in seconds, counted from when the mu process started. A benchmark harness sets the variable from
 * the task's timeout. Without a budget, nothing here does anything.
 *
 * - `runtime.deadlineAt` is set for the other features: the watchdog cuts a reply that only thinks in time for its
 *   retry to finish before the deadline.
 * - With `notices` on, the model is told how much time is left when 50% and when 80% of the budget have passed, the
 *   second time with a reminder to get the requested result in place first. No judge is asked. The notice is a steer:
 *   it waits for the tool calls under way and is read before the next step. A level reached while no run is going is
 *   told when the next run starts, never after the last one has ended.
 *
 * A sub-agent ignores the budget: its own clock starts later than its parent's, and from it the budget would overstate
 * the time left.
 */
export function registerDeadline(runtime: KyrnRuntime): void {
	const options = runtime.options("deadline", { enabled: true, budgetS: 0, notices: true });
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const startedAt = Date.now() - process.uptime() * 1000;
	const deadline = runDeadline(muEnv("TIME_BUDGET_S"), options.budgetS, startedAt);
	if (deadline === undefined) return;
	runtime.deadlineAt = deadline;
	if (!options.notices) return;
	const { pi } = runtime;
	const reachedAt = (percent: number): number => startedAt + ((deadline - startedAt) * percent) / 100;

	let running = false;
	let ended = false;
	/** How many of the levels the model has been told of. */
	let told = 0;
	let timer: NodeJS.Timeout | undefined;

	const tell = (): void => {
		if (!running || ended) return;
		const now = Date.now();
		let reached = told;
		while (reached < NOTICE_AT.length && now >= reachedAt(NOTICE_AT[reached])) reached++;
		if (reached === told) return;
		told = reached;
		// Two levels passed at once: only the later one is worth saying.
		const percent = NOTICE_AT[reached - 1];
		const leftMs = Math.max(0, deadline - now);
		pi.sendMessage(
			{
				customType: DEADLINE_MESSAGE,
				content: deadlineNotice(percent, leftMs),
				display: true,
				details: { percent, leftMs },
			},
			{ deliverAs: "steer" },
		);
	};

	const schedule = (): void => {
		const next = NOTICE_AT.find((percent) => reachedAt(percent) > Date.now());
		if (next === undefined || ended) return;
		timer = setTimeout(
			() => {
				timer = undefined;
				try {
					tell();
				} catch {
					// A notice that cannot be sent is not worth ending mu over: a throw here would be uncaught.
				}
				schedule();
			},
			Math.min(MAX_DELAY_MS, reachedAt(next) - Date.now()),
		);
		// A notice never keeps the process alive.
		timer.unref();
	};
	schedule();

	pi.on(
		"agent_start",
		failOpen(() => {
			running = true;
			tell();
			return undefined;
		}),
	);
	pi.on(
		"agent_end",
		failOpen(() => {
			running = false;
			return undefined;
		}),
	);
	pi.on("session_shutdown", () => {
		ended = true;
		if (timer) clearTimeout(timer);
		timer = undefined;
	});
}
