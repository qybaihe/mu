/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The position-template catalog, pure: validating the downloaded catalog
 * file, searching it, and deriving the wizard's draft from one entry. The
 * catalog is the community list at awesome-grokbot (CC0-1.0) — thousands of
 * shared bot templates, each a name, a Chinese summary and a category —
 * cached whole on disk by the position service; this module never touches
 * the network or the disk. The search spec here is mirrored, on purpose, by
 * the supervisor workspace's `templates.cjs` (the file format is the
 * contract between the two, the same arrangement positions.cjs has with
 * positionLibraryCore): both sides are tested against the same fixtures.
 */

/**
 * Where the catalog is downloaded from: the awesome-grokbot repo's raw
 * file at an immutable ref — never a branch head, so a repo compromise or a
 * silent history rewrite cannot turn the app's download into a moving
 * target. The repo has cut no release tags yet, so the pin is the audited
 * commit SHA below; once a release exists, the ref becomes its tag. Bumping
 * the pin is a deliberate, review-worthy code change.
 */
export const TEMPLATE_CATALOG_REF = 'f64dc25af7f823bcc697ad7d5fa675b397934d82';
export const TEMPLATE_CATALOG_URL = `https://raw.githubusercontent.com/kydlikebtc/awesome-grokbot/${TEMPLATE_CATALOG_REF}/catalog.json`;

/** How old a cached catalog may be before the wizard offers a refresh: 30 days. */
export const TEMPLATE_CATALOG_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The largest download accepted: the catalog is ~6MB today; 16MB is
 * generous headroom for its growth, not a budget to fill.
 */
export const TEMPLATE_CATALOG_MAX_BYTES = 16 * 1024 * 1024;

/** One template of the catalog, the fields both surfaces show. */
export type TemplateEntry = {
  /** The stable identifier, a lowercase slug; also the wizard's id candidate. */
  slug: string;
  /** The template's display name (usually English). */
  name: string;
  /** The Chinese one-line summary, the description candidate. */
  summary_zh: string;
  /** The editorial bucket: personal-admin, coding-shipping, … */
  category: string;
  /** Free-form tags. */
  tags: string[];
  /** The English summary. */
  summary: string;
  /** The x.ai/bot share link, kept in the draft body for reference. */
  import: string;
};

/** The query side of a template search. */
export type TemplateSearchQuery = {
  /** Free text: latin words tokenize on whitespace, CJK matches as-is. */
  query: string;
  /** Restrict to one category; undefined searches every category. */
  category?: string;
  /** How many entries to answer; 5 by default (the supervisor's brief). */
  limit?: number;
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const asTags = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];

/**
 * The downloaded text as the catalog's entries, or undefined when the text is
 * not the catalog: a JSON object whose `entries` is an array, each entry
 * carrying the four required fields (slug, name, summary_zh, category — a
 * catalog that lost these is not a catalog). The wire file is a trust
 * boundary: one malformed entry is skipped, a malformed file is refused.
 */
export function parseTemplateCatalog(text: string): TemplateEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    return undefined;
  }
  const entries: TemplateEntry[] = [];
  for (const raw of (parsed as { entries: unknown[] }).entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const slug = asString(record.slug);
    const name = asString(record.name);
    const summary_zh = asString(record.summary_zh);
    const category = asString(record.category);
    if (!slug || !name || !summary_zh || !category) continue;
    entries.push({
      slug,
      name,
      summary_zh,
      category,
      tags: asTags(record.tags),
      summary: asString(record.summary) ?? '',
      import: asString(record.import) ?? '',
    });
  }
  return entries.length > 0 ? entries : undefined;
}

/** A search text's tokens: lowercase whitespace pieces, the whole text kept for CJK substring hits. */
const queryTokens = (query: string): { whole: string; words: string[] } => {
  const whole = query.trim().toLowerCase();
  const words = whole.split(/\s+/).filter((word) => word.length > 0 && /[a-z0-9]/.test(word));
  return { whole, words };
};

/**
 * How well one entry answers one token: a name hit weighs most, then tags
 * and category, then the Chinese summary, then the English one. Substring,
 * case-insensitive — enough for both a latin word and a CJK phrase.
 */
const entryScore = (entry: TemplateEntry, token: string): number => {
  if (!token) return 0;
  const name = entry.name.toLowerCase();
  if (name.includes(token)) return 4;
  if (entry.tags.some((tag) => tag.toLowerCase().includes(token))) return 3;
  if (entry.category.toLowerCase().includes(token)) return 2;
  if (entry.summary_zh.toLowerCase().includes(token)) return 2;
  if (entry.summary.toLowerCase().includes(token)) return 1;
  return 0;
};

/**
 * The entries a query answers best: every entry that scores on any token,
 * best score first, slug order within a score (the order is deterministic,
 * so the supervisor's two surfaces agree). An empty query answers nothing.
 */
export function searchTemplateEntries(entries: readonly TemplateEntry[], search: TemplateSearchQuery): TemplateEntry[] {
  const { whole, words } = queryTokens(search.query);
  const tokens = whole ? (words.length > 0 ? words : [whole]) : [];
  if (tokens.length === 0) return [];
  const limit = search.limit ?? 5;
  return entries
    .filter((entry) => search.category === undefined || entry.category === search.category)
    .map((entry) => ({ entry, score: tokens.reduce((sum, token) => sum + entryScore(entry, token), 0) }))
    .filter((scored) => scored.score > 0)
    .toSorted((a, b) => b.score - a.score || (a.entry.slug < b.entry.slug ? -1 : 1))
    .slice(0, limit)
    .map((scored) => scored.entry);
}

/** The catalog's distinct categories with counts, most numerous first: the wizard's filter options. */
export function templateCategoriesOf(entries: readonly TemplateEntry[]): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .toSorted((a, b) => b.count - a.count || (a.category < b.category ? -1 : 1));
}

/** How many days ago `fetchedAt` was, rounded down; 0 when the clock reads earlier. */
export const templateCatalogAgeDays = (fetchedAt: number, now: number): number =>
  Math.max(0, Math.floor((now - fetchedAt) / (24 * 60 * 60 * 1000)));

/** The cache's state as the wizard's template tab shows it. */
export type TemplateCatalogStatus = {
  /** True when a parsed catalog is on disk and searchable. */
  available: boolean;
  /** How many entries the cached catalog carries. */
  count: number;
  /** Epoch ms of the download, from the cache's meta file; undefined when unknown. */
  fetchedAt: number | undefined;
  /** True when the cache is older than the stale span (30 days) — the refresh hint. */
  stale: boolean;
  /**
   * Why the last fetch attempt failed, when it did. A code, not text: the
   * main process cannot localize, so the renderer maps it to the wizard's
   * language; the raw cause goes to the dev log instead.
   */
  errorCode: TemplateCatalogErrorCode | undefined;
};

/** The fetch failures the status can carry; the wizard maps each to localized text. */
export type TemplateCatalogErrorCode = 'download-failed' | 'unparseable';

/** Whether a cached catalog is old enough that the wizard offers a refresh. */
export const isTemplateCatalogStale = (fetchedAt: number, now: number): boolean =>
  now - fetchedAt >= TEMPLATE_CATALOG_STALE_MS;

/**
 * The catalog's editorial categories with the Chinese labels the position
 * wizard offers as display-name candidates (a template's own name is
 * English; its summary's opening is a sentence, not a name — the category
 * is the honest Chinese seed). A category upstream added later falls back
 * to the entry's own name.
 */
const TEMPLATE_CATEGORY_LABELS_ZH: Record<string, string> = {
  'personal-admin': '个人事务',
  'content-publishing': '内容发布',
  'coding-shipping': '编码交付',
  'research-briefings': '调研简报',
  'teams-handoffs': '团队协作',
  'finance-ops': '财务运营',
  'customer-sales': '客户销售',
  'inbox-calendar': '邮件日历',
};

/**
 * The common taboos a template category suggests for the new position's
 * `anti_job` — a draft the user edits, never a verdict. Categories with no
 * obvious taboo (personal-admin, teams-handoffs) suggest nothing: an
 * invented taboo is worse than none.
 */
export const TEMPLATE_CATEGORY_ANTI_JOBS: Record<string, readonly string[]> = {
  'content-publishing': ['严禁未经用户确认对外发布任何内容（发帖/评论/点赞/关注）'],
  'coding-shipping': ['严禁未经用户确认 push 代码或创建 issue/PR'],
  'research-briefings': ['严禁编造来源、数据与结论；未核实的一律显式标注'],
  'finance-ops': ['严禁未经用户确认执行任何资金或支付操作'],
  'customer-sales': ['严禁未经用户确认联系客户或对外发送消息'],
  'inbox-calendar': ['严禁未经用户确认发送邮件或改写日历事件'],
};

/**
 * The category map as the rule-6 drafting text shows it: one line per
 * category with taboos, id and Chinese label together, so the supervisor's
 * draft and the wizard's prefill quote one source.
 */
export const templateAntiJobHintLines = (): string[] =>
  Object.entries(TEMPLATE_CATEGORY_ANTI_JOBS).map(
    ([category, items]) => `- ${category}（${TEMPLATE_CATEGORY_LABELS_ZH[category] ?? category}）→ ${items.join('；')}`
  );

/** One text as one line, capped: the library frontmatter requirement. */
const oneLine = (text: string, cap: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
};

/** A legal position id: the wizard's own rule, kept here so the template draft obeys it too. */
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The wizard draft one template fills: the id from the slug (already a slug;
 * anything else collapses to dashes and, if that fails, the category), the
 * description from the Chinese summary, suggested taboos from the category,
 * and a body that names the template as the draft's source. No project root
 * — the template path has none.
 */
export function draftFromTemplate(entry: TemplateEntry): {
  id: string;
  displayNameCandidates: string[];
  description: string;
  antiJob: string[];
  body: string;
} {
  const slugId = entry.slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const id = TEMPLATE_ID_RE.test(slugId) ? slugId : entry.category;
  const candidate = TEMPLATE_CATEGORY_LABELS_ZH[entry.category] ?? entry.name;
  return {
    id,
    displayNameCandidates: [candidate, entry.name].filter((name, index, all) => all.indexOf(name) === index),
    description: oneLine(entry.summary_zh, 160),
    antiJob: [...(TEMPLATE_CATEGORY_ANTI_JOBS[entry.category] ?? [])],
    body: [
      `你是「${candidate}」岗位的常设负责 Bot（岗位即项目，跨任务常设，持续积累本岗记忆）。本岗位由 awesome-grokbot 模板「${entry.name}」起步，请在首次任务中结合实际工作核实并补全职责。`,
      '',
      '## 岗位职责（草案，来自模板中文摘要，可改）',
      `- ${oneLine(entry.summary_zh, 200)}`,
      '',
      '## 归属判据（草案）',
      `- 涉及「${entry.category}」域相关任务属于本岗；不属于时按名册转交并附一句理由。`,
      '',
      '## 参考模板',
      `- 模板：${entry.name}（slug：${entry.slug}，分类：${entry.category}）`,
      entry.import ? `- 分享链接：${entry.import}` : '',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  };
}
