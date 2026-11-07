import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';

const rowsIn = (list: HTMLElement | null): HTMLElement[] =>
  list ? Array.from(list.querySelectorAll<HTMLElement>('[data-roving-row]')) : [];

/**
 * A long list of rows as one stop in the Tab order, the way a list box is: Tab reaches one row (the one used last,
 * else the current one, else the first), ArrowUp and ArrowDown move through the rows in the order they are shown, and
 * Home and End go to either end. With a stop per row, a sidebar of a hundred conversations stands between the title
 * bar and the page.
 *
 * `listRef`, `onFocus` and `onKeyDown` go on the element that holds the rows; each row carries
 * `data-roving-row={key}` and `tabIndex={tabIndexOf(key)}`. A key pressed on a control inside a row (its menu button)
 * is left to that control.
 */
export function useRovingRows(currentKey: string | null) {
  const listRef = useRef<HTMLDivElement>(null);
  const usedKeyRef = useRef<string | null>(null);
  const currentKeyRef = useRef(currentKey);
  const [stopKey, setStopKey] = useState<string | null>(null);

  // Rows come and go (a project folds, a conversation is archived): the stop stays on a row that is shown. A row
  // opened from elsewhere (the palette, a link) is the one Tab comes back to.
  useLayoutEffect(() => {
    if (currentKeyRef.current !== currentKey) {
      currentKeyRef.current = currentKey;
      usedKeyRef.current = null;
    }
    const keys = rowsIn(listRef.current).map((row) => row.dataset.rovingRow ?? '');
    const shown = (key: string | null) => (key !== null && keys.includes(key) ? key : null);
    const next = shown(usedKeyRef.current) ?? shown(currentKey) ?? keys[0] ?? null;
    if (next !== stopKey) setStopKey(next);
  });

  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const key = (event.target as HTMLElement).dataset?.rovingRow;
    if (key === undefined) return;
    usedKeyRef.current = key;
    setStopKey(key);
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const row = event.target as HTMLElement;
    if (row.dataset?.rovingRow === undefined) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    // Taken even at either end, where it would scroll the list away from the focused row.
    event.preventDefault();
    const rows = rowsIn(listRef.current);
    const at = rows.indexOf(row);
    const next =
      event.key === 'ArrowDown'
        ? rows[at + 1]
        : event.key === 'ArrowUp'
          ? rows[at - 1]
          : event.key === 'Home'
            ? rows[0]
            : rows[rows.length - 1];
    next?.focus();
  }, []);

  const tabIndexOf = useCallback((key: string) => (key === stopKey ? 0 : -1), [stopKey]);

  return { listRef, onFocus, onKeyDown, tabIndexOf };
}
