import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * One-sentence hints shown the first time something appears (a Jev verdict line, the side panel), until the person
 * closes them; closed is remembered in this browser's storage, per hint. Without storage they never show: a hint
 * that cannot be closed for good would nag.
 *
 * One place shows a hint at a time: of the places that want it, the first to ask holds it until it goes away (a
 * conversation can have many verdict lines; the hint sits under one of them), and the next one takes it then.
 */
export const FIRST_HINTS = ['jevLine', 'workPanel'] as const;
export type FirstHintId = (typeof FIRST_HINTS)[number];

const STORAGE_KEY = 'mu.firstHints';

let closed: Set<string> | undefined;
const holders = new Map<FirstHintId, symbol>();
const listeners = new Set<() => void>();
let version = 0;

const emit = (): void => {
  version += 1;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = (): number => version;

function readClosed(): Set<string> {
  if (closed) return closed;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    closed = new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    closed = new Set(FIRST_HINTS);
  }
  return closed;
}

/** Closes a hint for good. */
export function closeFirstHint(id: FirstHintId): void {
  const now = readClosed();
  now.add(id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...now]));
  } catch {
    // Closed for this session; it may show again after a restart.
  }
  holders.delete(id);
  emit();
}

/** Whether this place shows hint `id`: it `wants` it, the hint was never closed, and no other place holds it. */
export function useFirstHint(id: FirstHintId, wants: boolean): boolean {
  const token = useRef(Symbol(id));
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const open = wants && !readClosed().has(id);
  // `current`: a place that wants the hint asks again whenever the holder lets it go.
  useEffect(() => {
    if (!open || holders.has(id)) return;
    holders.set(id, token.current);
    emit();
  }, [current, id, open]);
  // Let go when this place no longer wants it, or goes away.
  useEffect(() => {
    if (!open) return undefined;
    const mine = token.current;
    return () => {
      if (holders.get(id) !== mine) return;
      holders.delete(id);
      emit();
    };
  }, [id, open]);
  return open && holders.get(id) === token.current;
}

/** Forgets what was closed and who holds what: for tests. */
export function resetFirstHintsForTest(): void {
  closed = undefined;
  holders.clear();
  version = 0;
}
