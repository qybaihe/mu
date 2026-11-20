/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The positions the user hid from the monitor's wall and the sidebar's roster
 * (a position card's hide action): names in localStorage, nothing deleted —
 * the library files stay, so restoring is one click. Pure list IO only; the
 * cards and rows that consume this stay in their own files.
 */
import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'monitor-hidden-positions';

/** A stored list back: unique, in file order, anything unparsable dropped. */
export const parseHiddenPositions = (text: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item !== ''))];
  } catch {
    return [];
  }
};

const listeners = new Set<() => void>();
let cached: ReadonlySet<string> | undefined;

const readStorage = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

/** The hidden names, read once and kept until a change rewrites them. */
const hiddenPositions = (): ReadonlySet<string> => {
  if (cached === undefined) cached = new Set(parseHiddenPositions(readStorage() ?? '[]'));
  return cached;
};

const writeHidden = (names: readonly string[]): void => {
  cached = new Set(names);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
    // The hide simply does not persist; the session still works.
  }
  listeners.forEach((listener) => listener());
};

/** The hidden names as a live value; re-renders on hide and restore. */
export const useHiddenPositions = (): ReadonlySet<string> => {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return useSyncExternalStore(subscribe, hiddenPositions, hiddenPositions);
};

/** Hides one position from the monitor wall and the sidebar roster. */
export const hidePosition = (name: string): void => {
  const next = [...hiddenPositions()];
  if (!next.includes(name)) next.push(name);
  writeHidden(next);
};

/** Un-hides every hidden position at once — the one recovery entry. */
export const restoreHiddenPositions = (): void => {
  writeHidden([]);
};

/** Test hook: forget the cache so a fresh storage read happens. */
export const resetHiddenPositionsForTest = (): void => {
  cached = undefined;
  listeners.forEach((listener) => listener());
};
