/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wire format for the resident inspection's receipt into the supervisor's
 * conversation. The desktop main process runs the inspection on a schedule
 * (see `inspectionService`), writes a markdown report under
 * `positions/_shared/inspections/`, and then delivers THIS marker + JSON as a
 * real user message into the supervisor conversation — the same closing-the-
 * loop shape as `[[MU_TEAM_RECEIPT]]`. `MessageText` renders the marker
 * localized, and the supervisor's injected rules tell it to open the report
 * path and answer the user with a one-line digest of the top problems.
 */

/** Machine marker of an inspection receipt; the payload follows as one JSON body. */
export const INSPECTION_MARKER = '[[MU_INSPECTION]]';

/** The two system-owned schedules; a receipt carries whichever ran. */
export type InspectionKind = 'friction' | 'waste';

/** The JSON body that follows the marker in a receipt message. */
export type InspectionNoticePayload = {
  v: 1;
  /** Which schedules produced this receipt; `both` only from a manual run. */
  kinds: InspectionKind[];
  /** The report's local date (`YYYY-MM-DD`) — also its file name stem. */
  date: string;
  /** Absolute path of the markdown report written for this run. */
  path: string;
  /** One-line summary counts per conversation, already ordered worst-first. */
  friction: Array<{ name: string; errors: number; interrupts: number }>;
  /** Waste audit totals; present only when the audit ran. */
  waste?: { idleTurns: number; repeatedFailures: number; lowOutputSessions: number };
  at: number;
};

/** Serializes an inspection receipt into the marker + JSON wire format. */
export function buildInspectionNotice(payload: InspectionNoticePayload): string {
  return `${INSPECTION_MARKER}${JSON.stringify(payload)}`;
}

/** Parses an inspection receipt body back into its payload; null for ordinary text. */
export function parseInspectionNotice(content: string): InspectionNoticePayload | null {
  if (!content.startsWith(INSPECTION_MARKER)) return null;
  try {
    const value = JSON.parse(content.slice(INSPECTION_MARKER.length)) as Record<string, unknown>;
    if (value.v !== 1 || typeof value.date !== 'string' || typeof value.path !== 'string') return null;
    if (!Array.isArray(value.kinds) || !value.kinds.every((k) => k === 'friction' || k === 'waste')) return null;
    if (!Array.isArray(value.friction) || typeof value.at !== 'number') return null;
    for (const row of value.friction) {
      const candidate = row as Record<string, unknown>;
      if (
        typeof candidate.name !== 'string' ||
        typeof candidate.errors !== 'number' ||
        typeof candidate.interrupts !== 'number'
      ) {
        return null;
      }
    }
    const waste = value.waste as Record<string, unknown> | undefined;
    if (
      waste !== undefined &&
      (typeof waste.idleTurns !== 'number' ||
        typeof waste.repeatedFailures !== 'number' ||
        typeof waste.lowOutputSessions !== 'number')
    ) {
      return null;
    }
    return value as unknown as InspectionNoticePayload;
  } catch {
    return null;
  }
}

/** The inspections folder name under the positions shared dir. */
export const INSPECTIONS_FOLDER = 'inspections';
