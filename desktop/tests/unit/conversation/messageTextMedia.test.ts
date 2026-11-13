/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mediaPathsOf } from '@/renderer/pages/conversation/Messages/components/messageTextMedia';

describe('mediaPathsOf', () => {
  it('collects local images and videos, resolves relative paths against workspace, and skips remote/non-media', () => {
    const text = [
      'before',
      '![card](E:/out/card.png)',
      '![demo](./out/demo.mp4)',
      '![remote](https://example.com/x.png)',
      '![doc](F:/docs/report.pdf)',
      '![encoded](F:/%E6%8A%A5%E5%91%8A/shot.webp)',
      '![bad-percent](out/100%raw.png)',
      'after',
    ].join('\n');
    expect(mediaPathsOf(text)).toEqual([
      'E:/out/card.png',
      './out/demo.mp4',
      'F:/报告/shot.webp',
      'out/100%raw.png',
    ]);
    expect(mediaPathsOf(text, '/Users/demo/project')).toEqual([
      'E:/out/card.png',
      '/Users/demo/project/out/demo.mp4',
      'F:/报告/shot.webp',
      '/Users/demo/project/out/100%raw.png',
    ]);
  });
});
