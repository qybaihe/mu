/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers `team-workspace.readHandoff` (common/chat/teamWorkspace/handoffBridge.ts).
 */
import { teamWorkspaceBridge } from '@/common/chat/team/teamWorkspace/handoffBridge';
import { kyrnFailure, type KyrnResult } from '@/common/kyrn/errors';
import { getPlatformServices } from '@/common/platform';
import { isSeedableTeamWorkspace } from '@process/services/team/teamDispatch/dispatchSeedService';
import { readTeamHandoffIn } from './handoffService';

export { readTeamHandoffIn } from './handoffService';

// Always answer, failures included: the generic bridge only logs a provider's exception, and the window would wait.
async function result<T>(work: () => Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

export function initTeamWorkspaceBridge(): void {
  teamWorkspaceBridge.readHandoff.provider(({ workspace }) =>
    result(async () => {
      const dataDir = getPlatformServices().paths.getDataDir();
      // The refusal is logged, not just answered: a workspace outside the app
      // data dir means a compromised renderer aiming the read somewhere else.
      if (!isSeedableTeamWorkspace(workspace, dataDir))
        console.warn(`[teamWorkspace] refused to read a workspace outside the app data dir: ${workspace}`);
      return readTeamHandoffIn(workspace, { dataDir });
    })
  );
}
