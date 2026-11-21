/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The resident inspection service: two system-owned schedules that run in the
 * MAIN process — the friction scan every weekday 09:00 (previous local day),
 * the waste audit every Monday 09:00 (previous 7 local days). A run reads the
 * messages API for every position/team conversation, aggregates via the
 * framework-free cores, writes one markdown report under
 * `positions/_shared/inspections/YYYY-MM-DD.md`, and delivers a
 * `[[MU_INSPECTION]]` receipt into the supervisor conversation (best-effort:
 * no supervisor conversation means the report still lands, nobody to tell).
 *
 * Why not the backend's aionui_cron: its job payload can only send a MESSAGE
 * into a conversation (an agent turn — burning tokens to run TS aggregation
 * logic unreliably), and its jobs are user-facing rows in the cron page; the
 * scheduler here is invisible plumbing, in the main process where timers do
 * not get throttled like a backgrounded renderer window's.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getPlatformServices } from '@/common/platform';
import { httpRequest } from '@/common/adapter/httpBridge';
import {
  buildInspectionNotice,
  INSPECTIONS_FOLDER,
  type InspectionKind,
} from '@/common/chat/team/inspection/inspectionCore';
import {
  hasFriction,
  localDateKey,
  rankFriction,
  scanConversationFriction,
  type ConversationFriction,
  type ConversationMeta,
  type InspectionRow,
} from '@/common/chat/team/inspection/frictionCore';
import { buildInspectionReport } from '@/common/chat/team/inspection/reportCore';
import {
  isAuditWake,
  nextWakeAt,
  previousDayWindow,
  previousWeekWindow,
  rollingDayWindow,
} from '@/common/chat/team/inspection/scheduleCore';
import {
  auditConversationWaste,
  selectLowOutputSessions,
  type ConversationWaste,
  type LowOutputSession,
} from '@/common/chat/team/inspection/wasteCore';
import { SHARED_TEAMS_FOLDER, SUPERVISOR_POSITION_NAME } from '@/common/chat/team/supervisor/supervisorCore';
import { findPositionConversationId } from '@/common/chat/team/positions/positionLibraryCore';

/** The conversations list's row, sliced to the fields the inspection reads. */
type ConversationListRow = { id: string; name: string; modified_at?: number; extra?: Record<string, unknown> };

/** Cursor page from the messages API. */
export type MessagePage = { items?: InspectionRow[]; newest_cursor?: string | null; has_more_before?: boolean };

/** Everything the service needs from the outside; the seams its tests fake. */
export type InspectionDeps = {
  now: () => number;
  listConversations: () => Promise<ConversationListRow[]>;
  /** One cursor page of a conversation's rows, newest-first. */
  fetchPage: (conversationId: string, qs: string) => Promise<MessagePage>;
  dataDir: () => string;
  isFrictionEnabled: () => Promise<boolean>;
  isWasteEnabled: () => Promise<boolean>;
  sendToSupervisor: (input: string) => Promise<void>;
  reportExists: (path: string) => Promise<boolean>;
  writeReport: (path: string, body: string) => Promise<void>;
  log: (message: string) => void;
};

/** How many cursor pages (200 rows each) one conversation may cost a run. */
export const FETCH_PAGE_CAP = 5;
export const MESSAGES_PAGE_LIMIT = 200;

/** True when the conversation belongs to the inspected world: a position session (extra.position) or a team thread (extra.teamId). */
const isInspectedConversation = (row: ConversationListRow): boolean => {
  const extra = row.extra ?? {};
  const has = (value: unknown): boolean => typeof value === 'string' && value !== '';
  return has(extra.position) || has(extra.teamId);
};

const metaOf = (row: ConversationListRow): ConversationMeta => {
  const extra = row.extra ?? {};
  const teamId = typeof extra.teamId === 'string' ? extra.teamId : undefined;
  const role = typeof extra.role === 'string' ? extra.role : undefined;
  const position = typeof extra.position === 'string' ? extra.position : undefined;
  return {
    conversationId: row.id,
    name: row.name,
    ...(teamId ? { teamId, role } : { position }),
  };
};

/** Pulls one conversation's rows newest-first backwards until before `from` or the page cap. */
export async function fetchRowsThrough(
  deps: Pick<InspectionDeps, 'fetchPage' | 'log'>,
  conversationId: string,
  from: number
): Promise<InspectionRow[]> {
  const collected: InspectionRow[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < FETCH_PAGE_CAP; page += 1) {
    const query = new URLSearchParams({ limit: String(MESSAGES_PAGE_LIMIT), content_mode: 'compact' });
    if (cursor) query.set('before', cursor);
    let data: MessagePage;
    try {
      data = await deps.fetchPage(conversationId, query.toString());
    } catch (error) {
      deps.log(`inspection: rows fetch failed for ${conversationId} page ${page}: ${String(error)}`);
      break;
    }
    const items = data.items ?? [];
    // Cursor pages may overlap (a `before` cursor can re-serve its anchor row);
    // row ids dedupe that so no turn is counted twice.
    for (const row of items) {
      const id = (row as { id?: unknown }).id;
      if (typeof id !== 'string' || !seen.has(id)) {
        if (typeof id === 'string') seen.add(id);
        collected.push(row);
      }
    }
    const oldest = items.length === 0 ? Infinity : Math.min(...items.map((r) => r.created_at ?? 0));
    if (oldest <= from) break;
    if (!data.has_more_before || !data.newest_cursor) break;
    cursor = data.newest_cursor;
  }
  return collected;
}

export type InspectionRunOutcome = {
  reportPath: string;
  dateKey: string;
  kinds: InspectionKind[];
  friction: ConversationFriction[];
  waste?: { conversations: ConversationWaste[]; lowOutput: LowOutputSession[] };
};

/** Runs the inspection over an explicit window and reports what happened. */
export async function runInspectionIn(
  deps: InspectionDeps,
  options: { from: number; to: number; kinds: InspectionKind[]; skipWhenReportExists: boolean }
): Promise<InspectionRunOutcome | { skipped: true; reportPath: string }> {
  const at = deps.now();
  const dateKey = localDateKey(at);
  const reportPath = join(deps.dataDir(), 'positions', SHARED_TEAMS_FOLDER, INSPECTIONS_FOLDER, `${dateKey}.md`);
  if (options.skipWhenReportExists && (await deps.reportExists(reportPath))) {
    return { skipped: true, reportPath };
  }

  const conversations = (await deps.listConversations()).filter(isInspectedConversation);
  const perConversation: Array<{ meta: ConversationMeta; rows: InspectionRow[] }> = [];
  for (const conversation of conversations) {
    const rows = await fetchRowsThrough(deps, conversation.id, options.from);
    const inWindow = rows.filter((r) => {
      const ts = r.created_at ?? 0;
      return ts >= options.from && ts < options.to;
    });
    perConversation.push({ meta: metaOf(conversation), rows: inWindow });
  }

  const friction = rankFriction(perConversation.map(({ meta, rows }) => scanConversationFriction(meta, rows)));
  let waste: InspectionRunOutcome['waste'];
  if (options.kinds.includes('waste')) {
    const audits = perConversation.map(({ meta, rows }) => auditConversationWaste(meta, rows));
    waste = { conversations: audits, lowOutput: selectLowOutputSessions(audits) };
  }

  const report = buildInspectionReport({
    dateKey,
    window: { from: options.from, to: options.to },
    ranAt: at,
    friction,
    ...(waste ? { waste } : {}),
  });
  await deps.writeReport(reportPath, report);

  const kinds = [...options.kinds].sort() as InspectionKind[];
  const notice = buildInspectionNotice({
    v: 1,
    kinds,
    date: dateKey,
    path: reportPath,
    friction: friction
      .filter(hasFriction)
      .slice(0, 5)
      .map((f) => ({ name: f.meta.name, errors: f.errorTips + f.toolErrors, interrupts: f.interrupts })),
    ...(waste
      ? {
          waste: {
            idleTurns: waste.conversations.reduce((n, c) => n + c.idleTurns.length, 0),
            repeatedFailures: waste.conversations.reduce((n, c) => n + c.repeatedFailures.length, 0),
            lowOutputSessions: waste.lowOutput.length,
          },
        }
      : {}),
    at,
  });
  try {
    await deps.sendToSupervisor(notice);
  } catch (error) {
    deps.log(`inspection: supervisor receipt failed (report still written): ${String(error)}`);
  }
  return { reportPath, dateKey, kinds, friction, ...(waste ? { waste } : {}) };
}

export type InspectionScheduler = { stop: () => void };

/** Arms the schedule chain: wake at every weekday 09:00 local, run what the day owes, re-arm. */
export function startInspectionSchedulerIn(deps: InspectionDeps): InspectionScheduler {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (stopped) return;
    const wakeAt = nextWakeAt(deps.now());
    timer = setTimeout(
      () => {
        timer = undefined;
        void (async () => {
          try {
            const kinds: InspectionKind[] = [];
            if (await deps.isFrictionEnabled()) kinds.push('friction');
            if (isAuditWake(wakeAt) && (await deps.isWasteEnabled())) kinds.push('waste');
            if (kinds.length > 0) {
              const now = deps.now();
              const window = kinds.includes('waste') ? previousWeekWindow(now) : previousDayWindow(now);
              await runInspectionIn(deps, { from: window.from, to: window.to, kinds, skipWhenReportExists: true });
              deps.log(`inspection: scheduled run done kinds=${kinds.join(',')}`);
            }
          } catch (error) {
            deps.log(`inspection: scheduled run failed: ${String(error)}`);
          } finally {
            arm();
          }
        })();
      },
      Math.max(0, wakeAt - deps.now())
    );
    timer.unref?.();
  };
  arm();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** The production wiring: backend HTTP for conversations/settings/receipt, the platform data dir for the report. */
const prodDeps = (): InspectionDeps => ({
  now: Date.now,
  listConversations: async () => {
    const data = await httpRequest<{ items?: ConversationListRow[] }>('GET', '/api/conversations?limit=200');
    return data.items ?? [];
  },
  fetchPage: async (conversationId, qs) => {
    const data = await httpRequest<unknown>('GET', `/api/conversations/${conversationId}/messages?${qs}`);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
    return data as MessagePage;
  },
  dataDir: () => getPlatformServices().paths.getDataDir(),
  isFrictionEnabled: async () => {
    const data = await httpRequest<Record<string, unknown | undefined>>(
      'GET',
      `/api/settings/client?keys=${encodeURIComponent('tools.inspectionFrictionEnabled')}`
    );
    return data?.['tools.inspectionFrictionEnabled'] !== false;
  },
  isWasteEnabled: async () => {
    const data = await httpRequest<Record<string, unknown | undefined>>(
      'GET',
      `/api/settings/client?keys=${encodeURIComponent('tools.inspectionWasteEnabled')}`
    );
    return data?.['tools.inspectionWasteEnabled'] !== false;
  },
  sendToSupervisor: async (input) => {
    const list = await httpRequest<{ items?: ConversationListRow[] }>('GET', '/api/conversations?limit=200');
    const conversationId = findPositionConversationId(list.items ?? [], SUPERVISOR_POSITION_NAME);
    if (!conversationId) return;
    await httpRequest('POST', `/api/conversations/${conversationId}/messages`, { content: input, files: [] });
  },
  reportExists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  writeReport: async (path, body) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, 'utf8');
  },
  log: (message) => console.log(`[mu:inspection] ${message}`),
});

let scheduler: InspectionScheduler | undefined;

/** Starts the resident schedules once (idempotent) — the app's single wiring point. */
export function startInspectionScheduler(): InspectionScheduler {
  if (scheduler) return scheduler;
  scheduler = startInspectionSchedulerIn(prodDeps());
  return scheduler;
}

/** One manual run over a rolling 24h window: both schedules, report overwritten. */
export async function runInspectionNow(): Promise<{
  ok: boolean;
  reportPath?: string;
  dateKey: string;
  error?: string;
}> {
  const deps = prodDeps();
  const now = deps.now();
  const window = rollingDayWindow(now);
  try {
    const outcome = await runInspectionIn(deps, {
      from: window.from,
      to: window.to,
      kinds: ['friction', 'waste'],
      skipWhenReportExists: false,
    });
    if ('skipped' in outcome) return { ok: true, reportPath: outcome.reportPath, dateKey: localDateKey(now) };
    return { ok: true, reportPath: outcome.reportPath, dateKey: outcome.dateKey };
  } catch (error) {
    deps.log(`inspection: manual run failed: ${String(error)}`);
    return { ok: false, dateKey: localDateKey(now), error: String(error) };
  }
}
