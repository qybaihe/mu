/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import AionInlineSearchInput from '@/renderer/components/base/AionInlineSearchInput';
import {
  DROPDOWN_SEARCH_THRESHOLD,
  RUNTIME_SUBMENU_TRIGGER_PROPS,
  RuntimeSelectorCheckedItem,
  thoughtLevelOptionLabel,
} from '@/renderer/components/agent/runtimeSelectorOptions';
import { Menu } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import React from 'react';
import type { MenuModel, MenuModelGroup } from './modelMenu';

type ModelLevelMenuProps = {
  /** The rows to show, by provider: already narrowed to the search. */
  groups: MenuModelGroup[];
  /** How many models there are in all: past a handful the menu gets a search box. */
  total: number;
  query: string;
  onQuery: (query: string) => void;
  /** The model in use, and the thinking level in force. */
  current?: string | null;
  level?: string | null;
  onPick: (model: string, level?: string) => void;
};

/**
 * The model · thinking menu, the same on the home page and in a conversation: every model by provider, and a model
 * that takes more than one level opens to its levels, so one pick sets both. A model with one level, or none known,
 * is picked as it is.
 *
 * A function that returns the `Menu`, not a component: Arco's `Dropdown` gives its popup look and its pop-out
 * submenus only to a `Menu` element it is handed directly, so a wrapper component would open as a bare inline menu.
 */
export function modelLevelMenu(
  t: TFunction,
  { groups, total, query, onQuery, current, level, onPick }: ModelLevelMenuProps
): React.ReactElement {
  const row = (entry: MenuModel) => {
    const inUse = entry.value === current;
    const name = (
      <RuntimeSelectorCheckedItem selected={inUse} description={entry.description}>
        {entry.label}
      </RuntimeSelectorCheckedItem>
    );
    if (entry.levels.length < 2) {
      return (
        <Menu.Item
          key={entry.value}
          data-testid='composer-model-option'
          data-value={entry.value}
          className={inUse ? 'bg-2!' : ''}
          onClick={() => onPick(entry.value)}
        >
          {name}
        </Menu.Item>
      );
    }
    const inForce = inUse ? entry.levels.find((candidate) => candidate.value === level) : undefined;
    return (
      <Menu.SubMenu
        key={entry.value}
        data-testid='composer-model-option'
        data-value={entry.value}
        triggerProps={RUNTIME_SUBMENU_TRIGGER_PROPS}
        title={
          <div className='flex items-center justify-between gap-8px w-full min-w-0'>
            {name}
            {inForce ? <span className='shrink-0 text-t-tertiary'>{thoughtLevelOptionLabel(t, inForce)}</span> : null}
          </div>
        }
      >
        <div
          data-testid='composer-thinking-note'
          className='model-level-note px-12px py-6px max-w-260px text-12px leading-16px text-t-tertiary whitespace-normal break-words'
        >
          {t('conversation.composer.thinkingNote')}
        </div>
        {entry.levels.map((option) => {
          const chosen = inUse && option.value === level;
          return (
            <Menu.Item
              key={JSON.stringify([entry.value, option.value])}
              data-testid='composer-level-option'
              data-value={option.value}
              className={chosen ? 'bg-2!' : ''}
              onClick={() => onPick(entry.value, option.value)}
            >
              <RuntimeSelectorCheckedItem selected={chosen}>
                {thoughtLevelOptionLabel(t, option)}
              </RuntimeSelectorCheckedItem>
            </Menu.Item>
          );
        })}
      </Menu.SubMenu>
    );
  };

  return (
    <Menu>
      {total > DROPDOWN_SEARCH_THRESHOLD ? (
        <div className='px-6px pt-4px pb-6px' style={{ background: 'var(--color-bg-popup)' }}>
          <AionInlineSearchInput
            value={query}
            onChange={onQuery}
            placeholder={t('agent.model.searchPlaceholder')}
            data-testid='composer-model-search'
          />
        </div>
      ) : null}
      <div className='dropdown-search-scroll max-h-320px overflow-y-auto'>
        {groups.length === 0 ? (
          <div className='px-12px py-10px text-12px text-t-tertiary text-center'>{t('agent.model.noResults')}</div>
        ) : (
          groups.flatMap((group) =>
            group.title
              ? [
                  <Menu.ItemGroup key={group.key} title={group.title}>
                    {group.models.map(row)}
                  </Menu.ItemGroup>,
                ]
              : group.models.map(row)
          )
        )}
      </div>
    </Menu>
  );
}
