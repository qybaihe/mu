import type { JsonObject } from '../../../../common/utils/nativeHost/records.ts';

/**
 * Whether pi's session went on in a straight line from `from` (the leaf the main process last knew; null for the
 * start of a session) to `leaf`, through exactly `entries` (what `get_entries` gave since `from`). Then the view,
 * built live record by record, is still the view of pi's branch.
 *
 * It is not when the session changed under the conversation: another session (`/clear`, an import switching to its
 * session), or the same session's leaf moved (mu's checkpoint rewind navigates the tree): the leaf then is not reached
 * from `from`, or entries appeared off the way to it.
 */
export function followsBranch(entries: readonly JsonObject[], from: string | null, leaf: string | null): boolean {
  if (leaf === from) return entries.length === 0;
  const byId = new Map<string, JsonObject>();
  for (const entry of entries) if (typeof entry.id === 'string') byId.set(entry.id, entry);
  if (byId.size !== entries.length) return false;
  const passed = new Set<string>();
  let current: string | null = leaf;
  while (current !== from) {
    const entry = current === null ? undefined : byId.get(current);
    if (!entry || current === null || passed.has(current)) return false;
    passed.add(current);
    current = typeof entry.parentId === 'string' ? entry.parentId : null;
  }
  return passed.size === byId.size;
}
