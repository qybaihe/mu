/**
 * What the harness offers, described for people: every decision point and every
 * feature with its options, in Chinese and English. A settings screen renders
 * its controls from this, so nothing the harness can do is hidden from the user.
 *
 * `manifest.json` next to the package's `package.json` is this object as data,
 * for clients that do not import TypeScript (the desktop app reads it). Tests
 * keep both in step with the code: a decision or a feature that is missing
 * here fails `test/manifest.test.ts`.
 *
 * Regenerate the JSON after a change: `node packages/kyrn-judge/scripts/write-manifest.ts`.
 * The JSON also carries the texts in eleven more languages, from `i18n/manifest.json`
 * (src/manifest-locales.ts): a text whose English changes shows in English there until it is
 * translated again, and the script lists those.
 */
import { DEFAULT_CONFIG } from "./config.ts";
import type { DecisionMode } from "./decision.ts";

export interface Localized {
	readonly zh: string;
	readonly en: string;
}

export type DecisionGroup = "input" | "context" | "tools" | "turn" | "team";

export interface DecisionInfo {
	/** The spec id, which is also the key under `modes` in mu.json. */
	readonly id: string;
	readonly group: DecisionGroup;
	/** The feature that asks it: switching that feature off silences the decision. */
	readonly feature: string;
	readonly title: Localized;
	readonly summary: Localized;
	/**
	 * The point's own built-in mode, from `DEFAULT_CONFIG.modes` in config.ts, when it has one: it keeps that mode
	 * whatever `modes.default` says, until `modes.<id>` in mu.json sets another. Absent: the point follows
	 * `modes.default`, which is `active` unless mu.json changes it.
	 */
	readonly defaultMode?: DecisionMode;
}

interface OptionBase {
	/** The key under `features.<name>` in mu.json. */
	readonly key: string;
	readonly label: Localized;
	readonly help?: Localized;
}

export type OptionInfo =
	| (OptionBase & { readonly kind: "boolean"; readonly default: boolean })
	| (OptionBase & {
			readonly kind: "number";
			readonly default: number;
			readonly min?: number;
			readonly max?: number;
			readonly unit?: Localized;
	  })
	| (OptionBase & { readonly kind: "text"; readonly default: string })
	| (OptionBase & { readonly kind: "list"; readonly default: readonly string[] })
	| (OptionBase & { readonly kind: "numbers"; readonly default: readonly number[] })
	| (OptionBase & {
			readonly kind: "choice";
			readonly default: string;
			readonly choices: readonly { readonly value: string; readonly label: Localized }[];
	  });

export interface FeatureInfo {
	/** The key under `features` in mu.json. `false` there switches the feature off. */
	readonly name: string;
	readonly title: Localized;
	readonly summary: Localized;
	readonly defaultEnabled: boolean;
	readonly beta?: boolean;
	readonly options: readonly OptionInfo[];
}

export interface HarnessManifest {
	readonly version: 1;
	readonly groups: Readonly<Record<DecisionGroup, Localized>>;
	readonly modes: readonly {
		readonly value: "off" | "shadow" | "active";
		readonly label: Localized;
		readonly help: Localized;
	}[];
	readonly decisions: readonly DecisionInfo[];
	readonly features: readonly FeatureInfo[];
}

const ms: Localized = { zh: "毫秒", en: "ms" };
const chars: Localized = { zh: "字符", en: "chars" };

/** The manifest as written here; MANIFEST adds each point's built-in mode from config.ts. */
const DESCRIBED: HarnessManifest = {
	version: 1,
	groups: {
		input: { zh: "输入", en: "Input" },
		context: { zh: "上下文", en: "Context" },
		tools: { zh: "工具与安全", en: "Tools and safety" },
		turn: { zh: "回合", en: "Turn" },
		team: { zh: "协作", en: "Teamwork" },
	},
	modes: [
		{
			value: "active",
			label: { zh: "生效", en: "Active" },
			help: { zh: "判定结果直接起作用。", en: "The verdict takes effect." },
		},
		{
			value: "shadow",
			label: { zh: "影子", en: "Shadow" },
			help: {
				zh: "照常提问并记录，但不改变任何行为，用来先观察判定准不准。",
				en: "Asked and logged, but changes nothing. Use it to see how well the judge does before relying on it.",
			},
		},
		{
			value: "off",
			label: { zh: "关闭", en: "Off" },
			help: { zh: "不提问，这个判定点关闭。", en: "Not asked; this decision point is off." },
		},
	],
	decisions: [
		{
			id: "input.preflight",
			group: "input",
			feature: "preflight",
			title: { zh: "消息预判", en: "Message preflight" },
			summary: {
				zh: "每条消息先判断是什么类型、要多深的思考，据此给出一行提示；可选按判定设定本回合的思考等级。",
				en: "Classifies each message and how much thinking it needs, then gives the model a one-line hint; it can also set the turn's thinking level.",
			},
		},
		{
			id: "task.frame",
			group: "input",
			feature: "frame",
			title: { zh: "任务帧更新", en: "Task frame update" },
			summary: {
				zh: "每条消息判断一次：它是新任务、新的硬约束、对做法的纠正、新的子目标，还是什么都没变。只有变了才让模型重写任务帧。",
				en: "Classifies each message as a new task, a new hard constraint, a correction, a new subgoal or no change. Only a change makes a model rewrite the task frame.",
			},
		},
		{
			id: "input.interjection",
			group: "input",
			feature: "interjection",
			title: { zh: "中途插话", en: "Mid-run messages" },
			summary: {
				zh: "任务进行中你又发来一句话：判断是要立刻打断，还是等这一步做完再处理。默认是影子模式：判定只记录，消息按你按的键投递，不用等判定。",
				en: "For a message that arrives while the agent is working: interrupt now, or handle it after the current step. In shadow by default: the verdict is only logged, and the message goes the way of the key you pressed without waiting for it.",
			},
		},
		{
			id: "skills.disclosure",
			group: "context",
			feature: "skills",
			title: { zh: "技能披露", en: "Skill disclosure" },
			summary: {
				zh: "会话开始时只把与任务有关的技能说明放进提示词，其余隐藏但随时可查。",
				en: "Only skills relevant to the task go into the prompt; the rest stay hidden but findable.",
			},
		},
		{
			id: "capability.disclosure",
			group: "context",
			feature: "catalog",
			title: { zh: "能力披露", en: "Capability disclosure" },
			summary: {
				zh: "能力包、MCP 服务器等装着但默认不露，任务需要时才打开，对应的进程也到那时才启动。",
				en: "Packs and MCP servers stay installed but hidden until a task needs them; their processes start only then.",
			},
		},
		{
			id: "tool.admission",
			group: "context",
			feature: "admission",
			title: { zh: "工具输出准入", en: "Tool output admission" },
			summary: {
				zh: "很长的工具输出分块判断，只让与任务有关的部分进入上下文，其余归档并留下指针。",
				en: "Judges long tool output in chunks; only what matters enters the context, and the rest is archived behind a pointer.",
			},
		},
		{
			id: "tool.admission.test-log",
			group: "context",
			feature: "admission",
			title: { zh: "测试日志精简", en: "Test log trimming" },
			summary: {
				zh: "测试输出里完全重复的失败段落只留一份；可再让判定器挑出必要的部分。",
				en: "Keeps one copy of exact repeats in test output; optionally, the judge picks what's needed from the rest.",
			},
		},
		{
			id: "context.forget",
			group: "context",
			feature: "forgetting",
			title: { zh: "过期结果遗忘", en: "Forgetting stale results" },
			summary: {
				zh: "上下文用量越过阈值时，把已经用不上的旧工具结果在发出的请求里换成一行占位。",
				en: "When context use crosses a threshold, replaces stale tool results with one-line placeholders in outgoing requests.",
			},
		},
		{
			id: "context.compact",
			group: "context",
			feature: "compaction",
			title: { zh: "免摘要压缩", en: "Summary-free compaction" },
			summary: {
				zh: "压缩时不让模型写摘要，而是逐段判断保留还是裁掉，原文保真。",
				en: "When compacting, the judge keeps or prunes each passage instead of having a model write a summary.",
			},
		},
		{
			id: "memory.recall",
			group: "context",
			feature: "memory",
			title: { zh: "经验召回", en: "Lesson recall" },
			summary: {
				zh: "从经验库里挑出与当前任务有关的几条，带进这一回合。",
				en: "Picks the lessons relevant to the current task and brings them into the turn.",
			},
		},
		{
			id: "memory.capture",
			group: "context",
			feature: "memory",
			title: { zh: "经验记录", en: "Lesson capture" },
			summary: {
				zh: "判断你的一句话是不是在纠正代理、或立下以后都要守的规矩；是就记成一条经验。",
				en: "Decides whether your message corrects the agent or sets a rule for the future; if so, saves it as a lesson.",
			},
		},
		{
			id: "memory.outcome",
			group: "context",
			feature: "memory",
			title: { zh: "从脱困中学", en: "Learning from getting unstuck" },
			summary: {
				zh: "代理原地打转或跑偏过、这一回合却以通过的检查或达成的目标收尾时，判断最后奏效的办法是不是换了一种；是就记下这个坑和绕过办法。每回合最多问一次。",
				en: "When the agent went in circles or off course but the turn still ended with a passing check or the goal met, judges whether what finally worked was a different approach; if so, saves the pitfall and the workaround as a lesson. Asked at most once per turn.",
			},
		},
		{
			id: "memory.worth",
			group: "context",
			feature: "memory",
			title: { zh: "值不值得记", en: "Worth keeping" },
			summary: {
				zh: "模型自己想记下的经验、子代理报告里标出的经验，判断是以后还用得上、只关这一次，还是提示词或项目文件里早就有。只存以后用得上的。",
				en: "For a lesson the model saves with the remember tool, or a Lesson: line in a subagent's report: will it help again, is it a one-off or is it already in the prompt or project files? Only lessons that will help again are kept.",
			},
		},
		{
			id: "memory.merge",
			group: "context",
			feature: "memory",
			title: { zh: "经验整理", en: "Lesson merging" },
			summary: {
				zh: "新经验落盘前，和最像的几条已有经验逐一比：同一条就不重复存，说得更准的替代旧的，互相矛盾时以你最新的说法为准。",
				en: "Before saving a new lesson, compares it with the most similar existing ones: a duplicate isn't saved twice, a more precise lesson replaces the older one, and when two contradict, your latest word wins.",
			},
		},
		{
			id: "memory.applied",
			group: "context",
			feature: "memory",
			title: { zh: "经验有没有用", en: "Lesson followed" },
			summary: {
				zh: "回合结束时，判断带进这一回合的经验有没有被照做。召回多次却从没照做过的经验会自动退役。",
				en: "At the end of a turn, judges whether the lessons brought into it were followed. A lesson recalled many times and never followed is retired.",
			},
		},
		{
			id: "skill.capture",
			group: "context",
			feature: "procedures",
			title: { zh: "把做法起草成技能", en: "Drafting a procedure as a skill" },
			summary: {
				zh: "一次步骤多、跑过命令、以成功收尾的运行结束后，判断它是不是一套可复用的做法（同样的步骤能做下一件同类的事），还是只为这一件事、或者已有技能覆盖了。是做法就由写作模型起草成技能，放进待审区，等你 /skills accept 才安装。每回合最多问一次，普通回合不问。",
				en: "After a long, successful run that ran commands, judges whether it was a reusable procedure (the same steps would handle the next task of its kind), a one-off, or already covered by an installed skill. The writer model drafts a procedure as a skill, which waits until you install it with /skills accept. Asked at most once per turn, and never for an ordinary turn.",
			},
		},
		{
			id: "cache.warming",
			group: "context",
			feature: "warming",
			title: { zh: "缓存保温", en: "Cache warming" },
			summary: {
				zh: "判断你是否很快会回来，以决定要不要在提示词缓存过期前续一下。只在代理空闲时问：运行中从不丢掉缓存。",
				en: "Guesses whether you'll be back soon, to decide whether to refresh the prompt cache before it expires. Asked only while the agent is idle, so a run never loses its cache to it.",
			},
		},
		{
			id: "tool.risk",
			group: "tools",
			feature: "guard",
			title: { zh: "危险命令把关", en: "Risky command guard" },
			summary: {
				zh: "规则先挑出看起来危险的命令，判定器只负责确认「这是不是你要求的」；拿不准就问你。",
				en: "Rules flag dangerous-looking commands; the judge only confirms that you asked for them. If it's unsure, mu asks you.",
			},
		},
		{
			id: "tool.approval",
			group: "tools",
			feature: "permissions",
			title: { zh: "判定器替你审批", en: "The judge approves for you" },
			summary: {
				zh: "在「判定模式」下，命令、项目外的改动、对外操作和子代理先交给判定器：它确信这是任务需要、也是你会预期的做法才放行，否则在状态栏问你。",
				en: "In Judge mode, commands, changes outside the project, external actions and subagents go to the judge first. Only what the judge is sure the task needs, done the way you'd expect, runs without asking; anything else asks you in the status bar.",
			},
		},
		{
			id: "tool.constraint",
			group: "tools",
			feature: "constraints",
			title: { zh: "硬约束把关", en: "Hard constraint gate" },
			summary: {
				zh: "你说过「先别改 X」「不要加依赖」这类话会原文记在任务帧里；每次要改动东西之前，逐条判断这次调用是否违反，确信违反才拦下，并用你的原话告诉模型。",
				en: "What you ruled out is kept verbatim in the task frame. Before any call that changes something, each constraint is checked; only a confident violation is blocked, and the model is told in your own words.",
			},
		},
		{
			id: "tool.injection",
			group: "tools",
			feature: "injection",
			title: { zh: "外来内容里的指令", en: "Instructions in outside content" },
			summary: {
				zh: "网页、搜索结果、MCP 服务器返回的内容，以及 shell 命令从别的机器取回的内容（curl、gh issue view），模型读到之前先过一遍：哪一段是写给 AI 的指令（让它忽略规则、交出数据、跑命令，或借一个链接把对话带出去）。这样的段落被扣下，换成一行说明。判定器没答上来时，只扣下明显的注入用语。子代理读到的内容里有段落被扣下时，它的报告交回时前面带一句警告。",
				en: "Before the model reads a web page, search results, an MCP server's response or what a shell command fetched from another machine (curl, gh issue view), the judge checks which passages carry instructions aimed at an AI (to ignore rules, hand over data, run commands or leak the conversation through a link). Those passages are withheld and replaced with a one-line note. When the judge doesn't answer, only obvious injection phrases are withheld. If a subagent had passages withheld from what it read, its report comes back with a warning.",
			},
		},
		{
			id: "tool.description",
			group: "tools",
			feature: "injection",
			title: { zh: "MCP 工具说明里的私货", en: "Hidden instructions in MCP tool descriptions" },
			summary: {
				zh: "MCP 服务器自己写工具说明，模型把它当工具列表的一部分来读。每个工具第一次出现、说明变了时问一次：这段说明是不是要 AI 做调用这个工具以外的事（读用不着的文件或密钥、把数据发到别处、改变它对待别的工具或你的方式、瞒着你）？是的话这个工具从列表里拿掉，调用也被拒绝，并告诉你。判定器没答上来时，只按 <IMPORTANT> 块、「别告诉用户」这类明显标记处理。",
				en: "MCP servers write their own tool descriptions, and the model reads them as part of its tool list. Asked once per tool when it first appears and whenever its description changes: does the description ask the AI to do more than call this tool (read files or secrets it doesn't need, send data elsewhere, change how it treats other tools or you, hide something from you)? If so, the tool is removed from the list, calls to it are refused and you're told. When the judge gives no answer, only obvious markers such as an <IMPORTANT> block or \"do not tell the user\" count.",
			},
		},
		{
			id: "files.locate",
			group: "tools",
			feature: "locate",
			title: { zh: "文件定位", en: "File locator" },
			summary: {
				zh: "用一句话描述要找什么，判定器给候选文件排序，省去一次次搜索。",
				en: "The model describes what it's looking for and the judge ranks candidate files, saving a string of greps.",
			},
		},
		{
			id: "judge.items",
			group: "tools",
			feature: "judgeItems",
			title: { zh: "批量判定（模型用的工具）", en: "Judging many items (a tool for the model)" },
			summary: {
				zh: "模型要从几百个文件、日志行或发现里挑东西时，把一个是非题交给判定器逐条回答，每条给一个概率，不用自己一条条读。只在任务用得上时出现。是模型自己问的，所以影子模式下也照常回答；关闭则不能用。",
				en: "When the model has to sort through hundreds of files, log lines or findings, it gives the judge one yes/no question to answer for each item, with a probability for each, instead of reading them all. Available only when a task needs it. Since the model is the one asking, it's answered in shadow mode too; off disables it.",
			},
		},
		{
			id: "browser.step",
			group: "tools",
			feature: "browser",
			title: { zh: "浏览器逐步操作", en: "Browser steps" },
			summary: {
				zh: "内置浏览器每一步「观察 → 一次判定 → 动作」，由判定器选择下一步操作和目标。",
				en: "Each browser step is observe, judge once, act: the judge picks the next action and its target.",
			},
		},
		{
			id: "turn.drift",
			group: "turn",
			feature: "monitor",
			title: { zh: "跑偏监测", en: "Drift monitor" },
			summary: {
				zh: "每隔几步或几分钟，看退出码、耗时和离上次进展多久，判断这次运行是否还在朝目标推进；原地打转由规则发现。",
				en: "Every few steps or minutes, checks that the run still moves toward the goal, reading exit codes, times and how long since the last progress; rules catch the agent going in circles.",
			},
		},
		{
			id: "turn.rewind",
			group: "turn",
			feature: "checkpoint",
			title: { zh: "判断回退", en: "Judged rewind" },
			summary: {
				zh: "监测发现原地打转或同一条命令连续失败时，判断这条路是不是死路；只有确信是死路且没有进展，才向你提议回到本回合开始前的检查点。它自己从不回退。",
				en: "When the monitor sees the agent going in circles or the same command failing again and again, judges whether the approach is a dead end. Only a confident dead end with no progress makes mu propose going back to the turn's checkpoint; it never rewinds on its own.",
			},
		},
		{
			id: "turn.completion",
			group: "turn",
			feature: "completion",
			title: { zh: "完成核对", en: "Completion check" },
			summary: {
				zh: "模型说「做完了」时，判断是否真的验证过；没验证就提醒一次。",
				en: "When the model says it's done, checks whether anything verified the work; if not, nudges it once.",
			},
		},
		{
			id: "turn.continue",
			group: "turn",
			feature: "continuation",
			title: { zh: "半路停下", en: "Stopped short" },
			summary: {
				zh: "一轮结束在「接下来我去跑测试」却什么也没做，或者你已经让它做了它还在问「要我改吗」：让它接着做。难以撤销、或要出这台电脑的一步（推送、发布、删除、付款）不催。每条消息最多催两次。",
				en: 'When a run ends on "next I\'ll run the tests" without doing it, or asks permission for work you already asked for, sends the agent back to it. Never nudges a step that is hard to undo or reaches beyond this machine (push, publish, delete, pay). At most twice per message.',
			},
		},
		{
			id: "review.triage",
			group: "tools",
			feature: "packs",
			title: { zh: "评审发现分级", en: "Review triage" },
			summary: {
				zh: "评审子代理交回发现之后，逐条判断两件事：会不会改变程序行为，是不是这次改动引起的；再结合评审自己标的轻重，按严重程度排成四级。一条都不丢，最轻的一级折叠显示；评审坚持必须改的永远不会落到最轻一级。",
				en: "After the /review reviewer reports, each finding gets two questions: does it change how the program behaves, and is it caused by this change? Together with the reviewer's own severity, the answers rank findings from P0 to P3. None is dropped, P3 is collapsed, and a finding the reviewer insisted on never lands in P3.",
			},
		},
		{
			id: "output.drift",
			group: "turn",
			feature: "ttsr",
			title: { zh: "写偏即停（实验）", en: "Mid-stream correction (experimental)" },
			summary: {
				zh: "模型边输出，判定器边每隔几百字对照一次你的硬约束和下面配置的规则；确信写偏了就立刻掐断输出，告诉模型是哪一条，让它从断点接着写。只有开启了「写偏即停」功能才会运行。",
				en: "While the model writes, the judge checks the latest output against your hard constraints and the configured rules every few hundred characters. On a confident violation, the output is cut off, the rule is named, and the model continues from there. Runs only when the feature is turned on.",
			},
		},
		{
			id: "diagnostics.delivery",
			group: "tools",
			feature: "lsp",
			title: { zh: "诊断何时告知", en: "When to report diagnostics" },
			summary: {
				zh: "改完文件后语言服务器新报的错：现在就说、等模型停下再说，还是不说（风格类警告）。回合结束时仍在的新错误一定会说。",
				en: "For new language server diagnostics after an edit: report now, when the model pauses or never (style warnings). New errors still present when the turn ends are always reported.",
			},
		},
		{
			id: "goal.met",
			group: "turn",
			feature: "goal",
			title: { zh: "目标是否达成（判定器兜底）", en: "Goal met (judge fallback)" },
			summary: {
				zh: "目标模式默认由大模型判断；这个判定点只在选了判定器、或大模型没答上来时用：读结束语，判断目标是否达成、是否需要你拿主意。还有没勾掉的验收条件、或改完没跑过，一律算没达成。",
				en: "In goal mode, a model decides by default whether the goal is met. This decision point is used only when the judge is chosen or the model doesn't answer: it reads the closing message to judge whether the goal is met and whether you're needed. An open acceptance item or an unverified edit always means not yet.",
			},
		},
		{
			id: "board.read",
			group: "turn",
			feature: "board",
			title: { zh: "人话看板：现在在干什么", en: "Plain-language board: where things stand" },
			summary: {
				zh: "打开人话看板的项目里，代理每说一段话、跑完检查或勾掉一条验收条件时、每做几步、以及每次停下时，用选择题读出它处在哪个阶段、在做哪条验收条件、是不是在等你，并把这段时间发生的事逐条分成「你会想知道的」和「例行步骤」。只有出现新情况，才把挑出来的要点交给会说人话的模型重写看板、并在流水里重讲一句；一轮结束时再挑一次整轮的要点，做个总结。",
				en: "In a project with the board on, multiple-choice questions are asked whenever the agent says something, after a check or a ticked acceptance item, every few tool calls and whenever the agent stops. They read the agent's phase, the acceptance item it's working on and whether it's waiting for you, and sort what happened since the last update into news and routine. Only something new makes a plain-speaking model rewrite the board and retell the news in the running account. When a run ends, the news from the whole run is picked again for a summary.",
			},
		},
		{
			id: "notify.routing",
			group: "turn",
			feature: "notify",
			title: { zh: "通知分流", en: "Notification routing" },
			summary: {
				zh: "上下文预算、后台命令结束等事件出现时，判断该现在告诉模型、稍后再说，还是不必说。默认是影子模式：判定只记录，事件按各自的规则投递，后台命令结束和上下文预算都是立刻告知。",
				en: "For events such as the context budget or a background job's end: tell the model now, later or not at all. In shadow by default: the verdict is only logged and each event is delivered by its own rule, which for a job's end and the context budget is now.",
			},
		},
		{
			id: "swarm.routing",
			group: "team",
			feature: "swarm",
			title: { zh: "子代理分派", en: "Subagent routing" },
			summary: {
				zh: "为每个没指定角色的委派任务挑选角色；设了模型梯队时，再按难度选择模型档位和思考等级。角色都已指定、又没有梯队时不提问。",
				en: "Picks a role for each delegated task that doesn't name one. With a model ladder set, it also picks a model tier and thinking level based on difficulty. When every role is named and there's no ladder, nothing is asked.",
			},
		},
		{
			id: "swarm.patch",
			group: "team",
			feature: "swarm",
			title: { zh: "子代理补丁的范围检查", en: "Subagent patch scope check" },
			summary: {
				zh: "隔离的子代理交回补丁时，只看任务、改动的路径和行数，判断改动是否超出任务、哪些文件与任务无关；只给主代理一句提示，从不拦截。默认关闭：交回的结果本来就列出了每个改动的文件和行数。",
				en: "When an isolated subagent hands back a patch, judges from the task, the changed paths and the line counts whether it stays within scope and which files look unrelated. Gives the main agent one line of advice; it never blocks. Off by default: the result already lists every changed file with its line counts.",
			},
		},
		{
			id: "hive.publish",
			group: "team",
			feature: "hive",
			title: { zh: "蜂群：发布发现", en: "Hive: publishing findings" },
			summary: {
				zh: "一只蜂说的话值不值得放到公告板上给其他蜂看。以 FOUND: 或 DEAD END: 开头的发现直接发布，不用问。",
				en: "Decides whether what a bee said is worth putting on the board for the others. A finding that starts with FOUND: or DEAD END: is published without asking.",
			},
		},
		{
			id: "hive.deliver",
			group: "team",
			feature: "hive",
			title: { zh: "蜂群：投递", en: "Hive: delivery" },
			summary: {
				zh: "公告板上的一条发现与某只蜂手头的工作有没有关系，有关系才送达。判定器答不上来时照样送达（不超过每只蜂的上限）。",
				en: "Decides whether a finding on the board matters to a bee's current work; only then is it delivered. When the judge can't answer, it's delivered anyway, up to each bee's limit.",
			},
		},
		{
			id: "hive.relate",
			group: "team",
			feature: "hive",
			title: { zh: "蜂群：纠正", en: "Hive: corrections" },
			summary: {
				zh: "一条新发现对公告板上的旧发现意味着什么：更新了它、和它冲突、佐证它，还是无关。被更新的下线，听过它的蜂收到纠正；冲突两边都留着，交给蜂去核实。",
				en: "How a new finding relates to an earlier one on the board: it replaces it, contradicts it, supports it or is unrelated. A replaced finding is withdrawn and every bee that heard it is told; a contradiction keeps both sides for a bee to settle.",
			},
		},
	],
	features: [
		{
			name: "preflight",
			title: { zh: "消息预判", en: "Message preflight" },
			summary: {
				zh: "发送后先判定再开工，判定结果显示在对话里。",
				en: "Judges a message before work starts and shows the verdict in the conversation.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "thinking",
					kind: "boolean",
					default: false,
					label: {
						zh: "按判定设置思考等级（切换会丢缓存）",
						en: "Set the thinking level from the verdict (changing it invalidates the prompt cache)",
					},
				},
				{
					key: "hints",
					kind: "boolean",
					default: true,
					label: { zh: "给模型一行提示", en: "Give the model a one-line hint" },
				},
				{
					key: "show",
					kind: "boolean",
					default: true,
					label: { zh: "在界面上显示等待和结论", en: "Show the wait and the verdict" },
				},
				{
					key: "waitMs",
					kind: "number",
					default: 4000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
					help: { zh: "超时就不等了，按原样开始。", en: "After this, the turn starts without the verdict." },
				},
				{
					key: "unattended",
					kind: "boolean",
					default: false,
					label: { zh: "无人值守的运行也预判", en: "Also judge messages in unattended runs" },
					help: {
						zh: "无人值守指 mu --print 和 json 模式的一次性运行。默认不问：那里没人看提示，每条消息却要多等判定、多花判定的钱。",
						en: "Unattended means a one-shot mu --print or json-mode run. Off by default: nobody reads the hint there, and every message would wait for the judge and pay for it.",
					},
				},
			],
		},
		{
			name: "interjection",
			title: { zh: "中途插话", en: "Mid-run messages" },
			summary: { zh: "处理任务进行中发来的消息。", en: "Handles messages sent while the agent is working." },
			defaultEnabled: true,
			options: [
				{
					key: "waitMs",
					kind: "number",
					default: 1500,
					min: 200,
					max: 10000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
				},
			],
		},
		{
			name: "skills",
			title: { zh: "技能披露", en: "Skill disclosure" },
			summary: {
				zh: "按任务决定提示词里带哪些技能说明。",
				en: "Chooses which skill descriptions go into the prompt.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "minSkills",
					kind: "number",
					default: 4,
					min: 1,
					max: 100,
					label: { zh: "技能少于这个数就不筛", en: "Don't filter below this many skills" },
				},
				{
					key: "waitMs",
					kind: "number",
					default: 4000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
				},
				{
					key: "applyLate",
					kind: "boolean",
					default: true,
					label: { zh: "首次判定晚到时下一回合补上", en: "Apply a late first verdict from the next turn" },
					help: {
						zh: "会话第一条消息的判定超过等待时间才到时，从下一回合起照它隐藏技能，提示词前缀只变这一次；关掉则整个会话都带着全部技能说明。",
						en: "When the verdict on the session's first message comes after the wait, skills are hidden from the next turn on, which changes the prompt prefix once. Off: the session keeps every skill description.",
					},
				},
			],
		},
		{
			name: "catalog",
			title: { zh: "能力目录", en: "Capability catalog" },
			summary: {
				zh: "装得多、露得少：能力包和 MCP 服务器默认隐藏，按任务打开。",
				en: "Install a lot, expose little: packs and MCP servers stay hidden until a task needs them.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "waitMs",
					kind: "number",
					default: 4000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
				},
				{
					key: "askUnattended",
					kind: "boolean",
					default: false,
					label: { zh: "无人值守的运行也判定要开哪些能力", en: "Also choose capabilities in unattended runs" },
					help: {
						zh: "无人值守指 mu --print 和 json 模式的一次性运行。默认不问：能力照样隐藏，开工前也不等。",
						en: "Unattended means a one-shot mu --print or json-mode run. Off by default: capabilities stay hidden, and the turn doesn't wait.",
					},
				},
				{
					key: "unattendedHidden",
					kind: "list",
					default: [
						"delegate",
						"apply_patch_from",
						"browse",
						"locate",
						"remember",
						"find_skill",
						"find_capability",
						"hive",
						"mu-browser",
					],
					label: {
						zh: "无人值守的运行里不放进请求的工具和技能",
						en: "Tools and skills left out of unattended runs",
					},
					help: {
						zh: "按名字写。这些在一次性运行里几乎没人用，却每次请求都要带上。用命令点名的（比如 /hive）照样保留；清空就全带上。",
						en: "By name. One-shot runs almost never use them, and each one is in every request. One you call for by its command (such as /hive) stays. Empty keeps them all.",
					},
				},
			],
		},
		{
			name: "frame",
			title: { zh: "任务帧与待办", en: "Task frame and to-do list" },
			summary: {
				zh: "记住你到底要什么：目标、你的硬约束（原话加出处）、当前子目标、验收条件。验收条件就是待办清单，模型用 todo 工具勾选。所有「和目标相关吗」的判断都以它为准，回退会话时它跟着回退。",
				en: "Keeps track of what you actually want: the goal, your hard constraints (in your own words, with their source), the current subgoal and the acceptance criteria. The acceptance criteria are the to-do list the model checks off with the todo tool. Every goal-related verdict reads the frame, and it rewinds with the session.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "waitMs",
					kind: "number",
					default: 3000,
					min: 0,
					max: 30000,
					unit: ms,
					label: { zh: "回合最多等任务帧多久", en: "Wait for the task frame at most" },
					help: {
						zh: "从消息到达算起。超时不丢弃：本回合先用上一版加这条原话，更新完成后照常落地。",
						en: "Counted from when the message arrives. A late update isn't dropped: the turn starts with the previous version plus the raw message, and the update applies when it's ready.",
					},
				},
				{
					key: "writerTimeoutMs",
					kind: "number",
					default: 20000,
					min: 1000,
					max: 120000,
					unit: ms,
					label: { zh: "重写任务帧的时限", en: "Time limit for writing a frame" },
					help: {
						zh: "超时或写坏了就保留上一版并标记为过期，按目标筛选上下文的功能暂停，下一条消息时重试。",
						en: "On a timeout or malformed reply, the last version stays and is marked stale, goal-based filtering holds back, and the next message tries again.",
					},
				},
				{
					key: "show",
					kind: "boolean",
					default: true,
					label: { zh: "在对话里显示任务帧更新", en: "Show frame updates in the conversation" },
				},
			],
		},
		{
			name: "memory",
			title: { zh: "经验库", en: "Lessons" },
			summary: {
				zh: "从你的纠正、代理自己的脱困、模型和子代理的发现里学经验，存之前先和已有的合并，下次遇到相关任务时带上，没人照做的自动退役。随时可以查看、编辑或让一条退役。",
				en: "Learns from your corrections, from the agent getting itself unstuck and from what the model and subagents find. Merges each new lesson with existing ones before saving it, brings relevant lessons into later turns and retires those that are never followed. /lessons lists them; /forget retires one.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "path",
					kind: "text",
					default: "",
					label: { zh: "经验库文件", en: "Lessons file" },
					help: { zh: "留空使用默认位置。", en: "Leave empty for the default location." },
				},
				{
					key: "maxCandidates",
					kind: "number",
					default: 24,
					min: 1,
					max: 200,
					label: { zh: "每次最多评估", en: "Judge at most" },
					help: {
						zh: "照做次数多的、最近记下或确认过的排在前面。",
						en: "The most followed come first, then the most recently saved or confirmed.",
					},
				},
				{
					key: "maxInjected",
					kind: "number",
					default: 5,
					min: 0,
					max: 20,
					label: { zh: "每回合最多带入", en: "Bring in at most" },
				},
				{
					key: "waitMs",
					kind: "number",
					default: 4000,
					min: 0,
					max: 30000,
					unit: ms,
					label: { zh: "最多等召回结果", en: "Wait for recall at most" },
					help: {
						zh: "从消息到达算起；给子代理挑经验也等这么久。",
						en: "Counted from when the message arrives; picking lessons for subagents uses the same limit.",
					},
				},
				{
					key: "retireAfter",
					kind: "number",
					default: 8,
					min: 0,
					max: 100,
					label: { zh: "召回几次从没照做就退役", en: "Retire after this many recalls without being followed" },
					help: { zh: "0 表示从不自动退役。", en: "0 never retires lessons automatically." },
				},
				{
					key: "mergeNeighbours",
					kind: "number",
					default: 6,
					min: 0,
					max: 16,
					label: { zh: "存之前比较几条最像的", en: "Compare with this many similar lessons" },
					help: {
						zh: "按字面重合挑出来，一次请求问完；0 表示不整理，直接存。",
						en: "Chosen by shared words and judged in one request; 0 saves without merging.",
					},
				},
				{
					key: "outcome",
					kind: "boolean",
					default: true,
					label: { zh: "从代理的脱困中学", en: "Learn from the agent getting unstuck" },
					help: {
						zh: "需要写作模型或当前对话模型把经验写成一句话。",
						en: "Needs the writer model or the main model to word the lesson.",
					},
				},
				{
					key: "applied",
					kind: "boolean",
					default: true,
					label: {
						zh: "回合结束时检查经验有没有被照做",
						en: "Check at the end of a turn whether lessons were followed",
					},
				},
				{
					key: "unattendedWrites",
					kind: "boolean",
					default: false,
					label: { zh: "无人值守的运行也学新经验", en: "Also learn new lessons in unattended runs" },
					help: {
						zh: "无人值守指 mu --print 和 json 模式的一次性运行。默认只读已有的经验，不从纠正、脱困和子代理报告里学；remember 工具由能力目录拿掉。",
						en: "Unattended means a one-shot mu --print or json-mode run. Off by default: kept lessons are still read, but nothing is learned from corrections, ways out or subagent reports. The capability catalog leaves out the remember tool.",
					},
				},
			],
		},
		{
			name: "procedures",
			title: { zh: "做法变技能", en: "Procedures as skills" },
			summary: {
				zh: "一次成功的长运行如果是一套可复用的做法，起草成技能放进待审区：/skills 列出草稿，/skills show、accept、reject 查看、安装、丢掉。不经你同意不安装任何技能。",
				en: "When a long, successful run was a reusable procedure, drafts it as a skill for you to review: /skills lists the drafts, and /skills show, accept and reject read, install or discard one. Nothing is installed without your approval.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "minSteps",
					kind: "number",
					default: 6,
					min: 2,
					max: 100,
					label: { zh: "至少多少步", en: "Minimum steps" },
					help: {
						zh: "少于这么多步的运行不问。",
						en: "Runs with fewer steps aren't considered.",
					},
				},
				{
					key: "minCommands",
					kind: "number",
					default: 2,
					min: 0,
					max: 50,
					label: { zh: "至少多少条命令", en: "Minimum commands" },
					help: {
						zh: "跑过的 shell 命令少于这么多的运行不问：做法总要做点什么。",
						en: "Runs with fewer shell commands aren't considered: a procedure has to do something.",
					},
				},
				{
					key: "maxPending",
					kind: "number",
					default: 3,
					min: 1,
					max: 20,
					label: { zh: "每个项目最多待审", en: "Max pending drafts per project" },
					help: {
						zh: "一个项目的草稿攒到这么多，就不再起草，等你先看。",
						en: "Once a project has this many pending drafts, no more are made until you review them.",
					},
				},
				{
					key: "unattended",
					kind: "boolean",
					default: false,
					label: { zh: "无人值守的运行也起草技能", en: "Also draft skills in unattended runs" },
					help: {
						zh: "无人值守指 mu --print 和 json 模式的一次性运行。默认不起草：草稿要有人审，起草还会让运行结束后多等一次模型调用。",
						en: "Unattended means a one-shot mu --print or json-mode run. Off by default: a draft needs someone to review it, and writing one keeps the run going for another model call.",
					},
				},
			],
		},
		{
			name: "guard",
			title: { zh: "危险命令把关", en: "Risky command guard" },
			summary: { zh: "危险命令在执行前确认。", en: "Confirms dangerous commands before they run." },
			defaultEnabled: true,
			options: [],
		},
		{
			name: "permissions",
			title: { zh: "权限模式", en: "Permission modes" },
			summary: {
				zh: "完全访问、判定模式、最小权限三种模式，用 /permissions 随时切换；需要授权时在状态栏提示你，可以只允许这一次，或这次对话都允许。开着它时，危险命令的把关也归它管。",
				en: "Full access, Judge mode or Ask first; switch any time with /permissions. When a step needs your permission, the status bar asks; allow it once or for the whole conversation. While this feature is on, it also takes over the risky command guard.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "mode",
					kind: "choice",
					default: "judge",
					choices: [
						{ value: "full", label: { zh: "完全访问", en: "Full access" } },
						{ value: "judge", label: { zh: "判定模式", en: "Judge mode" } },
						{ value: "ask", label: { zh: "最小权限", en: "Ask first" } },
					],
					label: { zh: "新对话的默认模式", en: "Mode for new conversations" },
					help: {
						zh: "用 /permissions 选过之后，以你最后选的为准。",
						en: "Once you pick a mode with /permissions, your latest choice is used.",
					},
				},
				{
					key: "readOnlyChains",
					kind: "boolean",
					default: true,
					label: { zh: "只读命令串直接执行", en: "Read-only command chains go ahead" },
					help: {
						zh: "只由只读命令用 ;、&&、|| 或 | 连起来的命令（如 pwd && ls -la; git status），和单条只读命令一样直接执行，不问判定器也不问你。可以带 2>/dev/null、2>&1 这类丢掉输出的重定向；写文件的重定向、sed -i、tee、带 -exec 或 -delete 的 find 都不算只读。关掉后只有单条只读命令或管道直接执行。",
						en: "Commands made only of read-only commands joined by ;, &&, || or | (such as pwd && ls -la; git status) run without asking the judge or you, like a single read-only command. They may throw output away with 2>/dev/null or 2>&1; a redirect that writes a file, sed -i, tee or find with -exec or -delete is not read-only. Off: only a single read-only command or pipeline goes ahead.",
					},
				},
			],
		},
		{
			name: "constraints",
			title: { zh: "硬约束把关", en: "Hard constraint gate" },
			summary: {
				zh: "改动文件或执行命令之前，对照你的硬约束检查一遍；子代理同样受这些约束限制。",
				en: "Checks each change or command against your hard constraints first; subagents follow them too.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "maxConstraints",
					kind: "number",
					default: 6,
					min: 1,
					max: 20,
					label: { zh: "每次最多对照的约束条数", en: "Max constraints checked per call" },
					help: { zh: "取最新的几条。", en: "The newest ones are used." },
				},
				{
					key: "waitMs",
					kind: "number",
					default: 5000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
				},
				{
					key: "skipReadOnly",
					kind: "boolean",
					default: true,
					label: { zh: "只读命令不对照", en: "Skip read-only commands" },
					help: {
						zh: "只读的 shell 命令（ls、git status、cat … | grep …，以及它们连成的命令串）不拿去对照约束，和 read、grep 工具一样。",
						en: "Read-only shell commands (ls, git status, cat … | grep …, and chains of them) aren't checked against your constraints, just like the read and grep tools.",
					},
				},
			],
		},
		{
			name: "injection",
			title: { zh: "注入筛查", en: "Injection screening" },
			summary: {
				zh: "模型读网页、搜索结果、MCP 结果和 shell 命令从别的机器取回的内容之前，扣下写给 AI 的指令；说明里夹带私货的 MCP 工具从列表里拿掉。",
				en: "Withholds instructions aimed at an AI before the model reads web pages, search results, MCP responses and what shell commands fetch from other machines, and removes MCP tools whose descriptions contain such instructions.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "tools",
					kind: "list",
					default: ["web_fetch", "web_search", "browse", "mcp__*"],
					label: { zh: "要筛的工具", en: "Tools screened" },
					help: {
						zh: "工具名，或以 * 结尾的前缀；mcp__* 是所有 MCP 服务器。",
						en: "Tool names, or a prefix ending in *; mcp__* covers every MCP server.",
					},
				},
				{
					key: "fetchCommands",
					kind: "list",
					default: [
						"curl",
						"wget",
						"gh",
						"glab",
						"lynx",
						"w3m",
						"Invoke-WebRequest",
						"Invoke-RestMethod",
						"iwr",
						"irm",
					],
					label: { zh: "算作外取的命令", en: "Fetching commands" },
					help: {
						zh: "bash 或 PowerShell 命令用到这些程序时，输出要筛；给的地址全在本机（localhost）时不筛，gh 和 glab 总要筛。留空：不筛 shell 输出。",
						en: "When a bash or PowerShell command runs one of these programs, its output is screened unless every address it's given is on this machine (localhost); gh and glab output is always screened. Empty: no shell output is screened.",
					},
				},
				{
					key: "proseWords",
					kind: "number",
					default: 6,
					min: 0,
					max: 50,
					label: { zh: "几个词连成句才送判", en: "Words in a row to ask the judge" },
					help: {
						zh: "一段里没有这么多个连着的词（中文、日文这类不空格的文字算连着 8 个字），就不问判定器，只按规则看：目录列表、链接列表、响应头、几个字的 grep 结果里放不下一条指令。0：每段都问。",
						en: "A passage without this many words in a row (8 characters in a row for Chinese, Japanese and other scripts written without spaces) isn't put to the judge; rules alone read it. Directory listings, link lists, response headers and short grep hits can't hold an instruction. 0: every passage is judged.",
					},
				},
				{
					key: "waitMs",
					kind: "number",
					default: 6000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
					help: {
						zh: "超时就只按规则扣下明显的注入用语，判定照样记账。",
						en: "After this, rules withhold only obvious injection phrases; the verdict is still recorded.",
					},
				},
				{
					key: "descriptions",
					kind: "boolean",
					default: true,
					label: { zh: "筛 MCP 工具说明", en: "Screen MCP tool descriptions" },
					help: {
						zh: "说明里要 AI 做额外事情的 MCP 工具从列表里拿掉（tool.description）。",
						en: "MCP tools whose descriptions ask the AI to do more than use the tool are removed from the list (tool.description).",
					},
				},
				{
					key: "descriptionWaitMs",
					kind: "number",
					default: 8000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "工具说明最多等待", en: "Wait for tool description verdicts at most" },
					help: {
						zh: "第一次见到的 MCP 工具，回合最多等这么久；超时先按规则处理，判定到了再更新。",
						en: "How long a turn waits for verdicts on MCP tools it hasn't seen before. After this, rules decide until the verdict arrives.",
					},
				},
			],
		},
		{
			name: "admission",
			title: { zh: "工具输出准入", en: "Tool output admission" },
			summary: {
				zh: "控制多长的工具输出、以什么方式进入上下文。",
				en: "Decides which parts of long tool output enter the context.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "minChars",
					kind: "number",
					default: 4000,
					min: 500,
					max: 200000,
					unit: chars,
					label: { zh: "超过这个长度才筛", en: "Only filter output longer than" },
				},
				{
					key: "chunkChars",
					kind: "number",
					default: 1200,
					min: 200,
					max: 20000,
					unit: chars,
					label: { zh: "每块大小", en: "Chunk size" },
				},
				{
					key: "maxChunks",
					kind: "number",
					default: 48,
					min: 4,
					max: 400,
					label: { zh: "最多判断的块数", en: "Judge at most this many chunks" },
				},
				{
					key: "batchChunks",
					kind: "number",
					default: 16,
					min: 1,
					max: 32,
					label: { zh: "一次请求判断几块", en: "Chunks per request" },
					help: {
						zh: "托管判定器把多块放进一个请求，状态只计费一次；本地判定器始终一次一块。",
						en: "A hosted judge takes many chunks in one request, with the shared context billed once; the local judge takes one at a time.",
					},
				},
				{
					key: "waitMs",
					kind: "number",
					default: 4000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
					help: {
						zh: "超时就整段放行，判定只记账。",
						en: "After this, the full output goes in; the verdict is only recorded.",
					},
				},
				{
					key: "passThrough",
					kind: "list",
					default: ["read", "edit", "write", "delegate", "hive", "web_fetch"],
					label: { zh: "这些工具的输出不筛", en: "Never filter these tools" },
				},
				{
					key: "printCommands",
					kind: "list",
					default: [
						"cat",
						"sed -n",
						"head",
						"tail",
						"nl",
						"less",
						"bat",
						"grep",
						"rg",
						"od",
						"xxd",
						"git show",
						"git diff",
						"readelf",
						"objdump",
					],
					label: { zh: "只打印文件的命令不筛", en: "Never filter file prints" },
					help: {
						zh: "bash 命令只用这些程序打印文件（前面可以 cd，可以用管道接这些程序）时，输出整段放行，和 read 一样：模型要看的就是这个文件。构建、测试、后台任务和别的命令的输出照常判断。留空：都判断。",
						en: "When a bash command only prints a file with these programs (after a cd, or piped through them), its output goes in whole, as with read: the model asked to see that file. Build, test, background-job and other output is still judged. Empty: all of it is judged.",
					},
				},
				{
					key: "testLog",
					kind: "choice",
					default: "off",
					label: { zh: "测试日志精简", en: "Test log trimming" },
					choices: [
						{ value: "off", label: { zh: "关闭", en: "Off" } },
						{
							value: "rules",
							label: { zh: "只去掉完全重复的段落（无损）", en: "Drop exact repeats only (lossless)" },
						},
						{
							value: "jev",
							label: { zh: "再由判定器挑选剩余部分", en: "Also let the judge pick from the rest" },
						},
					],
				},
				{
					key: "agentEnv",
					kind: "boolean",
					default: true,
					label: { zh: "告诉测试工具「读者是代理」", en: "Tell test runners an agent is reading" },
					help: {
						zh: "Vitest 等会因此只输出失败和汇总。",
						en: "Vitest and other runners then print only failures and the summary.",
					},
				},
			],
		},
		{
			name: "forgetting",
			title: { zh: "过期结果遗忘", en: "Forgetting stale results" },
			summary: {
				zh: "上下文吃紧时，把用不上的旧结果换成占位。",
				en: "Replaces stale results with placeholders when the context gets tight.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "thresholds",
					kind: "numbers",
					default: [50, 70, 85],
					label: { zh: "触发阈值（上下文用量 %）", en: "Trigger thresholds (context use %)" },
				},
				{
					key: "minChars",
					kind: "number",
					default: 6000,
					min: 500,
					max: 200000,
					unit: chars,
					label: { zh: "只考虑长于此的结果", en: "Only results longer than" },
				},
				{
					key: "minAgeTurns",
					kind: "number",
					default: 2,
					min: 0,
					max: 50,
					label: { zh: "至少过了几个回合", en: "At least this many turns old" },
				},
				{
					key: "maxPerBatch",
					kind: "number",
					default: 12,
					min: 1,
					max: 100,
					label: { zh: "每批最多判断", en: "Judge at most per batch" },
				},
				{
					key: "waitMs",
					kind: "number",
					default: 4000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
					help: {
						zh: "这次请求最多等这么久；来晚的判定在下一次请求生效。",
						en: "The current request waits this long; later verdicts apply from the next request on.",
					},
				},
			],
		},
		{
			name: "compaction",
			title: { zh: "免摘要压缩", en: "Summary-free compaction" },
			summary: {
				zh: "压缩时保留原文片段，不写摘要。",
				en: "Compaction that keeps original passages instead of a summary.",
			},
			defaultEnabled: false,
			beta: true,
			options: [
				{
					key: "keepThreshold",
					kind: "number",
					default: 0.5,
					min: 0,
					max: 1,
					label: { zh: "保留阈值", en: "Keep threshold" },
				},
				{
					key: "minChars",
					kind: "number",
					default: 600,
					min: 100,
					max: 20000,
					unit: chars,
					label: { zh: "短于此的原样保留", en: "Keep anything shorter than" },
				},
				{
					key: "headChars",
					kind: "number",
					default: 300,
					min: 0,
					max: 5000,
					unit: chars,
					label: { zh: "裁掉时保留的开头", en: "Head kept when pruning" },
				},
				{
					key: "targetRatio",
					kind: "number",
					default: 0.5,
					min: 0.05,
					max: 1,
					label: { zh: "压缩后占原来的比例", en: "Target share of the original" },
				},
				{
					key: "maxWindowShare",
					kind: "number",
					default: 0.25,
					min: 0.05,
					max: 0.9,
					label: { zh: "最多占上下文窗口的比例", en: "At most this share of the window" },
				},
				{
					key: "freeChars",
					kind: "number",
					default: 24000,
					min: 0,
					max: 500000,
					unit: chars,
					label: { zh: "小于此的历史不受预算挤压", en: "Leave histories smaller than this alone" },
				},
				{
					key: "maxJudged",
					kind: "number",
					default: 120,
					min: 10,
					max: 1000,
					label: { zh: "最多判断的片段数", en: "Judge at most this many passages" },
				},
			],
		},
		{
			name: "checkpoint",
			title: { zh: "检查点与回退", en: "Checkpoints and rewind" },
			summary: {
				zh: "每个会改文件的回合，在第一次改动前给工作区拍一张快照，存在 mu 自己的影子 git 目录里，不碰你的仓库。/rewind 让文件和对话一起回到那一刻，/rewind undo 撤销回退。",
				en: "Before the first file change in each turn, snapshots the working tree into mu's own shadow git directory, without touching your repository. /rewind restores files and the conversation; /rewind undo reverses a rewind.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "dir",
					kind: "text",
					default: "",
					label: { zh: "快照存放目录", en: "Where snapshots are kept" },
					help: {
						zh: "留空则放在 mu 主目录的 mu/checkpoints 下，每个项目一个影子仓库。",
						en: "Empty means mu/checkpoints in mu's home folder, with one shadow repository per project.",
					},
				},
				{
					key: "keep",
					kind: "number",
					default: 50,
					min: 1,
					max: 1000,
					label: { zh: "每个项目保留的快照数", en: "Snapshots kept per project" },
				},
				{
					key: "maxAgeDays",
					kind: "number",
					default: 14,
					min: 1,
					max: 365,
					label: { zh: "快照保留天数", en: "Days a snapshot is kept" },
					unit: { zh: "天", en: "days" },
				},
				{
					key: "maxFileMb",
					kind: "number",
					default: 5,
					min: 1,
					max: 1024,
					label: { zh: "单个文件大小上限", en: "Largest file in a snapshot" },
					help: {
						zh: "更大的文件不进快照，回退时也绝不动它。",
						en: "Larger files stay out of snapshots, and a rewind never touches them.",
					},
					unit: { zh: "MB", en: "MB" },
				},
				{
					key: "maxFiles",
					kind: "number",
					default: 5000,
					min: 100,
					max: 1000000,
					label: { zh: "一次快照最多的文件数", en: "Max files per snapshot" },
					help: {
						zh: "要拍的文件更多时，这个会话就不拍检查点，并说一次原因。你的主目录和 mu 自己的目录从来不拍。",
						en: "With more files than this, mu runs without checkpoints and tells you once. Your home folder and mu's own folders are never snapshotted.",
					},
					unit: { zh: "个", en: "files" },
				},
				{
					key: "maxTotalMb",
					kind: "number",
					default: 200,
					min: 1,
					max: 100000,
					label: { zh: "一次快照最多的总大小", en: "Max total snapshot size" },
					help: {
						zh: "要拍的文件加起来更大时，这个会话就不拍检查点，并说一次原因。",
						en: "Above this, mu runs without checkpoints and tells you once.",
					},
					unit: { zh: "MB", en: "MB" },
				},
				{
					key: "ignore",
					kind: "list",
					default: [],
					label: { zh: "额外忽略的路径", en: "Extra paths to ignore" },
					help: {
						zh: "gitignore 写法，一行一条。项目自己的 .gitignore 和内置清单（node_modules、构建产物等）始终生效。",
						en: "gitignore patterns, one per line. The project's own .gitignore and the built-in list (node_modules, build outputs and so on) always apply.",
					},
				},
				{
					key: "timeoutMs",
					kind: "number",
					default: 30000,
					min: 1000,
					max: 600000,
					label: { zh: "单次快照最长用时", en: "Max time for a snapshot" },
					help: {
						zh: "超时则本回合不拍快照，工具照常执行。",
						en: "Past this, the turn runs without a checkpoint; the tool call still runs.",
					},
					unit: ms,
				},
				{
					key: "propose",
					kind: "boolean",
					default: true,
					label: { zh: "发现死路时提议回退", en: "Propose a rewind at a dead end" },
				},
				{
					key: "confirmSeconds",
					kind: "number",
					default: 120,
					min: 0,
					max: 3600,
					label: { zh: "提议等待你回答的时间", en: "How long a proposal waits for you" },
					help: {
						zh: "到时未答就继续原来的工作。0 表示一直等。",
						en: "If you don't answer, the run continues. 0 waits forever.",
					},
					unit: { zh: "秒", en: "s" },
				},
			],
		},
		{
			name: "monitor",
			title: { zh: "跑偏监测", en: "Drift monitor" },
			summary: { zh: "发现偏离目标和原地打转。", en: "Catches drift from the goal and the agent going in circles." },
			defaultEnabled: true,
			options: [
				{
					key: "every",
					kind: "number",
					default: 6,
					min: 1,
					max: 100,
					label: { zh: "每隔几次工具调用检查", en: "Tool calls between checks" },
				},
				{
					key: "minMinutes",
					kind: "number",
					default: 3,
					min: 0,
					max: 60,
					unit: { zh: "分钟", en: "min" },
					label: { zh: "两次检查至少间隔", en: "At least this long between checks" },
					help: {
						zh: "攒够上面的工具调用次数，并且离上次检查过了这么久，才再检查。",
						en: "A check needs both: the tool calls above, and this long since the last check.",
					},
				},
				{
					key: "maxMinutes",
					kind: "number",
					default: 10,
					min: 1,
					max: 120,
					unit: { zh: "分钟", en: "min" },
					label: { zh: "最长隔多久检查一次", en: "Check at least this often" },
					help: {
						zh: "到时间就检查，不管有没有新的工具调用，所以很久没有动静的回复也照看得到。",
						en: "A check comes after this long whatever happened, so a long reply with no tool call is checked too.",
					},
				},
				{
					key: "stuckMinutes",
					kind: "number",
					default: 10,
					min: 0,
					max: 120,
					unit: { zh: "分钟", en: "min" },
					label: { zh: "多久没有进展才提醒跑偏", en: "No progress for this long before a drift steer" },
					help: {
						zh: "还要连续两次检查都判断为跑偏，且把握至少九成。进展指：写出新文件、通过的测试变多、出现不同的报错、跑了一分钟以上的命令成功结束、勾掉一项待办。",
						en: "It also takes two drift readings in a row, each at least 90% sure. Progress is a new file written, more tests passing, a different error, a command of a minute or more that succeeds, or an item ticked.",
					},
				},
				{
					key: "cooldownMinutes",
					kind: "number",
					default: 15,
					min: 0,
					max: 240,
					unit: { zh: "分钟", en: "min" },
					label: { zh: "两次提醒至少间隔", en: "At least this long between two steers" },
					help: {
						zh: "判定器的提醒（跑偏或原地打转）离监测的上一次提醒至少隔这么久，规则发现的打转也算一次。",
						en: "The judge's steers, on drift or a loop, wait this long after the monitor's last steer, the loop rule's included.",
					},
				},
				{
					key: "repeats",
					kind: "number",
					default: 3,
					min: 2,
					max: 20,
					label: { zh: "同一调用重复几次算打转", en: "Repeats that count as a loop" },
					help: {
						zh: "输入完全相同、结果也完全相同才算同一调用；分段读同一个文件不算。",
						en: "Only the same input with the same result counts as the same call; paging through a file does not.",
					},
				},
				{
					key: "window",
					kind: "number",
					default: 8,
					min: 2,
					max: 100,
					label: { zh: "观察窗口", en: "Recent calls checked" },
				},
				{
					key: "unattended",
					kind: "boolean",
					default: false,
					label: { zh: "无人值守的运行也判断跑偏", en: "Also check for drift in unattended runs" },
					help: {
						zh: "无人值守指 mu --print 和 json 模式的一次性运行。默认不问；发现原地打转的规则照常生效。",
						en: "Unattended means a one-shot mu --print or json-mode run. Off by default. The rule that catches going in circles still applies.",
					},
				},
			],
		},
		{
			name: "lsp",
			title: { zh: "语言服务器诊断", en: "Language server diagnostics" },
			summary: {
				zh: "接本机已装的语言服务器（不代装），只留这次改动新引入的报错，由判定器决定何时告诉模型。",
				en: "Uses language servers already installed on this machine (it installs none), keeps only diagnostics an edit newly introduced and lets the judge decide when to tell the model.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "builtin",
					kind: "boolean",
					default: true,
					label: { zh: "使用内置的常见服务器表", en: "Use the built-in list of well-known servers" },
					help: {
						zh: "TypeScript、Python、Go、Rust、C/C++ 的常见服务器，只在 PATH 上查找。自定义的服务器在设置文件里添加。",
						en: "Well-known servers for TypeScript, Python, Go, Rust and C/C++, found on PATH only. Add your own under features.lsp.servers in mu.json.",
					},
				},
				{
					key: "editTools",
					kind: "list",
					default: ["edit", "write"],
					label: { zh: "算作改文件的工具", en: "Tools that count as editing a file" },
				},
				{
					key: "subAgents",
					kind: "boolean",
					default: false,
					label: { zh: "子代理也启动语言服务器", en: "Subagents start language servers too" },
					help: {
						zh: "默认关闭：每个子代理各起一套服务器会很吃资源。",
						en: "Off by default: a set of servers per subagent is heavy on the machine.",
					},
				},
				{
					key: "settleMs",
					kind: "number",
					default: 1500,
					min: 0,
					max: 10000,
					unit: ms,
					label: { zh: "改完后最多等服务器多久", en: "Wait for the server after an edit, at most" },
					help: {
						zh: "超时不再等：晚到的诊断在下一次改动或回合结束时处理。",
						en: "Past this, nothing waits: late diagnostics are handled at the next edit or when the turn ends.",
					},
				},
				{
					key: "turnEndSettleMs",
					kind: "number",
					default: 3000,
					min: 0,
					max: 30000,
					unit: ms,
					label: { zh: "回合结束时最多等多久", en: "Wait at the end of a turn, at most" },
				},
				{
					key: "quietMs",
					kind: "number",
					default: 250,
					min: 20,
					max: 5000,
					unit: ms,
					label: { zh: "服务器安静多久算说完", en: "Silence that counts as the server being done" },
				},
				{
					key: "baselineMs",
					kind: "number",
					default: 5000,
					min: 100,
					max: 60000,
					unit: ms,
					label: { zh: "等改动前诊断的上限", en: "Wait for the pre-edit diagnostics, at most" },
					help: {
						zh: "在后台等，不挡工具调用。过了上限就不把首份诊断当成新问题。",
						en: "Waited for in the background, never blocking a tool. Past this, the first report isn't treated as new.",
					},
				},
				{
					key: "maxItems",
					kind: "number",
					default: 10,
					min: 1,
					max: 100,
					label: { zh: "一次最多告知几条", en: "Diagnostics reported at once, at most" },
				},
				{
					key: "maxServers",
					kind: "number",
					default: 4,
					min: 1,
					max: 16,
					label: { zh: "同时运行的服务器上限", en: "Servers running at once, at most" },
				},
				{
					key: "waitMs",
					kind: "number",
					default: 4000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "等判定最多多久", en: "Wait for the judge, at most" },
				},
			],
		},
		{
			name: "ttsr",
			title: { zh: "写偏即停（实验）", en: "Mid-stream correction (experimental)" },
			summary: {
				zh: "语义版 TTSR：不用正则，而由判定器发现模型写偏，中断输出、摆出规则、从原处继续。默认关闭；开启后每隔一段输出就会多一次判定调用。",
				en: "The judge, not a regular expression, notices when output goes astray, cuts it off, shows the rule and lets the model continue. Off by default; when on, every stretch of output costs one more judge call.",
			},
			defaultEnabled: false,
			options: [
				{
					key: "rules",
					kind: "list",
					default: [],
					label: { zh: "一直要守的规则", en: "Rules to follow at all times" },
					help: {
						zh: "一行一条，用平常的话写，例如「用中文回答」「不要写占位实现」。任务帧里你的硬约束会自动加入，不必重复。",
						en: "One per line, in plain words, e.g. “Answer in Chinese”, “No placeholder implementations”. Your hard constraints from the task frame are added automatically.",
					},
				},
				{
					key: "segmentChars",
					kind: "number",
					default: 600,
					min: 200,
					max: 5000,
					label: { zh: "每输出多少字符判一次", en: "Characters of output per check" },
				},
				{
					key: "maxRules",
					kind: "number",
					default: 4,
					min: 1,
					max: 12,
					label: { zh: "每次最多对照的规则条数", en: "Rules checked per call at most" },
					help: { zh: "超出时保留你最近说的。", en: "When there are more, the most recent ones are used." },
				},
				{
					key: "maxInterrupts",
					kind: "number",
					default: 2,
					min: 1,
					max: 10,
					label: { zh: "两次发言之间最多中断几次", en: "Max cuts between two of your messages" },
				},
			],
		},
		{
			name: "deadline",
			title: { zh: "运行时限", en: "Run deadline" },
			summary: {
				zh: "知道这次运行什么时候必须结束时：只思考的回复会更早打断（见长思考重试），时间用掉 50% 和 80% 时各告诉模型还剩几分钟，第二次还提醒它先把要交的结果做好（文件写好、服务跑起来）再打磨。不问判定器。没有设时间预算就什么都不变。",
				en: "When mu knows when the run has to be done, a reply that only thinks is cut sooner (see Long-thinking retry), and the model is told how many minutes are left when 50% and 80% of the time has passed; the second time it is also asked to get the requested result in place (files written, services running) before polishing. No judge is asked. Without a time budget, nothing changes.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "budgetS",
					kind: "number",
					default: 0,
					min: 0,
					unit: { zh: "秒", en: "s" },
					label: { zh: "一次运行的时间预算", en: "Time budget for a run" },
					help: {
						zh: "从 mu 进程启动时算起，0 表示不设。环境变量 MU_TIME_BUDGET_S 优先，评测框架用它按任务的超时来设。子代理不用这个预算。",
						en: "Counted from when the mu process starts; 0 means none. The environment variable MU_TIME_BUDGET_S takes precedence, and a benchmark harness sets it from the task's timeout. Sub-agents ignore the budget.",
					},
				},
				{
					key: "notices",
					kind: "boolean",
					default: true,
					label: { zh: "告诉模型还剩多少时间", en: "Tell the model how much time is left" },
					help: {
						zh: "用掉 50% 和 80% 时各说一句。正在跑的工具调用不受打扰，模型在下一步之前读到。",
						en: "One line at 50% and one at 80%. Tool calls under way are not interrupted; the model reads it before its next step.",
					},
				},
			],
		},
		{
			name: "watchdog",
			title: { zh: "长思考重试", en: "Long-thinking retry" },
			summary: {
				zh: "一次回复只思考、迟迟不写字也不调用工具，到时限就打断，用同样的思考强度重问一次，并把它想到哪一步带给它，让它先动手再接着想。重问的那一次不再打断。",
				en: "When a reply has only been thinking for too long, with no text and no tool call yet, it is cut and asked again at the same reasoning effort. The retry is told where the reasoning had gotten to and asked to act on it first. The retry itself is never cut.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "thinkingMs",
					kind: "number",
					default: 600000,
					min: 60000,
					unit: ms,
					label: { zh: "只思考多久后打断", en: "Cut a reply after thinking this long" },
					help: {
						zh: "运行有时限时（见运行时限、MU_TIME_BUDGET_S）会更早：最多等回复开始时剩余时间的一半，至少 1 分钟。",
						en: "With a run deadline (see Run deadline, MU_TIME_BUDGET_S) the cut can come sooner: after at most half the time left when the reply started, and never under a minute.",
					},
				},
				{
					key: "maxCuts",
					kind: "number",
					default: 3,
					min: 1,
					max: 10,
					label: { zh: "两次发言之间最多打断几次", en: "Max cuts between two of your messages" },
				},
			],
		},
		{
			name: "goal",
			title: { zh: "目标模式", en: "Goal mode" },
			summary: {
				zh: "定下一个完成条件后，代理会一直干到条件成立为止。每次它想停，由大模型对照证据判断是否达成、下一步做什么。被你打断、模型调用失败、连续空转或原地打转、用完续跑次数或时间，都会自己停下；你再发一条消息就接着干。",
				en: "After /goal <condition>, the agent keeps working until the condition holds (/goal alone asks for one). Each time it wants to stop, a model reads the evidence and decides: met, or the next step. It pauses on its own when you interrupt, a model call fails, it idles or goes in circles, or it reaches its limits; your next message resumes it.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "checker",
					kind: "choice",
					default: "model",
					label: { zh: "谁来判断目标是否达成", en: "Who checks whether the goal is met" },
					help: {
						zh: "大模型读目标、这一轮做了什么、最后一次测试的结果和结束语，给出结论和下一步；它没答上来时才退回判定器。无论哪种，没勾的验收条件、改完没跑都算没达成。",
						en: "A model reads the goal, what the run did, the last test run and the closing message, then gives a verdict and the next step; the judge steps in only when the model doesn't answer. Either way, an open acceptance item or an unverified edit means not yet.",
					},
					choices: [
						{ value: "model", label: { zh: "大模型（推荐）", en: "A model (recommended)" } },
						{ value: "jev", label: { zh: "判定器", en: "The judge" } },
					],
				},
				{
					key: "checkModel",
					kind: "text",
					default: "",
					label: { zh: "判断用的模型", en: "Model for the check" },
					help: {
						zh: "写成「提供商/模型」。留空就用当前会话的模型。",
						en: "As provider/model. Empty: the current model.",
					},
				},
				{
					key: "checkThinking",
					kind: "choice",
					default: "off",
					label: { zh: "判断时的思考等级", en: "Thinking level for the check" },
					choices: [
						{ value: "off", label: { zh: "不思考", en: "Off" } },
						{ value: "minimal", label: { zh: "极少", en: "Minimal" } },
						{ value: "low", label: { zh: "低", en: "Low" } },
						{ value: "medium", label: { zh: "中", en: "Medium" } },
						{ value: "high", label: { zh: "高", en: "High" } },
					],
				},
				{
					key: "checkTimeoutMs",
					kind: "number",
					default: 90000,
					min: 5000,
					max: 600000,
					unit: ms,
					label: { zh: "判断最多等多久", en: "Max wait for the check" },
					help: {
						zh: "超时就退回判定器，再退回只看事实。",
						en: "If the check takes longer, the judge decides; if the judge can't, only the facts count.",
					},
				},
				{
					key: "stallLimit",
					kind: "number",
					default: 2,
					min: 1,
					max: 10,
					label: { zh: "连续几轮没进展就停", en: "Runs without progress before pausing" },
					help: {
						zh: "判断者发现代理在重复自己、原地打转。第一次会让它换个思路，到这个次数就停下来问你。",
						en: "Runs where the check finds the agent repeating itself. The first time, the agent is told to change course; at this count, the goal pauses for you.",
					},
				},
				{
					key: "maxContinuations",
					kind: "number",
					default: 20,
					min: 1,
					max: 200,
					label: { zh: "最多自动续跑次数", en: "Max continuations" },
					help: { zh: "从你上一次发言算起。", en: "Counted from your last message." },
				},
				{
					key: "maxMinutes",
					kind: "number",
					default: 180,
					min: 5,
					max: 1440,
					unit: { zh: "分钟", en: "min" },
					label: { zh: "最长自动运行", en: "Longest automatic run" },
					help: { zh: "从你上一次发言算起。", en: "Counted from your last message." },
				},
				{
					key: "idleLimit",
					kind: "number",
					default: 2,
					min: 1,
					max: 10,
					label: { zh: "连续空转几次就停", en: "Idle runs before pausing" },
					help: {
						zh: "模型连续几次什么工具都没用就结束，说明它在原地打转。",
						en: "Runs in a row that ended without a single tool call: the agent is going nowhere.",
					},
				},
			],
		},
		{
			name: "board",
			title: { zh: "人话看板", en: "Plain-language board" },
			summary: {
				zh: "用大白话告诉你项目推进到哪、现在在干什么、有什么要你确认，并记一份流水：代理每做一步就记一行，它说的话、发现的事由会说人话的模型当场重讲，判定器决定什么值得讲；一轮做完再总结一遍，过程留在流水里。只给人看，不进模型的上下文。每个项目单独开关；第一次打开时选一个模型来讲，之后可以换。",
				en: "Tells you in plain words how far along the work is, what's happening now and what's waiting on you. It keeps a running account: a line for each step as it happens, plus what the agent says or finds, retold right away by a plain-speaking model, with the judge deciding what's worth telling. A finished run gets a summary, and the account is kept. For you only; never in the model's context. Turned on per project (/board on, /board off); the first time, you pick the model that writes it (/board model changes it).",
			},
			defaultEnabled: true,
			options: [
				{
					key: "defaultOn",
					kind: "boolean",
					default: false,
					label: { zh: "没单独设置过的项目也打开", en: "On in projects you haven't set it for" },
					help: {
						zh: "默认关闭：看板每更新一次就调用一次模型。",
						en: "Off by default: each board update costs a model call.",
					},
				},
				{
					key: "model",
					kind: "text",
					default: "",
					label: { zh: "写看板的模型", en: "Model that writes the board" },
					help: {
						zh: "写成「提供商/模型」，填了就不再问。留空：第一次打开看板时让你挑一个（推荐 Claude Opus 4.6，其次 Gemini 3.8 Flash），挑好的会记住。",
						en: "As provider/model; if set here, you won't be asked. Empty: you pick one the first time you turn the board on (Claude Opus 4.6 recommended, then Gemini 3.8 Flash), saved in mu/board.json. If none is picked: the writer model, else the current model.",
					},
				},
				{
					key: "language",
					kind: "choice",
					default: "auto",
					label: { zh: "看板的语言", en: "Board language" },
					choices: [
						{ value: "auto", label: { zh: "跟着你说的话", en: "The one you write in" } },
						{ value: "zh", label: { zh: "中文", en: "Chinese" } },
						{ value: "en", label: { zh: "英文", en: "English" } },
					],
				},
				{
					key: "everyTools",
					kind: "number",
					default: 5,
					min: 1,
					max: 100,
					label: { zh: "代理每做几步看一次", en: "Tool calls between checks" },
				},
				{
					key: "minIntervalMs",
					kind: "number",
					default: 20000,
					min: 0,
					max: 600000,
					unit: ms,
					label: { zh: "干活时两次查看至少隔多久", en: "Minimum time between checks while it works" },
					help: {
						zh: "代理停下时总会看一次，不受这个限制。",
						en: "When the agent stops, the board always checks, regardless of this setting.",
					},
				},
				{
					key: "maxSteps",
					kind: "number",
					default: 10,
					min: 3,
					max: 50,
					label: { zh: "每次读最近几步", en: "Latest tool calls read each time" },
				},
				{
					key: "narrateTimeoutMs",
					kind: "number",
					default: 60000,
					min: 5000,
					max: 300000,
					unit: ms,
					label: { zh: "写看板最多等多久", en: "Max wait for the writer" },
					help: {
						zh: "超时就用固定的句子说。",
						en: "After that, stock phrases are used.",
					},
				},
				{
					key: "unattended",
					kind: "boolean",
					default: false,
					label: { zh: "一次性运行里也写看板", en: "Also in one-shot runs" },
					help: {
						zh: "mu --print 和 json 模式里没人看看板，默认不写，省下判定器和写看板模型的调用。",
						en: "Nobody watches the board in mu --print or json mode, so by default it isn't written there, saving the judge and writer calls.",
					},
				},
				{
					key: "followAlways",
					kind: "boolean",
					default: false,
					label: { zh: "子代理干活时按时查看", en: "Check on subagents on a timer" },
					help: {
						zh: "默认只在有子代理开始、做完或出错时才查看；打开后不管有没有变化，每隔一段时间都看一次。",
						en: "By default the board checks only when a subagent starts, finishes or fails. On: it checks at every interval, changed or not.",
					},
				},
			],
		},
		{
			name: "completion",
			title: { zh: "完成核对", en: "Completion check" },
			summary: {
				zh: "「做完了」之前确认有没有验证过。",
				en: "Checks that something verified the work before it's called done.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "waitMs",
					kind: "number",
					default: 3000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
					help: {
						zh: "超时就不催了，这次判定也随之取消，不拖住单次运行的退出。",
						en: "After this, there's no nudge, and the judge call is cancelled so it doesn't hold up the end of a one-shot run.",
					},
				},
			],
		},
		{
			name: "continuation",
			title: { zh: "半路停下时接着做", en: "Continue after stopping short" },
			summary: {
				zh: "说了要做却停下的一轮，让它接着做。",
				en: "Sends the agent back to work when a run stops short of what it said it would do.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "maxNudges",
					kind: "number",
					default: 2,
					min: 1,
					max: 5,
					label: { zh: "每条消息最多催几次", en: "Max nudges per message" },
				},
				{
					key: "waitMs",
					kind: "number",
					default: 3000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
					help: {
						zh: "超时就不催了，这次判定也随之取消，不拖住单次运行的退出。",
						en: "After this, there's no nudge, and the judge call is cancelled so it doesn't hold up the end of a one-shot run.",
					},
				},
			],
		},
		{
			name: "notify",
			title: { zh: "通知分流", en: "Notification routing" },
			summary: { zh: "决定各类事件何时告诉模型。", en: "Decides when to tell the model about events." },
			defaultEnabled: true,
			options: [
				{
					key: "budgetThresholds",
					kind: "numbers",
					default: [70, 85],
					label: { zh: "上下文预算提醒（%）", en: "Context budget notices (%)" },
				},
				{
					key: "unjudged",
					kind: "choice",
					default: "now",
					choices: [
						{ value: "now", label: { zh: "立刻告知", en: "Now" } },
						{ value: "next_turn", label: { zh: "下一回合", en: "Next turn" } },
						{ value: "drop", label: { zh: "不说", en: "Never" } },
					],
					label: { zh: "没有判定时，上下文预算提醒", en: "Without a verdict, context budget notices" },
					help: {
						zh: "通知分流默认是影子模式，这时就按这里投递。「下一回合」要等下一次运行开始才读到，单次运行里读不到。",
						en: "Notification routing is in shadow by default, and then this decides. A next-turn notice is read only when another run starts, which never happens in a one-shot run.",
					},
				},
			],
		},
		{
			name: "warming",
			title: { zh: "缓存保温", en: "Cache warming" },
			summary: {
				zh: "在提示词缓存过期前视情况续一下。",
				en: "Refreshes the prompt cache before it expires, when that pays off.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "waitMs",
					kind: "number",
					default: 3000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
					help: {
						zh: "超时就按 pi 自己的算法决定，这次判定也随之取消。",
						en: "After this, pi's own estimate decides, and the judge call is cancelled.",
					},
				},
			],
		},
		{
			name: "warmup",
			title: { zh: "判定连接保温", en: "Judge connection warm-up" },
			summary: {
				zh: "会话在用时每隔一会儿问判定器一个小问题，让连接一直热着：一轮开始前的判定省下 1–3 秒的建连。",
				en: "While mu is in use, a tiny question keeps the judge's connection warm, so the questions before a turn skip 1–3 s of connection setup.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "intervalMs",
					kind: "number",
					default: 50000,
					min: 10000,
					max: 85000,
					unit: ms,
					label: { zh: "间隔", en: "Every" },
					help: {
						zh: "服务端空闲约 90 秒断开，间隔要短于它。",
						en: "The server drops connections idle for about 90 s; stay below that.",
					},
				},
				{
					key: "idleMs",
					kind: "number",
					default: 900000,
					min: 60000,
					max: 7200000,
					unit: ms,
					label: { zh: "多久没动静就停", en: "Stop after this much inactivity" },
				},
			],
		},
		{
			name: "swarm",
			title: { zh: "子代理", en: "Subagents" },
			summary: { zh: "把任务委派给按角色分工的子代理。", en: "Delegates tasks to subagents with roles." },
			defaultEnabled: true,
			options: [
				{
					key: "models",
					kind: "list",
					default: [],
					label: { zh: "模型梯队（从便宜到强）", en: "Model ladder (cheapest to strongest)" },
					help: {
						zh: "留空则子代理都用当前会话的模型。",
						en: "Empty means every subagent uses the main agent's model.",
					},
				},
				{
					key: "maxTasks",
					kind: "number",
					default: 6,
					min: 1,
					max: 32,
					label: { zh: "一次最多委派", en: "Max tasks per call" },
				},
				{
					key: "concurrency",
					kind: "number",
					default: 3,
					min: 1,
					max: 16,
					label: { zh: "同时运行", en: "Running at once" },
				},
				{ key: "defaultAgent", kind: "text", default: "worker", label: { zh: "默认角色", en: "Default role" } },
				{
					key: "agentsDir",
					kind: "text",
					default: "",
					label: { zh: "自定义角色目录", en: "Folder with your own roles" },
					help: { zh: "留空使用 <agent 目录>/agents。", en: "Empty uses <agent dir>/agents." },
				},
				{
					key: "isolation",
					kind: "choice",
					default: "worktree",
					choices: [
						{
							value: "worktree",
							label: { zh: "在独立的 git worktree 里改", en: "Edit in its own git worktree" },
						},
						{ value: "none", label: { zh: "直接在当前目录改", en: "Edit in place" } },
					],
					label: { zh: "会改文件的子代理", en: "Subagents that edit files" },
					help: {
						zh: "隔离时改动以补丁交回，由主代理用 apply_patch_from 决定是否应用；不在 git 仓库里时自动退回原地修改。",
						en: "Isolated changes come back as a patch, which the main agent may apply with apply_patch_from. Outside a git repository, subagents edit in place.",
					},
				},
				{
					key: "carryUncommitted",
					kind: "boolean",
					default: true,
					label: { zh: "带上未提交的改动", en: "Carry over uncommitted changes" },
					help: {
						zh: "子代理从主代理当前看到的文件状态开始，而不是从上一次提交开始。",
						en: "The subagent starts from the files as the main agent sees them, not from the last commit.",
					},
				},
				{
					key: "patchPreviewLines",
					kind: "number",
					default: 30,
					min: 0,
					max: 400,
					label: { zh: "补丁预览行数", en: "Lines of patch preview" },
					help: {
						zh: "随子代理报告一起给主代理看的补丁开头。",
						en: "The start of the patch, shown with the subagent's report.",
					},
				},
			],
		},
		{
			name: "hive",
			title: { zh: "蜂群", en: "Hive" },
			summary: {
				zh: "多只蜂并行攻一个难题，判定器把关它们之间传什么。输入 /hive <问题> 就能自己发起；遇到直接做不下去的难题，代理也会自己发起。",
				en: "Several bees work on one hard task in parallel, and the judge decides what passes between them. Start one yourself with /hive <question>; the agent also starts one when a problem resists a direct attempt.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "maxNotesPerBee",
					kind: "number",
					default: 12,
					min: 1,
					max: 100,
					label: { zh: "每只蜂最多发布", en: "Max notes per bee" },
				},
				{
					key: "maxDeliveriesPerBee",
					kind: "number",
					default: 10,
					min: 1,
					max: 100,
					label: { zh: "每只蜂最多收到", en: "Max deliveries per bee" },
				},
				{
					key: "checkpointEvery",
					kind: "number",
					default: 4,
					min: 0,
					max: 50,
					label: { zh: "沉默几次工具调用后询问进展", en: "Ask for findings after this many silent tool calls" },
					help: { zh: "0 表示不询问。", en: "0 turns this off." },
				},
				{
					key: "lastCall",
					kind: "boolean",
					default: true,
					label: { zh: "写报告时再听一次新消息", en: "Deliver findings once more while writing the report" },
				},
				{
					key: "maxRelatedPerNote",
					kind: "number",
					default: 2,
					min: 0,
					max: 30,
					label: { zh: "一条新发现最多对照几条旧发现", en: "Max earlier findings to compare a new one against" },
					help: {
						zh: "只对照有共同词的旧发现。0 表示不做纠正。",
						en: "Only those sharing words with it. 0 turns corrections off.",
					},
				},
				{
					key: "publishMarked",
					kind: "boolean",
					default: true,
					label: { zh: "带标记的发现直接发布", en: "Publish marked findings directly" },
					help: {
						zh: "蜂以 FOUND: 或 DEAD END: 开头说的话直接上公告板，不问判定器。",
						en: "What a bee says starting with FOUND: or DEAD END: goes on the board without asking the judge.",
					},
				},
				{
					key: "publishToolOutputs",
					kind: "boolean",
					default: false,
					label: { zh: "工具输出也拿去问要不要发布", en: "Consider tool output for the board too" },
					help: {
						zh: "默认只看蜂自己说的话。",
						en: "By default only what a bee says is considered.",
					},
				},
				{
					key: "verifyConflicts",
					kind: "number",
					default: 1,
					min: 0,
					max: 3,
					label: { zh: "为没解决的冲突最多加派几只验证蜂", en: "Max verifier bees for unsettled disputes" },
					help: { zh: "0 表示不加派，冲突两边都留在报告里。", en: "0 adds none; both sides stay in the report." },
				},
				{
					key: "verifyAfterSeconds",
					kind: "number",
					default: 60,
					min: 0,
					max: 600,
					label: {
						zh: "冲突挂多少秒没人解决才加派",
						en: "Seconds before a verifier joins an open dispute",
					},
				},
			],
		},
		{
			name: "locate",
			title: { zh: "文件定位", en: "File locator" },
			summary: { zh: "用描述找文件的 locate 工具。", en: "The locate tool: find files by description." },
			defaultEnabled: true,
			options: [
				{
					key: "candidates",
					kind: "number",
					default: 40,
					min: 5,
					max: 400,
					label: { zh: "送判的候选数", en: "Candidates judged" },
				},
				{
					key: "results",
					kind: "number",
					default: 12,
					min: 1,
					max: 100,
					label: { zh: "返回条数", en: "Results returned" },
				},
			],
		},
		{
			name: "judgeItems",
			title: { zh: "批量判定工具", en: "Bulk judging tool" },
			summary: {
				zh: "judge_items 工具：一个是非题，对很多条目逐条给出概率。",
				en: "The judge_items tool: one yes/no question, a probability for each of many items.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "maxItems",
					kind: "number",
					default: 500,
					min: 10,
					max: 5000,
					label: { zh: "一次最多几条", en: "Max items per call" },
				},
			],
		},
		{
			name: "browser",
			title: { zh: "内置浏览器", en: "Built-in browser" },
			summary: {
				zh: "判定器驱动的浏览器，用自己独立的配置目录，从不动你的浏览器。",
				en: "A judge-driven browser with its own profile; it never touches yours.",
			},
			defaultEnabled: true,
			options: [
				{ key: "headless", kind: "boolean", default: true, label: { zh: "无界面运行", en: "Run headless" } },
				{
					key: "maxSteps",
					kind: "number",
					default: 40,
					min: 1,
					max: 200,
					label: { zh: "每次最多步数", en: "Max steps per run" },
				},
				{
					key: "textChars",
					kind: "number",
					default: 4000,
					min: 500,
					max: 50000,
					unit: chars,
					label: { zh: "每步读取的页面文字", en: "Page text read per step" },
				},
				{
					key: "embedded",
					kind: "boolean",
					default: true,
					label: {
						zh: "桌面端运行时使用应用内的浏览器面板",
						en: "Use the desktop app's browser panel when it's running",
					},
					help: {
						zh: "这样每一步都看得见，可以随时暂停、停止或接管；应用没开时用 mu 自己的浏览器。",
						en: "Every step is then visible and can be paused, stopped or taken over; without the app, mu uses its own browser.",
					},
				},
				{
					key: "profileDir",
					kind: "text",
					default: "",
					label: { zh: "浏览器配置目录", en: "Browser profile folder" },
					help: { zh: "留空使用 mu 自己的目录。", en: "Empty uses mu's own folder." },
				},
			],
		},
		{
			name: "background",
			title: { zh: "后台命令", en: "Background commands" },
			summary: {
				zh: "开发服务器、长时间构建放到后台跑，不占用回合；任务结束时立刻告诉代理；会话结束时全部终止，无人值守的单次运行除外。",
				en: "bg_start / bg_output / bg_stop: run dev servers and long builds without blocking the turn. The agent hears of a finished job right away; every job stops when the session ends, except in an unattended one-shot run.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "maxJobs",
					kind: "number",
					default: 8,
					min: 1,
					max: 32,
					label: { zh: "同时运行的任务上限", en: "Jobs running at the same time" },
				},
				{
					key: "bufferChars",
					kind: "number",
					default: 262144,
					min: 10000,
					unit: chars,
					label: { zh: "每个任务留在内存里的输出", en: "Output kept in memory per job" },
					help: {
						zh: "只留最新的；完整输出在日志文件里。",
						en: "The newest output is kept; the log file has everything.",
					},
				},
				{
					key: "maxOutputChars",
					kind: "number",
					default: 20000,
					min: 1000,
					unit: chars,
					label: { zh: "bg_output 单次返回上限", en: "Max output per bg_output call" },
				},
				{
					key: "killGraceMs",
					kind: "number",
					default: 3000,
					min: 0,
					unit: ms,
					label: { zh: "强制终止前的等待", en: "Wait before force-killing a job" },
					help: {
						zh: "先发 SIGTERM（Windows 上是不带 /F 的 taskkill），超时后强制。",
						en: "SIGTERM first (taskkill without /F on Windows), then force after this long.",
					},
				},
				{
					key: "logDir",
					kind: "text",
					default: "",
					label: { zh: "日志目录", en: "Log directory" },
					help: {
						zh: "留空为 ~/.mu/jobs/<会话 id>，7 天后清理。",
						en: "Empty means ~/.mu/jobs/<session id>, cleared after 7 days.",
					},
				},
				{
					key: "inheritShell",
					kind: "boolean",
					default: true,
					label: { zh: "沿用前台 shell 设置", en: "Use the foreground shell settings" },
					help: {
						zh: "和 bash 工具用同一套 shell 设置。",
						en: "Reads shellPath and shellCommandPrefix from settings.json, like the bash tool.",
					},
				},
				{
					key: "wakeWhenIdle",
					kind: "boolean",
					default: false,
					label: { zh: "空闲时任务结束可唤醒代理", en: "A finished job may wake an idle agent" },
					help: {
						zh: "只有「立刻」告知的才会开始新回合；关闭时只留一条消息。",
						en: 'Only a notice delivered "now" starts a turn; when off, the notice is only appended.',
					},
				},
				{
					key: "unjudged",
					kind: "choice",
					default: "now",
					choices: [
						{ value: "now", label: { zh: "立刻告知", en: "Now" } },
						{ value: "next_turn", label: { zh: "下一回合", en: "Next turn" } },
						{ value: "drop", label: { zh: "不说", en: "Never" } },
					],
					label: { zh: "没有判定时，任务结束或匹配行", en: "Without a verdict, a job's end or watched line" },
					help: {
						zh: "通知分流默认是影子模式，这时就按这里投递。「下一回合」要等下一次运行开始才读到，单次运行里读不到。",
						en: "Notification routing is in shadow by default, and then this decides. A next-turn notice is read only when another run starts, which never happens in a one-shot run.",
					},
				},
				{
					key: "keepOnExit",
					kind: "choice",
					default: "headless",
					choices: [
						{ value: "headless", label: { zh: "无人值守运行时保留", en: "Keep in unattended runs" } },
						{ value: "always", label: { zh: "总是保留", en: "Always keep" } },
						{ value: "never", label: { zh: "总是终止", en: "Always stop" } },
					],
					label: { zh: "会话结束时仍在运行的任务", en: "Jobs still running when the session ends" },
					help: {
						zh: "无人值守指 mu --print 和 json 模式的单次运行：任务要求的服务在运行结束后还得在。",
						en: "Unattended means a one-shot mu --print or json run, where a service the task asked for must still be up after the run.",
					},
				},
			],
		},
		{
			name: "web",
			title: { zh: "网页读取与搜索", en: "Web reading and search" },
			summary: {
				zh: "把网页读成文字（限时限量，拒绝内网地址，页面文字标为不可信）；网页搜索用国内不需要密钥就能访问的搜索源。",
				en: "web_fetch reads a page as text (with time and size limits, internal addresses refused and page text labeled untrusted); web_search uses a source that works from mainland China without a key.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "search",
					kind: "text",
					default: "so",
					label: { zh: "搜索源", en: "Search source" },
					help: {
						zh: "so（360）、sogou、bing-cn、searxng:<地址>，或带 {query} 的网址。",
						en: "so (360), sogou, bing-cn, searxng:<base url>, or a URL with {query} in it.",
					},
				},
				{
					key: "searchFallback",
					kind: "boolean",
					default: true,
					label: { zh: "失败时换用其他内置源", en: "Try the other built-in sources on failure" },
					help: {
						zh: "遇到验证页、没有结果或结果与查询无关时生效。",
						en: "Applies when a source returns a verification page, no results, or results unrelated to the query.",
					},
				},
				{
					key: "maxChars",
					kind: "number",
					default: 20000,
					min: 500,
					unit: chars,
					label: { zh: "一次读取网页最多返回", en: "Max text per web_fetch call" },
				},
				{
					key: "timeoutMs",
					kind: "number",
					default: 20000,
					min: 1000,
					unit: ms,
					label: { zh: "单次请求时限", en: "Time limit per request" },
				},
				{
					key: "maxBytes",
					kind: "number",
					default: 2000000,
					min: 10000,
					unit: { zh: "字节", en: "bytes" },
					label: { zh: "下载上限", en: "Download limit" },
				},
				{
					key: "maxRedirects",
					kind: "number",
					default: 5,
					min: 0,
					max: 20,
					label: { zh: "最多跟随的重定向", en: "Redirects followed" },
				},
				{
					key: "allowLoopback",
					kind: "boolean",
					default: true,
					label: { zh: "允许读取本机开发服务器", en: "Allow this machine's dev servers" },
					help: {
						zh: "仅当网址直接写 localhost 或 127.0.0.1 时；从外部网页重定向过来的一律拒绝。",
						en: "Only when the URL itself names localhost or 127.0.0.1; a redirect from the web is always refused.",
					},
				},
				{
					key: "allowPrivate",
					kind: "boolean",
					default: false,
					label: { zh: "允许内网地址", en: "Allow private network addresses" },
					help: {
						zh: "10/8、172.16/12、192.168/16、链路本地等。默认拒绝，防止网页诱导读取内网。",
						en: "10/8, 172.16/12, 192.168/16, link-local and similar. Refused by default so a page can't steer the reader into your local network.",
					},
				},
			],
		},
		{
			name: "welcome",
			title: { zh: "欢迎页", en: "Welcome screen" },
			summary: {
				zh: "终端里的欢迎框和身份说明。",
				en: "The terminal's welcome screen and the identity note for the model.",
			},
			defaultEnabled: true,
			options: [],
		},
		{
			name: "inherit",
			title: { zh: "沿用已有配置", en: "Inherit existing setup" },
			summary: {
				zh: "首次运行就沿用你给 Claude Code、Cursor、Codex 配好的规则、技能和 MCP 服务器，只读不写。常驻规则进提示词；按文件匹配的规则只在碰到匹配文件时随工具结果交给模型一次；其余规则只列描述。项目里的内容只在项目受信任时才用。",
				en: "Uses the rules, skills and MCP servers you've already set up for Claude Code, Cursor and Codex, read-only. Always-on rules join the prompt; a rule scoped to file patterns is passed along once, with the result of the first tool that touches a matching file; the rest are listed by description. Project content is used only in trusted projects.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "claude",
					kind: "boolean",
					default: true,
					label: { zh: "来自 Claude Code", en: "From Claude Code" },
				},
				{ key: "cursor", kind: "boolean", default: true, label: { zh: "来自 Cursor", en: "From Cursor" } },
				{ key: "codex", kind: "boolean", default: true, label: { zh: "来自 Codex", en: "From Codex" } },
				{ key: "rules", kind: "boolean", default: true, label: { zh: "沿用规则", en: "Inherit rules" } },
				{ key: "skills", kind: "boolean", default: true, label: { zh: "沿用技能", en: "Inherit skills" } },
				{
					key: "mcp",
					kind: "boolean",
					default: true,
					label: { zh: "沿用 MCP 服务器", en: "Inherit MCP servers" },
					help: {
						zh: "关掉后只用你自己在设置文件里定义的服务器。",
						en: "When off, only the servers under mcp.servers in mu.json are used.",
					},
				},
				{
					key: "maxRuleChars",
					kind: "number",
					default: 4000,
					min: 500,
					max: 20000,
					unit: chars,
					label: { zh: "单条按文件规则最多交给模型", en: "Max size of a file-scoped rule passed along" },
					help: {
						zh: "超出的部分留在文件里，模型可以自己去读。",
						en: "The rest stays in the file for the model to read.",
					},
				},
				{
					key: "maxAlwaysChars",
					kind: "number",
					default: 16000,
					min: 0,
					max: 100000,
					unit: chars,
					label: { zh: "常驻规则总量上限", en: "Budget for always-on rules" },
					help: {
						zh: "放不下的常驻规则改为只列描述，避免提示词被规则撑大。",
						en: "Always-on rules that don't fit are listed by description instead, so they can't bloat the prompt.",
					},
				},
			],
		},
		{
			name: "mcp",
			title: { zh: "MCP 服务器", en: "MCP servers" },
			summary: {
				zh: "MCP 服务器由 pi 自带的客户端连接（stdio 与 Streamable HTTP，支持 OAuth 登录，用 /mcp 管理）。从 Claude Code、Cursor、Codex 和 mu.json 沿用的服务器，每个是能力目录里的一项，默认隐藏：判定器认定任务需要，或模型主动申请，才启动它并把工具交给模型。工具清单会缓存，服务器没跑过，判定器也有描述可判。项目里定义的服务器第一次启动前要你点头，定义变了会再问。在 mu.json 里可以把某个服务器设为常开。用 mu mcp add 加的服务器归 pi 管：随会话连接，工具由 tool_search 按需加载。",
				en: 'MCP servers connect through pi\'s own client (stdio and Streamable HTTP, OAuth sign-in, managed with /mcp). Each server mu inherits from Claude Code, Cursor, Codex or mu.json is a hidden catalog entry: it starts, and its tools reach the model, only when the judge finds the task needs it or the model asks through find_capability. Tool lists are cached, so the judge has a description even before a server has run. A server defined by a project asks before its first start, and again when its definition changes. "exposure": "always" under mcp.servers in mu.json keeps a server open. Servers added with mu mcp add belong to pi: they connect with the session, and tool_search loads their tools when needed.',
			},
			defaultEnabled: true,
			options: [
				{
					key: "startTimeoutMs",
					kind: "number",
					default: 45000,
					min: 1000,
					max: 300000,
					unit: ms,
					label: { zh: "启动最多等待", en: "Start timeout" },
					help: { zh: "npx 一类的服务器第一次要先下载自己。", en: "An npx-style server downloads itself first." },
				},
				{
					key: "requestTimeoutMs",
					kind: "number",
					default: 120000,
					min: 1000,
					max: 3600000,
					unit: ms,
					label: { zh: "单次调用最多等待", en: "Call timeout" },
				},
			],
		},
		{
			name: "packs",
			title: { zh: "能力包", en: "Capability packs" },
			summary: {
				zh: "随 mu 装好、默认不露的工具包，任务需要时才打开；缺外部程序时给出安装提示。",
				en: "Tool packs that ship with mu and stay hidden until a task needs them; if a required program is missing, mu shows how to install it.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "astGrep",
					kind: "boolean",
					default: true,
					label: { zh: "ast-grep 结构化搜索与改写", en: "ast-grep structural search and rewrite" },
					help: {
						zh: "按语法而不是按文字找代码、改代码。需要本机装有 ast-grep。",
						en: "Finds and changes code by syntax, not text. Requires ast-grep on this machine.",
					},
				},
				{
					key: "maxResults",
					kind: "number",
					default: 50,
					min: 1,
					max: 500,
					label: { zh: "一次搜索最多返回", en: "Max matches per search" },
				},
				{
					key: "maxDiffChars",
					kind: "number",
					default: 12000,
					min: 1000,
					max: 200000,
					unit: chars,
					label: { zh: "单个结果最多带多少 diff", en: "Max diff per result" },
				},
				{
					key: "astGrepCommand",
					kind: "text",
					default: "",
					label: { zh: "ast-grep 的路径", en: "ast-grep path" },
					help: {
						zh: "留空则依次在 PATH 里找 ast-grep 和 sg。",
						en: "Empty: ast-grep, then sg, from PATH.",
					},
				},
				{
					key: "github",
					kind: "boolean",
					default: true,
					label: { zh: "GitHub（通过 gh）", en: "GitHub through gh" },
					help: {
						zh: "不加工具，只带一个教模型用 gh 处理 PR、issue、检查和发布的技能。需要本机装有 gh。",
						en: "No tools; a skill that teaches gh for PRs, issues, checks and releases. Requires gh on this machine.",
					},
				},
				{
					key: "ghCommand",
					kind: "text",
					default: "",
					label: { zh: "gh 的路径", en: "gh path" },
					help: { zh: "留空则在 PATH 里找 gh。", en: "Empty: gh from PATH." },
				},
				{
					key: "commit",
					kind: "boolean",
					default: true,
					label: { zh: "/commit：把改动拆成多个提交", en: "/commit: split changes into commits" },
					help: {
						zh: "模型提议怎么分组、怎么写提交说明，你看过计划并确认后才提交；要么全部提交成功，要么一个都不留。从不推送。",
						en: "A model proposes the groups and messages; commits are made only after you confirm the plan, all or none. Never pushes.",
					},
				},
				{
					key: "maxPlanChars",
					kind: "number",
					default: 60000,
					min: 5000,
					max: 400000,
					label: { zh: "提议拆分时模型最多读多少字符的改动", en: "Characters of the change the model reads" },
				},
				{
					key: "review",
					kind: "boolean",
					default: true,
					label: { zh: "评审并按严重程度分级", en: "/review, with findings ranked P0 to P3" },
				},
				{
					key: "conflicts",
					kind: "boolean",
					default: true,
					label: { zh: "冲突解决", en: "Conflict resolution" },
					help: {
						zh: "合并、变基、拣选停在冲突上时，逐个文件显示双方和共同基线，按块写入解决结果并标记为已解决。从不提交，也不执行 --continue。",
						en: "When a merge, rebase or cherry-pick stops on conflicts, shows both sides and their base for each file, writes the resolution block by block and marks the file resolved. Never commits and never runs --continue.",
					},
				},
				{
					key: "maxSideLines",
					kind: "number",
					default: 80,
					min: 10,
					max: 1000,
					label: { zh: "每块冲突每一侧最多显示几行", en: "Lines shown per side of a conflict block" },
				},
				{
					key: "maxConflictChars",
					kind: "number",
					default: 20000,
					min: 2000,
					max: 200000,
					label: { zh: "一个文件的冲突最多显示多少字符", en: "Max characters of conflicts shown per file" },
				},
				{
					key: "maxFindings",
					kind: "number",
					default: 40,
					min: 5,
					max: 200,
					label: { zh: "一次最多分级多少条发现", en: "Max findings ranked per triage" },
					help: {
						zh: "超出的照样报告，只是不参与分级。",
						en: "The rest are still reported, just not ranked.",
					},
				},
				{
					key: "debugger",
					kind: "boolean",
					default: true,
					label: { zh: "调试器（断点、单步、变量）", en: "Debugger: breakpoints, stepping, variables" },
					help: {
						zh: "在调试器里运行程序，停在断点或未捕获的异常处，看调用栈和变量。Python 用 debugpy，Go 用 delve，编译型程序用 lldb-dap，都要本机已装；也可以在设置文件里加自己的。一次只跑一个，随会话结束。",
						en: "Runs a program under a debugger and stops at breakpoints or uncaught exceptions, showing the call stack and variables. Uses debugpy for Python, delve for Go and lldb-dap for compiled programs, if installed; add your own under debugAdapters in mu.json. One run at a time; it ends with the session.",
					},
				},
				{
					key: "maxFrames",
					kind: "number",
					default: 20,
					min: 1,
					max: 200,
					label: { zh: "停下时显示几层调用栈", en: "Frames shown at a stop" },
				},
				{
					key: "maxVariables",
					kind: "number",
					default: 50,
					min: 5,
					max: 1000,
					label: { zh: "每个作用域最多列几个变量", en: "Variables listed per scope" },
				},
				{
					key: "debugOutputChars",
					kind: "number",
					default: 4000,
					min: 500,
					max: 100000,
					unit: chars,
					label: { zh: "一次结果最多带多少程序输出", en: "Max program output per result" },
					help: { zh: "超出时只留最后的部分。", en: "When there's more, only the end is kept." },
				},
				{
					key: "debugWaitMs",
					kind: "number",
					default: 30000,
					min: 1000,
					max: 600000,
					unit: ms,
					label: { zh: "等程序停下的最长时间", en: "Max wait for the program to stop" },
					help: {
						zh: "到时还没停下也没结束，就告诉模型程序还在跑；它可以暂停看看停在哪，或者接着等。",
						en: "If it hasn't stopped or exited by then, the model is told it's still running, and can pause it to see where it is, or keep waiting.",
					},
				},
			],
		},
		{
			name: "googleLogin",
			title: { zh: "用 Google 账号登录（实验）", en: "Sign in with Google (experimental)" },
			summary: {
				zh: "在 /login 里多出两项：借 Gemini CLI 的登录用 Gemini 模型，借 Antigravity 的登录用 Gemini、Claude 和 GPT-OSS。这是 Google 给自家工具的登录，别的程序用它可能违反 Google 的条款、被限制或封号，所以登录前会先说明风险，你同意才继续。官方的方式不需要这一项：Gemini API key（提供商 google）和 Vertex AI（提供商 google-vertex，用 gcloud 登录）。",
				en: "Adds two entries to /login: Gemini CLI's sign-in for the Gemini models, and Antigravity's for Gemini, Claude and GPT-OSS. These are Google's sign-ins for its own tools; using them from another program may violate Google's terms and get the account limited or suspended, so mu explains the risk first and continues only if you agree. The official routes need none of this: a Gemini API key (provider google) or Vertex AI (provider google-vertex, signed in with gcloud).",
			},
			defaultEnabled: true,
			beta: true,
			options: [
				{
					key: "geminiCli",
					kind: "boolean",
					default: true,
					label: { zh: "Gemini CLI 登录", en: "Gemini CLI sign-in" },
					help: {
						zh: "Gemini 模型；个人账号走免费额度，有 Code Assist 许可的走许可。",
						en: "The Gemini models, on the free tier for a personal account or with a Code Assist license.",
					},
				},
				{
					key: "antigravity",
					kind: "boolean",
					default: true,
					label: { zh: "Antigravity 登录", en: "Antigravity sign-in" },
					help: {
						zh: "Gemini、Claude 和 GPT-OSS；登录后按账号实际能用的模型更新列表。",
						en: "Gemini, Claude and GPT-OSS; once you're signed in, the list shows what the account can use.",
					},
				},
			],
		},
	],
};

export const MANIFEST: HarnessManifest = {
	...DESCRIBED,
	decisions: DESCRIBED.decisions.map((decision) => {
		const mode = DEFAULT_CONFIG.modes[decision.id];
		return mode ? { ...decision, defaultMode: mode } : decision;
	}),
};
