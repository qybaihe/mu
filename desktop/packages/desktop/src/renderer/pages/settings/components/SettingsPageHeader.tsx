/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SettingsPageHeader — the shared header paradigm for settings pages.
 *
 * Layout (top to bottom):
 *   1. Title row: page title + description on the left, action slot on the right.
 *   2. Tabs (optional): underline tabs with an optional count badge.
 *
 * Pages own everything below the header (their list/content). This keeps the
 * title sizing, description, action placement, tab styling and responsive
 * breakpoints identical across Agents / Skills / Tools.
 */

import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useInRouterContext, useLocation } from 'react-router-dom';
import { SETTINGS_GROUPS, SETTINGS_PAGES, isSettingsRouteActive } from '../settingsNav';
import SettingsPageWrapper, { SETTINGS_PAGE_STICKY_TOP } from './SettingsPageWrapper';

export type SettingsPageTab = {
  key: string;
  label: string;
  /** Optional count badge shown after the label. */
  count?: number;
};

type SettingsPageHeaderProps = {
  title: React.ReactNode;
  /** Secondary description under the title; may contain inline links. */
  description?: React.ReactNode;
  /** Right-aligned action slot (search, create button, dropdowns, …). */
  actions?: React.ReactNode;
  tabs?: SettingsPageTab[];
  activeTab?: string;
  onTabChange?: (key: string) => void;
  /** Disable sticky behavior when the caller renders a fixed header outside its scroll body. */
  sticky?: boolean;
  /** Extra testid for the whole header block. */
  'data-testid'?: string;
};

/**
 * The small mono line above a settings page's title: the rail's group the page is in ("Kernel"), or "Settings" for a
 * page the rail lists elsewhere (an extension's). Drawn from an attribute, so the title block's text and what a screen
 * reader says stay the page's own; the rail already says the group.
 */
const GroupEyebrow: React.FC = () => {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  if (!pathname.startsWith('/settings/')) return null;
  const page = SETTINGS_PAGES.find((each) => isSettingsRouteActive(pathname, each.route));
  const group = page && SETTINGS_GROUPS.find((each) => each.id === page.group);
  return (
    <div
      className='settings-page-eyebrow'
      data-testid='settings-page-group'
      data-group={page?.group}
      data-label={t(group ? group.labelKey : 'settings.title')}
      aria-hidden='true'
    />
  );
};

const SettingsPageHeader: React.FC<SettingsPageHeaderProps> = ({
  title,
  description,
  actions,
  tabs,
  activeTab,
  onTabChange,
  sticky = true,
  'data-testid': dataTestId,
}) => {
  const inRouter = useInRouterContext();
  return (
    <div
      data-testid={dataTestId}
      className={classNames(
        'settings-page-header',
        sticky && ['settings-page-header--sticky sticky top-0 z-10', SETTINGS_PAGE_STICKY_TOP]
      )}
    >
      {inRouter ? <GroupEyebrow /> : null}
      {/* As tall as a search box or a button, with or without them: the title sits at one height on every page. */}
      <div className='flex min-h-34px items-center justify-between gap-8px sm:gap-16px'>
        <h1 className='settings-page-title m-0 min-w-0 flex-1 text-20px md:text-22px font-600 text-t-primary'>
          {title}
        </h1>
        {actions ? <div className='shrink-0 flex flex-wrap items-center justify-end gap-8px'>{actions}</div> : null}
      </div>
      {description ? (
        // No last line of one or two characters (a CJK widow such as 准。): the lines are evened out. `pretty` leaves a
        // Chinese ending as it is, so the short texts under a title are balanced.
        <p className='m-0 mt-8px text-13px leading-relaxed text-t-secondary' style={{ textWrap: 'balance' }}>
          {description}
        </p>
      ) : null}

      {tabs && tabs.length > 0 ? (
        <div className='mt-16px flex gap-24px border-b border-border-2' role='tablist'>
          {tabs.map((tab) => {
            const isActive = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                type='button'
                role='tab'
                aria-selected={isActive}
                data-testid={`settings-tab-${tab.key}`}
                onClick={() => onTabChange?.(tab.key)}
                className={classNames(
                  'relative inline-flex cursor-pointer items-center border-none bg-transparent px-2px pb-12px text-14px leading-none transition-colors',
                  isActive ? 'font-600 text-t-primary' : 'font-500 text-t-tertiary hover:text-t-secondary'
                )}
              >
                <span>{tab.label}</span>
                {/* Greys only: the tab shown is told by its weight, its count's darker grey and the line under it. */}
                {typeof tab.count === 'number' ? (
                  <span
                    className={classNames(
                      'ms-6px inline-flex h-16px min-w-16px items-center justify-center rounded-999px px-5px text-10px font-500 leading-none bg-fill-2',
                      isActive ? 'text-t-secondary' : 'text-t-quaternary'
                    )}
                  >
                    {tab.count}
                  </span>
                ) : null}
                {isActive ? <span className='absolute inset-x-0 -bottom-1px h-2px rounded-2px bg-t-primary' /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

export default SettingsPageHeader;

type SettingsPageProps = {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** On the column that holds the header and the page's panels. */
  'data-testid'?: string;
  children: React.ReactNode;
};

/**
 * One short page of the settings rail: the page frame, the title, then the page's panels. Pages with a layout of their
 * own (skills, assistants, archived) draw the header themselves, in the same frame.
 */
export const SettingsPage: React.FC<SettingsPageProps> = ({
  title,
  description,
  actions,
  'data-testid': dataTestId,
  children,
}) => (
  <SettingsPageWrapper>
    <div className='flex flex-col gap-16px' data-testid={dataTestId}>
      <SettingsPageHeader sticky={false} title={title} description={description} actions={actions} />
      {children}
    </div>
  </SettingsPageWrapper>
);
