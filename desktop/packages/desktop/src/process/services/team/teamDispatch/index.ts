/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers `team-dispatch.seed` (common/chat/teamDispatch/dispatchSeedBridge.ts).
 */
import { dispatchSeedBridge } from '@/common/chat/team/teamDispatch/dispatchSeedBridge';
import { kyrnFailure, type KyrnResult } from '@/common/kyrn/errors';
import { getPlatformServices } from '@/common/platform';
import { isSeedableTeamWorkspace, seedDispatchRulesIn } from './dispatchSeedService';

export { isSeedableTeamWorkspace, seedDispatchRulesIn } from './dispatchSeedService';

// Always answer, failures included: the generic bridge only logs a provider's exception, and the window would wait.
async function result<T>(work: () => Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

export function initTeamDispatchBridge(): void {
  dispatchSeedBridge.seed.provider(({ workspace }) =>
    result(async () => {
      const dataDir = getPlatformServices().paths.getDataDir();
      // The refusal is logged, not just answered: a workspace outside the app
      // data dir means a compromised renderer aiming the write somewhere else.
      if (!isSeedableTeamWorkspace(workspace, dataDir))
        console.warn(`[teamDispatch] refused to seed a workspace outside the app data dir: ${workspace}`);
      return { changed: await seedDispatchRulesIn(workspace, { dataDir }) };
    })
  );
}
