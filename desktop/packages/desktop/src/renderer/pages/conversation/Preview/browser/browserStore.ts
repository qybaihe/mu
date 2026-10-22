import { useSyncExternalStore } from 'react';
import { announcePreviewOpened, type PreviewOpener } from '../context/previewOpeners';
import { BROWSER_SCOPE_KEY_PREFIX, browserScopeStorageKey, previewScopeStorageKey } from '../context/previewScope';
import { BROWSER_BLANK_URL, MAX_BROWSER_TABS, isAppAddress } from './constants';

/**
 * The in-app browser's pages: what the work panel's 浏览器 tab shows.
 *
 * Every web page opens here: a link the person follows, the browser's plus, a page the agent opens, and the tabs
 * mu's judge-driven browsing works in. The preview keeps files, HTML and other previews.
 *
 * The pages are kept per project (the preview's scope, see `previewScope.ts`), in memory and in one localStorage
 * entry per project, so switching projects and restarting the app both bring each project's pages back with the one
 * that was in front.
 *
 * Earlier builds kept the pages among the preview's tabs. The first time a project is opened, its pages are carried
 * over from the preview's entry and written here at once; when the preview was showing one of them, the work panel
 * follows it from 预览 to 浏览器 once (`handOver`, taken by the work panel).
 */

export type BrowserTab = {
  id: string;
  /** The page's address: the one it was opened at, then every address it moves to. */
  url: string;
  /** The page's own title; '' (or the stored "New Tab" of an older build) until it reports one. */
  title: string;
  favicon?: string;
  /** Opened by mu's browsing for this request: the agent's own session, and the step bar above the page. */
  muRun?: string;
  /** The built-in browser tool is driving the pages right now. Never stored. */
  agentActive?: boolean;
};

export type BrowserState = {
  readonly tabs: readonly BrowserTab[];
  readonly activeTabId: string | null;
  /** The last time an open took over the oldest page because the browser was full (null: never). */
  readonly limitHitAt: number | null;
  /** The pages came over from an older build's preview while it was showing one of them (see above). */
  readonly handOver: boolean;
  /** The browser fills the conversation page, the transcript hidden, as the preview can. Never stored. */
  readonly maximized: boolean;
};

export type BrowserTabPatch = { url?: string; title?: string; favicon?: string };

/** Projects whose pages are kept; the least recently changed are dropped first, as the preview does. */
const MAX_REMEMBERED_SCOPES = 12;

type Loaded = Pick<BrowserState, 'tabs' | 'activeTabId' | 'handOver'> & { carried: boolean };

const NOTHING: Loaded = { tabs: [], activeTabId: null, handOver: false, carried: false };
const EMPTY: BrowserState = { tabs: [], activeTabId: null, limitHitAt: null, handOver: false, maximized: false };

let scope: string | null = null;
let state: BrowserState = EMPTY;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const newTabId = (): string => `browser-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/** One page as stored, or null when the row is unusable. */
function readTab(id: unknown, url: unknown, title: unknown, favicon: unknown, muRun: unknown): BrowserTab | null {
  if (typeof id !== 'string' || !id || typeof url !== 'string') return null;
  const tab: BrowserTab = { id, url, title: typeof title === 'string' ? title : '' };
  if (text(favicon)) tab.favicon = text(favicon);
  if (text(muRun)) tab.muRun = text(muRun);
  return tab;
}

/** The page in front: the stored one while it is still there, otherwise the newest. */
const frontOf = (tabs: readonly BrowserTab[], stored: unknown): string | null =>
  tabs.some((tab) => tab.id === stored) ? (stored as string) : (tabs.at(-1)?.id ?? null);

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    // Unreadable or no storage: the browser starts empty rather than failing.
    return null;
  }
}

/** The pages an older build kept among a project's preview tabs, and whether the preview was showing one. */
function pagesFromPreview(key: string): Loaded {
  const stored = record(readJson(previewScopeStorageKey(key)));
  const tabs: BrowserTab[] = [];
  for (const value of Array.isArray(stored.tabs) ? stored.tabs : []) {
    const row = record(value);
    if (row.content_type !== 'browser') continue;
    const metadata = record(row.metadata);
    const tab = readTab(row.id, row.content, row.title, metadata.favicon, metadata.muRun);
    if (tab) tabs.push(tab);
  }
  if (!tabs.length) return NOTHING;
  const kept = tabs.slice(-MAX_BROWSER_TABS);
  const shown = stored.isOpen === true && kept.some((tab) => tab.id === stored.activeTabId);
  return { tabs: kept, activeTabId: frontOf(kept, stored.activeTabId), handOver: shown, carried: true };
}

function load(key: string): Loaded {
  const stored = readJson(browserScopeStorageKey(key));
  if (stored === undefined) return pagesFromPreview(key);
  const row = record(stored);
  const tabs = (Array.isArray(row.tabs) ? row.tabs : [])
    .map((value) => {
      const tab = record(value);
      return readTab(tab.id, tab.url, tab.title, tab.favicon, tab.muRun);
    })
    .filter((tab): tab is BrowserTab => tab !== null)
    .slice(0, MAX_BROWSER_TABS);
  return { tabs, activeTabId: frontOf(tabs, row.activeTabId), handOver: false, carried: false };
}

/** Drop the least recently changed projects' pages until `keep` remain, never the one just written. */
function evictColdest(keep: number, protectedKey: string): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(BROWSER_SCOPE_KEY_PREFIX)) keys.push(key);
  }
  const coldest = keys
    .filter((key) => key !== protectedKey)
    .map((key) => {
      const savedAt = record(readJson(key)).savedAt;
      return { key, savedAt: typeof savedAt === 'number' ? savedAt : 0 };
    })
    .toSorted((a, b) => a.savedAt - b.savedAt);
  for (const { key } of coldest.slice(0, Math.max(0, keys.length - keep))) localStorage.removeItem(key);
}

function persist(): void {
  if (scope === null) return;
  const key = browserScopeStorageKey(scope);
  const tabs = state.tabs.map(({ agentActive: _agentActive, ...tab }) => tab);
  const write = () =>
    localStorage.setItem(key, JSON.stringify({ tabs, activeTabId: state.activeTabId, savedAt: Date.now() }));
  try {
    write();
    evictColdest(MAX_REMEMBERED_SCOPES, key);
  } catch {
    // Out of quota: make room once. Should that fail too, the pages stay open for this run and are not restored.
    try {
      evictColdest(Math.floor(MAX_REMEMBERED_SCOPES / 2), key);
      write();
    } catch {
      // Nothing more to do: the browser is a convenience, never worth an error.
    }
  }
}

/** Replace the state; what is stored (the pages and the one in front) is written when it changed. */
function set(next: BrowserState, { store = true }: { store?: boolean } = {}): void {
  const changed = next.tabs !== state.tabs || next.activeTabId !== state.activeTabId;
  state = next;
  if (store && changed) persist();
  emit();
}

/**
 * Show another project's pages (null: no project, nothing kept). Called with the preview's own scope switch, so the
 * browser and the preview always show the same project.
 */
export function switchBrowserScope(next: string | null): void {
  if (next === scope) return;
  scope = next;
  const loaded = next === null ? NOTHING : load(next);
  state = {
    tabs: loaded.tabs,
    activeTabId: loaded.activeTabId,
    limitHitAt: null,
    handOver: loaded.handOver,
    maximized: false,
  };
  // Pages carried over from the preview are written here at once: the preview's next write leaves them out.
  if (loaded.carried) persist();
  emit();
}

export type OpenBrowserPageOptions = {
  /** Who opened it, the person unless said otherwise: the panel comes up for the person, and marks it for the agent. */
  by?: PreviewOpener;
  /** A run of mu's (its request id): the page gets the agent's own session and the step bar. */
  muRun?: string;
  /**
   * The address, when already open in a page of the person's session, brings that page to the front instead of
   * opening it again: what an agent's navigation tool asks for twice is one page, not two.
   */
  reuse?: boolean;
};

/**
 * Open a web page in a new tab (a blank one without an address) and bring it to the front. The app itself is never
 * opened (see `isAppAddress`), and a full browser takes over its oldest page, saying so through `limitHitAt`: the
 * oldest the person browses, since taking over a page of mu's would end its run there (the oldest of all only when
 * every page is mu's). A run of mu's is refused instead, since its policy asks first (`muBrowser/panelPolicy.ts`).
 * Returns the tab's id, or null when nothing was opened.
 */
export function openBrowserPage(url?: string, options: OpenBrowserPageOptions = {}): string | null {
  const address = url?.trim() || BROWSER_BLANK_URL;
  // The app is not a page to browse: without the desktop bridge it would only show the web sign-in.
  if (isAppAddress(address)) {
    console.warn('[browser] refused to open the app itself in a browser tab:', address);
    return null;
  }
  const open = options.reuse ? state.tabs.find((tab) => tab.url === address && !tab.muRun) : undefined;
  if (open) {
    if (state.activeTabId !== open.id) set({ ...state, activeTabId: open.id });
    announcePreviewOpened(options.by ?? 'user', 'browser');
    return open.id;
  }
  const full = state.tabs.length >= MAX_BROWSER_TABS;
  if (full && options.muRun) return null;
  let id: string;
  if (full) {
    id = (state.tabs.find((tab) => !tab.muRun) ?? state.tabs[0]).id;
    const tabs = state.tabs.map((tab) => (tab.id === id ? { id, url: address, title: '' } : tab));
    set({ ...state, tabs, activeTabId: id, limitHitAt: Date.now() });
  } else {
    id = newTabId();
    const tab: BrowserTab = { id, url: address, title: '' };
    if (options.muRun) tab.muRun = options.muRun;
    set({ ...state, tabs: [...state.tabs, tab], activeTabId: id });
  }
  announcePreviewOpened(options.by ?? 'user', 'browser');
  return id;
}

/** Bring a page to the front. */
export function switchBrowserTab(id: string): void {
  if (state.activeTabId === id || !state.tabs.some((tab) => tab.id === id)) return;
  set({ ...state, activeTabId: id });
}

/** Close a page; the one that takes its place comes to the front when it was in front. */
export function closeBrowserTab(id: string): void {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeTabId =
    state.activeTabId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.activeTabId;
  set({ ...state, tabs, activeTabId });
}

/** Close every page but this one, which comes to the front. */
export function closeOtherBrowserTabs(id: string): void {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab || (state.tabs.length === 1 && state.activeTabId === id)) return;
  set({ ...state, tabs: [tab], activeTabId: id });
}

/**
 * What a page reported about itself: where it went, its title, its icon. An empty title is ignored, so a page that
 * has not named itself yet keeps the last name; a page on another site drops the old site's icon until its own one
 * arrives.
 */
export function updateBrowserTab(id: string, patch: BrowserTabPatch): void {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab) return;
  const next: BrowserTab = { ...tab };
  if (typeof patch.url === 'string' && patch.url !== tab.url) {
    next.url = patch.url;
    if (originOf(patch.url) !== originOf(tab.url)) delete next.favicon;
  }
  const title = patch.title?.trim();
  if (title) next.title = title;
  if (text(patch.favicon)) next.favicon = patch.favicon;
  if (next.url === tab.url && next.title === tab.title && next.favicon === tab.favicon) return;
  set({ ...state, tabs: state.tabs.map((item) => (item.id === id ? next : item)) });
}

/** The built-in browser tool started or stopped driving the pages. Nothing to store: it is never restored. */
export function markBrowserAgentActive(active: boolean): void {
  if (!state.tabs.some((tab) => Boolean(tab.agentActive) !== active)) return;
  set({ ...state, tabs: state.tabs.map((tab) => ({ ...tab, agentActive: active })) }, { store: false });
}

/** Let the browser fill the conversation page, or give the transcript back. */
export function setBrowserMaximized(maximized: boolean): void {
  if (state.maximized !== maximized) set({ ...state, maximized });
}

/** Whether the pages came over from a preview that was showing one; answered true once. */
export function takeBrowserHandOver(): boolean {
  if (!state.handOver) return false;
  set({ ...state, handOver: false });
  return true;
}

const snapshot = (): BrowserState => state;
const maximizedSnapshot = (): boolean => state.maximized;
const handOverSnapshot = (): boolean => state.handOver;

export const useBrowser = (): BrowserState => useSyncExternalStore(subscribe, snapshot, snapshot);

/** Only whether the browser is maximized: the page layout follows it without following every page's title. */
export const useBrowserMaximized = (): boolean => useSyncExternalStore(subscribe, maximizedSnapshot, maximizedSnapshot);

/** Only whether there is a hand-over to take (see `takeBrowserHandOver`): the work panel follows nothing else here. */
export const useBrowserHandOver = (): boolean => useSyncExternalStore(subscribe, handOverSnapshot, handOverSnapshot);

/** For code outside React (mu's browser answering the main process). */
export const browserNow = (): BrowserState => state;

/** Forget everything, storage aside: tests start from a clean module. */
export function resetBrowserStoreForTest(): void {
  scope = null;
  state = EMPTY;
}
