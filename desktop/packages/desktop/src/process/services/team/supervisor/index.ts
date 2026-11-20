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
import {
  cleanupOrphanTeamWorkspaces,
  ensureSupervisorWorkspace,
  ensureSupervisorWorkspaceWithCatalog,
  listSupervisorTeams,
  purgeDueDeletedTeams,
  registerSupervisorTeam,
  restoreSupervisorTeam,
  setTeamLifecycle,
  softDeleteSupervisorTeam,
} from './supervisorService';

export {
  cleanupOrphanTeamWorkspaces,
  cleanupOrphanTeamWorkspacesIn,
  ensureSupervisorWorkspace,
  ensureSupervisorWorkspaceIn,
  ensureSupervisorWorkspaceWithCatalog,
  listSupervisorTeams,
  purgeDueDeletedTeams,
  purgeDueDeletedTeamsIn,
  registerSupervisorTeam,
  registerSupervisorTeamIn,
  restoreSupervisorTeam,
  restoreSupervisorTeamIn,
  reuseSupervisorTeamIn,
  setTeamLifecycle,
  setTeamLifecycleIn,
  softDeleteSupervisorTeam,
  softDeleteSupervisorTeamIn,
  type DeleteTeamForPurge,
  type OrphanWorkspaceResult,
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
  // The teams read is also the lazy delete reconcile: an expired soft delete
  // is purged (backend DELETE, then the row) the moment anything re-reads the
  // index, so the monitor and sidebar stay the honest mirrors of the file.
  // The orphan-workspace sweep rides along, best-effort: its failure never
  // fails the read.
  supervisorBridge.teams.provider(() =>
    result(() =>
      purgeDueDeletedTeams()
        .then(() =>
          cleanupOrphanTeamWorkspaces().catch((error) =>
            console.warn('[supervisor] orphan workspace sweep failed', error)
          )
        )
        .then(() => listSupervisorTeams().then((teams) => ({ teams })))
    )
  );
  supervisorBridge.registerTeam.provider((params) =>
    result(() => registerSupervisorTeam(params).then((teams) => ({ teams })))
  );
  supervisorBridge.setTeamLifecycle.provider((params) =>
    result(() => setTeamLifecycle(params).then((teams) => ({ teams })))
  );
  supervisorBridge.softDeleteTeam.provider((params) =>
    result(() => softDeleteSupervisorTeam(params).then((teams) => ({ teams })))
  );
  supervisorBridge.restoreTeam.provider((params) =>
    result(() => restoreSupervisorTeam(params).then((teams) => ({ teams })))
  );
  // The startup pass: the canonical rewrite (retiring expired teams), then
  // the delete reconcile (backend DELETE for grace-expired soft deletes),
  // then the orphan-workspace sweep (grace-expired folders no row explains).
  void ensureSupervisorWorkspaceWithCatalog()
    .then(() => purgeDueDeletedTeams())
    .then(() => cleanupOrphanTeamWorkspaces())
    .catch((error) => {
      console.warn('[supervisor] startup reconciliation failed', error);
    });
}
