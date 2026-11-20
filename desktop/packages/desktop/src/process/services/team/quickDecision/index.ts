/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers `quickDecision.route` (common/chat/quickDecision/quickDecisionBridge.ts):
 * the pre-send decision layer behind the ⚡ short-circuits. Always answers —
 * a thrown provider would hang the send — and the majority answer is `full`.
 */
import { quickDecisionBridge } from '@/common/chat/team/quickDecision/quickDecisionBridge';
import type {
  QuickDecisionRouteParams,
  QuickDecisionRouteResult,
} from '@/common/chat/team/quickDecision/quickDecisionBridge';
import { kyrnFailure, type KyrnResult } from '@/common/kyrn/errors';
import { routeQuickDecision } from './quickDecisionService';

export {
  routeQuickDecision,
  routeQuickDecisionIn,
  resetQuickDecisionStateForTest,
  type QuickDecisionCounters,
  type QuickDecisionDeps,
} from './quickDecisionService';

async function result(work: () => Promise<QuickDecisionRouteResult>): Promise<KyrnResult<QuickDecisionRouteResult>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    // The decision layer's own contract is "never throw, answer full"; this
    // catch is the belt under it — a send must never die on the short-circuit.
    console.warn('[quickDecision] route failed, falling back to the full flow', error);
    return kyrnFailure(error);
  }
}

export function initQuickDecisionBridge(): void {
  quickDecisionBridge.route.provider((params: QuickDecisionRouteParams) => result(() => routeQuickDecision(params)));
}
