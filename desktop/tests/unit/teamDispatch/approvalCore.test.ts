/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Risk-tiered approval (batch L ③): the three tiers a position frontmatter
 * may declare, the tier texts (the four risk categories, the payment iron
 * line that survives even `none`), and the group block's mode-driven merge
 * into a team workspace's AGENTS.md.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_PAYMENT_IRON_LINE,
  APPROVAL_RISK_ACTIONS,
  TEAM_APPROVAL_DEFAULT,
  planTeamApprovalSeed,
  positionApprovalGateLines,
  teamApprovalBlockOf,
  parseApprovalField,
  effectiveApprovalMode,
} from '@/common/chat/team/teamDispatch/approvalCore';

describe('parseApprovalField', () => {
  it('settles the three spellings; anything else reads as no declaration (the default applies)', () => {
    expect(parseApprovalField('risk-only')).toBe('risk-only');
    expect(parseApprovalField(' all ')).toBe('all');
    expect(parseApprovalField('NONE')).toBe('none');
    expect(parseApprovalField('sometimes')).toBeUndefined();
    expect(parseApprovalField(undefined)).toBeUndefined();
    expect(effectiveApprovalMode(undefined)).toBe(TEAM_APPROVAL_DEFAULT);
    expect(effectiveApprovalMode('all')).toBe('all');
  });
});

describe('positionApprovalGateLines', () => {
  it('risk-only (the default): the four categories must ask, everything else runs', () => {
    const lines = positionApprovalGateLines(undefined).join('\n');
    expect(lines).toContain('本岗审批档位：risk-only');
    for (const action of APPROVAL_RISK_ACTIONS) expect(lines).toContain(action);
    expect(lines).toContain('其余动作不逐件请示');
  });

  it('all: every write asks, reads stay free', () => {
    const lines = positionApprovalGateLines('all').join('\n');
    expect(lines).toContain('全部写操作须先问');
    expect(lines).toContain('纯读取类动作（读文件、查询、检索、汇总）不需逐件请示');
  });

  it('none: no per-action approval — but the payment iron line survives every tier', () => {
    for (const tier of ['risk-only', 'all', 'none'] as const) {
      expect(positionApprovalGateLines(tier).join('\n')).toContain(APPROVAL_PAYMENT_IRON_LINE);
    }
    const lines = positionApprovalGateLines('none').join('\n');
    expect(lines).toContain('不逐件审批');
    expect(lines).toContain(APPROVAL_PAYMENT_IRON_LINE);
  });
});

describe('the group block', () => {
  it('says it overrides the seats own tiers, between its markers', () => {
    const block = teamApprovalBlockOf('all');
    expect(block.startsWith('<!-- mu-team-approval v1 -->')).toBe(true);
    expect(block.endsWith('<!-- /mu-team-approval -->')).toBe(true);
    expect(block).toContain('本群审批模式：all');
    expect(block).toContain('冲突时以本节为准');
  });

  it('an empty workspace gains the block; a same-mode block stays put', () => {
    const seeded = planTeamApprovalSeed(undefined, 'risk-only');
    expect(seeded.changed).toBe(true);
    expect(seeded.next.startsWith('<!-- mu-team-approval v1 -->')).toBe(true);
    const again = planTeamApprovalSeed(`${seeded.next}\n`, 'risk-only');
    expect(again.changed).toBe(false);
    expect(again.next).toBe(`${seeded.next}\n`);
  });

  it('a mode switch replaces the block in place, the rest of the file untouched', () => {
    const user = '# 团队自己的说明\n';
    const first = planTeamApprovalSeed(user, 'risk-only').next;
    const switched = planTeamApprovalSeed(first, 'none');
    expect(switched.changed).toBe(true);
    expect(switched.next.startsWith(user)).toBe(true);
    expect(switched.next).toContain('本群审批模式：none');
    expect(switched.next).not.toContain('本群审批模式：risk-only');
    // One block only: the old one was replaced, not appended beside.
    expect(switched.next.match(/<!-- mu-team-approval v1 -->/g)).toHaveLength(1);
  });

  it('a user file without markers keeps its content and gains the block after it', () => {
    const user = '# 用户笔记\n\n- 一条';
    const plan = planTeamApprovalSeed(user, 'all');
    expect(plan.changed).toBe(true);
    expect(plan.next.startsWith(user)).toBe(true);
    expect(plan.next).toContain(teamApprovalBlockOf('all'));
  });
});
