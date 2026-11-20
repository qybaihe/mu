/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The position roster between the window and the main process
 * (process/services/positions/). The window asks for the library as it
 * changes; before a position's first conversation it asks the main process to
 * prepare that position's dedicated workspace, where the injected
 * AGENTS.override.md carries the position identity and the ownership gate.
 */
import { bridge } from '../../../platform/bridge';
import type { KyrnResult } from '../../../kyrn/errors';
import type { PositionInfo } from './positionLibraryCore';
import type { TrashedPosition } from './positionTrashCore';

/** The position's workspace folder, and whether its injected rules file changed. */
export type PositionWorkspaceResult = { workspace: string; changed: boolean };

export const positionBridge = {
  /** The roster, in library order; empty when the user has no position library. */
  list: bridge.buildProvider<PositionInfo[], void>('positions.list'),
  /** Prepares (and refreshes) one position's workspace and its gate file. */
  ensureWorkspace: bridge.buildProvider<KyrnResult<PositionWorkspaceResult>, { name: string }>(
    'positions.ensure-workspace'
  ),
  /**
   * The delete quarantine's manifest (also its lazy reconcile: grace-expired
   * entries are purged before the list answers), as the monitor lists it.
   */
  trashedList: bridge.buildProvider<TrashedPosition[], void>('positions.trashed-list'),
  /** Soft-deletes one position: its file moves into the quarantine, restorable for the grace. */
  deletePosition: bridge.buildProvider<KyrnResult<void>, { name: string }>('positions.delete'),
  /** Restores one quarantined position (by its origin file name); answers the manifest that remains. */
  restorePosition: bridge.buildProvider<KyrnResult<TrashedPosition[]>, { file: string }>('positions.restore'),
};
