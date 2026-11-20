/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The team workspace's record file (HANDOFF.md), read-only for the window:
 * the dispatch rules every member runs make each of them append this task's
 * record there, so the group chat's header offers the file as the team's
 * workbench record. All fs work for that read lives here; whether a workspace
 * is one of the app's own team folders is decided by the dispatch seed's
 * `isSeedableTeamWorkspace` — the same bar the write side holds.
 */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { KyrnError } from '@/common/kyrn/errors';
import { isSeedableTeamWorkspace } from '@process/services/team/teamDispatch/dispatchSeedService';

/** The record file's name in a team workspace (the dispatch rules' 收尾落账 target). */
const HANDOFF_FILE_NAME = 'HANDOFF.md';

/**
 * How much of the record is read: the file is agent-appended and small in
 * practice — the cap only bounds a runaway file, and `truncated` tells the
 * window the record continues past what it shows (a cut mid-codepoint reads
 * as one replacement character at the tail).
 */
const HANDOFF_READ_CAP = 1024 * 1024;

/** The record's answer: the content (maybe capped), or `missing` when no record exists yet. */
export type TeamHandoff = { status: 'ok'; content: string; truncated: boolean } | { status: 'missing' };

/**
 * Reads `workspace`'s record file. A missing file is `missing` — a team that
 * never wrapped up a task has no record yet, not an error; any other read
 * failure propagates. The workspace must be one of the app's own team
 * folders under `dataDir` (`isSeedableTeamWorkspace`): a renderer-supplied
 * path outside them is refused, not read.
 */
export async function readTeamHandoffIn(workspace: string, options: { dataDir: string }): Promise<TeamHandoff> {
  if (!isSeedableTeamWorkspace(workspace, options.dataDir))
    throw new KyrnError('invalid', 'The workspace is not a team workspace of this app', { workspace });
  const handle = await open(join(workspace, HANDOFF_FILE_NAME), 'r').catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? undefined : Promise.reject(error)
  );
  if (handle === undefined) return { status: 'missing' };
  try {
    const buffer = Buffer.alloc(HANDOFF_READ_CAP + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > HANDOFF_READ_CAP;
    return {
      status: 'ok',
      // The +1 probe byte decides truncation; the shown text stops at the cap.
      content: buffer.subarray(0, truncated ? HANDOFF_READ_CAP : bytesRead).toString('utf8'),
      truncated,
    };
  } finally {
    await handle.close();
  }
}
