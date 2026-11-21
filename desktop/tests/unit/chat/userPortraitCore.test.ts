/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  USER_PORTRAIT_CAP,
  buildUserPortraitSkeleton,
  userPortraitSectionLines,
} from '@/common/chat/team/positions/userPortraitCore';

/**
 * The user portrait's pure half: the first-start skeleton (instruction
 * comments plus suggested sections, written once and then the user's) and
 * the gate section that carries the portrait — capped, and silent when
 * there is nothing to carry.
 */
describe('buildUserPortraitSkeleton', () => {
  it('is a teachable skeleton: sections for the long-lived facts, examples, and the no-secrets warning', () => {
    const skeleton = buildUserPortraitSkeleton();
    expect(skeleton).toContain('# 用户画像');
    expect(skeleton).toContain('称呼');
    expect(skeleton).toContain('工作时段');
    expect(skeleton).toContain('交付偏好');
    expect(skeleton).toContain('硬规矩');
    // The warning rides along because the text reaches every position's spawn context.
    expect(skeleton).toContain('切勿写入密钥');
    expect(skeleton).toContain('全文注入');
  });
});

describe('userPortraitSectionLines', () => {
  it('carries the portrait whole under a section that says what it is — facts to read against, not a task, not a rule', () => {
    const lines = userPortraitSectionLines('# 用户画像\n\n- 称呼：老林\n');
    expect(lines[0]).toContain('## 用户画像');
    expect(lines[0]).toContain('不是任务指令');
    expect(lines.join('\n')).toContain('- 称呼：老林');
  });

  it('is silent for an absent or blank portrait: an unfilled file injects nothing', () => {
    expect(userPortraitSectionLines(undefined)).toEqual([]);
    expect(userPortraitSectionLines('   \n ')).toEqual([]);
  });

  it('cuts an oversized portrait at the cap and says so: every gate embeds this text', () => {
    const fat = 'x'.repeat(USER_PORTRAIT_CAP + 100);
    const lines = userPortraitSectionLines(fat);
    const text = lines.join('\n');
    expect(text).not.toContain('x'.repeat(USER_PORTRAIT_CAP + 1));
    expect(text).toContain('截断');
  });
});
