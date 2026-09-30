/**
 * The conversations the person archived in the sidebar's native group, by session id: out of the list until restored,
 * their session files untouched (a choice about this app's list, kept as the pins are: idSetStore.ts).
 */
import { createIdSetStore, useIdSet } from './idSetStore';

export const ARCHIVED_KEY = 'mu.native.archived';

const store = createIdSetStore(ARCHIVED_KEY);

export function useNativeArchived(): {
  archived: ReadonlySet<string>;
  archive: (id: string) => void;
  restore: (id: string) => void;
} {
  return { archived: useIdSet(store), archive: store.add, restore: store.remove };
}
