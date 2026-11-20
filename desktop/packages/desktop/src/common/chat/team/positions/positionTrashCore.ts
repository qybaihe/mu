/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The position quarantine, pure: the `.trash` folder inside the user's
 * position library (`~/.mu/agent/agents/.trash/`) and its manifest. A deleted
 * position's file MOVES there (the library is the user's — the delete only
 * ever quarantines, never unlinks), the manifest records where it came from
 * and when, and the desktop restores by moving it back for the grace period —
 * then a purge deletes the quarantined files for real. The manifest is the
 * single file of record: the folder itself is never listed to find entries.
 * All IO lives in the service.
 */

/** The quarantine folder inside the position library; the roster scan skips it. */
export const POSITION_TRASH_FOLDER = '.trash';

/** The manifest file inside the trash folder. */
export const TRASH_MANIFEST_NAME = 'manifest.json';

/** How long a deleted position stays restorable before the purge deletes it. */
export const POSITION_DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One quarantined position: the file's place of origin and its delete stamp. */
export type TrashedPosition = {
  /** The position's frontmatter name — what the roster and the walls keyed on. */
  name: string;
  /** The display name the roster showed (falls back to `name` when absent at the delete). */
  displayName: string;
  /** The file's name in the library (its place of origin, where a restore moves it back to). */
  file: string;
  /** The file's name inside the trash folder (the origin name, unless it collided). */
  trashFile: string;
  /** Epoch ms of the delete. */
  deletedAt: number;
};

/**
 * The manifest's contents, tolerant of the file a hand edit or an older
 * version wrote: a JSON array of well-shaped entries, everything else —
 * prose, a missing file, malformed rows — reads as an empty manifest.
 */
export function parseTrashManifest(content: string): TrashedPosition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: TrashedPosition[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const name = entry.name;
    const file = entry.file;
    const trashFile = entry.trashFile;
    const deletedAt = entry.deletedAt;
    if (typeof name !== 'string' || name === '') continue;
    if (typeof file !== 'string' || file === '') continue;
    if (typeof trashFile !== 'string' || trashFile === '') continue;
    if (typeof deletedAt !== 'number' || !Number.isFinite(deletedAt)) continue;
    const displayName = typeof entry.displayName === 'string' && entry.displayName !== '' ? entry.displayName : name;
    entries.push({ name, displayName, file, trashFile, deletedAt });
  }
  return entries;
}

/** The manifest's canonical text: one line per entry, stable order (newest delete first). */
export function buildTrashManifest(entries: readonly TrashedPosition[]): string {
  const rows = entries.toSorted((a, b) => b.deletedAt - a.deletedAt);
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/** Whole days of restorable grace left: 0 on the last day, capped at the
 *  grace length — a clock reading from before the stamp (a slow render tick)
 *  must not round a fresh delete up to "8 days". */
export const trashDaysLeftOf = (deletedAt: number, now: number): number =>
  Math.min(
    POSITION_DELETE_GRACE_MS / DAY_MS,
    Math.max(0, Math.ceil((deletedAt + POSITION_DELETE_GRACE_MS - now) / DAY_MS))
  );

/** Whether a quarantined position's grace has passed and the purge deletes it. */
export const isTrashPurgeDue = (entry: TrashedPosition, now: number): boolean =>
  now >= entry.deletedAt + POSITION_DELETE_GRACE_MS;
