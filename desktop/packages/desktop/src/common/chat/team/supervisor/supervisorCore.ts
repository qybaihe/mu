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
 * one pipe-table row per team, ISO timestamps, and a 7-day TTL that a reuse
 * (a `send`) refreshes. The workspace also carries `positions.cjs`, the
 * read-only roster listing behind the supervisor's new-project dedup gate.
 * All IO lives in the service and the scripts.
 */
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { positionLabel } from '@/common/chat/team/positions/positionLibraryCore';

/** The supervisor's identity: the `extra.position` marker and the roster label key. */
export const SUPERVISOR_POSITION_NAME = 'supervisor';

/** The supervisor workspace's folder under the app data dir's `positions/`. */
export const SUPERVISOR_FOLDER = '_supervisor';

/** How long a team lives: created for this span, every reuse extends it to `now + TTL`. */
export const TEAM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** The backend team id, for `send`. */
  teamId: string;
  /** The lead slot's conversation, where a task is delivered. */
  leadConversationId: string;
};

const iso = (ms: number): string => new Date(ms).toISOString();

/** The header row both tables share; the parser recognizes data rows by shape, not by this text. */
const TABLE_HEADER = '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 |';
const TABLE_RULE = '| --- | --- | --- | --- | --- | --- | --- |';

const teamRow = (team: SupervisorTeam): string =>
  `| ${team.name} | ${team.positions.join(', ')} | ${iso(team.createdAt)} | ${iso(team.lastUsedAt)} | ${iso(
    team.expiresAt
  )} | ${team.teamId} | ${team.leadConversationId} |`;

const table = (teams: readonly SupervisorTeam[]): string[] =>
  teams.length === 0 ? [] : [TABLE_HEADER, TABLE_RULE, ...teams.map(teamRow)];

/**
 * The canonical index file: marker, the active teams (newest reuse first),
 * then the retired ones under their own heading. Retired teams keep their
 * history but are never matched again.
 */
export function buildTeamsFile(teams: readonly SupervisorTeam[], now: number): string {
  const active = teams.filter((team) => team.expiresAt > now).toSorted((a, b) => b.lastUsedAt - a.lastUsedAt);
  const retired = teams.filter((team) => team.expiresAt <= now).toSorted((a, b) => b.lastUsedAt - a.lastUsedAt);
  const lines = [TEAMS_FILE_MARKER, '# 临时团队索引（由 teams.cjs 维护，勿手改）', '', ...table(active)];
  if (active.length > 0) lines.push('');
  if (retired.length > 0) lines.push('已退役（到期未复用，不再匹配）：', '', ...table(retired));
  return lines.join('\n');
}

/**
 * The teams an index file records. Tolerant of the file a model or an older
 * script version wrote: rows are recognized by shape (seven cells, parseable
 * dates), and anything else — prose, headings, malformed rows — is skipped.
 */
export function parseTeamsFile(content: string): SupervisorTeam[] {
  if (!content.includes(TEAMS_FILE_MARKER)) return [];
  const teams: SupervisorTeam[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length !== 7) continue;
    const createdAt = Date.parse(cells[2]);
    const lastUsedAt = Date.parse(cells[3]);
    const expiresAt = Date.parse(cells[4]);
    if (!Number.isFinite(createdAt) || !Number.isFinite(lastUsedAt) || !Number.isFinite(expiresAt)) continue;
    const name = cells[0];
    const teamId = cells[5];
    const leadConversationId = cells[6];
    if (!name || !teamId || !leadConversationId) continue;
    teams.push({
      name,
      positions: cells[1]
        .split(',')
        .map((position) => position.trim())
        .filter(Boolean),
      createdAt,
      lastUsedAt,
      expiresAt,
      teamId,
      leadConversationId,
    });
  }
  return teams;
}

/** Whether a team is still matchable at `now`. */
export const isTeamActive = (team: SupervisorTeam, now: number): boolean => team.expiresAt > now;

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
    '在 match 运行之前，禁止调用任何其他工具：不 read、不 bash 其他命令、不 edit、不读任何技能文件。用户消息里没有明写「不用派队，你直接做」时，不存在任何默许授权，不允许自己执行任务。',
    '',
    '**规则 1（match 输出 `MATCH <队名>`）**→复用：把用户任务原文写入 `task.txt`，运行 `node teams.cjs send --team <队名> --file task.txt`（send 自动刷新该队 7 天生命周期）。回复用户一句话：已复用团队 <队名>（成员岗位），任务已转交该队 lead。',
    '',
    '**规则 2（match 输出 `NONE`）**→建队：`node teams.cjs add --name <中文短语队名> --positions 岗位A,岗位B`（队名概括任务域，如「CNS 查重队」；岗位顺序即主次，第一个岗位任 lead；只需一个岗位时脚本会自动补同岗位第二成员）。成功后再按规则 1 的 send 发任务。回复用户一句话：已组建团队 <队名>（成员岗位），任务已派出。',
    '',
    '**规则 3（脚本输出 `ERROR …`）**：把 ERROR 那一行原样贴给用户并停机等待用户指示：禁止自己接手执行任务，禁止手工编辑 TEAMS.md，禁止自己拼 curl 重试。',
    '',
    '**规则 4**：名册覆盖不了该任务时，停下向用户说明缺口并建议（补岗位库或单岗直谈），不硬凑。闲聊与状态问题（「现在有哪些队」→ `node teams.cjs list`）直接回答，不建队。岗位匹配拿不准时，把候选岗位列给用户确认。',
    '',
    '**规则 5（新建项目/岗位先去重）**：任务或用户消息要求「新建一个 XX 项目」「注册一个新岗位」时，先在本工作区运行 `node positions.cjs list` 取全岗名册，逐岗比对任务域：与既有岗职责重合 → 不新建，把任务按规则 0-2 派给该既有岗（match/build 同域队），回复中说明归并理由（点名重合岗位）；确属名册都覆盖不了的新领域 → 按规则 4 停下向用户说明缺口，不硬凑建队。主管不得创建或改写岗位库文件；「项目即岗位」的注册只给判定与建议，建不建由用户决定。',
    '',
    'TEAMS.md 与 teams.cjs、positions.cjs 由桌面版维护，只能通过脚本读写。发现自己在读业务项目文件或技能文件 = 违规，立即停下回到规则 0。',
    '',
    '## 全岗名册（组队匹配依据，只读）',
    ...roster.map((position) => `- ${positionLabel(position)} — ${position.description}`),
    '',
    '名册仅用于组队匹配：只读、不得创建新岗位、不得改写岗位库文件。',
    '',
  ];
  return lines.join('\n');
}
