/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mediaPathsOf } from '@/renderer/pages/conversation/Messages/components/messageTextMedia';

describe('mediaPathsOf', () => {
  it('collects the local images and videos a reply embeds, and only those', () => {
    const text = [
      'before',
      '![card](E:/out/card.png)',
      '![demo](./out/demo.mp4)',
      '![remote](https://example.com/x.png)',
      '![doc](F:/docs/report.pdf)',
      '![encoded](F:/%E6%8A%A5%E5%91%8A/shot.webp)',
      'after',
    ].join('\n');
    expect(mediaPathsOf(text)).toEqual(['E:/out/card.png', './out/demo.mp4', 'F:/报告/shot.webp']);
  });
});
