/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Input } from '@arco-design/web-react';
import { Search } from '@icon-park/react';
import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIndexedItemRefs } from '@/renderer/hooks/ui/useIndexedItemRefs';
import { formatPrimaryShortcut, MESSAGE_SEARCH_SHORTCUT } from '@/renderer/utils/ui/keyboardShortcuts';
import { splitByHits, type PaletteItem } from './paletteGroups';
import { usePaletteGroups } from './usePaletteGroups';
import { usePaletteNavigation } from './usePaletteNavigation';
import styles from './CommandPalette.module.css';

/** A label with the characters the query matched underlined. */
const MatchedLabel: React.FC<{ text: string; hits: number[] }> = ({ text, hits }) => {
  if (hits.length === 0) return <>{text}</>;
  return (
    <>
      {splitByHits(text, hits).map((segment, index) =>
        segment.hit ? (
          <span key={index} className={styles.hit} data-hit=''>
            {segment.text}
          </span>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        )
      )}
    </>
  );
};

/**
 * The palette's content: one input and the rows under it, grouped. It mounts each time the palette opens, so every
 * opening starts from an empty query.
 */
const CommandPalettePanel: React.FC<{ onRun: (item: PaletteItem) => void }> = ({ onRun }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const groups = usePaletteGroups(query);
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const { activeIndex, setActiveIndex, onKeyDown } = usePaletteNavigation(items, query, onRun);
  const { itemRefs, setItemRef } = useIndexedItemRefs<HTMLDivElement>(items.length);
  const listId = useId();

  // Where each group's rows start in the flat list that the arrow keys walk.
  const sections = useMemo(() => {
    let start = 0;
    return groups.map((group) => {
      const section = { group, start };
      start += group.items.length;
      return section;
    });
  }, [groups]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, itemRefs]);

  const title = t('common.commandPalette.title');
  const messageSearchShortcut = formatPrimaryShortcut(MESSAGE_SEARCH_SHORTCUT);
  // Nothing typed and no conversation to list yet: a quiet line says why the list starts with the settings.
  const noConversations = query.trim() === '' && !groups.some((group) => group.id === 'conversations');

  return (
    <div data-testid='command-palette'>
      <div className={styles.field}>
        <Input
          autoFocus
          value={query}
          onChange={setQuery}
          onKeyDown={onKeyDown}
          placeholder={t('common.commandPalette.placeholder')}
          prefix={<Search theme='outline' size='16' fill='currentColor' />}
          role='combobox'
          aria-label={title}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete='list'
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        />
      </div>
      <div id={listId} role='listbox' aria-label={title} className={styles.list}>
        {sections.map(({ group, start }) => (
          <div key={group.id} role='group' aria-label={group.label || undefined} data-palette-group={group.id}>
            {group.label ? (
              <div className={styles.groupLabel} aria-hidden='true'>
                {group.label}
              </div>
            ) : start > 0 ? (
              <div className={styles.divider} aria-hidden='true' />
            ) : null}
            {group.items.map((item, offset) => {
              const index = start + offset;
              return (
                <div
                  key={item.key}
                  ref={setItemRef(index)}
                  id={`${listId}-${index}`}
                  role='option'
                  aria-selected={index === activeIndex}
                  data-kind={item.kind}
                  className={styles.row}
                  onMouseMove={() => {
                    if (index !== activeIndex) setActiveIndex(index);
                  }}
                  // The input keeps the focus, so the keys keep working after a click.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onRun(item)}
                >
                  <span className={styles.label}>
                    <MatchedLabel text={item.label} hits={item.hits} />
                  </span>
                  {(item.kind === 'command' || item.kind === 'conversation') && item.detail ? (
                    <span className={styles.detail}>{item.detail}</span>
                  ) : null}
                  {item.kind === 'conversation' ? <span className={styles.meta}>{item.time}</span> : null}
                  {item.kind === 'messages' ? <span className={styles.meta}>{messageSearchShortcut}</span> : null}
                </div>
              );
            })}
          </div>
        ))}
        {items.length === 0 ? <div className={styles.empty}>{t('common.commandPalette.empty')}</div> : null}
        {noConversations ? (
          <div className={styles.hint} data-testid='command-palette-hint'>
            {t('common.commandPalette.noConversations')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default CommandPalettePanel;
