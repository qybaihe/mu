/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The context steward between the window and the main process
 * (process/services/team/contextSteward/). One call per finished turn: the
 * main process reads the session's live token count, and only when it stands
 * at the check line asks the engine once and ACTS — compact in place, or
 * switch the session to a fresh part conversation. `skip` is the overwhelming
 * majority answer (below the line, not a stewarded conversation, no usable
 * count) and touches nothing.
 */
import { bridge } from '../../../platform/bridge';
import type { KyrnResult } from '../../../kyrn/errors';

/** What one run did. `skip` reasons are diagnostics for the dev log, never user-facing. */
export type ContextStewardRunResult =
  | {
      action: 'compact';
      reason: string;
      tokens: number;
      contextWindow: number;
      percent: number | null;
    }
  | {
      action: 'switch';
      reason: string;
      /** The conversation the part chain left behind, now renamed `(part N)`. */
      oldConversationId: string;
      newConversationId: string;
      oldTitle: string;
      newTitle: string;
      part: number;
      tokens: number;
      contextWindow: number;
      percent: number | null;
    }
  | { action: 'none'; reason: string }
  | { action: 'skip'; reason: string };

export const contextStewardBridge = {
  /** One finished turn of one conversation: check the line, decide once if it is crossed, act. */
  run: bridge.buildProvider<KyrnResult<ContextStewardRunResult>, { conversationId: string }>('contextSteward.run'),
};
