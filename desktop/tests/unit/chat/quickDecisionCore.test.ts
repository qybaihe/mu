/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import type { SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';
import {
  QUICK_DECISION_MIN_CONFIDENCE,
  activeTeamsForDecision,
  buildPositionDomainPrompt,
  buildSupervisorReusePrompt,
  decisionCacheKey,
  extractDecisionJson,
  isCacheEntryFresh,
  normalizeDecisionInput,
  parsePositionDomainDecision,
  parseSupervisorReuseDecision,
} from '@/common/chat/team/quickDecision/quickDecisionCore';

/** The quick-decision core: strict parsing with a conservative error direction, cache math, and the two prompts. */

const position = (name: string, displayName: string, description: string): PositionInfo => ({
  name,
  displayName,
  description,
  body: `${displayName} 岗位说明书正文。`,
});

const roster = [
  position('forwarder', '货代', '海运订舱与货代客户开发'),
  position('video-lab', '视频实验室', '视频制作与动效'),
];

const team = (over: Partial<SupervisorTeam> = {}): SupervisorTeam => ({
  name: '货代小队',
  positions: ['forwarder'],
  createdAt: 1,
  lastUsedAt: 2,
  expiresAt: 100,
  ttlDays: 7,
  permanent: false,
  deletedAt: undefined,
  teamId: 't1',
  leadConversationId: 'c1',
  ...over,
});

describe('extractDecisionJson', () => {
  it('takes a bare JSON object', () => {
    expect(extractDecisionJson('{"action":"full"}')).toEqual({ action: 'full' });
  });
  it('takes the fenced block out of prose', () => {
    expect(extractDecisionJson('判定如下：\n```json\n{"action":"reuse"}\n```\n以上。')).toEqual({ action: 'reuse' });
  });
  it('takes the first balanced object out of loose prose', () => {
    expect(extractDecisionJson('结果 {"action":"full"} 完')).toEqual({ action: 'full' });
  });
  it('rejects anything that does not parse, and arrays', () => {
    expect(extractDecisionJson('no json here')).toBeUndefined();
    expect(extractDecisionJson('[1,2]')).toBeUndefined();
  });
});

describe('parseSupervisorReuseDecision', () => {
  it('accepts a confident reuse with a team id', () => {
    expect(parseSupervisorReuseDecision('{"action":"reuse","teamId":"t1","reason":"同域","confidence":0.95}')).toEqual({
      action: 'reuse',
      teamId: 't1',
      reason: '同域',
      confidence: 0.95,
    });
  });
  it('maps the model saying full to full', () => {
    expect(parseSupervisorReuseDecision('{"action":"full","reason":"需建队","confidence":0.9}')).toEqual({
      action: 'full',
      reason: '需建队',
    });
  });
  it('falls back on low confidence — the conservative direction', () => {
    const verdict = parseSupervisorReuseDecision('{"action":"reuse","teamId":"t1","reason":"x","confidence":0.5}');
    expect(verdict.action).toBe('full');
    expect(verdict.action === 'full' && verdict.reason).toBe('low-confidence');
  });
  it('falls back on a missing or empty team id', () => {
    expect(parseSupervisorReuseDecision('{"action":"reuse","confidence":0.99}').action).toBe('full');
    expect(parseSupervisorReuseDecision('{"action":"reuse","teamId":"  ","confidence":0.99}').action).toBe('full');
  });
  it('falls back on missing confidence, an unknown action, and garbage', () => {
    expect(parseSupervisorReuseDecision('{"action":"reuse","teamId":"t1"}').action).toBe('full');
    expect(parseSupervisorReuseDecision('{"action":"maybe"}').action).toBe('full');
    expect(parseSupervisorReuseDecision('内部错误').action).toBe('full');
  });
  it('treats a confidence exactly at the bar as acting', () => {
    expect(
      parseSupervisorReuseDecision(
        `{"action":"reuse","teamId":"t1","reason":"r","confidence":${QUICK_DECISION_MIN_CONFIDENCE}}`
      ).action
    ).toBe('reuse');
  });
});

describe('parsePositionDomainDecision', () => {
  it('accepts a confident reject whose suggestion names a roster position, by id or display name', () => {
    const byId = parsePositionDomainDecision(
      '{"action":"reject","suggest":"video-lab","reason":"视频域","confidence":0.95}',
      roster
    );
    expect(byId).toEqual({ action: 'reject', suggest: 'video-lab', reason: '视频域', confidence: 0.95 });
    const byName = parsePositionDomainDecision(
      '{"action":"reject","suggest":"视频实验室","reason":"视频域","confidence":0.95}',
      roster
    );
    expect(byName && byName.action === 'reject' && byName.suggest).toBe('video-lab');
  });
  it('falls back when the suggestion is off the roster — the receipt must never invent a position', () => {
    const verdict = parsePositionDomainDecision(
      '{"action":"reject","suggest":"不存在岗","reason":"x","confidence":0.99}',
      roster
    );
    expect(verdict.action).toBe('full');
    expect(verdict.action === 'full' && verdict.reason).toBe('suggestion-off-roster');
  });
  it('falls back on low confidence and on the model saying full', () => {
    expect(
      parsePositionDomainDecision('{"action":"reject","suggest":"video-lab","reason":"x","confidence":0.6}', roster)
        .action
    ).toBe('full');
    expect(parsePositionDomainDecision('{"action":"full","reason":"域内","confidence":0.9}', roster)).toEqual({
      action: 'full',
      reason: '域内',
    });
  });
});

describe('cache keys and freshness', () => {
  it('normalizes whitespace, case and width so near-identical tasks share a key', () => {
    expect(normalizeDecisionInput('  查一下   CNS客户 ')).toBe(normalizeDecisionInput('查一下 CNS客户'));
    expect(normalizeDecisionInput('ABC任务')).toBe(normalizeDecisionInput('abc任务'));
  });
  it('caps the key length so a novel cannot blow up the cache', () => {
    expect(normalizeDecisionInput('长'.repeat(9999)).length).toBeLessThanOrEqual(2000);
  });
  it('separates kinds and scopes in the key', () => {
    expect(decisionCacheKey('supervisor-reuse', 'supervisor', '任务A')).not.toBe(
      decisionCacheKey('position-domain', 'forwarder', '任务A')
    );
  });
  it('freshness follows the expiry stamp', () => {
    expect(isCacheEntryFresh({ verdict: { action: 'full', reason: 'x' }, expiresAt: 110 }, 100)).toBe(true);
    expect(isCacheEntryFresh({ verdict: { action: 'full', reason: 'x' }, expiresAt: 90 }, 100)).toBe(false);
    expect(isCacheEntryFresh(undefined, 100)).toBe(false);
  });
});

describe('activeTeamsForDecision', () => {
  it('keeps only matchable teams, freshest first', () => {
    const teams = [
      team({ teamId: 'old', lastUsedAt: 1, expiresAt: 200 }),
      team({ teamId: 'fresh', lastUsedAt: 5, expiresAt: 200 }),
      team({ teamId: 'expired', expiresAt: 50, lastUsedAt: 9 }),
      team({ teamId: 'gone', deletedAt: 10, lastUsedAt: 9, expiresAt: 200 }),
      team({ teamId: 'perm', permanent: true, expiresAt: 50, lastUsedAt: 3 }),
    ];
    expect(activeTeamsForDecision(teams, 100).map((entry) => entry.teamId)).toEqual(['fresh', 'perm', 'old']);
  });
});

describe('prompt builders', () => {
  it('the reuse prompt lists team ids, names and roster; demands the one-line JSON', () => {
    const prompt = buildSupervisorReusePrompt({ task: '查一下 CNS 客户', teams: [team()], roster });
    expect(prompt.user).toContain('t1');
    expect(prompt.user).toContain('货代小队');
    expect(prompt.user).toContain('货代(forwarder)');
    expect(prompt.user).toContain('video-lab');
    expect(prompt.user).toContain('{"action":"reuse"');
    expect(prompt.system).toContain('JSON');
  });
  it('the domain prompt carries the position and demands a roster id in suggest', () => {
    const prompt = buildPositionDomainPrompt({ task: '做个宣传视频', position: roster[0], roster });
    expect(prompt.user).toContain('货代(forwarder)');
    expect(prompt.user).toContain('做个宣传视频');
    expect(prompt.user).toContain('岗位说明书正文');
    expect(prompt.user).toContain('{"action":"reject"');
  });
  it('an empty team list says so instead of implying choices', () => {
    const prompt = buildSupervisorReusePrompt({ task: '任务', teams: [], roster });
    expect(prompt.user).toContain('无现役团队');
  });
});
