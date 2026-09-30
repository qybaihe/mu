import { describe, expect, it } from 'vitest';
import { emptyView, fromEntries, reduce, reduceAll, type NativeView } from '@/common/utils/nativeHost';
import { toActivity } from '@/renderer/pages/native/utils/toActivity';
import { isWorking, statusRow } from '@/renderer/pages/native/utils/statusRow';
import { ended, frame, recorded, recordedSession, reply, text, toolCall, user } from './records';

/** The Jev panel's activity of a native conversation, and the status line above its send box. */

describe('the Jev panel’s activity', () => {
  it('holds the recorded conversation’s frames with each decision’s ledger record, in time order', () => {
    const view = reduceAll(recorded);
    const events = toActivity(view);
    const decisions = events.filter((event) => event.kind === 'decision');
    const ledger = recordedSession.filter((entry) => entry.customType === 'kyrn.decision');
    expect(decisions.map((event) => event.payload.id)).toEqual(
      ledger.map((entry) => (entry.data as { id: string }).id)
    );
    for (const event of decisions) expect(event.payload).toHaveProperty('specId');
    const times = events.map((event) => event.at);
    expect(times).toEqual(times.toSorted((a, b) => a - b));
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(events.find((event) => event.kind === 'context.usage')?.payload).toMatchObject({
      model: 'e2e-fake-model',
      busy: false,
      compacting: false,
      usage: { contextWindow: 128000 },
    });
    expect(events.find((event) => event.kind === 'permissions.request')).toMatchObject({
      turnId: 4,
      runtimeId: expect.any(String),
      payload: { summary: 'sleep 0.2; echo asked-ok' },
    });
  });

  it('holds the judgments of a conversation read from its file, which has the ledger and no frames', () => {
    const view = fromEntries(recordedSession);
    expect(view.host.activity).toEqual([]);
    const decisions = toActivity(view).filter((event) => event.kind === 'decision');
    const ledger = recordedSession
      .filter((entry) => entry.customType === 'kyrn.decision')
      .map((entry) => entry.data as { id: string; timestamp: string });
    expect(decisions.map((event) => event.payload.id)).toEqual(ledger.map((record) => record.id));
    // Each at the time its record was made, not the time the file was read.
    expect(decisions.map((event) => event.at)).toEqual(ledger.map((record) => Date.parse(record.timestamp)));
    for (const event of decisions) expect(event.payload).toHaveProperty('specId');
    // A live view carries each judgment once, by its frame: nothing from the ledger comes twice.
    const live = toActivity(reduceAll(recorded)).filter((event) => event.kind === 'decision');
    expect(live.filter((event) => event.id.startsWith('judgment:'))).toEqual([]);
  });

  it('counts the latest reply that read anything, as the board’s cache ring shows it', () => {
    const view = reduceAll([
      ended(user('hi')),
      ended(reply([text('a')], { usage: { input: 10, output: 2, cacheRead: 90, cacheWrite: 0 } })),
      ended(reply([text('b')], { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, timestamp: 3 })),
    ]);
    expect(toActivity(view).filter((event) => event.kind === 'turn.usage')).toEqual([
      { id: 'usage:m2', at: 2, kind: 'turn.usage', payload: { input: 10, output: 2, cacheRead: 90, cacheWrite: 0 } },
    ]);
  });

  it('makes a hive’s manifest, its latest snapshot and the images tools gave back', () => {
    const snapshot = { kind: 'hive', title: 'Survey', bees: [{ name: 'ant' }], dir: '/tmp/kyrn-hive-1' };
    const view = reduceAll([
      { type: 'agent_start' },
      ended(user('survey it')),
      ended(
        reply([toolCall('h1', 'hive', { goal: 'Survey', bees: [{ name: 'ant', focus: 'docs' }, 'odd'] })], {
          stopReason: 'toolUse',
        })
      ),
      { type: 'tool_execution_start', toolCallId: 'h1', toolName: 'hive', args: {} },
      {
        type: 'tool_execution_update',
        toolCallId: 'h1',
        partialResult: { content: [text('working')], details: { snapshot } },
      },
      ended({
        role: 'toolResult',
        toolCallId: 'h1',
        toolName: 'hive',
        content: [
          text('done'),
          { type: 'image', mimeType: 'image/png', data: 'aGk=' },
          { type: 'image', mimeType: 'image/tiff', data: 'aGk=' },
        ],
        details: { snapshot: { ...snapshot, title: 'Survey done' } },
        isError: false,
        timestamp: 4,
      }),
    ]);
    const events = toActivity(view);
    expect(events.find((event) => event.kind === 'hive.manifest')).toMatchObject({
      run: 'h1',
      payload: {
        goal: 'Survey',
        bees: [
          { name: 'ant', focus: 'docs' },
          { name: '', focus: '' },
        ],
      },
    });
    expect(events.filter((event) => event.kind === 'swarm.snapshot')).toEqual([
      { id: 'snapshot:h1', at: 2, kind: 'swarm.snapshot', run: 'h1', payload: { ...snapshot, title: 'Survey done' } },
    ]);
    expect(events.filter((event) => event.kind === 'artifact.image').map((event) => event.payload)).toEqual([
      { type: 'image', data: 'aGk=', mimeType: 'image/png', toolCallId: 'h1' },
    ]);
  });

  it('is empty for a conversation that said nothing yet', () => {
    expect(toActivity(emptyView())).toEqual([]);
  });
});

describe('the status line', () => {
  const running = reduce(emptyView(), { type: 'agent_start' });

  it('says what holds the run up first, then how it goes, then how it ended', () => {
    expect(statusRow(emptyView())).toEqual({ kind: 'idle' });
    expect(statusRow(running)).toEqual({ kind: 'working' });
    expect(isWorking(running)).toBe(true);
    const reviewing = reduce(
      running,
      frame('progress', { step: 'Jev is reviewing: ls', code: 'permission_review', params: { summary: 'ls' } })
    );
    expect(statusRow(reviewing)).toEqual({
      kind: 'working',
      step: 'Jev is reviewing: ls',
      code: 'permission_review',
      params: { summary: 'ls' },
    });
    const thinking = reduceAll(
      [
        { type: 'message_start', message: reply([]) },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
      ],
      running
    );
    expect(statusRow(thinking)).toEqual({ kind: 'thinking' });
    const retrying = reduce(running, {
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4000,
      errorMessage: 'overloaded',
    });
    expect(statusRow(retrying)).toEqual({
      kind: 'retrying',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4000,
      error: 'overloaded',
    });
    expect(statusRow(reduce(retrying, { type: 'compaction_start', reason: 'overflow' }))).toEqual({
      kind: 'compacting',
    });
    const classifying: NativeView = reduce(emptyView(), frame('preflight.pending', { judge: 'jev-latest' }));
    expect(statusRow(classifying)).toEqual({ kind: 'classifying', judge: 'jev-latest' });
    expect(isWorking(classifying)).toBe(false);
  });

  it('says how the last run ended', () => {
    const end = (stopReason: string, errorMessage?: string) =>
      statusRow(
        reduceAll(
          [ended(reply([], { stopReason, ...(errorMessage ? { errorMessage } : {}) })), { type: 'agent_settled' }],
          running
        )
      );
    expect(end('stop')).toEqual({ kind: 'settled' });
    expect(end('aborted')).toEqual({ kind: 'aborted' });
    expect(end('error', 'boom')).toEqual({ kind: 'error', error: 'boom' });
  });
});
