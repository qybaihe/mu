/**
 * A set of session ids this app keeps for the person: the conversations pinned, archived, or marked unread in the
 * sidebar. A choice about this app's list, not part of a session, so it is kept in the window's own storage: every
 * reader on the page shares it, and another window takes it in through the `storage` event. Storage that cannot be
 * read or written (a private window) leaves the set empty and keeps it in memory for the life of the page.
 */
import { useSyncExternalStore } from 'react';

export type IdSetStore = {
  /** The ids now: the same set until one changes, so it is a snapshot a component can subscribe to. */
  get: () => ReadonlySet<string>;
  add: (id: string) => void;
  remove: (id: string) => void;
  toggle: (id: string) => void;
  /** Drops the ids that are not in `keep`. */
  retain: (keep: ReadonlySet<string>) => void;
  /** Empties the set. */
  clear: () => void;
  subscribe: (listener: () => void) => () => void;
};

export function createIdSetStore(key: string): IdSetStore {
  const listeners = new Set<() => void>();

  const read = (): ReadonlySet<string> => {
    try {
      const stored: unknown = JSON.parse(globalThis.localStorage.getItem(key) ?? '[]');
      return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  };

  let snapshot = read();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const write = (ids: ReadonlySet<string>): void => {
    snapshot = ids;
    try {
      globalThis.localStorage.setItem(key, JSON.stringify([...ids]));
    } catch {
      // Kept in memory: for as long as the page lives.
    }
    emit();
  };

  globalThis.addEventListener?.('storage', (event) => {
    if (event.key !== key) return;
    snapshot = read();
    emit();
  });

  const add = (id: string) => {
    if (!snapshot.has(id)) write(new Set(snapshot).add(id));
  };
  const remove = (id: string) => {
    if (!snapshot.has(id)) return;
    const next = new Set(snapshot);
    next.delete(id);
    write(next);
  };

  return {
    get: () => snapshot,
    add,
    remove,
    toggle: (id) => (snapshot.has(id) ? remove(id) : add(id)),
    retain: (keep) => {
      const kept = [...snapshot].filter((id) => keep.has(id));
      if (kept.length !== snapshot.size) write(new Set(kept));
    },
    clear: () => {
      if (snapshot.size > 0) write(new Set());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The store's ids, kept up to date in the component. */
export const useIdSet = (store: IdSetStore): ReadonlySet<string> => useSyncExternalStore(store.subscribe, store.get);
