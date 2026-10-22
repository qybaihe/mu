import { describe, expect, it } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import { questionsBeforeCalls } from '@/renderer/pages/conversation/Messages/permissionOrder';

// mu asks about a call once the call has started, so the card came after the call's row: the refused call's outcome
// read above the question that led to it. The card goes right before the call it asks about.

const said = (id: string, created: number): TMessage =>
  ({ id, type: 'text', position: 'right', created_at: created, content: { content: 'do it' } }) as unknown as TMessage;

const call = (id: string, command: string, created: number): TMessage =>
  ({
    id,
    type: 'acp_tool_call',
    position: 'left',
    created_at: created,
    content: { update: { tool_call_id: id, title: 'bash', raw_input: { command } } },
  }) as unknown as TMessage;

/** mu's card as the backend relays it: its codes under `raw_input.mu`, snake-cased or not. */
const card = (id: string, command: string, created: number, mu: Record<string, string>): TMessage =>
  ({
    id,
    type: 'acp_permission',
    position: 'left',
    created_at: created,
    content: { tool_call: { tool_call_id: `permission:${id}`, raw_input: { command, mu } } },
  }) as unknown as TMessage;

const ids = (list: TMessage[]) => list.map((message) => message.id);

describe('mu’s question in the conversation', () => {
  it('goes right before the call it names, at the call’s time', () => {
    const list = [
      said('m1', 1),
      call('call-1', 'ls', 2),
      call('call-2', 'rm -rf build', 3),
      card('q1', 'rm -rf build', 4, { kind: 'shell', toolCallId: 'call-2' }),
    ];
    const ordered = questionsBeforeCalls(list);
    expect(ids(ordered)).toEqual(['m1', 'call-1', 'q1', 'call-2']);
    expect(ordered[2].created_at).toBe(3);
  });

  it('finds the call by its snake-cased id, and by the command it ran when the card names no call', () => {
    const snake = [call('call-2', 'rm -rf build', 3), card('q1', 'rm -rf build', 4, { tool_call_id: 'call-2' })];
    expect(ids(questionsBeforeCalls(snake))).toEqual(['q1', 'call-2']);
    // A card from before mu named the call: the call of the same turn that ran exactly that command.
    const older = [call('call-1', 'ls', 2), call('call-2', 'rm -rf build', 3), card('q1', 'rm -rf build', 4, {})];
    expect(ids(questionsBeforeCalls(older))).toEqual(['call-1', 'q1', 'call-2']);
  });

  it('never moves a question past the person’s message, or one that names another turn’s call', () => {
    const list = [
      call('call-2', 'rm -rf build', 1),
      said('m2', 2),
      card('q1', 'rm -rf build', 3, {}),
      card('q2', 'rm -rf build', 4, { toolCallId: 'call-2' }),
    ];
    expect(questionsBeforeCalls(list)).toBe(list);
  });

  it('leaves another agent’s card, and a list without mu’s questions, as they were', () => {
    const other = {
      id: 'q1',
      type: 'acp_permission',
      created_at: 4,
      content: { tool_call: { raw_input: { command: 'rm -rf build' } } },
    } as unknown as TMessage;
    const list = [call('call-2', 'rm -rf build', 3), other];
    expect(questionsBeforeCalls(list)).toBe(list);
  });

  it('puts two questions about one call before it in the order they came', () => {
    const list = [
      call('call-2', 'git push --force', 3),
      card('q1', 'git push --force', 4, { toolCallId: 'call-2' }),
      card('q2', 'git push --force', 5, { toolCallId: 'call-2' }),
    ];
    expect(ids(questionsBeforeCalls(list))).toEqual(['q1', 'q2', 'call-2']);
  });
});
