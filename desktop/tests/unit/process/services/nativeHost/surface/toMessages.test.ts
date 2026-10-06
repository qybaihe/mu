import { describe, expect, it } from 'vitest';
import type { IMessageAcpToolCall, TMessage } from '@/common/chat/chatLib';
import { normalizeAcpToolCall } from '@/common/chat/normalizeToolCall';
import { emptyView, reduce, reduceAll, type NativeView, type PiRecord } from '@/common/utils/nativeHost';
import { jevLine } from '@/renderer/pages/conversation/Messages/acp/jevLine';
import { muNotice } from '@/renderer/pages/conversation/Messages/acp/muNotice';
import { findMuTurnError } from '@/renderer/utils/chat/muTurnErrors';
import { createMessageMapper, toMessages, type MessageOptions } from '@/renderer/pages/native/utils/toMessages';
import { PLAIN_TEXT } from '../../../../../e2e/mu-conversation/fakeModel.mjs';
import {
  delta,
  ended,
  findRecord,
  frame,
  recorded,
  recordedAt,
  reply,
  text,
  toolCall,
  toolResult,
  user,
} from './records';

/**
 * The rows the message list shows for a native conversation, read the way the list and its rows read them: tool rows
 * through the tool summary's normalizer, Jev's lines and mu's notices through their own readers, errors through the
 * tips row's recogniser.
 */

const words = {
  retried: (count: number) => `Retried ${count}×`,
  compacted: (tokens: number) => (tokens ? `Compacted ${tokens}` : 'Compacted'),
};
const options: MessageOptions = { conversationId: 'native-1', words };
const rows = (view: NativeView, extra: Partial<MessageOptions> = {}): TMessage[] =>
  toMessages(view, { ...options, ...extra });

/** One row as a short line: what it is and what it says. */
function brief(row: TMessage): string {
  switch (row.type) {
    case 'text':
      return `${row.position === 'right' ? 'person' : 'mu'}: ${row.content.content}`;
    case 'thinking':
      return `thinking (${row.content.status}): ${row.content.content}`;
    case 'tips':
      return `${row.content.type}: ${row.content.content}`;
    case 'acp_tool_call': {
      const jev = jevLine(row);
      if (jev) return `jev: ${jev.stage}`;
      const notice = muNotice(row);
      if (notice) return `notice: ${notice.code ?? notice.level ?? ''}`;
      const call = normalizeAcpToolCall(row);
      return `call ${call?.name} ${call?.status}: ${call?.output ?? ''}`;
    }
    default:
      return row.type;
  }
}

const tool = (list: TMessage[], index = -1): IMessageAcpToolCall => {
  const calls = list.filter(
    (row): row is IMessageAcpToolCall => row.type === 'acp_tool_call' && !jevLine(row) && !muNotice(row)
  );
  const found = calls.at(index);
  if (!found) throw new Error('No tool row');
  return found;
};

describe('the recorded conversation', () => {
  it('shows every message, call, verdict line and notice in order', () => {
    const list = rows(reduceAll(recorded));
    expect(list.map(brief)).toEqual([
      'person: E2E:PLAIN',
      'jev: classified',
      `mu: ${PLAIN_TEXT}`,
      'person: E2E:WRITE notes/hello.txt',
      'jev: fallback',
      'call write completed: Successfully wrote to notes/hello.txt',
      'notice: checkpoint_off',
      'mu: WRITE-DONE: Successfully wrote to notes/hello.txt',
      'person: E2E:BASH echo native-host-bash-ok',
      'jev: fallback',
      'call bash completed: native-host-bash-ok\n',
      'mu: BASH-SAW: native-host-bash-ok\n',
      'person: E2E:BASH sleep 0.2; echo asked-ok',
      'jev: fallback',
      'call bash completed: asked-ok\n',
      'mu: BASH-SAW: asked-ok\n',
      'person: E2E:BASH sleep 0.2; echo asked-ok',
      'jev: fallback',
      'call bash error: Operation aborted',
      'notice: stopped',
      'person: E2E:SLOW',
      'jev: fallback',
      'mu: SLOW-001 SLOW-002 SLOW-003 ',
      'notice: stopped',
    ]);
  });

  it('keeps the rows in time order, so the list’s sort by time moves none of them', () => {
    const list = rows(reduceAll(recorded));
    const times = list.map((row) => row.created_at ?? 0);
    expect(times).toEqual(times.toSorted((a, b) => a - b));
    expect(new Set(list.map((row) => row.id)).size).toBe(list.length);
  });

  it('streams the reply into its row, and runs a call from pending to its result', () => {
    const midway = findRecord((record) => (record.assistantMessageEvent as { delta?: string })?.delta === '好几段');
    expect(rows(recordedAt(midway)).map(brief).at(-1)).toBe('mu: PLAIN-REPLY-OK: 这是分成好几段');

    const written = findRecord(
      (record) => (record.assistantMessageEvent as { type?: string })?.type === 'toolcall_end'
    );
    expect(normalizeAcpToolCall(tool(rows(recordedAt(written))))).toMatchObject({
      name: 'write',
      status: 'pending',
      description: 'notes/hello.txt',
    });
    const running = findRecord((record) => record.type === 'tool_execution_start', written);
    expect(normalizeAcpToolCall(tool(rows(recordedAt(running))))?.status).toBe('running');
    const update = findRecord((record) => record.type === 'tool_execution_update');
    expect(normalizeAcpToolCall(tool(rows(recordedAt(update))))).toMatchObject({ name: 'bash', status: 'running' });
  });

  it('says the stopped command did not run, and the run was stopped, not failed', () => {
    const first = findRecord((record) => record.method === 'select');
    const asked = findRecord((record) => record.method === 'select', first + 1);
    const settled = findRecord((record) => record.type === 'agent_settled', asked);
    const list = rows(recordedAt(settled));
    expect(list.map(brief).slice(-2)).toEqual(['call bash error: Operation aborted', 'notice: stopped']);
    expect(list.some((row) => row.type === 'tips')).toBe(false);
  });
});

describe('rows written by hand', () => {
  it('shows a thought as live only while the model writes it', () => {
    const run: PiRecord[] = [
      { type: 'agent_start' },
      { type: 'message_start', message: reply([]) },
      delta({ type: 'thinking_start', contentIndex: 0 }),
      delta({ type: 'thinking_delta', contentIndex: 0, delta: 'Weighing it' }),
    ];
    const thinking = reduceAll(run);
    expect(rows(thinking).map(brief)).toEqual(['thinking (thinking): Weighing it']);
    const writing = reduceAll(
      [
        delta({ type: 'thinking_end', contentIndex: 0, content: 'Weighing it' }),
        delta({ type: 'text_start', contentIndex: 1 }),
      ],
      thinking
    );
    expect(rows(writing).map(brief)).toEqual(['thinking (done): Weighing it']);
    // A run stopped inside the block leaves no live thought behind.
    const stopped = reduceAll(
      [
        ended(reply([{ type: 'thinking', thinking: 'Weighing it' }], { stopReason: 'aborted' })),
        { type: 'agent_settled' },
      ],
      thinking
    );
    expect(rows(stopped).map(brief)).toEqual(['thinking (done): Weighing it', 'notice: stopped']);
  });

  it('ends a call the run left behind as failed, and leaves a live one running', () => {
    const calling: PiRecord[] = [
      { type: 'agent_start' },
      ended(user('go')),
      ended(reply([toolCall('c1', 'bash', { command: 'sleep 9' })], { stopReason: 'toolUse' })),
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'sleep 9' } },
    ];
    const running = reduceAll(calling);
    expect(normalizeAcpToolCall(tool(rows(running)))).toMatchObject({ status: 'running', description: 'sleep 9' });
    // mu's process closed mid-call: the run is over with no end for the call.
    const over = reduce(running, { type: 'agent_settled' });
    expect(normalizeAcpToolCall(tool(rows(over)))?.status).toBe('error');
  });

  it('says a failed request in the bridge’s words, which the tips row recognises, and a refused prompt too', () => {
    const failed = reduceAll([
      { type: 'agent_start' },
      ended(user('hi')),
      ended(reply([], { stopReason: 'error', errorMessage: '529 overloaded' })),
      { type: 'agent_settled' },
    ]);
    const list = rows(failed);
    expect(list.map(brief).at(-1)).toBe('error: Model request failed: 529 overloaded');
    const tip = list.at(-1);
    expect(tip?.type === 'tips' && findMuTurnError([tip.content.content])).toBe('modelFailed');

    const refused = reduce(emptyView(), {
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'No API key found for p.',
    });
    const refusedTip = rows(refused).at(-1);
    expect(refusedTip?.type === 'tips' && findMuTurnError([refusedTip.content.content])).toBe('noModel');
  });

  it('puts a reply that came after failed attempts after a line that says so', () => {
    const view = reduceAll([
      ended(user('hi'), 'u1'),
      ended(reply([], { stopReason: 'error', errorMessage: 'overloaded' }), 'a1'),
      { type: 'entry_appended', entry: { type: 'context_edit', id: 'e1', targetId: 'a1', replacement: null } },
      ended(reply([text('hello')]), 'a2'),
    ]);
    const list = rows(view);
    expect(list.map(brief)).toEqual(['person: hi', 'notice: info', 'mu: hello']);
    expect(muNotice(list[1])?.title).toBe('Retried 1×');
  });

  it('shows the message on its way while Jev classifies it, then the message itself with Jev’s line', () => {
    const outgoing = { id: 'outgoing-1', text: 'fix the test', at: 5 };
    const classifying = reduce(emptyView(), frame('preflight.pending', { judge: 'laya', mode: 'active' }, 1));
    const waiting = rows(classifying, { outgoing });
    expect(waiting.map(brief)).toEqual(['person: fix the test', 'jev: classifying']);
    expect(jevLine(waiting[1])).toEqual({ stage: 'classifying', judge: 'laya' });

    const verdict = { version: 1, by: 'laya', state: 'applied', turnType: 'single_edit', hintIds: [] as string[] };
    const taken = reduceAll(
      [
        frame('preflight.verdict', verdict, 1),
        { type: 'agent_start' },
        ended(user('fix the test', 6)),
        { type: 'entry_appended', entry: { type: 'custom', customType: 'kyrn.verdict', id: 'v1', data: verdict } },
      ],
      classifying
    );
    expect(rows(taken).map(brief)).toEqual(['person: fix the test', 'jev: classified']);
    expect(jevLine(rows(taken)[1])).toMatchObject({ stage: 'classified', turnType: 'single_edit', judge: 'laya' });
  });

  it('says once that bash is missing, instead of pi’s error', () => {
    const noBash = 'No bash shell found. Options: install Git for Windows';
    const view = reduceAll([
      ended(user('run it')),
      ended(reply([toolCall('c1', 'bash', { command: 'ls' })], { stopReason: 'toolUse' })),
      ended(toolResult('c1', noBash, true)),
      ended(reply([toolCall('c2', 'bash', { command: 'pwd' })], { stopReason: 'toolUse' })),
      ended(toolResult('c2', noBash, true)),
    ]);
    const list = rows(view);
    expect(list.map(brief)).toEqual([
      'person: run it',
      'call bash error: ',
      'notice: bash_missing',
      'call bash error: ',
    ]);
    expect(tool(list, 0).content.update.rawOutput).toEqual({ notice: 'bash_missing' });
  });

  it('shows what an extension shows the person, and nothing for an empty message', () => {
    const view = reduceAll([
      ended({ role: 'custom', customType: 'note', content: 'Saved a lesson', display: true, timestamp: 9 }),
      ended({ role: 'custom', customType: 'note', content: '  ', display: true, timestamp: 9 }),
    ]);
    expect(rows(view).map(brief)).toEqual(['mu: Saved a lesson']);
  });

  it('shows what mu told the model as a line of its own, never as a reply, with the words it sent', () => {
    const sent = 'You edited a.ts and nothing has run since. Verify the change.';
    const view = reduceAll([
      ended(user('fix it')),
      ended({ role: 'custom', customType: 'kyrn.nudge', content: sent, display: true, timestamp: 9 }),
      ended({
        role: 'custom',
        customType: 'kyrn.goal',
        content: [{ type: 'text', text: 'Keep going.' }],
        display: true,
        timestamp: 9,
      }),
      ended({ role: 'custom', customType: 'kyrn.steer', content: '  ', display: true, timestamp: 9 }),
    ]);
    const list = rows(view);
    expect(list.map(brief)).toEqual(['person: fix it', 'notice: to_model', 'notice: to_model']);
    expect(list.map((row) => muNotice(row))).toEqual([
      undefined,
      { code: 'to_model', title: sent, kind: 'kyrn.nudge', sent },
      { code: 'to_model', title: 'Keep going.', kind: 'kyrn.goal', sent: 'Keep going.' },
    ]);
  });

  it('says where the conversation was compacted, as a line of its own between the messages', () => {
    const view = reduceAll([
      ended(user('one')),
      ended(reply([{ type: 'text', text: 'first' }])),
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', result: { summary: 's', tokensBefore: 182_340 }, aborted: false },
      ended(user('two')),
    ]);
    // A notice of mu's own reads as the words it was given.
    expect(rows(view).map((row) => muNotice(row)?.title ?? brief(row))).toEqual([
      'person: one',
      'mu: first',
      'Compacted 182340',
      'person: two',
    ]);
    expect(rows(view).map((row) => muNotice(row)?.level)).toEqual([undefined, undefined, 'info', undefined]);
    // A compaction that was stopped left nothing to say.
    const stopped = reduceAll([
      ended(user('one')),
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', aborted: true },
    ]);
    expect(rows(stopped).map(brief)).toEqual(['person: one']);
  });

  it('gives an unchanged message the rows it gave before, and a streaming one new rows', () => {
    const map = createMessageMapper();
    const before = reduceAll([
      { type: 'agent_start' },
      ended(user('hi')),
      { type: 'message_start', message: reply([]) },
      delta({ type: 'text_delta', contentIndex: 0, delta: 'hel' }),
    ]);
    const after = reduce(before, delta({ type: 'text_delta', contentIndex: 0, delta: 'lo' }));
    const first = map(before, options);
    const second = map(after, options);
    expect(second[0]).toBe(first[0]);
    expect(second.at(-1)).not.toBe(first.at(-1));
    expect(brief(second.at(-1) as TMessage)).toBe('mu: hello');
    // Other words (another language) give new rows.
    expect(map(after, { ...options, words: { retried: () => '', compacted: () => '' } })[0]).not.toBe(second[0]);
  });
});
