/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  hasBackgroundBlock,
  injectBackgroundCssBlock,
  BACKGROUND_BLOCK_START,
  BACKGROUND_BLOCK_END,
} from '@/renderer/pages/settings/AppearanceSettings/backgroundUtils';

describe('backgroundUtils', () => {
  const testImageUrl = 'data:image/png;base64,iVBORw0KGg';

  it('injects background block into empty CSS', () => {
    const result = injectBackgroundCssBlock('', testImageUrl);
    expect(result).toContain(BACKGROUND_BLOCK_START);
    expect(result).toContain(BACKGROUND_BLOCK_END);
    expect(result).toContain(`url("${testImageUrl}")`);
  });

  it('injects background block into CSS without existing block', () => {
    const existingCss = `body { color: red; }`;
    const result = injectBackgroundCssBlock(existingCss, testImageUrl);
    expect(result).toContain(existingCss);
    expect(result).toContain(BACKGROUND_BLOCK_START);
    expect(result).toContain(BACKGROUND_BLOCK_END);
    expect(result).toContain(`url("${testImageUrl}")`);
  });

  it('replaces existing background block with new one', () => {
    const oldImageUrl = 'data:image/png;base64,OLD';
    const existingCss = `body { color: red; }\n${BACKGROUND_BLOCK_START}\nbody { background-image: url("${oldImageUrl}"); }\n${BACKGROUND_BLOCK_END}\nfooter { color: blue; }`;
    const result = injectBackgroundCssBlock(existingCss, testImageUrl);

    expect(result).toContain(BACKGROUND_BLOCK_START);
    expect(result).toContain(BACKGROUND_BLOCK_END);
    expect(result).toContain(`url("${testImageUrl}")`);
    expect(result).not.toContain(oldImageUrl);
    expect(result).toContain('body { color: red; }');
    expect(result).toContain('footer { color: blue; }');
  });

  it('handles CSS with multiple whitespace variations', () => {
    const cssWithSpaces = `  body { color: red; }  \n\n  `;
    const result = injectBackgroundCssBlock(cssWithSpaces, testImageUrl);
    expect(result).toContain('body { color: red; }');
    expect(result).toContain(BACKGROUND_BLOCK_START);
  });

  it('generates correct CSS structure with all required selectors', () => {
    const result = injectBackgroundCssBlock('', testImageUrl);
    expect(result).toContain('body,');
    expect(result).toContain('html,');
    expect(result).toContain('.arco-layout,');
    expect(result).toContain('.app-shell');
    expect(result).toContain('background-size: cover');
    expect(result).toContain('background-attachment: fixed');
  });

  it('removes old block completely when replacing', () => {
    const existingCss = `${BACKGROUND_BLOCK_START}\nOLD BLOCK CONTENT\n${BACKGROUND_BLOCK_END}`;
    const result = injectBackgroundCssBlock(existingCss, testImageUrl);
    expect(result).not.toContain('OLD BLOCK CONTENT');
    const startCount = result.split(BACKGROUND_BLOCK_START).length - 1;
    const endCount = result.split(BACKGROUND_BLOCK_END).length - 1;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it('replaces a block an earlier version wrote, under its old markers', () => {
    const existingCss = `body { color: red; }\n/* AionUi Theme Background Start */\nOLD\n/* AionUi Theme Background End */`;
    const result = injectBackgroundCssBlock(existingCss, testImageUrl);
    expect(result).not.toContain('OLD');
    expect(result).not.toContain('AionUi Theme Background');
    expect(result).toContain('body { color: red; }');
    expect(result).toContain(BACKGROUND_BLOCK_START);
    expect(hasBackgroundBlock(existingCss)).toBe(true);
  });

  it('preserves other CSS when no existing block', () => {
    const css = `.class1 { color: blue; }\n.class2 { color: green; }`;
    const result = injectBackgroundCssBlock(css, testImageUrl);
    expect(result).toContain('.class1 { color: blue; }');
    expect(result).toContain('.class2 { color: green; }');
  });

  it('handles empty image URL by returning empty string for new CSS', () => {
    const result = injectBackgroundCssBlock('', '');
    expect(result).toBe('');
  });

  it('removes existing block when image URL is empty', () => {
    const existingCss = `body { color: red; }\n${BACKGROUND_BLOCK_START}\nBACKGROUND\n${BACKGROUND_BLOCK_END}`;
    const result = injectBackgroundCssBlock(existingCss, '');
    expect(result).toBe('body { color: red; }');
    expect(result).not.toContain(BACKGROUND_BLOCK_START);
  });
});
