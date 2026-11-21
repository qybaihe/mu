/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureTemplateCatalogIn,
  searchTemplatesIn,
  templateCatalogDirOf,
} from '@process/services/team/positions/templateCatalogService';
import { TEMPLATE_CATALOG_REF, TEMPLATE_CATALOG_URL } from '@/common/chat/team/positions/templateCatalogCore';

/**
 * The template catalog's service half (process/services/team/positions/
 * templateCatalogService.ts): the one-time download into the shared folder,
 * the meta stamp, the staleness the wizard hints at, and the searches the
 * wizard's tab asks for. The fetch and the clock are injected; no test here
 * touches the network.
 */

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-template-catalog-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CATALOG_TEXT = JSON.stringify({
  generated: '2026-11-20',
  entries: [
    {
      slug: 'podcast-notes',
      name: 'Podcast Notes',
      summary: 'Chops each podcast episode into chapter notes',
      summary_zh: '把每期播客切成章节笔记并写好摘要',
      category: 'content-publishing',
      tags: ['podcast'],
      import: 'https://x.ai/bot/abc',
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
  ],
});

const deps = (text: string | Error, at: number) => ({
  fetchText: text instanceof Error ? async () => Promise.reject(text) : async () => text,
  now: () => at,
});

const DAY = 24 * 60 * 60 * 1000;

describe('ensureTemplateCatalogIn', () => {
  it('downloads once into the shared folder: the catalog verbatim, the meta stamp beside it', async () => {
    const dir = temp();
    const at = 1_800_000_000_000;
    const status = await ensureTemplateCatalogIn({ templatesDir: dir }, deps(CATALOG_TEXT, at));
    expect(status).toMatchObject({ available: true, count: 2, fetchedAt: at, stale: false, errorCode: undefined });
    const templatesDir = templateCatalogDirOf(join(dir, 'data'));
    expect(templatesDir).toContain(join('positions', '_shared', 'templates'));
    expect(await readFile(join(dir, 'catalog.json'), 'utf8')).toBe(CATALOG_TEXT);
    const meta = JSON.parse(await readFile(join(dir, 'catalog.meta.json'), 'utf8')) as {
      fetched_at: string;
      count: number;
      source: string;
      source_ref: string;
    };
    expect(meta.count).toBe(2);
    expect(Date.parse(meta.fetched_at)).toBe(at);
    // The stamp records which pinned ref served, so a moved pin can be told from the cache it left.
    expect(meta.source).toBe(TEMPLATE_CATALOG_URL);
    expect(meta.source_ref).toBe(TEMPLATE_CATALOG_REF);
  });

  it('answers from the cache without fetching, and refetches only on refresh', async () => {
    const dir = temp();
    let downloads = 0;
    const counting = {
      fetchText: async () => {
        downloads += 1;
        return CATALOG_TEXT;
      },
      now: () => 2_000,
    };
    await ensureTemplateCatalogIn({ templatesDir: dir }, counting);
    const again = await ensureTemplateCatalogIn({ templatesDir: dir }, counting);
    expect(downloads).toBe(1);
    expect(again.fetchedAt).toBe(2_000);
    await ensureTemplateCatalogIn({ templatesDir: dir }, counting, { refresh: true });
    expect(downloads).toBe(2);
  });

  it('keeps the serving cache when a refresh fails or downloads garbage', async () => {
    const dir = temp();
    await ensureTemplateCatalogIn({ templatesDir: dir }, deps(CATALOG_TEXT, 1_000));
    const failed = await ensureTemplateCatalogIn({ templatesDir: dir }, deps(new Error('offline'), 2_000), {
      refresh: true,
    });
    expect(failed.available).toBe(true);
    expect(failed.fetchedAt).toBe(1_000);
    expect(failed.errorCode).toBe('download-failed');
    const garbage = await ensureTemplateCatalogIn({ templatesDir: dir }, deps('<html>bad gateway</html>', 3_000), {
      refresh: true,
    });
    expect(garbage.available).toBe(true);
    expect(garbage.errorCode).toBe('unparseable');
    expect(await readFile(join(dir, 'catalog.json'), 'utf8')).toBe(CATALOG_TEXT);
    expect(existsSync(join(dir, 'catalog.json.tmp'))).toBe(false);
  });

  it('refetches a cache another source wrote — a moved pin or an older origin must not keep serving', async () => {
    const dir = temp();
    await ensureTemplateCatalogIn({ templatesDir: dir }, deps(CATALOG_TEXT, 1_000));
    const metaFile = join(dir, 'catalog.meta.json');
    const foreign = JSON.parse(await readFile(metaFile, 'utf8')) as { source: string };
    foreign.source = 'https://raw.githubusercontent.com/someone/else/main/catalog.json';
    await writeFile(metaFile, `${JSON.stringify(foreign, null, 2)}\n`, 'utf8');
    let downloads = 0;
    const counting = {
      fetchText: async () => {
        downloads += 1;
        return CATALOG_TEXT;
      },
      now: () => 2_000,
    };
    const status = await ensureTemplateCatalogIn({ templatesDir: dir }, counting);
    expect(downloads).toBe(1);
    expect(status).toMatchObject({ available: true, fetchedAt: 2_000 });
    const after = JSON.parse(await readFile(metaFile, 'utf8')) as { source: string };
    expect(after.source).toBe(TEMPLATE_CATALOG_URL);
  });

  it('answers unavailable when nothing is cached and the download fails', async () => {
    const dir = temp();
    const status = await ensureTemplateCatalogIn({ templatesDir: dir }, deps(new Error('no route'), 1_000));
    expect(status).toMatchObject({ available: false, count: 0, fetchedAt: undefined, stale: false });
    expect(status.errorCode).toBe('download-failed');
  });

  it('marks a month-old cache stale without touching it', async () => {
    const dir = temp();
    await ensureTemplateCatalogIn({ templatesDir: dir }, deps(CATALOG_TEXT, 1_000));
    const monthLater = await ensureTemplateCatalogIn(
      { templatesDir: dir },
      deps(new Error('unused'), 1_000 + 31 * DAY)
    );
    expect(monthLater.stale).toBe(true);
    expect(monthLater.available).toBe(true);
  });
});

describe('searchTemplatesIn', () => {
  it('serves the cache: results, the category options, and the status in one answer', async () => {
    const dir = temp();
    await ensureTemplateCatalogIn({ templatesDir: dir }, deps(CATALOG_TEXT, 5_000));
    const answer = await searchTemplatesIn({ templatesDir: dir }, { query: '播客' }, () => 6_000);
    expect(answer.results.map((item) => item.slug)).toStrictEqual(['podcast-notes']);
    expect(answer.categories).toStrictEqual([
      { category: 'content-publishing', count: 1 },
      { category: 'finance-ops', count: 1 },
    ]);
    expect(answer.status).toMatchObject({ available: true, count: 2, fetchedAt: 5_000, stale: false });
  });

  it('answers an empty, unavailable state when no cache exists — not an error', async () => {
    const answer = await searchTemplatesIn({ templatesDir: temp() }, { query: '播客' });
    expect(answer.status.available).toBe(false);
    expect(answer.results).toStrictEqual([]);
    expect(answer.categories).toStrictEqual([]);
  });
});
