import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { KyrnError } from '../../../common/kyrn/errors';
import {
  FOLDER_HIDDEN,
  FOLDER_LISTING_LIMIT,
  type FolderEntry,
  type FolderListing,
} from '../../../common/kyrn/folderBridge';

/*
 * The files tab of a native conversation (common/kyrn/folderBridge.ts): one directory of the conversation's folder at
 * a time, read afresh for every answer, so what the model wrote shows at the next look. Nothing is written here.
 */

const LONGEST_PATH = 4096;

/** A folder as the screen sends it: a full path, one line, not too long. */
export function readFolder(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > LONGEST_PATH ||
    value.includes('\u0000') ||
    /[\r\n]/.test(value) ||
    !isAbsolute(value)
  )
    throw new KyrnError('invalid', 'Invalid folder');
  return value;
}

/** A path inside the folder: relative, `/` between names, never above the folder. '' is the folder itself. */
function inside(folder: string, path: unknown): { absolute: string; relative: string } {
  if (typeof path !== 'string' || path.length > LONGEST_PATH || path.includes('\u0000') || /[\r\n]/.test(path))
    throw new KyrnError('invalid', 'Invalid path');
  const absolute = resolve(folder, ...path.split('/').filter(Boolean));
  const within = relative(folder, absolute);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new KyrnError('invalid', 'The path leaves the folder');
  return { absolute, relative: within.split(sep).join('/') };
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * One directory of `folder`: its entries (folders first, each group by name), at most FOLDER_LISTING_LIMIT, the rest
 * counted. A link counts as what it points to; a broken one as a file. A directory that cannot be read names itself.
 */
export async function listFolder(folder: string, path: unknown): Promise<FolderListing> {
  const where = inside(folder, path);
  let names: Array<{ name: string; dir: boolean; link: boolean }>;
  try {
    const entries = await readdir(where.absolute, { withFileTypes: true });
    names = entries
      .filter((entry) => !FOLDER_HIDDEN.has(entry.name))
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory(), link: entry.isSymbolicLink() }));
  } catch (error) {
    throw new KyrnError('unreadable', error instanceof Error ? error.message : String(error), {
      file: where.absolute,
    });
  }
  // A link counts as what it points to.
  await Promise.all(
    names
      .filter((entry) => entry.link)
      .map(async (entry) => {
        entry.dir = await stat(join(where.absolute, entry.name)).then(
          (info) => info.isDirectory(),
          () => false
        );
      })
  );
  const sorted = names.toSorted((a, b) => Number(b.dir) - Number(a.dir) || byName.compare(a.name, b.name));
  const entries: FolderEntry[] = sorted.slice(0, FOLDER_LISTING_LIMIT).map((entry) => ({
    name: entry.name,
    path: where.relative ? `${where.relative}/${entry.name}` : entry.name,
    kind: entry.dir ? 'dir' : 'file',
  }));
  return { path: where.relative, entries, more: sorted.length - entries.length };
}
