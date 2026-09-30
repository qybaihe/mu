/**
 * What tells the files tab there is news: the calls of pi's tools that change a file by themselves, finished. (The
 * shell can change files too, and says nothing of which; the folder is read again after every run in any case.)
 */
import type { NativeView } from '@/common/utils/nativeHost';

const EDITS: ReadonlySet<string> = new Set(['write', 'edit']);

/** How many `write` and `edit` calls the view holds that finished without an error. */
export function finishedEdits(view: NativeView): number {
  let count = 0;
  for (const message of view.messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks)
      if (block.type === 'tool' && block.status === 'done' && EDITS.has(block.name)) count++;
  }
  return count;
}
