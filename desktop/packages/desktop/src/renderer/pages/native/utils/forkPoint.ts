/**
 * Where a message's fork button goes, in pi's terms. pi forks from a person's message: `fork` with the entry a message
 * is saved as makes a new session of everything before that message, and answers with the message's text. `clone`
 * copies the whole branch. So:
 *
 * - The person's message: `fork` at it, and its text comes back for the send box (edit it, or send it again, in the
 *   new session).
 * - mu's reply: the session as it stood at the end of that reply, which is `fork` at the person's next message (its text
 *   is not wanted then), or `clone` when the reply is the last one.
 *
 * Pure: it reads the view only. A message pi has not saved yet, or one a harness too old to say which entry it is
 * came from, has no point.
 */
import type { NativeView, PiCommand } from '@/common/utils/nativeHost';

export type ForkPoint = {
  command: Extract<PiCommand, { type: 'fork' } | { type: 'clone' }>;
  /** The text pi answers with goes into the send box: the person's own message, to edit. */
  fill: boolean;
};

/** The fork point of the view's message `messageId` (a row's `msg_id`), or undefined when it has none. */
export function forkPoint(view: NativeView, messageId: string): ForkPoint | undefined {
  const index = view.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return undefined;
  const message = view.messages[index];
  if (message.role === 'user')
    return message.entryId ? { command: { type: 'fork', entryId: message.entryId }, fill: true } : undefined;
  if (message.role !== 'assistant' || message.streaming) return undefined;
  for (const later of view.messages.slice(index + 1)) {
    if (later.role !== 'user') continue;
    return later.entryId ? { command: { type: 'fork', entryId: later.entryId }, fill: false } : undefined;
  }
  return message.entryId ? { command: { type: 'clone' }, fill: false } : undefined;
}

/**
 * The ids of every message of the view that has a fork point, in one pass: the same messages `forkPoint` answers for,
 * so the rows that offer a fork are drawn without looking each one up.
 */
export function forkableIds(view: NativeView): Set<string> {
  const ids = new Set<string>();
  // The nearest message of the person after the one looked at.
  let later: { entryId?: string } | undefined;
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index];
    if (message.role === 'user') {
      if (message.entryId) ids.add(message.id);
      later = message;
    } else if (message.role === 'assistant' && !message.streaming && (later ? later.entryId : message.entryId)) {
      ids.add(message.id);
    }
  }
  return ids;
}
