/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Dropdown, Menu, Message } from '@arco-design/web-react';
import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '@/renderer/utils/ui/clipboard';
import { formatPrimaryShortcut } from '@/renderer/utils/ui/keyboardShortcuts';

/**
 * Right-click menu for text, shown where Electron shows nothing by default: the send box and the message list.
 *
 * Electron does not open a native context menu in the renderer, so selecting text and right-clicking did nothing.
 * This wraps a container and opens an Arco dropdown on `contextmenu`, offering copy/cut/paste/select-all on the
 * wrapped text. Labels reuse the `common.menu.*` keys already translated for the native Edit menu in every locale.
 *
 * The classic pitfall is the menu itself: opening it can blur the target and a click on a menu item clears the
 * selection, so `document.execCommand` would then act on an empty selection. The selection is therefore captured
 * when the menu opens and restored on the target before the command runs.
 *
 * Paste is special: Electron's renderer refuses `execCommand('paste')`, so paste falls back to
 * `navigator.clipboard.readText()` (the app grants its renderer clipboard-read) inserted with
 * `execCommand('insertText')`. Text only — pasting images stays with Ctrl+V's native paste handling.
 */

/** Editable variant: the menu acts on this textarea, and offers cut and paste besides copy and select-all. */
type EditableSpec = {
  variant: 'editable';
  /** The textarea the menu acts on: read when the menu opens, focused again when an item runs. */
  getTextarea: () => HTMLTextAreaElement | null;
};

/** Read-only variant: for rendered text (the message list), which has no editable target. */
type ReadonlySpec = {
  variant: 'readonly';
  /** The element whose whole contents "Select all" covers, so the command stays inside the message area. */
  getSelectAllTarget: () => HTMLElement | null;
};

type TextContextMenuProps = (EditableSpec | ReadonlySpec) & {
  /** A single element that accepts a ref; right-clicking anywhere inside it opens the menu. */
  children: React.ReactElement;
};

/** Menu entry keys. */
type MenuAction = 'copy' | 'cut' | 'paste' | 'selectAll' | 'clear';

/** A menu row: label on the left, the shortcut the item duplicates on the right. */
const MenuRow: React.FC<{ label: string; shortcut?: string }> = ({ label, shortcut }) => (
  <span className='flex items-center justify-between gap-24px'>
    <span>{label}</span>
    {shortcut ? <span className='text-11px text-t-tertiary flex-shrink-0'>{shortcut}</span> : null}
  </span>
);

/**
 * Text context menu wrapper.
 *
 * `editable` restores the captured textarea selection before running copy/cut/paste through
 * `document.execCommand`, which in Electron's renderer acts on the focused element; paste therefore goes through
 * the textarea's own paste handling (image paste included). `readonly` copies the text captured at open — a
 * rendered selection cannot be restored reliably, but a saved string cannot be cleared by the click either.
 */
const TextContextMenu: React.FC<TextContextMenuProps> = (props) => {
  const { t } = useTranslation();
  const editable = props.variant === 'editable';
  // Selection captured when the menu opened: textarea offsets for editable, the selected string for readonly.
  const savedRangeRef = useRef<{ start: number; end: number } | null>(null);
  const savedTextRef = useRef('');
  const [hasSelection, setHasSelection] = useState(false);
  const [hasContent, setHasContent] = useState(false);

  const handleContextMenu = useCallback(
    (_event: React.MouseEvent) => {
      if (props.variant === 'editable') {
        const textarea = props.getTextarea();
        if (textarea) {
          savedRangeRef.current = { start: textarea.selectionStart, end: textarea.selectionEnd };
          setHasSelection(textarea.selectionStart !== textarea.selectionEnd);
          setHasContent(textarea.value.length > 0);
        } else {
          savedRangeRef.current = null;
          setHasSelection(false);
          setHasContent(false);
        }
      } else {
        const text = window.getSelection()?.toString() ?? '';
        savedTextRef.current = text;
        setHasSelection(text.length > 0);
      }
    },
    [props]
  );

  const runEditable = useCallback(
    (action: MenuAction, getTextarea: () => HTMLTextAreaElement | null) => {
      const textarea = getTextarea();
      if (!textarea) return;
      const saved = savedRangeRef.current;
      textarea.focus();
      if (saved) {
        // Restore what was selected when the menu opened: clicking the menu item cleared it.
        textarea.setSelectionRange(saved.start, saved.end);
      }
      if (action === 'selectAll') {
        textarea.select();
        return;
      }
      if (action === 'clear') {
        // Clear through the editor's own delete command: React's onChange sees it and Ctrl+Z undoes it.
        textarea.focus();
        textarea.select();
        document.execCommand('delete');
        return;
      }
      const ran = document.execCommand(action);
      if (!ran && action === 'paste') {
        // Electron's renderer no longer honours execCommand('paste'); go through the async Clipboard API and
        // insert as text. execCommand('insertText') keeps the undo stack and fires the textarea's onChange.
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (!text) return;
            textarea.focus();
            if (saved) textarea.setSelectionRange(saved.start, saved.end);
            document.execCommand('insertText', false, text);
          })
          .catch(() => Message.error(t('common.copyFailed')));
        return;
      }
      if (!ran && action === 'copy' && saved) {
        // execCommand can refuse (no focused selection); copy the captured text directly instead.
        void copyText(textarea.value.slice(saved.start, saved.end)).catch(() => Message.error(t('common.copyFailed')));
      }
    },
    [t]
  );

  const runReadonly = useCallback(
    (action: MenuAction, getSelectAllTarget: () => HTMLElement | null) => {
      if (action === 'copy') {
        const text = savedTextRef.current;
        if (!text) return;
        void copyText(text)
          .then(() => Message.success(t('messages.copySuccess')))
          .catch(() => Message.error(t('common.copyFailed')));
        return;
      }
      if (action === 'selectAll') {
        const target = getSelectAllTarget();
        const selection = window.getSelection();
        if (!target || !selection) return;
        const range = document.createRange();
        range.selectNodeContents(target);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    },
    [t]
  );

  const onClickMenuItem = useCallback(
    (key: string) => {
      const action = key as MenuAction;
      if (props.variant === 'editable') {
        runEditable(action, props.getTextarea);
      } else {
        runReadonly(action, props.getSelectAllTarget);
      }
    },
    [props, runEditable, runReadonly]
  );

  const menu = (
    <Menu onClickMenuItem={onClickMenuItem} data-testid='text-context-menu'>
      <Menu.Item key='copy' disabled={!hasSelection}>
        <MenuRow label={t('common.menu.copy')} shortcut={formatPrimaryShortcut({ key: 'c' })} />
      </Menu.Item>
      {editable && (
        <Menu.Item key='cut' disabled={!hasSelection}>
          <MenuRow label={t('common.menu.cut')} shortcut={formatPrimaryShortcut({ key: 'x' })} />
        </Menu.Item>
      )}
      {editable && (
        <Menu.Item key='paste'>
          <MenuRow label={t('common.menu.paste')} shortcut={formatPrimaryShortcut({ key: 'v' })} />
        </Menu.Item>
      )}
      <Menu.Item key='selectAll'>
        <MenuRow label={t('common.menu.selectAll')} shortcut={formatPrimaryShortcut({ key: 'a' })} />
      </Menu.Item>
      {editable && (
        <Menu.Item key='clear' disabled={!hasContent}>
          <MenuRow label={t('common.menu.clearInput')} />
        </Menu.Item>
      )}
    </Menu>
  );

  // Arco's Trigger replaces the child's `onContextMenu` prop with its own when it opens the dropdown, but it
  // forwards the event to the child's original handler first (Trigger#triggerPropsEvent), so the capture rides
  // on the child: type-safe, and it runs before the popup opens.
  const child = React.Children.only(props.children) as React.ReactElement<{ onContextMenu?: React.MouseEventHandler }>;
  const wrappedChild = React.cloneElement(child, {
    onContextMenu: (event: React.MouseEvent) => {
      child.props.onContextMenu?.(event);
      handleContextMenu(event);
    },
  });

  return (
    <Dropdown trigger='contextMenu' position='bl' droplist={menu} getPopupContainer={() => document.body}>
      {wrappedChild}
    </Dropdown>
  );
};

export default TextContextMenu;
