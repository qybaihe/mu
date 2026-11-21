/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Waste audit: find turns that burned work without producing anything, from
 * the same persisted rows the friction scan reads. A turn starts at each
 * user row (`text` + `position:'right'`) and runs until the next one; the
 * per-turn usage API snapshot is null while a conversation idles, so the
 * audit measures MESSAGE FLOW instead of tokens — tool calls versus assistant
 * text volume, plus the error/interrupt outcome. Framework-free, fake-data
 * testable; every threshold below is a named constant with its reason.
 */

import { INTERRUPT_TITLE, INTERRUPT_TOOL_CALL_PREFIX, type ConversationMeta, type InspectionRow } from './frictionCore';

/** One user-to-user turn slice: what the user asked, what came back. */
export type TurnSlice = {
  startedAt: number;
  endedAt: number;
  assistantTextLen: number;
  toolCalls: number;
  toolErrors: number;
  errorTips: number;
  interrupted: boolean;
};

/** A turn that burned work without a usable answer. */
export type IdleTurn = TurnSlice & { reason: 'tools-no-output' | 'error-no-output' | 'interrupted' };

/** The same failure seen twice or more in one conversation. */
export type RepeatedFailure = { message: string; count: number };

/** The audit outcome for one conversation. */
export type ConversationWaste = {
  meta: ConversationMeta;
  turns: number;
  idleTurns: IdleTurn[];
  repeatedFailures: RepeatedFailure[];
  avgAssistantTextLen: number;
};

/** A turn with >= this many tool calls but less text than this is "burned tools, no answer". */
export const IDLE_TOOL_CALL_MIN = 3;
export const IDLE_OUTPUT_MAX_LEN = 200;
/** A turn ending in error tips with less text than this never answered. */
export const ERROR_OUTPUT_MAX_LEN = 50;
/** A low-output session row: at least this many turns, averaging under this much text. */
export const LOW_OUTPUT_TURNS_MIN = 2;
export const LOW_OUTPUT_AVG_MAX_LEN = 100;
/** Low-output rows must also be this fraction error/interrupt-laden turns. */
export const LOW_OUTPUT_BAD_TURN_RATIO = 0.5;

/** Splits window rows into user-anchored turns; rows before the first user row are ignored (no ask, no turn). */
export function splitTurns(rows: ReadonlyArray<InspectionRow>): TurnSlice[] {
  const turns: TurnSlice[] = [];
  let current: TurnSlice | undefined;
  let lastAt = 0;
  for (const row of rows) {
    const at = row.created_at ?? 0;
    lastAt = Math.max(lastAt, at);
    if (row.type === 'text' && row.position === 'right') {
      if (current) current.endedAt = lastAt;
      current = {
        startedAt: at,
        endedAt: lastAt,
        assistantTextLen: 0,
        toolCalls: 0,
        toolErrors: 0,
        errorTips: 0,
        interrupted: false,
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (row.type === 'text' && row.position === 'left') {
      const text = (row.content as { content?: unknown } | undefined)?.content;
      if (typeof text === 'string') current.assistantTextLen += text.length;
      continue;
    }
    if (row.type === 'tips' && (row.content as { type?: unknown } | undefined)?.type === 'error') {
      current.errorTips += 1;
      continue;
    }
    if (row.type === 'acp_tool_call' && typeof row.content === 'object' && row.content !== null) {
      const update = (row.content as { update?: unknown }).update;
      if (typeof update !== 'object' || update === null) continue;
      const { tool_call_id, title, status } = update as { tool_call_id?: unknown; title?: unknown; status?: unknown };
      if (typeof tool_call_id === 'string' && tool_call_id.startsWith(INTERRUPT_TOOL_CALL_PREFIX)) {
        // Only the exact user-stop title counts; other notices (checklists, progress) are skipped entirely.
        if (title === INTERRUPT_TITLE) current.interrupted = true;
        continue;
      }
      current.toolCalls += 1;
      if (status === 'error') current.toolErrors += 1;
    }
  }
  return turns;
}

const idleReasonOf = (turn: TurnSlice): IdleTurn['reason'] | undefined => {
  if (turn.interrupted) return 'interrupted';
  if (turn.errorTips > 0 && turn.assistantTextLen < ERROR_OUTPUT_MAX_LEN) return 'error-no-output';
  if (turn.toolCalls >= IDLE_TOOL_CALL_MIN && turn.assistantTextLen < IDLE_OUTPUT_MAX_LEN) return 'tools-no-output';
  return undefined;
};

/** Audits one conversation's window rows: idle turns, repeated failures, averages. */
export function auditConversationWaste(meta: ConversationMeta, rows: ReadonlyArray<InspectionRow>): ConversationWaste {
  const turns = splitTurns(rows);
  const idleTurns: IdleTurn[] = [];
  for (const turn of turns) {
    const reason = idleReasonOf(turn);
    if (reason) idleTurns.push({ ...turn, reason });
  }
  const failureCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.type !== 'tips' || (row.content as { type?: unknown } | undefined)?.type !== 'error') continue;
    const text = (row.content as { content?: unknown }).content;
    if (typeof text !== 'string') continue;
    const key = text.slice(0, 120);
    failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
  }
  const repeatedFailures = [...failureCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count);
  const avgAssistantTextLen =
    turns.length === 0 ? 0 : Math.round(turns.reduce((sum, t) => sum + t.assistantTextLen, 0) / turns.length);
  return { meta, turns: turns.length, idleTurns, repeatedFailures, avgAssistantTextLen };
}

/** One row of the "lowest-yield sessions" table; ranked worst-first by the caller. */
export type LowOutputSession = {
  meta: ConversationMeta;
  turns: number;
  avgAssistantTextLen: number;
  badTurns: number;
};

/** Picks the sessions that ran turns but barely produced: the audit's top table. */
export function selectLowOutputSessions(wastes: ReadonlyArray<ConversationWaste>, topN = 5): LowOutputSession[] {
  const rows: LowOutputSession[] = [];
  for (const waste of wastes) {
    if (waste.turns < LOW_OUTPUT_TURNS_MIN) continue;
    const badTurns = waste.idleTurns.length;
    if (waste.avgAssistantTextLen >= LOW_OUTPUT_AVG_MAX_LEN) continue;
    if (badTurns / waste.turns < LOW_OUTPUT_BAD_TURN_RATIO) continue;
    rows.push({ meta: waste.meta, turns: waste.turns, avgAssistantTextLen: waste.avgAssistantTextLen, badTurns });
  }
  return rows.sort((a, b) => b.badTurns - a.badTurns || a.avgAssistantTextLen - b.avgAssistantTextLen).slice(0, topN);
}
