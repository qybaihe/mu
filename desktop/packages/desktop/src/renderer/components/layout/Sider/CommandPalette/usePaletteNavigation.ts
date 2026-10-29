/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useState } from 'react';

/**
 * The chosen row of the palette (or of quick open) and the keys of its input: ↑ and ↓ move through every row across
 * the groups and wrap around, Enter runs the chosen one. A new query starts again from the first row. Esc belongs to
 * the dialog.
 */
export const usePaletteNavigation = <Item,>(items: readonly Item[], query: string, onRun: (item: Item) => void) => {
  // The cursor remembers which query it was set for, so a new query needs no effect to reset it.
  const [cursor, setCursor] = useState({ query, index: 0 });
  const index = cursor.query === query ? Math.min(cursor.index, items.length - 1) : 0;
  const activeIndex = items.length > 0 ? index : -1;

  const setActiveIndex = useCallback((next: number) => setCursor({ query, index: next }), [query]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // Enter that ends an IME composition (Chinese, Japanese…) picks the characters, not a row.
      if (event.nativeEvent.isComposing) return;
      const count = items.length;
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          if (count > 0) setActiveIndex((activeIndex + 1) % count);
          return;
        case 'ArrowUp':
          event.preventDefault();
          if (count > 0) setActiveIndex((activeIndex - 1 + count) % count);
          return;
        case 'Enter': {
          event.preventDefault();
          const item = items[activeIndex];
          if (item) onRun(item);
        }
      }
    },
    [activeIndex, items, onRun, setActiveIndex]
  );

  return { activeIndex, setActiveIndex, onKeyDown };
};
