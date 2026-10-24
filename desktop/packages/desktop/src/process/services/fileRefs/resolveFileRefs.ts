import type { Dirent, Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { FileRefAnswer, FileRefKind } from '../../../common/chat/fileRefs/fileRefBridge';
import {
  extensionOf,
  FILE_REF_MAX_LENGTH,
  hasControlCharacter,
  isImagePath,
  withoutLineSuffix,
} from '../../../common/chat/fileRefs/pathLike';

/*
 * What a reference in a reply names (common/chat/fileRefs/fileRefBridge.ts). An absolute or `~/` path is taken as it
 * is, anything else under the conversation's folder. A bare name that is not there (`07_card.png`, written into
 * `out/` by the model) is looked for below the folder by its exact name, within bounds, and counts only when one file
 * has it. Only regular files count: a folder, a broken link or a device never does.
 */

/** How many folders deep below the conversation's folder a bare name is looked for. */
export const SEARCH_DEPTH = 4;
/** How many directory entries one search reads at most. */
export const SEARCH_ENTRIES = 5000;

/** Folders the search never enters, besides every folder whose name starts with a dot (`.git`, `.venv`, `.cache`). */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  '__pycache__',
  'site-packages',
  'venv',
  'Pods',
  'DerivedData',
]);

/** What would run when opened: shown in its folder, never opened. */
const PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set([
  'app',
  'command',
  'tool',
  'terminal',
  'sh',
  'bash',
  'zsh',
  'csh',
  'tcsh',
  'ksh',
  'fish',
  'exe',
  'com',
  'bat',
  'cmd',
  'msi',
  'msp',
  'mst',
  'scr',
  'pif',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'cpl',
  'msc',
  'jar',
  'jnlp',
  'lnk',
  'reg',
  'inf',
  'scf',
  'url',
  'website',
  'appref-ms',
  'application',
  'gadget',
  'appimage',
  'run',
  'deb',
  'rpm',
  'pkg',
  'mpkg',
  'dmg',
  'iso',
  'img',
  'vhd',
  'vhdx',
  'workflow',
  'action',
  'scpt',
  'scptd',
  'applescript',
  'desktop',
  'webloc',
  'inetloc',
  'fileloc',
  'mobileconfig',
  'shortcut',
  'safariextz',
  'ipa',
  'apk',
  'flatpak',
  'flatpakref',
  'snap',
  'chm',
  'hlp',
  'xll',
  'xlam',
  'ppam',
  'dll',
  'ocx',
  'shb',
  'shs',
  'ins',
  'isp',
  'vb',
  'ws',
  'diagcab',
  'settingcontent-ms',
  'library-ms',
  'search-ms',
  'searchconnector-ms',
  'appx',
  'appxbundle',
  'msix',
  'msixbundle',
  'xbap',
  'py',
  'pyw',
  'pyc',
  'pyo',
  'pl',
  'rb',
  'php',
]);

/** Windows runs these with its script host when they are opened. */
const WINDOWS_SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['js', 'mjs', 'cjs']);

/** Files that open in a viewer or an editor even with an execute bit set (copied from a FAT disk or a zip). */
const VIEWED_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
  'tif',
  'tiff',
  'heic',
  'heif',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'csv',
  'tsv',
  'txt',
  'md',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'mp3',
  'wav',
  'm4a',
  'mp4',
  'mov',
  'webm',
]);

export type ResolveOptions = {
  home: string;
  platform: NodeJS.Platform;
  depth?: number;
  entries?: number;
};

/**
 * What a found file is to the window: an image the preview shows, a program (by its extension, or on macOS and Linux
 * by an execute bit on a file that is not a document) that is only ever shown in its folder, or a file to open.
 */
export function fileRefKind(path: string, info: Pick<Stats, 'mode'>, platform: NodeJS.Platform): FileRefKind {
  const extension = extensionOf(path);
  if (PROGRAM_EXTENSIONS.has(extension)) return 'program';
  if (platform === 'win32' && WINDOWS_SCRIPT_EXTENSIONS.has(extension)) return 'program';
  if (platform !== 'win32' && (info.mode & 0o111) !== 0 && !VIEWED_EXTENSIONS.has(extension)) return 'program';
  return isImagePath(path) ? 'image' : 'file';
}

/** The file at `path` (a link counts as what it points to) if it is a regular file. */
export async function regularFile(path: string): Promise<Stats | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? info : undefined;
  } catch {
    return undefined;
  }
}

/** A reference as the window sent it: a string of one line, not too long. */
const readable = (reference: unknown): reference is string =>
  typeof reference === 'string' &&
  reference.length > 0 &&
  reference.length <= FILE_REF_MAX_LENGTH &&
  !hasControlCharacter(reference);

/** Where a reference points: `~/` under home, an absolute path as it is, anything else under the folder. */
function expand(reference: string, cwd: string | undefined, home: string): string | undefined {
  const text = withoutLineSuffix(reference.trim());
  if (!text) return undefined;
  if (/^~[\\/]/.test(text)) return join(home, text.slice(2));
  if (isAbsolute(text)) return resolve(text);
  return cwd ? resolve(cwd, text) : undefined;
}

const isBareName = (reference: string): boolean => !/[\\/]/.test(reference) && reference !== '.' && reference !== '..';

/**
 * Every file below `root` named one of `names` (compared in Unicode NFC: a Mac may store a name decomposed), at most
 * two each: two already make a name ambiguous. Breadth first, files in `root` itself included, up to `depth` folders
 * below it and `entries` entries read; folders named with a leading dot or in SKIPPED_FOLDERS, and links to folders,
 * are not entered. A link to a regular file counts as that file.
 */
export async function findByName(
  root: string,
  names: readonly string[],
  limits: { depth: number; entries: number } = { depth: SEARCH_DEPTH, entries: SEARCH_ENTRIES }
): Promise<Map<string, string[]>> {
  const wanted = new Map(names.map((name) => [name.normalize('NFC'), name]));
  const found = new Map<string, string[]>();
  const settled = () => [...wanted.values()].every((name) => (found.get(name)?.length ?? 0) >= 2);
  let budget = limits.entries;
  let level = [root];
  for (let depth = 0; depth <= limits.depth && level.length > 0 && budget > 0; depth++) {
    const below: string[] = [];
    for (const folder of level) {
      if (budget <= 0 || settled()) return found;
      let entries: Dirent[];
      try {
        // One folder at a time, so the search stops at its bounds.
        // eslint-disable-next-line no-await-in-loop
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (budget-- <= 0) break;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name)) below.push(path);
          continue;
        }
        const name = wanted.get(entry.name.normalize('NFC'));
        if (!name) continue;
        // Only a link that has a wanted name is followed.
        // eslint-disable-next-line no-await-in-loop
        if (entry.isFile() || (entry.isSymbolicLink() && (await regularFile(path)))) {
          const paths = found.get(name) ?? [];
          if (paths.length < 2) found.set(name, [...paths, path]);
        }
      }
    }
    level = below;
  }
  return found;
}

/**
 * One answer per reference, in order. A reference that is not a readable string, or that names no regular file, is
 * `missing`; a bare name found in more than one place below the folder is `ambiguous`.
 */
export async function resolveFileRefs(
  cwd: string | undefined,
  references: readonly unknown[],
  options: ResolveOptions
): Promise<FileRefAnswer[]> {
  const answers: FileRefAnswer[] = references.map(() => ({ state: 'missing' }));
  const searched = new Map<string, number[]>();
  const describe = (path: string, info: Stats): FileRefAnswer => ({
    state: 'found',
    path,
    kind: fileRefKind(path, info, options.platform),
    size: info.size,
  });

  await Promise.all(
    references.map(async (reference, index) => {
      if (!readable(reference)) return;
      const path = expand(reference, cwd, options.home);
      const info = path ? await regularFile(path) : undefined;
      if (path && info) {
        answers[index] = describe(path, info);
        return;
      }
      const name = withoutLineSuffix(reference.trim());
      if (cwd && isBareName(name)) searched.set(name, [...(searched.get(name) ?? []), index]);
    })
  );

  if (cwd && searched.size > 0) {
    const found = await findByName(cwd, [...searched.keys()], {
      depth: options.depth ?? SEARCH_DEPTH,
      entries: options.entries ?? SEARCH_ENTRIES,
    });
    for (const [name, indexes] of searched) {
      const paths = found.get(name) ?? [];
      // eslint-disable-next-line no-await-in-loop
      const info = paths.length === 1 ? await regularFile(paths[0]) : undefined;
      const answer: FileRefAnswer =
        paths.length > 1 ? { state: 'ambiguous' } : info ? describe(paths[0], info) : { state: 'missing' };
      for (const index of indexes) answers[index] = answer;
    }
  }
  return answers;
}
