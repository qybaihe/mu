/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  TEAM_DELETE_GRACE_MS,
  TEAM_TTL_DEFAULT_DAYS,
  TEAM_TTL_MAX_DAYS,
  TEAM_TTL_MS,
  buildSupervisorOverrideContent,
  buildTeamsFile,
  clampTeamTtlDays,
  deletedDaysLeftOf,
  expiryAfterTtl,
  isTeamActive,
  isTeamDeleted,
  isTeamPurgeDue,
  isTeamWorkspaceFolder,
  isTeamsIndexFile,
  parseTeamsFile,
  teamWorkspaceFolderOf,
  type SupervisorTeam,
} from '@/common/chat/team/supervisor/supervisorCore';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';

/**
 * The supervisor's pure core (common/chat/team/supervisor/supervisorCore.ts): the
 * TEAMS.md format — parse and canonical build, the TTL retirement the
 * canonical build applies — and the rules text injected into the workspace.
 * The file format is a contract with teams.cjs; the script's own test
 * cross-checks that side.
 */

const team = (overrides: Partial<SupervisorTeam> = {}): SupervisorTeam => ({
  name: 'CNS 查重队',
  positions: ['forwarder', 'worker'],
  createdAt: 1_000,
  lastUsedAt: 2_000,
  expiresAt: 3_000,
  ttlDays: 7,
  permanent: false,
  deletedAt: undefined,
  teamId: 'team-1',
  leadConversationId: 'conv-lead',
  ...overrides,
});

/** An index file holding one ten-cell row: the header and rule the parser
 *  must skip, then the row itself. */
const tenCellRow = (cells: string): string =>
  `<!-- mu-supervisor-teams v1 -->\n# 临时团队索引\n\n| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 | TTL天数 | 永久 | 删除时间 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${cells}`;

describe('parseTeamsFile / buildTeamsFile', () => {
  it('round-trips teams through the canonical file', () => {
    const file = buildTeamsFile(
      [team({ expiresAt: Date.now() + TEAM_TTL_MS }), team({ name: '旧队', expiresAt: 1 })],
      Date.now()
    );
    const parsed = parseTeamsFile(file);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((t) => t.name)).toEqual(['CNS 查重队', '旧队']);
    expect(parsed[0]).toMatchObject({
      positions: ['forwarder', 'worker'],
      createdAt: 1_000,
      lastUsedAt: 2_000,
      teamId: 'team-1',
      leadConversationId: 'conv-lead',
    });
  });

  it('round-trips a hostile name and member list: `|` escaped, line breaks folded, nothing corrupted', () => {
    const hostile = team({
      name: '毒|队\n名\\续',
      positions: ['for|ward', 'worker'],
      expiresAt: Date.now() + TEAM_TTL_MS,
    });
    const file = buildTeamsFile([hostile], Date.now());
    // the written row stays one row: the pipe is the escape, not a split
    expect(file).toContain('| 毒\\|队 名\\\\续 |');
    expect(file).not.toContain('毒|队');
    const parsed = parseTeamsFile(file);
    expect(parsed).toHaveLength(1);
    // the line break folded to a space on write — that loss is the point
    expect(parsed[0].name).toBe('毒|队 名\\续');
    expect(parsed[0].positions).toEqual(['for|ward', 'worker']);
  });

  it('reads an index an older, escape-free version wrote: a lone backslash stays, a raw `|` row stays skipped', () => {
    const content = [
      '<!-- mu-supervisor-teams v1 -->',
      '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| 货代\\a队 | forwarder | 2026-01-01T00:00:00.000Z | 2026-01-02T00:00:00.000Z | 2026-01-08T00:00:00.000Z | t-1 | c-1 |',
      '| 毒|队 | forwarder | 2026-01-01T00:00:00.000Z | 2026-01-02T00:00:00.000Z | 2026-01-08T00:00:00.000Z | t-2 | c-2 |',
    ].join('\n');
    const parsed = parseTeamsFile(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('货代\\a队');
  });

  it('rejects a file without the app-managed marker', () => {
    expect(parseTeamsFile('| CNS 队 | forwarder | 2026-01-01T00:00:00.000Z | x | y | t | c |')).toEqual([]);
  });

  it('round-trips the per-team lifecycle: ttlDays and the permanent flag in and out', () => {
    const file = buildTeamsFile(
      [
        team({ ttlDays: 30, expiresAt: Date.now() + 30 * 86_400_000 }),
        team({ name: '永久队', ttlDays: 3, permanent: true, expiresAt: Date.now() + 3 * 86_400_000 }),
      ],
      Date.now()
    );
    const parsed = parseTeamsFile(file);
    expect(parsed.map((t) => [t.ttlDays, t.permanent])).toEqual([
      [30, false],
      [3, true],
    ]);
  });

  it('reads a seven-cell row as the pre-lifecycle default: 7 days, not permanent', () => {
    // The file an older script version wrote — no lifecycle cells at all.
    const content = [
      '<!-- mu-supervisor-teams v1 -->',
      '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| 老队 | forwarder | 2026-01-01T00:00:00.000Z | 2026-01-02T00:00:00.000Z | 2026-01-08T00:00:00.000Z | t-old | c-old |',
    ].join('\n');
    const parsed = parseTeamsFile(content);
    expect(parsed[0].ttlDays).toBe(TEAM_TTL_DEFAULT_DAYS);
    expect(parsed[0].permanent).toBe(false);
  });

  it('falls back to the default ttl for an unparsable cell, clamps out-of-range ones', () => {
    const file = [
      '<!-- mu-supervisor-teams v1 -->',
      '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 | TTL天数 | 永久 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      `| 废队 | forwarder | 2026-01-01T00:00:00.000Z | 2026-01-02T00:00:00.000Z | 2026-01-08T00:00:00.000Z | t-1 | c-1 | NaN |  |`,
    ].join('\n');
    expect(parseTeamsFile(file)[0].ttlDays).toBe(TEAM_TTL_DEFAULT_DAYS);
    expect(clampTeamTtlDays(0)).toBe(1);
    expect(clampTeamTtlDays(400)).toBe(TEAM_TTL_MAX_DAYS);
    expect(clampTeamTtlDays(Number.NaN)).toBe(TEAM_TTL_DEFAULT_DAYS);
    expect(expiryAfterTtl(3, 1_000)).toBe(1_000 + 3 * 86_400_000);
  });

  it('skips prose, headings and malformed rows, keeping well-shaped ones', () => {
    const content = [
      '<!-- mu-supervisor-teams v1 -->',
      '# 临时团队索引（由 teams.cjs 维护，勿手改）',
      '',
      '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| CNS 查重队 | forwarder, worker | 2026-01-01T00:00:00.000Z | 2026-01-02T00:00:00.000Z | 2026-01-08T00:00:00.000Z | team-1 | conv-lead |',
      '| 这行是模型手写的废话，没有日期 | a | b | c | d | e | f |',
      '已退役（到期未复用，不再匹配）：',
      '',
    ].join('\n');
    const parsed = parseTeamsFile(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('CNS 查重队');
    expect(parsed[0].positions).toEqual(['forwarder', 'worker']);
  });

  it('drops rows whose team id or lead conversation id is not a backend id shape — they flow into backend URL paths', () => {
    const row = (teamId: string, lead: string) =>
      `| 队 | forwarder | 2026-01-01T00:00:00.000Z | 2026-01-02T00:00:00.000Z | 2026-01-08T00:00:00.000Z | ${teamId} | ${lead} |`;
    const content = [
      '<!-- mu-supervisor-teams v1 -->',
      '| 队名 | 岗位成员 | 创建时间 | 最后复用 | 到期时间 | team_id | lead会话 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      row('01a1f939-ec89-7302-ace9-6d27a944968d', '3d19b983'),
      row('../x', '3d19b983'),
      row('a b', '3d19b983'),
      row('ok/id', '3d19b983'),
      row('3d19b983', 'a/b'),
    ].join('\n');
    const parsed = parseTeamsFile(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].teamId).toBe('01a1f939-ec89-7302-ace9-6d27a944968d');
  });

  it('builds the empty index for no teams', () => {
    const file = buildTeamsFile([], Date.now());
    expect(parseTeamsFile(file)).toEqual([]);
    expect(file).toContain('<!-- mu-supervisor-teams v1 -->');
  });

  it('sorts active teams by latest reuse and moves expired ones under the retired heading', () => {
    const now = 10_000_000;
    const older = team({ name: '旧队', lastUsedAt: 1, expiresAt: now + 1 });
    const newer = team({ name: '新队', lastUsedAt: 9_999, expiresAt: now + 1 });
    const expired = team({ name: '过期队', lastUsedAt: 5_000, expiresAt: now - 1 });
    const file = buildTeamsFile([older, expired, newer], now);
    const retiredAt = file.indexOf('已退役');
    const newerAt = file.indexOf('| 新队 ');
    const olderAt = file.indexOf('| 旧队 ');
    const expiredAt = file.indexOf('| 过期队 ');
    expect(retiredAt).toBeGreaterThan(-1);
    expect(newerAt).toBeGreaterThan(-1);
    expect(olderAt).toBeGreaterThan(newerAt);
    expect(expiredAt).toBeGreaterThan(retiredAt);
    expect(olderAt).toBeLessThan(retiredAt);
  });

  it('never retires a permanent team: its row stays above the retired heading past its recorded expiry', () => {
    const now = 10_000_000;
    const forever = team({ name: '永久队', permanent: true, expiresAt: now - 1 });
    const expired = team({ name: '过期队', expiresAt: now - 1 });
    const file = buildTeamsFile([expired, forever], now);
    const retiredAt = file.indexOf('已退役');
    expect(file.indexOf('| 永久队 ')).toBeGreaterThan(-1);
    expect(file.indexOf('| 永久队 ')).toBeLessThan(retiredAt);
    expect(file.indexOf('| 过期队 ')).toBeGreaterThan(retiredAt);
  });

  it('round-trips the soft delete: the stamp in and out, the row under the deleted heading', () => {
    const now = 10_000_000;
    const live = team({ name: '现役队', expiresAt: now + 1 });
    const deleted = team({ name: '已删队', expiresAt: now + 1, deletedAt: 9_000_000 });
    const file = buildTeamsFile([deleted, live], now);
    expect(file).toContain('已删除');
    const deletedAt = file.indexOf('已删除');
    expect(file.indexOf('| 现役队 ')).toBeGreaterThan(-1);
    expect(file.indexOf('| 现役队 ')).toBeLessThan(deletedAt);
    expect(file.indexOf('| 已删队 ')).toBeGreaterThan(deletedAt);
    const parsed = parseTeamsFile(file);
    expect(parsed.find((t) => t.name === '现役队')?.deletedAt).toBeUndefined();
    expect(parsed.find((t) => t.name === '已删队')?.deletedAt).toBe(9_000_000);
  });

  it('reads a ten-cell row with an empty delete cell as the live team it is, and a nine-cell row the same', () => {
    const stamped = Date.parse('2026-11-20T00:00:00Z');
    const parsedTen = parseTeamsFile(
      tenCellRow(
        `| 队 | a | 2026-11-01T00:00:00Z | 2026-11-02T00:00:00Z | 2026-12-01T00:00:00Z | t1 | c1 | 7 |  | ${new Date(
          stamped
        ).toISOString()} |`
      )
    );
    expect(parsedTen[0]?.deletedAt).toBe(stamped);
    const parsedEmpty = parseTeamsFile(
      tenCellRow('| 队 | a | 2026-11-01T00:00:00Z | 2026-11-02T00:00:00Z | 2026-12-01T00:00:00Z | t1 | c1 | 7 |  |  |')
    );
    expect(parsedEmpty[0]?.deletedAt).toBeUndefined();
    const parsedNine = parseTeamsFile(
      '<!-- mu-supervisor-teams v1 -->\n| 队 | a | 2026-11-01T00:00:00Z | 2026-11-02T00:00:00Z | 2026-12-01T00:00:00Z | t1 | c1 | 7 |  |'
    );
    expect(parsedNine[0]?.deletedAt).toBeUndefined();
  });
});

describe('the delete grace', () => {
  it('a deleted team is never active, not even a permanent one', () => {
    expect(isTeamActive(team({ deletedAt: 1, expiresAt: 100 }), 50)).toBe(false);
    expect(isTeamActive(team({ deletedAt: 1, permanent: true, expiresAt: 1 }), 100)).toBe(false);
    expect(isTeamDeleted(team({ deletedAt: 1 }))).toBe(true);
    expect(isTeamDeleted(team())).toBe(false);
  });

  it('the purge is due strictly past the grace', () => {
    expect(isTeamPurgeDue(team({ deletedAt: 1 }), 1 + TEAM_DELETE_GRACE_MS)).toBe(true);
    expect(isTeamPurgeDue(team({ deletedAt: 1 }), 1 + TEAM_DELETE_GRACE_MS - 1)).toBe(false);
    expect(isTeamPurgeDue(team(), 1_000_000_000)).toBe(false);
  });

  it('the days left count down to zero, never negative, never past the grace length', () => {
    const deletedAt = 0;
    const day = 24 * 60 * 60 * 1000;
    expect(deletedDaysLeftOf(deletedAt, 0)).toBe(7);
    // A clock from before the stamp (a slow render tick) must not read 8.
    expect(deletedDaysLeftOf(deletedAt, -10_000)).toBe(7);
    expect(deletedDaysLeftOf(deletedAt, 6 * day)).toBe(1);
    expect(deletedDaysLeftOf(deletedAt, 7 * day)).toBe(0);
    expect(deletedDaysLeftOf(deletedAt, 8 * day)).toBe(0);
  });
});

describe('isTeamActive', () => {
  it('is active strictly before the expiry', () => {
    expect(isTeamActive(team({ expiresAt: 100 }), 99)).toBe(true);
    expect(isTeamActive(team({ expiresAt: 100 }), 100)).toBe(false);
  });

  it('a permanent team stays active whatever its recorded expiry says', () => {
    expect(isTeamActive(team({ permanent: true, expiresAt: 1 }), 100)).toBe(true);
  });
});

describe('buildSupervisorOverrideContent', () => {
  const roster: PositionInfo[] = [
    { name: 'forwarder', displayName: '货代', description: '货代岗', body: 'x' },
    { name: 'video-lab', displayName: 'video-lab', description: '视频岗', body: 'y' },
  ];

  it('carries the roster as the matching reference, display name with the id beside it', () => {
    const content = buildSupervisorOverrideContent(roster);
    expect(content).toContain('- 货代(forwarder) — 货代岗');
    expect(content).toContain('- video-lab — 视频岗');
  });

  it('teaches the exact workflow: match, then reuse-send or add, and the guardrails', () => {
    const content = buildSupervisorOverrideContent(roster);
    expect(content).toContain('node teams.cjs match --positions');
    expect(content).toContain('node teams.cjs send --team');
    expect(content).toContain('node teams.cjs add --name');
    expect(content).toContain('MATCH');
    expect(content).toContain('NONE');
    expect(content).toContain('生命周期');
    expect(content).toContain('禁止手工编辑 TEAMS.md');
    expect(content).toContain('禁止自己接手执行任务');
  });

  it('teaches the new-project dedup gate: positions.cjs first, merge or hand to rule 6, never create positions unasked', () => {
    const content = buildSupervisorOverrideContent(roster);
    expect(content).toContain('node positions.cjs list');
    expect(content).toContain('规则 5');
    expect(content).toContain('与既有岗职责重合 → 不新建');
    expect(content).toContain('说明归并理由');
    expect(content).toContain('除规则 6 经用户明确同意的安全写外，主管不得创建、改写或删除岗位库文件');
    expect(content).toContain('判定先行，建不建由用户决定');
  });

  it('teaches the template-backed new-position flow: search, draft, propose, safe write only after consent', () => {
    const content = buildSupervisorOverrideContent(roster);
    expect(content).toContain('规则 6');
    expect(content).toContain('node templates.cjs search');
    expect(content).toContain('node templates.cjs get');
    expect(content).toContain('UNAVAILABLE');
    expect(content).toContain('未参考模板库');
    // The proposal waits for consent before any file is touched.
    expect(content).toContain('同意创建吗');
    expect(content).toContain('同意前不写任何文件');
    // The safe write: refuse an id that exists, never overwrite.
    expect(content).toContain('~/.mu/agent/agents/');
    expect(content).toContain('id 已被岗位');
    // The written file must parse as a library position.
    expect(content).toContain('display_name:');
    expect(content).toContain('项目根：');
    // The new project dir follows the wrap-up rules: AGENTS three sections, a first HANDOFF entry.
    expect(content).toContain('AGENTS.md');
    expect(content).toContain('HANDOFF.md');
    // Rule 0's no-candidate branch lands here too.
    expect(content).toContain('名册中没有描述与任务相关的岗位时，不运行 match，直接按规则 6 起草新岗位提议');
    // Rule 7: the write gate — a task message never counts as consent, and a turn may not both
    // propose and proceed.
    expect(content).toContain('规则 7');
    expect(content).toContain('任务消息');
    expect(content).toContain('不构成同意');
    expect(content).toContain('同一回合里自己提议又自己继续执行 = 违规');
    // Rule 8: a receipt is bookkeeping, not a task — one-line report, no dispatch.
    expect(content).toContain('规则 8');
    expect(content).toContain('[[MU_TEAM_RECEIPT]]');
    expect(content).toContain('不建队、不派活、不跑 teams.cjs、不写任何文件');
  });

  it('teaches the requirement-coverage flow: list the task requirements first, map each to a duty, show the mapping in the proposal', () => {
    const content = buildSupervisorOverrideContent(roster);
    // Drafting starts from an explicit requirements list of the task.
    expect(content).toContain('任务需求清单');
    expect(content).toContain('能力/工具/知识域');
    // Each requirement must be carried by the drafted duties; an unmapped requirement blocks the proposal.
    expect(content).toContain('逐条对应需求清单');
    expect(content).toContain('找不到承接 = 草稿未完成');
    // The proposal itself shows the mapping, one line per requirement, for the user to verify.
    expect(content).toContain('需求覆盖（需求 → 承接职责，一行一条');
    expect(content).toContain('→ 〈承接职责句〉');
    // The written position file keeps per-requirement duty bullets and learns gaps at wrap-up.
    expect(content).toContain('逐条承接任务需求清单');
    expect(content).toContain('职责迭代（收尾时）');
    expect(content).toContain('回写上方「岗位职责」节');
    expect(content).toContain('岗位随使用变准');
  });

  it('declares the supervisor identity and its no-hands rule', () => {
    const content = buildSupervisorOverrideContent([]);
    expect(content).toContain('主管（Supervisor）');
    expect(content).toContain('你不做业务，只做派发');
    expect(content).toContain('无条件第一个动作');
  });
});

describe('the teams root sweep: which folders the index explains', () => {
  it('derives workspace folder names the way teams.cjs add does', () => {
    // The mirror of the script's teamWorkspace(): unsafe characters and
    // whitespace fold to dashes, leading/trailing dashes drop.
    expect(teamWorkspaceFolderOf('CNS 查重队')).toBe('CNS-查重队');
    expect(teamWorkspaceFolderOf(' a/b:c*d?e"f<g>h|i ')).toBe('a-b-c-d-e-f-g-h-i');
    expect(teamWorkspaceFolderOf('--货代--')).toBe('货代');
    expect(teamWorkspaceFolderOf('///')).toBe('');
  });

  it('explains the exact derived folder, the collision-suffixed variant, and nothing else', () => {
    const rows = [team({ name: '播客笔记队' })];
    expect(isTeamWorkspaceFolder('播客笔记队', rows)).toBe(true);
    // add's collision variant appends -<timestamp>: still that team's folder.
    expect(isTeamWorkspaceFolder('播客笔记队-mwovvd2m', rows)).toBe(true);
    expect(isTeamWorkspaceFolder('播客笔记整理队', rows)).toBe(false);
    expect(isTeamWorkspaceFolder('other', rows)).toBe(false);
  });

  it('counts every row of the full table — active, retired, soft-deleted', () => {
    const now = Date.now();
    const rows = [
      team({ name: '现役队', teamId: 'a', deletedAt: undefined }),
      team({ name: '退役队', teamId: 'b', expiresAt: now - 1, deletedAt: undefined }),
      team({ name: '已删队', teamId: 'c', deletedAt: now - 1 }),
    ];
    for (const name of ['现役队', '退役队', '已删队']) expect(isTeamWorkspaceFolder(name, rows)).toBe(true);
    // A name that derives to nothing (all unsafe characters) explains no folder.
    expect(isTeamWorkspaceFolder('', [team({ name: '///' })])).toBe(false);
  });

  it("recognizes index files by the marker — the sweep's truth-is-known bar", () => {
    expect(isTeamsIndexFile(buildTeamsFile([team()], 2_000))).toBe(true);
    expect(isTeamsIndexFile(`# 临时团队索引${'\n'}| 队名 |${'\n'}| --- |${'\n'}`)).toBe(false);
    expect(isTeamsIndexFile('')).toBe(false);
  });
});
