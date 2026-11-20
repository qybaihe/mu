/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers `positions.list`, `positions.ensure-workspace` and the delete
 * quarantine's three providers (common/chat/positions/positionBridge.ts).
 * The startup pass reconciles the quarantine: grace-expired entries are
 * deleted for real before anything lists them.
 */
import { positionBridge } from '@/common/chat/team/positions/positionBridge';
import { kyrnFailure, type KyrnResult } from '@/common/kyrn/errors';
import {
  ensurePositionWorkspace,
  listPositions,
  listTrashedPositions,
  purgeDueTrashedPositions,
  restoreTrashedPosition,
  trashPosition,
} from './positionService';

export {
  ensurePositionWorkspace,
  ensurePositionWorkspaceIn,
  listPositions,
  listTrashedPositions,
  purgeDueTrashedPositions,
  purgeDueTrashedPositionsIn,
  restoreTrashedPosition,
  restoreTrashedPositionIn,
  safeFolderName,
  scanPositionLibrary,
  trashPosition,
  trashPositionIn,
} from './positionService';

// Always answer IPC, including failure: the generic bridge otherwise only logs exceptions.
async function result<T>(work: () => T | Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

export function initPositionsBridge(): void {
  positionBridge.list.provider(() => listPositions());
  positionBridge.ensureWorkspace.provider(({ name }) => result(() => ensurePositionWorkspace(name)));
  // The manifest read is also the lazy reconcile: an expired quarantine entry
  // is deleted the moment anything lists the trash.
  positionBridge.trashedList.provider(() => purgeDueTrashedPositions().then(() => listTrashedPositions()));
  positionBridge.deletePosition.provider(({ name }) =>
    result(() => trashPosition({ name }).then((): Promise<void> => undefined))
  );
  positionBridge.restorePosition.provider(({ file }) => result(() => restoreTrashedPosition({ file })));
  // The startup pass, so a quarantine ages out even if nothing ever lists it.
  void purgeDueTrashedPositions().catch((error) => {
    console.warn('[positions] startup trash reconciliation failed', error);
  });
}
