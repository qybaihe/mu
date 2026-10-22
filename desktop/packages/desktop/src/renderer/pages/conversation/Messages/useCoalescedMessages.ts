import { useEffect, useRef, useState } from 'react';
import type { TMessage } from '@/common/chat/chatLib';

/**
 * The list the transcript draws from, redrawn at most once a frame while a reply streams.
 *
 * A reply and a thought arrive a few characters at a time, and each chunk replaces the whole list. Redrawing per
 * chunk costs more the faster the model is, and nothing on screen can move more often than the screen does. So a
 * chunk that only adds to the text of the last row waits for the next frame and takes every chunk after it along.
 *
 * Everything else lands at once — a row added or removed, a tool call changing state, a permission request, the
 * reader's own message. Only the two kinds of row that grow letter by letter are ever a frame late.
 */

const STREAMS = new Set(['text', 'thinking']);

/** Whether `next` only adds to the text of the row that is already last: the one case worth holding for a frame. */
const isStreamedChunk = (current: TMessage[], next: TMessage[]): boolean => {
  if (current.length === 0 || current.length !== next.length) return false;
  const last = next[next.length - 1];
  if (!STREAMS.has(last.type) || last.id !== current[current.length - 1]?.id) return false;
  for (let index = 0; index < current.length - 1; index++) {
    if (current[index] !== next[index]) return false;
  }
  return true;
};

export function useCoalescedMessages(list: TMessage[]): TMessage[] {
  const [rendered, setRendered] = useState(list);
  const frameRef = useRef<number | null>(null);
  const latestRef = useRef(list);

  useEffect(() => {
    latestRef.current = list;
    if (list === rendered) return;

    if (!isStreamedChunk(rendered, list)) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      setRendered(list);
      return;
    }

    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setRendered(latestRef.current);
    });
  }, [list, rendered]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  return rendered;
}
