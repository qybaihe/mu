/**
 * mu's slash commands, by name, with the words mu-agent gives each one in English and in Chinese (pi's
 * `get_commands`, with MU_LANG en or zh), then any earlier English wording an older mu may still send. `llama` and
 * `mcp` are pi's own commands, in English only. `clear` and `new` are not in the menu (`process/agent/kyrn/commands.ts`).
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
      'Show the task frame: the goal, your constraints with their source, the current subgoal and the acceptance criteria',
      '任务帧：目标、你的硬约束（原话加出处）、当前子目标、验收条件',
      'The task frame: goal, your constraints (with where you stated them), current subgoal and acceptance criteria',
      'The task frame: goal, your hard constraints and where you said them, subgoal, acceptance items',
    ],
  ],
  [
    'remember',
    [
      'Save a lesson for later work in this project: /remember <what to do>',
      '给这个项目记一条经验，以后的会话都会用上：/remember <该怎么做>',
      'Save a lesson for future sessions in this project: /remember <what to do>',
      'Store a lesson for future sessions in this project: /remember <what to do>',
    ],
  ],
  [
    'lessons',
    [
      "List this project's lessons (id · kind · recalled/followed · lesson); /lessons all adds global and retired lessons",
      '这个项目的经验：/lessons 列出 id · 类型 · 召回/照做次数 · 经验，/lessons all 连到处适用的和已退役的一起列',
      "This project's lessons: /lessons lists id · kind · recalled/followed · lesson; /lessons all adds global and retired lessons",
      "This project's lessons: /lessons lists id · kind · recalled/followed · lesson, /lessons all adds the ones for everywhere and the retired ones",
    ],
  ],
  [
    'forget',
    [
      "Retire a lesson so it's no longer recalled: /forget <id prefix> (find IDs with /lessons)",
      '让一条经验退役，以后不再召回：/forget <id 前几位>（id 见 /lessons）',
      'Retire a lesson so it is no longer recalled: /forget <id prefix> (the ids are in /lessons)',
    ],
  ],
  [
    'capabilities',
    [
      "Show what's installed and what's turned on; /capabilities open <id> turns one on",
      '装了哪些能力、这次打开了哪些：/capabilities 查看，/capabilities open <ID> 打开',
      "What's installed and what's turned on: /capabilities lists them, /capabilities open <id> turns one on",
      'What is installed and what is open: /capabilities, /capabilities open <id>',
    ],
  ],
  [
    'permissions',
    [
      "Set how much mu can do without asking: /permissions full | jev | ask (no argument opens a picker); /permissions reset clears what you've allowed so far",
      'mu 不问你就能做多少事：/permissions full（完全访问）| jev（Jev 审批）| ask（最小权限），不带参数就弹出选择；/permissions reset 忘掉这次对话里允许过的操作',
      'How much mu can do without asking: /permissions full | jev | ask, or no argument for a picker. /permissions reset clears what you allowed for this conversation',
      'Set how much mu can do without asking: /permissions full | jev | ask (no argument opens a picker); /permissions reset clears what you allowed in this session',
      'How much mu may do without asking: /permissions full | jev | ask, or a picker. /permissions reset forgets what you allowed for this conversation',
    ],
  ],
  [
    'lsp',
    [
      "Show the language servers: what's installed, what's running and the last error",
      '语言服务器：装了哪些、哪些在运行、最近一次出错',
      "Language servers: what's installed, what's running and the last error",
      'Language servers: which are installed, which are running, and the last error',
    ],
  ],
  [
    'goal',
    [
      'Keep the agent working until a condition holds: /goal <condition> sets it, /goal shows it (or asks for one), /goal clear ends it',
      '目标模式：让代理一直干到某个条件成立。/goal <条件> 设定，/goal 查看（没有时会问你），/goal clear 结束',
      'Goal mode: keep the agent working until a condition holds. /goal <condition>, /goal (show, or ask for one), /goal clear',
    ],
  ],
  [
    'board',
    [
      'Show the plain-language board; /board on|off turns it on or off for this project, /board model picks the model that writes it',
      '人话看板：/board 查看，/board on、/board off 为这个项目打开或关闭，/board model 换个模型来讲',
      'The plain-language board: /board shows it, /board on or /board off for this project, /board model picks the model that writes it',
      'The plain-language board: /board (show it), /board on, /board off (for this project), /board model (who writes it)',
    ],
  ],
  [
    'checkpoints',
    [
      'List the checkpoints so far: turn, time and the files changed since each',
      '这次对话的检查点：第几回合、什么时间、之后改了哪些文件',
      "List this session's checkpoints: turn, time and files changed since",
      'The checkpoints of this conversation: turn, time, files changed since',
    ],
  ],
  [
    'rewind',
    [
      'Go back to a checkpoint: /rewind [#] [both|files|conversation]; /rewind undo reverses the last rewind',
      '回到一个检查点：/rewind [序号] [both|files|conversation]，/rewind undo 撤销回退；both 文件和对话都退，files 只退文件，conversation 只退对话',
      'Go back to a checkpoint: /rewind [#] [both|files|conversation], /rewind undo',
    ],
  ],
  [
    'swarm',
    [
      'Show what each subagent is doing; /swarm stop [name] asks it to report now, /swarm kill [name] stops it immediately',
      '正在干活的子代理：/swarm 看每个在做什么，/swarm stop [名字] 让它现在交报告，/swarm kill [名字] 立刻结束它',
      'Subagents at work: /swarm shows what each is doing, /swarm stop [name] asks it to report now, /swarm kill [name] stops it immediately',
      'Sub-agents at work: /swarm (what each one is doing), /swarm stop [name] (report now), /swarm kill [name]',
    ],
  ],
  [
    'agents',
    [
      'List the subagent roles the delegate tool can use, and where to add your own',
      '列出 delegate 工具能用的子代理角色，以及在哪里加你自己的',
      'List the sub-agent roles the delegate tool can use, and where to add your own',
    ],
  ],
  [
    'hive',
    [
      'Have several investigators work on one question at once: /hive <question>. With no question, it works like /swarm',
      '让几个调查员同时查一个问题：/hive <问题>；不带问题时同 /swarm，看正在干活的子代理',
      'Have several investigators work on one question at once: /hive <question>. Without a question, same as /swarm',
      'Put several investigators on one question at once: /hive <question>. Without one, the same as /swarm',
    ],
  ],
  [
    'browse',
    [
      'Have the built-in browser open a page and do what you ask: /browse <url> [goal]',
      '让内置浏览器打开网址，照你说的去做：/browse <网址> [要做的事]',
      'Drive the built-in browser yourself: /browse <url> [goal]',
    ],
  ],
  [
    'inherit',
    [
      'Show what mu inherited from Claude Code, Cursor and Codex, and from which files',
      'mu 从 Claude Code、Cursor 和 Codex 沿用了什么，各来自哪个文件',
      'What mu inherited from Claude Code, Cursor and Codex, and from which files',
      'What mu took over from Claude Code, Cursor and Codex, and from where',
    ],
  ],
  // pi's own command since mu took pi's MCP client (2026-10-05), in English only.
  ['mcp', ['Manage MCP servers: sign in, reconnect, enable or disable, and change exposure']],
  [
    'jobs',
    [
      'List background jobs; /jobs stop <id|all> stops them',
      '后台命令：/jobs 查看，/jobs stop <编号|all> 停掉',
      'Background jobs: /jobs lists them, /jobs stop <id|all> stops them',
      'Background jobs: /jobs, /jobs stop <id|all>',
    ],
  ],
  [
    'commit',
    [
      'Split uncommitted changes into commits: shows the plan, commits only when you approve and never pushes',
      '把还没提交的改动拆成几个提交：先给你看计划，你同意才提交，从不推送',
      'Split uncommitted changes into commits: shows the plan, commits only when you approve, and never pushes',
      'Split the uncommitted change into commits: shows the plan, commits only when you say yes, never pushes',
    ],
  ],
  [
    'review',
    [
      'Have the reviewer subagent review uncommitted changes, or whatever you name; the judge ranks findings from P0 to P3',
      '让评审子代理审查还没提交的改动（或你指定的内容），评审发现按轻重排成 P0 到 P3',
      'Review the uncommitted change, or what you name, with the reviewer sub-agent; findings sorted P0 to P3',
    ],
  ],
  [
    'mu',
    [
      "Show mu's status. Also: /mu judge <judges> | /mu route <point> <judge|default> | /mu mode <point|default> <off|shadow|active>",
      'mu 的状态。另外：/mu judge <判定器> | /mu route <判定点> <判定器|default> | /mu mode <判定点|default> <off|shadow|active>',
      "Show mu's status. Also: /mu judge <tiers> | /mu route <decision> <tiers|default> | /mu mode <decision|default> <off|shadow|active>",
      'mu status. Also: /mu judge <tiers> | /mu route <decision> <tiers|default> | /mu mode <decision|default> <off|shadow|active>',
    ],
  ],
  [
    'status',
    [
      "Show the model, the judge, each decision point's mode, context savings and recent verdicts",
      '模型、判定器、各判定点的模式、省下的上下文和最近的判定',
      'Model, judge, decision point modes, context savings and recent verdicts',
      'Model, judge, decision modes, context savings and the latest verdicts',
    ],
  ],
  [
    'help',
    [
      'Show what mu can do and the commands worth knowing',
      'mu 能做什么，以及常用命令一览',
      'What mu can do, and the commands worth knowing',
      'What mu can do and every command worth knowing',
    ],
  ],
  [
    'ledger',
    [
      'Show the last n verdicts and their latency: /ledger [n]',
      '判定器最近的判定和用时：/ledger [条数]',
      'Recent verdicts, with timing: /ledger [n]',
      'The last verdicts of the judge with timing: /ledger [n]',
    ],
  ],
  [
    'doctor',
    [
      'Check that the judge, model, browser and subagents are set up',
      '检查判定器、模型、浏览器和子代理有没有接好',
      'Check that the judge, the model, the browser and the sub-agents are wired up',
    ],
  ],
  [
    'import-chat',
    [
      'Import a Claude Code or Codex conversation from this project and continue it here: /import-chat [file]',
      '导入这个项目在 Claude Code 或 Codex 里的对话，接着在这里聊：/import-chat [文件]',
      'Bring a Claude Code or Codex conversation of this project into mu and continue it: /import-chat [file]',
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
