/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers the inspection bridge (common/chat/team/inspection/
 * inspectionBridge.ts) and starts the resident schedules: the weekday
 * friction scan and the Monday waste audit, both owned by the main process.
 */
import { inspectionBridge, type InspectionRunResult } from '@/common/chat/team/inspection/inspectionBridge';
import { localDateKey } from '@/common/chat/team/inspection/frictionCore';
import { runInspectionNow, startInspectionScheduler } from './inspectionService';

export { runInspectionNow, startInspectionScheduler } from './inspectionService';
export {
  fetchRowsThrough,
  runInspectionIn,
  startInspectionSchedulerIn,
  type InspectionDeps,
  type InspectionRunOutcome,
  type InspectionScheduler,
  type MessagePage,
} from './inspectionService';

async function result(work: () => Promise<InspectionRunResult>): Promise<InspectionRunResult> {
  try {
    return await work();
  } catch (error) {
    return { ok: false, dateKey: localDateKey(Date.now()), error: String(error) };
  }
}

export function initInspectionBridge(): void {
  inspectionBridge.runNow.provider(() => result(() => runInspectionNow()));
  // The schedules start with the app; failures inside a run log and re-arm.
  startInspectionScheduler();
}
