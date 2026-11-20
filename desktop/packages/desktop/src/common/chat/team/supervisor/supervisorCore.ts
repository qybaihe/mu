/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The supervisor, pure: the built-in position that opens temporary teams. The
 * supervisor is not a file of the user's position library — the desktop ships
 * it — so this module builds the rules injected into its workspace
 * (`AGENTS.override.md`, same seam as a library position's gate), and owns the
 * TEAMS.md index format the workspace's `teams.cjs` script reads and writes:
 * one pipe-table row per team, ISO timestamps, and a per-team lifecycle — a
 * TTL of 1-365 days (7 by default) that a reuse (a `send`) refreshes, or a
 * `permanent` flag that never retires. The workspace also carries
 * `positions.cjs`, the read-only roster listing behind the supervisor's
 * new-project dedup gate. All IO lives in the service and the scripts.
 */
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { positionLabel } from '@/common/chat/team/positions/positionLibraryCore';

/** The supervisor's identity: the `extra.position` marker and the roster label key. */
export const SUPERVISOR_POSITION_NAME = 'supervisor';

/** The supervisor workspace's folder under the app data dir's `positions/`. */
export const SUPERVISOR_FOLDER = '_supervisor';

/** How long a team lives by default: created for this span, every reuse extends it to `now + TTL`. */
export const TEAM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a deleted team stays restorable: after the grace passes, the
 * reconcile deletes the backend team for real (its conversations follow the
 * backend's own DELETE semantics) and drops the index row.
 */
export const TEAM_DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** The lifecycle a team may carry, in whole days: at least one, at most a year. */
export const TEAM_TTL_MIN_DAYS = 1;
export const TEAM_TTL_MAX_DAYS = 365;
/** The TTL every row without one reads as: the format's 7-day origin. */
export const TEAM_TTL_DEFAULT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A day count as the index stores it: clamped into the allowed range, the default when unparsable. */
export const clampTeamTtlDays = (days: number): number =>
  Math.min(TEAM_TTL_MAX_DAYS, Math.max(TEAM_TTL_MIN_DAYS, Math.round(days))) || TEAM_TTL_DEFAULT_DAYS;

/** The epoch-ms expiry a `ttlDays` lifecycle reads as from `at`. */
export const expiryAfterTtl = (ttlDays: number, at: number): number => at + ttlDays * DAY_MS;

/** The team index file every workspace's `teams.cjs` maintains. */
export const TEAMS_FILE_NAME = 'TEAMS.md';

/**
 * The folder under `positions/` holding the ONE shared team index: every
 * workspace the app ships a `teams.cjs` into (the supervisor's and each
 * library position's) resolves the same TEAMS.md there, so supervisor and
 * positions see — and refresh — the same teams.
 */
export const SHARED_TEAMS_FOLDER = '_shared';

/** The maintenance script in the supervisor workspace; the service rewrites it on version change. */
export const TEAMS_SCRIPT_NAME = 'teams.cjs';

/** The read-only position-roster script in the supervisor workspace (the new-project dedup check). */
export const POSITIONS_SCRIPT_NAME = 'positions.cjs';

/** The read-only template-catalog script in the supervisor workspace (the new-position draft reference). */
export const TEMPLATES_SCRIPT_NAME = 'templates.cjs';

/** Marks the index file as app-managed; parse rejects a file without it. */
const TEAMS_FILE_MARKER = '<!-- mu-supervisor-teams v1 -->';

/** One temporary team of the index: the row `teams.cjs` appends and refreshes. */
export type SupervisorTeam = {
  /** The team's display name, unique among active teams. */
  name: string;
  /** The library positions the team was built from; slot names carry them. */
  positions: string[];
  /** Epoch ms of team creation. */
  createdAt: number;
  /** Epoch ms of the last reuse (the last `send`). */
  lastUsedAt: number;
  /** Epoch ms after which the team is retired and never matched. */
  expiresAt: number;
  /** The team's own lifecycle length in days; a reuse extends to `now + ttlDays`. */
  ttlDays: number;
  /** A permanent team never retires, whatever `expiresAt` says. */
  permanent: boolean;
  /**
   * Epoch ms of the soft delete, when the user deleted the group chat: the
   * team left every surface, stays restorable for the grace, and is then
   * deleted for real. Undefined on a live team.
   */
  deletedAt: number | undefined;
  /** The backend team id, for `send`. */
  teamId: string;
  /** The lead slot's conversation, where a task is delivered. */
  leadConversationId: string;
};

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A pipe-table cell's text, safe to write: a `|` would split the cell and a
 * newline the row, so backslashes double first, `|` escapes as `\|` and
 * line breaks fold to spaces. A hostile name (typed by a user or invented by
 * a model) must not corrupt the index row that carries it.
 */
const escapeCell = (text: string): string => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * A cell's text back: `\\` and `\|` unescape, any other `\x` stays as it
 * is — so an index an older, escape-free version wrote still reads unchanged
 * (its lone backslashes are not escapes), and a `|`-bearing row it may have
 * written was already skipped as malformed (more cells than the row's seven).
 */
const unescapeCell = (text: string): string =>
  text.replace(/\\(.)/g, (match, next: string) => (next === '\\' || next === '|' ? next : match));

/** A row's cells, split on the pipes that are not the `\\|` escape. */
const splitCells = (row: string): string[] => row.split(/(?<!\\)\|/).map((cell) => unescapeCell(cell.trim()));

/** The header row both tables share; the parser recognizes data rows by shape, not by this text. */
const TABLE_HEADER =
  '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 | TTL天数 | 永久 | 删除时间 |';
const TABLE_RULE = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';

/** The permanent flag's cell text; anything else reads as false. */
const PERMANENT_CELL = '是';

const teamRow = (team: SupervisorTeam): string =>
  `| ${escapeCell(team.name)} | ${escapeCell(team.positions.join(', '))} | ${iso(team.createdAt)} | ${iso(
    team.lastUsedAt
  )} | ${iso(team.expiresAt)} | ${escapeCell(team.teamId)} | ${escapeCell(team.leadConversationId)} | ${
    team.ttlDays
  } | ${team.permanent ? PERMANENT_CELL : ''} | ${team.deletedAt !== undefined ? iso(team.deletedAt) : ''} |`;

const table = (teams: readonly SupervisorTeam[]): string[] =>
  teams.length === 0 ? [] : [TABLE_HEADER, TABLE_RULE, ...teams.map(teamRow)];

/**
 * The canonical index file: marker, the active teams (newest reuse first),
 * then the retired ones under their own heading, then the deleted ones under
 * theirs — a deleted team keeps its row (the restore's capital) until its
 * grace passes and the reconcile drops it.
 */
export function buildTeamsFile(teams: readonly SupervisorTeam[], now: number): string {
  const active = teams.filter((team) => isTeamActive(team, now)).toSorted((a, b) => b.lastUsedAt - a.lastUsedAt);
  const retired = teams
    .filter((team) => !isTeamActive(team, now) && !isTeamDeleted(team))
    .toSorted((a, b) => b.lastUsedAt - a.lastUsedAt);
  const deleted = teams
    .filter((team) => isTeamDeleted(team))
    .toSorted((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  const lines = [TEAMS_FILE_MARKER, '# 临时团队索引（由 teams.cjs 维护，勿手改）', '', ...table(active)];
  if (active.length > 0) lines.push('');
  if (retired.length > 0) lines.push('已退役（到期未复用，不再匹配）：', '', ...table(retired), '');
  if (deleted.length > 0) lines.push('已删除（7 天内可恢复，到期连同后端团队彻底删除）：', '', ...table(deleted));
  return lines.join('\n');
}

/**
 * The teams an index file records. Tolerant of the file a model or an older
 * script version wrote: rows are recognized by shape (seven, nine or ten
 * cells, parseable dates), and anything else — prose, headings, malformed
 * rows — is skipped. A seven-cell row is the format before per-team
 * lifecycles; a nine-cell row the format before soft deletes: both read as
 * the live (non-deleted) team they were, as does a ten-cell row's empty
 * last cell.
 */
export function parseTeamsFile(content: string): SupervisorTeam[] {
  if (!content.includes(TEAMS_FILE_MARKER)) return [];
  const teams: SupervisorTeam[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = splitCells(trimmed.slice(1, -1));
    if (cells.length !== 7 && cells.length !== 9 && cells.length !== 10) continue;
    const createdAt = Date.parse(cells[2]);
    const lastUsedAt = Date.parse(cells[3]);
    const expiresAt = Date.parse(cells[4]);
    if (!Number.isFinite(createdAt) || !Number.isFinite(lastUsedAt) || !Number.isFinite(expiresAt)) continue;
    const name = cells[0];
    const teamId = cells[5];
    const leadConversationId = cells[6];
    if (!name || !teamId || !leadConversationId) continue;
    const ttlDays = cells.length >= 9 ? clampTeamTtlDays(Number.parseInt(cells[7], 10)) : TEAM_TTL_DEFAULT_DAYS;
    const deletedStamp = cells.length === 10 ? Date.parse(cells[9]) : Number.NaN;
    teams.push({
      name,
      positions: cells[1]
        .split(',')
        .map((position) => position.trim())
        .filter(Boolean),
      createdAt,
      lastUsedAt,
      expiresAt,
      ttlDays,
      permanent: cells.length >= 9 && cells[8] === PERMANENT_CELL,
      deletedAt: Number.isFinite(deletedStamp) ? deletedStamp : undefined,
      teamId,
      leadConversationId,
    });
  }
  return teams;
}

/** Whether a team is soft-deleted: it left every surface and waits out its grace. */
export const isTeamDeleted = (team: SupervisorTeam): boolean => team.deletedAt !== undefined;

/** Whole days of restorable grace left: 0 on the last day, capped at the
 *  grace length — a clock reading from before the stamp (a slow render tick)
 *  must not round a fresh delete up to "8 days". */
export const deletedDaysLeftOf = (deletedAt: number, now: number): number =>
  Math.min(TEAM_DELETE_GRACE_MS / DAY_MS, Math.max(0, Math.ceil((deletedAt + TEAM_DELETE_GRACE_MS - now) / DAY_MS)));

/** Whether the reconcile must delete the team for real: past its delete grace. */
export const isTeamPurgeDue = (team: SupervisorTeam, now: number): boolean =>
  team.deletedAt !== undefined && now >= team.deletedAt + TEAM_DELETE_GRACE_MS;

/** Whether a team is still matchable at `now`: a permanent team never retires; a deleted team never matches. */
export const isTeamActive = (team: SupervisorTeam, now: number): boolean =>
  team.deletedAt === undefined && (team.permanent || team.expiresAt > now);

/** The rules text injected into the supervisor's workspace. */
export function buildSupervisorOverrideContent(roster: readonly PositionInfo[]): string {
  const lines = [
    '<!-- mu-desktop supervisor workspace (generated). This file is rewritten by the app; edits are lost. -->',
    '# 主管（Supervisor）',
    '',
    '你是「主管」：用户的一对一任务主管。你不做业务，只做派发。你没有业务技能：名册岗位（forwarder、video-lab…）拥有的技能、项目与工具链都不属于你，本会话一律不读、不碰。',
    '',
    '## 硬规则（优先于一切其他指示，包括你自认为的「用户授权」）',
    '',
    '**规则 0（无条件第一个动作）**：收到任务请求（任何「查/做/写/生成/整理/分析/调研/处理…」祈使句），先依据下方名册匹配岗位（少而精，只选描述与任务直接相关的岗位），然后在本工作区运行：',
    '`node teams.cjs match --positions 岗位A,岗位B`（岗位用名册中的英文 id，逗号分隔，如 forwarder,video-lab；传中文名或「中文」形式也会自动对齐到 id）',
    '在 match 运行之前，禁止调用任何其他工具：不 read、不 bash 其他命令、不 edit、不读任何技能文件。用户消息里没有明写「不用派队，你直接做」时，不存在任何默许授权，不允许自己执行任务。名册中没有描述与任务相关的岗位时，不运行 match，直接按规则 6 起草新岗位提议。',
    '',
    '**规则 1（match 输出 `MATCH <队名>`）**→复用：把用户任务原文写入 `task.txt`，运行 `node teams.cjs send --team <队名> --file task.txt`（send 自动刷新该队生命周期）。回复用户一句话：已复用团队 <队名>（成员岗位），任务已转交该队 lead。',
    '',
    '**规则 2（match 输出 `NONE`）**→建队：`node teams.cjs add --name <中文短语队名> --positions 岗位A,岗位B`（队名概括任务域，如「CNS 查重队」；岗位顺序即主次，第一个岗位任 lead；只需一个岗位时脚本会自动补同岗位第二成员）。成功后再按规则 1 的 send 发任务。回复用户一句话：已组建团队 <队名>（成员岗位），任务已派出。',
    '',
    '**规则 3（脚本输出 `ERROR …`）**：把 ERROR 那一行原样贴给用户并停机等待用户指示：禁止自己接手执行任务，禁止手工编辑 TEAMS.md，禁止自己拼 curl 重试。',
    '',
    '**规则 4**：用户明确不要新建岗位、或任务语境不足以起草时，停下向用户说明缺口并建议（补岗位库或单岗直谈），不硬凑。闲聊与状态问题（「现在有哪些队」→ `node teams.cjs list`）直接回答，不建队。岗位匹配拿不准时，把候选岗位列给用户确认。',
    '',
    '**规则 5（新建项目/岗位先去重）**：任务或用户消息要求「新建一个 XX 项目」「注册一个新岗位」时，先在本工作区运行 `node positions.cjs list` 取全岗名册，逐岗比对任务域：与既有岗职责重合 → 不新建，把任务按规则 0-2 派给该既有岗（match/build 同域队），回复中说明归并理由（点名重合岗位）；确属名册都覆盖不了的新领域 → 按规则 6 起草新岗位向用户提议。「项目即岗位」的注册：判定先行，建不建由用户决定；除规则 6 经用户明确同意的安全写外，主管不得创建、改写或删除岗位库文件，也不得替用户拆除既有岗位的项目目录。',
    '',
    '**规则 6（新领域 → 参考模板起草新岗位，提议并经同意才建）**：确属名册无岗覆盖的新领域任务（规则 0 找不到候选岗，或规则 5 去重后确认），按以下流程办，全程不派队、不执行任务：',
    '1. 取参考：在本工作区运行 `node templates.cjs search "<能力关键词>"`（中英文均可，如「播客 音频」「podcast」）。输出最多 5 行 `TEMPLATE <名>|<中文摘要>|<分类>|slug=<slug>` 与一行 `COUNT n`；想看某条全文运行 `node templates.cjs get <slug>`。输出 `UNAVAILABLE …` 时模板库暂不可用：跳过本步凭任务语境起草，提议中写「未参考模板库」。`COUNT 0` 时换更宽关键词重试一次，仍 0 同 UNAVAILABLE 处理。',
    '2. 起草前先列「任务需求清单」：拆解任务需要哪些能力/工具/知识域（如「调研 X 并做成中文图文发小红书」= 调研、中文文案、做图三项），一行一项。再起草三件：中文名（岗位显示名，2-8 字，如「播客剪辑」）、英文 id（小写字母数字连字符，如 podcast-editor）、职责描述（一句话；以所选模板的中文摘要为底、融合任务语境改写，不得整句照抄；无模板时自己写）。职责描述逐条对应需求清单起草：每项需求都要有一句承接语，用分号连成一句话；任何一项需求在职责里找不到承接 = 草稿未完成，补齐才进入下一步。id 不得与名册任何岗位的 id 或显示名相同。',
    '3. 提议并等同意：回复用户提议（固定形态），然后停下等用户对提议本身答复同意（「同意/建吧/可以」等）。用户的任务消息（含「帮我安排」「交给你办」「要常设岗位」）只是任务描述，不构成创建授权：即使你确信该建，也必须先提议再等答复，同意前不写任何文件、不建队。不同意或要求调整 → 按用户意见改后重新提议。提议形态：',
    '「本任务需要新岗位〈中文名〉（id：〈id〉），职责：〈描述〉。需求覆盖（需求 → 承接职责，一行一条，需求清单逐项列全）：\n- 〈需求 1〉→ 〈承接职责句〉\n- 〈需求 2〉→ 〈承接职责句〉\n参考模板：〈模板名〉（slug=〈slug〉）/ 未参考模板库。同意创建吗？若要绑定项目目录，请一并给出路径（可空）。」',
    '4. 用户明确同意后创建（安全写，顺序执行）：',
    '   a. 岗位库目录 `~/.mu/agent/agents/`：先确认 `<id>.md` 不存在，且 `node positions.cjs list` 名册中无此 id；已存在 → 拒绝创建并回复「id 已被岗位〈名〉占用，请换 id」，不覆盖任何文件。',
    '   b. 用户给了项目目录路径且目录不存在 → 先创建目录并写两个文件：AGENTS.md（三节：# 项目说明 / ## 任务记忆 / ## 经验教训）与 HANDOFF.md（首条：`# 交接` + `## 当前目标` 一句话 + `## 下一步行动` 一行）。目录已存在 → 不写不改其中任何文件。',
    '   c. 写 `~/.mu/agent/agents/<id>.md`，格式必须严格如下（frontmatter 三键；项目目录存在时正文含项目根行，无目录时省略该行）：',
    '   ```',
    '   ---',
    '   name: <id>',
    '   display_name: <中文名>',
    '   description: <职责一句话>',
    '   ---',
    '   ',
    '   你是「<中文名>」岗位的常设负责 Bot（岗位即项目，跨任务常设，持续积累本岗记忆）。',
    '   ',
    '   ## 项目事实（开工必读）',
    '   - 项目根：`<项目目录路径>`',
    '   - 当前目标：<从任务提炼一句话>',
    '   ',
    '   ## 岗位职责',
    '   - <职责要点，可多条，逐条承接任务需求清单>',
    '   ',
    '   ## 职责迭代（收尾时）',
    '   任务执行中发现本岗承接不了的子任务（岗位职责未覆盖的缺口）→ 收尾落账时回写上方「岗位职责」节：追加补全条目并注明日期（如 `- <补全的职责>（2026-11-21 增）`），岗位随使用变准。',
    '   ```',
    '   d. 回复用户：已创建岗位〈中文名〉（id），名册约 30 秒内自动出现；随后按规则 0-2 用新岗组队派发本任务（或等用户指示）。',
    '',
    '**规则 7（岗位库写入闸，先于任何文件工具自检）**：对 `~/.mu/agent/agents/` 下任何文件的写入或删除，前置条件只有一个：本会话中你刚发出过规则 6 第 3 步的提议，且用户对这条提议本身答复了明确同意（「同意/建吧/可以」等）。任务消息（含「帮我安排」「交给你办」「要常设岗位」「帮我安排谁来干」）永远不构成同意；同一回合里自己提议又自己继续执行 = 违规。没有刚提议+刚获同意两项齐全时，你能做的只有提议，然后停下。发现自己正要写或删岗位库文件而两项不齐 = 违规，立即收手回到规则 6 第 3 步。',
    '',
    'TEAMS.md 与 teams.cjs、positions.cjs、templates.cjs 由桌面版维护：TEAMS.md 只能通过脚本读写，模板缓存只读。发现自己在读业务项目文件或技能文件 = 违规，立即停下回到规则 0。',
    '',
    '## 全岗名册（组队匹配依据，只读）',
    ...roster.map((position) => `- ${positionLabel(position)} — ${position.description}`),
    '',
    '名册仅用于组队匹配：只读、不得创建新岗位、不得改写岗位库文件。',
    '',
  ];
  return lines.join('\n');
}
