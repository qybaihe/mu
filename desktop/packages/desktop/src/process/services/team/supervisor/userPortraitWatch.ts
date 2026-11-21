/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hot refresh of the user portrait: a watch of the shared folder
 * (`positions/_shared/`) that notices USER.md changes — the settings editor's
 * save and a hand edit arrive as the same directory event — and hands each
 * settled change to the caller, which rebuilds the gates that embed the
 * portrait (the supervisor's and every position's). Each live conversation's
 * own gate watch (agent/kyrn/gateReload.ts) then reloads what opened, so a
 * portrait edit reaches open sessions without reopening them. Best-effort:
 * a folder that cannot be watched simply has no hot refresh — the next
 * ensure still reads the file as it is.
 */
import { watch } from 'node:fs';
import { USER_PORTRAIT_FILE_NAME } from '@/common/chat/team/positions/userPortraitCore';

/** Edit bursts settle before the refresh runs: a save fires several events. */
export const USER_PORTRAIT_SETTLE_MS = 500;

/** One settled USER.md change. */
export type UserPortraitChange = () => void;

/** The watch of the shared folder: notice portrait changes, refresh once per burst. */
export interface UserPortraitWatch {
  /** Stops watching and forgets the pending refresh. */
  close(): void;
}

/**
 * Watches `dir` for USER.md changes and calls `onChange` once per settled
 * burst. The watch is of the folder (not the file), so a hand-deleted and
 * re-created portrait still reaches the callback; the callback is
 * fire-and-forget by contract — it may be async, its failures are its own.
 */
export function watchUserPortrait(
  dir: string,
  onChange: UserPortraitChange,
  settleMs: number = USER_PORTRAIT_SETTLE_MS
): UserPortraitWatch {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const fire = (): void => {
    timer = undefined;
    try {
      onChange();
    } catch (error) {
      console.warn('[supervisor] user-portrait refresh failed', error);
    }
  };
  const schedule = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, settleMs);
  };
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (closed || !filename || filename.toLowerCase() !== USER_PORTRAIT_FILE_NAME.toLowerCase()) return;
      schedule();
    });
  } catch {
    // Unwatchable folder: no hot refresh, the ensure cadence still reads the file.
  }
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      watcher?.close();
    },
  };
}
