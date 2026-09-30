/**
 * A long conversation is shown by its latest rows, so opening one costs what a screenful costs and not what its whole
 * history costs (a session of 6,752 entries drew every message at once, and took 24 seconds). Scrolling to the top
 * shows the rows before, a step at a time.
 */
import type { TMessage } from '@/common/chat/chatLib';

/** The rows a conversation opens with, and the number each step up shows more. */
export const ROW_WINDOW = 120;

const startsTurn = (row: TMessage): boolean => row.type === 'text' && row.position === 'right';

/**
 * A row the list folds into the run of steps around it ("7 steps": consecutive tool calls and thoughts are one row,
 * named by the first of them). A window that starts inside a run shows part of it; when the rows before come, the run
 * has a new first step and the row the reader was looking at has another name, so the list cannot keep their place.
 */
const isStep = (row: TMessage): boolean =>
  row.type === 'tool_group' || row.type === 'acp_tool_call' || row.type === 'tool_call' || row.type === 'thinking';

/** A row a window can start at without cutting a run of steps in two. */
const startsCleanly = (rows: readonly TMessage[], index: number): boolean =>
  index <= 0 || !isStep(rows[index]) || !isStep(rows[index - 1]);

/**
 * The index to show rows from when `size` of the ones before `end` are wanted: at the person's message that opens the
 * turn the cut falls in, so a turn is not shown without its start, as long as that message is within another `size`
 * rows; else where the cut does not split a run of steps (the run is shown whole), within the same distance; else
 * where the cut falls (a turn or a run that long is cut). 0 when there are no more rows than `size`.
 */
export function windowStart(rows: readonly TMessage[], size: number, end = rows.length): number {
  const cut = end - size;
  if (cut <= 0) return 0;
  const floor = Math.max(0, cut - size);
  for (let index = cut; index >= floor; index--) if (startsTurn(rows[index])) return index;
  for (let index = cut; index >= floor; index--) if (startsCleanly(rows, index)) return index;
  return cut;
}
