import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activityPage,
  modelLevels,
  readPage,
  Telemetry,
} from '../../../packages/desktop/src/process/agent/kyrn/telemetry';
import { mergeActivity } from '../../../packages/desktop/src/renderer/pages/conversation/KyrnPanel/activity';
import { sessionBinding } from '../../../packages/desktop/src/process/agent/kyrn/sessionBinding';
import { BACKEND_DATABASE_FILE } from '@/common/platform/backendNames';

/** A KYRN presentation frame as pi's RPC status channel carries it. */
const presentation = (frame: Record<string, unknown>) => ({
  type: 'extension_ui_request',
  method: 'setStatus',
  statusKey: 'kyrn.presentation.v1',
  statusText: JSON.stringify({
    version: 1,
    at: 1,
    kind: 'preflight.verdict',
    payload: { state: 'applied' },
    ...frame,
  }),
});

/** A reply of the model as pi's RPC ends it: its words, and what it read and wrote. */
const modelReply = (usage: unknown) => ({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'private answer' }], usage },
});

/** The usage of one reply, as the activity keeps it. */
const turnUsage = (id: string, cacheRead: number) => ({
  id,
  at: 1,
  kind: 'turn.usage',
  payload: { input: 100, output: 10, cacheRead, cacheWrite: 0 },
});

describe('KYRN durable activity', () => {
  it('resolves the backend resume anchor without mixing conversations or agents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-session-binding-'));
    try {
      const db = new DatabaseSync(join(dir, BACKEND_DATABASE_FILE));
      db.exec('CREATE TABLE acp_session(conversation_id TEXT, agent_id TEXT, session_id TEXT)');
      db.prepare('INSERT INTO acp_session VALUES (?, ?, ?)').run('a', 'kyrn', 'session-a');
      db.prepare('INSERT INTO acp_session VALUES (?, ?, ?)').run('b', 'kyrn', 'session-b');
      db.close();
      expect(sessionBinding(dir, 'a', 'kyrn')).toBe('session-a');
      expect(sessionBinding(dir, 'a', 'other')).toBe('');
      expect(sessionBinding(dir, "a' OR 1=1 --", 'kyrn')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('does not follow a board symlink outside the run directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-hive-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'kyrn-outside-'));
    const session = randomUUID();
    try {
      writeFileSync(join(outside, 'private.jsonl'), '{"private":true}\n');
      symlinkSync(join(outside, 'private.jsonl'), join(dir, 'board.jsonl'));
      new Telemetry(dir, session).capture({
        type: 'tool_execution_end',
        result: { details: { snapshot: { kind: 'hive', dir } } },
      });
      const page = activityPage(dir, session, 0);
      expect(page.events.map((e) => e.kind)).toEqual(['swarm.snapshot']);
      expect(page).not.toHaveProperty('rows');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it('preserves incomplete UTF-8 lines for the next poll', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    try {
      const path = join(dir, 'events');
      writeFileSync(path, '{"text":"经验"}\n{"text":');
      const first = readPage(path, 0);
      appendFileSync(path, '"后续"}\n');
      expect(first.rows).toEqual([{ text: '经验' }]);
      expect(readPage(path, first.cursor).rows).toEqual([{ text: '后续' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('captures a hive manifest with whitelisted presentation fields under its tool run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    const session = randomUUID();
    try {
      new Telemetry(dir, session).capture({
        type: 'tool_execution_start',
        toolName: 'hive',
        toolCallId: 'hive-call',
        args: {
          goal: 'Investigate the regression',
          bees: [{ name: 'researcher', focus: 'Find the cause', ignored: 'do not persist' }],
          ignored: 'do not persist',
        },
      });
      const [manifest] = activityPage(dir, session, 0).events;
      expect(manifest?.kind).toBe('hive.manifest');
      expect(manifest?.run).toBe('hive-call');
      expect(manifest?.payload).toEqual({
        goal: 'Investigate the regression',
        bees: [{ name: 'researcher', focus: 'Find the cause' }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('excludes unrelated tools and malformed hive manifests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    const session = randomUUID();
    try {
      const telemetry = new Telemetry(dir, session);
      telemetry.capture({
        type: 'tool_execution_start',
        toolName: 'delegate',
        toolCallId: 'delegate-call',
        args: { goal: 'Ignore this', bees: [] },
      });
      telemetry.capture({
        type: 'tool_execution_start',
        toolName: 'hive',
        toolCallId: '',
        args: { goal: 'Missing id', bees: [] },
      });
      telemetry.capture({ type: 'tool_execution_start', toolName: 'hive', toolCallId: 'hive-1', args: { bees: [] } });
      telemetry.capture({
        type: 'tool_execution_start',
        toolName: 'hive',
        toolCallId: 'hive-2',
        args: { goal: 'Malformed bees', bees: {} },
      });
      expect(activityPage(dir, session, 0).events).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('bounds manifest fields while preserving malformed bee indices', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    const session = randomUUID();
    const goal = 'g'.repeat(16001);
    const name = 'n'.repeat(161);
    const focus = 'f'.repeat(16001);
    const bees = Array.from({ length: 17 }, (_, index) =>
      index === 1 ? 'malformed' : { name, focus, ignored: `secret-${index}` }
    );
    try {
      new Telemetry(dir, session).capture({
        type: 'tool_execution_start',
        toolName: 'hive',
        toolCallId: 'hive-call',
        args: { goal, bees, ignored: 'do not persist' },
      });
      expect(activityPage(dir, session, 0).events[0]?.payload).toEqual({
        goal: goal.slice(0, 16000),
        bees: Array.from({ length: 16 }, (_, index) =>
          index === 1 ? { name: '', focus: '' } : { name: name.slice(0, 160), focus: focus.slice(0, 16000) }
        ),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('streams both accepted and rejected gates, confirmed deliveries and per-bee logs once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-hive-fixture-'));
    const session = randomUUID();
    const telemetry = new Telemetry(dir, session);
    try {
      mkdirSync(join(dir, 'transcripts'));
      writeFileSync(join(dir, 'gate.jsonl'), '{"gate":"publish","publish":false}\n');
      writeFileSync(join(dir, 'board.jsonl'), '{"id":"n","bee":"a","text":"Finding"}\n');
      writeFileSync(join(dir, 'deliveries.jsonl'), '{"note":"n","to":"b"}\n');
      writeFileSync(join(dir, 'relations.jsonl'), '{"later":"m","earlier":"n","relation":"supersedes","by":"b"}\n');
      const transcript = join(dir, 'transcripts/a.jsonl');
      writeFileSync(transcript, '{"type":"turn_end"}\n');
      const event = {
        type: 'tool_execution_update',
        toolCallId: 'h',
        partialResult: {
          details: {
            snapshot: {
              kind: 'hive',
              dir,
              bees: [
                { name: 'queued', transcript: join(dir, 'transcripts/not-yet.jsonl') },
                { name: 'a', transcript },
              ],
            },
          },
        },
      };
      telemetry.capture(event);
      telemetry.capture(event);
      const events = activityPage(dir, session, 0).events;
      expect(events.filter((e) => e.kind === 'hive.delivery')).toHaveLength(1);
      expect(events.filter((e) => e.kind === 'hive.relation').map((e) => e.payload)).toEqual([
        { later: 'm', earlier: 'n', relation: 'supersedes', by: 'b' },
      ]);
      expect(events.filter((e) => e.kind === 'bee.event')).toHaveLength(1);
      expect(events.find((e) => e.kind === 'hive.gate')?.payload.publish).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('does not read arbitrary run directories and rejects path traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-a-run-'));
    const session = randomUUID();
    try {
      writeFileSync(join(dir, 'gate.jsonl'), '{"private":true}\n');
      new Telemetry(dir, session).capture({
        type: 'tool_execution_end',
        result: { details: { snapshot: { kind: 'hive', dir } } },
      });
      expect(activityPage(dir, session, 0).events.map((e) => e.kind)).toEqual(['swarm.snapshot']);
      expect(() => activityPage(dir, '../../outside', 0)).toThrow('Invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('keeps the runtime, turn and sequence of a presentation frame so its phases can be joined exactly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    const session = randomUUID();
    try {
      const telemetry = new Telemetry(dir, session);
      telemetry.capture(presentation({ runtimeId: 'runtime-a', turnId: 1, sequence: 4 }));
      // A reconnect starts a new runtime whose turns count from 1 again: only the pair tells them apart.
      telemetry.capture(presentation({ runtimeId: 'runtime-b', turnId: 1, sequence: 2 }));
      const events = activityPage(dir, session, 0).events;
      expect(events.map(({ runtimeId, turnId, sequence }) => ({ runtimeId, turnId, sequence }))).toEqual([
        { runtimeId: 'runtime-a', turnId: 1, sequence: 4 },
        { runtimeId: 'runtime-b', turnId: 1, sequence: 2 },
      ]);
      expect(events.every((event) => event.kind === 'preflight.verdict' && event.payload.state === 'applied')).toBe(
        true
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('stores a frame with incomplete correlation as uncorrelated instead of guessing the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    const session = randomUUID();
    try {
      const telemetry = new Telemetry(dir, session);
      for (const frame of [
        {},
        { runtimeId: 'runtime-a' },
        { turnId: 1, sequence: 4 },
        { runtimeId: '', turnId: 1, sequence: 4 },
        { runtimeId: 'runtime-a', turnId: 1.5, sequence: 4 },
        { runtimeId: 'runtime-a', turnId: -1, sequence: 4 },
        { runtimeId: 'runtime-a', turnId: 1, sequence: 0 },
        { runtimeId: 'runtime-a', turnId: '1', sequence: 4 },
      ])
        telemetry.capture(presentation(frame));
      telemetry.capture({ type: 'agent_settled' });
      const events = activityPage(dir, session, 0).events;
      // All or nothing: a partial id would let an old record be attached to the wrong judgment.
      expect(events).toHaveLength(9);
      for (const event of events) {
        expect(event).not.toHaveProperty('runtimeId');
        expect(event).not.toHaveProperty('turnId');
        expect(event).not.toHaveProperty('sequence');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('records the lessons brought into a turn once: from the harness’s own frame, else from the message carrying them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    const older = randomUUID();
    const newer = randomUUID();
    const lessons = {
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'kyrn.lessons',
        content: 'Lessons from earlier sessions:\n- Use ./test.sh.',
      },
    };
    try {
      // A harness that does not present its recalls: the message is the only record of them.
      new Telemetry(dir, older).capture(lessons);
      expect(activityPage(dir, older, 0).events.map((event) => event.payload)).toEqual([
        { content: 'Lessons from earlier sessions:\n- Use ./test.sh.' },
      ]);
      // One that does sends its frame before the message, which then adds nothing, this turn and the next.
      const telemetry = new Telemetry(dir, newer);
      for (const turn of [1, 2]) {
        telemetry.capture(
          presentation({
            kind: 'memory.recalled',
            payload: { ids: ['a'], turn },
            runtimeId: 'r',
            turnId: turn,
            sequence: turn,
          })
        );
        telemetry.capture(lessons);
      }
      expect(activityPage(dir, newer, 0).events.map((event) => [event.kind, event.payload])).toEqual([
        ['memory.recalled', { ids: ['a'], turn: 1 }],
        ['memory.recalled', { ids: ['a'], turn: 2 }],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('records what each reply of the model read and wrote, counts only, for the board’s cache ring', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    const session = randomUUID();
    try {
      const telemetry = new Telemetry(dir, session);
      telemetry.capture(
        modelReply({ input: 200, output: 50, cacheRead: 7800, cacheWrite: 0, totalTokens: 8050, cost: { total: 0.01 } })
      );
      // Not replies of the model: the person's message and a tool's result.
      telemetry.capture({ type: 'message_end', message: { role: 'user', content: 'hi', usage: { input: 5 } } });
      telemetry.capture({ type: 'message_end', message: { role: 'toolResult', content: [] } });
      const page = activityPage(dir, session, 0);
      expect(page.events.map((event) => [event.kind, event.payload])).toEqual([
        ['turn.usage', { input: 200, output: 50, cacheRead: 7800, cacheWrite: 0 }],
      ]);
      expect(JSON.stringify(page)).not.toMatch(/private answer|cost/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('records nothing for a reply that failed before the model read anything, or whose counts are not numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    const session = randomUUID();
    try {
      const telemetry = new Telemetry(dir, session);
      telemetry.capture({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      });
      telemetry.capture({
        type: 'message_end',
        message: { role: 'assistant', usage: { input: '200', output: 1, cacheRead: 0, cacheWrite: 0 } },
      });
      telemetry.capture({ type: 'message_end', message: { role: 'assistant' } });
      expect(activityPage(dir, session, 0).events).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('pages only the kinds a reader asks for, while the cursor still moves past every row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    const session = randomUUID();
    try {
      const telemetry = new Telemetry(dir, session);
      telemetry.capture(presentation({}));
      telemetry.capture(presentation({ kind: 'goal.state', payload: { status: 'active', text: 'tests pass' } }));
      telemetry.capture(presentation({}));
      const all = activityPage(dir, session, 0);
      const goals = activityPage(dir, session, 0, ['goal.state']);
      expect(all.events.map((event) => event.kind)).toEqual(['preflight.verdict', 'goal.state', 'preflight.verdict']);
      expect(goals.events.map((event) => event.payload)).toEqual([{ status: 'active', text: 'tests pass' }]);
      expect(goals.cursor).toBe(all.cursor);
      expect(activityPage(dir, session, goals.cursor, ['goal.state']).events).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('keeps the levels each model takes beside the activity, and writes them only when they change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    const session = randomUUID();
    const levels = { 'anthropic/claude-sonnet-4-5': ['off' as const, 'low' as const, 'high' as const] };
    try {
      expect(modelLevels(dir, session)).toEqual({});
      const telemetry = new Telemetry(dir, session);
      telemetry.levels(levels);
      expect(modelLevels(dir, session)).toEqual(levels);
      // A record of its own, not an event: the activity stays as it was.
      expect(activityPage(dir, session, 0).events).toEqual([]);
      // The same levels again write nothing: the record spoiled here stays spoiled, and reads as none.
      writeFileSync(join(dir, `${session}.models.json`), 'not json');
      telemetry.levels({ ...levels });
      expect(modelLevels(dir, session)).toEqual({});
      telemetry.levels({ 'openai/gpt-4o': ['off'] });
      expect(modelLevels(dir, session)).toEqual({ 'openai/gpt-4o': ['off'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reads back only levels pi knows, for models named with their provider, and only for a session id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyrn-telemetry-'));
    const session = randomUUID();
    try {
      writeFileSync(
        join(dir, `${session}.models.json`),
        JSON.stringify({
          version: 1,
          levels: {
            'openai/gpt-5': ['off', 'turbo', 7, 'high'],
            'no-provider': ['off'],
            'openai/unknown-only': ['turbo'],
            'openai/not-a-list': 'high',
          },
        })
      );
      expect(modelLevels(dir, session)).toEqual({ 'openai/gpt-5': ['off', 'high'] });
      expect(() => modelLevels(dir, '../../outside')).toThrow('Invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('updates live snapshots without losing earlier interaction events', () => {
    const base = { at: 1, payload: {}, run: 'r' };
    const events = mergeActivity(
      [
        { ...base, id: 's1', kind: 'swarm.snapshot' },
        { ...base, id: 'n1', kind: 'hive.note' },
      ],
      [
        { ...base, id: 's2', kind: 'swarm.snapshot' },
        { ...base, id: 'n1', kind: 'hive.note' },
      ]
    );
    expect(events.map((e) => e.id)).toEqual(['s2', 'n1']);
  });
  it('keeps only the latest reply’s usage: the ring shows that one', () => {
    const events = mergeActivity([turnUsage('u1', 100)], [turnUsage('u2', 900), turnUsage('u3', 400)]);
    expect(events.map((e) => e.id)).toEqual(['u3']);
  });
});
