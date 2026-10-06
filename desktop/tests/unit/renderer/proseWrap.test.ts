/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The sentences a person reads under a setting, a page title or a step of the guide never end on a line of one or two
 * characters (「准。」 alone, 「情做完。」 split from 「事」): their lines are balanced. `text-wrap: pretty` is not
 * enough: measured in the app (Chromium 152), it leaves 「直到把事 / 情做完。」 exactly where plain wrapping puts it,
 * while `balance` breaks the guide's lead as 「……它读你的项目、 / 改代码、跑命令和测试，直到把事情做完。」.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const renderer = resolve(__dirname, '../../../packages/desktop/src/renderer');
const read = (path: string): string => readFileSync(resolve(renderer, path), 'utf8');

/** The body of the rule whose selector is exactly `selector`. */
const rule = (css: string, selector: string): string => {
  const start = css.indexOf(`\n${selector} {`);
  return start < 0 ? '' : css.slice(start, css.indexOf('\n}', start));
};

const PROSE: Record<string, string[]> = {
  // The sentence under a setting's row, once it is opened from its one line.
  'components/settings/OneLine.module.css': ['.open'],
  'pages/settings/KyrnSettings/sections/sections.module.css': [
    '.cardSummary',
    '.meta',
    '.choiceDescription',
    '.choiceHint',
  ],
  'pages/settings/KyrnSettings/providers/providers.module.css': ['.hint'],
  'pages/welcome/Welcome.module.css': ['.lead', '.pointText', '.subtitle', '.note'],
  // The board tab's own explanations: what the switch does, what it costs, what comes.
  'pages/conversation/KyrnPanel/Board/Board.module.css': ['.offText', '.faint', '.empty'],
};

describe('prose wrapping', () => {
  it.each(Object.entries(PROSE))('balances the lines of the texts in %s', (path, selectors) => {
    const css = read(path);
    for (const selector of selectors) expect(rule(css, selector), selector).toContain('text-wrap: balance');
  });

  it('does the same for the description under every settings page title, and every row says its own in one line', () => {
    expect(read('pages/settings/components/SettingsPageHeader.tsx')).toContain("style={{ textWrap: 'balance' }}");
    expect(read('components/settings/SettingsModal/contents/SystemModalContent/PreferenceRow.tsx')).toContain(
      '<OneLine text={description} />'
    );
    expect(read('pages/settings/KyrnSettings/fields/Row.tsx')).toContain('<OneLine text={help} />');
  });
});
