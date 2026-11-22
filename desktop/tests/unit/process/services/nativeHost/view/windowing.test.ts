import { describe, expect, it } from 'vitest';
import {
  earlierOf,
  emptyView,
  windowedView,
  type NativeView,
  type ViewMessage,
  type ViewWindow,
} from '@/common/utils/nativeHost/index.ts';

/**
 * A view's messages windowed for the crossing to the renderer (common/utils/nativeHost/windowing.ts): the tail
 * within a byte budget with `window` saying what was left out, and the pages before one message, a budget at a time.
 * The pages and the windows line up: what a window holds and the pages before its first message, concatenated, are
 * the conversation's messages from wherever the paging has reached.
 */

/** A message whose text carries the bytes: `size` is what it adds over the smallest note (its wrapper aside). */
const note = (id: string, size: number): ViewMessage => ({
  id,
  role: 'custom',
  customType: 'note',
  text: 'x'.repeat(size),
});

const viewOf = (messages: readonly ViewMessage[]): NativeView => ({ ...emptyView(), messages: [...messages] });

/** A budget that fits exactly these messages as JSON, and no more. */
const budgetOf = (...messages: readonly ViewMessage[]): number =>
  messages.reduce((total, message) => total + JSON.stringify(message).length, 0);

const windowOf = (dropped: number, total: number): ViewWindow => ({ dropped, total });

describe('windowedView', () => {
  it('leaves a view whose messages fit the budget as it is, with no window', () => {
    const view = viewOf([note('m1', 50), note('m2', 50)]);
    expect(windowedView(view, budgetOf(...view.messages))).toBe(view);
  });

  it('keeps the tail that fits, and says what was dropped from the head', () => {
    const view = viewOf([note('m1', 200), note('m2', 100), note('m3', 50)]);
    // The last two fit; the first of all three does not.
    const shown = windowedView(view, budgetOf(view.messages[1], view.messages[2]));
    expect(shown.messages.map((message) => message.id)).toEqual(['m2', 'm3']);
    expect(shown.window).toEqual(windowOf(1, 3));
    expect(shown.status).toBe(view.status);
  });

  it('keeps the last message however large it alone is', () => {
    const view = viewOf([note('m1', 10), note('m2', 300)]);
    const shown = windowedView(view, budgetOf(view.messages[1]));
    expect(shown.messages.map((message) => message.id)).toEqual(['m2']);
    expect(shown.window).toEqual(windowOf(1, 2));
  });

  it('leaves a view of one message alone: a window of it would hold the same', () => {
    const view = viewOf([note('m1', 500)]);
    expect(windowedView(view, 10)).toBe(view);
  });
});

describe('earlierOf', () => {
  it('gives the messages before the anchor, within the budget, and the window they would build', () => {
    const view = viewOf([note('m1', 50), note('m2', 50), note('m3', 50), note('m4', 50), note('m5', 50)]);
    // A page of two: the messages right before the anchor, and the window starts at the page's first.
    expect(earlierOf(view, 'm5', budgetOf(view.messages[2], view.messages[3]))).toEqual({
      messages: [view.messages[2], view.messages[3]],
      window: windowOf(2, 5),
    });
    // The anchor is the first of what the page's window holds: nothing is left out before it.
    expect(earlierOf(view, 'm3', budgetOf(view.messages[0], view.messages[1]))).toEqual({
      messages: [view.messages[0], view.messages[1]],
      window: windowOf(0, 5),
    });
  });

  it('holds at least the message right before the anchor, however large it alone is', () => {
    const view = viewOf([note('m1', 300), note('m2', 10), note('m3', 10)]);
    expect(earlierOf(view, 'm3', budgetOf(view.messages[1]))).toEqual({
      messages: [view.messages[1]],
      window: windowOf(1, 3),
    });
    const pair = viewOf([note('m1', 10), note('m2', 300)]);
    expect(earlierOf(pair, 'm2', budgetOf(pair.messages[0]))).toEqual({
      messages: [pair.messages[0]],
      window: windowOf(0, 2),
    });
  });

  it('answers an anchor the view does not have with no messages, everything of it still not held', () => {
    const view = viewOf([note('m1', 10), note('m2', 10)]);
    expect(earlierOf(view, 'm9', 100)).toEqual({ messages: [], window: windowOf(2, 2) });
    // The view's first message: nothing is before it.
    expect(earlierOf(view, 'm1', 100)).toEqual({ messages: [], window: windowOf(0, 2) });
  });

  it('pages back into what a windowed view dropped, without a gap or a repeat', () => {
    const messages = Array.from({ length: 20 }, (_, index) => note(`m${index + 1}`, 40));
    const view = viewOf(messages);
    const opened = windowedView(view, budgetOf(messages[15], messages[16], messages[17], messages[18], messages[19]));
    expect(opened.window?.dropped).toBeGreaterThan(0);
    const page = earlierOf(view, opened.messages[0].id, budgetOf(messages[10], messages[11], messages[12]));
    expect([...page.messages, ...opened.messages]).toEqual(messages.slice(page.window.dropped));
    expect(page.window.dropped).toBeLessThan(opened.window?.dropped ?? 0);
  });
});
