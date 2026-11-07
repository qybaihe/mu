import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';

const OPEN_KEYS = new Set(['Enter', ' ', 'ArrowDown']);
// The menu mounts and starts its entry animation after the render that opens it; its first item can take the focus
// a frame or two later.
const FOCUS_ATTEMPTS = 10;

const menuItems = (menu: HTMLElement | null): HTMLElement[] =>
  menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter((item) => item.tabIndex >= 0) : [];

/**
 * What a menu opened from a button needs for the keyboard. Arco's Dropdown leaves the focus on the button and puts
 * the menu at the end of the page, so Tab never reaches its items. With this, Enter, Space or ArrowDown on the button
 * opens the menu with the focus on its first item; ArrowUp and ArrowDown move through the items, Home and End go to
 * either end, Enter picks one (Arco's own), and Escape or Tab closes the menu and gives the focus back to the button.
 *
 * `menuRef` goes on the Menu, `buttonRef` on the button that opens it, `onButtonKeyDown` on that button and
 * `onMenuKeyDown` on the Menu.
 */
export function useMenuKeyboard<TButton extends HTMLElement = HTMLElement>(
  open: boolean,
  setOpen: (open: boolean) => void
) {
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<TButton>(null);
  const focusFirstItemRef = useRef(false);

  useEffect(() => {
    if (!open || !focusFirstItemRef.current) return;
    focusFirstItemRef.current = false;
    let frame = 0;
    let attempts = 0;
    const focusFirstItem = () => {
      const first = menuItems(menuRef.current)[0];
      first?.focus();
      if (first && document.activeElement === first) return;
      attempts += 1;
      if (attempts < FOCUS_ATTEMPTS) frame = requestAnimationFrame(focusFirstItem);
    };
    frame = requestAnimationFrame(focusFirstItem);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const onButtonKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!OPEN_KEYS.has(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (open) {
        menuItems(menuRef.current)[0]?.focus();
        return;
      }
      focusFirstItemRef.current = true;
      setOpen(true);
    },
    [open, setOpen]
  );

  const onMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      const items = menuItems(menuRef.current);
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      let next: HTMLElement | undefined;
      if (event.key === 'ArrowDown') next = items[current < 0 ? 0 : (current + 1) % items.length];
      else if (event.key === 'ArrowUp') next = items[current <= 0 ? items.length - 1 : current - 1];
      else if (event.key === 'Home') next = items[0];
      else if (event.key === 'End') next = items[items.length - 1];
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      next.focus();
    },
    [setOpen]
  );

  return { menuRef, buttonRef, onButtonKeyDown, onMenuKeyDown };
}
