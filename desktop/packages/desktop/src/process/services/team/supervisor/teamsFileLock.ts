/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The TEAMS.md write lock, main-process side. Every read-modify-write cycle
 * the supervisor service runs on the shared index happens inside
 * `withTeamsIndexLock`, and every `teams.cjs` copy embeds the same policy
 * (O_EXCL create, stale takeover): the desktop and the agents the script runs
 * for are separate processes mutating one file, so mutual exclusion has to
 * live on the filesystem, next to the file it guards. A holder that died with
 * the lock in hand leaves the file behind; a waiter takes it over once its
 * mtime is older than the stale span (verified against a second stat, so a
 * lock replaced between the two looks is not unlinked), then re-races for the
 * create — the one that wins holds, the others keep waiting. Holders hold for
 * milliseconds (read, splice, write), so waiting is a short poll, not a queue.
 */
import { open, mkdir, stat, unlink, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SHARED_TEAMS_FOLDER,
  TEAMS_FILE_NAME,
  TEAMS_LOCK_STALE_MS,
  TEAMS_LOCK_SUFFIX,
} from '@/common/chat/team/supervisor/supervisorCore';

/** The lock file's path under a data dir. */
export const teamsLockFileOf = (dataDir: string): string =>
  join(dataDir, 'positions', SHARED_TEAMS_FOLDER, TEAMS_FILE_NAME + TEAMS_LOCK_SUFFIX);

/** How long a waiter sleeps between attempts while a live holder works. */
const POLL_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` holding the index lock: the exclusive create succeeds exactly
 * once per holder, so the read-modify-write inside sees no concurrent writer.
 * The lock is released in `finally`; a work crash between create and release
 * leaves a stale lock the next holder takes over after the stale span.
 */
export async function withTeamsIndexLock<T>(dataDir: string, work: () => Promise<T>): Promise<T> {
  const lockFile = teamsLockFileOf(dataDir);
  await mkdir(join(dataDir, 'positions', SHARED_TEAMS_FOLDER), { recursive: true });
  for (;;) {
    const handle = await open(lockFile, 'wx').catch((error: NodeJS.ErrnoException) =>
      error.code === 'EEXIST' ? undefined : Promise.reject(error)
    );
    if (handle !== undefined) {
      await handle.close();
      break;
    }
    // Held: stale means its writer is gone (holders hold for milliseconds);
    // the takeover unlinks only a file whose mtime still matches the stale
    // one, never a fresh lock another waiter just won.
    const held = await stat(lockFile).catch((error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' ? undefined : Promise.reject(error)
    );
    if (held === undefined) continue;
    if (Date.now() - held.mtimeMs > TEAMS_LOCK_STALE_MS) {
      const again = await stat(lockFile).catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? undefined : Promise.reject(error)
      );
      if (again !== undefined && again.mtimeMs === held.mtimeMs) {
        await unlink(lockFile).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      continue;
    }
    await sleep(POLL_MS);
  }
  try {
    return await work();
  } finally {
    await unlink(lockFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/**
 * Writes a file by temp-then-rename: readers of the index never see a torn
 * half-written file (a parse that hits a truncated first line would read as
 * an empty index). Callers hold the lock; the rename keeps the unlocked
 * readers honest.
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.write`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, file);
}
