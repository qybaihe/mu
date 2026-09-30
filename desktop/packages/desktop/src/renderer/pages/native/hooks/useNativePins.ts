/**
 * The conversations pinned in the sidebar's native group, by session id (idSetStore.ts keeps them in the window's own
 * storage, so a pin outlives a restart and reaches another window).
 */
import { createIdSetStore, useIdSet } from './idSetStore';

export const PINNED_KEY = 'mu.native.pinned';

const store = createIdSetStore(PINNED_KEY);

export function useNativePins(): {
  pinned: ReadonlySet<string>;
  toggle: (id: string) => void;
  unpin: (id: string) => void;
} {
  return { pinned: useIdSet(store), toggle: store.toggle, unpin: store.remove };
}
