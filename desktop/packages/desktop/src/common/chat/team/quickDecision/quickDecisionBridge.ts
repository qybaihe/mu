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
import type { PositionThinkingLevel } from '@/common/chat/team/thinkingLevel/thinkingLevelCore';

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
  durationMs: number;
  cached: boolean;
};

/** No short-circuit: the ordinary flow runs; `reason` is the dev-log diagnosis, never user-facing. */
export type QuickDecisionFullResult = { action: 'full'; reason: string };

export type QuickDecisionRouteResult = QuickDecisionReuseResult | QuickDecisionRejectResult | QuickDecisionFullResult;

/** Point C: a whole-team send asking where the message belongs. */
export type QuickDecisionRouteTeamParams = { input: string; teamId: string };

/** Point C short-circuited: the message is with the teammate directly (delivered by the main process). */
export type QuickDecisionDirectResult = {
  action: 'direct';
  slotId: string;
  memberName: string;
  reason: string;
  confidence: number;
  model: string;
  durationMs: number;
  cached: boolean;
};

export type QuickDecisionRouteTeamResult = QuickDecisionDirectResult | QuickDecisionFullResult;

/** Point D: a supervisor send asking for pre-matched candidate positions. */
export type QuickDecisionHintParams = { input: string };

/** Point F's ask: one task text whose complexity decides the target session's thinking level. */
export type QuickDecisionThinkingParams = { input: string };

/** Point F's answer: the level the target conversation should run this task on, or keep the current one. */
export type QuickDecisionThinkingResult =
  | {
      action: 'set';
      level: PositionThinkingLevel;
      reason: string;
      confidence: number;
      model: string;
      durationMs: number;
      cached: boolean;
    }
  | { action: 'keep'; reason: string };

/** Point D's answer: the hint line to prefix the task with, or nothing. */
export type QuickDecisionHintResult =
  | {
      action: 'hint';
      positions: Array<{ id: string; label: string }>;
      reason: string;
      confidence: number;
      model: string;
      durationMs: number;
      cached: boolean;
    }
  | { action: 'none'; reason: string };

/** The one-line wire format prefixed to the task: `[[MU_DISPATCH_HINT]] positions=a,b`. */
export const DISPATCH_HINT_MARKER = '[[MU_DISPATCH_HINT]]';

/** The hint as the supervisor's message carries it: one marker line above the task text. */
export const dispatchHintLine = (ids: readonly string[]): string =>
  `${DISPATCH_HINT_MARKER} positions=${ids.join(',')}`;

export const quickDecisionBridge = {
  /**
   * Routes one send through the quick-decision layer. `full` is the majority
   * answer by design: no model configured, cache miss and timeout, low
   * confidence, or a failed delivery all mean the original flow — unchanged
   * — takes over.
   */
  route: bridge.buildProvider<KyrnResult<QuickDecisionRouteResult>, QuickDecisionRouteParams>('quickDecision.route'),
  /**
   * Routes one group-chat (whole-team) send: `direct` means the message was
   * delivered to that teammate's slot and the whole-team path is skipped;
   * `full` — every doubt — runs the ordinary whole-team send unchanged.
   */
  routeTeamMessage: bridge.buildProvider<KyrnResult<QuickDecisionRouteTeamResult>, QuickDecisionRouteTeamParams>(
    'quickDecision.routeTeamMessage'
  ),
  /**
   * Pre-matches candidate positions for one supervisor-bound task. `hint` is
   * advisory — the caller prefixes one wire line onto the task and the
   * supervisor re-checks it; `none` means send the task untouched.
   */
  dispatchHint: bridge.buildProvider<KyrnResult<QuickDecisionHintResult>, QuickDecisionHintParams>(
    'quickDecision.dispatchHint'
  ),
  /**
   * Evaluates one task's complexity into one of the four thinking levels
   * (`off`/`low`/`medium`/`high`). `set` is the caller's cue to switch the
   * target conversation's thinking option BEFORE the send; `keep` — every
   * doubt, and an unconfigured engine — leaves the current level untouched.
   */
  thinkingLevel: bridge.buildProvider<KyrnResult<QuickDecisionThinkingResult>, QuickDecisionThinkingParams>(
    'quickDecision.thinkingLevel'
  ),
};
