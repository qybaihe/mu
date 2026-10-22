import { basename, join } from "node:path";
import { type AgentEndEvent, CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { skillCapture } from "../../decisions/skill-capture.ts";
import { say } from "../../language.ts";
import { turnDigest } from "../../memory/phrasing.ts";
import { parseSkill, SkillDrafts } from "../../memory/skill-drafts.ts";
import type { LlmCompletion } from "../../providers/llm.ts";
import { environmentSecrets } from "../../redact.ts";
import { clip, failOpen, type KyrnRuntime, textOf, userWords } from "../runtime.ts";
import { isShellTool } from "../shell-tools.ts";
import { describeCall } from "./admission.ts";
import type { HarnessRoots } from "./inherit.ts";

const SKILL_PROMPT = `You turn a coding agent's successful run into a reusable skill: a SKILL.md file that another agent will follow the next time a task of the same kind comes up.

Write only the file. Start with front matter:
---
name: <two to five lowercase words joined by hyphens>
description: <one sentence, under 200 characters: what the skill does and when to use it; name the project when the steps only work there>
---
Then one sentence on when to use it, a "## Steps" section of numbered steps with the exact commands and files the run used (put <placeholders> where the next task will differ, such as <version>), and a "## Check" section that says how to tell it worked.

Keep only what worked: leave out mistakes, dead ends and retries. Never write secrets, tokens, keys or personal data. At most 60 lines.`;

const WRITER_TIMEOUT_MS = 30_000;
/** Steps kept for the digest: the run's start and its end matter most, as in the experience library. */
const MAX_KEPT_STEPS = 48;
const HEAD_KEPT = 6;

interface PromptSkill {
	readonly name: string;
	readonly description: string;
}

/**
 * Procedures (kyrn/docs/features/procedures.md): a long run that ended well may have been a procedure, the same
 * sequence of steps that will do the next task of its kind. The judge says whether it was (skill.capture), a writer
 * drafts it as a skill, and the draft waits for the user: `/skills` lists the drafts, `/skills accept <name>`
 * installs one. Nothing is installed without the user.
 *
 * Asked at most once per user turn, and only for a run that took `minSteps` steps or more, ran commands, and ended
 * without an error in its last step: an ordinary turn costs nothing. Drafts stop at `maxPending` per project until
 * the user has looked at them.
 */
export function registerProcedures(runtime: KyrnRuntime, roots?: HarnessRoots): void {
	const options = runtime.options("procedures", {
		enabled: true,
		/** Where drafts wait. Empty: `<agent dir>/mu/skill-drafts`. */
		path: "",
		/** Steps a run must take before it is asked about. */
		minSteps: 6,
		/** Shell commands a run must have run: a procedure does something. */
		minCommands: 2,
		/** Drafts of one project waiting for the user, after which no more are made. */
		maxPending: 3,
	});
	// A sub-agent drafts nothing: its run is part of its parent's.
	if (!options.enabled || process.env.KYRN_SWARM_DEPTH) return;
	const { pi } = runtime;
	const dir = options.path || (roots ? join(roots.agentDir, "mu", "skill-drafts") : undefined);
	if (!dir) return;
	const drafts = new SkillDrafts(dir);
	const userSkillsDir = roots ? join(roots.agentDir, "skills") : undefined;

	let turnOf = -1;
	let request = "";
	let steps: string[] = [];
	let dropped = 0;
	let commands = 0;
	let lastFailed = false;
	let asked = false;
	const sync = () => {
		if (turnOf === runtime.userTurns) return;
		turnOf = runtime.userTurns;
		request = runtime.turn.userMessage;
		steps = [];
		dropped = 0;
		commands = 0;
		lastFailed = false;
		asked = false;
	};

	/** The skills the session has, so a run that followed one is not drafted again; waiting drafts count too. */
	const installed = (): PromptSkill[] => {
		const ctx = runtime.ctx as { getSystemPromptOptions?: () => { skills?: readonly PromptSkill[] } } | undefined;
		let skills: readonly PromptSkill[] = [];
		try {
			skills = ctx?.getSystemPromptOptions?.().skills ?? [];
		} catch {
			// No prompt options on this host: only the drafts are known.
		}
		return [
			...skills.map((skill) => ({ name: skill.name, description: skill.description })),
			...drafts.list().map((draft) => ({ name: draft.name, description: draft.description })),
		];
	};

	/** Who drafts a skill: the writer model, else the conversation's own. */
	const writerFor = (ctx: ExtensionContext): LlmCompletion | undefined =>
		runtime.writer() ??
		(ctx.model ? runtime.llm(`${ctx.model.provider}/${ctx.model.id}`, { thinking: "off" }) : undefined);

	const consider = (finalMessage: string, ctx: ExtensionContext): void => {
		if (asked || steps.length + dropped < options.minSteps || commands < options.minCommands || lastFailed) return;
		const pending = drafts.list().filter((draft) => draft.cwd === ctx.cwd).length;
		if (pending >= options.maxPending) return;
		const write = writerFor(ctx);
		if (!write) return;
		asked = true;
		const digest = turnDigest({ request: userWords(request), steps, dropped, finalMessage });
		const skills = installed();
		const origin = { cwd: ctx.cwd, request: userWords(request) };
		void (async () => {
			const decision = await runtime.engine.decide(skillCapture, { turnDigest: digest, skills });
			if (decision.source !== "judge" || decision.outcome !== "draft") return;
			const reply = await write({
				system: SKILL_PROMPT,
				user: `The run, oldest step first:\n${digest}`,
				signal: AbortSignal.timeout(WRITER_TIMEOUT_MS),
			});
			const skill = parseSkill(reply.text, environmentSecrets());
			if (!skill) return;
			const draft = drafts.save(
				skill,
				origin,
				skills.map((known) => known.name),
			);
			runtime.present("skill.drafted", { name: draft.name, description: draft.description, cwd: draft.cwd });
			const shown = runtime.ctx;
			if (!shown?.hasUI) return;
			shown.ui.notify(
				say({
					zh: `mu：把这次的做法起草成了技能「${draft.name}」：${draft.description}\n/skills show ${draft.name} 看全文，/skills accept ${draft.name} 安装，/skills reject ${draft.name} 丢掉。`,
					en: `mu: drafted the skill "${draft.name}" from this run: ${draft.description}\n/skills show ${draft.name} to read it, /skills accept ${draft.name} to install it, /skills reject ${draft.name} to discard it.`,
				}),
				"info",
			);
		})().catch(() => {});
	};

	pi.on(
		"tool_result",
		failOpen((event, ctx) => {
			runtime.touch(ctx);
			sync();
			const toolName = "toolName" in event ? String(event.toolName) : "tool";
			const input = (event.input ?? {}) as Record<string, unknown>;
			if (isShellTool(toolName)) commands++;
			lastFailed = event.isError;
			steps.push(`${describeCall(toolName, input)} -> ${event.isError ? "error" : "ok"}`);
			if (steps.length > MAX_KEPT_STEPS) {
				steps.splice(HEAD_KEPT, 1);
				dropped++;
			}
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>((event, ctx) => {
			runtime.touch(ctx);
			sync();
			const last = [...event.messages].reverse().find((message) => message.role === "assistant") as
				| { content?: unknown; stopReason?: string }
				| undefined;
			// Cut short by the user or by an error: not a run to learn a procedure from.
			if (!last || last.stopReason === "aborted" || last.stopReason === "error") return undefined;
			consider(textOf(last.content), ctx);
			return undefined;
		}),
	);

	const listing = (): string => {
		const all = drafts.list();
		if (all.length === 0) {
			return say({
				zh: "没有待审的技能草稿。一次步骤多、以成功结束的运行被判定为可复用的做法时，mu 会起草一个。",
				en: "No skill drafts to review. mu drafts one when the judge finds that a long, successful run is a reusable procedure.",
			});
		}
		const lines = all.map(
			(draft) =>
				`${draft.name} · ${basename(draft.cwd)} · ${draft.created.slice(0, 10)}\n  ${clip(draft.description, 200)}`,
		);
		return `${say({ zh: "待审的技能草稿：", en: "Skill drafts to review:" })}\n${lines.join("\n")}\n${say({
			zh: "/skills show <名字> 看全文 · /skills accept <名字> [--project] 安装 · /skills reject <名字> 丢掉",
			en: "/skills show <name> to read · /skills accept <name> [--project] to install · /skills reject <name> to discard",
		})}`;
	};

	pi.registerCommand("skills", {
		description: say({
			zh: "mu 从运行里起草的技能：/skills 列出草稿，/skills show|accept|reject <名字>；accept 加 --project 装进这个项目",
			en: "Review skills mu drafted from past runs: /skills lists drafts, /skills show|accept|reject <name>; accept --project installs into this project",
		}),
		handler: async (args, ctx) => {
			runtime.touch(ctx);
			const words = args.trim().split(/\s+/).filter(Boolean);
			const project = words.includes("--project");
			const [verb = "", name = ""] = words.filter((word) => !word.startsWith("--"));
			if (!verb || verb === "drafts" || verb === "list") {
				ctx.ui.notify(listing(), "info");
				return;
			}
			const draft = name ? drafts.get(name) : undefined;
			if (!draft) {
				ctx.ui.notify(
					say({
						zh: `${name ? `没有叫「${name}」的草稿。` : "要给出草稿的名字。"}/skills 列出草稿。`,
						en: `${name ? `No draft named "${name}".` : "Name a draft."} /skills lists the drafts.`,
					}),
					"warning",
				);
				return;
			}
			if (verb === "show") {
				ctx.ui.notify(`${draft.markdown}\n(${draft.cwd})`, "info");
				return;
			}
			if (verb === "reject") {
				drafts.remove(draft.name);
				ctx.ui.notify(
					say({ zh: `已丢掉草稿「${draft.name}」。`, en: `Discarded the draft "${draft.name}".` }),
					"info",
				);
				return;
			}
			if (verb === "accept") {
				const target = project ? join(ctx.cwd, CONFIG_DIR_NAME, "skills") : userSkillsDir;
				if (!target) return;
				const result = drafts.accept(draft.name, target);
				if ("error" in result) {
					ctx.ui.notify(
						result.error === "exists"
							? say({
									zh: `${target} 里已经有叫「${draft.name}」的技能，没有覆盖。`,
									en: `A skill named "${draft.name}" already exists in ${target}; it wasn't replaced.`,
								})
							: say({ zh: `草稿「${draft.name}」不见了。`, en: `The draft "${draft.name}" no longer exists.` }),
						"warning",
					);
					return;
				}
				runtime.present("skill.installed", { name: draft.name, path: result.path });
				ctx.ui.notify(
					say({
						zh: `已安装技能「${draft.name}」：${result.path}。下次会话起生效（或 /reload 之后）。`,
						en: `Installed the skill "${draft.name}" at ${result.path}. It takes effect in the next session (or after /reload).`,
					}),
					"info",
				);
				return;
			}
			ctx.ui.notify(listing(), "info");
		},
	});
}
