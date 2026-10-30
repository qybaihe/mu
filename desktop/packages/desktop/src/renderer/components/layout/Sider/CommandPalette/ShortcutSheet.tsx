/**
 * The keyboard shortcuts (Cmd/Ctrl+/, the command palette's row, Help → Keyboard shortcuts): the app's own keys in
 * groups, written as this computer writes them (⇧⌘A on a Mac, Ctrl+Shift+A elsewhere). Every row is a key the app
 * handles: useConversationShortcuts.ts, the application menu (appMenu.ts), the send box, the preview and the browser.
 * Esc or a click outside closes it.
 */
import { Modal } from '@arco-design/web-react';
import classNames from 'classnames';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { emitter, useAddEventListener } from '@/renderer/utils/emitter';
import { isMacOS } from '@/renderer/utils/platform';
import {
  COMMAND_PALETTE_SHORTCUT,
  MESSAGE_SEARCH_SHORTCUT,
  NEXT_WAITING_SHORTCUT,
  QUICK_OPEN_SHORTCUT,
  formatPrimaryShortcut,
  type PrimaryShortcutOptions,
} from '@/renderer/utils/ui/keyboardShortcuts';
import styles from './CommandPalette.module.css';

/** The same veil as the command palette's. */
const MASK_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--mu-scrim, color-mix(in srgb, var(--color-mask-bg) 30%, transparent))',
};

/** Cmd/Ctrl+/: the sheet itself. */
export const SHORTCUT_SHEET_SHORTCUT: PrimaryShortcutOptions = { key: '/', targetGuard: 'embedded-editor' };

export type ShortcutRow = {
  /** Its words: `common.shortcuts.rows.<id>`. */
  id: string;
  keys: readonly string[];
  /** The keys are the two ends of a range (⌘1 … ⌘9), not two ways to do it. */
  range?: boolean;
};

export type ShortcutGroup = { id: 'general' | 'conversations' | 'panels' | 'sendBox' | 'view'; rows: ShortcutRow[] };

/** The app's keys, in the groups the sheet shows, as this computer writes them; those with a constant come from it. */
export function shortcutGroups(): ShortcutGroup[] {
  const mac = isMacOS();
  const primary = (key: string | PrimaryShortcutOptions, shiftKey = false) =>
    formatPrimaryShortcut(typeof key === 'string' ? { key, shiftKey } : key);
  const shift = (key: string) => (mac ? `⇧${key}` : `Shift+${key}`);
  const control = (key: string, withShift = false) =>
    mac ? `⌃${withShift ? '⇧' : ''}${key}` : `Ctrl+${withShift ? 'Shift+' : ''}${key}`;
  return [
    {
      id: 'general',
      rows: [
        { id: 'palette', keys: [primary(COMMAND_PALETTE_SHORTCUT)] },
        { id: 'quickOpen', keys: [primary(QUICK_OPEN_SHORTCUT)] },
        { id: 'searchMessages', keys: [primary(MESSAGE_SEARCH_SHORTCUT)] },
        { id: 'findInConversation', keys: [primary('f')] },
        { id: 'newConversation', keys: [primary('n')] },
        { id: 'settings', keys: [primary(',')] },
        { id: 'shortcuts', keys: [primary(SHORTCUT_SHEET_SHORTCUT)] },
      ],
    },
    {
      id: 'conversations',
      rows: [
        { id: 'byPosition', keys: [primary('1'), primary('9')], range: true },
        { id: 'nextWaiting', keys: [primary(NEXT_WAITING_SHORTCUT)] },
        { id: 'nextPrevious', keys: [control('Tab'), control('Tab', true)] },
      ],
    },
    {
      id: 'panels',
      rows: [
        { id: 'sidebar', keys: [primary('b')] },
        { id: 'workPanel', keys: [primary('j')] },
        { id: 'closeTab', keys: [primary('w')] },
        { id: 'saveFile', keys: [primary('s')] },
      ],
    },
    {
      id: 'sendBox',
      rows: [
        { id: 'send', keys: ['Enter'] },
        { id: 'newLine', keys: [shift('Enter')] },
        { id: 'history', keys: ['↑', '↓'] },
        { id: 'commands', keys: ['/'] },
        { id: 'mention', keys: ['@'] },
      ],
    },
    {
      id: 'view',
      rows: [
        { id: 'zoom', keys: [primary('+'), primary('-')] },
        { id: 'resetZoom', keys: [primary('0')] },
      ],
    },
  ];
}

/** Open the sheet, or close it when it is open. */
export const toggleShortcutSheet = (): void => {
  emitter.emit('shortcuts.toggle');
};

const ShortcutSheet: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => shortcutGroups(), []);

  useAddEventListener('shortcuts.toggle', () => setOpen((value) => !value), []);

  return (
    <Modal
      visible={open}
      onCancel={() => setOpen(false)}
      title={null}
      footer={null}
      closable={false}
      alignCenter={false}
      unmountOnExit
      className={classNames(styles.palette, styles.sheet)}
      wrapClassName={styles.wrap}
      maskStyle={MASK_STYLE}
    >
      <div
        className={styles.sheetBody}
        data-testid='shortcut-sheet'
        role='document'
        aria-label={t('common.shortcuts.title')}
      >
        <div className={styles.sheetTitle}>{t('common.shortcuts.title')}</div>
        {groups.map((group) => (
          <section key={group.id} className={styles.sheetGroup} data-shortcut-group={group.id}>
            <h3 className={styles.groupLabel}>{t(`common.shortcuts.groups.${group.id}`)}</h3>
            <dl className={styles.sheetList}>
              {group.rows.map((row) => (
                <div key={row.id} className={styles.sheetRow} data-shortcut={row.id}>
                  <dt>{t(`common.shortcuts.rows.${row.id}`)}</dt>
                  <dd className={styles.sheetKeys}>
                    {row.keys.map((key, index) => (
                      <React.Fragment key={key}>
                        {index > 0 ? (
                          <span className={styles.sheetOr} aria-hidden='true'>
                            {row.range ? '…' : '/'}
                          </span>
                        ) : null}
                        <kbd className={styles.sheetKey}>{key}</kbd>
                      </React.Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
};

export default ShortcutSheet;
