/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * mu's slash commands, by name, with the words mu-agent gives each one in English and in Chinese (pi's
 * `get_commands`, with MU_LANG en or zh). `llama` and `mcp` are pi's own commands, in English only. `clear` and `new` are not in
 * the menu (`process/agent/kyrn/commands.ts`).
 *
 * pi gives a command no code to translate by, and mu has wording in those two languages only: a reader of the app in
 * any other language, or one who switched it after mu started, would read mu's English or Chinese. So the app knows
 * mu's own commands by their name and words, and shows its own line (`mu.commands.<name>`) in the reader's language.
 * Anything else keeps its words: another agent's command of the same name (Claude Code has a /review too), a prompt
 * template or a skill, or a description mu has since reworded.
 */
export const MU_COMMAND_WORDS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'frame',
    [
      'The task frame: goal, your hard constraints and where you said them, subgoal, acceptance items',
      '任务帧：目标、你的硬约束（原话加出处）、当前子目标、验收条件',
    ],
  ],
  [
    'remember',
    [
      'Store a lesson for future sessions in this project: /remember <what to do>',
      '给这个项目记一条经验，以后的会话都会用上：/remember <该怎么做>',
    ],
  ],
  [
    'lessons',
    [
      "This project's lessons: /lessons lists id · kind · recalled/followed · lesson, /lessons all adds the ones for everywhere and the retired ones",
      '这个项目的经验：/lessons 列出 id · 类型 · 召回/照做次数 · 经验，/lessons all 连到处适用的和已退役的一起列',
    ],
  ],
  [
    'forget',
    [
      'Retire a lesson so it is no longer recalled: /forget <id prefix> (the ids are in /lessons)',
      '让一条经验退役，以后不再召回：/forget <id 前几位>（id 见 /lessons）',
    ],
  ],
  [
    'capabilities',
    [
      'What is installed and what is open: /capabilities, /capabilities open <id>',
      '装了哪些能力、这次打开了哪些：/capabilities 查看，/capabilities open <ID> 打开',
    ],
  ],
  [
    'permissions',
    [
      'How much mu may do without asking: /permissions full | jev | ask, or a picker. /permissions reset forgets what you allowed for this conversation',
      'mu 不问你就能做多少事：/permissions full（完全访问）| jev（Jev 审批）| ask（最小权限），不带参数就弹出选择；/permissions reset 忘掉这次对话里允许过的操作',
    ],
  ],
  [
    'lsp',
    [
      'Language servers: which are installed, which are running, and the last error',
      '语言服务器：装了哪些、哪些在运行、最近一次出错',
    ],
  ],
  [
    'goal',
    [
      'Goal mode: keep the agent working until a condition holds. /goal <condition>, /goal (show, or ask for one), /goal clear',
      '目标模式：让代理一直干到某个条件成立。/goal <条件> 设定，/goal 查看（没有时会问你），/goal clear 结束',
    ],
  ],
  [
    'board',
    [
      'The plain-language board: /board (show it), /board on, /board off (for this project), /board model (who writes it)',
      '人话看板：/board 查看，/board on、/board off 为这个项目打开或关闭，/board model 换个模型来讲',
    ],
  ],
  [
    'checkpoints',
    [
      'The checkpoints of this conversation: turn, time, files changed since',
      '这次对话的检查点：第几回合、什么时间、之后改了哪些文件',
    ],
  ],
  [
    'rewind',
    [
      'Go back to a checkpoint: /rewind [#] [both|files|conversation], /rewind undo',
      '回到一个检查点：/rewind [序号] [both|files|conversation]，/rewind undo 撤销回退；both 文件和对话都退，files 只退文件，conversation 只退对话',
    ],
  ],
  [
    'swarm',
    [
      'Sub-agents at work: /swarm (what each one is doing), /swarm stop [name] (report now), /swarm kill [name]',
      '正在干活的子代理：/swarm 看每个在做什么，/swarm stop [名字] 让它现在交报告，/swarm kill [名字] 立刻结束它',
    ],
  ],
  [
    'agents',
    [
      'List the sub-agent roles the delegate tool can use, and where to add your own',
      '列出 delegate 工具能用的子代理角色，以及在哪里加你自己的',
    ],
  ],
  [
    'hive',
    [
      'Put several investigators on one question at once: /hive <question>. Without one, the same as /swarm',
      '让几个调查员同时查一个问题：/hive <问题>；不带问题时同 /swarm，看正在干活的子代理',
    ],
  ],
  [
    'browse',
    [
      'Drive the built-in browser yourself: /browse <url> [goal]',
      '让内置浏览器打开网址，照你说的去做：/browse <网址> [要做的事]',
    ],
  ],
  [
    'inherit',
    [
      'What mu took over from Claude Code, Cursor and Codex, and from where',
      'mu 从 Claude Code、Cursor 和 Codex 沿用了什么，各来自哪个文件',
    ],
  ],
  // pi's own command since mu took pi's MCP client (2026-10-05), in English only.
  ['mcp', ['Manage MCP servers: sign in, reconnect, enable or disable, and change exposure']],
  ['jobs', ['Background jobs: /jobs, /jobs stop <id|all>', '后台命令：/jobs 查看，/jobs stop <编号|all> 停掉']],
  [
    'commit',
    [
      'Split the uncommitted change into commits: shows the plan, commits only when you say yes, never pushes',
      '把还没提交的改动拆成几个提交：先给你看计划，你同意才提交，从不推送',
    ],
  ],
  [
    'review',
    [
      'Review the uncommitted change, or what you name, with the reviewer sub-agent; findings sorted P0 to P3',
      '让评审子代理审查还没提交的改动（或你指定的内容），评审发现按轻重排成 P0 到 P3',
    ],
  ],
  [
    'mu',
    [
      'mu status. Also: /mu judge <tiers> | /mu route <decision> <tiers|default> | /mu mode <decision|default> <off|shadow|active>',
      'mu 的状态。另外：/mu judge <判定器> | /mu route <判定点> <判定器|default> | /mu mode <判定点|default> <off|shadow|active>',
    ],
  ],
  [
    'status',
    [
      'Model, judge, decision modes, context savings and the latest verdicts',
      '模型、判定器、各判定点的模式、省下的上下文和最近的判定',
    ],
  ],
  ['help', ['What mu can do and every command worth knowing', 'mu 能做什么，以及常用命令一览']],
  ['ledger', ['The last verdicts of the judge with timing: /ledger [n]', '判定器最近的判定和用时：/ledger [条数]']],
  [
    'doctor',
    [
      'Check that the judge, the model, the browser and the sub-agents are wired up',
      '检查判定器、模型、浏览器和子代理有没有接好',
    ],
  ],
  [
    'import-chat',
    [
      'Bring a Claude Code or Codex conversation of this project into mu and continue it: /import-chat [file]',
      '导入这个项目在 Claude Code 或 Codex 里的对话，接着在这里聊：/import-chat [文件]',
    ],
  ],
  ['llama', ['Manage llama.cpp router models']],
]);

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A slash command's description in the reader's language when it is one of mu's own, and as it came otherwise. */
export function commandDescription(
  command: { readonly name: string; readonly description: string },
  t: Translate
): string {
  return MU_COMMAND_WORDS.get(command.name)?.includes(command.description)
    ? t(`mu.commands.${command.name}`, { defaultValue: command.description })
    : command.description;
}
