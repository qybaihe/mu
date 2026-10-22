/**
 * The in-app browser's pages (the work panel's 浏览器 tab): what opens where, the cap, what a page writes back, what is
 * kept per project across restarts, and how the pages an older build kept among the preview's tabs come over.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserNow,
  closeBrowserTab,
  closeOtherBrowserTabs,
  markBrowserAgentActive,
  openBrowserPage,
  resetBrowserStoreForTest,
  setBrowserMaximized,
  switchBrowserScope,
  switchBrowserTab,
  takeBrowserHandOver,
  updateBrowserTab,
} from '@/renderer/pages/conversation/Preview/browser/browserStore';
import { MAX_BROWSER_TABS } from '@/renderer/pages/conversation/Preview/browser/constants';
import {
  onPreviewOpened,
  type OpenedIn,
  type PreviewOpener,
} from '@/renderer/pages/conversation/Preview/context/previewOpeners';

const stored = (scope: string) => JSON.parse(localStorage.getItem(`browser-ui:${scope}`) ?? 'null');
/** What an older build wrote for a project's preview, its web pages among the tabs. */
const olderPreview = (scope: string, value: Record<string, unknown>) =>
  localStorage.setItem(`preview-ui:${scope}`, JSON.stringify(value));
const olderPage = (id: string, url: string, metadata: Record<string, unknown> = {}) => ({
  id,
  content: url,
  content_type: 'browser',
  title: 'New Tab',
  metadata,
});
const olderFile = { id: 'md-1', content: '# Notes', content_type: 'markdown', title: 'notes.md' };
const urls = () => browserNow().tabs.map((tab) => tab.url);
/** A restart: the module forgets everything, storage stays. */
const restart = (scope: string) => {
  resetBrowserStoreForTest();
  switchBrowserScope(scope);
};

let heard: [PreviewOpener, OpenedIn][] = [];
let stopHearing = () => {};
beforeEach(() => {
  localStorage.clear();
  resetBrowserStoreForTest();
  heard = [];
  stopHearing = onPreviewOpened((by, where) => heard.push([by, where]));
});
afterEach(() => {
  stopHearing();
  vi.restoreAllMocks();
});

describe('opening pages', () => {
  it('opens a blank page without a title of its own, in front, and says the person opened it in the browser', () => {
    const id = openBrowserPage();
    expect(browserNow().tabs).toEqual([{ id, url: 'about:blank', title: '' }]);
    expect(browserNow().activeTabId).toBe(id);
    expect(heard).toEqual([['user', 'browser']]);
  });

  it('opens a page at an address, and says who opened it', () => {
    openBrowserPage('  https://example.com/  ', { by: 'agent' });
    expect(urls()).toEqual(['https://example.com/']);
    expect(heard).toEqual([['agent', 'browser']]);
  });

  it('stacks pages instead of merging them: two blank ones, or two at the same address', () => {
    openBrowserPage();
    openBrowserPage();
    openBrowserPage('https://example.com/');
    openBrowserPage('https://example.com/');
    expect(urls()).toEqual(['about:blank', 'about:blank', 'https://example.com/', 'https://example.com/']);
    expect(new Set(browserNow().tabs.map((tab) => tab.id)).size).toBe(4);
  });

  it('brings each new page to the front, not only the first', () => {
    const first = openBrowserPage('https://first.test/');
    expect(browserNow().activeTabId).toBe(first);
    const second = openBrowserPage('https://second.test/');
    expect(browserNow().activeTabId).toBe(second);
  });

  it('refuses to open the app itself as a page', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(openBrowserPage(`${window.location.origin}/index.html#/login`)).toBeNull();
    expect(browserNow().tabs).toHaveLength(0);
    expect(heard).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('takes over the oldest page when full, and says so', () => {
    for (let index = 0; index < MAX_BROWSER_TABS; index++) openBrowserPage(`https://site${index}.test/`);
    expect(browserNow().limitHitAt).toBeNull();
    const oldest = browserNow().tabs[0].id;
    updateBrowserTab(oldest, { title: 'Site 0', favicon: 'https://site0.test/icon.png' });

    const id = openBrowserPage('https://overflow.test/');
    expect(id).toBe(oldest);
    expect(browserNow().tabs).toHaveLength(MAX_BROWSER_TABS);
    // The oldest page goes to the new address as a new page: nothing of the old site's stays.
    expect(browserNow().tabs[0]).toEqual({ id: oldest, url: 'https://overflow.test/', title: '' });
    expect(browserNow().activeTabId).toBe(oldest);
    expect(browserNow().limitHitAt).toBeTypeOf('number');
  });

  it('takes over the oldest page the person browses, not one mu works in, unless every page is mu’s', () => {
    const runPage = openBrowserPage('about:blank', { by: 'agent', muRun: 'r1' });
    for (let index = 1; index < MAX_BROWSER_TABS; index++) openBrowserPage(`https://site${index}.test/`);
    const oldestOwn = browserNow().tabs[1].id;

    expect(openBrowserPage('https://overflow.test/')).toBe(oldestOwn);
    expect(browserNow().tabs[0]).toMatchObject({ id: runPage, url: 'about:blank', muRun: 'r1' });
    expect(browserNow().tabs[1]).toEqual({ id: oldestOwn, url: 'https://overflow.test/', title: '' });

    resetBrowserStoreForTest();
    for (let index = 0; index < MAX_BROWSER_TABS; index++) openBrowserPage('about:blank', { muRun: `r${index}` });
    const oldest = browserNow().tabs[0].id;
    expect(openBrowserPage('https://overflow.test/')).toBe(oldest);
    expect(browserNow().tabs[0]).toEqual({ id: oldest, url: 'https://overflow.test/', title: '' });
  });

  it('refuses a run of mu’s when full: its own policy asks first, and a person’s page is never taken over for it', () => {
    for (let index = 0; index < MAX_BROWSER_TABS; index++) openBrowserPage(`https://site${index}.test/`);
    heard = [];
    expect(openBrowserPage('about:blank', { by: 'agent', muRun: 'r1' })).toBeNull();
    expect(urls()).toEqual(Array.from({ length: MAX_BROWSER_TABS }, (_unused, index) => `https://site${index}.test/`));
    expect(browserNow().limitHitAt).toBeNull();
    expect(heard).toEqual([]);
  });

  it('brings an address already open to the front when asked to reuse it, but never a page of mu’s run', () => {
    const first = openBrowserPage('https://docs.test/', { by: 'agent', reuse: true });
    openBrowserPage('https://other.test/');
    const run = openBrowserPage('https://run.test/', { by: 'agent', muRun: 'r1' });
    heard = [];

    expect(openBrowserPage('https://docs.test/', { by: 'agent', reuse: true })).toBe(first);
    expect(browserNow().activeTabId).toBe(first);
    expect(heard).toEqual([['agent', 'browser']]);
    // A run's page is the agent's own session: a navigation elsewhere gets a page of its own.
    expect(openBrowserPage('https://run.test/', { by: 'agent', reuse: true })).not.toBe(run);
    // Without reuse, the same address opens again, as a person's new tab does.
    openBrowserPage('https://docs.test/');
    expect(urls()).toEqual([
      'https://docs.test/',
      'https://other.test/',
      'https://run.test/',
      'https://run.test/',
      'https://docs.test/',
    ]);
  });

  it('keeps which run of mu’s a page was opened for', () => {
    const id = openBrowserPage('about:blank', { by: 'agent', muRun: 'r1' });
    expect(browserNow().tabs).toEqual([{ id, url: 'about:blank', title: '', muRun: 'r1' }]);
  });
});

describe('closing and switching pages', () => {
  it('brings the next page forward when the one in front closes, or the one before when it was the last', () => {
    const [a, b, c] = ['https://a.test/', 'https://b.test/', 'https://c.test/'].map((url) => openBrowserPage(url));
    switchBrowserTab(b as string);
    closeBrowserTab(b as string);
    expect(urls()).toEqual(['https://a.test/', 'https://c.test/']);
    expect(browserNow().activeTabId).toBe(c);
    closeBrowserTab(c as string);
    expect(browserNow().activeTabId).toBe(a);
    closeBrowserTab(a as string);
    expect(browserNow()).toMatchObject({ tabs: [], activeTabId: null });
  });

  it('keeps the page in front when a page behind it closes', () => {
    const a = openBrowserPage('https://a.test/');
    const b = openBrowserPage('https://b.test/');
    closeBrowserTab(a as string);
    expect(browserNow().activeTabId).toBe(b);
    closeBrowserTab('no-such-page');
    expect(urls()).toEqual(['https://b.test/']);
  });

  it('switches only to a page it has', () => {
    const a = openBrowserPage('https://a.test/');
    openBrowserPage('https://b.test/');
    switchBrowserTab('no-such-page');
    switchBrowserTab(a as string);
    expect(browserNow().activeTabId).toBe(a);
  });

  it('closes every other page, the one kept coming to the front, and keeps that for the next start', () => {
    switchBrowserScope('project-a');
    const [a, b] = ['https://a.test/', 'https://b.test/', 'https://c.test/'].map((url) => openBrowserPage(url));
    closeOtherBrowserTabs(b as string);
    expect(urls()).toEqual(['https://b.test/']);
    expect(browserNow().activeTabId).toBe(b);
    expect(stored('project-a')).toMatchObject({ tabs: [{ id: b, url: 'https://b.test/' }], activeTabId: b });

    const before = browserNow();
    closeOtherBrowserTabs(b as string);
    closeOtherBrowserTabs(a as string);
    closeOtherBrowserTabs('no-such-page');
    expect(browserNow()).toBe(before);
  });
});

describe('what a page writes back', () => {
  it('keeps where a page went, its title and its icon, without bringing a page behind to the front', () => {
    const first = openBrowserPage('https://first.test/') as string;
    const second = openBrowserPage('https://second.test/');
    updateBrowserTab(first, { url: 'https://first.test/next', title: 'First', favicon: 'https://first.test/icon.png' });
    expect(browserNow().tabs[0]).toEqual({
      id: first,
      url: 'https://first.test/next',
      title: 'First',
      favicon: 'https://first.test/icon.png',
    });
    expect(browserNow().activeTabId).toBe(second);
  });

  it('ignores an empty title, so a page that has not named itself yet keeps the last name', () => {
    const id = openBrowserPage('https://example.com/') as string;
    updateBrowserTab(id, { title: 'Real Title' });
    updateBrowserTab(id, { title: '   ' });
    expect(browserNow().tabs[0].title).toBe('Real Title');
  });

  it('drops the old site’s icon when the page moves to another site, and keeps it within the same site', () => {
    const id = openBrowserPage('https://a.test/') as string;
    updateBrowserTab(id, { favicon: 'https://a.test/icon.png' });
    updateBrowserTab(id, { url: 'https://a.test/other' });
    expect(browserNow().tabs[0].favicon).toBe('https://a.test/icon.png');
    updateBrowserTab(id, { url: 'https://b.test/' });
    expect(browserNow().tabs[0].favicon).toBeUndefined();
  });

  it('changes nothing for an unknown page or a report that says nothing new', () => {
    const id = openBrowserPage('https://example.com/') as string;
    updateBrowserTab(id, { title: 'Example' });
    const before = browserNow();
    updateBrowserTab('no-such-page', { title: 'Nope' });
    updateBrowserTab(id, { url: 'https://example.com/', title: 'Example' });
    expect(browserNow()).toBe(before);
  });
});

describe('the agent’s browser tool at work', () => {
  it('marks every page while it drives them, and never keeps the mark', () => {
    switchBrowserScope('project-a');
    openBrowserPage('https://a.test/');
    openBrowserPage('https://b.test/');
    markBrowserAgentActive(true);
    expect(browserNow().tabs.every((tab) => tab.agentActive)).toBe(true);
    // A live signal: stored as it was before the mark, and never back on after a restart.
    expect(stored('project-a').tabs.some((tab: Record<string, unknown>) => 'agentActive' in tab)).toBe(false);
    openBrowserPage('https://c.test/');
    expect(stored('project-a').tabs.some((tab: Record<string, unknown>) => 'agentActive' in tab)).toBe(false);
    restart('project-a');
    expect(browserNow().tabs.some((tab) => tab.agentActive)).toBe(false);

    markBrowserAgentActive(true);
    markBrowserAgentActive(false);
    expect(browserNow().tabs.every((tab) => !tab.agentActive)).toBe(true);
  });
});

describe('pages kept per project', () => {
  it('keeps each project’s pages and the one in front, across project switches and restarts', () => {
    switchBrowserScope('project-a');
    const a1 = openBrowserPage('https://a1.test/') as string;
    openBrowserPage('https://a2.test/');
    updateBrowserTab(a1, { title: 'A1', favicon: 'https://a1.test/icon.png' });
    switchBrowserTab(a1);

    switchBrowserScope('project-b');
    expect(browserNow().tabs).toEqual([]);
    openBrowserPage('https://b.test/');

    switchBrowserScope('project-a');
    expect(urls()).toEqual(['https://a1.test/', 'https://a2.test/']);
    expect(browserNow().activeTabId).toBe(a1);
    expect(browserNow().tabs[0]).toMatchObject({ title: 'A1', favicon: 'https://a1.test/icon.png' });

    restart('project-b');
    expect(urls()).toEqual(['https://b.test/']);
    restart('project-a');
    expect(browserNow().activeTabId).toBe(a1);
    expect(stored('project-a')).toMatchObject({ activeTabId: a1, savedAt: expect.any(Number) });
  });

  it('keeps nothing without a project, and starts empty from storage it cannot read', () => {
    openBrowserPage('https://nowhere.test/');
    expect(localStorage.length).toBe(0);

    localStorage.setItem('browser-ui:project-a', '{not json');
    switchBrowserScope('project-a');
    expect(browserNow().tabs).toEqual([]);

    localStorage.setItem(
      'browser-ui:project-b',
      JSON.stringify({ tabs: [{ id: 'ok', url: 'https://ok.test/' }, { url: 'https://no-id.test/' }, 'junk'] })
    );
    switchBrowserScope('project-b');
    expect(browserNow().tabs).toEqual([{ id: 'ok', url: 'https://ok.test/', title: '' }]);
    // The stored front page is gone: the newest comes to the front.
    expect(browserNow().activeTabId).toBe('ok');
  });

  it('keeps the pages of the 12 projects changed most recently', () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    for (let index = 0; index < 13; index++) {
      switchBrowserScope(`project-${index}`);
      openBrowserPage(`https://site${index}.test/`);
    }
    const kept = Object.keys(localStorage).filter((key) => key.startsWith('browser-ui:'));
    expect(kept).toHaveLength(12);
    expect(kept).not.toContain('browser-ui:project-0');
    expect(kept).toContain('browser-ui:project-12');
  });

  it('is not maximized after a project switch, and never keeps that', () => {
    switchBrowserScope('project-a');
    openBrowserPage('https://a.test/');
    setBrowserMaximized(true);
    expect(browserNow().maximized).toBe(true);
    expect(stored('project-a')).not.toHaveProperty('maximized');
    switchBrowserScope('project-b');
    expect(browserNow().maximized).toBe(false);
  });
});

describe('pages an older build kept among the preview’s tabs', () => {
  it('carries them over with their titles, icons and runs, keeps the one in front, and stores them here at once', () => {
    olderPreview('project-a', {
      isOpen: true,
      activeTabId: 'browser-2',
      tabs: [
        olderPage('browser-1', 'https://one.test/', { favicon: 'https://one.test/icon.png' }),
        olderFile,
        { ...olderPage('browser-2', 'https://two.test/', { muRun: 'r1' }), title: 'Two' },
      ],
    });
    switchBrowserScope('project-a');
    expect(browserNow().tabs).toEqual([
      { id: 'browser-1', url: 'https://one.test/', title: 'New Tab', favicon: 'https://one.test/icon.png' },
      { id: 'browser-2', url: 'https://two.test/', title: 'Two', muRun: 'r1' },
    ]);
    expect(browserNow().activeTabId).toBe('browser-2');
    expect(stored('project-a').tabs).toHaveLength(2);

    // The preview was showing one of them: the work panel follows it to 浏览器, once.
    expect(browserNow().handOver).toBe(true);
    expect(takeBrowserHandOver()).toBe(true);
    expect(takeBrowserHandOver()).toBe(false);
    restart('project-a');
    expect(browserNow().handOver).toBe(false);
    expect(urls()).toEqual(['https://one.test/', 'https://two.test/']);
  });

  it('hands nothing over when the preview was closed or showing a file', () => {
    olderPreview('closed', {
      isOpen: false,
      activeTabId: 'browser-1',
      tabs: [olderPage('browser-1', 'https://one.test/')],
    });
    olderPreview('on-a-file', {
      isOpen: true,
      activeTabId: 'md-1',
      tabs: [olderPage('browser-1', 'https://one.test/'), olderFile],
    });
    switchBrowserScope('closed');
    expect(browserNow()).toMatchObject({ handOver: false, activeTabId: 'browser-1' });
    switchBrowserScope('on-a-file');
    // No page was in front: the newest is.
    expect(browserNow()).toMatchObject({ handOver: false, activeTabId: 'browser-1' });
    expect(takeBrowserHandOver()).toBe(false);
  });

  it('keeps the newest pages up to the cap, and reads an entry with no pages as none', () => {
    olderPreview('many', {
      isOpen: true,
      activeTabId: 'browser-0',
      tabs: Array.from({ length: MAX_BROWSER_TABS + 2 }, (_unused, index) =>
        olderPage(`browser-${index}`, `https://site${index}.test/`)
      ),
    });
    switchBrowserScope('many');
    expect(browserNow().tabs).toHaveLength(MAX_BROWSER_TABS);
    expect(browserNow().tabs[0].id).toBe('browser-2');
    // The page that was in front did not come over: no hand-over, the newest in front.
    expect(browserNow()).toMatchObject({ handOver: false, activeTabId: `browser-${MAX_BROWSER_TABS + 1}` });

    olderPreview('files-only', { isOpen: true, activeTabId: 'md-1', tabs: [olderFile] });
    switchBrowserScope('files-only');
    expect(browserNow().tabs).toEqual([]);
    expect(stored('files-only')).toBeNull();
  });

  it('reads its own entry once it has one, whatever the preview’s entry still says', () => {
    olderPreview('project-a', {
      isOpen: true,
      activeTabId: 'browser-1',
      tabs: [olderPage('browser-1', 'https://old.test/')],
    });
    localStorage.setItem(
      'browser-ui:project-a',
      JSON.stringify({ tabs: [{ id: 'new', url: 'https://new.test/', title: 'New' }], activeTabId: 'new' })
    );
    switchBrowserScope('project-a');
    expect(urls()).toEqual(['https://new.test/']);
    expect(browserNow().handOver).toBe(false);
  });
});
