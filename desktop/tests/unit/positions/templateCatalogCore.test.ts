/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  draftFromTemplate,
  isTemplateCatalogStale,
  parseTemplateCatalog,
  searchTemplateEntries,
  templateCatalogAgeDays,
  templateCategoriesOf,
  type TemplateEntry,
} from '@/common/chat/team/positions/templateCatalogCore';

/**
 * The template catalog's pure core (common/chat/team/positions/
 * templateCatalogCore.ts): the wire file's validation (the download is a
 * trust boundary — malformed entries drop, a malformed file is refused), the
 * search spec the supervisor's templates.cjs mirrors, the staleness math,
 * and the wizard draft one entry fills. The script's own test runs the same
 * spec for real; these two suites are the contract's two ends.
 */

const entry = (over: Partial<TemplateEntry> = {}): TemplateEntry => ({
  slug: 'podcast-notes',
  name: 'Podcast Notes',
  summary_zh: '把每期播客切成章节笔记并写好摘要',
  category: 'content-publishing',
  tags: ['podcast', 'notes'],
  summary: 'Chops each podcast episode into chapter notes with a summary',
  import: 'https://x.ai/bot/abc',
  ...over,
});

const catalogOf = (entries: unknown[]): string => JSON.stringify({ generated: '2026-11-20', entries });

describe('parseTemplateCatalog', () => {
  it('parses the wire file, keeping the fields both surfaces show', () => {
    const parsed = parseTemplateCatalog(catalogOf([entry()]));
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]).toEqual(entry());
  });

  it('drops malformed entries and refuses files without usable ones', () => {
    const parsed = parseTemplateCatalog(catalogOf([entry(), { slug: 'no-name' }, 'junk', null]));
    expect(parsed).toHaveLength(1);
    expect(parseTemplateCatalog(catalogOf([]))).toBeUndefined();
    expect(parseTemplateCatalog(catalogOf([{ slug: 'x' }]))).toBeUndefined();
  });

  it('refuses what is not the catalog: bad JSON, no entries array', () => {
    expect(parseTemplateCatalog('not json')).toBeUndefined();
    expect(parseTemplateCatalog('{"entries": 5}')).toBeUndefined();
    expect(parseTemplateCatalog('{}')).toBeUndefined();
  });
});

describe('searchTemplateEntries', () => {
  const entries = [
    entry(),
    entry({
      slug: 'podcast-clipper',
      name: 'Podcast Clipper',
      summary: 'Cuts viral clips out of long podcast episodes',
      summary_zh: '从长播客里剪出传播片段',
      tags: ['audio'],
    }),
    entry({
      slug: 'newsletter-writer',
      name: 'Newsletter Writer',
      summary: 'Writes the weeks links into a newsletter',
      summary_zh: '把本周链接写成 newsletter',
      tags: ['newsletter'],
    }),
    entry({
      slug: 'invoice-chaser',
      name: 'Invoice Chaser',
      category: 'finance-ops',
      summary: 'Chases overdue invoices politely',
      summary_zh: '礼貌追讨逾期发票',
      tags: ['invoice'],
    }),
  ];

  it('answers the entries that hit — a name hit and a CJK summary hit each — ties broken by slug', () => {
    expect(searchTemplateEntries(entries, { query: 'podcast' }).map((item) => item.slug)).toStrictEqual([
      'podcast-clipper',
      'podcast-notes',
    ]);
    expect(searchTemplateEntries(entries, { query: '章节笔记' }).map((item) => item.slug)).toStrictEqual([
      'podcast-notes',
    ]);
    expect(searchTemplateEntries(entries, { query: 'newsletter' }).map((item) => item.slug)).toStrictEqual([
      'newsletter-writer',
    ]);
  });

  it('honors the category filter and the limit', () => {
    expect(searchTemplateEntries(entries, { query: 'newsletter', category: 'finance-ops' })).toStrictEqual([]);
    expect(searchTemplateEntries(entries, { query: 'podcast', category: 'content-publishing' })).toHaveLength(2);
    expect(searchTemplateEntries(entries, { query: 'e', limit: 1 })).toHaveLength(1);
  });

  it('answers nothing for an empty query, and breaks score ties by slug', () => {
    expect(searchTemplateEntries(entries, { query: '  ' })).toStrictEqual([]);
    const tie = [entry({ slug: 'b-x', name: 'X Tool' }), entry({ slug: 'a-x', name: 'X Tool' })];
    expect(searchTemplateEntries(tie, { query: 'tool' }).map((item) => item.slug)).toStrictEqual(['a-x', 'b-x']);
  });
});

describe("the catalog's side tables", () => {
  it('counts the distinct categories, most numerous first', () => {
    const counts = templateCategoriesOf([
      entry(),
      entry({ slug: 'x1', category: 'finance-ops' }),
      entry({ slug: 'x2', category: 'finance-ops' }),
    ]);
    expect(counts).toStrictEqual([
      { category: 'finance-ops', count: 2 },
      { category: 'content-publishing', count: 1 },
    ]);
  });

  it('marks a cache stale only past the thirty-day span', () => {
    const now = 10_000_000_000_000;
    expect(isTemplateCatalogStale(now - 30 * 24 * 3600_000 + 1, now)).toBe(false);
    expect(isTemplateCatalogStale(now - 30 * 24 * 3600_000, now)).toBe(true);
    expect(templateCatalogAgeDays(now - 36 * 3600_000, now)).toBe(1);
  });
});

describe('draftFromTemplate', () => {
  it('fills the draft: slug id, category-Chinese name candidate, one-line description, template-named body', () => {
    const draft = draftFromTemplate(entry());
    expect(draft.id).toBe('podcast-notes');
    expect(draft.displayNameCandidates).toStrictEqual(['内容发布', 'Podcast Notes']);
    expect(draft.description).toBe('把每期播客切成章节笔记并写好摘要');
    expect(draft.body).toContain('Podcast Notes');
    expect(draft.body).toContain('slug：podcast-notes');
    expect(draft.body).toContain('https://x.ai/bot/abc');
  });

  it('sanitizes an odd slug and folds a multiline summary to one line', () => {
    const draft = draftFromTemplate(entry({ slug: 'Weird Slug!!', summary_zh: `第一行\n第二行 ${'长'.repeat(170)}` }));
    expect(draft.id).toBe('weird-slug');
    expect(draft.description).not.toMatch(/\n/);
    expect(draft.description.endsWith('…')).toBe(true);
  });
});
