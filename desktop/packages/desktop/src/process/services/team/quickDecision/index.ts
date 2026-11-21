/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers the quickDecision bridge (common/chat/team/quickDecision/
 * quickDecisionBridge.ts): the pre-send decision layer behind the ⚡ rows.
 * Always answers — a thrown provider would hang the send — and the majority
 * answer is the conservative one (`full` / `none`).
 */
import { quickDecisionBridge } from '@/common/chat/team/quickDecision/quickDecisionBridge';
import type {
  QuickDecisionHintParams,
  QuickDecisionRouteParams,
  QuickDecisionRouteTeamParams,
  QuickDecisionThinkingParams,
} from '@/common/chat/team/quickDecision/quickDecisionBridge';
import { kyrnFailure, type KyrnResult } from '@/common/kyrn/errors';
import { routeQuickDecision, routeTeamMessage, dispatchHintFor, thinkingLevelFor } from './quickDecisionService';

export {
  routeQuickDecision,
  routeQuickDecisionIn,
  routeTeamMessage,
  routeTeamMessageIn,
  dispatchHintFor,
  dispatchHintIn,
  thinkingLevelFor,
  thinkingLevelIn,
  contextStewardDecision,
  contextStewardDecisionIn,
  resetQuickDecisionStateForTest,
  type ContextStewardAskParams,
  type ContextStewardEngineResult,
  type QuickDecisionCounters,
  type QuickDecisionDeps,
} from './quickDecisionService';

async function result<T>(work: () => Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    // The decision layer's own contract is "never throw, answer full"; this
    // catch is the belt under it — a send must never die on the short-circuit.
    console.warn('[quickDecision] decision failed, falling back to the ordinary flow', error);
    return kyrnFailure(error);
  }
}

export function initQuickDecisionBridge(): void {
  quickDecisionBridge.route.provider((params: QuickDecisionRouteParams) => result(() => routeQuickDecision(params)));
  quickDecisionBridge.routeTeamMessage.provider((params: QuickDecisionRouteTeamParams) =>
    result(() => routeTeamMessage(params))
  );
  quickDecisionBridge.dispatchHint.provider((params: QuickDecisionHintParams) => result(() => dispatchHintFor(params)));
  quickDecisionBridge.thinkingLevel.provider((params: QuickDecisionThinkingParams) =>
    result(() => thinkingLevelFor(params))
  );
}
