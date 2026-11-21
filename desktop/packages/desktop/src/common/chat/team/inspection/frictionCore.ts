/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Friction scan: aggregate "where did work hurt yesterday" from persisted
 * conversation rows. Three signals, each verified against live backend data:
 * an error tip row (`type:'tips'` + `content.type:'error'`, e.g. the
 * UNKNOWN_UPSTREAM_ERROR a killed adapter leaves), a failed tool call
 * (`acp_tool_call` row with `status:'error'`), and a user interrupt
 * (`acp_tool_call` row whose `tool_call_id` starts with `mu:notice:` — the
 * harness stamps "You stopped this reply." there). Framework-free so the
 * node test project can drive it with fixtures shaped like real rows.
 */

/** The minimal row shape the scan needs — a slice of the messages API's row. */
export type InspectionRow = {
  type?: string;
  position?: string;
  status?: string;
  created_at?: number;
  content?: unknown;
};

/** Which conversation a scan ran over; the display fields come from `extra`. */
export type ConversationMeta = {
  conversationId: string;
  name: string;
  position?: string;
  teamId?: string;
  role?: string;
};

/** One sampled error tip, for the report's "what actually broke" column. */
export type FrictionErrorSample = { message: string; code?: string; at: number };

/** The friction found in one conversation over the scan window. */
export type ConversationFriction = {
  meta: ConversationMeta;
  errorTips: number;
  errorTipSamples: FrictionErrorSample[];
  toolErrors: number;
  interrupts: number;
  interruptAt: number[];
  userTurns: number;
  rows: number;
};

/** Interrupt rows' tool_call_id prefix and title: the harness notice channel carries MANY notices
 * (task checklists, progress), only this exact title is a user stop — verified against live rows. */
export const INTERRUPT_TOOL_CALL_PREFIX = 'mu:notice:';
export const INTERRUPT_TITLE = 'You stopped this reply.';

/** True when the update is the harness's user-stop notice (not any other notice). */
const isInterruptUpdate = (update: { tool_call_id?: unknown; title?: unknown }): boolean =>
  typeof update.tool_call_id === 'string' &&
  update.tool_call_id.startsWith(INTERRUPT_TOOL_CALL_PREFIX) &&
  update.title === INTERRUPT_TITLE;

/** True when the update is any OTHER harness notice (checklists, progress) — not a real tool call either. */
const isNoticeUpdate = (update: { tool_call_id?: unknown }): boolean =>
  typeof update.tool_call_id === 'string' && update.tool_call_id.startsWith(INTERRUPT_TOOL_CALL_PREFIX);

const isErrorTipRow = (row: InspectionRow): boolean => {
  if (row.type !== 'tips' || typeof row.content !== 'object' || row.content === null) return false;
  return (row.content as { type?: unknown }).type === 'error';
};

const errorTipOf = (row: InspectionRow): FrictionErrorSample => {
  const content = (row.content ?? {}) as { content?: unknown; error?: { code?: unknown } };
  const message = typeof content.content === 'string' ? content.content : '(no message)';
  const code = typeof content.error?.code === 'string' ? content.error.code : undefined;
  return { message: message.slice(0, 160), ...(code ? { code } : {}), at: row.created_at ?? 0 };
};

type ToolCallUpdate = { tool_call_id?: unknown; status?: unknown };

const toolCallUpdateOf = (row: InspectionRow): ToolCallUpdate | undefined => {
  if (row.type !== 'acp_tool_call' || typeof row.content !== 'object' || row.content === null) return undefined;
  const update = (row.content as { update?: unknown }).update;
  if (typeof update !== 'object' || update === null) return undefined;
  return update as ToolCallUpdate;
};

/** Scans one conversation's window rows into friction counts; sampling caps keep reports bounded. */
export function scanConversationFriction(
  meta: ConversationMeta,
  rows: ReadonlyArray<InspectionRow>,
  sampleCap = 5
): ConversationFriction {
  const friction: ConversationFriction = {
    meta,
    errorTips: 0,
    errorTipSamples: [],
    toolErrors: 0,
    interrupts: 0,
    interruptAt: [],
    userTurns: 0,
    rows: rows.length,
  };
  for (const row of rows) {
    if (row.type === 'text' && row.position === 'right') friction.userTurns += 1;
    if (isErrorTipRow(row)) {
      friction.errorTips += 1;
      if (friction.errorTipSamples.length < sampleCap) friction.errorTipSamples.push(errorTipOf(row));
      continue;
    }
    const update = toolCallUpdateOf(row);
    if (!update) continue;
    if (isInterruptUpdate(update)) {
      friction.interrupts += 1;
      friction.interruptAt.push(row.created_at ?? 0);
    } else if (isNoticeUpdate(update)) {
      // Other harness notices (task checklists, progress) are neither interrupts nor work.
      continue;
    } else if (update.status === 'error') {
      friction.toolErrors += 1;
    }
  }
  return friction;
}

/** Orders worst-first for the report: errors outweigh interrupts, then turns. */
export function rankFriction(frictions: ReadonlyArray<ConversationFriction>): ConversationFriction[] {
  const severity = (f: ConversationFriction): number => f.errorTips * 4 + f.toolErrors * 2 + f.interrupts;
  return [...frictions].sort((a, b) => severity(b) - severity(a) || b.userTurns - a.userTurns);
}

/** True when the conversation showed any friction at all (a report row). */
export const hasFriction = (f: ConversationFriction): boolean =>
  f.errorTips > 0 || f.toolErrors > 0 || f.interrupts > 0;

/** Local-time day key `YYYY-MM-DD` — the report file name stem. */
export function localDateKey(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
