/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import type { SupervisorTeam } from '@/common/chat/team/supervisor/supervisorCore';
import {
  buildPositionDomainAsk,
  buildSupervisorReuseAsk,
  choicesOfAsk,
  jevChoiceToDecisionJson,
  jevGate,
  parseJevChoice,
  sanitizeEngineState,
  MU_ENGINE_ACT_PROBABILITY,
  MU_ENGINE_ESCALATE_PROBABILITY,
} from '@/common/chat/team/quickDecision/muEngineCore';

/**
 * The MU decision engine's pure half: the privacy gate (decision-rsi-
 * kernel's redaction set), the System One question builders, and — the
 * four-way comparison's key finding — the gate that reads
 * `probabilities[choice]`, never the `confidence` field.
 */

const position = (name: string, displayName: string, description: string): PositionInfo => ({
  name,
  displayName,
  description,
  body: `${displayName} 说明书。`,
});

const roster = [
  position('forwarder', '货代', '海运订舱'),
  position('video-lab', '视频实验室', '视频制作'),
  position('copywriter', '文案', '文案撰写'),
];

const team = (teamId: string, name: string, positions: string[]): SupervisorTeam => ({
  name,
  positions,
  createdAt: 1,
  lastUsedAt: 2,
  expiresAt: 1_000_000,
  ttlDays: 7,
  permanent: false,
  deletedAt: undefined,
  teamId,
  leadConversationId: 'c1',
});

describe('sanitizeEngineState — the privacy gate before anything leaves the machine', () => {
  it('redacts the four decision-rsi-kernel classes: email, domain, company, drive path', () => {
    const state = sanitizeEngineState({
      task: '联系 a.b@acme-corp.com 查 https://foo.example.com/x 和 Acme Co., Ltd. 以及 E:\\Docs\\合同.txt',
    });
    const task = state.task as string;
    expect(task).not.toContain('acme-corp.com');
    expect(task).toContain('[EMAIL]');
    expect(task).toContain('[DOMAIN]');
    expect(task).toContain('[COMPANY]');
    expect(task).toContain('[PATH]');
  });
  it('caps every string at 200 characters, arrays included', () => {
    const state = sanitizeEngineState({ lines: ['x'.repeat(500)], task: 'y'.repeat(300) });
    expect((state.lines as string[])[0]).toHaveLength(200);
    expect(state.task).toHaveLength(200);
  });
  it('leaves plain task text untouched apart from the redactions', () => {
    expect(sanitizeEngineState({ task: '查一下 CNS 客户是否已合作' })).toEqual({ task: '查一下 CNS 客户是否已合作' });
  });
});

describe('the System One builders — criteria are the verdict space', () => {
  const teams = [team('t1', '货代小队', ['forwarder']), team('t2', '内容队', ['copywriter'])];
  it('point A offers one choice per active team plus full, and only those', () => {
    const payload = buildSupervisorReuseAsk({ task: '查运价', teams, roster });
    expect(choicesOfAsk(payload)).toEqual(['reuse:t1', 'reuse:t2', 'full']);
    expect(payload.state.mode).toBe('supervisor-reuse');
    expect(payload.questions.q.type).toBe('choice');
  });
  it('point B offers reject choices for every roster position except the own one', () => {
    const payload = buildPositionDomainAsk({ task: '剪视频', position: roster[0]!, roster });
    expect(choicesOfAsk(payload)).toEqual(['reject:video-lab', 'reject:copywriter', 'full']);
  });
});

describe('parseJevChoice — the gate reads probabilities[choice], not confidence', () => {
  const valid = ['reuse:t1', 'full'];
  it('returns the chosen option and ITS probability', () => {
    const verdict = parseJevChoice(
      { type: 'choice', choice: 'reuse:t1', probabilities: { 'reuse:t1': 0.96, full: 0.04 }, confidence: 0.94 },
      valid
    );
    expect(verdict).toEqual({ choice: 'reuse:t1', probability: 0.96 });
  });
  it('scenario a2 shape: confidence 0.57 but probability 0.84 — the probability is what gates', () => {
    const verdict = parseJevChoice(
      { type: 'choice', choice: 'reuse:t1', probabilities: { 'reuse:t1': 0.8354, full: 0.132 }, confidence: 0.5746 },
      valid
    );
    expect(verdict?.probability).toBe(0.8354);
  });
  it('a confident answer without probabilities is NO answer', () => {
    expect(parseJevChoice({ type: 'choice', choice: 'reuse:t1', confidence: 0.99 }, valid)).toBeUndefined();
  });
  it('a choice outside the criteria we sent is NO answer', () => {
    expect(
      parseJevChoice({ type: 'choice', choice: 'reuse:别的队', probabilities: { 'reuse:别的队': 0.99 } }, valid)
    ).toBeUndefined();
  });
  it('non-finite probabilities, non-objects and non-choice types are no answer', () => {
    expect(parseJevChoice({ type: 'score', choice: 'full', probabilities: { full: 1 } }, valid)).toBeUndefined();
    expect(parseJevChoice(undefined, valid)).toBeUndefined();
    expect(
      parseJevChoice({ type: 'choice', choice: 'full', probabilities: { full: Number.NaN } }, valid)
    ).toBeUndefined();
  });
});

describe('jevGate — the three probability bands', () => {
  it('acts at and above 0.85, escalates in [0.5, 0.85), reads full below 0.5', () => {
    expect(jevGate(MU_ENGINE_ACT_PROBABILITY)).toBe('act');
    expect(jevGate(0.99)).toBe('act');
    expect(jevGate(MU_ENGINE_ESCALATE_PROBABILITY)).toBe('escalate');
    expect(jevGate(0.84)).toBe('escalate');
    expect(jevGate(0.49)).toBe('full');
    expect(jevGate(0)).toBe('full');
  });
});

describe('jevChoiceToDecisionJson — L1 funnels into the strict parsers', () => {
  it('a reuse choice becomes the decision JSON parseSupervisorReuseDecision accepts', () => {
    expect(JSON.parse(jevChoiceToDecisionJson('supervisor-reuse', 'reuse:t1', 0.93)!)).toEqual({
      action: 'reuse',
      teamId: 't1',
      reason: 'jev 概率 0.93',
      confidence: 0.93,
    });
  });
  it('a reject choice carries the roster id, a full choice stays full', () => {
    expect(JSON.parse(jevChoiceToDecisionJson('position-domain', 'reject:video-lab', 0.9)!)).toMatchObject({
      action: 'reject',
      suggest: 'video-lab',
      confidence: 0.9,
    });
    expect(JSON.parse(jevChoiceToDecisionJson('supervisor-reuse', 'full', 0.9)!)).toMatchObject({
      action: 'full',
      confidence: 0.9,
    });
  });
  it('a choice that names no verdict of the kind is undefined, not a guess', () => {
    expect(jevChoiceToDecisionJson('supervisor-reuse', 'reject:video-lab', 0.9)).toBeUndefined();
    expect(jevChoiceToDecisionJson('position-domain', 'reuse:t1', 0.9)).toBeUndefined();
  });
});
