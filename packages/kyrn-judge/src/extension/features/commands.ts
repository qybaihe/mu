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
import { modelRef, VERSIONS } from "./welcome.ts";

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
  /import-chat [文件]：把这个项目在 Claude Code、Codex 或 ZCode 里的对话导入进来，接着在这里聊

判断层
  按 esc 不等判定器读完消息；${keyText("app.tools.expand")} 可以看每个判定背后的全部回答。
  /mu judge <判定器>：由哪些模型来判定、按什么顺序，比如 jev | mude,jev | jev-opencode-free | clm | classifier:<提供商>/<模型> | llm:<提供商>/<模型>
  /mu route <判定点> <判定器|default>：让某一个判定点用自己的判定器，比如 browser.step llm:openai/gpt-5.6-luna
  /mu mode <判定点|default> <off|shadow|active>：off 关闭，shadow 影子（只记录，不起作用），active 生效
  /frame：查看任务帧，也就是 mu 记住的目标、你的硬约束（原话加出处）和验收条件
  /goal <条件>：让代理一直干到大模型判断条件成立；只输入 /goal 会问你条件（或显示正在进行的目标），
    /goal clear 结束
  /board on|off：为这个项目打开或关闭人话看板，用大白话讲进展、正在做什么、什么在等你；
    /board 查看，/board model 换个模型来讲
  /permissions [模式]：mu 不问你就能做多少事，可选 full（完全访问）、judge（判定模式，由判定器替你批，
    拿不准才问你）、ask（最小权限，除了读都要问你）
  /capabilities：装了哪些能力，这次打开了哪些；/capabilities open <ID> 打开一个
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

/** A row of the English help: a command and what it does. An empty command continues the row above. */
type HelpRow = readonly [command: string, description: string];

interface HelpSection {
	readonly title: string;
	readonly intro?: string;
	readonly rows: readonly HelpRow[];
}

const helpSectionsEn = (): HelpSection[] => [
	{
		title: "Start here",
		rows: [
			[
				"/status",
				"show the model, the judge, each decision point's mode, what was kept out of context and recent verdicts",
			],
			["/doctor", "check that the judge, model, browser and subagents are set up"],
			["/init", "have the agent write an AGENTS.md for this project"],
			["/clear", "start a new session (same as /new)"],
			[
				"/import-chat [file]",
				"import a Claude Code, Codex or ZCode conversation from this project and continue it here",
			],
		],
	},
	{
		title: "Judgment kernel",
		intro: `While the judge reads a message, esc skips the wait; ${keyText("app.tools.expand")} shows the full answers behind a verdict.`,
		rows: [
			[
				"/mu judge <judges>",
				"set which judges answer, in order: jev | mude,jev | jev-opencode-free | clm | classifier:<provider>/<model> | llm:<provider>/<model>",
			],
			[
				"/mu route <point> <judge|default>",
				"give one decision point its own judge, e.g. browser.step llm:openai/gpt-5.6-luna",
			],
			["/mu mode <point|default> <off|shadow|active>", ""],
			["", "off; shadow (asked and logged, changes nothing); active (the verdict takes effect)"],
			["/frame", "show the current task: the goal, your constraints with their source and the checklist"],
			[
				"/goal <condition>",
				"keep the agent working until a model judges the condition met; /goal alone asks for one (or shows the current goal) and /goal clear ends it",
			],
			[
				"/board on|off",
				"turn the plain-language board on or off for this project: progress, what's happening, what's waiting on you; /board shows it, /board model picks the model that writes it",
			],
			[
				"/permissions [mode]",
				"set how much mu can do without asking: full (Full access), judge (Judge mode: the judge allows what the task clearly needs and asks you about the rest), ask (Ask first: asks before anything but reading)",
			],
			["/capabilities", "show what's installed and what's open for this task; /capabilities open <id> opens one"],
			["/ledger [n]", "show the last n verdicts and their latency"],
			["/remember <lesson>", "save a lesson for future sessions"],
			[
				"/lessons [all]",
				"list this project's lessons and how often each was recalled and followed; all adds global and retired lessons",
			],
			["/forget <id>", "retire a lesson so it's no longer recalled"],
		],
	},
	{
		title: "Tools the agent can use (and you can ask for)",
		rows: [
			["/browse <url> [goal]", "drive the built-in browser yourself; the agent uses it through the browse tool"],
			[
				"/agents",
				"list the subagent roles for delegate (independent tasks or a chain of steps) and hive (several investigators on one hard problem, with the judge passing findings between them)",
			],
			["/implement <task>", "scout, plan, implement: a chain of subagents, each working through its own checklist"],
			["/scout-and-plan <task>", "scout, then plan; changes nothing"],
			["/implement-and-review <task>", "implement, review, fix"],
			[
				"/hive <question>",
				"several investigators take on one question at once, each from its own angle; the judge passes each finding to whoever needs it, and the answer draws on all of them",
			],
			[
				"/swarm",
				"show what each running subagent is doing; /swarm stop [name] asks it to report now and keeps its findings, /swarm kill [name] stops it immediately",
			],
			[
				"/review [what]",
				"have the reviewer subagent review your changes (or what you name); the judge ranks its findings from P0 to P3",
			],
			["/commit [guidance]", "split uncommitted changes into commits; shows the plan first and never pushes"],
		],
	},
	{
		title: "Session and model (from pi)",
		rows: [
			["/model  /thinking  /login  /logout  /settings  /hotkeys", ""],
			[
				"",
				"/login also signs in to Grok, and to a Google account through Gemini CLI or Antigravity (experimental: explains the risk and asks before opening the browser)",
			],
			["/new  /resume  /tree  /fork  /clone  /compact  /name  /session", ""],
			["/copy  /export  /import  /share  /reload  /changelog  /quit", ""],
		],
	},
];

/** Where the English help's descriptions start: two spaces, then a column for the command. */
const HELP_COLUMN = 27;

/** `text` broken between words: the first line at most `first` wide, the rest `rest`; no width, one line. */
function wrapWords(text: string, first: number | undefined, rest: number | undefined): string[] {
	if (first === undefined || rest === undefined) return [text];
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		const limit = lines.length === 0 ? first : rest;
		if (line && line.length + 1 + word.length > limit) {
			lines.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	return [...lines, line];
}

/**
 * The English help at a width: a command column, and each description wrapped so it continues under itself, never
 * under the command. Without a width (no terminal: the desktop app shows it in its own font), each row is one line.
 */
export function renderHelpEn(head: string, sections: readonly HelpSection[], foot: string, width?: number): string {
	const out = [head];
	for (const section of sections) {
		out.push("", section.title);
		if (section.intro)
			out.push(...wrapWords(section.intro, width && width - 2, width && width - 2).map((line) => `  ${line}`));
		for (const [command, description] of section.rows) {
			const lead = command ? `  ${command}` : "";
			if (!description) {
				out.push(lead);
				continue;
			}
			const start = Math.max(HELP_COLUMN, lead.length + 3);
			const lines = wrapWords(
				description,
				width && Math.max(20, width - start),
				width && Math.max(20, width - HELP_COLUMN),
			);
			out.push(
				`${lead.padEnd(start)}${lines[0]}`,
				...lines.slice(1).map((line) => `${" ".repeat(HELP_COLUMN)}${line}`),
			);
		}
	}
	out.push("", ...wrapWords(foot, width, width));
	return out.join("\n");
}

/** The width the help is shown at: the terminal's, less the margin pi's notice keeps on each side. */
const helpWidth = (): number | undefined =>
	process.stdout.isTTY && process.stdout.columns ? Math.max(40, process.stdout.columns - 2) : undefined;

/**
 * /doctor's rows under a line that says how many need fixing (pi puts "Warning:" in front of the first line of a
 * warning), each row wrapped so it continues under its own text.
 */
export function renderDoctor(
	rows: readonly (readonly [state: string, name: string, text: string])[],
	width?: number,
): string {
	const fixes = rows.filter(([state]) => state === "FIX ").length;
	const lines = [
		fixes > 0
			? `mu doctor found ${fixes} ${fixes === 1 ? "thing" : "things"} to fix`
			: "mu doctor: everything is set up",
	];
	for (const [state, name, text] of rows) {
		const lead = `${state}${name.padEnd(11)}`;
		const wrapped = wrapWords(
			text,
			width && Math.max(20, width - lead.length),
			width && Math.max(20, width - lead.length),
		);
		lines.push(...wrapped.map((line, i) => `${i === 0 ? lead : " ".repeat(lead.length)}${line}`));
	}
	return lines.join("\n");
}

const helpEn = () =>
	renderHelpEn(
		`mu ${VERSIONS.mu} · a judgment-first coding agent, built on pi ${VERSIONS.pi}`,
		helpSectionsEn(),
		"While typing: ! runs a shell command · !! runs it without adding the output to context · @ attaches a file",
		helpWidth(),
	);

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
		const modes = [...engine.overrides()].map(([specId, mode]) => `${specId}=${mode}`).join(" ");
		const usage = ctx.getContextUsage();
		const lines = [
			`model: ${modelRef(ctx.model) ?? "none yet"} · thinking ${pi.getThinkingLevel()}${
				usage?.percent === undefined || usage.percent === null ? "" : ` · context ${Math.round(usage.percent)}%`
			}`,
			// With every point off no judge is asked, whichever is set up: say so, as the welcome does.
			`judge: ${!runtime.enabled ? "off" : engine.asksJudge() ? engine.providerId : "off · every decision point uses its fallback"}`,
			...[...engine.routes()].map(([specId, judge]) => `  ${specId} -> ${judge.id}`),
			`mode: default=${engine.getMode("*")}${modes ? ` ${modes}` : ""}`,
			`calls: ${stats.calls} | failures: ${stats.failures} | abstentions: ${stats.abstentions} | input tokens: ${stats.inputTokens} | probes: ${stats.probes} (${stats.probeInputTokens} input tokens)`,
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
					probe.ok
						? `answering in ${probe.latencyMs} ms`
						: `not answering (${probe.error}); decision points use their fallbacks`,
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
			en: "Show mu's status. Also: /mu judge <judges> | /mu route <point> <judge|default> | /mu mode <point|default> <off|shadow|active>",
		}),
		getArgumentCompletions: (prefix) => {
			const options = ["judge jev", "judge mude", "judge mude,jev", "mode default active", "mode default shadow"];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: mu,
	});

	pi.registerCommand("status", {
		description: say({
			zh: "模型、判定器、各判定点的模式、省下的上下文和最近的判定",
			en: "Show the model, the judge, each decision point's mode, context savings and recent verdicts",
		}),
		handler: async (_args, ctx) => mu("", ctx),
	});

	pi.registerCommand("help", {
		description: say({
			zh: "mu 能做什么，以及常用命令一览",
			en: "Show what mu can do and the commands worth knowing",
		}),
		handler: async (_args, ctx) => ctx.ui.notify(help(), "info"),
	});

	pi.registerCommand("clear", {
		description: say({
			zh: "开始一段新对话（同 /new）",
			en: "Start a new session (same as /new)",
		}),
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});

	pi.registerCommand("ledger", {
		description: say({
			zh: "判定器最近的判定和用时：/ledger [条数]",
			en: "Show the last n verdicts and their latency: /ledger [n]",
		}),
		handler: async (args, ctx) => {
			const count = Math.min(50, Math.max(1, Number.parseInt(args.trim(), 10) || 15));
			const records = runtime.memory.records.slice(-count);
			ctx.ui.notify(
				records.length === 0
					? "No verdicts in this session yet. For all sessions, run mu ledger"
					: records.flatMap(describeRecord).join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("doctor", {
		description: say({
			zh: "检查判定器、模型、浏览器和子代理有没有接好",
			en: "Check that the judge, model, browser and subagents are set up",
		}),
		handler: async (_args, ctx) => {
			runtime.touch(ctx);
			const ok = (good: boolean) => (good ? "ok  " : "FIX ");
			// With every decision point off nothing is sent to a judge, and the check must not send anything either.
			const asks = runtime.enabled && engine.asksJudge();
			const probe = asks ? await engine.probe() : undefined;
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
			const rows: (readonly [state: string, name: string, text: string])[] = [
				[ok(Boolean(modelRef(ctx.model))), "model", modelRef(ctx.model) ?? "none yet: run /login, then /model"],
				[
					ok(providers.length > 0),
					"login",
					providers.length > 0 ? providers.join(", ") : "not signed in to any provider: run /login",
				],
				probe
					? [
							ok(probe.ok),
							"judge",
							`${engine.providerId} ${probe.ok ? `answers in ${probe.latencyMs} ms` : `isn't answering (${probe.error}). For mude 1.0, run mu judge mude start`}`,
						]
					: [
							"--  ",
							"judge",
							runtime.enabled
								? "off: no decision point asks one, so nothing is sent to a judge"
								: "off (MU_JUDGE=off)",
						],
				[
					"--  ",
					"decisions",
					`default mode ${engine.getMode("*")}. Change it with /mu mode default <off|shadow|active>`,
				],
				[ok(Boolean(chrome)), "browser", chrome ?? browserAdvice(browserHost)],
				[
					"--  ",
					"browse",
					runtime.mode("browser.step") === "off"
						? "off: mu's browser runs on the judge, and browser.step is off"
						: `driven by ${engine.judgeFor("browser.step").id}. It needs a judge that can match a goal to a page (Jev or an LLM judge), e.g. /mu route browser.step llm:openai/gpt-5.6-luna`,
				],
				[
					ok(roles.length > 0),
					"subagents",
					`${roles.map((role) => role.name).join(", ")} · add your own in ${agentsDir}`,
				],
				[
					ok(missing.length === 0),
					"ladder",
					`${ladder.length === 0 ? "none: subagents use the session's model" : ladder.join(" < ")}${
						missing.length > 0 ? ` · unavailable: ${missing.join(", ")}` : ""
					}`,
				],
				[
					"--  ",
					"writer",
					runtime.config.writer ?? "none: the session's model writes task frames, browser form text and lessons",
				],
				...runtime.problems.map((problem) => ["FIX ", "problem", problem] as const),
			];
			const fixes = rows.filter(([state]) => state === "FIX ").length;
			ctx.ui.notify(renderDoctor(rows, helpWidth()), fixes > 0 ? "warning" : "info");
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
