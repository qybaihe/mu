/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback } from 'react';
import WebviewHost, {
  type PageConsoleEntry,
  type WebviewNavigation,
  type WebviewNavigationState,
} from '@/renderer/components/media/WebviewHost';
import { clearPageConsole, notePageConsole } from './browserStore';
import {
  BROWSER_BLANK_URL,
  BROWSER_SESSION_PARTITION,
  browserTabLabelFromUrl,
  resolveAddressBarInput,
} from './constants';

export interface BrowserViewerProps {
  /** 该 tab 当前地址 / Current address of this tab */
  url: string;
  /** 所属 preview tab 的 id / Id of the owning preview tab */
  tabId: string;
  /** 地址变化时回写 tab（用于持久化）/ Persist the new address back onto the tab */
  onUrlChange: (tabId: string, url: string) => void;
  /** 页面标题变化时回写 tab / Persist the page title back onto the tab */
  onTitleChange: (tabId: string, title: string) => void;
  /** 站点图标变化时回写 tab / Persist the site favicon back onto the tab */
  onFaviconChange: (tabId: string, favicon: string) => void;
  /** Session partition of this tab. Defaults to the shared browser partition. */
  partition?: string;
  /** See WebviewHost: takes over the webContents report for a tab that is driven by someone else. */
  onWebContentsReady?: (webContentsId: number, webview: Electron.WebviewTag) => void;
  /** See WebviewHost: the page keeps its own links and forms. */
  pristine?: boolean;
  /**
   * The page's navigation state as it changes, for the browser's one address bar above its pages. Without it the
   * page draws its own bar (see WebviewHost).
   */
  onNavigationChange?: (tabId: string, state: WebviewNavigationState) => void;
  /** Filled with the page's navigation controls, for the same address bar. */
  navigationRef?: React.Ref<WebviewNavigation>;
}

/**
 * 应用内浏览器视图 / In-app browser view.
 *
 * 在 WebviewHost 之上多做三件事：
 * 1. 使用共享的持久化 partition，登录态跨 tab / 跨项目保留；
 * 2. 地址栏支持「输入关键词直接搜索」，不只是补 https://；
 * 3. 把地址 / 标题 / 图标回写给 tab，使会话重启后能恢复。
 *
 * Adds three things to the bare WebviewHost: a shared persistent partition
 * (sign-in survives), keyword search in the address bar, and writing
 * address/title/favicon back onto the owning tab so the browser can be restored
 * after a restart. In the work panel's browser the address bar is the browser's
 * own, above all its pages (`onNavigationChange`). The page's console warnings and
 * errors since it loaded are kept for the tab (`browserStore.ts`), for the person
 * to send to mu.
 */
const BrowserViewer: React.FC<BrowserViewerProps> = ({
  url,
  tabId,
  onUrlChange,
  onTitleChange,
  onFaviconChange,
  partition = BROWSER_SESSION_PARTITION,
  onWebContentsReady,
  pristine,
  onNavigationChange,
  navigationRef,
}) => {
  const handleUrlChange = useCallback((next: string) => onUrlChange(tabId, next), [tabId, onUrlChange]);

  const handleNavigationChange = useCallback(
    (state: WebviewNavigationState) => onNavigationChange?.(tabId, state),
    [tabId, onNavigationChange]
  );

  const handleTitleChange = useCallback(
    (title: string) => {
      const trimmed = title.trim();
      if (trimmed) onTitleChange(tabId, trimmed);
    },
    [tabId, onTitleChange]
  );

  const handleFaviconChange = useCallback(
    (favicon: string) => onFaviconChange(tabId, favicon),
    [tabId, onFaviconChange]
  );

  const handleConsoleMessage = useCallback((entry: PageConsoleEntry) => notePageConsole(tabId, entry), [tabId]);
  const handleNewDocument = useCallback(() => clearPageConsole(tabId), [tabId]);

  /**
   * about:blank 不会触发 page-title-updated，所以空白页的标题在这里兜底，
   * 否则新建 tab 会一直显示上一次的标题。
   * about:blank fires no title event, so derive the label here — otherwise a
   * fresh tab would keep showing the previous page's title.
   */
  const handleDidFinishLoad = useCallback(() => {
    if (url === BROWSER_BLANK_URL) onTitleChange(tabId, browserTabLabelFromUrl(url));
  }, [url, tabId, onTitleChange]);

  // The page's canvas is white, as in any browser: the webview is transparent where a page paints no background of its
  // own, and on the app's dark background such a page's default black text could not be read.
  return (
    <WebviewHost
      url={url || BROWSER_BLANK_URL}
      partition={partition}
      showNavBar
      className='bg-white'
      resolveUrlInput={resolveAddressBarInput}
      onUrlChange={handleUrlChange}
      onTitleChange={handleTitleChange}
      onFaviconChange={handleFaviconChange}
      onDidFinishLoad={handleDidFinishLoad}
      onWebContentsReady={onWebContentsReady}
      pristine={pristine}
      onNavigationChange={onNavigationChange ? handleNavigationChange : undefined}
      navigationRef={navigationRef}
      onConsoleMessage={handleConsoleMessage}
      onNewDocument={handleNewDocument}
    />
  );
};

export default BrowserViewer;
