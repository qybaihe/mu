import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { turnCompletion } from "../../decisions/turn-completion.ts";
import { openItems } from "../../frame/frame.ts";
import { clip, failOpen, type KyrnRuntime, textOf, within } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";

const EDIT_TOOLS = ["edit", "write"];

/**
 * D1: "done" after an edit that nothing has run since is a claim, not a
 * result. The harness knows the facts (what was edited, what ran afterwards);
 * the judge reads the closing message. At most one nudge per user turn.
 */
export function registerCompletion(runtime: KyrnRuntime): void {
	const options = runtime.options("completion", { enabled: true, waitMs: 3000 });
	if (!options.enabled) return;
	const { pi } = runtime;

	pi.on(
		"tool_result",
		failOpen((event) => {
			if (event.isError) return undefined;
			const toolName = "toolName" in event ? String(event.toolName) : "";
			if (EDIT_TOOLS.includes(toolName)) {
				runtime.turn.editedFiles.add(String((event.input as { path?: unknown }).path ?? "?"));
				runtime.turn.ranCommandAfterLastEdit = false;
			} else if (isShellTool(toolName) && runtime.turn.editedFiles.size > 0) {
				runtime.turn.ranCommandAfterLastEdit = true;
			}
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>(async (event, ctx) => {
			runtime.touch(ctx);
			// With a goal running, its own check sends the agent back to work, with these same facts. One voice is enough.
			if (runtime.goalActive || runtime.harnessAbort) return undefined;
			const turn = runtime.turn;
			const unverified = turn.editedFiles.size > 0 && !turn.ranCommandAfterLastEdit;
			// The to-do list is the task frame's acceptance criteria: "done" with one of them open is a claim too.
			const open = openItems(runtime.frame);
			if (turn.nudgedForCompletion || (!unverified && open.length === 0)) return undefined;
			const last = [...event.messages].reverse().find((message) => message.role === "assistant");
			const finalMessage = last ? textOf((last as { content?: unknown }).content) : "";
			if (!finalMessage.trim()) return undefined;

			const input = {
				userMessage: clip(turn.userMessage, 400),
				finalMessage: clip(finalMessage, 600),
				editedFiles: turn.editedFiles.size,
				ranCommandAfterLastEdit: turn.ranCommandAfterLastEdit,
				openItems: open.length,
			};
			// Shadow records what it would have said; only an active verdict is worth holding the end of the run for.
			if (runtime.mode(turnCompletion.id) !== "active") {
				void runtime.engine.decide(turnCompletion, input).catch(() => {});
				return undefined;
			}
			// The run is over as far as the user can see; a nudge that comes later than this is not worth the wait.
			const decision = await within(runtime.engine.decide(turnCompletion, input), options.waitMs);
			if (decision?.source !== "judge" || decision.outcome !== "nudge") return undefined;
			turn.nudgedForCompletion = true;
			runtime.nudgedEnds.add(event);
			const said: string[] = [];
			if (unverified) {
				said.push(
					`You edited ${[...turn.editedFiles].join(", ")} and nothing has run since. Verify the change (run the relevant test, build or command), or say plainly why it cannot be verified here.`,
				);
			}
			if (open.length > 0) {
				said.push(
					`These acceptance items are still open: ${open.map((item) => `${item.id} ${item.text}`).join("; ")}. Finish them and tick each with the todo tool and one line of evidence, or say which no longer apply.`,
				);
			}
			pi.sendMessage(
				{
					customType: "kyrn.nudge",
					content: said.join("\n"),
					display: true,
				},
				{ triggerTurn: true },
			);
			return undefined;
		}),
	);
}
