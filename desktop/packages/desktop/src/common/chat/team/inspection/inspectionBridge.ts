/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The resident inspection between the window and the main process
 * (`process/services/team/inspection/`). The schedules themselves are
 * system-owned and fire in the main process; the window only asks for a
 * manual run (the settings page's "run now" row) and gets back what the run
 * produced so it can toast the outcome.
 */
import { bridge } from '../../../platform/bridge';

/** What one manual run did — echoed by the settings row. */
export type InspectionRunResult = {
  ok: boolean;
  /** The report's absolute path when one was written. */
  reportPath?: string;
  /** The local date key the report covers. */
  dateKey: string;
  /** Why the run produced nothing (supervisor absent is NOT one — the report still lands). */
  error?: string;
};

export const inspectionBridge = {
  /** Runs one inspection now over a rolling 24h window, ignoring the schedule. */
  runNow: bridge.buildProvider<InspectionRunResult, void>('inspection.runNow'),
};
