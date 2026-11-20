/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Framework-free core for the supervisor receipt: turns the same
 * `team.runCompleted` / `team.runFailed` wire events the notification chain
 * reads into one merged receipt message delivered into the supervisor's
 * conversation. The receipt is a real user message (it triggers one
 * supervisor turn — that is the loop closing: the supervisor learns its team
 * finished), so the core also owns the wire format the message carries:
 * a `[[MU_TEAM_RECEIPT]]` marker plus JSON, rendered localized by
 * `MessageText` instead of stored text. Kept free of React / DOM globals so
 * it is unit-testable in the node project, like `teamRunNotificationCore`.
 */

import type { ITeamRunEvent } from '@/common/types/team/teamTypes';

/** Machine marker of a receipt message; the payload follows as one JSON body. */
export const TEAM_RECEIPT_MARKER = '[[MU_TEAM_RECEIPT]]';

/** Receipts of one team merge while this window is open (anti-spam). */
export const RECEIPT_MERGE_WINDOW_MS = 60_000;

export type TeamReceiptChannel = 'completed' | 'failed';

/** One normalized terminal run event, after the verdict filter. */
export type TeamReceiptEvent = {
  kind: TeamReceiptChannel;
  teamId: string;
  runId: string;
};

/** The JSON body that follows the marker in a receipt message. */
export type TeamReceiptPayload = {
  v: 1;
  teams: Array<{ teamId: string; name: string; completed: number; failed: number }>;
  at: number;
};

/** What the hook sends after a merge window closes; names resolve at send. */
export type TeamReceiptFlush = {
  teams: Array<{ teamId: string; completed: number; failed: number }>;
  at: number;
};

/**
 * The same verdict the notification chain applies: only the lead's run
 * completing means "the team answered you" (a teammate target is an
 * intermediate step), while any failure is worth a receipt. Returns null for
 * events that must not produce a receipt.
 */
export function receiptEventFromRunEvent(event: ITeamRunEvent, channel: TeamReceiptChannel): TeamReceiptEvent | null {
  if (!event?.team_id || !event.team_run_id) return null;
  if (channel === 'completed' && event.target_role !== 'lead') return null;
  return { kind: channel, teamId: event.team_id, runId: event.team_run_id };
}

/** Serializes a receipt into the marker + JSON wire format the message carries. */
export function buildReceiptContent(payload: TeamReceiptPayload): string {
  return `${TEAM_RECEIPT_MARKER}${JSON.stringify(payload)}`;
}

/** Parses a receipt message body back into its payload; null for ordinary text. */
export function parseTeamReceiptNotice(content: string): TeamReceiptPayload | null {
  if (!content.startsWith(TEAM_RECEIPT_MARKER)) return null;
  try {
    const value = JSON.parse(content.slice(TEAM_RECEIPT_MARKER.length)) as Record<string, unknown>;
    if (value.v !== 1 || !Array.isArray(value.teams) || typeof value.at !== 'number') return null;
    for (const team of value.teams) {
      const candidate = team as Record<string, unknown>;
      if (
        typeof candidate.teamId !== 'string' ||
        typeof candidate.name !== 'string' ||
        typeof candidate.completed !== 'number' ||
        typeof candidate.failed !== 'number'
      ) {
        return null;
      }
    }
    return value as unknown as TeamReceiptPayload;
  } catch {
    return null;
  }
}

export type SupervisorReceiptBuffer = {
  /** The window the hook arms its timer with; the buffer itself is timeless. */
  windowMs: number;
  /** Records one event; true when this event opened a merge window (arm the timer). */
  push: (event: TeamReceiptEvent, now: number) => boolean;
  /** Emits and clears everything buffered; null when nothing is pending. */
  flush: (now: number) => TeamReceiptFlush | null;
};

/**
 * Merges terminal run events into one receipt per merge window. The window
 * anchors at the first event: everything landing inside it (same team or not)
 * folds into one flush, so a burst of completions costs the supervisor a
 * single turn. Run ids are deduped per kind — a reconnect replay of the same
 * terminal event must not double-count (the notification controller's rule).
 */
export function createSupervisorReceiptBuffer(options?: { windowMs?: number }): SupervisorReceiptBuffer {
  const windowMs = options?.windowMs ?? RECEIPT_MERGE_WINDOW_MS;
  const seenRunKeys = new Set<string>();
  let counts = new Map<string, { completed: number; failed: number }>();
  let windowStart: number | undefined;

  return {
    windowMs,
    push: (event, now) => {
      const key = `${event.kind}:${event.runId}`;
      if (seenRunKeys.has(key)) return false;
      seenRunKeys.add(key);
      const team = counts.get(event.teamId) ?? { completed: 0, failed: 0 };
      team[event.kind] += 1;
      counts.set(event.teamId, team);
      if (windowStart === undefined) {
        windowStart = now;
        return true;
      }
      return false;
    },
    flush: (now) => {
      if (windowStart === undefined || counts.size === 0) return null;
      const receipt: TeamReceiptFlush = {
        teams: [...counts.entries()].map(([teamId, { completed, failed }]) => ({ teamId, completed, failed })),
        at: now,
      };
      counts = new Map();
      windowStart = undefined;
      return receipt;
    },
  };
}
