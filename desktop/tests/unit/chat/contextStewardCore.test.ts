/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  parsePartSuffix,
  partNamingAvoiding,
  STEWARD_ABS_CAP_TOKENS,
  checkLineTokens,
  conservativeDecision,
  freshStewardMemory,
  partNamingFor,
  standsAtLine,
} from '@/common/chat/team/contextSteward/contextStewardCore';

/** The steward's pure half: the three-rule check line, hysteresis, part naming, and the lossless error direction. */

describe('checkLineTokens', () => {
  it('draws the line at 0.8 of usable tokens (window minus pi reserve)', () => {
    // usable = 200k - 16384 = 183616; line = 146892 (0.8), under both 0.95 and the 380k cap.
    expect(checkLineTokens(200_000)).toBe(146_892);
  });

  it('floors usable at half the window so a huge reserve cannot sink the line', () => {
    // A 20k window: window - 16384 would be 3616; the floor holds usable at 10000, line 8000.
    expect(checkLineTokens(20_000)).toBe(8000);
  });

  it('never rises past the 0.95 hard line or the 380k cap, whatever the configured ratio', () => {
    expect(checkLineTokens(1_000_000, 1)).toBe(380_000); // min(0.95×usable, 380k) — the absolute cap binds.
    expect(checkLineTokens(400_000, 1)).toBe(Math.floor((400_000 - 16384) * 0.95)); // Under the cap, 0.95 binds.
  });

  it('caps the line at 380k absolute — prefix-cache economics, not the window, decide very large sessions', () => {
    expect(checkLineTokens(2_000_000)).toBe(STEWARD_ABS_CAP_TOKENS);
    expect(checkLineTokens(2_000_000, 0.99)).toBe(STEWARD_ABS_CAP_TOKENS);
  });

  it('assumes a 500k window when the model declares none', () => {
    expect(checkLineTokens(undefined)).toBe(checkLineTokens(500_000));
    expect(checkLineTokens(0)).toBe(checkLineTokens(500_000));
  });

  it('honors a ratio override within (0, 1] and ignores anything else', () => {
    expect(checkLineTokens(200_000, 0.01)).toBe(1836); // The E2E knob: any real turn crosses it.
    expect(checkLineTokens(200_000, 0)).toBe(checkLineTokens(200_000));
    expect(checkLineTokens(200_000, 1.5)).toBe(checkLineTokens(200_000));
    expect(checkLineTokens(200_000, Number.NaN)).toBe(checkLineTokens(200_000));
  });
});

describe('standsAtLine', () => {
  const usage = { tokens: 150_000, contextWindow: 200_000, percent: 0.75 };

  it('stands over at the line and above it', () => {
    expect(standsAtLine(usage, freshStewardMemory())).toBe('over');
    expect(standsAtLine({ ...usage, tokens: 146_892 }, freshStewardMemory())).toBe('over'); // exactly at the line
  });

  it('stays below under the line', () => {
    expect(standsAtLine({ ...usage, tokens: 146_891 }, freshStewardMemory())).toBe('below');
  });

  it('reads unknown — never acts — while tokens is null (the post-compaction window)', () => {
    expect(standsAtLine({ tokens: null, contextWindow: 200_000 }, freshStewardMemory())).toBe('unknown');
  });

  it('holds hysteresis: after an action, growth under check/4 does not re-open the question', () => {
    const line = checkLineTokens(200_000); // 146892; a quarter is 36723.
    const memory = { ...freshStewardMemory(), watermark: 160_000 };
    expect(standsAtLine({ ...usage, tokens: 160_000 + line / 4 - 1 }, memory)).toBe('below');
    expect(standsAtLine({ ...usage, tokens: 160_000 + line / 4 }, memory)).toBe('over');
  });

  it('re-opens freely once tokens fall back below the watermark (a compaction happened elsewhere)', () => {
    const memory = { ...freshStewardMemory(), watermark: 160_000 };
    expect(standsAtLine({ ...usage, tokens: 100_000 }, memory)).toBe('below');
    // Grown from the new, lower state without any steward watermark in between.
    const retrained = { ...memory, watermark: undefined };
    expect(standsAtLine({ ...usage, tokens: 150_000 }, retrained)).toBe('over');
  });
});

describe('conservativeDecision', () => {
  it('falls the lossless way — switch — where a switch may happen', () => {
    expect(conservativeDecision(true)).toEqual({ action: 'switch', reason: 'steward-undecidable-lossless' });
  });

  it('falls to compact where a switch cannot happen (team-bound threads)', () => {
    expect(conservativeDecision(false)).toEqual({ action: 'compact', reason: 'steward-undecidable' });
  });
});

describe('partNamingFor', () => {
  it('numbers the first switch from a bare name', () => {
    expect(partNamingFor('货代')).toEqual({ oldTitle: '货代 (part 1)', newTitle: '货代', part: 1 });
  });

  it('increments an existing part suffix and keeps the base clean', () => {
    expect(partNamingFor('货代 (part 1)')).toEqual({ oldTitle: '货代 (part 2)', newTitle: '货代', part: 2 });
    expect(partNamingFor('货代 (part 12)')).toEqual({ oldTitle: '货代 (part 13)', newTitle: '货代', part: 13 });
  });

  it('does not read a mid-name parenthetical as a part suffix', () => {
    expect(partNamingFor('报告（终版）').part).toBe(1);
    expect(partNamingFor('报告（终版）').newTitle).toBe('报告（终版）');
  });

  it('keeps a name from collapsing when the base is only a suffix', () => {
    expect(partNamingFor('(part 3)').oldTitle).toBe('mu (part 4)');
  });
});

describe('parsePartSuffix', () => {
  it('reads the suffix a title claims', () => {
    expect(parsePartSuffix('货代 (part 1)')).toEqual({ base: '货代', part: 1 });
    expect(parsePartSuffix(' 货代 (part 12) ')).toEqual({ base: '货代', part: 12 });
  });

  it('returns undefined for a clean name, a mid-name parenthetical, or a bare suffix', () => {
    expect(parsePartSuffix('货代')).toBeUndefined();
    expect(parsePartSuffix('报告（终版）')).toBeUndefined();
    expect(parsePartSuffix('(part 3)')).toBeUndefined();
  });
});

describe('partNamingAvoiding', () => {
  it('keeps the plain numbering when no title collides', () => {
    expect(partNamingAvoiding('货代', [])).toEqual(partNamingFor('货代'));
  });

  it('bumps past a taken (part N) and reports the bumped number', () => {
    expect(partNamingAvoiding('货代', ['货代', '货代 (part 1)'])).toEqual({
      oldTitle: '货代 (part 2)',
      newTitle: '货代',
      part: 2,
    });
    expect(partNamingAvoiding('货代', ['货代 (part 1)', '货代 (part 2)']).oldTitle).toBe('货代 (part 3)');
  });

  it('matches taken titles after trimming — the backend may hand padded names', () => {
    expect(partNamingAvoiding('货代', [' 货代 (part 1) ']).oldTitle).toBe('货代 (part 2)');
  });
});
