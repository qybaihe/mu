/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import MuInlineSearchInput from '@/renderer/components/base/MuInlineSearchInput';
import {
  DROPDOWN_SEARCH_THRESHOLD,
  RuntimeSelectorCheckedItem,
  thoughtLevelOptionLabel,
} from '@/renderer/components/agent/runtimeSelectorOptions';
import { Menu, Radio, Tooltip } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import React from 'react';
import type { MenuLevel, MenuModel, MenuModelGroup } from './modelMenu';

/** The key of the row that shows every model, or the short list again: a click on it keeps the menu open. */
const SHOW_ALL_KEY = 'show-all-models';

type ModelLevelMenuProps = {
  /** The rows to show, by provider: already narrowed to the search, or to the short list (`visibleModelMenu`). */
  groups: MenuModelGroup[];
  /** How many models there are in all: past a handful the menu gets a search box. */
  total: number;
  query: string;
  onQuery: (query: string) => void;
  /** The model in use, and the thinking level in force. */
  current?: string | null;
  level?: string | null;
  /** The thinking levels the model in use takes (`levelsOf`): two or more, and the menu offers them under the list. */
  levels: MenuLevel[];
  onPick: (model: string, level?: string) => void;
  /** How many models the short list leaves out: above 0 (and with `onShowAll`), a row under the list toggles them. */
  hidden?: number;
  /** Every model is listed, not the short list. */
  showAll?: boolean;
  onShowAll?: (showAll: boolean) => void;
  /** The model new conversations start on: its row says so. */
  defaultModel?: string | null;
  /** Makes the model in use the default; offered under the list when it is not the default already. */
  onMakeDefault?: () => void;
};

/**
 * The model · thinking menu, the same on the home page and in a conversation: the models by provider in a list that
 * scrolls, and under it, always in view, the thinking levels of the model in use. A row switches the model; a level
 * switches the level. Before the person asks for all of them, the list holds the short list (`visibleModelMenu`).
 *
 * A function that returns the `Menu`, not a component: Arco's `Dropdown` gives its popup look only to a `Menu` element
 * it is handed directly, so a wrapper component would open as a bare inline menu.
 */
export function modelLevelMenu(
  t: TFunction,
  {
    groups,
    total,
    query,
    onQuery,
    current,
    level,
    levels,
    onPick,
    hidden = 0,
    showAll = false,
    onShowAll,
    defaultModel,
    onMakeDefault,
  }: ModelLevelMenuProps
): React.ReactElement {
  const row = (entry: MenuModel) => {
    const inUse = entry.value === current;
    return (
      <Menu.Item
        key={entry.value}
        data-testid='composer-model-option'
        data-value={entry.value}
        className={inUse ? 'bg-2!' : ''}
        onClick={() => onPick(entry.value)}
      >
        <RuntimeSelectorCheckedItem selected={inUse} description={entry.description}>
          {entry.label}
          {entry.value === defaultModel ? (
            <span data-testid='composer-model-default' className='ml-6px text-11px text-t-tertiary'>
              {t('conversation.composer.defaultTag')}
            </span>
          ) : null}
        </RuntimeSelectorCheckedItem>
      </Menu.Item>
    );
  };

  return (
    <Menu
      className='w-320px max-w-[calc(100vw-32px)]'
      // The row that toggles the short list keeps the menu open; any other click closes it.
      onClickMenuItem={(key: string) => (key === SHOW_ALL_KEY ? false : undefined)}
    >
      {total > DROPDOWN_SEARCH_THRESHOLD ? (
        <div className='px-6px pt-4px pb-6px' style={{ background: 'var(--color-bg-popup)' }}>
          <MuInlineSearchInput
            value={query}
            onChange={onQuery}
            placeholder={t('agent.model.searchPlaceholder')}
            data-testid='composer-model-search'
          />
        </div>
      ) : null}
      <div className='dropdown-search-scroll max-h-[min(300px,36vh)] overflow-y-auto'>
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
        {hidden > 0 && onShowAll ? (
          <Menu.Item
            key={SHOW_ALL_KEY}
            data-testid='composer-model-show-all'
            data-show-all={showAll ? 'true' : 'false'}
            onClick={() => onShowAll(!showAll)}
          >
            <span className='pl-24px text-12px text-t-secondary'>
              {showAll
                ? t('conversation.composer.showFewerModels')
                : t('conversation.composer.showAllModels', { count: total })}
            </span>
          </Menu.Item>
        ) : null}
      </div>
      {current && levels.length > 1 ? (
        // Outside the list that scrolls: the levels stay in view however long the list is.
        <div
          data-testid='composer-thinking'
          className='mt-4px px-12px pt-8px pb-6px border-0 border-t border-solid border-[var(--color-border-2)]'
        >
          <div className='mb-6px text-12px leading-16px text-t-secondary'>
            {/* Why to switch seldom, on hover: a switch clears the prompt cache. */}
            <Tooltip content={t('conversation.composer.thinkingNote')} position='top'>
              <span
                data-testid='composer-thinking-note'
                className='cursor-help underline decoration-dotted underline-offset-3'
              >
                {t('agent.thoughtLevel.label')}
              </span>
            </Tooltip>
          </div>
          <Radio.Group
            type='button'
            size='mini'
            // Narrower buttons than Arco's: five levels fit on one line in most languages, and the rest wrap.
            className='[&_.arco-radio-button-inner]:px-8px'
            aria-label={t('agent.thoughtLevel.label')}
            value={level ?? undefined}
            onChange={(value: string) => onPick(current, value)}
          >
            {levels.map((option) => (
              <Radio
                key={option.value}
                value={option.value}
                data-testid='composer-level-option'
                data-value={option.value}
              >
                {thoughtLevelOptionLabel(t, option)}
              </Radio>
            ))}
          </Radio.Group>
        </div>
      ) : null}
      {onMakeDefault && current && current !== defaultModel ? (
        <div className='mt-4px pt-4px border-0 border-t border-solid border-[var(--color-border-2)]'>
          <Menu.Item key='make-default' data-testid='composer-make-default' onClick={onMakeDefault}>
            <span className='pl-24px text-12px text-t-secondary'>{t('conversation.composer.makeDefault')}</span>
          </Menu.Item>
        </div>
      ) : null}
    </Menu>
  );
}
