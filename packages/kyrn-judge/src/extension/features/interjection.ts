import type { ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { duration } from "../../board/narrate.ts";
import { inputInterjection } from "../../decisions/interjection.ts";
import { count, say } from "../../language.ts";
import { clip, failOpen, type KyrnRuntime, within } from "../runtime.ts";

type Delivery = "steer" | "followUp";

/** A question about progress mu answered, sent again within this long, is the agent's to answer. */
const AGAIN_MS = 60_000;

/**
 * A8: mu decides when a message typed mid-run reaches the work. pi delivers it the way it was sent: a steer (Enter in
 * the terminal) reaches the model at its next step, a follow-up (Alt+Enter) after the run. When the judge reads it
 * differently (a correction queued for later, extra work or an unrelated question about to break into the run), the
 * message is re-sent the other way.
 *
 * A message that asks how far the work has got is answered here, in a notice made of what mu knows without asking the
 * agent: how long the run has gone and how many steps, the task's checklist, what runs now, what the agent said last,
 * and what waits for the user. The agent is not sent it, so the run is not interrupted to say where it stands. The
 * notice says so; the same message sent again within a minute goes to the agent. Not in a sub-agent, whose messages
 * come from its parent, nor where there is nobody to show a notice to (`answerStatus: false` turns it off).
 *
 * Active by default. The judge has `waitMs` to answer. With no verdict in time, a judge that failed, no judge, or a
 * run that ended meanwhile, the message goes as sent. Mid-run messages reach the run in the order they were sent,
 * however long each verdict takes. In shadow the verdict is only recorded, and the message goes on its way at once.
 */
export function registerInterjection(runtime: KyrnRuntime): void {
	const options = runtime.options("interjection", { enabled: true, waitMs: 1500, answerStatus: true });
	if (!options.enabled) return;
	const { pi } = runtime;
	// A sub-agent's messages come from its parent, which wants the agent's own answer.
	const answersStatus = options.answerStatus && !process.env.KYRN_SWARM_DEPTH;
	// Settles once the mid-run message sent before is on its way.
	let previous: Promise<void> = Promise.resolve();
	/** When the user's message started the run that is going, and the tool calls the agent has made in it. */
	let startedAt = Date.now();
	let steps = 0;
	/** The agent's tool calls that are going, by id: what each is, and since when. */
	const going = new Map<string, { what: string; since: number }>();
	/** The question about progress mu answered last, and when. */
	let answered: { text: string; at: number } | undefined;

	pi.on(
		"before_agent_start",
		failOpen((event) => {
			if (event.messageType !== "user") return undefined;
			startedAt = Date.now();
			steps = 0;
			return undefined;
		}),
	);
	// A call that never returned, in a run that was cut short, has no end: the next run starts with none going.
	pi.on(
		"agent_start",
		failOpen(() => {
			going.clear();
			return undefined;
		}),
	);
	pi.on(
		"tool_execution_start",
		failOpen((event) => {
			// A call another tool made is part of that tool's step.
			if (event.parentToolCallId) return undefined;
			steps++;
			const command = (event.args as { command?: unknown } | undefined)?.command;
			going.set(event.toolCallId, {
				what: typeof command === "string" ? `${event.toolName}: ${clip(command, 60)}` : event.toolName,
				since: Date.now(),
			});
			return undefined;
		}),
	);
	pi.on(
		"tool_execution_end",
		failOpen((event) => {
			going.delete(event.toolCallId);
			return undefined;
		}),
	);

	/**
	 * Where the run stands, for the user who asked: only what mu knows without asking the agent. It names the question,
	 * which is in the conversation nowhere else.
	 */
	const standing = (question: string): string => {
		const now = Date.now();
		const asked = clip(question, 80);
		const lines = [
			say({
				zh: `mu：代理还在干活，“${asked}”没有发给它。目前的进度：`,
				en: `mu: the agent is still working and wasn't sent "${asked}". Here's where the run stands:`,
			}),
			say({
				zh: `  这一轮已运行 ${duration(now - startedAt)}，${steps} 步。`,
				en: `  ${duration(now - startedAt)} into this run, ${count(steps, "step")} so far.`,
			}),
		];
		const checklist = runtime.frameState?.frame?.acceptance ?? [];
		if (checklist.length > 0) {
			const done = checklist.filter((item) => item.done).length;
			lines.push(
				say({
					zh: `  清单 ${checklist.length} 项，完成 ${done} 项：`,
					en: `  Checklist, ${done} of ${checklist.length} done:`,
				}),
				...checklist.map((item) => `    [${item.done ? "x" : " "}] ${clip(item.text, 100)}`),
			);
		}
		for (const call of going.values()) {
			lines.push(
				say({
					zh: `  正在运行：${call.what}（${duration(now - call.since)}）`,
					en: `  Running now: ${call.what} (${duration(now - call.since)})`,
				}),
			);
		}
		const last = clip(runtime.lastAssistantText, 200);
		if (last) lines.push(say({ zh: `  它最近说：“${last}”`, en: `  It last said: "${last}"` }));
		if (runtime.permissionsWaiting > 0) {
			lines.push(
				say({
					zh: `  ${runtime.permissionsWaiting} 步在等你授权：输入 /approve`,
					en: `  ${count(runtime.permissionsWaiting, "step is", "steps are")} waiting for your permission: type /approve`,
				}),
			);
		}
		if (runtime.questionsOpen > 0) {
			lines.push(say({ zh: "  mu 有问题等你回答：输入 /answer", en: "  mu has a question for you: type /answer" }));
		}
		lines.push(
			say({
				zh: "想让代理自己回答，一分钟内把这条消息原样再发一次。",
				en: "To have the agent answer instead, send the same message again within a minute.",
			}),
		);
		return lines.join("\n");
	};

	/**
	 * What to do with a mid-run message other than let it go as it was sent: re-send it the other way, or answer it
	 * here. Undefined when it goes as sent.
	 */
	const reading = async (
		event: InputEvent,
		sent: Delivery,
		ctx: ExtensionContext,
	): Promise<Delivery | "answer" | undefined> => {
		if (event.images?.length) return undefined;
		const goal = runtime.taskFrame()?.goal;
		if (!goal) return undefined;
		// Asked again right after mu answered: they want the agent's answer.
		if (answered && answered.text === event.text && Date.now() - answered.at < AGAIN_MS) {
			answered = undefined;
			return undefined;
		}

		const input = {
			userMessage: clip(event.text, 400),
			goal,
			currentAction: clip(runtime.lastAssistantText, 300),
		};
		if (runtime.mode(inputInterjection.id) !== "active") {
			void runtime.engine.decide(inputInterjection, input).catch(() => {});
			return undefined;
		}
		const decision = await within(runtime.engine.decide(inputInterjection, input), options.waitMs);
		if (!decision || decision.source !== "judge") return undefined;
		if (decision.outcome === "answer") return answersStatus && ctx.hasUI ? "answer" : undefined;
		if (decision.outcome === "keep" || decision.outcome === sent) return undefined;
		return decision.outcome;
	};

	pi.on(
		"input",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			const sent = event.streamingBehavior;
			if (event.source === "extension" || !sent || !event.text.trim()) return undefined;
			// The handlers after this one never see a message taken here. What they note of a message the user wrote, this
			// one notes for them: the user is at the keyboard, and they wrote into the run.
			runtime.userAway = false;
			const earlier = previous;
			let release = () => {};
			previous = new Promise<void>((resolve) => {
				// A tick later: a message re-sent here takes a few more steps to reach pi's queue than one let through.
				release = () => setTimeout(resolve, 0);
			});
			try {
				const read = await reading(event, sent, ctx).catch(() => undefined);
				await earlier;
				// A run that ended meanwhile is started by the message as it was sent: the queue it was meant for is gone, and
				// an agent at rest can say where it stands itself.
				if (!read || ctx.isIdle()) return undefined;
				if (read === "answer") {
					ctx.ui.notify(standing(event.text), "info");
					answered = { text: event.text, at: Date.now() };
				} else {
					// As pi would have read it: a prompt template or a skill (`/name …`) is expanded.
					pi.sendUserMessage(event.text, { deliverAs: read, expandPromptTemplates: true });
				}
				runtime.evolve?.wrote(read === "answer" ? "status" : "message");
				return { action: "handled" as const };
			} finally {
				release();
			}
		}),
	);
}
