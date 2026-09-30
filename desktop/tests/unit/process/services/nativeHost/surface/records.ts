import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRESENTATION_STATUS_KEY, reduceAll, type NativeView, type PiRecord } from '@/common/utils/nativeHost';

/** The conversation recorded from a real host (../fixtures/record.mjs), and records written by hand for the rest. */

const lines = (name: string): PiRecord[] =>
  readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PiRecord);

export const recorded = lines('conversation.records.jsonl');
export const recordedSession = lines('conversation.session.jsonl');

/** The view after the recorded record at `index`. */
export const recordedAt = (index: number): NativeView => reduceAll(recorded.slice(0, index + 1));

/** The index of the first recorded record from `from` on that `test` accepts. */
export function findRecord(test: (record: PiRecord) => boolean, from = 0): number {
  const index = recorded.findIndex((record, at) => at >= from && test(record));
  if (index < 0) throw new Error('No such record in the fixture');
  return index;
}

type Json = Record<string, unknown>;

export const text = (value: string): Json => ({ type: 'text', text: value });
export const user = (value: string, timestamp = 1): Json => ({ role: 'user', content: [text(value)], timestamp });
export const reply = (content: Json[], extra: Json = {}): Json => ({
  role: 'assistant',
  content,
  provider: 'p',
  model: 'm',
  stopReason: 'stop',
  timestamp: 2,
  ...extra,
});
export const toolCall = (id: string, name: string, args: Json): Json => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
export const toolResult = (toolCallId: string, value: string, isError = false, extra: Json = {}): Json => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'bash',
  content: [text(value)],
  isError,
  timestamp: 3,
  ...extra,
});
export const ended = (message: Json, entryId?: string): PiRecord => ({
  type: 'message_end',
  message,
  ...(entryId ? { entryId } : {}),
});
export const delta = (event: Json): PiRecord => ({ type: 'message_update', assistantMessageEvent: event });

let sequence = 0;
/** A presentation frame of the judgment layer, as pi sends it. */
export const frame = (kind: string, payload: Json, turnId = 1, at = 100): PiRecord => {
  sequence += 1;
  return {
    type: 'extension_ui_request',
    id: `frame-${sequence}`,
    method: 'setStatus',
    statusKey: PRESENTATION_STATUS_KEY,
    statusText: JSON.stringify({ version: 1, sequence, at, runtimeId: 'runtime', turnId, kind, payload }),
  };
};
