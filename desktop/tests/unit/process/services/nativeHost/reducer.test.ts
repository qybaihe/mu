import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECISION_ENTRY,
  durable,
  emptyView,
  fromEntries,
  PRESENTATION_STATUS_KEY,
  readPresentation,
  reduce,
  reduceAll,
  VERDICT_ENTRY,
  type NativeView,
  type PiRecord,
  type ViewAssistantMessage,
  type ViewMessage,
  type ViewToolCall,
} from '../../../../../packages/desktop/src/common/utils/nativeHost/index.ts';
import { PLAIN_TEXT } from '../../../../e2e/mu-conversation/fakeModel.mjs';

/**
 * The reducer against a conversation recorded from a real host (fixtures/record.mjs: the E2E fake model, the mock
 * judge in shadow mode), and against records written by hand for what the fake model never does (thinking, errors,
 * branches). What only a live host says (the view's `host`) and retries are tested in view/.
 */

const lines = (name: string): PiRecord[] =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PiRecord);

const records = lines('conversation.records.jsonl');
const session = lines('conversation.session.jsonl');

/** The view after the record at `index`. */
const viewAt = (index: number): NativeView => reduceAll(records.slice(0, index + 1));

/** The index of the first record from `from` on that `test` accepts. */
function find(test: (record: PiRecord) => boolean, from = 0): number {
  const index = records.findIndex((record, at) => at >= from && test(record));
  if (index < 0) throw new Error('No such record in the fixture');
  return index;
}

const delta = (record: PiRecord): { type?: string; delta?: string } =>
  (record.assistantMessageEvent ?? {}) as { type?: string; delta?: string };

const frameKind = (record: PiRecord): string | undefined => readPresentation(record)?.kind;

const settles = (record: PiRecord): boolean => record.type === 'agent_settled';

const lastAssistant = (view: NativeView): ViewAssistantMessage => {
  const message = view.messages.at(-1);
  if (message?.role !== 'assistant') throw new Error('The last message is not the model’s');
  return message;
};

const toolOf = (message: ViewMessage | undefined): ViewToolCall => {
  const block = message?.role === 'assistant' ? message.blocks.find((each) => each.type === 'tool') : undefined;
  if (block?.type !== 'tool') throw new Error('No tool call in that message');
  return block;
};

const brief = (message: ViewMessage): string => {
  if (message.role === 'user') return `user: ${message.text}`;
  if (message.role === 'custom') return `custom: ${message.text}`;
  const blocks = message.blocks.map((block) =>
    block.type === 'tool' ? `${block.name} ${block.status} → ${block.result?.text ?? ''}` : block.text
  );
  return `assistant (${message.stopReason}): ${blocks.join(' | ')}`;
};

/** Freezes `value` and everything in it, so a reducer that changes what it was given throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

describe('a conversation recorded from a real host', () => {
  const settledAt = records.flatMap((record, index) => (record.type === 'agent_settled' ? [index] : []));

  it('gives the same view live and read back from the session file', () => {
    expect(durable(reduceAll(records))).toStrictEqual(fromEntries(session));
  });

  it('names the session entry each message is saved as', () => {
    const saved = new Map(session.map((entry) => [entry.id, entry]));
    const view = reduceAll(records);
    for (const message of view.messages) {
      const entry = saved.get(message.entryId ?? '');
      expect(entry?.type === 'message' ? (entry.message as { role?: string }).role : entry?.type).toBe(message.role);
    }
  });

  it('shows every message in order, each run ending as pi says it ended', () => {
    const view = reduceAll(records);
    expect(view.messages.map(brief)).toEqual([
      'user: E2E:PLAIN',
      `assistant (stop): ${PLAIN_TEXT}`,
      'user: E2E:WRITE notes/hello.txt',
      'assistant (toolUse): write done → Successfully wrote to notes/hello.txt',
      'assistant (stop): WRITE-DONE: Successfully wrote to notes/hello.txt',
      'user: E2E:BASH echo native-host-bash-ok',
      'assistant (toolUse): bash done → native-host-bash-ok\n',
      'assistant (stop): BASH-SAW: native-host-bash-ok\n',
      'user: E2E:BASH sleep 0.2; echo asked-ok',
      'assistant (toolUse): bash done → asked-ok\n',
      'assistant (stop): BASH-SAW: asked-ok\n',
      'user: E2E:BASH sleep 0.2; echo asked-ok',
      'assistant (toolUse): bash error → Operation aborted',
      'assistant (aborted): ',
      'user: E2E:SLOW',
      'assistant (aborted): SLOW-001 SLOW-002 SLOW-003 ',
    ]);
    expect(view.messages.map((message) => message.id)).toEqual(view.messages.map((_, index) => `m${index + 1}`));
    expect(settledAt.map((index) => viewAt(index).status)).toEqual([
      'settled',
      'settled',
      'settled',
      'settled',
      'aborted',
      'aborted',
    ]);
    expect(view.status).toBe('aborted');
    expect(view.error).toBeUndefined();
    expect(view.dialogs).toEqual([]);
    expect(view.live).toEqual({ compacting: false });
  });

  it('streams the reply into the message pi started, and completes it at its end', () => {
    const start = find(
      (record) => record.type === 'message_start' && (record.message as { role?: string }).role === 'assistant'
    );
    expect(lastAssistant(viewAt(start))).toMatchObject({ id: 'm2', blocks: [], streaming: true });
    expect(viewAt(start).status).toBe('working');

    const midway = find((record) => delta(record).delta === '好几段');
    expect(lastAssistant(viewAt(midway)).blocks).toEqual([{ type: 'text', text: 'PLAIN-REPLY-OK: 这是分成好几段' }]);

    const end = find((record) => record.type === 'message_end', midway);
    expect(lastAssistant(viewAt(end))).toMatchObject({
      id: 'm2',
      blocks: [{ type: 'text', text: PLAIN_TEXT }],
      model: 'e2e/e2e-fake-model',
      stopReason: 'stop',
      streaming: false,
    });
  });

  it('follows a tool call from the model writing it to its result', () => {
    const write = (record: PiRecord) => delta(record).type === 'toolcall_start';
    const started = find(write);
    expect(toolOf(viewAt(started).messages.at(-1))).toEqual({
      type: 'tool',
      id: 'call_e2e_2',
      name: 'write',
      args: {},
      status: 'streaming',
    });
    const written = find((record) => delta(record).type === 'toolcall_end', started);
    expect(toolOf(viewAt(written).messages.at(-1))).toMatchObject({
      status: 'pending',
      args: { path: 'notes/hello.txt', content: 'Written by the fake model for the E2E test.\n' },
    });
    const running = find((record) => record.type === 'tool_execution_start', written);
    expect(toolOf(viewAt(running).messages.at(-1)).status).toBe('running');
    const done = find((record) => record.type === 'tool_execution_end', running);
    expect(toolOf(viewAt(done).messages.at(-1))).toMatchObject({
      status: 'done',
      result: { text: 'Successfully wrote to notes/hello.txt', images: [], isError: false },
    });
  });

  it('shows a running command’s output as it comes, then its result', () => {
    const update = find((record) => record.type === 'tool_execution_update');
    const running = toolOf(viewAt(update).messages.at(-1));
    expect(running).toMatchObject({ name: 'bash', status: 'running', partial: { isError: false } });
    const end = find((record) => record.type === 'tool_execution_end', update);
    const done = toolOf(viewAt(end).messages.at(-1));
    expect(done.partial).toBeUndefined();
    expect(done.result).toEqual({ text: 'native-host-bash-ok\n', images: [], isError: false });
  });

  it('opens mu’s permission question while the run waits, and closes it with the answer', () => {
    const asked = find((record) => record.type === 'extension_ui_request' && record.method === 'select');
    const open = viewAt(asked);
    expect(open.status).toBe('working');
    expect(open.dialogs).toEqual([
      {
        id: records[asked].id,
        method: 'select',
        title: 'mu wants to run a command\nsleep 0.2; echo asked-ok\nJev is not sure this step is what you want.',
        options: ['Allow once', "Don't allow"],
        inRun: true,
        permission: {
          kind: 'shell',
          summary: 'sleep 0.2; echo asked-ok',
          answers: ['Allow once', "Don't allow"],
          answerIds: ['once', 'deny'],
          reason: 'unsure',
          toolCallId: 'call_e2e_6',
        },
      },
    ]);
    expect(open.live.permission).toBeUndefined();
    expect(viewAt(asked - 1).live.permission).toMatchObject({ summary: 'sleep 0.2; echo asked-ok' });
    expect(open.live.progress).toEqual({
      turn: 4,
      step: 'Jev is reviewing: sleep 0.2; echo asked-ok',
      code: 'permission_review',
      params: { summary: 'sleep 0.2; echo asked-ok' },
    });
    const answered = find((record) => record.type === 'extension_ui_response', asked);
    expect(records[answered]).toMatchObject({ id: records[asked].id, value: 'Allow once' });
    expect(viewAt(answered).dialogs).toEqual([]);
  });

  it('says a run stopped while mu asked about a command was aborted, not failed', () => {
    const first = find((record) => record.type === 'extension_ui_request' && record.method === 'select');
    const asked = find((record) => record.type === 'extension_ui_request' && record.method === 'select', first + 1);
    expect(viewAt(asked).dialogs).toMatchObject([{ id: records[asked].id, permission: { toolCallId: 'call_e2e_8' } }]);
    // pi says nothing of the dialog it stopped waiting on; mu says it took the question as denied.
    const resolved = find((record) => frameKind(record) === 'permissions.resolved', asked);
    expect(records.slice(asked, resolved).some((record) => record.type === 'extension_ui_response')).toBe(false);
    expect(viewAt(resolved).dialogs).toEqual([]);
    const settled = find(settles, resolved);
    const view = viewAt(settled);
    expect(view.status).toBe('aborted');
    expect(view.error).toBeUndefined();
    expect(toolOf(view.messages.at(-2))).toMatchObject({
      id: 'call_e2e_8',
      status: 'error',
      result: { text: 'Operation aborted', isError: true },
    });
    expect(lastAssistant(view)).toMatchObject({
      blocks: [],
      stopReason: 'aborted',
      errorMessage: 'This operation was aborted',
    });
  });

  it('keeps what the model wrote before the stop, and says the run was aborted, not failed', () => {
    const third = find((record) => delta(record).delta === 'SLOW-003 ');
    expect(viewAt(third).status).toBe('working');
    expect(lastAssistant(viewAt(third))).toMatchObject({ streaming: true });
    const last = lastAssistant(reduceAll(records));
    expect(last).toMatchObject({
      blocks: [{ type: 'text', text: 'SLOW-001 SLOW-002 SLOW-003 ' }],
      stopReason: 'aborted',
      errorMessage: 'Request was aborted',
      streaming: false,
    });
  });

  it('files each of Jev’s judgments once, under the turn that asked, without the state it was shown', () => {
    const view = reduceAll(records);
    const ledger = session.filter((entry) => entry.type === 'custom' && entry.customType === DECISION_ENTRY);
    expect(ledger.length).toBeGreaterThan(0);
    expect(view.judgments.map((judgment) => judgment.id)).toEqual(
      ledger.map((entry) => (entry.data as { id: string }).id)
    );
    for (const judgment of view.judgments) {
      expect(judgment.turn).toBe((judgment.record.origin as { turn: number }).turn);
      expect(judgment.record).not.toHaveProperty('state');
    }
    expect([...new Set(view.judgments.map((judgment) => judgment.turn))]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(view.judgments.some((judgment) => judgment.record.specId === 'tool.approval' && judgment.turn === 4)).toBe(
      true
    );
  });

  it('puts the preflight’s verdict line on the message it was about', () => {
    const view = reduceAll(records);
    const users = view.messages.filter((message) => message.role === 'user');
    expect(users).toHaveLength(6);
    for (const message of users) expect(message.verdict).toMatchObject({ version: 1, by: 'mock' });
    expect(session.filter((entry) => entry.customType === VERDICT_ENTRY)).toHaveLength(6);
  });

  it('shows that Jev classifies a message only until its verdict', () => {
    const pending = find((record) => frameKind(record) === 'preflight.pending');
    expect(viewAt(pending).live.classifying).toEqual({ turn: 1, judge: 'mock' });
    const verdict = find((record) => frameKind(record) === 'preflight.verdict', pending);
    expect(viewAt(verdict).live.classifying).toBeUndefined();
  });

  it('never changes the view or the records it is given', () => {
    const frozen = deepFreeze(structuredClone(records));
    let view = deepFreeze(emptyView());
    for (const record of frozen) view = deepFreeze(reduce(view, record));
    expect(view).toStrictEqual(reduceAll(records));
    expect(deepFreeze(fromEntries(deepFreeze(structuredClone(session))))).toStrictEqual(durable(view));
  });
});

// ── records written by hand ─────────────────────────────────────────────────

type Json = Record<string, unknown>;

const text = (value: string): Json => ({ type: 'text', text: value });
const user = (value: string): Json => ({ role: 'user', content: [text(value)], timestamp: 1 });
const assistant = (content: Json[], extra: Json = {}): Json => ({
  role: 'assistant',
  content,
  provider: 'p',
  model: 'm',
  stopReason: 'stop',
  timestamp: 2,
  ...extra,
});
const update = (event: Json): PiRecord => ({ type: 'message_update', assistantMessageEvent: event });
const frame = (kind: string, payload: Json, turnId = 1, sequence = 1): PiRecord => ({
  type: 'extension_ui_request',
  id: `ui-${sequence}`,
  method: 'setStatus',
  statusKey: PRESENTATION_STATUS_KEY,
  statusText: JSON.stringify({ version: 1, sequence, at: 0, runtimeId: 'runtime', turnId, kind, payload }),
});
const decision = (id: string, turn?: number): Json => ({
  id,
  specId: 'input.preflight',
  ...(turn === undefined ? {} : { origin: { turn } }),
  state: { conversation: 'what the judge was shown' },
});
const ledgerEntry = (data: Json): PiRecord => ({
  type: 'entry_appended',
  entry: { type: 'custom', customType: DECISION_ENTRY, id: `entry-${String(data.id)}`, parentId: null, data },
});

/** Every status the view passes through. */
const statuses = (list: PiRecord[]): string[] => {
  let view = emptyView();
  return list.map((record) => (view = reduce(view, record)).status);
};

describe('reduce', () => {
  it('says the model thinks while it writes a thinking block, and never shows a redacted one', () => {
    const run: PiRecord[] = [
      { type: 'agent_start' },
      { type: 'message_start', message: assistant([], { stopReason: 'pending' }) },
      update({ type: 'thinking_start', contentIndex: 0 }),
      update({ type: 'thinking_delta', contentIndex: 0, delta: 'Weighing ' }),
      update({ type: 'thinking_delta', contentIndex: 0, delta: 'it' }),
      update({ type: 'thinking_end', contentIndex: 0, content: 'Weighing it' }),
      update({ type: 'text_start', contentIndex: 1 }),
      update({ type: 'text_delta', contentIndex: 1, delta: 'Done.' }),
      {
        type: 'message_end',
        message: assistant([
          { type: 'thinking', thinking: 'Weighing it', thinkingSignature: 'signature' },
          { type: 'thinking', thinking: 'hidden', redacted: true },
          text('Done.'),
        ]),
      },
      { type: 'agent_settled' },
    ];
    expect(statuses(run)).toEqual([
      'working',
      'working',
      'thinking',
      'thinking',
      'thinking',
      'working',
      'working',
      'working',
      'working',
      'settled',
    ]);
    expect(lastAssistant(reduceAll(run.slice(0, 5))).blocks).toEqual([{ type: 'thinking', text: 'Weighing it' }]);
    expect(lastAssistant(reduceAll(run)).blocks).toEqual([
      { type: 'thinking', text: 'Weighing it' },
      { type: 'thinking', text: '', redacted: true },
      text('Done.'),
    ]);
  });

  it('leaves the thinking status when a message ends inside its thinking block', () => {
    const run: PiRecord[] = [
      { type: 'agent_start' },
      { type: 'message_start', message: assistant([]) },
      update({ type: 'thinking_start', contentIndex: 0 }),
      { type: 'message_end', message: assistant([{ type: 'thinking', thinking: '' }], { stopReason: 'aborted' }) },
      { type: 'agent_settled' },
    ];
    expect(statuses(run)).toEqual(['working', 'working', 'thinking', 'working', 'aborted']);
  });

  it('says why a run failed, from its last message', () => {
    const view = reduceAll([
      { type: 'agent_start' },
      { type: 'message_end', message: user('hi') },
      { type: 'message_end', message: assistant([], { stopReason: 'error', errorMessage: 'Connection refused' }) },
      { type: 'agent_settled' },
    ]);
    expect(view.status).toBe('error');
    expect(view.error).toBe('Connection refused');
    const next = reduceAll([{ type: 'agent_start' }], view);
    expect(next.status).toBe('working');
    expect(next).not.toHaveProperty('error');
  });

  it('shows what the person said, without the rules AionUi puts in front of a conversation’s first message', () => {
    const rules = '[Assistant Rules]\n## Available Skills\n\n- **cron**: Scheduled tasks\n[/Assistant Rules]\n\n';
    const said = (content: string) =>
      reduceAll([{ type: 'message_end', message: user(content) }]).messages.map((message) =>
        message.role === 'user' ? message.text : undefined
      );
    expect(said(`${rules}Refactor the parser`)).toEqual(['Refactor the parser']);
    // Nothing else in the message: it is shown as it is, not as an empty row.
    expect(said(rules.trimEnd())).toEqual([rules.trimEnd()]);
    // Ordinary messages, including one that talks about rules, are left alone; so is a preamble that is not first.
    expect(said('Write [Assistant Rules] for me')).toEqual(['Write [Assistant Rules] for me']);
    expect(said(`hello\n${rules}there`)).toEqual([`hello\n${rules}there`]);
    // The session file reads the same.
    const fromFile = fromEntries([
      { type: 'session', id: 's', timestamp: '2026-09-30T00:00:00.000Z', cwd: '/p' },
      { type: 'message', id: 'u1', parentId: null, message: user(`${rules}Refactor the parser`) },
    ]);
    expect(fromFile.messages[0]).toMatchObject({ role: 'user', text: 'Refactor the parser' });
  });

  it('takes a prompt pi refused as a failed run, but not a response while one runs', () => {
    const refused: PiRecord = { type: 'response', command: 'prompt', success: false, error: 'No API key for p/m' };
    expect(reduce(emptyView(), refused)).toMatchObject({ status: 'error', error: 'No API key for p/m' });
    const running = reduce(emptyView(), { type: 'agent_start' });
    expect(reduce(running, refused)).toBe(running);
    expect(reduce(running, { type: 'response', command: 'get_state', success: true, data: {} }).status).toBe('working');
  });

  it('shows a retry and a compaction only while they go', () => {
    let view = reduceAll([
      { type: 'agent_start' },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'overloaded' },
    ]);
    expect(view.live.retry).toEqual({ attempt: 1, maxAttempts: 3, delayMs: 2000, error: 'overloaded' });
    view = reduceAll([{ type: 'auto_retry_end', success: true, attempt: 1 }, { type: 'compaction_start' }], view);
    expect(view.live).toEqual({ compacting: true });
    expect(reduce(view, { type: 'compaction_end' }).live).toEqual({ compacting: false });
    expect(reduce(view, { type: 'agent_settled' }).live).toEqual({ compacting: true });
  });

  it('files a late judgment under the turn that asked, and counts an entry and its frame once', () => {
    const view = reduceAll([
      ledgerEntry(decision('a', 1)),
      frame('decision', { ...decision('a', 1), state: undefined }, 1, 2),
      { type: 'agent_start' },
      ledgerEntry(decision('late', 1)),
      frame('decision', decision('late', 1), 2, 3),
    ]);
    expect(view.judgments).toEqual([
      { id: 'a', turn: 1, record: { id: 'a', specId: 'input.preflight', origin: { turn: 1 } } },
      { id: 'late', turn: 1, record: { id: 'late', specId: 'input.preflight', origin: { turn: 1 } } },
    ]);
  });

  it('takes the turn of a record that names none from its frame', () => {
    const entryFirst = reduceAll([ledgerEntry(decision('old')), frame('decision', decision('old'), 3, 4)]);
    expect(entryFirst.judgments).toEqual([{ id: 'old', turn: 3, record: { id: 'old', specId: 'input.preflight' } }]);
    const noTurn = reduceAll([ledgerEntry(decision('older'))]);
    expect(noTurn.judgments).toEqual([{ id: 'older', record: { id: 'older', specId: 'input.preflight' } }]);
  });

  it('keeps a dialog pi opened outside a run past the end of the next run, and drops one of the run', () => {
    const outside: PiRecord = {
      type: 'extension_ui_request',
      id: 'outside',
      method: 'input',
      title: 'Name',
      placeholder: 'a name',
    };
    const inside: PiRecord = {
      type: 'extension_ui_request',
      id: 'inside',
      method: 'confirm',
      title: 'Sure?',
      message: 'This deletes the file',
      timeout: 5000,
    };
    const editor: PiRecord = {
      type: 'extension_ui_request',
      id: 'editor',
      method: 'editor',
      title: 'Edit',
      prefill: 'x',
    };
    const view = reduceAll([outside, { type: 'agent_start' }, inside, editor]);
    expect(view.dialogs).toEqual([
      { id: 'outside', method: 'input', title: 'Name', placeholder: 'a name', inRun: false },
      { id: 'inside', method: 'confirm', title: 'Sure?', message: 'This deletes the file', timeout: 5000, inRun: true },
      { id: 'editor', method: 'editor', title: 'Edit', prefill: 'x', inRun: true },
    ]);
    expect(reduce(view, { type: 'agent_settled' }).dialogs.map((dialog) => dialog.id)).toEqual(['outside']);
    expect(reduce(view, { type: 'extension_ui_response', id: 'outside', cancelled: true }).dialogs).toHaveLength(2);
  });

  it('opens no dialog for pi’s fire-and-forget requests', () => {
    const view = emptyView();
    for (const method of ['setStatus', 'setWidget', 'setTitle', 'set_editor_text'])
      expect(reduce(view, { type: 'extension_ui_request', id: 'x', method, message: 'hi' })).toBe(view);
    expect(reduce(view, { type: 'extension_ui_request', id: 'x', method: 'notify', message: 'hi' }).dialogs).toEqual(
      []
    );
  });

  it('shows the messages extensions show the person, live and from the file alike', () => {
    const shown = { role: 'custom', customType: 'kyrn.note', content: 'Saved a lesson', display: true, timestamp: 3 };
    const hidden = { ...shown, display: false, content: 'For the model only' };
    // pi writes one at a turn's boundary as an entry only, and its time as the entry's.
    const entry = {
      type: 'custom_message',
      id: 'c1',
      parentId: null,
      customType: 'kyrn.board',
      content: [text('The board')],
      display: true,
      timestamp: '2026-09-27T12:00:00.000Z',
    };
    const live = reduceAll([
      { type: 'message_end', message: shown, entryId: 'a' },
      { type: 'message_end', message: hidden, entryId: 'b' },
      { type: 'entry_appended', entry },
    ]);
    expect(live.messages).toEqual([
      { id: 'm1', role: 'custom', entryId: 'a', customType: 'kyrn.note', text: 'Saved a lesson' },
      { id: 'm2', role: 'custom', entryId: 'c1', customType: 'kyrn.board', text: 'The board' },
    ]);
    // In the file both are entries: pi keeps a message it sent while a run went as a custom_message too.
    const { role: _role, timestamp: _sent, ...sent } = shown;
    const { role: _hiddenRole, timestamp: _hiddenSent, ...hiddenSent } = hidden;
    const file = fromEntries([
      { type: 'custom_message', id: 'a', parentId: null, ...sent, timestamp: '2026-09-27T11:59:59.000Z' },
      { type: 'custom_message', id: 'b', parentId: 'a', ...hiddenSent, timestamp: '2026-09-27T11:59:59.500Z' },
      { ...entry, parentId: 'b' },
    ]);
    expect(file.messages).toEqual(live.messages);
  });

  it('ignores records it does not know, and results for calls it never saw', () => {
    const view = reduceAll([{ type: 'message_end', message: user('hi') }]);
    for (const record of [
      { type: 'turn_start' },
      { type: 'something_new', payload: 1 },
      { type: 'tool_execution_end', toolCallId: 'nobody', result: { content: [] }, isError: false },
      update({ type: 'text_delta', contentIndex: 0, delta: 'no message streams' }),
    ])
      expect(reduce(view, record)).toBe(view);
  });
});

describe('fromEntries', () => {
  const entries = [
    { type: 'session', version: 3, id: 'header', cwd: '/project' },
    { type: 'message', id: 'e1', parentId: null, message: user('first') },
    { type: 'message', id: 'e2', parentId: 'e1', message: assistant([text('one')]) },
    { type: 'message', id: 'e3', parentId: 'e2', message: user('second') },
    { type: 'message', id: 'e4', parentId: 'e3', message: assistant([text('two')]) },
    { type: 'message', id: 'e5', parentId: 'e2', message: user('another second') },
  ];

  it('reads the branch that ends at the leaf, the last entry unless named', () => {
    expect(fromEntries(entries).messages.map(brief)).toEqual([
      'user: first',
      'assistant (stop): one',
      'user: another second',
    ]);
    expect(fromEntries(entries, 'e4').messages.map(brief)).toEqual([
      'user: first',
      'assistant (stop): one',
      'user: second',
      'assistant (stop): two',
    ]);
    expect(fromEntries(entries, null)).toStrictEqual(emptyView());
  });

  it('ends at an entry whose parents loop', () => {
    const looped = [
      { type: 'message', id: 'x', parentId: 'y', message: user('x') },
      { type: 'message', id: 'y', parentId: 'x', message: user('y') },
    ];
    expect(fromEntries(looped).messages.map(brief)).toEqual(['user: x', 'user: y']);
  });

  it('shows a session that ends before any answer as idle', () => {
    expect(fromEntries(entries.slice(0, 2)).status).toBe('idle');
    expect(fromEntries(entries.slice(0, 3)).status).toBe('settled');
  });
});

describe('readPresentation', () => {
  it('reads a frame and its correlation', () => {
    expect(readPresentation(frame('progress', { step: 'reading' }, 2, 7))).toEqual({
      version: 1,
      kind: 'progress',
      payload: { step: 'reading' },
      at: 0,
      correlation: { runtimeId: 'runtime', turnId: 2, sequence: 7 },
    });
  });

  it('leaves out a correlation it cannot trust, and reads nothing from other records', () => {
    const odd: PiRecord = {
      ...frame('progress', {}),
      statusText: JSON.stringify({
        version: 1,
        kind: 'progress',
        payload: {},
        runtimeId: 'r',
        turnId: -1,
        sequence: 1,
      }),
    };
    expect(readPresentation(odd)).toEqual({ version: 1, kind: 'progress', payload: {} });
    expect(readPresentation({ ...frame('progress', {}), statusKey: 'kyrn' })).toBeUndefined();
    expect(readPresentation({ ...frame('progress', {}), statusText: '{not json' })).toBeUndefined();
    expect(readPresentation({ ...frame('progress', {}), statusText: JSON.stringify({ version: 1 }) })).toBeUndefined();
    expect(readPresentation({ type: 'message_end' })).toBeUndefined();
  });
});
