import { useEffect, useRef, useState } from 'react';
import type { TMessage } from '@/common/chat/chatLib';

/**
 * The list the transcript draws from, redrawn at most once a frame while a reply streams.
 *
 * A reply and a thought arrive a few characters at a time, and each chunk replaces the whole list. Redrawing per
 * chunk costs more the faster the model is, and nothing on screen can move more often than the screen does. So a
 * chunk that only grows one row in place waits for the next frame and takes every chunk after it along: the text of a
 * reply, a thought still thinking, a tool call still in progress, a terminal still printing.
 *
 * Everything else lands at once — a row added or removed, a tool call changing state, a permission request, the
 * reader's own message. Only rows that are still growing are ever a frame late.
 */

/** Whether a single row only grew in place during active streaming (text/thinking chunk or live tool output). */
const isStreamingRowUpdate = (prev: TMessage | undefined, next: TMessage): boolean => {
  if (!prev || prev.id !== next.id || prev.type !== next.type) return false;
  if (prev.type === 'text' && next.type === 'text') return prev.position === next.position;
  if (prev.type === 'thinking' && next.type === 'thinking') {
    return prev.content.status === 'thinking' && next.content.status === 'thinking';
  }
  if (prev.type === 'acp_tool_call' && next.type === 'acp_tool_call') {
    return (
      prev.content?.update?.status === 'in_progress' &&
      next.content?.update?.status === 'in_progress' &&
      prev.content?.update?.tool_call_id === next.content?.update?.tool_call_id
    );
  }
  if (prev.type === 'acp_terminal_output' && next.type === 'acp_terminal_output') {
    return !prev.content?.exit_status && !next.content?.exit_status;
  }
  return false;
};

/** Whether `next` only updates a live streaming row in place: the case worth holding for the next animation frame. */
const isStreamedChunk = (current: TMessage[], next: TMessage[]): boolean => {
  if (current.length === 0 || current.length !== next.length) return false;
  let changedIndex = -1;
  for (let index = 0; index < current.length; index++) {
    if (current[index] === next[index]) continue;
    if (changedIndex !== -1) return false;
    changedIndex = index;
  }
  if (changedIndex === -1) return false;
  return isStreamingRowUpdate(current[changedIndex], next[changedIndex]);
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
