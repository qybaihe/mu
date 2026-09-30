/**
 * How long a dialog pi waits on has left. pi stops waiting once the dialog's `timeout` has passed, takes the default,
 * and says nothing of it; the dialog then closes itself here (`onExpire`). The time counts from when this window first
 * saw the dialog: a window that opens a conversation while a dialog waits counts from then, and pi's clock decides.
 * Give the component that uses it a `key` per dialog.
 */
import { useEffect, useRef, useState } from 'react';

/** When each dialog was first seen, by conversation and dialog id, so a screen drawn again keeps counting. */
const firstSeen = new Map<string, number>();
const REMEMBERED = 200;

function seenAt(key: string): number {
  const known = firstSeen.get(key);
  if (known !== undefined) return known;
  const now = Date.now();
  firstSeen.set(key, now);
  if (firstSeen.size > REMEMBERED) firstSeen.delete(firstSeen.keys().next().value as string);
  return now;
}

/** The whole seconds left, or undefined for a dialog that waits as long as it takes. */
export function useDialogDeadline(key: string, timeout: number | undefined, onExpire: () => void): number | undefined {
  const [since] = useState(() => seenAt(key));
  const [now, setNow] = useState(() => Date.now());
  const expire = useRef(onExpire);
  useEffect(() => {
    expire.current = onExpire;
  });
  const left = timeout === undefined ? undefined : Math.max(0, Math.ceil((since + timeout - now) / 1000));
  const counting = left !== undefined && left > 0;

  useEffect(() => {
    if (!counting) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  useEffect(() => {
    if (left !== 0) return;
    firstSeen.delete(key);
    expire.current();
  }, [key, left]);

  return left;
}
