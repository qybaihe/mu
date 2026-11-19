/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answers `team-dispatch.seed` (common/chat/teamDispatch/dispatchSeedBridge.ts).
 */
import { dispatchSeedBridge } from '@/common/chat/teamDispatch/dispatchSeedBridge';
import { kyrnFailure, type KyrnResult } from '@/common/kyrn/errors';
import { seedDispatchRules } from './dispatchSeedService';

export { seedDispatchRules } from './dispatchSeedService';

// Always answer, failures included: the generic bridge only logs a provider's exception, and the window would wait.
async function result<T>(work: () => Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

export function initTeamDispatchBridge(): void {
  dispatchSeedBridge.seed.provider(({ workspace }) =>
    result(async () => ({ changed: await seedDispatchRules(workspace) }))
  );
}
