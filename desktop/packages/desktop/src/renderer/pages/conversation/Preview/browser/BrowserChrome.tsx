import React, { useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Input, Menu } from '@arco-design/web-react';
import type { RefInputType } from '@arco-design/web-react/es/Input/interface';
import { Close, Earth, FullScreen, Left, Loading, OffScreen, Plus, Refresh, Right } from '@icon-park/react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { WebviewNavigationState } from '@/renderer/components/media/WebviewHost';
import type { BrowserTab } from './browserStore';
import { BROWSER_BLANK_URL, BROWSER_TAB_FALLBACK_TITLE, browserTabLabelFromUrl } from './constants';
import styles from './BrowserPanel.module.css';

export type BrowserChromeProps = {
  tabs: readonly BrowserTab[];
  activeTabId: string | null;
  /** The page in front: where it is and what its history allows; absent until it has reported. */
  navigation?: WebviewNavigationState;
  /** The address field, for focusing it when the person opens a blank page. */
  addressRef?: React.Ref<RefInputType>;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /** Close every page but this one (from its tab's right-click menu). */
  onCloseOthers: (tabId: string) => void;
  /** Copy the page's address (from its tab's right-click menu). */
  onCopyAddress: (tabId: string) => void;
  onNewPage: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  /** What the person typed into the address field, not yet resolved to an address. */
  onSubmit: (input: string) => void;
  maximized: boolean;
  /** Absent where the browser cannot fill the page (a phone's sheet): no button then. */
  onToggleMaximize?: () => void;
};

/**
 * A page's name on its tab: the page's own title, else its site, else the reader's "New tab". The stored "New Tab" of
 * an older build counts as no title (see `BROWSER_TAB_FALLBACK_TITLE`).
 */
export function browserPageTitle(tab: Pick<BrowserTab, 'title' | 'url'>, t: TFunction): string {
  if (tab.title && tab.title !== BROWSER_TAB_FALLBACK_TITLE) return tab.title;
  const site = browserTabLabelFromUrl(tab.url);
  return site === BROWSER_TAB_FALLBACK_TITLE ? t('preview.browser.newTab') : site;
}

/** The page's icon, or a globe while it has none or its icon does not load. */
function PageIcon({ favicon }: { favicon?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [favicon]);
  if (favicon && !broken)
    return <img src={favicon} alt='' className={styles.favicon} draggable={false} onError={() => setBroken(true)} />;
  return <Earth theme='outline' size={14} fill='currentColor' className={styles.globe} aria-hidden='true' />;
}

/**
 * The browser's chrome: its pages on one line (the new-page button at the end), and the address with back, forward
 * and reload for the page in front, under the pages or beside them as the width allows (`BrowserPanel.module.css`).
 * With no page open there is only the address line, and the address opens the first page. The field shows where the
 * page is; what the person types stays until they press Enter (an address, or words to search for), Escape or leave
 * the field. A right click on a page's tab offers to close it, to close the others, and to copy its address.
 */
export default function BrowserChrome({
  tabs,
  activeTabId,
  navigation,
  addressRef,
  onSelect,
  onClose,
  onCloseOthers,
  onCopyAddress,
  onNewPage,
  onBack,
  onForward,
  onReload,
  onSubmit,
  maximized,
  onToggleMaximize,
}: BrowserChromeProps) {
  const { t } = useTranslation();
  const active = tabs.find((tab) => tab.id === activeTabId);
  const where = navigation?.url ?? active?.url ?? '';
  const address = where === BROWSER_BLANK_URL ? '' : where;
  const [draft, setDraft] = useState<string | null>(null);
  const pageRow = useRef<HTMLDivElement>(null);
  // Another page in front: the field shows where that one is, and its tab comes into view in the row (the row
  // scrolls by itself: `scrollIntoView` would also shift the work panel and the page around it).
  useEffect(() => {
    setDraft(null);
    const row = pageRow.current;
    const tab = Array.from(row?.querySelectorAll<HTMLElement>('[data-browser-tab]') ?? []).find(
      (button) => button.dataset.browserTab === activeTabId
    )?.parentElement;
    if (!row || !tab) return;
    const bounds = row.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    if (box.left < bounds.left) row.scrollLeft -= bounds.left - box.left;
    else if (box.right > bounds.right) row.scrollLeft += box.right - bounds.right;
  }, [activeTabId]);

  const submit = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const input = (draft ?? address).trim();
    if (!input) return;
    onSubmit(input);
    setDraft(null);
    event.currentTarget.blur();
  };

  const maximizeLabel = maximized ? t('preview.restorePanel') : t('preview.maximizePanel');

  // A page's right-click menu. The Menu is the droplist's direct child, or Arco gives it the tall navigation look.
  const pageMenu = (tab: BrowserTab) => (
    <Menu
      onClickMenuItem={(key) => {
        if (key === 'close') onClose(tab.id);
        else if (key === 'closeOthers') onCloseOthers(tab.id);
        else if (key === 'copyAddress') onCopyAddress(tab.id);
      }}
    >
      <Menu.Item key='close'>{t('preview.close')}</Menu.Item>
      <Menu.Item key='closeOthers' disabled={tabs.length < 2}>
        {t('preview.closeOthers')}
      </Menu.Item>
      <div className={styles.pageMenuDivider} role='separator' aria-hidden='true' />
      {/* A blank page has no address to copy. */}
      <Menu.Item key='copyAddress' disabled={!tab.url || tab.url === BROWSER_BLANK_URL}>
        {t('preview.browser.copyAddress')}
      </Menu.Item>
    </Menu>
  );

  return (
    <div className={styles.chrome}>
      <div className={styles.bar} data-empty={tabs.length ? undefined : 'true'}>
        {tabs.length ? (
          <div
            ref={pageRow}
            className={styles.pages}
            aria-label={t('preview.browser.tabsLabel')}
            role='group'
            onWheel={(event) => {
              // A mouse wheel scrolls the row sideways, as the work panel's own tabs do.
              if (!event.deltaX) event.currentTarget.scrollLeft += event.deltaY;
            }}
          >
            {tabs.map((tab) => {
              const selected = tab.id === activeTabId;
              const title = browserPageTitle(tab, t);
              return (
                <Dropdown key={tab.id} trigger='contextMenu' position='bl' droplist={pageMenu(tab)}>
                  <div className={styles.page} data-active={selected ? 'true' : 'false'}>
                    <Button
                      type='text'
                      className={styles.pageButton}
                      aria-current={selected ? 'page' : undefined}
                      title={title}
                      data-browser-tab={tab.id}
                      onClick={() => onSelect(tab.id)}
                      onAuxClick={(event) => {
                        // A middle click closes the page, as in any browser.
                        if (event.button !== 1) return;
                        event.preventDefault();
                        onClose(tab.id);
                      }}
                    >
                      <PageIcon favicon={tab.favicon} />
                      <span className={styles.title}>{title}</span>
                      {tab.agentActive ? (
                        <span className={styles.driving} title={t('preview.browser.agentActiveTooltip')} />
                      ) : null}
                    </Button>
                    <Button
                      type='text'
                      size='mini'
                      className={styles.pageClose}
                      icon={<Close size={12} />}
                      aria-label={t('preview.browser.closeTab', { title })}
                      title={t('preview.browser.closeTab', { title })}
                      onClick={() => onClose(tab.id)}
                    />
                  </div>
                </Dropdown>
              );
            })}
            <Button
              type='text'
              size='mini'
              className={styles.newPage}
              icon={<Plus size={14} />}
              aria-label={t('preview.browser.newTab')}
              title={t('preview.browser.newTab')}
              onClick={onNewPage}
            />
          </div>
        ) : null}

        <div className={styles.address}>
          <Button
            type='text'
            size='small'
            className={styles.navButton}
            icon={<Left size={16} />}
            aria-label={t('common.historyBack')}
            title={t('common.historyBack')}
            disabled={!navigation?.canGoBack}
            onClick={onBack}
          />
          <Button
            type='text'
            size='small'
            className={styles.navButton}
            icon={<Right size={16} />}
            aria-label={t('common.forward')}
            title={t('common.forward')}
            disabled={!navigation?.canGoForward}
            onClick={onForward}
          />
          <Button
            type='text'
            size='small'
            className={styles.navButton}
            icon={navigation?.loading ? <Loading size={16} className={styles.spin} /> : <Refresh size={16} />}
            aria-label={t('common.refresh')}
            title={t('common.refresh')}
            disabled={!active}
            onClick={onReload}
          />
          <Input
            ref={addressRef}
            size='small'
            className={styles.field}
            value={draft ?? address}
            placeholder={t('preview.browser.addressPlaceholder')}
            aria-label={t('preview.browser.addressPlaceholder')}
            spellCheck={false}
            autoComplete='off'
            onChange={(value) => setDraft(value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => setDraft(null)}
            onPressEnter={submit}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              setDraft(null);
              event.currentTarget.blur();
            }}
          />
        </div>

        <div className={styles.actions}>
          {onToggleMaximize ? (
            <Button
              type='text'
              size='mini'
              className={styles.actionButton}
              icon={maximized ? <OffScreen size={14} /> : <FullScreen size={14} />}
              aria-label={maximizeLabel}
              title={maximizeLabel}
              aria-pressed={maximized}
              onClick={onToggleMaximize}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
