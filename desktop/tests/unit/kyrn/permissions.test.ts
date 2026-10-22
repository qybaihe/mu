import { describe, expect, it } from 'vitest';
import {
  answerIndex,
  answerKind,
  answerOptionId,
  asks,
  isModeId,
  modeOption,
  permissionCall,
  presentation,
  readModes,
  readRequest,
  readResolved,
} from '../../../packages/desktop/src/process/agent/kyrn/permissions.ts';

/*
 * What the adapter reads of mu's permission events, and what it sends back. The happy paths run through the adapter
 * (adapter.test.ts); these are the edges: whatever a mode id, an answer id or a code is, only a word gets through,
 * because a mode id is sent to mu as part of a command and a code becomes part of the card's wording.
 */

const frame = (kind: string, payload: unknown) => ({
  type: 'extension_ui_request',
  method: 'setStatus',
  statusKey: 'kyrn.presentation.v1',
  statusText: JSON.stringify({ kind, payload }),
});

describe('mu presentation events', () => {
  it('reads a frame on mu’s status channel, and nothing else', () => {
    expect(presentation(frame('permissions.mode', { mode: 'full' }))).toEqual({
      kind: 'permissions.mode',
      payload: { mode: 'full' },
    });
    expect(presentation({ ...frame('x', {}), statusKey: 'other' })).toBeUndefined();
    expect(presentation({ ...frame('x', {}), method: 'notify' })).toBeUndefined();
    expect(presentation({ ...frame('x', {}), statusText: '{not json' })).toBeUndefined();
    expect(presentation({ ...frame('x', {}), statusText: JSON.stringify({ payload: {} }) })).toBeUndefined();
  });
});

describe('permission modes', () => {
  const modes = [
    { id: 'full', label: 'Full access', description: 'Everything runs' },
    { id: 'judge', label: 'Judge mode', description: '' },
    { id: 'ask', label: '', description: 'Asks first' },
  ];

  it('takes the modes mu offers, with the current one among them', () => {
    expect(readModes({ mode: 'judge', modes, conversationSwitch: true })).toEqual({
      mode: 'judge',
      modes: [modes[0], modes[1], { id: 'ask', label: 'ask', description: 'Asks first' }],
      conversationSwitch: true,
    });
    // An older mu does not say it can switch one conversation, and gets the plain command.
    expect(readModes({ mode: 'full', modes })?.conversationSwitch).toBe(false);
    expect(readModes({ mode: 'full', modes, conversationSwitch: 'yes' })?.conversationSwitch).toBe(false);
  });

  it('drops a mode whose id could be more than a word, and a current mode that is not offered', () => {
    const hostile = [
      ...modes,
      { id: 'full --here; /exit', label: 'x' },
      { id: 'Full', label: 'y' },
      { id: '', label: 'z' },
    ];
    expect(readModes({ mode: 'full', modes: hostile })?.modes.map((mode) => mode.id)).toEqual(['full', 'judge', 'ask']);
    expect(readModes({ mode: 'full --here; /exit', modes: hostile })).toBeUndefined();
    expect(readModes({ mode: 'none', modes })).toBeUndefined();
    expect(readModes({ mode: 'full', modes: 'full' })).toBeUndefined();
  });

  it('sends only a word to mu as a mode', () => {
    for (const id of ['full', 'judge', 'ask', 'read-only', 'a1']) expect(isModeId(id)).toBe(true);
    for (const id of ['', 'Full', '1full', 'full ask', 'full\n/exit', '-x', 'a'.repeat(33)])
      expect(isModeId(id)).toBe(false);
  });

  it('offers the modes as the send box’s permission picker', () => {
    const option = modeOption({ mode: 'judge', modes, conversationSwitch: true });
    expect(option).toMatchObject({ id: 'mode', category: 'mode', type: 'select', currentValue: 'judge' });
    expect(option.type === 'select' && option.options).toEqual([
      { value: 'full', name: 'Full access', description: 'Everything runs' },
      { value: 'judge', name: 'Judge mode' },
      { value: 'ask', name: '', description: 'Asks first' },
    ]);
  });
});

describe('permission requests', () => {
  const request = {
    kind: 'shell',
    summary: 'git push --force',
    answers: ['允许一次', '本次对话都允许', '不允许'],
    answerIds: ['once', 'session', 'deny'],
    reason: 'flagged',
    flagCode: 'force_push',
    grant: { label: 'git push' },
  };

  it('reads what mu is about to ask, with its codes', () => {
    expect(readRequest(request)).toEqual({
      kind: 'shell',
      summary: 'git push --force',
      answers: request.answers,
      answerIds: ['once', 'session', 'deny'],
      reason: 'flagged',
      flagCode: 'force_push',
      grantLabel: 'git push',
    });
  });

  it('needs at least two answers, none of them empty', () => {
    expect(readRequest({ ...request, answers: ['允许一次'] })).toBeUndefined();
    expect(readRequest({ ...request, answers: ['允许一次', ''] })).toBeUndefined();
    expect(readRequest({ ...request, answers: 'yes/no' })).toBeUndefined();
  });

  it('takes answer ids only as a full, distinct set of words in the answers’ order', () => {
    for (const answerIds of [['once', 'deny'], ['once', 'once', 'deny'], ['once', 'Session', 'deny'], 'once']) {
      expect(readRequest({ ...request, answerIds })).not.toHaveProperty('answerIds');
    }
  });

  it('passes on a code only when it is a word, never a sentence', () => {
    const read = readRequest({ ...request, reason: 'because I said so', flagCode: 'FORCE_PUSH', grant: 'git' });
    expect(read).not.toHaveProperty('reason');
    expect(read).not.toHaveProperty('flagCode');
    expect(read).not.toHaveProperty('grantLabel');
  });

  it('takes the call it asks about as the provider named it, when it is one short line', () => {
    expect(readRequest({ ...request, toolCallId: 'toolu_01A:bash/2' })).toMatchObject({
      toolCallId: 'toolu_01A:bash/2',
    });
    for (const toolCallId of ['', 'call\n2', 'x'.repeat(257), 7]) {
      expect(readRequest({ ...request, toolCallId })).not.toHaveProperty('toolCallId');
    }
    // The card carries it with the other codes, for the conversation to show the card above that call.
    expect(permissionCall(readRequest({ ...request, toolCallId: 'call-7' })!, 't').rawInput).toMatchObject({
      mu: { toolCallId: 'call-7' },
    });
  });

  it('reads the reasons a judge that cannot answer gives as codes', () => {
    expect(readRequest({ ...request, reason: 'nojudge' })).toMatchObject({ reason: 'nojudge' });
    expect(readRequest({ ...request, reason: 'judgedown' })).toMatchObject({ reason: 'judgedown' });
  });

  it('matches a picker to the request only when it offers the same answers in the same order', () => {
    const read = readRequest(request)!;
    expect(asks(read, ['允许一次', '本次对话都允许', '不允许'])).toBe(true);
    expect(asks(read, ['允许一次', '不允许'])).toBe(false);
    expect(asks(read, ['不允许', '本次对话都允许', '允许一次'])).toBe(false);
  });

  it('shows the call on a card: what mu wants to do as the title, why under it, the call where a command goes', () => {
    const read = readRequest(request)!;
    const call = permissionCall(read, 'mu 想运行命令\ngit push --force\n这条命令会改写远程历史');
    expect(call).toMatchObject({
      title: 'mu 想运行命令',
      kind: 'execute',
      rawInput: {
        command: 'git push --force',
        description: '这条命令会改写远程历史',
        mu: { kind: 'shell', reason: 'flagged', flagCode: 'force_push', grantLabel: 'git push' },
      },
    });
    // A title of two lines has no reason line; an empty one falls back to the call.
    expect(permissionCall(read, 'mu 想运行命令\ngit push --force').rawInput).not.toHaveProperty('description');
    expect(permissionCall(read, '').title).toBe('git push --force');
    expect(permissionCall({ ...read, kind: 'delegate' }, 't').kind).toBe('other');
    expect(permissionCall({ ...read, kind: 'outside' }, 't').kind).toBe('edit');
  });
});

describe('an answered question', () => {
  it('says the answer by its id and the call it was about', () => {
    expect(readResolved({ id: 'permission-1', toolCallId: 'call-7', answer: 'deny' })).toEqual({
      answer: 'deny',
      toolCallId: 'call-7',
    });
    // A mu from before the call was named, and words where an id belongs.
    expect(readResolved({ id: 'permission-1', answer: 'once' })).toEqual({ answer: 'once' });
    expect(readResolved({ answer: 'Don’t allow', toolCallId: 'call\n7' })).toEqual({});
  });
});

describe('answers', () => {
  const withIds = readRequest({
    kind: 'edit',
    summary: 'edit a.ts',
    answers: ['a', 'b', 'c'],
    answerIds: ['once', 'session', 'deny'],
  });
  const withoutIds = readRequest({ kind: 'edit', summary: 'edit a.ts', answers: ['a', 'b'] });

  it('are once, then for this conversation, then don’t allow', () => {
    expect([0, 1, 2].map((index) => answerKind(index, 3))).toEqual(['allow_once', 'allow_always', 'reject_once']);
    expect([0, 1].map((index) => answerKind(index, 2))).toEqual(['allow_once', 'reject_once']);
  });

  it('go by their ids when mu sent ids, else by position, and never by the other one', () => {
    expect([0, 1, 2].map((index) => answerOptionId(withIds, index))).toEqual(['mu:once', 'mu:session', 'mu:deny']);
    expect([0, 1].map((index) => answerOptionId(withoutIds, index))).toEqual(['0', '1']);

    expect(answerIndex(withIds, 'mu:deny', 3)).toBe(2);
    expect(answerIndex(withIds, 'mu:always', 3)).toBe(-1);
    expect(answerIndex(withIds, '0', 3)).toBe(-1);

    expect(answerIndex(withoutIds, '1', 2)).toBe(1);
    expect(answerIndex(withoutIds, 'mu:once', 2)).toBe(-1);
    expect(answerIndex(undefined, '0', 2)).toBe(0);
  });

  it('never read a malformed option id as the first answer, which allows', () => {
    // Number('') and Number(' ') are 0: an empty id once answered "allow once" to a mu that sent no ids.
    for (const optionId of ['', ' ', '2', '-1', '1.5', '01', '1e0', '0x0', ' 1', 'allow']) {
      expect(answerIndex(withoutIds, optionId, 2)).toBe(-1);
    }
  });
});
