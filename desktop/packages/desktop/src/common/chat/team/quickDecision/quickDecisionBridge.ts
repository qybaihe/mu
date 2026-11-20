/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The quick decision between the window and the main process
 * (process/services/quickDecision/). One atomic call per send: the main
 * process runs the configured cheap model (2s ceiling, conservative
 * fallback), and a `reuse` verdict also DELIVERS the task — the backend team
 * message plus the TEAMS.md lifecycle refresh, teams.cjs `send` semantics —
 * before answering, so the window never acts on a verdict the delivery
 * already failed. Any doubt answers `full`, and the ordinary send path runs
 * unchanged.
 */
import { bridge } from '../../../platform/bridge';
import type { KyrnResult } from '../../../kyrn/errors';

/** The send asking for a route: the task as typed, and the conversation's position marker (supervisor or a position id). */
export type QuickDecisionRouteParams = {
  input: string;
  positionMarker: string;
};

/** Point A short-circuited: the task is with the team, its lifecycle refreshed. */
export type QuickDecisionReuseResult = {
  action: 'reuse';
  teamId: string;
  teamName: string;
  leadConversationId: string;
  reason: string;
  confidence: number;
  model: string;
  /** Engine mode only: which tier decided (L1 jev / L2 glm); absent on a provider-path or cached decision. */
  tier?: 'L1' | 'L2';
  /** Engine mode, L1 only: the acting `probabilities[choice]` — the gate's number, not the model's `confidence`. */
  probability?: number;
  durationMs: number;
  cached: boolean;
};

/** Point B short-circuited: the position conversation answers with the gate's own rejection shape. */
export type QuickDecisionRejectResult = {
  action: 'reject';
  suggestId: string;
  suggestLabel: string;
  reason: string;
  confidence: number;
  model: string;
  /** Engine mode only: which tier decided (L1 jev / L2 glm); absent on a provider-path or cached decision. */
  tier?: 'L1' | 'L2';
  /** Engine mode, L1 only: the acting `probabilities[choice]`. */
  probability?: number;
  durationMs: number;
  cached: boolean;
};

/** No short-circuit: the ordinary flow runs; `reason` is the dev-log diagnosis, never user-facing. */
export type QuickDecisionFullResult = { action: 'full'; reason: string };

export type QuickDecisionRouteResult = QuickDecisionReuseResult | QuickDecisionRejectResult | QuickDecisionFullResult;

export const quickDecisionBridge = {
  /**
   * Routes one send through the quick-decision layer. `full` is the majority
   * answer by design: no model configured, cache miss and timeout, low
   * confidence, or a failed delivery all mean the original flow — unchanged
   * — takes over.
   */
  route: bridge.buildProvider<KyrnResult<QuickDecisionRouteResult>, QuickDecisionRouteParams>('quickDecision.route'),
};
