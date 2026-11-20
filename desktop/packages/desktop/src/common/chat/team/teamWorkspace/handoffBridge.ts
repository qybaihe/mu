/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reading a team workspace's HANDOFF.md, between the window and the main
 * process (process/services/teamWorkspace/). The window knows only the
 * workspace path the backend reported; the main process validates it is one
 * of the app's own team folders and reads the file, so the renderer can
 * never aim the read at an arbitrary path.
 */
import { bridge } from '../../../platform/bridge';
import type { KyrnResult } from '../../../kyrn/errors';

/** The record as the window sees it: the content, or `missing` when no record exists yet. */
export type TeamHandoffResult = { status: 'ok'; content: string; truncated: boolean } | { status: 'missing' };

export const teamWorkspaceBridge = {
  readHandoff: bridge.buildProvider<KyrnResult<TeamHandoffResult>, { workspace: string }>('team-workspace.readHandoff'),
};
