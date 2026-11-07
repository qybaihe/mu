import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { KyrnError } from '../../../common/kyrn/errors';

/*
 * The repository each of the sidebar's folders is in (common/kyrn/gitBridge.ts `roots`), so a project's conversations
 * group under its top folder: the nearest folder up from a folder, the folder itself included, that holds a `.git` (a
 * folder, or the file of a worktree or a submodule), which is where git finds a work tree's top. Read on the disk, git
 * does not run: a list of a hundred folders is a few dozen lookups, not a hundred processes.
 */

/** The most folders one call looks up; the ones after are left out. */
export const ROOTS_LIMIT = 1000;
const LONGEST_PATH = 4096;

/** Whether a folder holds a `.git`. */
export type HasGit = (dir: string) => Promise<boolean>;

const hasGit: HasGit = (dir) =>
  lstat(join(dir, '.git')).then(
    () => true,
    () => false
  );

/** A folder as the screen sends it: a full path, one line, not too long. Anything else is not looked up. */
const isFolder = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= LONGEST_PATH &&
  !value.includes('\u0000') &&
  !/[\r\n]/.test(value) &&
  isAbsolute(value);

/** The repository's top folder for each folder in one, by the folder as it was sent. */
export async function repoRoots(value: unknown, has: HasGit = hasGit): Promise<Record<string, string>> {
  if (!Array.isArray(value)) throw new KyrnError('invalid', 'Invalid folders');
  const folders = [...new Set(value.filter(isFolder))].slice(0, ROOTS_LIMIT);
  // The folders of one project share their parents: each is looked at once.
  const looked = new Map<string, Promise<boolean>>();
  const look = (dir: string): Promise<boolean> => {
    let found = looked.get(dir);
    if (!found) {
      found = has(dir);
      looked.set(dir, found);
    }
    return found;
  };
  // From the folder up, one at a time: the nearest one wins.
  const top = (dir: string): Promise<string | undefined> =>
    look(dir).then((found) => (found ? dir : dirname(dir) === dir ? undefined : top(dirname(dir))));
  const found = await Promise.all(folders.map(async (folder) => [folder, await top(resolve(folder))] as const));
  return Object.fromEntries(found.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
}
