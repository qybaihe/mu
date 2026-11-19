/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Seeding the team dispatch rules into a team workspace's AGENTS.md, between
 * the window and the main process (process/services/teamDispatch/). The window
 * knows only the workspace path; the main process reads, merges and writes the
 * versioned block (common/chat/teamDispatch/dispatchRules.ts), so a fresh team
 * dispatches a goal without anyone being named, from its very first turn.
 */
import { bridge } from '../../platform/bridge';
import type { KyrnResult } from '../../kyrn/errors';

/** Whether the file changed; `false` means the rules were already in place. */
export type DispatchSeedResult = { changed: boolean };

export const dispatchSeedBridge = {
  seed: bridge.buildProvider<KyrnResult<DispatchSeedResult>, { workspace: string }>('team-dispatch.seed'),
};
