/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * The supervisor workspace's template script (common/chat/team/supervisor/
 * templates.cjs), run for real against a fixture catalog: the search/get
 * CLI behind the supervisor's rule 6, and — the part the rules depend on —
 * the degrade: a missing or broken cache is `UNAVAILABLE` on stdout with
 * exit 0, never an ERROR the supervisor's rule 3 would stop on. The search
 * spec mirrors templateCatalogCore.ts; templateCatalogCore.test.ts holds
 * the other end of that contract.
 */

const SCRIPT_SRC = fileURLToPath(
  new URL('../../../packages/desktop/src/common/chat/team/supervisor/templates.cjs', import.meta.url)
);
const run = promisify(execFile);

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-templates-script-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixtureEntries = [
  {
    slug: 'podcast-notes',
    name: 'Podcast Notes',
    summary: 'Chops each podcast episode into chapter notes with a summary',
    summary_zh: '把每期播客切成章节笔记并写好摘要',
    category: 'content-publishing',
    tags: ['podcast', 'notes'],
    import: 'https://x.ai/bot/abc',
    verified: true,
    updated: '2026-09-16',
  },
  {
    slug: 'podcast-clipper',
    name: 'Podcast Clipper',
    summary: 'Cuts viral clips out of long podcast episodes',
    summary_zh: '从长播客里剪出传播片段',
    category: 'content-publishing',
    tags: ['audio'],
    import: 'https://x.ai/bot/def',
    verified: false,
    updated: '2026-10-01',
  },
  {
    slug: 'invoice-chaser',
    name: 'Invoice Chaser',
    summary: 'Chases overdue invoices politely',
    summary_zh: '礼貌追讨逾期发票',
    category: 'finance-ops',
    tags: ['invoice'],
    import: 'https://x.ai/bot/ghi',
  },
];

const writeCatalog = (dir: string, catalog: string): string => {
  const file = join(dir, 'catalog.json');
  writeFileSync(file, catalog, 'utf8');
  return file;
};

const exec = async (args: string[], catalogFile: string, expectCode0 = true) => {
  const promise = run('node', [SCRIPT_SRC, ...args], { env: { ...process.env, MU_TEMPLATE_CATALOG: catalogFile } });
  if (expectCode0) return (await promise).stdout;
  await expect(promise).rejects.toMatchObject({ code: 1 });
  return undefined;
};

describe('templates.cjs search', () => {
  it('answers the top matches with name, summary, category and slug, then the count', async () => {
    const dir = temp();
    const file = writeCatalog(dir, JSON.stringify({ entries: fixtureEntries }));
    const stdout = await exec(['search', 'podcast'], file);
    const lines = stdout.trim().split(/\r?\n/);
    expect(lines.at(-1)).toBe('COUNT 2');
    // Both names hit 'podcast' with the same weight; the slug order breaks the tie.
    expect(lines[0]).toContain('TEMPLATE Podcast Clipper');
    expect(lines[1]).toContain('TEMPLATE Podcast Notes');
    expect(lines[1]).toContain('把每期播客切成章节笔记并写好摘要');
    expect(lines[1]).toContain('content-publishing');
    expect(lines[1]).toContain('slug=podcast-notes');
  });

  it('matches a CJK phrase, honors --category and --limit', async () => {
    const dir = temp();
    const file = writeCatalog(dir, JSON.stringify({ entries: fixtureEntries }));
    expect(await exec(['search', '逾期发票'], file)).toContain('invoice-chaser');
    expect(await exec(['search', 'podcast', '--category', 'finance-ops'], file)).toContain('COUNT 0');
    expect(await exec(['search', 'e', '--limit', '1'], file)).toContain('COUNT 1');
  });

  it('refuses an empty query as a usage error', async () => {
    const dir = temp();
    const file = writeCatalog(dir, JSON.stringify({ entries: fixtureEntries }));
    await exec(['search', '   '], file, false);
  });
});

describe('templates.cjs get', () => {
  it('prints one entry whole, the share link included', async () => {
    const dir = temp();
    const file = writeCatalog(dir, JSON.stringify({ entries: fixtureEntries }));
    const stdout = await exec(['get', 'podcast-notes'], file);
    expect(stdout).toContain('name: Podcast Notes');
    expect(stdout).toContain('summary_zh: 把每期播客切成章节笔记并写好摘要');
    expect(stdout).toContain('import: https://x.ai/bot/abc');
    expect(stdout).toContain('(verified)');
  });

  it('answers an unknown slug as NOT_FOUND, not an error', async () => {
    const dir = temp();
    const file = writeCatalog(dir, JSON.stringify({ entries: fixtureEntries }));
    const stdout = await exec(['get', 'no-such-slug'], file);
    expect(stdout.trim()).toBe('NOT_FOUND no-such-slug');
  });
});

describe('templates.cjs without a usable catalog', () => {
  it('degrades to UNAVAILABLE with exit 0 when the cache is missing, broken, or empty', async () => {
    const dir = temp();
    mkdirSync(dir, { recursive: true });
    expect((await exec(['search', 'podcast'], join(dir, 'absent.json'))).trim()).toMatch(/^UNAVAILABLE /);

    const broken = writeCatalog(temp(), '{ not json');
    expect((await exec(['search', 'podcast'], broken)).trim()).toMatch(/^UNAVAILABLE /);

    const empty = writeCatalog(temp(), JSON.stringify({ entries: [{ slug: 'x' }] }));
    expect((await exec(['get', 'x'], empty)).trim()).toMatch(/^UNAVAILABLE /);
  });
});
