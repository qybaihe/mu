/**
 * Replays the frames of a mu turn in 最小权限 (minimal permission) mode, as the conversation E2E test recorded them:
 * every frame of the turn shares one msg_id, and the permission card (`acp_permission`) arrives between the tool call
 * it asks about and that call's result.
 *
 * Before the fix the card went through the generic msg_id arm of `composeMessageWithIndex`, found whatever frame was
 * indexed last under the shared msg_id and overwrote it: the `write` row (or the judge's line) turned into the card. The
 * call's result then found no row, was added as a row with no name, and the tool row's icon threw on the missing name:
 * the whole conversation page fell to the error screen right after 允许 (Allow).
 */

import { describe, expect, it } from 'vitest';
import type { IMessageAcpToolCall, TMessage } from '@/common/chat/chatLib';
import { transformMessage } from '@/common/chat/chatLib';
import { normalizeToolMessages } from '@/common/chat/normalizeToolCall';
import { buildMessageIndex, composeMessageWithIndex } from '@/renderer/pages/conversation/Messages/hooks';

const MSG_ID = 'abdbca15';
const PREFLIGHT = 'jev:5a367a6d-1ea9-49ae-92be-37f3f8ee18d4:3';

const frame = (type: string, data: unknown): TMessage => {
  const message = transformMessage({ type, conversation_id: 'conv-1', msg_id: MSG_ID, data } as never);
  if (!message) throw new Error(`no message for ${type}`);
  return message;
};

const toolCall = (update: Record<string, unknown>): TMessage =>
  frame('acp_tool_call', { session_id: 'session-1', update });

const preflightPending = toolCall({
  session_update: 'tool_call',
  tool_call_id: PREFLIGHT,
  status: 'in_progress',
  title: 'Jev · Classifying',
  kind: 'execute',
});
const preflightVerdict = toolCall({
  session_update: 'tool_call_update',
  tool_call_id: PREFLIGHT,
  status: 'completed',
  title: 'Jev · unknown',
  raw_output: { state: 'none', turn_type: 'unknown', reason_code: 'off', preflight: 'verdict' },
});

const permission = (id: string, command: string): TMessage =>
  frame('acp_permission', {
    session_id: 'session-1',
    tool_call: {
      tool_call_id: id,
      title: 'mu 想改文件，需要你授权',
      kind: 'edit',
      raw_input: { command, description: '最小权限模式：每一步都先问你。', mu: { kind: 'edit', reason: 'ask' } },
    },
    options: [
      { option_id: 'mu:once', name: '允许这一次', kind: 'allow_once' },
      { option_id: 'mu:deny', name: '不允许', kind: 'reject_once' },
    ],
  });

const replay = (frames: TMessage[]): TMessage[] => {
  let list: TMessage[] = [];
  for (const message of frames) list = composeMessageWithIndex(message, list, buildMessageIndex(list));
  return list;
};

const toolRows = (list: TMessage[]) =>
  normalizeToolMessages(list.filter((message): message is IMessageAcpToolCall => message.type === 'acp_tool_call'));

describe('permission card live merge', () => {
  it('keeps the row of the call it asks about, and the call settles in that row (write, 允许)', () => {
    const list = replay([
      preflightPending,
      preflightVerdict,
      toolCall({
        session_update: 'tool_call',
        tool_call_id: 'call_e2e_4',
        status: 'in_progress',
        title: 'write',
        kind: 'edit',
        raw_input: { path: 'notes/second.txt', content: 'Written by the fake model.\n' },
      }),
      permission('permission:e1708773', 'write notes/second.txt'),
      // The call's result names no tool: it settles the row the call opened.
      toolCall({
        session_update: 'tool_call_update',
        tool_call_id: 'call_e2e_4',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Successfully wrote to notes/second.txt' } }],
      }),
    ]);

    expect(list.filter((message) => message.type === 'acp_permission')).toHaveLength(1);
    const rows = toolRows(list);
    expect(rows.map((row) => [row.key, row.name, row.status])).toEqual([
      [PREFLIGHT, 'Jev · unknown', 'completed'],
      ['call_e2e_4', 'write', 'completed'],
    ]);
  });

  it('keeps the judge’s line when the card comes before the call (bash, 不允许)', () => {
    const list = replay([
      preflightPending,
      preflightVerdict,
      permission('permission:ec3afaa2', 'echo hi > bash-out.txt'),
      toolCall({
        session_update: 'tool_call',
        tool_call_id: 'call_e2e_6',
        status: 'in_progress',
        title: 'bash',
        kind: 'execute',
        raw_input: { command: 'echo hi > bash-out.txt' },
      }),
      toolCall({ session_update: 'tool_call_update', tool_call_id: 'call_e2e_6', status: 'failed' }),
    ]);

    expect(list.filter((message) => message.type === 'acp_permission')).toHaveLength(1);
    expect(toolRows(list).map((row) => [row.key, row.name, row.status])).toEqual([
      [PREFLIGHT, 'Jev · unknown', 'completed'],
      ['call_e2e_6', 'bash', 'error'],
    ]);
  });

  it('shows one card for a question sent again, and one card per question', () => {
    const list = replay([
      preflightPending,
      permission('permission:a', 'write a.txt'),
      preflightVerdict,
      permission('permission:a', 'write a.txt'),
      permission('permission:b', 'write b.txt'),
    ]);

    const cards = list.filter((message) => message.type === 'acp_permission');
    expect(
      cards.map((card) => (card.content as { tool_call: { tool_call_id: string } }).tool_call.tool_call_id)
    ).toEqual(['permission:a', 'permission:b']);
    expect(toolRows(list).map((row) => row.name)).toEqual(['Jev · unknown']);
  });
});
