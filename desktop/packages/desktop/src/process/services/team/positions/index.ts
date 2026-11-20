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
import { KyrnError, kyrnFailure, type KyrnResult } from '@/common/kyrn/errors';
import {
  analyzeProjectDirectory,
  createPosition,
  ensurePositionWorkspace,
  listPositions,
  listTrashedPositions,
  purgeDueTrashedPositions,
  restoreTrashedPosition,
  trashPosition,
} from './positionService';
import { runDeepAnalysis } from './positionDeepAnalysis';

export {
  analyzeProjectDirectory,
  createPosition,
  createPositionIn,
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
  // The creation wizard: heuristic analysis always answers; the deep variant
  // may legitimately fail (no harness, timeout, an unparseable answer) and
  // says so as a KyrnResult failure the wizard reports without losing the
  // heuristic answer it already has.
  positionBridge.analyzeProject.provider(({ dir, deep }) =>
    result(async () => {
      if (!deep) return { ...(await analyzeProjectDirectory(dir)), aiUsed: false };
      const run = await runDeepAnalysis(dir);
      // `=== false`, not `!run.ok`: the project's tsconfig runs without strict, where a
      // falsiness check does not narrow a discriminated union.
      if (run.ok === false)
        throw new KyrnError('unknown', `The deep analysis failed: ${run.reason}`, { detail: run.detail });
      return {
        profile: {
          directory: dir,
          projectName: run.analysis.projectName,
          goal: run.analysis.goal,
          techStack: run.analysis.techStack,
          constraints: run.analysis.constraints,
          sources: ['ai'],
          empty: false,
        },
        draft: run.draft,
        aiUsed: true,
      };
    })
  );
  positionBridge.createPosition.provider((params) => result(() => createPosition(params)));
  // The startup pass, so a quarantine ages out even if nothing ever lists it.
  void purgeDueTrashedPositions().catch((error) => {
    console.warn('[positions] startup trash reconciliation failed', error);
  });
}
