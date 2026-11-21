/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  POSITION_THINKING_LEVELS,
  buildThinkingLevelPrompt,
  clampThinkingLevelTo,
  isSystemChoreText,
  parsePositionThinkingField,
  parseThinkingLevelDecision,
} from '@/common/chat/team/thinkingLevel/thinkingLevelCore';

/** The four-level vocabulary, the chore texts, and the ⚡ complexity verdict: the conservative direction is `keep`. */
describe('parsePositionThinkingField', () => {
  it('accepts the four levels in any casing or spacing', () => {
    for (const level of POSITION_THINKING_LEVELS) {
      expect(parsePositionThinkingField(` ${level.toUpperCase()} `)).toBe(level);
    }
  });
  it('anything else — pi-only levels, junk, empty, absent — reads as no declaration', () => {
    expect(parsePositionThinkingField('minimal')).toBeUndefined();
    expect(parsePositionThinkingField('xhigh')).toBeUndefined();
    expect(parsePositionThinkingField('很高')).toBeUndefined();
    expect(parsePositionThinkingField('  ')).toBeUndefined();
    expect(parsePositionThinkingField(undefined)).toBeUndefined();
  });
});

describe('isSystemChoreText', () => {
  it('any wire marker opening the text is a chore, wherever it was wrapped', () => {
    expect(isSystemChoreText('[[MU_TEAM_RECEIPT]] {"completed":1}')).toBe(true);
    expect(isSystemChoreText('  [[MU_WEBHOOK]] source=x')).toBe(true);
    expect(isSystemChoreText('[[MU_INSPECTION]] 2026-11-22')).toBe(true);
  });
  it('a plain task is not a chore, even when it mentions a marker mid-text', () => {
    expect(isSystemChoreText('查一下 CNS 客户')).toBe(false);
    expect(isSystemChoreText('把 [[MU_TEAM_RECEIPT]] 这个标记解释给我听')).toBe(false);
  });
});

describe('buildThinkingLevelPrompt', () => {
  it('carries the task, the four bars and the two-answer contract', () => {
    const { system, user } = buildThinkingLevelPrompt('设计新的权限系统架构');
    expect(system).toContain('一行 JSON');
    expect(user).toContain('设计新的权限系统架构');
    expect(user).toContain('"off|low|medium|high"');
    expect(user).toContain('- high：规划/架构/评审/跨域整合');
    expect(user).toContain('拿不准就 keep');
  });
});

describe('parseThinkingLevelDecision', () => {
  const options = { minConfidence: 0.8 };
  it('a committed set parses to its level', () => {
    expect(
      parseThinkingLevelDecision('{"action":"set","level":"low","reason":"简单","confidence":0.9}', options)
    ).toEqual({ action: 'set', level: 'low', reason: '简单', confidence: 0.9 });
  });
  it('a fenced or prose-wrapped answer still parses', () => {
    const raw = '```json\n{"action":"set","level":"high","reason":"架构","confidence":0.95}\n```';
    expect(parseThinkingLevelDecision(raw, options)).toEqual({
      action: 'set',
      level: 'high',
      reason: '架构',
      confidence: 0.95,
    });
  });
  it('keep is passed through with the model reason', () => {
    expect(parseThinkingLevelDecision('{"action":"keep","reason":"跨档","confidence":0.6}', options)).toEqual({
      action: 'keep',
      reason: '跨档',
    });
  });
  it('every doubt maps to keep: unparseable, unknown action, unnamed level, low confidence', () => {
    expect(parseThinkingLevelDecision('不输出 JSON', options)).toEqual({
      action: 'keep',
      reason: 'unparseable-answer',
    });
    expect(parseThinkingLevelDecision('{"action":"boost","reason":"x","confidence":0.99}', options)).toEqual({
      action: 'keep',
      reason: 'unknown-action',
    });
    expect(
      parseThinkingLevelDecision('{"action":"set","level":"turbo","reason":"x","confidence":0.99}', options)
    ).toEqual({ action: 'keep', reason: 'level-not-named' });
    expect(parseThinkingLevelDecision('{"action":"set","level":"low","reason":"x","confidence":0.5}', options)).toEqual(
      {
        action: 'keep',
        reason: 'confidence-under-bar',
      }
    );
  });
});

describe('clampThinkingLevelTo', () => {
  it('the requested level passes when offered', () => {
    expect(clampThinkingLevelTo('low', ['off', 'low', 'medium', 'high'])).toBe('low');
  });
  it('a missing level steps down first — the cheaper direction', () => {
    expect(clampThinkingLevelTo('low', ['off', 'medium', 'high'])).toBe('off');
    expect(clampThinkingLevelTo('high', ['low', 'medium'])).toBe('medium');
  });
  it('a level below everything offered steps up to the lowest offered', () => {
    expect(clampThinkingLevelTo('off', ['low', 'medium', 'high'])).toBe('low');
    expect(clampThinkingLevelTo('off', ['medium'])).toBe('medium');
  });
  it('an empty or alien option list answers undefined — the caller leaves the level alone', () => {
    expect(clampThinkingLevelTo('low', [])).toBeUndefined();
    expect(clampThinkingLevelTo('low', ['别的档'])).toBeUndefined();
  });
});
