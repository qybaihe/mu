/**
 * What tells the files tab there is news: the calls of pi's tools that change a file by themselves, finished. (The
 * shell can change files too, and says nothing of which; the folder is read again after every run in any case.)
 */
import type { NativeView } from '@/common/utils/nativeHost';

const EDITS: ReadonlySet<string> = new Set(['write', 'edit']);

/**
 * The `write` and `edit` calls the view holds that finished without an error, in order: the file each changed, as the
 * call named it (relative to the conversation's folder or absolute), or '' when it named none.
 */
export function finishedEditPaths(view: NativeView): string[] {
  const paths: string[] = [];
  for (const message of view.messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type !== 'tool' || block.status !== 'done' || !EDITS.has(block.name)) continue;
      const path = block.args.path ?? block.args.file_path;
      paths.push(typeof path === 'string' ? path : '');
    }
  }
  return paths;
}

/** How many `write` and `edit` calls the view holds that finished without an error. */
export const finishedEdits = (view: NativeView): number => finishedEditPaths(view).length;
