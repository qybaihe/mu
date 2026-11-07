import type { Activity } from '@/common/kyrn/types';
import type { IMessageAcpToolCall } from '@/common/chat/chatLib';

export const hiveSnapshot = {
  kind: 'hive',
  title: 'Investigate cache behavior',
  startedAt: 1000,
  now: 8000,
  bees: [
    {
      name: 'prefix-mutations',
      status: 'tool',
      role: 'investigator',
      model: 'test-model',
      thinking: 'high',
      turns: 3,
      toolCalls: 6,
      published: 1,
      received: 0,
      tool: { name: 'read', summary: 'read src/cache.ts' },
    },
    {
      name: 'provider-cache',
      status: 'done',
      role: 'investigator',
      model: 'test-model',
      thinking: 'medium',
      turns: 2,
      toolCalls: 4,
      published: 0,
      received: 1,
    },
  ],
};

/** A tool call's output as the relay (the backend) streams and stores it: every key snake_cased, at every depth. */
export function relayed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relayed);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      relayed(item),
    ])
  );
}

export function activity(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  run = 'run-1',
  bee?: string
): Activity {
  return { id, at: 10000, kind, payload, run, bee };
}

export const hiveEvents: Activity[] = [
  activity('manifest', 'hive.manifest', {
    goal: 'Investigate cache behavior',
    bees: [
      { name: 'prefix-mutations', focus: 'Inspect changing request prefixes' },
      { name: 'provider-cache', focus: 'Inspect provider mapping' },
    ],
  }),
  activity('snapshot', 'swarm.snapshot', hiveSnapshot),
  activity('note', 'hive.note', {
    id: 'note-1',
    bee: 'prefix-mutations',
    kind: 'finding',
    text: 'Prefix remains stable after the first request.',
  }),
  activity('gate', 'hive.gate', { from: 'prefix-mutations', to: 'provider-cache', deliver: true }),
  activity('delivery', 'hive.delivery', { note: 'note-1', to: 'provider-cache' }),
  activity('note-2', 'hive.note', {
    id: 'note-2',
    bee: 'provider-cache',
    kind: 'finding',
    text: 'The prefix changes once the provider swaps its cache key.',
  }),
  // The judge read the second note as replacing the first: a correction, drawn from its author to the first's.
  activity('relation', 'hive.relation', {
    later: 'note-2',
    earlier: 'note-1',
    relation: 'supersedes',
    score: 0.9,
    by: 'provider-cache',
    at: '2026-09-23T00:00:00.000Z',
  }),
  activity(
    'tool-start',
    'bee.event',
    { type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'src/cache.ts' } },
    'run-1',
    'prefix-mutations'
  ),
  activity(
    'tool-end',
    'bee.event',
    {
      type: 'tool_execution_end',
      toolCallId: 'read-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'export const stablePrefix = true;' }] },
    },
    'run-1',
    'prefix-mutations'
  ),
  activity(
    'message',
    'bee.event',
    {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Confirmed stable prefix.' }] },
    },
    'run-1',
    'provider-cache'
  ),
];

export function hiveMessage(): IMessageAcpToolCall {
  return {
    id: 'message-1',
    conversation_id: 'conversation-1',
    type: 'acp_tool_call',
    content: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        tool_call_id: 'run-1',
        status: 'in_progress',
        title: 'hive',
        kind: 'execute',
        rawInput: {
          goal: 'Investigate cache behavior',
          bees: [{ name: 'prefix-mutations', focus: 'Inspect changing request prefixes' }],
        },
        rawOutput: { details: { snapshot: hiveSnapshot } },
        content: [
          { type: 'content', content: { type: 'text', text: '\u001b[32mOriginal terminal evidence\u001b[0m' } },
        ],
      },
    },
  };
}
