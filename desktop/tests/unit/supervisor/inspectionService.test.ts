/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  fetchRowsThrough,
  runInspectionIn,
  startInspectionSchedulerIn,
  type InspectionDeps,
  type MessagePage,
} from '@process/services/team/inspection';
import { parseInspectionNotice } from '@/common/chat/team/inspection/inspectionCore';

const T0 = new Date(2026, 10, 22, 10, 0).getTime(); // a Sunday, for stable date keys

const row = (at: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'text',
  position: 'left',
  status: 'finish',
  created_at: at,
  content: { content: 'x' },
  ...over,
});

/** A deps double: in-memory pages, recorded writes and receipts. */
const makeDeps = (
  options: {
    pages?: Record<string, MessagePage[]>;
    frictionEnabled?: boolean;
    wasteEnabled?: boolean;
    supervisorThrows?: boolean;
    existingReports?: string[];
  } = {}
) => {
  const written: Record<string, string> = {};
  const receipts: string[] = [];
  const logs: string[] = [];
  const deps: InspectionDeps = {
    now: () => T0,
    listConversations: async () => [
      {
        id: 'c-team',
        name: 'CNS复查队（群聊）',
        extra: { position: 'supervisor-adjacent', teamId: 'team-1', role: 'lead' },
      },
      { id: 'c-pos', name: '货代', extra: { position: 'forwarder' } },
      { id: 'c-other', name: '无关会话' }, // no extra: not inspected
      { id: 'c-broken', name: '坏数据', extra: { position: 42 } }, // not a string: not inspected
    ],
    fetchPage: async (conversationId, qs) => {
      const pages = options.pages?.[conversationId];
      void qs;
      if (!pages) return { items: [] };
      // Each call consumes the next page (the pages array is the cursor chain).
      const page = pages.shift() ?? { items: [] };
      return page;
    },
    dataDir: () => 'D:/appdata',
    isFrictionEnabled: async () => options.frictionEnabled !== false,
    isWasteEnabled: async () => options.wasteEnabled !== false,
    sendToSupervisor: async (input) => {
      if (options.supervisorThrows) throw new Error('no supervisor conversation');
      receipts.push(input);
    },
    reportExists: async (path) => (options.existingReports ?? []).includes(path),
    writeReport: async (path, body) => {
      written[path] = body;
    },
    log: (message) => logs.push(message),
  };
  return { deps, written, receipts, logs };
};

describe('fetchRowsThrough', () => {
  it('walks cursor pages backwards until a row predates the window start', async () => {
    const { deps } = makeDeps({
      pages: {
        c1: [
          { items: [row(T0 - 100), row(T0 - 200)], newest_cursor: 'p1', has_more_before: true },
          { items: [row(T0 - 1_000_000)], has_more_before: false },
        ],
      },
    });
    const rows = await fetchRowsThrough(deps, 'c1', T0 - 1000);
    expect(rows.length).toBe(3);
    // Page cap reached stops the walk even with more_before true.
    const many = Array.from({ length: 7 }, (_, i) => ({
      items: [row(T0 - 100 - i)],
      newest_cursor: `p${i}`,
      has_more_before: true,
    }));
    const { deps: capped } = makeDeps({ pages: { c1: many } });
    const rowsCapped = await fetchRowsThrough(capped, 'c1', T0 - 100_000);
    expect(rowsCapped.length).toBe(5);
  });

  it('dedupes rows a cursor overlap re-serves', async () => {
    const { deps } = makeDeps({
      pages: {
        c1: [
          {
            items: [row(T0 - 100, { id: 'a' }), row(T0 - 200, { id: 'b' })],
            newest_cursor: 'p1',
            has_more_before: true,
          },
          // The next page re-serves row b (cursor overlap) plus one older row.
          { items: [row(T0 - 200, { id: 'b' }), row(T0 - 300, { id: 'c' })], has_more_before: false },
        ],
      },
    });
    const rows = await fetchRowsThrough(deps, 'c1', T0 - 1000);
    expect(rows.length).toBe(3);
  });

  it('stops walking when a page fetch fails', async () => {
    const { deps, logs } = makeDeps();
    const failing: InspectionDeps = {
      ...deps,
      fetchPage: async () => {
        throw new Error('boom');
      },
    };
    const rows = await fetchRowsThrough(failing, 'c1', T0 - 1000);
    expect(rows).toEqual([]);
    expect(logs.some((l) => l.includes('rows fetch failed'))).toBe(true);
  });
});

describe('runInspectionIn', () => {
  const errorRow = (at: number) => ({
    type: 'tips',
    position: 'center',
    created_at: at,
    content: { content: 'upstream died', type: 'error', error: { code: 'UNKNOWN_UPSTREAM_ERROR' } },
  });

  it('writes the dated report and delivers a parseable receipt', async () => {
    const { deps, written, receipts } = makeDeps({
      pages: {
        'c-pos': [
          {
            items: [
              row(T0 - 50, { position: 'right', content: { content: 'task' } }),
              errorRow(T0 - 40),
              {
                type: 'acp_tool_call',
                position: 'left',
                created_at: T0 - 30,
                content: {
                  update: { tool_call_id: 'mu:notice:x', status: 'completed', title: 'You stopped this reply.' },
                },
              },
              row(T0 - 20),
            ],
          },
        ],
      },
    });
    const outcome = await runInspectionIn(deps, {
      from: T0 - 3600_000,
      to: T0,
      kinds: ['friction', 'waste'],
      skipWhenReportExists: false,
    });
    expect('skipped' in outcome && outcome.skipped).toBe(false);
    const path = join('D:/appdata', 'positions', '_shared', 'inspections', '2026-11-22.md');
    expect(written[path]).toContain('# 巡检报告 2026-11-22');
    expect(receipts.length).toBe(1);
    const payload = parseInspectionNotice(receipts[0] ?? '');
    expect(payload?.kinds).toEqual(['friction', 'waste']);
    expect(payload?.friction[0]).toEqual({ name: '货代', errors: 1, interrupts: 1 });
    expect(payload?.waste).toBeDefined();
  });

  it('skips when the day report already exists (scheduled dedupe)', async () => {
    const { deps, written, receipts } = makeDeps({
      existingReports: [join('D:/appdata', 'positions', '_shared', 'inspections', '2026-11-22.md')],
    });
    const outcome = await runInspectionIn(deps, {
      from: T0 - 3600_000,
      to: T0,
      kinds: ['friction'],
      skipWhenReportExists: true,
    });
    expect('skipped' in outcome && outcome.skipped).toBe(true);
    expect(Object.keys(written)).toEqual([]);
    expect(receipts).toEqual([]);
  });

  it('a failing receipt never fails the run — the report is already on disk', async () => {
    const { deps, written, logs } = makeDeps({ supervisorThrows: true });
    const outcome = await runInspectionIn(deps, {
      from: T0 - 3600_000,
      to: T0,
      kinds: ['friction'],
      skipWhenReportExists: false,
    });
    expect('skipped' in outcome && outcome.skipped).toBe(false);
    expect(Object.keys(written).length).toBe(1);
    expect(logs.some((l) => l.includes('supervisor receipt failed'))).toBe(true);
  });

  it('filters rows to the window before aggregating', async () => {
    const { deps } = makeDeps({
      pages: { 'c-pos': [{ items: [errorRow(T0 - 10), errorRow(T0 - 900_000_000 /* ancient, outside */)] }] },
    });
    const outcome = await runInspectionIn(deps, {
      from: T0 - 3600_000,
      to: T0,
      kinds: ['friction'],
      skipWhenReportExists: false,
    });
    if ('skipped' in outcome) throw new Error('unexpected skip');
    const inspected = outcome.friction.find((f) => f.meta.name === '货代');
    expect(inspected?.errorTips).toBe(1);
  });
});

describe('startInspectionSchedulerIn', () => {
  it('runs what the wake day owes and re-arms', async () => {
    vi.useFakeTimers();
    try {
      const { deps, written, receipts } = makeDeps();
      const runCalls: string[] = [];
      const recording: InspectionDeps = {
        ...deps,
        writeReport: async (path, body) => {
          runCalls.push(path);
          await deps.writeReport(path, body);
        },
      };
      startInspectionSchedulerIn(recording);
      // T0 is Sunday 10:00 -> next wake Monday 09:00 (audit day).
      const monday = new Date(2026, 10, 23, 9, 0).getTime();
      await vi.advanceTimersByTimeAsync(monday - T0 + 10);
      expect(runCalls.length).toBe(1);
      expect(Object.keys(written).length).toBe(1);
      expect(receipts.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the run when both schedules are disabled', async () => {
    vi.useFakeTimers();
    try {
      const { deps, written } = makeDeps({ frictionEnabled: false, wasteEnabled: false });
      startInspectionSchedulerIn(deps);
      const monday = new Date(2026, 10, 23, 9, 0).getTime();
      await vi.advanceTimersByTimeAsync(monday - T0 + 10);
      expect(Object.keys(written)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
