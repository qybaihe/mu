import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionCommandContext, getAgentDir, keyText } from "@earendil-works/pi-coding-agent";
import { browserAdvice, findBrowser, thisBrowserHost } from "../../browser/chrome.ts";
import type { DecisionMode } from "../../decision.ts";
import { appLanguage, say } from "../../language.ts";
import type { LedgerRecord } from "../../ledger.ts";
import { loadAgents } from "../agents.ts";
import { promptsFor } from "../localized-prompts.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";
import type { HarnessRoots } from "./inherit.ts";
import { VERSIONS } from "./welcome.ts";

const MODES: readonly string[] = ["off", "shadow", "active"];

/** Resolves to `<package>/prompts` from both `src/` and `dist/`. */
const PROMPTS_DIR = fileURLToPath(new URL("../../../prompts", import.meta.url));

/** Built when asked for: key names are only known once the user's keybindings are loaded. */
const help = () => say({ zh: helpZh(), en: helpEn() });

/** No aligned columns: Chinese is two cells wide in a terminal, so each line says "command: what it does". */
const helpZh = () => `mu ${VERSIONS.mu} · 先判断再动手的编程代理，基于 pi ${VERSIONS.pi}

从这里开始
  /status：判定器、各判定点的模式、没放进上下文的内容、最近的判定
  /doctor：检查判定器、模型、浏览器、子代理有没有接好
  /init：让代理为这个项目写一份 AGENTS.md
  /clear：开始一段新对话（同 /new）
  /import-chat [文件]：把这个项目在 Claude Code 或 Codex 里的对话导入进来，接着在这里聊

判断层
  你的每条消息都先交给判定器读：读的时候消息停在输入框上方（按 esc 可跳过等待），
  判定结果留在对话里这条消息下面。${keyText("app.tools.expand")} 可以看每个判定背后的全部回答。
  /mu judge <判定器>：由哪些模型来判定、按什么顺序，比如 laya | laya,jev | jev-opencode-free | clm | classifier:<提供商>/<模型> | llm:<提供商>/<模型>
  /mu route <判定点> <判定器|default>：让某一个判定点用自己的判定器，比如 browser.step luna
  /mu mode <判定点|default> <off|shadow|active>：off 关闭，shadow 影子（只记录，不起作用），active 生效
  /frame：查看任务帧，也就是 mu 记住的目标、你的硬约束（原话加出处）和验收条件
  /goal <条件>：让代理一直干到大模型判断条件成立；只输入 /goal 会问你条件（或显示正在进行的目标），
    /goal clear 结束
  /board on|off：为这个项目打开或关闭人话看板，用大白话讲进展、正在做什么、什么在等你；
    /board 查看，/board model 换个模型来讲
  /permissions [模式]：mu 不问你就能做多少事，可选 full（完全访问）、jev（Jev 审批，由 Jev 替你批，
    拿不准才问你）、ask（最小权限，除了读都要问你）
  /capabilities：装了哪些能力，判定器为这次任务打开了哪些
  /ledger [条数]：最近几条判定和用时
  /remember <经验>：记一条经验，以后的会话都会用上
  /lessons [all]：这个项目的经验，召回和照做了几次；all 连到处适用的和已退役的一起列
  /forget <id>：让一条经验退役，以后不再召回

代理能用的工具（你也可以叫它用）
  /browse <网址> [要做的事]：你直接让内置浏览器打开网址、照你说的去做；代理用的是 browse 工具
  /agents：列出子代理的角色。delegate 把几件互不相干的事、或一串接力的步骤分给它们；
    hive（蜂群）让几个子代理一起查一个难题，判定器在它们之间传递发现
  /implement <任务>：侦察、计划、实现，三个子代理接力，每个按自己的清单做
  /scout-and-plan <任务>：先侦察，再计划；什么都不改
  /implement-and-review <任务>：实现、评审、修正
  /hive <问题>：让几个调查员从不同角度同时查一个问题，判定器把每个人的发现传给用得上的其他人，
    回答综合所有人的结果
  /swarm：每个正在运行的子代理此刻在做什么；/swarm stop [名字] 让它现在交报告并保留发现，
    /swarm kill [名字] 立刻结束它
  /review [要审的内容]：交给评审子代理审查；判定器把评审发现按轻重排成 P0 到 P3
  /commit [要求]：把还没提交的改动拆成几个提交；先给你看计划，从不推送

会话和模型（来自 pi）
  /model  /thinking  /login  /logout  /settings  /hotkeys
    /login 还能登录 Grok，以及通过 Gemini CLI 或 Antigravity 登录 Google 账号
    （实验功能：打开浏览器之前会先说明风险并问你）
  /new  /resume  /tree  /fork  /clone  /compact  /name  /session
  /copy  /export  /import  /share  /reload  /changelog  /quit

输入时：! 运行一条 shell 命令 · !! 运行但不放进上下文 · @ 附上一个文件`;

const helpEn = () => `mu ${VERSIONS.mu} · judgment-first coding agent, built on pi ${VERSIONS.pi}

Start here
  /status                  judge, modes, what was kept out of the context, recent verdicts
  /doctor                  is everything wired up: judge, model, browser, sub-agents
  /init                    have the agent write AGENTS.md for this project
  /clear                   start a fresh conversation (same as /new)
  /import-chat [file]      bring a Claude Code or Codex conversation of this project into mu and continue it

Judgment layer
  Every message is read by the judge first: it waits above the editor while that happens (esc skips
  the wait), and the verdict stays under it in the chat. ${keyText("app.tools.expand")} shows every answer behind a verdict.
  /mu judge <tiers>      which models judge, in order: laya | laya,jev | jev-opencode-free | clm | classifier:<provider>/<model> | llm:<provider>/<model>
  /mu route <decision> <tiers|default>      one decision on its own judge, e.g. browser.step luna
  /mu mode <decision|default> <off|shadow|active>
  /frame                   the task as mu holds it: goal, your hard constraints and where you said them, to-do items
  /goal <condition>        keep the agent working until a model reads the condition as met; /goal alone asks
                           for one (or shows the running goal), /goal clear ends it
  /board on|off            the plain-language board for this project: progress, what is happening, what
                           waits on you, written for a person; /board shows it, /board model picks who writes it
  /permissions [mode]      how much mu may do without asking: full (full access), jev (Jev approves for you,
                           asks you only when it is not sure), ask (minimal: everything but reading asks)
  /capabilities            what is installed, and what the judge has opened for this task
  /ledger [n]              the last n verdicts with timing
  /remember <lesson>       keep a lesson for future sessions
  /lessons [all]           this project's lessons, how often each was recalled and followed; all adds the ones
                           for everywhere and the retired ones
  /forget <id>             retire a lesson so it is no longer recalled

Tools the agent can use (and you can ask for)
  /browse <url> [goal]     drive the built-in browser yourself; the agent has it as "browse"
  /agents                  sub-agent roles behind "delegate" (independent parts, or a chain of steps) and "hive"
                           (one hard problem, several investigators, the judge passing findings between them)
  /implement <task>        scout, plan, implement: a chain of sub-agents, each working to its own checklist
  /scout-and-plan <task>   scout, then plan; nothing is changed
  /implement-and-review <task>   implement, review, fix
  /hive <question>         several investigators on one question at once, each from its own angle; the judge
                           passes what one finds to the others it matters to, and the answer draws on all of them
  /swarm                   what every running sub-agent is doing right now; /swarm stop [name] has it report
                           now and keeps what it found, /swarm kill [name] ends it at once
  /review [what]           hand a review to the reviewer role; the judge sorts its findings P0 to P3
  /commit [guidance]       split the uncommitted change into commits; shows the plan first, never pushes

Session and model (from pi)
  /model  /thinking  /login  /logout  /settings  /hotkeys
                           /login also signs in with Grok, and with a Google account through Gemini CLI or
                           Antigravity (experimental: it says the risk and asks before the browser opens)
  /new  /resume  /tree  /fork  /clone  /compact  /name  /session
  /copy  /export  /import  /share  /reload  /changelog  /quit

While typing:  ! runs a shell command · !! runs it without adding it to the context · @ attaches a file`;

function describeRecord(record: LedgerRecord): string[] {
	const verdict = record.judged === undefined ? (record.reason ?? "no verdict") : JSON.stringify(record.judged);
	const timing = record.latencyMs === undefined ? "" : ` ${record.latencyMs}ms`;
	const batch = record.batch ? ` x${record.batch.size}` : "";
	const tiers = (record.tiers ?? [])
		.map(
			(tier) =>
				`${tier.judgeId.split(/[:/]/).pop()} ${tier.kept}/${tier.asked}${tier.error ? ` ${tier.error}` : ""}`,
		)
		.join(", ");
	const lines = [
		`${record.timestamp.slice(11, 19)} ${record.specId} v${record.specVersion}${batch} [${record.source}]${timing}${tiers ? ` (${tiers})` : ""} ${verdict.slice(0, 200)}`,
	];
	for (const warning of record.warnings ?? []) {
		lines.push(
			`  ! ${warning.type}${warning.questionId ? ` (${warning.questionId})` : ""}: ${warning.message ?? ""}`,
		);
	}
	return lines;
}

/**
 * The slash commands that make mu a CLI of its own rather than a bag of
 * hooks: help, status, a self-check, and the switches of the judgment layer.
 */
export function registerCommands(runtime: KyrnRuntime, roots?: HarnessRoots): void {
	const { pi, engine } = runtime;

	const status = (ctx: ExtensionCommandContext): string => {
		const { stats } = engine;
		const { savings } = runtime;
		const modes = [...engine.explicitModes()].map(([specId, mode]) => `${specId}=${mode}`).join(" ");
		const usage = ctx.getContextUsage();
		const lines = [
			`model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"} · thinking ${pi.getThinkingLevel()}${
				usage?.percent === undefined || usage.percent === null ? "" : ` · context ${Math.round(usage.percent)}%`
			}`,
			`judge: ${runtime.enabled ? engine.providerId : "off"}`,
			...[...engine.routes()].map(([specId, judge]) => `  ${specId} -> ${judge.id}`),
			`mode: default=${engine.getMode("*")}${modes ? ` ${modes}` : ""}`,
			`calls: ${stats.calls} | failures: ${stats.failures} | abstentions: ${stats.abstentions} | input tokens: ${stats.inputTokens}`,
			`kept out of context: tool output ${savings.admissionOmittedChars} chars, skills ${savings.skillsHiddenChars} chars, forgotten ${savings.forgottenChars} chars, compacted ${savings.compactedChars} chars, diagnostics ${savings.diagnosticsWithheldChars} chars`,
		];
		if (stats.lastError) lines.push(`last error: ${stats.lastError.kind} - ${stats.lastError.message}`);
		for (const problem of runtime.problems) lines.push(`problem: ${problem}`);
		for (const record of runtime.memory.records.slice(-6)) lines.push(...describeRecord(record));
		return lines.join("\n");
	};

	const mu = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		runtime.touch(ctx);
		const [verb, first, second] = args.trim().split(/\s+/);
		if (verb === "judge" && first) {
			const problems = runtime.useJudges(first.split(",").map((tier) => tier.trim()));
			const probe = await engine.probe();
			ctx.ui.notify(
				[
					`judge: ${engine.providerId}`,
					probe.ok ? `answering in ${probe.latencyMs} ms` : `not answering (${probe.error}); decisions fall back`,
					...problems.map((problem) => `problem: ${problem}`),
				].join("\n"),
				probe.ok ? "info" : "warning",
			);
			return;
		}
		if (verb === "route" && first) {
			const tiers = second && second !== "default" ? second.split(",").map((tier) => tier.trim()) : [];
			const problems = runtime.route(first, tiers);
			ctx.ui.notify(
				[`${first} -> ${engine.judgeFor(first).id}`, ...problems.map((problem) => `problem: ${problem}`)].join(
					"\n",
				),
				"info",
			);
			return;
		}
		if (verb === "mode" && first && second && MODES.includes(second)) {
			if (first === "default") engine.setDefaultMode(second as DecisionMode);
			else engine.setMode(first, second as DecisionMode);
			ctx.ui.notify(`${first} -> ${second}`, "info");
			return;
		}
		ctx.ui.notify(status(ctx), "info");
	};

	pi.registerCommand("mu", {
		description: say({
			zh: "mu 的状态。另外：/mu judge <判定器> | /mu route <判定点> <判定器|default> | /mu mode <判定点|default> <off|shadow|active>",
			en: "mu status. Also: /mu judge <tiers> | /mu route <decision> <tiers|default> | /mu mode <decision|default> <off|shadow|active>",
		}),
		getArgumentCompletions: (prefix) => {
			const options = [
				"judge laya",
				"judge laya,luna",
				"judge laya,jev",
				"mode default active",
				"mode default shadow",
			];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: mu,
	});

	pi.registerCommand("status", {
		description: say({
			zh: "模型、判定器、各判定点的模式、省下的上下文和最近的判定",
			en: "Model, judge, decision modes, context savings and the latest verdicts",
		}),
		handler: async (_args, ctx) => mu("", ctx),
	});

	pi.registerCommand("help", {
		description: say({
			zh: "mu 能做什么，以及常用命令一览",
			en: "What mu can do and every command worth knowing",
		}),
		handler: async (_args, ctx) => ctx.ui.notify(help(), "info"),
	});

	pi.registerCommand("clear", {
		description: say({
			zh: "开始一段新对话（同 /new）",
			en: "Start a fresh conversation (same as /new)",
		}),
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});

	pi.registerCommand("ledger", {
		description: say({
			zh: "判定器最近的判定和用时：/ledger [条数]",
			en: "The last verdicts of the judge with timing: /ledger [n]",
		}),
		handler: async (args, ctx) => {
			const count = Math.min(50, Math.max(1, Number.parseInt(args.trim(), 10) || 15));
			const records = runtime.memory.records.slice(-count);
			ctx.ui.notify(
				records.length === 0
					? "No verdicts yet in this session. Across sessions: mu ledger"
					: records.flatMap(describeRecord).join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("doctor", {
		description: say({
			zh: "检查判定器、模型、浏览器和子代理有没有接好",
			en: "Check that the judge, the model, the browser and the sub-agents are wired up",
		}),
		handler: async (_args, ctx) => {
			runtime.touch(ctx);
			const ok = (good: boolean) => (good ? "ok  " : "FIX ");
			const probe = runtime.enabled ? await engine.probe() : undefined;
			const browserHost = thisBrowserHost();
			const chrome = findBrowser(browserHost)?.executable;
			const available = ctx.modelRegistry.getAvailable();
			const providers = [...new Set(available.map((model) => model.provider))];
			const agentsDir = join(getAgentDir(), "agents");
			const roles = loadAgents(agentsDir);
			const ladder = runtime.options("swarm", { enabled: true, models: [] as string[] }).models;
			const missing = ladder.filter((ref) => {
				const slash = ref.indexOf("/");
				return slash < 1 || !ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
			});
			const lines = [
				`${ok(Boolean(ctx.model))}model      ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none selected: /login, then /model"}`,
				`${ok(providers.length > 0)}login      ${providers.length > 0 ? providers.join(", ") : "no provider has credentials: /login"}`,
				probe
					? `${ok(probe.ok)}judge      ${engine.providerId} ${probe.ok ? `answers in ${probe.latencyMs} ms` : `does not answer (${probe.error}). For laya: mu judge start`}`
					: "--  judge      off (MU_JUDGE=off)",
				`--  decisions  default ${engine.getMode("*")}. Change with /mu mode default <off|shadow|active>`,
				`${ok(Boolean(chrome))}browser    ${chrome ?? browserAdvice(browserHost)}`,
				`--  browse     driven by ${engine.judgeFor("browser.step").id}. It needs a judge that can relate a goal to a page (jev, or an llm judge): /mu route browser.step luna`,
				`${ok(roles.length > 0)}sub-agents ${roles.map((role) => role.name).join(", ")} · your own go in ${agentsDir}`,
				`${ok(missing.length === 0)}ladder     ${ladder.length === 0 ? "none: sub-agents use the session's model" : ladder.join(" < ")}${
					missing.length > 0 ? ` · not available: ${missing.join(", ")}` : ""
				}`,
				`--  writer     ${runtime.config.writer ?? "none: the session's model writes typed text and lessons"}`,
				...runtime.problems.map((problem) => `FIX problem    ${problem}`),
			];
			ctx.ui.notify(lines.join("\n"), lines.some((line) => line.startsWith("FIX")) ? "warning" : "info");
		},
	});

	// /init is a prompt, so it ships as a pi prompt template rather than code. (/review is a command of the review pack.)
	// In the app's language: the menu shows a template's description.
	pi.on(
		"resources_discover",
		failOpen(() =>
			existsSync(PROMPTS_DIR)
				? {
						promptPaths: [
							// In mu's own folder, which is the user's alone: a template is text the model follows.
							roots
								? promptsFor(PROMPTS_DIR, appLanguage()?.wording, join(roots.agentDir, "mu", "prompts"))
								: PROMPTS_DIR,
						],
					}
				: undefined,
		),
	);
}
