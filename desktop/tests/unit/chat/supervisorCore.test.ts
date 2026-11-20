/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  TEAM_TTL_DEFAULT_DAYS,
  TEAM_TTL_MAX_DAYS,
  TEAM_TTL_MS,
  buildSupervisorOverrideContent,
  buildTeamsFile,
  clampTeamTtlDays,
  expiryAfterTtl,
  isTeamActive,
  parseTeamsFile,
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
  teamId: 'team-1',
  leadConversationId: 'conv-lead',
  ...overrides,
});

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

  it('teaches the new-project dedup gate: positions.cjs first, merge or stop, never create positions', () => {
    const content = buildSupervisorOverrideContent(roster);
    expect(content).toContain('node positions.cjs list');
    expect(content).toContain('规则 5');
    expect(content).toContain('与既有岗职责重合 → 不新建');
    expect(content).toContain('说明归并理由');
    expect(content).toContain('主管不得创建或改写岗位库文件');
    expect(content).toContain('只给判定与建议');
  });

  it('declares the supervisor identity and its no-hands rule', () => {
    const content = buildSupervisorOverrideContent([]);
    expect(content).toContain('主管（Supervisor）');
    expect(content).toContain('你不做业务，只做派发');
    expect(content).toContain('无条件第一个动作');
  });
});
