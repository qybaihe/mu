import { describe, expect, it } from 'vitest';
import {
  durable,
  fromEntries,
  reduce,
  reduceAll,
  type NativeView,
  type PiRecord,
  type ViewMessage,
} from '@/common/utils/nativeHost/index.ts';

/**
 * The session entries a view's messages are saved as, and pi's retries: a failed attempt pi hides from the model
 * (`context_edit`, `replacement: null`) folds into the attempt after it, live and in the file alike. Nothing else a
 * context edit hides or replaces leaves the view.
 */

type Json = Record<string, unknown>;

const text = (value: string): Json => ({ type: 'text', text: value });
const user = (value: string): Json => ({ role: 'user', content: [text(value)], timestamp: 1 });
const reply = (value: string, extra: Json = {}): Json => ({
  role: 'assistant',
  content: value ? [text(value)] : [],
  provider: 'p',
  model: 'm',
  stopReason: 'stop',
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  timestamp: 2,
  ...extra,
});
const failed = (error: string): Json => reply('', { stopReason: 'error', errorMessage: error });

/** A session file: each entry the child of the one before. */
function file(entries: Json[]): Json[] {
  return entries.map((entry, index) => ({ ...entry, parentId: index ? entries[index - 1].id : null }));
}
const message = (id: string, value: Json): Json => ({ type: 'message', id, message: value, timestamp: 'x' });
const omit = (id: string, targetId: string): Json => ({ type: 'context_edit', id, targetId, replacement: null });
const compaction = (id: string, tokensBefore: number): Json => ({
  type: 'compaction',
  id,
  summary: 'what came before',
  firstKeptEntryId: 'u2',
  tokensBefore,
  timestamp: 'x',
});

/** The records of a live run: a message pi saved as `entryId`, the entry of an edit. */
const ended = (value: Json, entryId?: string): PiRecord => ({
  type: 'message_end',
  message: value,
  ...(entryId ? { entryId } : {}),
});
const appended = (entry: Json): PiRecord => ({ type: 'entry_appended', entry });

/** A view's messages without the entries they are saved as: what an older harness gives. */
const unsaved = (messages: readonly ViewMessage[]): ViewMessage[] =>
  messages.map(({ entryId: _entryId, ...rest }) => rest as ViewMessage);

describe('the entry a message is saved as', () => {
  const live: PiRecord[] = [
    { type: 'agent_start' },
    ended(user('hi'), 'u1'),
    { type: 'message_start', message: reply('') },
    ended(reply('hello'), 'a1'),
    { type: 'agent_settled' },
  ];

  it('comes from message_end live and from the entry in a file, the same way', () => {
    const view = reduceAll(live);
    expect(view.messages.map((each) => [each.id, each.entryId])).toEqual([
      ['m1', 'u1'],
      ['m2', 'a1'],
    ]);
    expect(durable(view)).toStrictEqual(fromEntries(file([message('u1', user('hi')), message('a1', reply('hello'))])));
  });

  it('is left out for a harness that does not send it, and nothing else changes', () => {
    const older = live.map(({ entryId: _entryId, ...record }) => record as PiRecord);
    const view = reduceAll(older);
    expect(view.messages.some((each) => 'entryId' in each)).toBe(false);
    expect(view.messages).toEqual(unsaved(reduceAll(live).messages));
    expect(view.status).toBe('settled');
  });

  it('keeps the token counts of a complete reply, not of one that streams', () => {
    const streaming = reduceAll(live.slice(0, 3));
    expect(streaming.messages.at(-1)).not.toHaveProperty('usage');
    expect(reduceAll(live).messages.at(-1)).toMatchObject({
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
  });
});

describe('a failed attempt pi retries', () => {
  const retried: PiRecord[] = [
    { type: 'agent_start' },
    ended(user('hi'), 'u1'),
    { type: 'message_start', message: reply('') },
    ended(failed('overloaded'), 'a1'),
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'overloaded' },
    appended(omit('e1', 'a1')),
    { type: 'message_start', message: reply('') },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hel' } },
    ended(reply('hello'), 'a2'),
    { type: 'auto_retry_end', success: true, attempt: 1 },
    { type: 'agent_settled' },
  ];
  const saved = file([
    message('u1', user('hi')),
    message('a1', failed('overloaded')),
    omit('e1', 'a1'),
    message('a2', reply('hello')),
  ]);

  it('is shown while pi waits to try again, then folds into the attempt that follows', () => {
    const waiting = reduceAll(retried.slice(0, 6));
    expect(waiting.status).toBe('working');
    expect(waiting.live.retry).toEqual({ attempt: 1, maxAttempts: 3, delayMs: 2000, error: 'overloaded' });
    expect(waiting.messages.at(-1)).toMatchObject({ id: 'm2', entryId: 'a1', stopReason: 'error', retried: true });

    const streaming = reduceAll(retried.slice(0, 8));
    expect(streaming.messages).toHaveLength(2);
    expect(streaming.messages.at(-1)).toMatchObject({ id: 'm2', streaming: true, retries: 1, blocks: [text('hel')] });
    expect(streaming.messages.at(-1)).not.toHaveProperty('retried');

    const view = reduceAll(retried);
    expect(view.status).toBe('settled');
    expect(view.live).toEqual({ compacting: false });
    expect(view.messages).toEqual([
      { id: 'm1', role: 'user', entryId: 'u1', text: 'hi', images: [], timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        entryId: 'a2',
        blocks: [text('hello')],
        timestamp: 2,
        model: 'p/m',
        stopReason: 'stop',
        streaming: false,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        retries: 1,
      },
    ]);
  });

  it('folds the same way from the session file', () => {
    expect(fromEntries(saved)).toStrictEqual(durable(reduceAll(retried)));
  });

  it('counts every attempt pi retried, and a final failure it did not retry shows as the run’s end', () => {
    const exhausted = file([
      message('u1', user('hi')),
      message('a1', failed('overloaded')),
      omit('e1', 'a1'),
      message('a2', failed('overloaded')),
      omit('e2', 'a2'),
      message('a3', failed('still overloaded')),
    ]);
    const view = fromEntries(exhausted);
    expect(view.messages.map((each) => [each.id, each.entryId])).toEqual([
      ['m1', 'u1'],
      ['m2', 'a3'],
    ]);
    expect(view.messages[1]).toMatchObject({ retries: 2, stopReason: 'error', errorMessage: 'still overloaded' });
    expect(view.status).toBe('error');
    expect(view.error).toBe('still overloaded');
  });

  it('ends the run with the attempt’s error when no attempt follows it', () => {
    const stopped = reduceAll([
      ...retried.slice(0, 6),
      { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'Retry cancelled' },
      { type: 'agent_settled' },
    ]);
    expect(stopped.messages.at(-1)).toMatchObject({ id: 'm2', retried: true });
    expect(stopped.status).toBe('error');
    expect(stopped.error).toBe('overloaded');
    expect(stopped.live.retry).toBeUndefined();
    expect(fromEntries(saved.slice(0, 3))).toStrictEqual(durable(stopped));
  });

  it('leaves messages an extension added between the attempts where they are, and gives no id twice', () => {
    const note = { role: 'custom', customType: 'kyrn.note', content: 'Noted', display: true, timestamp: 3 };
    const view = reduceAll([
      ended(user('hi'), 'u1'),
      ended(failed('overloaded'), 'a1'),
      ended(note, 'c1'),
      appended(omit('e1', 'a1')),
      ended(reply('hello'), 'a2'),
      ended(user('again'), 'u2'),
    ]);
    expect(view.messages.map((each) => [each.id, each.role, each.entryId])).toEqual([
      ['m1', 'user', 'u1'],
      ['m3', 'custom', 'c1'],
      ['m2', 'assistant', 'a2'],
      ['m4', 'user', 'u2'],
    ]);
  });

  it('is shown as it was without the entry ids that name it', () => {
    const older = retried.map(({ entryId: _entryId, ...record }) => record as PiRecord);
    const view = reduceAll(older);
    expect(view.messages.map((each) => (each.role === 'assistant' ? each.stopReason : each.role))).toEqual([
      'user',
      'error',
      'stop',
    ]);
    expect(view.messages.some((each) => each.role === 'assistant' && (each.retried || each.retries))).toBe(false);
    expect(view.status).toBe('settled');
  });
});

describe('any other context edit', () => {
  const base: NativeView = reduceAll([
    ended(user('hi'), 'u1'),
    ended(reply('hello'), 'a1'),
    ended(reply('', { stopReason: 'length' }), 'a2'),
    ended(failed('overloaded'), 'a3'),
  ]);

  it('changes nothing the person sees', () => {
    for (const entry of [
      omit('e1', 'u1'),
      omit('e2', 'a1'),
      // An overflow recovery hides a reply cut at the length limit: it stays, only an error is a retried attempt.
      omit('e3', 'a2'),
      { type: 'context_edit', id: 'e4', targetId: 'a3', replacement: { content: [text('shorter')] } },
      omit('e5', 'nowhere'),
      { type: 'context_edit', id: 'e6', replacement: null },
    ])
      expect(reduce(base, appended(entry))).toBe(base);
  });

  it('is read from a file the same way', () => {
    const view = fromEntries(
      file([
        message('u1', user('hi')),
        omit('e1', 'u1'),
        message('a1', reply('hello')),
        { type: 'context_edit', id: 'e2', targetId: 'a1', replacement: { content: [text('shorter')] } },
      ])
    );
    expect(view.messages.map((each) => each.entryId)).toEqual(['u1', 'a1']);
    expect(view.messages[1]).toMatchObject({ blocks: [text('hello')] });
  });
});

describe('where pi compacted the conversation', () => {
  const saved = file([
    message('u1', user('one')),
    message('a1', reply('first')),
    compaction('c1', 182_340),
    message('u2', user('two')),
  ]);
  /** A run's records up to a compaction that ends as `end` says, and the next message after it. */
  const live = (end: PiRecord): PiRecord[] => [
    { type: 'agent_start' },
    ended(user('one'), 'u1'),
    { type: 'message_start', message: reply('') },
    ended(reply('first'), 'a1'),
    { type: 'agent_settled' },
    { type: 'compaction_start', reason: 'threshold' },
    end,
    ended(user('two'), 'u2'),
  ];

  it('is a line of its own in the file, between the messages it falls between', () => {
    const view = fromEntries(saved);
    expect(view.messages.map((each) => each.role)).toEqual(['user', 'assistant', 'compaction', 'user']);
    expect(view.messages[2]).toEqual({ id: 'm3', role: 'compaction', tokensBefore: 182_340 });
  });

  it('is the same line live, at the end of a compaction that has a result', () => {
    const view = reduceAll(
      live({
        type: 'compaction_end',
        reason: 'threshold',
        result: { summary: 'what came before', firstKeptEntryId: 'u2', tokensBefore: 182_340 },
        aborted: false,
        willRetry: false,
      })
    );
    expect(durable(view)).toStrictEqual(fromEntries(saved));
  });

  it('is left out live when the compaction was stopped or failed: nothing was saved', () => {
    const stopped = reduceAll(live({ type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false }));
    const failedEnd = reduceAll(
      live({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, errorMessage: 'boom' })
    );
    for (const view of [stopped, failedEnd])
      expect(view.messages.map((each) => each.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('does not keep a retry from folding into the failed attempt it follows', () => {
    const records: PiRecord[] = [
      { type: 'agent_start' },
      ended(user('one'), 'u1'),
      { type: 'message_start', message: reply('') },
      ended(failed('overloaded'), 'a1'),
      appended(omit('e1', 'a1')),
      { type: 'compaction_start', reason: 'overflow' },
      {
        type: 'compaction_end',
        reason: 'overflow',
        result: { summary: 's', firstKeptEntryId: 'u1', tokensBefore: 90_000 },
        aborted: false,
        willRetry: true,
      },
      { type: 'message_start', message: reply('') },
      ended(reply('hello'), 'a2'),
      { type: 'agent_settled' },
    ];
    const compacted: Json = {
      type: 'compaction',
      id: 'c1',
      summary: 's',
      firstKeptEntryId: 'u1',
      tokensBefore: 90_000,
    };
    const inFile = file([
      message('u1', user('one')),
      message('a1', failed('overloaded')),
      omit('e1', 'a1'),
      compacted,
      message('a2', reply('hello')),
    ]);
    const view = reduceAll(records);
    expect(view.messages.map((each) => each.role)).toEqual(['user', 'compaction', 'assistant']);
    expect(view.messages[2]).toMatchObject({ id: 'm2', retries: 1, entryId: 'a2' });
    expect(durable(view)).toStrictEqual(fromEntries(inFile));
  });

  it('says 0 tokens for an entry that does not say how many it condensed', () => {
    const view = fromEntries(file([message('u1', user('one')), { type: 'compaction', id: 'c1', summary: 's' }]));
    expect(view.messages.at(-1)).toEqual({ id: 'm2', role: 'compaction', tokensBefore: 0 });
  });
});
