/**
 * What an earlier version left under its old names is found under mu's: the local storage keys move once, and the
 * theme painted before the renderer starts reads the old theme keys too.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_STORAGE_KEYS, migrateLegacyStorageKeys } from '@/common/platform/legacyNames';

const RENDERER = path.resolve(__dirname, '../../../packages/desktop/src/renderer');

function rendererSources(dir = RENDERER): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return rendererSources(full);
    return /\.(ts|tsx)$/.test(name) ? [readFileSync(full, 'utf8')] : [];
  });
}

/** The pre-paint script of the renderer's page, run as the page runs it. */
function paintTheme(): void {
  const html = readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error('index.html has no inline script');
  new Function(script)();
}

describe('the names of an earlier version', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => document.documentElement.removeAttribute('data-theme'));

  it('moves a value stored under an old key to its current key, and drops the old key', () => {
    localStorage.setItem('aionui_cron_unread', '["c1"]');

    migrateLegacyStorageKeys(localStorage);

    expect(localStorage.getItem('mu_cron_unread')).toBe('["c1"]');
    expect(localStorage.getItem('aionui_cron_unread')).toBeNull();
  });

  it('keeps what the current key already holds', () => {
    localStorage.setItem('aionui.emoji.recent', '["old"]');
    localStorage.setItem('mu.emoji.recent', '["new"]');

    migrateLegacyStorageKeys(localStorage);

    expect(localStorage.getItem('mu.emoji.recent')).toBe('["new"]');
    expect(localStorage.getItem('aionui.emoji.recent')).toBeNull();
  });

  it('writes nothing when there is nothing to move', () => {
    migrateLegacyStorageKeys(localStorage);

    expect(localStorage.length).toBe(0);
  });

  it('moves each old key to a key the renderer reads', () => {
    const sources = rendererSources().join('\n');
    for (const [, current] of LEGACY_STORAGE_KEYS) expect(sources, current).toContain(`'${current}'`);
  });

  it('paints the theme an earlier version saved, before the renderer moves its key', () => {
    localStorage.setItem('__aionui_theme', 'dark');

    paintTheme();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('paints the theme saved under the current key over an old one', () => {
    localStorage.setItem('__aionui_theme', 'dark');
    localStorage.setItem('__mu_theme', 'light');

    paintTheme();

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
