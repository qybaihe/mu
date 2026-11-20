/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers `positions.list` and `positions.ensure-workspace`
 * (common/chat/positions/positionBridge.ts).
 */
import { positionBridge } from '@/common/chat/team/positions/positionBridge';
import { kyrnFailure, type KyrnResult } from '@/common/kyrn/errors';
import { ensurePositionWorkspace, listPositions } from './positionService';

export {
  ensurePositionWorkspace,
  ensurePositionWorkspaceIn,
  listPositions,
  safeFolderName,
  scanPositionLibrary,
} from './positionService';

// Always answer, failures included: the generic bridge only logs a provider's exception, and the window would wait.
async function result<T>(work: () => Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

export function initPositionsBridge(): void {
  positionBridge.list.provider(() => listPositions());
  positionBridge.ensureWorkspace.provider(({ name }) => result(() => ensurePositionWorkspace(name)));
}
