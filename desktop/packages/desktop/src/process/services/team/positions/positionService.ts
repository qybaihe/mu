/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The position roster on the main-process side: reading the user's position
 * library (`~/.mu/agent/agents`) and preparing each position's dedicated
 * workspace under the app's data dir. The library is the user's: the app's
 * one write path is the creation wizard, which only ever adds a new file —
 * `createPositionIn` refuses an id that already exists as a file or a
 * position, and nothing else in the app writes there. The workspace's
 * AGENTS.override.md is the injection seam the harness reads at a session's
 * start (the highest-priority context file of the working directory), so it is
 * regenerated from the library whenever it changed and rewritten before a
 * position conversation opens; a conversation that is already open re-reads
 * it through the adapter's gate watch (see agent/kyrn/gateReload.ts), so a
 * rules upgrade reaches live sessions without reopening them.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPlatformServices } from '@/common/platform';
import { KyrnError } from '@/common/kyrn/errors';
import { shippedTeamsScript } from '@process/services/team/supervisor/teamScripts';
import {
  analyzeProjectProfile,
  buildPositionDocument,
  buildPositionDraft,
  FILE_READ_CHARS,
  POSITION_ID_RE,
  PROJECT_CONTEXT_FILES,
  type PositionDraft,
  type ProjectProfile,
} from '@/common/chat/team/positions/positionProjectProfile';
import {
  buildPositionOverrideContent,
  parsePositionDocument,
  type PositionInfo,
} from '@/common/chat/team/positions/positionLibraryCore';
import { SHARED_TEAMS_FOLDER } from '@/common/chat/team/supervisor/supervisorCore';
import { USER_PORTRAIT_FILE_NAME, buildUserPortraitSkeleton } from '@/common/chat/team/positions/userPortraitCore';
import {
  POSITION_TRASH_FOLDER,
  TRASH_MANIFEST_NAME,
  buildTrashManifest,
  isTrashPurgeDue,
  parseTrashManifest,
  type TrashedPosition,
} from '@/common/chat/team/positions/positionTrashCore';

/** The user's position library. Read-only: the library is the user's, not ours. */
export const POSITION_LIBRARY_DIR = join(homedir(), '.mu', 'agent', 'agents');

/** The injected gate file: pi's first-priority context file of the workspace. */
const GATE_FILE_NAME = 'AGENTS.override.md';

/** The team maintenance script the position's gate rules reference (on-demand team forming). */
const TEAMS_SCRIPT_NAME = 'teams.cjs';

/** The user portrait in the shared folder (`positions/_shared/USER.md`): the one file every gate embeds. */
export const userPortraitFileOf = (dataDir: string): string =>
  join(dataDir, 'positions', SHARED_TEAMS_FOLDER, USER_PORTRAIT_FILE_NAME);

/**
 * Writes the portrait skeleton once, on the first ensure that runs: the
 * content is the user's to fill (the settings editor or a hand edit), so an
 * existing file is never touched. Whether the skeleton was written.
 */
export async function ensureUserPortraitIn(dataDir: string): Promise<boolean> {
  const file = userPortraitFileOf(dataDir);
  try {
    await readFile(file, 'utf8');
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(join(dataDir, 'positions', SHARED_TEAMS_FOLDER), { recursive: true });
  await writeFile(file, buildUserPortraitSkeleton(), 'utf8');
  return true;
}

/** The portrait as the gates embed it; undefined when the file is absent. */
export async function readUserPortraitIn(dataDir: string): Promise<string | undefined> {
  try {
    return await readFile(userPortraitFileOf(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

/**
 * Folder names stay filesystem-safe even for a position name with odd
 * characters. The name comes from the user's library (frontmatter), a
 * trust boundary the types cannot speak for, so a name that sanitizes to a
 * folder-traversal segment — `.` or `..`, the only ones that escape, since
 * separators never survive — is refused, not written.
 */
export const safeFolderName = (name: string): string => {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-');
  if (safe === '.' || safe === '..')
    throw new KyrnError('invalid', 'A position name cannot become a safe folder name', { name });
  return safe;
};

/** Cache of the last scan of one library directory, reused until its mtime moves. */
const cacheByDir = new Map<string, { dirMtimeMs: number; positions: PositionInfo[] }>();

/**
 * The roster as one library directory defines it: every position file, in name
 * order. Empty when the directory does not exist; a read that fails skips that
 * file for this scan (the next scan retries). Repeated scans of an unchanged
 * directory are free.
 */
export async function scanPositionLibrary(libraryDir: string): Promise<PositionInfo[]> {
  let dirStat;
  try {
    dirStat = await stat(libraryDir);
  } catch {
    return [];
  }
  if (!dirStat.isDirectory()) return [];

  const dirMtimeMs = dirStat.mtimeMs;
  const cached = cacheByDir.get(libraryDir);
  if (cached && cached.dirMtimeMs === dirMtimeMs) return cached.positions;

  // Dot entries are the app's own hidden folder (the delete quarantine), not
  // positions; the manifest inside it never lists here either.
  const files = (await readdir(libraryDir))
    .filter((name) => name.toLowerCase().endsWith('.md') && !name.startsWith('.'))
    .toSorted();
  const positions: PositionInfo[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(join(libraryDir, file), 'utf8');
    } catch {
      continue;
    }
    const position = parsePositionDocument(file, content);
    if (position) positions.push(position);
  }
  cacheByDir.set(libraryDir, { dirMtimeMs, positions });
  return positions;
}

/**
 * Prepares a position's workspace: the folder, the injected gate file
 * (rewritten when the library changed it) and the `teams.cjs` team
 * maintenance script (rewritten when the app ships a new one) — the
 * position's on-demand team-forming tool, sharing one TEAMS.md index with
 * the supervisor (positions/_shared/). Throws when the name is not in the
 * library.
 */
export async function ensurePositionWorkspaceIn(
  name: string,
  options: { libraryDir: string; dataDir: string }
): Promise<{ workspace: string; changed: boolean }> {
  const positions = await scanPositionLibrary(options.libraryDir);
  const position = positions.find((candidate) => candidate.name === name);
  if (!position) throw new Error(`position not in library: ${name}`);

  const workspace = join(options.dataDir, 'positions', safeFolderName(name));
  await mkdir(workspace, { recursive: true });
  await ensureUserPortraitIn(options.dataDir);
  const userPortrait = await readUserPortraitIn(options.dataDir);

  let changed = false;
  const file = join(workspace, GATE_FILE_NAME);
  const next = `${buildPositionOverrideContent(position, positions, userPortrait)}\n`;
  let existing: string | undefined;
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== next) {
    await writeFile(file, next, 'utf8');
    changed = true;
  }

  const scriptFile = join(workspace, TEAMS_SCRIPT_NAME);
  let scriptExisting: string | undefined;
  try {
    scriptExisting = await readFile(scriptFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (scriptExisting !== shippedTeamsScript) {
    await writeFile(scriptFile, shippedTeamsScript, 'utf8');
    changed = true;
  }
  return { workspace, changed };
}

/** The user's roster, from the user's position library. */
export const listPositions = (): Promise<PositionInfo[]> => scanPositionLibrary(POSITION_LIBRARY_DIR);

// --- the creation wizard's analysis and write ---

/**
 * The wizard's heuristic analysis of one picked directory: the first screen
 * of each context file (AGENTS.md, HANDOFF.md, README.md, package.json) plus
 * the top-level entries, read into a profile and the wizard's draft. No
 * model calls, no walking — seconds at most. A directory that does not
 * exist answers an empty profile (the wizard's cue for the AI deep
 * analysis) rather than an error: the picker just gave it to us.
 */
export async function analyzeProjectDirectory(directory: string): Promise<{
  profile: ProjectProfile;
  draft: PositionDraft;
}> {
  const files: Partial<Record<(typeof PROJECT_CONTEXT_FILES)[number], string>> = {};
  await Promise.all(
    PROJECT_CONTEXT_FILES.map(async (name) => {
      try {
        files[name] = (await readFile(join(directory, name), 'utf8')).slice(0, FILE_READ_CHARS);
      } catch {
        // Absent or unreadable: not a contributor, the heuristic says so by its absence.
      }
    })
  );
  let entries: string[] = [];
  try {
    entries = await readdir(directory);
  } catch {
    // Gone between pick and read: the empty profile answers honestly.
  }
  const profile = analyzeProjectProfile({ directory, files, entries });
  return { profile, draft: buildPositionDraft(profile) };
}

/** What the wizard's create step asks for; the body carries the project-root line. */
export type CreatePositionParams = {
  id: string;
  displayName: string;
  description: string;
  /** Optional taboos, one line each; written as the frontmatter `anti_job`. */
  antiJob?: string[];
  body: string;
};

/** True when the file exists; anything but a clean miss rethrows. */
async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

/**
 * The wizard's write: one new library file, added and nothing else. The safe
 * semantics are hard refusals, not overwrites — an id that already exists as
 * a file or as a position (another session may have created it since the
 * wizard last looked) is a conflict; a non-slug id or a multi-line name or
 * description is invalid. The document is parsed back before the write, so
 * the library only ever gains files it can read again. The scan cache is
 * dropped so the roster's next poll (30s, or the wizard's explicit refresh)
 * sees the new position at once.
 */
export async function createPositionIn(
  options: { libraryDir: string },
  params: CreatePositionParams
): Promise<PositionInfo> {
  const id = params.id.trim();
  if (!POSITION_ID_RE.test(id))
    throw new KyrnError('invalid', 'A position id is a lowercase slug (letters, digits, dashes)', { id });
  const displayName = params.displayName.trim();
  const description = params.description.trim();
  if (!displayName || /[\r\n]/.test(displayName))
    throw new KyrnError('invalid', 'A display name is one non-empty line', { displayName });
  if (!description || /[\r\n]/.test(description))
    throw new KyrnError('invalid', 'A description is one non-empty line', { description });
  const antiJob = (params.antiJob ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (antiJob.some((item) => /[\r\n]/.test(item)))
    throw new KyrnError('invalid', 'A taboo is one non-empty line', { antiJob });

  await mkdir(options.libraryDir, { recursive: true });
  const file = join(options.libraryDir, `${id}.md`);
  if (await fileExists(file))
    throw new KyrnError('invalid', 'A library file of that id already exists — pick another id', { file: `${id}.md` });
  if ((await scanPositionLibrary(options.libraryDir)).some((position) => position.name === id))
    throw new KyrnError('invalid', 'A position of that id already exists — pick another id', { id });

  const content = buildPositionDocument({ ...params, antiJob });
  const parsed = parsePositionDocument(`${id}.md`, content);
  if (!parsed) throw new KyrnError('invalid', 'The generated document does not parse as a position', { id });
  await writeFile(file, content, 'utf8');
  cacheByDir.delete(options.libraryDir); // the write moves the dir mtime; this keeps even same-ms honest
  return parsed;
}

/** The wizard's write, under the user's library. */
export const createPosition = (params: CreatePositionParams): Promise<PositionInfo> =>
  createPositionIn({ libraryDir: POSITION_LIBRARY_DIR }, params);

// --- the delete quarantine (.trash) ---

/** The trash folder and manifest of one library directory. */
const trashDirOf = (libraryDir: string): string => join(libraryDir, POSITION_TRASH_FOLDER);
const manifestOf = (libraryDir: string): string => join(trashDirOf(libraryDir), TRASH_MANIFEST_NAME);

/** The manifest's entries, empty when the trash folder has none yet. */
async function readTrashIn(libraryDir: string): Promise<TrashedPosition[]> {
  try {
    return parseTrashManifest(await readFile(manifestOf(libraryDir), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
}

/** Writes the manifest whole; the trash folder exists before it does. */
async function writeTrashIn(libraryDir: string, entries: readonly TrashedPosition[]): Promise<void> {
  await mkdir(trashDirOf(libraryDir), { recursive: true });
  await writeFile(manifestOf(libraryDir), buildTrashManifest(entries), 'utf8');
}

/** The library file a position of that name lives in — the file the trash
 *  moves, with the parsed position (its display name is worth keeping in the
 *  manifest). The roster's `PositionInfo` keys on the frontmatter name, not
 *  the file name, so the origin file is found by scanning (the same read the
 *  roster does). Undefined when the library holds no such position. */
async function positionFileOf(
  libraryDir: string,
  name: string
): Promise<{ file: string; displayName: string } | undefined> {
  const files = (await readdir(libraryDir))
    .filter((file) => file.toLowerCase().endsWith('.md') && !file.startsWith('.'))
    .toSorted();
  const contents = await Promise.all(
    files.map(
      async (file): Promise<readonly [string, string | undefined]> => [
        file,
        await readFile(join(libraryDir, file), 'utf8').catch((): string | undefined => undefined),
      ]
    )
  );
  for (const [file, content] of contents) {
    if (content === undefined) continue;
    const position = parsePositionDocument(file, content);
    if (position?.name === name) return { file, displayName: position.displayName };
  }
  return undefined;
}

/**
 * Soft-deletes one position of the library: its file MOVES into `.trash` (a
 * delete only ever quarantines — the library's files are never unlinked at
 * the moment of the delete), and the manifest records the origin and the
 * stamp. The move is the whole effect: the roster loses the position at its
 * next scan, the file itself waits out its grace. Throws when the library
 * holds no position of that name. The clock is injectable for tests.
 */
export async function trashPositionIn(
  options: { libraryDir: string },
  params: { name: string },
  now: () => number = Date.now
): Promise<TrashedPosition[]> {
  const origin = await positionFileOf(options.libraryDir, params.name);
  if (origin === undefined) throw new KyrnError('invalid', 'No such position in the library', { name: params.name });
  const entries = await readTrashIn(options.libraryDir);
  const deletedAt = now();
  // A same-named file re-created after an earlier delete moves in under a
  // stamped name; the manifest's `trashFile` keeps the truth either way.
  const dot = origin.file.lastIndexOf('.');
  const base = dot > 0 ? origin.file.slice(0, dot) : origin.file;
  const ext = dot > 0 ? origin.file.slice(dot) : '';
  let trashFile = origin.file;
  if (entries.some((entry) => entry.trashFile === trashFile)) trashFile = `${base}-${deletedAt}${ext}`;
  const trashDir = trashDirOf(options.libraryDir);
  await mkdir(trashDir, { recursive: true });
  await rename(join(options.libraryDir, origin.file), join(trashDir, trashFile));
  // A re-created file re-deleted adds an entry alongside the older one — the
  // older trash file keeps its own grace; a restore picks the newest entry of
  // the origin file (the manifest is newest-first), the older stays for its
  // own grace and the purge takes whatever is due.
  const next = [
    ...entries,
    { name: params.name, displayName: origin.displayName, file: origin.file, trashFile, deletedAt },
  ];
  await writeTrashIn(options.libraryDir, next);
  return next;
}

/** Soft-deletes one position under the user's library. */
export const trashPosition = (params: { name: string }): Promise<TrashedPosition[]> =>
  trashPositionIn({ libraryDir: POSITION_LIBRARY_DIR }, params);

/**
 * Restores one quarantined position: the file moves back to its origin name
 * and the manifest entry leaves. The roster picks the position up on its next
 * scan. Throws when the manifest holds no entry of that origin file, or when
 * the origin name is taken again (a re-created position must not be
 * overwritten). Keyed by the origin file name — the entry's stable identity.
 */
export async function restoreTrashedPositionIn(
  options: { libraryDir: string },
  params: { file: string }
): Promise<TrashedPosition[]> {
  const entries = await readTrashIn(options.libraryDir);
  // Newest first (the manifest writes that order): with a re-created file
  // deleted twice, the newest delete is the one a restore brings back.
  const entry = entries.find((candidate) => candidate.file === params.file);
  if (!entry) throw new KyrnError('invalid', 'No such position in the trash', { file: params.file });
  const origin = join(options.libraryDir, entry.file);
  let originTaken = false;
  try {
    await stat(origin);
    originTaken = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // A re-created position keeps its file: the restore refuses rather than
  // overwrite what the user wrote since the delete.
  if (originTaken)
    throw new KyrnError('invalid', 'A file of that name exists in the library again', { file: entry.file });
  await rename(join(trashDirOf(options.libraryDir), entry.trashFile), origin);
  // Only the restored entry leaves; an older delete of the same origin file
  // keeps its own row (and its own grace).
  const next = entries.filter((candidate) => candidate.trashFile !== entry.trashFile);
  await writeTrashIn(options.libraryDir, next);
  return next;
}

/** Restores one quarantined position under the user's library. */
export const restoreTrashedPosition = (params: { file: string }): Promise<TrashedPosition[]> =>
  restoreTrashedPositionIn({ libraryDir: POSITION_LIBRARY_DIR }, params);

/** The quarantine's manifest under the user's library, as the monitor lists it. */
export const listTrashedPositions = (): Promise<TrashedPosition[]> => readTrashIn(POSITION_LIBRARY_DIR);

/**
 * The quarantine's reconcile: entries past their grace leave and their
 * quarantined files go for real — the one place a position file is deleted,
 * and only after the grace the user confirmed at the delete. The clock is
 * injectable for tests.
 */
export async function purgeDueTrashedPositionsIn(
  options: { libraryDir: string },
  now: () => number = Date.now
): Promise<TrashedPosition[]> {
  const at = now();
  const entries = await readTrashIn(options.libraryDir);
  if (!entries.some((entry) => isTrashPurgeDue(entry, at))) return entries;
  const due = entries.filter((entry) => isTrashPurgeDue(entry, at));
  await Promise.all(due.map((entry) => rm(join(trashDirOf(options.libraryDir), entry.trashFile), { force: true })));
  const next = entries.filter((entry) => !isTrashPurgeDue(entry, at));
  await writeTrashIn(options.libraryDir, next);
  return next;
}

/** The quarantine's reconcile under the user's library. */
export const purgeDueTrashedPositions = (): Promise<TrashedPosition[]> =>
  purgeDueTrashedPositionsIn({ libraryDir: POSITION_LIBRARY_DIR });

/** Prepares a position's workspace under the app data dir, from the user's library. */
export const ensurePositionWorkspace = (name: string): Promise<{ workspace: string; changed: boolean }> =>
  ensurePositionWorkspaceIn(name, {
    libraryDir: POSITION_LIBRARY_DIR,
    dataDir: getPlatformServices().paths.getDataDir(),
  });
