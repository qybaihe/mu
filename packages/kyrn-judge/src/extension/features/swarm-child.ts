import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { frameOut } from "../../swarm/brief.ts";
import { SWARM_MESSAGE, toolsClosed, wrapUp } from "../../swarm/markers.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

interface ChildState {
	/** Set once this sub-agent has been asked to stop and report. */
	wrapping: boolean;
	reason: string;
}

const states = new WeakMap<KyrnRuntime, ChildState>();

/** Whether this process is a sub-agent that was told to wrap up. */
export function isWrappingUp(runtime: KyrnRuntime): boolean {
	return states.get(runtime)?.wrapping === true;
}

/**
 * Inside every sub-agent. The parent cannot talk to a print-mode child, so
 * it leaves a request in a file the child looks at between steps. A wrap-up
 * request turns into one message ("report now") and closes the tools, so the
 * child ends with a report instead of being cut off without one.
 *
 * The other way round, the child keeps its acceptance list in `frameOutPath`
 * after every step, so the parent learns which criteria were met and on what
 * evidence even when the child was stopped before it could say so.
 */
export function registerSwarmChild(runtime: KyrnRuntime, path: string, frameOutPath?: string): void {
	const state: ChildState = { wrapping: false, reason: "" };
	states.set(runtime, state);

	/**
	 * "Report now" is a request for what is already known, not for more thought. The thinking level stays where it
	 * is all the same: lowering it for the last call would drop the prompt cache on most providers, and re-reading
	 * the whole context cold costs more than the thinking it saves.
	 */
	const beginWrapUp = (reason: string) => {
		state.wrapping = true;
		state.reason = reason;
	};

	const requested = (): string | undefined => {
		try {
			const request = JSON.parse(readFileSync(path, "utf8")) as { action?: unknown; reason?: unknown };
			if (request.action !== "wrap_up") return undefined;
			return typeof request.reason === "string" && request.reason ? request.reason : "the run is being ended";
		} catch {
			// No file, or one that is still being written: nothing was asked.
			return undefined;
		}
	};

	let saved = "";
	const saveFrame = () => {
		const frame = runtime.frame;
		if (!frameOutPath || !frame) return undefined;
		const text = JSON.stringify(frameOut(frame));
		if (text === saved) return undefined;
		try {
			// Whole or not at all: the parent may read it the moment this process is stopped.
			writeFileSync(`${frameOutPath}.tmp`, text);
			renameSync(`${frameOutPath}.tmp`, frameOutPath);
			saved = text;
		} catch {
			// The parent then reports the sub-agent without its list, as before there were lists.
		}
		return undefined;
	};
	runtime.pi.on("tool_execution_end", failOpen(saveFrame));
	// Extensions hear "settled" before the parent does, so the list is there when the parent looks.
	runtime.pi.on("agent_settled", failOpen(saveFrame));

	runtime.pi.on(
		"turn_end",
		failOpen((event) => {
			if (state.wrapping) return undefined;
			const reason = requested();
			if (!reason) return undefined;
			beginWrapUp(reason);
			// A turn without tool calls is already the report; only a bee that would go on needs telling.
			if (event.toolResults.length > 0) {
				runtime.pi.sendMessage(
					{ customType: SWARM_MESSAGE, content: wrapUp(reason), display: true },
					{ deliverAs: "steer" },
				);
			}
			return undefined;
		}),
	);

	runtime.pi.on(
		"tool_call",
		failOpen(() => {
			if (!state.wrapping) {
				const reason = requested();
				if (reason) beginWrapUp(reason);
			}
			return state.wrapping ? { block: true, reason: toolsClosed(state.reason) } : undefined;
		}),
		{ final: true },
	);
}
