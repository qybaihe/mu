/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildInspectionNotice,
  INSPECTION_MARKER,
  parseInspectionNotice,
  type InspectionNoticePayload,
} from '@/common/chat/team/inspection/inspectionCore';
import {
  hasFriction,
  localDateKey,
  rankFriction,
  scanConversationFriction,
  type InspectionRow,
} from '@/common/chat/team/inspection/frictionCore';
import { buildInspectionReport } from '@/common/chat/team/inspection/reportCore';
import {
  isAuditWake,
  isWeekday,
  nextWakeAt,
  plusDays,
  previousDayWindow,
  previousWeekWindow,
  rollingDayWindow,
  startOfDay,
} from '@/common/chat/team/inspection/scheduleCore';
import { auditConversationWaste, selectLowOutputSessions, splitTurns } from '@/common/chat/team/inspection/wasteCore';

/** Row fixtures shaped like the live messages API rows (verified against a dev backend). */
const userRow = (at: number, text = 'do it'): InspectionRow => ({
  type: 'text',
  position: 'right',
  status: 'finish',
  created_at: at,
  content: { content: text },
});
const assistantRow = (at: number, text: string): InspectionRow => ({
  type: 'text',
  position: 'left',
  status: 'finish',
  created_at: at,
  content: { content: text },
});
const thinkingRow = (at: number): InspectionRow => ({
  type: 'thinking',
  position: 'left',
  created_at: at,
  content: { content: 'thinking…' },
});
const errorTipRow = (
  at: number,
  message = 'The upstream Agent failed while handling the request',
  code = 'UNKNOWN_UPSTREAM_ERROR'
): InspectionRow => ({
  type: 'tips',
  position: 'center',
  created_at: at,
  content: { content: message, type: 'error', error: { message, code } },
});
const toolRow = (at: number, toolCallId: string, status = 'completed'): InspectionRow => ({
  type: 'acp_tool_call',
  position: 'left',
  status: 'finish',
  created_at: at,
  content: {
    session_id: 's1',
    update: { session_update: 'tool_call', tool_call_id: toolCallId, status, title: 'Read' },
  },
});
const interruptRow = (at: number): InspectionRow => ({
  type: 'acp_tool_call',
  position: 'left',
  status: 'finish',
  created_at: at,
  content: {
    session_id: 's1',
    update: {
      session_update: 'tool_call',
      tool_call_id: 'mu:notice:abc',
      status: 'completed',
      title: 'You stopped this reply.',
    },
  },
});
/** A harness notice that is NOT a user stop (task checklist / progress) — must not count as anything. */
const checklistNoticeRow = (at: number): InspectionRow => ({
  type: 'acp_tool_call',
  position: 'left',
  status: 'finish',
  created_at: at,
  content: {
    session_id: 's1',
    update: {
      session_update: 'tool_call',
      tool_call_id: 'mu:notice:def',
      status: 'completed',
      title: 'mu：这个任务的清单，2 项完成 2 项',
    },
  },
});

const meta = { conversationId: 'c1', name: '货代 2', position: 'forwarder-2' };

describe('inspection wire format', () => {
  const payload: InspectionNoticePayload = {
    v: 1,
    kinds: ['friction', 'waste'],
    date: '2026-11-22',
    path: 'C:/data/positions/_shared/inspections/2026-11-22.md',
    friction: [{ name: '货代 2', errors: 2, interrupts: 1 }],
    waste: { idleTurns: 3, repeatedFailures: 1, lowOutputSessions: 1 },
    at: 1795236072942,
  };

  it('round-trips build and parse', () => {
    const wire = buildInspectionNotice(payload);
    expect(wire.startsWith(INSPECTION_MARKER)).toBe(true);
    expect(parseInspectionNotice(wire)).toEqual(payload);
  });

  it('rejects ordinary text and malformed bodies', () => {
    expect(parseInspectionNotice('ordinary task message')).toBeNull();
    expect(parseInspectionNotice(`${INSPECTION_MARKER}not json`)).toBeNull();
    expect(parseInspectionNotice(`${INSPECTION_MARKER}{"v":2,"date":"x","path":"y"}`)).toBeNull();
    expect(
      parseInspectionNotice(`${INSPECTION_MARKER}{"v":1,"kinds":["other"],"date":"x","path":"y","friction":[],"at":1}`)
    ).toBeNull();
    expect(
      parseInspectionNotice(
        `${INSPECTION_MARKER}{"v":1,"kinds":["friction"],"date":"x","path":"y","friction":[{"name":1}],"at":1}`
      )
    ).toBeNull();
  });
});

describe('friction scan', () => {
  it('counts error tips, tool errors and interrupts from live-shaped rows', () => {
    const rows = [
      userRow(1000),
      errorTipRow(1100),
      toolRow(1200, 'call-1'),
      toolRow(1300, 'call-2', 'error'),
      interruptRow(1400),
      checklistNoticeRow(1500),
      assistantRow(1600, 'done'),
      thinkingRow(1700),
    ];
    const f = scanConversationFriction(meta, rows);
    expect(f.errorTips).toBe(1);
    expect(f.errorTipSamples[0]?.code).toBe('UNKNOWN_UPSTREAM_ERROR');
    expect(f.toolErrors).toBe(1);
    expect(f.interrupts).toBe(1);
    expect(f.userTurns).toBe(1);
    expect(f.rows).toBe(8);
    expect(hasFriction(f)).toBe(true);
  });

  it('a checklist notice is neither an interrupt nor a tool call', () => {
    const rows = [userRow(1000), checklistNoticeRow(1100), assistantRow(1200, 'done')];
    const f = scanConversationFriction(meta, rows);
    expect(f.interrupts).toBe(0);
    expect(hasFriction(f)).toBe(false);
    expect(splitTurns(rows)[0]?.toolCalls).toBe(0);
  });

  it('caps error samples and ranks worst-first', () => {
    const manyErrors = Array.from({ length: 8 }, (_, i) => errorTipRow(1000 + i));
    const quiet = [userRow(1000), assistantRow(1100, 'ok')];
    const a = scanConversationFriction({ ...meta, conversationId: 'a', name: 'A' }, [...manyErrors, ...quiet]);
    const b = scanConversationFriction({ ...meta, conversationId: 'b', name: 'B' }, quiet);
    expect(a.errorTipSamples.length).toBe(5);
    const ranked = rankFriction([b, a]);
    expect(ranked[0]?.meta.name).toBe('A');
    expect(hasFriction(b)).toBe(false);
  });

  it('labels local date keys', () => {
    expect(localDateKey(new Date(2026, 10, 22, 23, 59).getTime())).toBe('2026-11-22');
  });
});

describe('waste audit', () => {
  const base = new Date(2026, 10, 20, 10, 0).getTime();

  it('splits turns at user rows and ignores pre-history rows', () => {
    const rows = [
      assistantRow(base - 5000, 'orphan before first user'),
      userRow(base),
      toolRow(base + 100, 'call-1'),
      assistantRow(base + 200, 'answer text'),
      userRow(base + 1000),
      assistantRow(base + 1100, 'second answer'),
    ];
    const turns = splitTurns(rows);
    expect(turns.length).toBe(2);
    expect(turns[0]?.toolCalls).toBe(1);
    expect(turns[0]?.assistantTextLen).toBe('answer text'.length);
    expect(turns[1]?.startedAt).toBe(base + 1000);
  });

  it('flags tools-no-output, error-no-output and interrupted turns', () => {
    const idleTools = [
      userRow(base),
      toolRow(base + 100, 'call-1'),
      toolRow(base + 200, 'call-2'),
      toolRow(base + 300, 'call-3'),
      assistantRow(base + 400, 'x'.repeat(100)),
    ];
    const idleError = [userRow(base), errorTipRow(base + 100), assistantRow(base + 200, 'x'.repeat(10))];
    const interrupted = [userRow(base), toolRow(base + 100, 'call-1'), interruptRow(base + 200)];
    const healthy = [
      userRow(base),
      toolRow(base + 100, 'call-1'),
      assistantRow(base + 200, 'a substantial answer worth reading'),
    ];
    const audit = (rows: InspectionRow[]) => auditConversationWaste(meta, rows);
    expect(audit(idleTools).idleTurns[0]?.reason).toBe('tools-no-output');
    expect(audit(idleError).idleTurns[0]?.reason).toBe('error-no-output');
    expect(audit(interrupted).idleTurns[0]?.reason).toBe('interrupted');
    expect(audit(healthy).idleTurns.length).toBe(0);
  });

  it('clusters repeated failures and picks low-output sessions', () => {
    const rows = [
      userRow(base),
      errorTipRow(base + 100, 'same failure'),
      assistantRow(base + 200, 'x'),
      userRow(base + 1000),
      errorTipRow(base + 1100, 'same failure'),
      assistantRow(base + 1200, 'y'),
    ];
    const audit = auditConversationWaste(meta, rows);
    expect(audit.repeatedFailures).toEqual([{ message: 'same failure', count: 2 }]);
    const picked = selectLowOutputSessions([audit]);
    expect(picked.length).toBe(1);
    expect(picked[0]?.badTurns).toBe(2);
    const healthy = auditConversationWaste(meta, [userRow(base), assistantRow(base + 100, 'x'.repeat(400))]);
    expect(selectLowOutputSessions([healthy]).length).toBe(0);
  });
});

describe('schedule math', () => {
  // 2026-11-18 is a Wednesday; 2026-11-21 Saturday; 2026-11-22 Sunday; 2026-11-23 Monday.
  const at = (y: number, m: number, d: number, h: number, min = 0): number => new Date(y, m, d, h, min).getTime();

  it('jumps weekends to Monday 09:00 and weekdays to the next 09:00', () => {
    expect(nextWakeAt(at(2026, 10, 18, 10, 0))).toBe(at(2026, 10, 19, 9, 0));
    expect(nextWakeAt(at(2026, 10, 18, 8, 0))).toBe(at(2026, 10, 18, 9, 0));
    expect(nextWakeAt(at(2026, 10, 20, 10, 0))).toBe(at(2026, 10, 23, 9, 0)); // Friday -> Monday
    expect(nextWakeAt(at(2026, 10, 21, 12, 0))).toBe(at(2026, 10, 23, 9, 0)); // Saturday -> Monday
    expect(nextWakeAt(at(2026, 10, 22, 12, 0))).toBe(at(2026, 10, 23, 9, 0)); // Sunday -> Monday
    expect(isWeekday(at(2026, 10, 18, 12, 0))).toBe(true);
    expect(isWeekday(at(2026, 10, 21, 12, 0))).toBe(false);
  });

  it('marks Monday wakes as audit wakes', () => {
    expect(isAuditWake(at(2026, 10, 23, 9, 0))).toBe(true);
    expect(isAuditWake(at(2026, 10, 19, 9, 0))).toBe(false);
  });

  it('windows are local-day based', () => {
    expect(previousDayWindow(at(2026, 10, 19, 9, 0))).toEqual({
      from: at(2026, 10, 18, 0, 0),
      to: at(2026, 10, 19, 0, 0),
    });
    expect(previousWeekWindow(at(2026, 10, 23, 9, 0))).toEqual({
      from: at(2026, 10, 16, 0, 0),
      to: at(2026, 10, 23, 0, 0),
    });
    const now = at(2026, 10, 19, 15, 0);
    expect(rollingDayWindow(now)).toEqual({ from: now - 24 * 3600 * 1000, to: now });
    expect(startOfDay(plusDays(at(2026, 10, 19, 23, 30), 1))).toBe(at(2026, 10, 20, 0, 0));
  });
});

describe('report rendering', () => {
  it('renders both sections with honest empty states', () => {
    const quiet = scanConversationFriction(meta, [userRow(1000), assistantRow(1100, 'ok')]);
    const withFriction = scanConversationFriction({ ...meta, conversationId: 'c2', name: '货代 2' }, [
      userRow(1000),
      errorTipRow(1100),
      interruptRow(1200),
    ]);
    const report = buildInspectionReport({
      dateKey: '2026-11-22',
      window: { from: 0, to: 86_400_000 },
      ranAt: 1000,
      friction: [withFriction, quiet],
    });
    expect(report).toContain('# 巡检报告 2026-11-22');
    expect(report).toContain('货代 2（岗位 forwarder-2）');
    expect(report).toContain('UNKNOWN_UPSTREAM_ERROR');
    const empty = buildInspectionReport({
      dateKey: '2026-11-22',
      window: { from: 0, to: 86_400_000 },
      ranAt: 1000,
      friction: [quiet],
    });
    expect(empty).toContain('无报错');
    const audited = buildInspectionReport({
      dateKey: '2026-11-22',
      window: { from: 0, to: 86_400_000 },
      ranAt: 1000,
      friction: [],
      waste: {
        conversations: [
          auditConversationWaste(meta, [
            userRow(1000),
            toolRow(1100, 'c1'),
            toolRow(1200, 'c2'),
            toolRow(1300, 'c3'),
            assistantRow(1400, 'x'),
          ]),
        ],
        lowOutput: [],
      },
    });
    expect(audited).toContain('浪费审计');
    expect(audited).toContain('工具烧了无产出');
  });
});
