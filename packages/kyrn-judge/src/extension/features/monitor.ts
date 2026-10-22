import { createHash } from "node:crypto";
import { turnDrift } from "../../decisions/turn-drift.ts";
import { failOpen, type KyrnRuntime, textOf } from "../runtime.ts";
import { describeCall } from "./admission.ts";

/**
 * Which call this was and what came of it, for the loop rule. `describeCall` is for reading: it keeps the path of a
 * read and drops its offset, and cuts a script after 300 characters, so a file paged through and two scripts that
 * differ only further down would look like one call made three times. The key holds all of the input and the result.
 */
function callKey(toolName: string, input: unknown, isError: boolean, content: unknown): string {
	return createHash("sha1")
		.update(JSON.stringify([toolName, input ?? null, isError, textOf(content)]))
		.digest("hex");
}

/**
 * B5: a loop is a fact (the same call with the same result, three times), so a
 * rule catches it. Drift is a judgment, asked in the background every few
 * tool rounds. Either one earns the agent a single line, not a lecture.
 */
export function registerMonitor(runtime: KyrnRuntime): void {
	const options = runtime.options("monitor", { enabled: true, every: 6, repeats: 3, window: 8 });
	if (!options.enabled) return;
	const { pi } = runtime;
	/** The recent calls as the drift judge and the steer read them. */
	let actions: string[] = [];
	/** The last `repeats` calls as the loop rule compares them. */
	let keys: string[] = [];
	let warnedLoops = new Set<string>();
	let sinceCheck = 0;

	const steer = (content: string) => {
		pi.sendMessage({ customType: "kyrn.steer", content, display: true }, { deliverAs: "steer" });
	};

	pi.on(
		"input",
		failOpen((event) => {
			if (event.source !== "extension" && !event.streamingBehavior) {
				actions = [];
				keys = [];
				warnedLoops = new Set();
				sinceCheck = 0;
			}
			return undefined;
		}),
	);

	pi.on(
		"tool_result",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			const toolName = "toolName" in event ? String(event.toolName) : "tool";
			const action = `${describeCall(toolName, event.input)} -> ${event.isError ? "error" : "ok"}`;
			const key = callKey(toolName, event.input, event.isError, event.content);
			actions.push(action);
			keys = [...keys, key].slice(-options.repeats);
			sinceCheck++;

			const looping = keys.length === options.repeats && keys.every((entry) => entry === key);
			if (looping && !warnedLoops.has(key)) {
				warnedLoops.add(key);
				pi.appendEntry("kyrn.monitor", { kind: "loop", action });
				runtime.trouble("loop", action);
				steer(
					`The same call has now run ${options.repeats} times with the same outcome (${action}). Say what it told you and try a different approach.`,
				);
				return undefined;
			}

			const goal = runtime.taskFrame()?.goal;
			if (sinceCheck < options.every || !goal) return undefined;
			sinceCheck = 0;
			void runtime.engine
				.decide(turnDrift, { goal, recentActions: actions.slice(-options.window) }, { signal: ctx.signal })
				.then((decision) => {
					if (decision.source !== "judge") return;
					if (decision.outcome === "drift") {
						runtime.trouble("drift", "the recent steps look unrelated to the goal");
						steer(
							`Check your course: the recent steps look unrelated to the goal ("${goal}"). Return to it or say why the detour is needed.`,
						);
					}
				})
				.catch(() => {});
			return undefined;
		}),
	);
}
