import FlexFullContainer from '@/renderer/components/layout/FlexFullContainer';
import { resolveExtensionAssetUrl } from '@/renderer/utils/platform';
import { type IExtensionSettingsTab } from '@/common/adapter/ipcBridge';
import { useExtI18n } from '@/renderer/hooks/system/useExtI18n';
import { useExtensionSettingsTabs } from '@/renderer/hooks/system/useExtensionSettingsTabs';
import { Puzzle, Search } from '@icon-park/react';
import classNames from 'classnames';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Input, Tooltip } from '@arco-design/web-react';
import { getSiderTooltipProps } from '@/renderer/utils/ui/siderTooltip';
import { rowButtonProps } from '@/renderer/utils/ui/rowButton';
import { useNativeEnabled } from '@/renderer/pages/native/hooks/useNativeConversations';
import {
  SETTINGS_ANCHOR_REMAP,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  isSettingsPageListed,
  isSettingsRouteActive,
  settingsPageLabelKey,
  settingsPageRailLabelKey,
  type SettingsGroupId,
  type SettingsPage,
} from '../settingsNav';
import { searchSettings, useSearchManifest, type SettingsHit } from './settingsSearch';

/** Every built-in settings page, in rail order (must match the router paths). */
export const BUILTIN_TAB_IDS = SETTINGS_PAGES.map((page) => page.id);

/**
 * Anchors extensions used before the settings had their current pages. An extension that anchored itself to a page
 * that is now part of another one is placed next to the page that took it over, so it keeps working untouched.
 */
export const LEGACY_ANCHOR_REMAP: Record<string, string> = SETTINGS_ANCHOR_REMAP;

/** Where an extension that names no anchor goes: at the end of the capabilities, the things mu can reach for. */
const UNANCHORED_GROUP: SettingsGroupId = 'capabilities';

export type SettingsNavItem = {
  id: string;
  /** The page's whole name: the tooltip of the folded rail, and the phone's row of chips. */
  label: string;
  /** What the rail's row says under its group's header; the whole name when the page has no shorter one. */
  railLabel: string;
  /** The icon component: a built-in page's, or an extension's image. */
  icon: React.ReactElement;
  isImageIcon?: boolean;
  /** Route path segment — for builtins: `/settings/{path}`, for extensions: `/settings/ext/{id}` */
  path: string;
};

export type SettingsNavGroup = { id: SettingsGroupId; label: string; items: SettingsNavItem[] };

/**
 * The settings navigation as groups of entries: the built-in pages of `settingsNav.ts`, with extension tabs placed
 * before or after the page they anchor to, and unanchored ones at the end of the capabilities. The rail and the
 * mobile top navigation both draw this list. While mu runs inside the app, the pages of the classic mode's own
 * storage are left out, and a page that then shows something else has that name.
 */
export function useSettingsNav(): SettingsNavGroup[] {
  const { t } = useTranslation();
  const extensionTabs = useExtensionSettingsTabs();
  const { resolveExtTabName } = useExtI18n();
  const native = useNativeEnabled() === true;

  return useMemo(() => {
    const groups: SettingsNavGroup[] = SETTINGS_GROUPS.map(({ id, labelKey }) => ({
      id,
      label: t(labelKey),
      items: SETTINGS_PAGES.filter((page) => page.group === id && isSettingsPageListed(page, native)).map(
        (page: SettingsPage) => ({
          id: page.id,
          label: t(settingsPageLabelKey(page, native)),
          railLabel: t(settingsPageRailLabelKey(page, native)),
          icon: React.createElement(page.Icon as React.ComponentType),
          path: page.path,
        })
      ),
    }));

    const toItem = (tab: IExtensionSettingsTab): SettingsNavItem => {
      const resolvedIcon = resolveExtensionAssetUrl(tab.icon) || tab.icon;
      const label = resolveExtTabName(tab);
      return {
        id: tab.id,
        label,
        railLabel: label,
        icon: resolvedIcon ? <img src={resolvedIcon} alt='' className='w-full h-full object-contain' /> : <Puzzle />,
        isImageIcon: Boolean(resolvedIcon),
        path: `ext/${tab.id}`,
      };
    };

    const unanchored: IExtensionSettingsTab[] = [];
    for (const tab of extensionTabs) {
      const anchor = tab.position ? (LEGACY_ANCHOR_REMAP[tab.position.relativeTo] ?? tab.position.relativeTo) : '';
      const group = groups.find((each) => each.items.some((item) => item.id === anchor));
      if (!tab.position || !group) {
        unanchored.push(tab);
        continue;
      }
      const at = group.items.findIndex((item) => item.id === anchor);
      // Each tab goes right next to its anchor; later ones of the same side stay after earlier ones.
      let index = tab.position.placement === 'before' ? at : at + 1;
      while (
        tab.position.placement === 'after' &&
        index < group.items.length &&
        group.items[index].path.startsWith('ext/')
      )
        index += 1;
      group.items.splice(index, 0, toItem(tab));
    }
    groups.find((group) => group.id === UNANCHORED_GROUP)?.items.push(...unanchored.map(toItem));
    return groups;
  }, [t, extensionTabs, resolveExtTabName, native]);
}

/**
 * The settings rail: a search box over every page, then six groups under small grey headers, whitespace between them
 * and no lines. The page shown is marked by weight alone: its row reads in the body colour and bold, the others in
 * grey, with no fill and no accent. A row says only what its group's header leaves out ("Context" under "Details");
 * collapsed, only the icons remain, and each tooltip gives the whole name. The rail is taller than most windows, so
 * whenever the page changes (a click, the palette, a link) the rail scrolls just far enough to show that page's row.
 *
 * Typing in the search box puts what it finds in place of the groups: pages by their names and the texts on them, and
 * every feature and decision point by what the harness calls it, each leading to its row. Esc clears it.
 */
const SettingsSider: React.FC<{ collapsed?: boolean; tooltipEnabled?: boolean }> = ({
  collapsed = false,
  tooltipEnabled = false,
}) => {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { pathname, search } = useLocation();
  const groups = useSettingsNav();
  const siderTooltipProps = getSiderTooltipProps(tooltipEnabled);
  const rail = useRef<HTMLElement>(null);
  const [query, setQuery] = useState('');
  const searching = !collapsed && query.trim() !== '';
  const manifest = useSearchManifest(searching);
  const native = useNativeEnabled() === true;
  const hits = useMemo(
    () => (searching ? searchSettings(query, t, i18n.language, manifest, native) : []),
    [searching, query, t, i18n.language, manifest, native]
  );

  useEffect(() => {
    rail.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [pathname, groups]);

  const go = (path: string) => {
    Promise.resolve(navigate(path, { replace: true })).catch((error) => {
      console.error('Navigation failed:', error);
    });
  };

  return (
    <div className='h-full flex flex-col min-h-0'>
      {collapsed ? null : (
        <div className='settings-sider__search shrink-0 pb-8px'>
          <Input
            size='small'
            allowClear
            prefix={<Search theme='outline' size='14' />}
            aria-label={t('settings.search.placeholder')}
            placeholder={t('settings.search.placeholder')}
            value={query}
            onChange={setQuery}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('');
              else if (event.key === 'Enter' && hits[0]) go(hits[0].path);
            }}
          />
        </div>
      )}
      <nav
        ref={rail}
        className={classNames('flex-1 min-h-0 settings-sider flex flex-col overflow-y-auto overflow-x-hidden pb-8px', {
          'settings-sider--collapsed': collapsed,
        })}
        aria-label={t('settings.title')}
      >
        {searching ? (
          <SearchHits hits={hits} here={`${pathname}${search}`} onOpen={go} empty={t('settings.search.empty')} />
        ) : (
          groups.map((group, index) => (
            <div
              key={group.id}
              role='group'
              aria-label={group.label}
              data-settings-group={group.id}
              className={classNames('settings-sider__group flex flex-col gap-2px shrink-0', index > 0 && 'mt-10px')}
            >
              {/* Collapsed, the header goes and the margin alone keeps the groups apart. */}
              <div className='settings-sider__group-header collapsed-hidden h-24px px-8px flex items-end pb-4px text-11px font-[500] lh-16px text-t-tertiary text-nowrap overflow-hidden'>
                {group.label}
              </div>
              {group.items.map((item) => {
                const isSelected = isSettingsRouteActive(pathname, `/settings/${item.path}`);
                return (
                  <Tooltip key={item.id} {...siderTooltipProps} content={item.label} position='right'>
                    {/* A button for the keyboard too: Tab reaches every page, Enter or Space opens it. Named by the page's
                    whole name, which the folded rail does not show. */}
                    <div
                      data-settings-id={item.id}
                      data-settings-path={item.path}
                      aria-current={isSelected ? 'page' : undefined}
                      aria-label={item.label}
                      className={classNames(
                        'settings-sider__item h-32px rd-6px flex items-center gap-8px group cursor-pointer relative overflow-hidden shrink-0 transition-colors',
                        collapsed ? 'w-full justify-center px-0' : 'justify-start px-8px',
                        { 'hover:bg-fill-1': !isSelected }
                      )}
                      {...rowButtonProps(() => go(`/settings/${item.path}`))}
                    >
                      {/* Leading icon — 22px slot to align with main sider rows */}
                      <span className='size-22px flex items-center justify-center shrink-0 line-height-0'>
                        {item.isImageIcon ? (
                          <span className='w-16px h-16px flex items-center justify-center'>{item.icon}</span>
                        ) : (
                          React.cloneElement(
                            item.icon as React.ReactElement<{
                              theme?: string;
                              size?: string | number;
                              className?: string;
                              strokeWidth?: number;
                            }>,
                            {
                              theme: 'outline',
                              size: '16',
                              strokeWidth: 3,
                              className: classNames(
                                'block leading-none',
                                isSelected ? 'text-t-primary' : 'text-t-tertiary'
                              ),
                            }
                          )
                        )}
                      </span>
                      <FlexFullContainer className='h-24px collapsed-hidden'>
                        <div
                          className={classNames(
                            'settings-sider__item-label text-nowrap overflow-hidden inline-block w-full text-13px lh-24px whitespace-nowrap',
                            isSelected
                              ? 'font-600 text-t-primary'
                              : 'font-400 text-t-secondary group-hover:text-t-primary'
                          )}
                        >
                          {item.railLabel}
                        </div>
                      </FlexFullContainer>
                    </div>
                  </Tooltip>
                );
              })}
            </div>
          ))
        )}
      </nav>
    </div>
  );
};

type SearchHitsProps = {
  hits: SettingsHit[];
  /** The route shown, query included: the hit that leads there is marked as the rail marks its page. */
  here: string;
  onOpen: (path: string) => void;
  empty: string;
};

/** What the rail's search found, in place of the groups: a row each, its name and under it where it is. */
function SearchHits({ hits, here, onOpen, empty }: SearchHitsProps) {
  const { t } = useTranslation();
  if (!hits.length) return <div className='px-8px py-12px text-12px lh-18px text-t-tertiary'>{empty}</div>;
  return (
    <div role='group' aria-label={t('settings.search.results')} className='flex flex-col gap-2px'>
      {hits.map((hit) => {
        const isSelected = hit.path === here;
        return (
          <div
            key={hit.key}
            data-settings-hit={hit.key}
            aria-current={isSelected ? 'page' : undefined}
            className={classNames(
              'settings-sider__item rd-6px flex flex-col justify-center px-8px py-4px cursor-pointer shrink-0 transition-colors',
              { 'hover:bg-fill-1': !isSelected }
            )}
            {...rowButtonProps(() => onOpen(hit.path))}
          >
            <span
              className={classNames(
                'text-13px lh-20px truncate',
                isSelected ? 'font-600 text-t-primary' : 'font-400 text-t-secondary'
              )}
            >
              {hit.label}
            </span>
            <span className='text-11px lh-16px text-t-tertiary truncate'>{hit.where}</span>
          </div>
        );
      })}
    </div>
  );
}

export default SettingsSider;
