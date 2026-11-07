import { mkdirSync, type Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { KyrnError } from '../../../common/kyrn/errors';
import {
  FOLDER_FIND_LIMIT,
  FOLDER_HIDDEN,
  FOLDER_LISTING_LIMIT,
  FOLDER_SCRIPTS_LIMIT,
  type FolderEntry,
  type FolderFiles,
  type FolderListing,
  type FolderScripts,
  type ScriptRunner,
} from '../../../common/kyrn/folderBridge';
import type { GitRunner } from '../../services/folderGit/runGit';

/*
 * The files tab of a native conversation (common/kyrn/folderBridge.ts): one directory of the conversation's folder at
 * a time, read afresh for every answer, so what the model wrote shows at the next look. Nothing is written here.
 * Also `findFiles`, every file of the folder for quick open, `folderScripts`, the scripts its package.json names (the
 * send box's Run), and `openFolder`, which shows one of mu's folders in the file manager, making it first when it is
 * not there yet.
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

/** Folders a walk never enters: dependencies, caches and build output, by name, at any depth. */
const WALK_SKIPPED: ReadonlySet<string> = new Set([
  'node_modules',
  '__pycache__',
  'venv',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
]);
/** How deep a walk goes below the folder, and how many entries it reads in all. */
const WALK_DEPTH = 12;
const WALK_ENTRIES = 50000;

/**
 * Every file of `folder` worth opening by name, for quick open. In a git repository, git's own list: the files it
 * tracks and the new ones it does not ignore (`ls-files --cached --others --exclude-standard`), below `folder` only.
 * Anywhere else, or when git cannot answer, a walk: breadth first, no dot folders, none of WALK_SKIPPED, at most
 * WALK_DEPTH deep and WALK_ENTRIES read. Never more than FOLDER_FIND_LIMIT paths; `more` says some were left out.
 */
export async function findFiles(folder: string, git?: GitRunner): Promise<FolderFiles> {
  if (git) {
    const listed = await gitFiles(folder, git).catch((): undefined => undefined);
    if (listed) return listed;
  }
  return walkFiles(folder);
}

async function gitFiles(folder: string, git: GitRunner): Promise<FolderFiles | undefined> {
  const run = await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: folder,
    timeoutMs: 5000,
    maxBytes: 16 * 1024 * 1024,
  });
  if (run.code !== 0) return undefined;
  const all = [...new Set(run.stdout.split('\0').filter(Boolean))];
  // A list cut short by the byte cap ends in the middle of a name.
  if (run.overflow) all.pop();
  return { paths: all.slice(0, FOLDER_FIND_LIMIT), more: run.overflow || all.length > FOLDER_FIND_LIMIT };
}

async function walkFiles(folder: string): Promise<FolderFiles> {
  const paths: string[] = [];
  let read = 0;
  let level = [''];
  // One level at a time, its folders read together: breadth first, so a cut leaves out the deepest files.
  for (let depth = 0; level.length; depth++) {
    if (depth > WALK_DEPTH) return { paths, more: true };
    const listed = await Promise.all(
      level.map((dir) =>
        readdir(join(folder, ...dir.split('/').filter(Boolean)), { withFileTypes: true }).then(
          (entries) => ({ dir, entries }),
          (): { dir: string; entries: Dirent[] } => ({ dir, entries: [] })
        )
      )
    );
    const next: string[] = [];
    for (const { dir, entries } of listed) {
      for (const entry of entries) {
        if (++read > WALK_ENTRIES || paths.length >= FOLDER_FIND_LIMIT) return { paths, more: true };
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !WALK_SKIPPED.has(entry.name)) next.push(path);
        } else if (entry.isFile() && !FOLDER_HIDDEN.has(entry.name)) paths.push(path);
      }
    }
    level = next;
  }
  return { paths, more: false };
}

/** A package.json larger than this is not read for its scripts. */
const LARGEST_PACKAGE_JSON = 1024 * 1024;
/** A script name a shell takes as it is, on every platform: nothing to quote. */
const PLAIN_SCRIPT_NAME = /^[\w.][\w:.@/+-]{0,99}$/;
const LOCKFILES: [string, ScriptRunner][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
];

/**
 * The scripts of the package.json at the top of the folder, read afresh, with what runs them: package.json's
 * `packageManager`, else the first lockfile found, else npm. None (null) without a package.json, one that does not
 * parse or is too large, or one with no scripts.
 */
export async function folderScripts(folder: string): Promise<FolderScripts | null> {
  const file = join(folder, 'package.json');
  let manifest: unknown;
  try {
    if ((await stat(file)).size > LARGEST_PACKAGE_JSON) return null;
    manifest = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object') return null;
  const { scripts, packageManager } = manifest as { scripts?: unknown; packageManager?: unknown };
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return null;
  const all = Object.entries(scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''
  );
  if (all.length === 0) return null;
  const plain = all.filter(([name]) => PLAIN_SCRIPT_NAME.test(name)).slice(0, FOLDER_SCRIPTS_LIMIT);
  return {
    runner: await scriptRunner(folder, packageManager),
    scripts: plain.map(([name, command]) => ({ name, command })),
    more: all.length - plain.length,
  };
}

async function scriptRunner(folder: string, packageManager: unknown): Promise<ScriptRunner> {
  const named = typeof packageManager === 'string' ? packageManager.split('@')[0] : '';
  if (named === 'npm' || named === 'pnpm' || named === 'yarn' || named === 'bun') return named;
  const present = await Promise.all(
    LOCKFILES.map(([lockfile]) =>
      stat(join(folder, lockfile)).then(
        () => true,
        () => false
      )
    )
  );
  return LOCKFILES[present.indexOf(true)]?.[1] ?? 'npm';
}

/** Creates the folder if needed; `show` opens it in the file manager (Electron's `shell.openPath`). */
export async function openFolder(folder: string, show: (path: string) => Promise<string>): Promise<void> {
  mkdirSync(folder, { recursive: true });
  const problem = await show(folder);
  if (problem) throw new KyrnError('unreadable', problem, { file: folder });
}
