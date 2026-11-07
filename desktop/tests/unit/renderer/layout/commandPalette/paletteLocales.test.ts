/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CONFIG_PATH = path.join(REPO_ROOT, 'packages/desktop/src/common/config/i18n-config.json');
const LOCALES_DIR = path.join(REPO_ROOT, 'packages/desktop/src/renderer/services/i18n/locales');

const { supportedLanguages } = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { supportedLanguages: string[] };

const PALETTE_KEYS = [
  'title',
  'placeholder',
  'groups.conversations',
  'groups.settings',
  'groups.commands',
  'searchMessages',
  'empty',
  'commandWaits',
  'actions.quickOpen',
];

/** Quick open's own strings (common.quickOpen). */
const QUICK_OPEN_KEYS = ['title', 'placeholder', 'loading', 'failed', 'more', 'noFolder'];

const paletteCopy = (lang: string): Record<string, unknown> => {
  const common = JSON.parse(readFileSync(path.join(LOCALES_DIR, lang, 'common.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  return (common.commandPalette ?? {}) as Record<string, unknown>;
};

const valueAt = (copy: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], copy);

describe('command palette copy', () => {
  it('covers all thirteen languages', () => {
    expect(supportedLanguages).toHaveLength(13);
  });

  it.each(supportedLanguages)('has every palette string in %s', (lang) => {
    const copy = paletteCopy(lang);
    for (const key of PALETTE_KEYS) {
      const value = valueAt(copy, key);
      expect(typeof value, `${lang} common.commandPalette.${key}`).toBe('string');
      expect((value as string).trim().length, `${lang} common.commandPalette.${key} is empty`).toBeGreaterThan(0);
    }
  });

  it.each(supportedLanguages)('has every quick open string in %s', (lang) => {
    const common = JSON.parse(readFileSync(path.join(LOCALES_DIR, lang, 'common.json'), 'utf8')) as {
      quickOpen?: Record<string, unknown>;
    };
    for (const key of QUICK_OPEN_KEYS) {
      const value = common.quickOpen?.[key];
      expect(typeof value === 'string' && value.trim().length > 0, `${lang} common.quickOpen.${key}`).toBe(true);
    }
  });

  it.each(supportedLanguages)('keeps the query in the message-search row in %s', (lang) => {
    expect(valueAt(paletteCopy(lang), 'searchMessages')).toContain('{{query}}');
  });
});
