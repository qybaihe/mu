import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_LIMIT, NOTICE_LIMIT } from '@/common/utils/nativeHost/host.ts';
import {
  durable,
  emptyView,
  fromEntries,
  PRESENTATION_STATUS_KEY,
  readPresentation,
  reduce,
  reduceAll,
  type NativeView,
  type PiRecord,
} from '@/common/utils/nativeHost/index.ts';

/**
 * What only a live host says, in the view's `host` part: the judgment layer's frames and the run's edges for the Jev
 * panel, notices, pi's queue and the session as pi describes it; and mu's permission question, from its announcement
 * to its dialog. None of it is in a session file.
 */

type Json = Record<string, unknown>;

const records = readFileSync(join(__dirname, '..', 'fixtures', 'conversation.records.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as PiRecord);

let sequence = 0;
const frame = (kind: string, payload: Json, at = 100, turnId = 1): PiRecord => {
  sequence += 1;
  return {
    type: 'extension_ui_request',
    id: `ui-${sequence}`,
    method: 'setStatus',
    statusKey: PRESENTATION_STATUS_KEY,
    statusText: JSON.stringify({ version: 1, sequence, at, runtimeId: 'runtime', turnId, kind, payload }),
  };
};
const notify = (message: string, notifyType?: string): PiRecord => ({
  type: 'extension_ui_request',
  id: `notify-${message}`,
  method: 'notify',
  message,
  ...(notifyType ? { notifyType } : {}),
});
const select = (options: string[]): PiRecord => ({
  type: 'extension_ui_request',
  id: 'dialog-1',
  method: 'select',
  title: 'mu wants to run a command',
  options,
  timeout: 60000,
});
const userMessage = (text: string, timestamp: number): PiRecord => ({
  type: 'message_end',
  message: { role: 'user', content: [{ type: 'text', text }], timestamp },
});

describe('the activity the Jev panel reads', () => {
  it('holds every frame of the recorded conversation and the run’s edges, none of it in the file', () => {
    const view = reduceAll(records);
    const frames = records.flatMap((record) => {
      const shown = readPresentation(record);
      return shown ? [shown] : [];
    });
    const kinds = new Set(view.host.activity.map((line) => line.kind));
    for (const shown of frames) expect(kinds).toContain(shown.kind);
    expect(kinds).toContain('agent_start');
    expect(kinds).toContain('agent_settled');
    expect(view.host.activity.filter((line) => line.kind === 'agent_settled')).toHaveLength(6);
    expect(fromEntries([]).host.activity).toEqual([]);
    expect(durable(view).host).toEqual(emptyView().host);
  });

  it('keeps a decision frame as its record’s id, and a frame’s time and correlation', () => {
    const view = reduceAll([
      frame('decision', { id: 'd1', specId: 'input.preflight', state: { secret: 1 } }, 500, 3),
      frame('decision', { specId: 'old', state: { secret: 1 } }, 600, 3),
      frame('memory.recalled', { count: 2 }, 700, 3),
    ]);
    expect(view.host.activity).toEqual([
      { id: 'a1', kind: 'decision', payload: { id: 'd1' }, at: 500, runtimeId: 'runtime', turnId: 3, sequence: 1 },
      { id: 'a2', kind: 'decision', payload: { specId: 'old' }, at: 600, runtimeId: 'runtime', turnId: 3, sequence: 2 },
      {
        id: 'a3',
        kind: 'memory.recalled',
        payload: { count: 2 },
        at: 700,
        runtimeId: 'runtime',
        turnId: 3,
        sequence: 3,
      },
    ]);
    expect(view.judgments.map((judgment) => judgment.record)).toEqual([
      { id: 'd1', specId: 'input.preflight' },
      { specId: 'old' },
    ]);
  });

  it('keeps only the latest context policy, and a board with its running account over one without', () => {
    const view = reduceAll([
      frame('context.policy', { mode: 'shadow' }),
      frame('board.update', { now: 'a', log: ['one'] }),
      frame('context.policy', { mode: 'active' }),
      frame('board.update', { now: 'b' }),
    ]);
    expect(view.host.activity.map((line) => [line.id, line.kind, line.payload])).toEqual([
      ['a2', 'board.update', { now: 'a', log: ['one'] }],
      ['a3', 'context.policy', { mode: 'active' }],
      ['a4', 'board.update', { now: 'b' }],
    ]);
    const next = reduce(view, frame('board.update', { now: 'c', log: ['one', 'two'] }));
    expect(next.host.activity.map((line) => line.id)).toEqual(['a3', 'a5']);
  });

  it('times pi’s events by the latest time it has seen, and says how a compaction went', () => {
    const view = reduceAll([
      userMessage('hi', 900),
      { type: 'agent_start' },
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'compaction_end',
        reason: 'threshold',
        aborted: false,
        willRetry: false,
        result: {
          summary: 's',
          tokensBefore: 90000,
          estimatedTokensAfter: 20000,
          details: { kyrn: { version: 1, metrics: { kept: 3 } } },
        },
      },
      { type: 'compaction_end', reason: 'overflow', aborted: true, result: undefined, errorMessage: 'stopped' },
    ]);
    expect(view.host.activity).toEqual([
      { id: 'a1', kind: 'agent_start', payload: {}, at: 900 },
      { id: 'a2', kind: 'compaction_start', payload: { reason: 'threshold' }, at: 900 },
      {
        id: 'a3',
        kind: 'compaction_end',
        payload: {
          reason: 'threshold',
          aborted: false,
          applied: true,
          tokensBefore: 90000,
          tokensAfter: 20000,
          beta: true,
          metrics: { kept: 3 },
        },
        at: 900,
      },
      {
        id: 'a4',
        kind: 'compaction_end',
        payload: { reason: 'overflow', aborted: true, error: 'stopped', applied: false, beta: false },
        at: 900,
      },
    ]);
    expect(view.live.compacting).toBe(false);
  });

  it('keeps the latest lines only, and never gives an id twice', () => {
    let view = emptyView();
    for (let index = 0; index < ACTIVITY_LIMIT + 5; index++) view = reduce(view, frame('progress', { step: 's' }));
    expect(view.host.activity).toHaveLength(ACTIVITY_LIMIT);
    expect(view.host.activity[0].id).toBe('a6');
    expect(view.host.activity.at(-1)?.id).toBe(`a${ACTIVITY_LIMIT + 5}`);
  });
});

describe('notices', () => {
  it('shows an answer each time, a warning or an error once, after the message that was last', () => {
    const view = reduceAll([
      notify('  Saved.  '),
      userMessage('hi', 1),
      notify('Saved.', 'info'),
      notify('Disk is full', 'warning'),
      notify('Disk is full', 'warning'),
      notify('Broke', 'error'),
      notify('   '),
      notify('Odd level', 'loud'),
    ]);
    expect(view.host.notices).toEqual([
      { id: 'n1', level: 'info', text: 'Saved.' },
      { id: 'n2', level: 'info', text: 'Saved.', after: 'm1' },
      { id: 'n3', level: 'warning', text: 'Disk is full', after: 'm1' },
      { id: 'n4', level: 'error', text: 'Broke', after: 'm1' },
      { id: 'n5', level: 'info', text: 'Odd level', after: 'm1' },
    ]);
    expect(view.dialogs).toEqual([]);
  });

  it('turns mu’s checkpoint warning into its coded notice where it stands, once', () => {
    const recorded = reduceAll(records).host.notices;
    expect(recorded).toEqual([
      {
        id: 'n1',
        level: 'warning',
        text: expect.stringContaining('checkpoints are off'),
        after: 'm4',
        code: 'checkpoint_off',
        reason: 'xcode_license',
        params: {},
      },
    ]);
    const alone = reduceAll([
      frame('checkpoint.off', {
        code: 'repo_too_big',
        params: { files: 120000, note: 'x' },
        message: 'No checkpoints',
      }),
      frame('checkpoint.off', { code: 'again', params: {}, message: 'No checkpoints' }),
    ]);
    expect(alone.host.notices).toEqual([
      {
        id: 'n1',
        level: 'warning',
        text: 'No checkpoints',
        code: 'checkpoint_off',
        reason: 'repo_too_big',
        params: { files: 120000 },
      },
    ]);
  });

  it('says the free Jev’s notices by code, once each, and mu’s line after one not again', () => {
    const free = 'mu: no Jev key is set, so the judge uses the free Jev.';
    const paid = 'mu: the free Jev now asks for a key.';
    const view = reduceAll([
      frame('judge.notice', { code: 'free_jev', message: free }),
      notify(free, 'info'),
      frame('judge.notice', { code: 'free_jev', message: free }),
      frame('judge.notice', { code: 'free_jev_unavailable', reason: 'paid', message: paid }),
      notify(paid, 'warning'),
      // A code this build does not know leaves mu's line to say it.
      frame('judge.notice', { code: 'newer', message: 'Something newer.' }),
      notify('Something newer.', 'info'),
    ]);
    expect(view.host.notices).toEqual([
      { id: 'n1', level: 'info', text: free, code: 'free_jev' },
      { id: 'n2', level: 'warning', text: paid, code: 'free_jev_unavailable', reason: 'paid' },
      { id: 'n3', level: 'info', text: 'Something newer.' },
    ]);
    // mu's line already said becomes the coded notice where it stands.
    expect(
      reduceAll([notify(free, 'info'), frame('judge.notice', { code: 'free_jev', message: free })]).host.notices
    ).toEqual([{ id: 'n1', level: 'info', text: free, code: 'free_jev' }]);
  });

  it('keeps the latest notices only', () => {
    let view = emptyView();
    for (let index = 0; index < NOTICE_LIMIT + 2; index++) view = reduce(view, notify(`answer ${index}`));
    expect(view.host.notices).toHaveLength(NOTICE_LIMIT);
    expect(view.host.notices[0]).toMatchObject({ id: 'n3', text: 'answer 2' });
  });
});

describe('pi’s queue and the session', () => {
  it('shows what pi holds to send, as it last said', () => {
    const view = reduceAll([
      { type: 'queue_update', steering: ['look at b'], followUp: ['then c', 'and d'] },
      { type: 'queue_update', steering: [], followUp: ['and d'] },
    ]);
    expect(view.host.queue).toEqual({ steering: [], followUp: ['and d'] });
    expect(reduce(view, { type: 'queue_update' }).host.queue).toEqual({ steering: [], followUp: [] });
  });

  it('takes the session from the answers that describe it, whoever asked', () => {
    const state: PiRecord = {
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        model: { provider: 'p', id: 'm', name: 'M' },
        thinkingLevel: 'high',
        sessionName: 'Fixing tests',
        contextUsage: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
        compactionSettings: { enabled: true },
        autoCompactionEnabled: true,
        isStreaming: false,
      },
    };
    let view = reduceAll([userMessage('hi', 50), state]);
    expect(view.host.session).toEqual({
      model: 'p/m',
      thinkingLevel: 'high',
      name: 'Fixing tests',
      contextUsage: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
      compactionSettings: { enabled: true },
      autoCompaction: true,
      at: 50,
    });
    view = reduceAll(
      [
        { type: 'response', command: 'get_session_stats', success: true, data: { tokens: { input: 5, total: 9 } } },
        { type: 'response', command: 'set_model', success: true, data: { provider: 'q', id: 'n' } },
        { type: 'thinking_level_changed', level: 'low' },
        { type: 'session_info_changed', name: 'Renamed' },
        { type: 'response', command: 'get_state', success: false, error: 'busy' },
      ],
      view
    );
    expect(view.host.session).toMatchObject({
      model: 'q/n',
      thinkingLevel: 'low',
      name: 'Renamed',
      tokens: { input: 5, total: 9 },
    });
    view = reduce(view, {
      type: 'response',
      command: 'cycle_model',
      success: true,
      data: { model: { provider: 'r', id: 'o' }, thinkingLevel: 'off' },
    });
    expect(view.host.session).toMatchObject({ model: 'r/o', thinkingLevel: 'off' });
    // A state without a usable model: pi has none now.
    view = reduce(view, { type: 'response', command: 'get_state', success: true, data: { thinkingLevel: 'off' } });
    expect(view.host.session).not.toHaveProperty('model');
    expect(reduce(view, { type: 'session_info_changed' }).host.session).not.toHaveProperty('name');
  });
});

describe('mu’s permission question', () => {
  const request = (extra: Json = {}): PiRecord =>
    frame('permissions.request', {
      id: 'permission-1',
      toolCallId: 'call_1',
      kind: 'shell',
      summary: 'rm -rf build',
      reason: 'flagged',
      flagCode: 'mass_delete',
      grant: { label: 'rm in build' },
      answers: ['Allow once', 'Allow for this conversation', "Don't allow"],
      answerIds: ['once', 'session', 'deny'],
      ...extra,
    });
  const running = reduce(emptyView(), { type: 'agent_start' });

  it('goes with the dialog that asks it, which a screen can word in the reader’s language', () => {
    const announced = reduce(running, request());
    expect(announced.live.permission).toEqual({
      kind: 'shell',
      summary: 'rm -rf build',
      answers: ['Allow once', 'Allow for this conversation', "Don't allow"],
      answerIds: ['once', 'session', 'deny'],
      reason: 'flagged',
      flagCode: 'mass_delete',
      grantLabel: 'rm in build',
      toolCallId: 'call_1',
    });
    const asked = reduce(announced, select(['Allow once', 'Allow for this conversation', "Don't allow"]));
    expect(asked.live.permission).toBeUndefined();
    expect(asked.dialogs).toEqual([
      {
        id: 'dialog-1',
        method: 'select',
        title: 'mu wants to run a command',
        options: ['Allow once', 'Allow for this conversation', "Don't allow"],
        timeout: 60000,
        inRun: true,
        permission: announced.live.permission,
      },
    ]);
    const resolved = reduce(
      asked,
      frame('permissions.resolved', { id: 'permission-1', toolCallId: 'call_1', answer: 'deny' })
    );
    expect(resolved.dialogs).toEqual([]);
    expect(resolved.live.permission).toBeUndefined();
  });

  it('is not put on a select that offers something else, and drops ids that do not fit', () => {
    const announced = reduce(running, request({ answerIds: ['once', 'once', 'deny'], reason: 'Not A Code' }));
    expect(announced.live.permission).not.toHaveProperty('answerIds');
    expect(announced.live.permission).not.toHaveProperty('reason');
    const other = reduce(announced, select(['Red', 'Blue']));
    expect(other.dialogs[0]).not.toHaveProperty('permission');
    expect(other.live.permission).toBeDefined();
    expect(reduce(running, request({ answers: ['Only one'] })).live).toEqual(running.live);
  });

  it('is gone once the run settles', () => {
    const announced = reduce(running, request());
    expect(reduce(announced, { type: 'agent_settled' }).live).toEqual({ compacting: false });
  });
});

describe('a dialog outside a run', () => {
  it('stays open across runs until it is answered', () => {
    const asked: PiRecord = { type: 'extension_ui_request', id: 'name', method: 'input', title: 'Name it' };
    let view: NativeView = reduceAll([asked]);
    expect(view.dialogs).toEqual([{ id: 'name', method: 'input', title: 'Name it', inRun: false }]);
    view = reduceAll([{ type: 'agent_start' }, { type: 'agent_settled' }], view);
    expect(view.dialogs.map((dialog) => dialog.id)).toEqual(['name']);
    expect(reduce(view, { type: 'extension_ui_response', id: 'name', value: 'x' }).dialogs).toEqual([]);
  });
});
