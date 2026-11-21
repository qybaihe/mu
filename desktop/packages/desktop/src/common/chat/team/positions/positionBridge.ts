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
import type { PositionDraft, ProjectProfile } from './positionProjectProfile';
import type { TemplateCatalogStatus, TemplateEntry } from './templateCatalogCore';
import type { TrashedPosition } from './positionTrashCore';

/** The position's workspace folder, and whether its injected rules file changed. */
export type PositionWorkspaceResult = { workspace: string; changed: boolean };

/** The wizard's analysis of one picked directory. */
export type ProjectAnalysis = {
  profile: ProjectProfile;
  draft: PositionDraft;
  /** True when a one-shot mu run produced this answer (the AI deep analysis). */
  aiUsed: boolean;
};

/** What the wizard's create step writes; the body carries the project-root line. */
export type CreatePositionParams = {
  id: string;
  displayName: string;
  description: string;
  antiJob?: string[];
  body: string;
};

export const positionBridge = {
  /** The roster, in library order; empty when the user has no position library. */
  list: bridge.buildProvider<PositionInfo[], void>('positions.list'),
  /** Prepares (and refreshes) one position's workspace and its gate file. */
  ensureWorkspace: bridge.buildProvider<KyrnResult<PositionWorkspaceResult>, { name: string }>(
    'positions.ensure-workspace'
  ),
  /**
   * The creation wizard's analysis of a directory: heuristic (zero model
   * calls) unless `deep`, which runs a one-shot mu analysis there instead —
   * the wizard offers it when the heuristic found nothing.
   */
  analyzeProject: bridge.buildProvider<KyrnResult<ProjectAnalysis>, { dir: string; deep?: boolean }>(
    'positions.analyze-project'
  ),
  /** The wizard's write: one new library file, added and nothing else. */
  createPosition: bridge.buildProvider<KyrnResult<PositionInfo>, CreatePositionParams>('positions.create'),
  /** Ensures the template catalog cache is on disk (downloading when missing,
   *  or when `refresh` asks); the wizard's template tab opens with this. */
  templatesEnsure: bridge.buildProvider<KyrnResult<TemplateCatalogStatus>, { refresh?: boolean }>(
    'positions.templates-ensure'
  ),
  /** Searches the cached catalog for the wizard's template tab. */
  templatesSearch: bridge.buildProvider<
    KyrnResult<{
      status: TemplateCatalogStatus;
      results: TemplateEntry[];
      categories: { category: string; count: number }[];
    }>,
    { query: string; category?: string; limit?: number }
  >('positions.templates-search'),
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
