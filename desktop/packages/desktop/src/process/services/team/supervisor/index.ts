/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers `supervisor.ensure` (common/chat/supervisor/supervisorBridge.ts) and
 * keeps the workspace honest at startup: the reconciliation that retires
 * expired teams runs once when the bridge comes up, not only when the user
 * first opens the supervisor's conversation.
 */
import { supervisorBridge } from '@/common/chat/team/supervisor/supervisorBridge';
import { kyrnFailure, type KyrnResult } from '@/common/kyrn/errors';
import { ensureSupervisorWorkspace, listSupervisorTeams, registerSupervisorTeam } from './supervisorService';

export {
  ensureSupervisorWorkspace,
  ensureSupervisorWorkspaceIn,
  listSupervisorTeams,
  registerSupervisorTeam,
  registerSupervisorTeamIn,
} from './supervisorService';

// Always answer, failures included: the generic bridge only logs a provider's exception, and the window would wait.
async function result<T>(work: () => Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

export function initSupervisorBridge(): void {
  supervisorBridge.ensure.provider(() => result(() => ensureSupervisorWorkspace()));
  supervisorBridge.teams.provider(() => result(() => listSupervisorTeams().then((teams) => ({ teams }))));
  supervisorBridge.registerTeam.provider((params) =>
    result(() => registerSupervisorTeam(params).then((teams) => ({ teams })))
  );
  void ensureSupervisorWorkspace().catch((error) => {
    console.warn('[supervisor] startup reconciliation failed', error);
  });
}
