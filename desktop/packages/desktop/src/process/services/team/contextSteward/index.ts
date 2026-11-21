/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers the contextSteward bridge (common/chat/team/contextSteward/
 * contextStewardBridge.ts): the after-turn check behind the ⚡ steward rows.
 * Always answers — a steward failure is a `skip` with a reason, and the
 * conversation flow is never touched by one.
 */
import { contextStewardBridge } from '@/common/chat/team/contextSteward/contextStewardBridge';
import { kyrnFailure, type KyrnResult } from '@/common/kyrn/errors';
import { runContextSteward } from './contextStewardService';

export {
  runContextSteward,
  runContextStewardIn,
  resetContextStewardStateForTest,
  type ContextStewardDeps,
} from './contextStewardService';

async function result<T>(work: () => Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    // The steward's own contract is "never throw, answer skip"; this catch is
    // the belt under it — a turn-end must never die on the steward.
    console.warn('[contextSteward] run failed', error);
    return kyrnFailure(error);
  }
}

export function initContextStewardBridge(): void {
  contextStewardBridge.run.provider(({ conversationId }) => result(() => runContextSteward(conversationId)));
}
