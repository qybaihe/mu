/**
 * The work panel's 浏览器 tab as the person uses it: its pages as tabs, one address field for the page in front (an
 * address or words to search for), back, forward and reload, a new blank page, closing, each tab's right-click menu,
 * and filling the page.
 * jsdom has no `<webview>`: each page is a stand-in that reports its navigation and records the controls it gets.
 */

import React, { useEffect, useImperativeHandle } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import preview from '@/renderer/services/i18n/locales/en-US/preview.json';

type Navigation = { url: string; canGoBack: boolean; canGoForward: boolean; loading: boolean };
type Controls = { back: () => void; forward: () => void; reload: () => void; go: (url: string) => void };

const pages = vi.hoisted(() => ({
  /** Each page by the address it opened at: its partition, how it reports, and the controls it was given. */
  byUrl: new Map<string, { partition?: string; report: (state: Navigation) => void; controls: Controls }>(),
}));
const { copyTextMock } = vi.hoisted(() => ({ copyTextMock: vi.fn() }));

vi.mock('@/renderer/components/media/WebviewHost', () => ({
  default: function FakeWebview(props: {
    url: string;
    partition?: string;
    onNavigationChange?: (state: Navigation) => void;
    navigationRef?: React.Ref<Controls>;
  }) {
    const [controls] = React.useState<Controls>(() => ({
      back: vi.fn(),
      forward: vi.fn(),
      reload: vi.fn(),
      go: vi.fn(),
    }));
    useImperativeHandle(props.navigationRef, () => controls, [controls]);
    useEffect(() => {
      const report = (state: Navigation) => props.onNavigationChange?.(state);
      pages.byUrl.set(props.url, { partition: props.partition, report, controls });
      report({ url: props.url, canGoBack: false, canGoForward: false, loading: false });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.url]);
    return <div data-testid='webview' data-url={props.url} />;
  },
}));
vi.mock('@/common/kyrn/browserBridge', () => ({
  kyrnBrowserBridge: {
    events: { on: () => () => undefined },
    snapshot: { invoke: async () => [] },
    ready: { invoke: vi.fn(async () => undefined) },
    control: { invoke: vi.fn() },
  },
}));
vi.mock('@/renderer/utils/platform', () => ({ isMacOS: () => true, isElectronDesktop: () => true }));
vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: copyTextMock }));

import BrowserPanel from '@/renderer/pages/conversation/Preview/browser/BrowserPanel';
import {
  browserNow,
  markBrowserAgentActive,
  openBrowserPage,
  resetBrowserStoreForTest,
  switchBrowserTab,
  updateBrowserTab,
} from '@/renderer/pages/conversation/Preview/browser/browserStore';
import { MAX_BROWSER_TABS } from '@/renderer/pages/conversation/Preview/browser/constants';
import { BROWSER_PARTITION } from '@/common/platform/legacyNames';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { common, preview } } },
    interpolation: { escapeValue: false },
  });
});

const show = (props: { maximized?: boolean; onToggleMaximize?: () => void } = {}) =>
  render(
    <I18nextProvider i18n={i18n}>
      <BrowserPanel maximized={props.maximized ?? false} onToggleMaximize={props.onToggleMaximize} />
    </I18nextProvider>
  );

const address = () => screen.getByRole('textbox', { name: preview.browser.addressPlaceholder }) as HTMLInputElement;
const type = (text: string) => {
  fireEvent.focus(address());
  fireEvent.change(address(), { target: { value: text } });
};
const enter = () => fireEvent.keyDown(address(), { key: 'Enter', keyCode: 13, which: 13 });
const pageTabs = () => within(screen.getByRole('group', { name: preview.browser.tabsLabel }));
const page = (name: string) => pageTabs().getByRole('button', { name });
const open = (url?: string) => {
  let id: string | null = null;
  act(() => {
    id = openBrowserPage(url);
  });
  return id as unknown as string;
};

beforeEach(() => {
  localStorage.clear();
  resetBrowserStoreForTest();
  pages.byUrl.clear();
  copyTextMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the browser with no page open', () => {
  it('says how to open one, and opens a page at the address typed', () => {
    show();
    expect(screen.getByText(common.workPanel.browserEmpty)).toBeInTheDocument();
    expect(screen.queryByTestId('webview')).not.toBeInTheDocument();
    // One line: the address opens the first page, so there is no row of pages and no plus yet.
    expect(screen.queryByRole('group', { name: preview.browser.tabsLabel })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: preview.browser.newTab })).not.toBeInTheDocument();

    type('example.com');
    enter();
    expect(browserNow().tabs.map((tab) => tab.url)).toEqual(['https://example.com']);
    expect(screen.queryByText(common.workPanel.browserEmpty)).not.toBeInTheDocument();
    expect(screen.getByTestId('webview')).toHaveAttribute('data-url', 'https://example.com');
  });

  it('searches for words typed into the address field', () => {
    show();
    type('how to cook rice');
    enter();
    expect(browserNow().tabs[0].url).toBe('https://www.bing.com/search?q=how%20to%20cook%20rice');
  });
});

describe('the browser’s pages', () => {
  it('opens a blank page with the plus, the address field ready for typing', async () => {
    vi.useFakeTimers();
    open('https://a.test/');
    show();
    fireEvent.click(screen.getByRole('button', { name: preview.browser.newTab }));
    expect(browserNow().tabs.map((tab) => tab.url)).toEqual(['https://a.test/', 'about:blank']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(document.activeElement).toBe(address());
    // A blank page shows no address, only the hint; its tab is the reader's "New tab", like the plus beside it.
    expect(address().value).toBe('');
    expect(pageTabs().getByRole('button', { current: 'page' })).toHaveTextContent(preview.browser.newTab);
  });

  it('shows each page as a tab by its title, else its site, the one in front marked, and switches on a click', () => {
    const first = open('https://docs.example.com/guide');
    open('https://second.test/');
    act(() => updateBrowserTab(first, { title: 'The guide' }));
    show();
    expect(pageTabs().getAllByRole('button', { current: 'page' })).toHaveLength(1);
    expect(page('second.test')).toHaveAttribute('aria-current', 'page');

    fireEvent.click(page('The guide'));
    expect(browserNow().activeTabId).toBe(first);
    expect(page('The guide')).toHaveAttribute('aria-current', 'page');
    expect(address().value).toBe('https://docs.example.com/guide');
  });

  it('closes a page by its close button, and the one in front with Cmd+W from inside the browser only', () => {
    open('https://one.test/');
    open('https://two.test/');
    open('https://three.test/');
    show();
    fireEvent.click(pageTabs().getByRole('button', { name: 'Close one.test' }));
    expect(browserNow().tabs.map((tab) => tab.url)).toEqual(['https://two.test/', 'https://three.test/']);

    // From the chat, Cmd+W is not the browser's.
    const outside = new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(outside);
    });
    expect(outside.defaultPrevented).toBe(false);
    expect(browserNow().tabs).toHaveLength(2);

    fireEvent.keyDown(address(), { key: 'w', metaKey: true });
    expect(browserNow().tabs.map((tab) => tab.url)).toEqual(['https://two.test/']);
  });

  it('scrolls the row of pages to the page in front when it is out of view', () => {
    // jsdom lays nothing out: the row is 300px wide and each page's tab 100px, side by side.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.getAttribute('role') === 'group') return DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 34 });
      const index = this.parentElement ? Array.from(this.parentElement.children).indexOf(this) : 0;
      const row = this.parentElement as HTMLElement | null;
      const left = index * 100 - (row?.scrollLeft ?? 0);
      return DOMRect.fromRect({ x: left, y: 0, width: 100, height: 34 });
    });
    for (let index = 0; index < 6; index++) open(`https://site${index}.test/`);
    show();
    const row = screen.getByRole('group', { name: preview.browser.tabsLabel });
    // The newest page is in front: its tab (500-600px) comes into the 300px row.
    expect(row.scrollLeft).toBe(300);
    fireEvent.click(page('site3.test'));
    expect(row.scrollLeft).toBe(300);
    act(() => switchBrowserTab(browserNow().tabs[0].id));
    expect(row.scrollLeft).toBe(0);
    vi.restoreAllMocks();
  });

  it('closes a page with a middle click on its tab', () => {
    open('https://one.test/');
    open('https://two.test/');
    show();
    fireEvent(page('one.test'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(browserNow().tabs.map((tab) => tab.url)).toEqual(['https://two.test/']);
  });

  it('offers to close a page, to close the others and to copy its address on a right click of its tab', async () => {
    open('https://one.test/');
    open('https://two.test/');
    open('https://three.test/');
    show();
    const menuItem = async (tab: string, name: string) => {
      fireEvent.contextMenu(page(tab));
      return screen.findByRole('menuitem', { name });
    };

    fireEvent.click(await menuItem('two.test', preview.browser.copyAddress));
    expect(copyTextMock).toHaveBeenCalledWith('https://two.test/');
    expect(await screen.findByText(common.copySuccess)).toBeInTheDocument();

    fireEvent.click(await menuItem('three.test', preview.close));
    expect(browserNow().tabs.map((tab) => tab.url)).toEqual(['https://one.test/', 'https://two.test/']);

    fireEvent.click(await menuItem('one.test', preview.closeOthers));
    expect(browserNow().tabs.map((tab) => tab.url)).toEqual(['https://one.test/']);
    expect(page('one.test')).toHaveAttribute('aria-current', 'page');
  });

  it('offers no copy on a blank page, nor closing the others when there are none, and says when a copy fails', async () => {
    open();
    show();
    // The blank page's tab, in front: the plus beside it has the same name.
    fireEvent.contextMenu(pageTabs().getByRole('button', { current: 'page' }));
    const copy = await screen.findByRole('menuitem', { name: preview.browser.copyAddress });
    expect(copy.className).toMatch(/-disabled/);
    expect(screen.getByRole('menuitem', { name: preview.closeOthers }).className).toMatch(/-disabled/);
    fireEvent.click(copy);
    expect(copyTextMock).not.toHaveBeenCalled();

    act(() => updateBrowserTab(browserNow().tabs[0].id, { url: 'https://moved.test/' }));
    copyTextMock.mockRejectedValue(new Error('no clipboard'));
    fireEvent.contextMenu(page('moved.test'));
    fireEvent.click(await screen.findByRole('menuitem', { name: preview.browser.copyAddress }));
    expect(copyTextMock).toHaveBeenCalledWith('https://moved.test/');
    expect(await screen.findByText(common.copyFailed)).toBeInTheDocument();
  });

  it('marks the pages while the agent’s browser tool drives them', () => {
    open('https://one.test/');
    open('https://two.test/');
    show();
    expect(screen.queryByTitle(preview.browser.agentActiveTooltip)).not.toBeInTheDocument();
    // What PreviewContext does while the tool stream says the browser tool is at work, and once it is done.
    act(() => markBrowserAgentActive(true));
    expect(screen.getAllByTitle(preview.browser.agentActiveTooltip)).toHaveLength(2);
    act(() => markBrowserAgentActive(false));
    expect(screen.queryByTitle(preview.browser.agentActiveTooltip)).not.toBeInTheDocument();
  });

  it('gives a page mu opened for a run the agent’s own session, and a person’s page the shared one', () => {
    act(() => {
      openBrowserPage('https://person.test/');
      openBrowserPage('https://run.test/', { by: 'agent', muRun: 'r1' });
    });
    show();
    expect(pages.byUrl.get('https://person.test/')?.partition).toBe(BROWSER_PARTITION);
    expect(pages.byUrl.get('https://run.test/')?.partition).toBe('persist:mu-browser');
  });

  it('says so when a full browser took over its oldest page', async () => {
    for (let index = 0; index < MAX_BROWSER_TABS; index++) open(`https://site${index}.test/`);
    show();
    open('https://overflow.test/');
    expect(
      await screen.findByText(preview.browser.tabLimitReached.replace('{{count}}', String(MAX_BROWSER_TABS)))
    ).toBeInTheDocument();
  });
});

describe('the address and the controls act on the page in front', () => {
  it('shows where the page is as it moves, and puts that back on Escape', () => {
    open('https://a.test/');
    show();
    act(() =>
      pages.byUrl
        .get('https://a.test/')
        ?.report({ url: 'https://a.test/after', canGoBack: true, canGoForward: false, loading: false })
    );
    expect(address().value).toBe('https://a.test/after');

    type('something else');
    expect(address().value).toBe('something else');
    fireEvent.keyDown(address(), { key: 'Escape' });
    expect(address().value).toBe('https://a.test/after');
  });

  it('goes back, forward and reloads as the page allows', () => {
    open('https://behind.test/');
    open('https://a.test/');
    show();
    const back = screen.getByRole('button', { name: common.historyBack });
    const forward = screen.getByRole('button', { name: common.forward });
    expect(back).toBeDisabled();
    expect(forward).toBeDisabled();

    const a = pages.byUrl.get('https://a.test/');
    act(() => a?.report({ url: 'https://a.test/', canGoBack: true, canGoForward: true, loading: true }));
    fireEvent.click(back);
    fireEvent.click(forward);
    fireEvent.click(screen.getByRole('button', { name: common.refresh }));
    expect(a?.controls.back).toHaveBeenCalledTimes(1);
    expect(a?.controls.forward).toHaveBeenCalledTimes(1);
    expect(a?.controls.reload).toHaveBeenCalledTimes(1);
    // Only the page in front moves.
    const behind = pages.byUrl.get('https://behind.test/');
    expect(behind?.controls.back).not.toHaveBeenCalled();
    expect(behind?.controls.reload).not.toHaveBeenCalled();
  });

  it('sends what is typed to the page in front, an address or a search, without opening another page', () => {
    open('https://a.test/');
    show();
    const a = pages.byUrl.get('https://a.test/');
    type('news.example.org');
    enter();
    expect(a?.controls.go).toHaveBeenLastCalledWith('https://news.example.org');
    type('weather tomorrow');
    enter();
    expect(a?.controls.go).toHaveBeenLastCalledWith('https://www.bing.com/search?q=weather%20tomorrow');
    expect(browserNow().tabs).toHaveLength(1);
  });
});

describe('filling the page', () => {
  it('offers to fill the page where it can, and to give the transcript back once it does', () => {
    const toggle = vi.fn();
    const view = show({ onToggleMaximize: toggle });
    fireEvent.click(screen.getByRole('button', { name: preview.maximizePanel }));
    expect(toggle).toHaveBeenCalledTimes(1);

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <BrowserPanel maximized onToggleMaximize={toggle} />
      </I18nextProvider>
    );
    expect(screen.getByRole('button', { name: preview.restorePanel })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers nothing where the browser cannot fill the page', () => {
    show();
    expect(screen.queryByRole('button', { name: preview.maximizePanel })).not.toBeInTheDocument();
  });
});
