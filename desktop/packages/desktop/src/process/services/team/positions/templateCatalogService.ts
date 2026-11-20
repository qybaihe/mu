/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The template catalog on the main-process side: the one-time download of
 * the community catalog (awesome-grok-bot, CC0-1.0) into the shared folder
 * (`positions/_shared/templates/`), the status of that cache, and the search
 * the wizard's template tab asks for. The catalog file is stored verbatim
 * next to a small meta file (`fetched_at`); a download that fails or does
 * not parse never removes the cache it was meant to replace, and a missing
 * cache is a status, not an exception — the supervisor's `templates.cjs`
 * reads the same file and degrades to `UNAVAILABLE` without it. The fetch
 * and the clock are injectable; everything here is bounded and synchronous
 * after the one network call.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPlatformServices } from '@/common/platform';
import { SHARED_TEAMS_FOLDER } from '@/common/chat/team/supervisor/supervisorCore';
import {
  TEMPLATE_CATALOG_MAX_BYTES,
  TEMPLATE_CATALOG_URL,
  isTemplateCatalogStale,
  parseTemplateCatalog,
  searchTemplateEntries,
  templateCategoriesOf,
  type TemplateCatalogStatus,
  type TemplateEntry,
} from '@/common/chat/team/positions/templateCatalogCore';

/** The shared folder's template cache directory under a data dir. */
export const templateCatalogDirOf = (dataDir: string): string =>
  join(dataDir, 'positions', SHARED_TEAMS_FOLDER, 'templates');

const CATALOG_FILE_NAME = 'catalog.json';
const META_FILE_NAME = 'catalog.meta.json';

/** One fetched catalog with its stamp. */
type CachedCatalog = { entries: TemplateEntry[]; fetchedAt: number | undefined };

const readOptional = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
};

/** The cache as it stands: undefined when no parsed catalog is on disk. */
async function readCachedCatalog(templatesDir: string): Promise<CachedCatalog | undefined> {
  const text = await readOptional(join(templatesDir, CATALOG_FILE_NAME));
  if (text === undefined) return undefined;
  const entries = parseTemplateCatalog(text);
  if (entries === undefined) return undefined;
  let fetchedAt: number | undefined;
  const meta = await readOptional(join(templatesDir, META_FILE_NAME));
  if (meta !== undefined) {
    try {
      const stamp = Date.parse((JSON.parse(meta) as { fetched_at?: unknown }).fetched_at as string);
      if (Number.isFinite(stamp)) fetchedAt = stamp;
    } catch {
      // A broken meta file means "unknown when"; the catalog itself still serves.
    }
  }
  return { entries, fetchedAt };
}

/** A cache as the status the wizard shows. */
const statusOf = (cached: CachedCatalog | undefined, now: number, error?: string): TemplateCatalogStatus =>
  cached === undefined
    ? { available: false, count: 0, fetchedAt: undefined, stale: false, error }
    : {
        available: true,
        count: cached.entries.length,
        fetchedAt: cached.fetchedAt,
        stale: cached.fetchedAt === undefined || isTemplateCatalogStale(cached.fetchedAt, now),
        error,
      };

/** How the catalog text arrives; injectable so tests need no network. */
export type FetchCatalogText = (url: string) => Promise<string>;

/** The app's own fetch: one minute's timeout, a size cap, the body as text. */
const fetchCatalogText: FetchCatalogText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > TEMPLATE_CATALOG_MAX_BYTES) throw new Error('the catalog download exceeded the size cap');
  return text;
};

/** Writes the cache whole: the catalog verbatim, the meta beside it, both via tmp+rename. */
async function writeCachedCatalog(
  templatesDir: string,
  text: string,
  entries: readonly TemplateEntry[],
  at: number
): Promise<void> {
  await mkdir(templatesDir, { recursive: true });
  const meta = `${JSON.stringify({ fetched_at: new Date(at).toISOString(), source: TEMPLATE_CATALOG_URL, count: entries.length }, null, 2)}\n`;
  await writeFile(join(templatesDir, `${CATALOG_FILE_NAME}.tmp`), text, 'utf8');
  await writeFile(join(templatesDir, `${META_FILE_NAME}.tmp`), meta, 'utf8');
  await rename(join(templatesDir, `${CATALOG_FILE_NAME}.tmp`), join(templatesDir, CATALOG_FILE_NAME));
  await rename(join(templatesDir, `${META_FILE_NAME}.tmp`), join(templatesDir, META_FILE_NAME));
}

/**
 * Ensures the cache: a present cache answers as-is (its status carries the
 * stale hint), a missing one — or `refresh` — downloads the catalog once.
 * A download that fails or does not parse never touches the cache it was
 * meant to replace: the status reports the failure beside the cache that
 * still serves.
 */
export async function ensureTemplateCatalogIn(
  options: { templatesDir: string },
  deps: { fetchText: FetchCatalogText; now: () => number },
  params: { refresh?: boolean } = {}
): Promise<TemplateCatalogStatus> {
  const cached = await readCachedCatalog(options.templatesDir);
  if (cached !== undefined && params.refresh !== true) return statusOf(cached, deps.now());
  let text: string;
  try {
    text = await deps.fetchText(TEMPLATE_CATALOG_URL);
    if (text.length > TEMPLATE_CATALOG_MAX_BYTES) throw new Error('the catalog download exceeded the size cap');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return statusOf(cached, deps.now(), `模板库下载失败：${message}`);
  }
  const entries = parseTemplateCatalog(text);
  if (entries === undefined) return statusOf(cached, deps.now(), '模板库下载内容无法解析为目录（保持原缓存）');
  const at = deps.now();
  await writeCachedCatalog(options.templatesDir, text, entries, at);
  return statusOf({ entries, fetchedAt: at }, at);
}

/** The one download the app may have in flight; concurrent callers join it. */
let inFlight: Promise<TemplateCatalogStatus> | undefined;

/** Ensures the cache under the app data dir; the startup pass and the wizard's tab share one flight. */
export const ensureTemplateCatalog = (params: { refresh?: boolean } = {}): Promise<TemplateCatalogStatus> => {
  inFlight ??= ensureTemplateCatalogIn(
    { templatesDir: templateCatalogDirOf(getPlatformServices().paths.getDataDir()) },
    { fetchText: fetchCatalogText, now: Date.now },
    params
  ).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
};

/** The search the wizard's template tab asks: the cache's status, the best entries, the filter options. */
export async function searchTemplatesIn(
  options: { templatesDir: string },
  params: { query: string; category?: string; limit?: number },
  now: () => number = Date.now
): Promise<{
  status: TemplateCatalogStatus;
  results: TemplateEntry[];
  categories: { category: string; count: number }[];
}> {
  const cached = await readCachedCatalog(options.templatesDir);
  return {
    status: statusOf(cached, now()),
    results: cached === undefined ? [] : searchTemplateEntries(cached.entries, params),
    categories: cached === undefined ? [] : templateCategoriesOf(cached.entries),
  };
}

/** The wizard's search under the app data dir. */
export const searchTemplates = (params: {
  query: string;
  category?: string;
  limit?: number;
}): Promise<{
  status: TemplateCatalogStatus;
  results: TemplateEntry[];
  categories: { category: string; count: number }[];
}> => searchTemplatesIn({ templatesDir: templateCatalogDirOf(getPlatformServices().paths.getDataDir()) }, params);
