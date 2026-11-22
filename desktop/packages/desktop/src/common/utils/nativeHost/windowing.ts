/**
 * A view's messages windowed for the crossing to the renderer (docs/native-host.md, Limits): a conversation is sent
 * as its tail within a byte budget, with `view.window` saying what was left out, and the pages before it come on
 * demand. The main process folds every record into the whole view as before; only what crosses is windowed, so the
 * reducer's semantics never see a budget.
 */
import type { NativeView, ViewMessage, ViewWindow } from './view.ts';

/** How many bytes of messages a windowed view carries, and each page of the ones before it. */
export const WINDOW_BUDGET = 2 * 1024 * 1024;

const sizeOf = (message: ViewMessage): number => JSON.stringify(message).length;

/**
 * Where a window of `messages` that holds at most `budget` bytes can start: far enough from the end that the messages
 * from there fit the budget, but never past the first of the messages before `end` (a window holds at least the one
 * right before `end`, however large it alone is). 0 when they all fit.
 */
function startFor(messages: readonly ViewMessage[], end: number, budget: number): number {
  let size = 0;
  for (let index = end - 1; index >= 0; index--) {
    size += sizeOf(messages[index]);
    if (size > budget) return Math.min(index + 1, end - 1);
  }
  return 0;
}

/** The view with only its last messages, within `budget` as JSON, and `window` saying what was left out. */
export function windowedView(view: NativeView, budget: number = WINDOW_BUDGET): NativeView {
  const messages = view.messages;
  if (messages.length === 0) return view;
  const start = startFor(messages, messages.length, budget);
  if (start === 0) return view; // everything fits, or one message alone is the view: nothing to window
  return { ...view, messages: messages.slice(start), window: { dropped: start, total: messages.length } };
}

/** What `earlierOf` answers: the messages of one page, oldest first, and the window a view holding them would have. */
export type EarlierPage = { messages: ViewMessage[]; window: ViewWindow };

/**
 * The page of messages before the one `before` names, within `budget` as JSON (the page holds at least the one
 * right before it). An anchor this view does not have — the conversation moved on to another session, or the view
 * was rebuilt — answers with no messages and a window that holds nothing of this view: nothing is prepended, and the
 * conversation's next `replaced` says where the view really starts.
 */
export function earlierOf(view: NativeView, before: string, budget: number = WINDOW_BUDGET): EarlierPage {
  const messages = view.messages;
  const total = messages.length;
  const anchor = messages.findIndex((message) => message.id === before);
  if (anchor <= 0)
    return { messages: [], window: { dropped: anchor === 0 ? 0 : total, total } };
  const start = startFor(messages, anchor, budget);
  return { messages: messages.slice(start, anchor), window: { dropped: start, total } };
}
