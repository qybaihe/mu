/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useSyncExternalStore } from 'react';

/**
 * What the work panel remembers, and which of its tabs have news.
 *
 * Memory is per conversation: open or closed, the tab, the width. It lives in this module and in one localStorage
 * entry, so switching conversations restores each one's panel and a restart keeps them. A conversation the panel
 * has never been used in starts from the last choice made anywhere, so a person who keeps the panel open keeps it
 * open in a new conversation too.
 *
 * News is per conversation and per tab, in memory only. The panel never opens itself for news: a tab with something
 * the person has not seen gets a dot until they look at it. Which tabs a conversation has used (news there, something
 * to show, or the person opening it) is kept with its news: the strip shows the tabs every conversation needs, and
 * the others once they are used (WorkPanelTabs).
 */

/**
 * The panel's tabs, in the order the strip shows them: the kernel's views of the conversation, the project's
 * workspace, then the browser. 文件, 预览 and 源码 are one workspace (文件 and 源码 share one explorer, and both open
 * what they show in 预览), so 浏览器, the one tab about the web rather than the project, comes after them; appended
 * at the end, it also leaves every older tab where the person already finds it.
 */
export const WORK_PANEL_TABS = ['board', 'judge', 'hive', 'lessons', 'files', 'preview', 'source', 'browser'] as const;
export type WorkPanelTab = (typeof WORK_PANEL_TABS)[number];

/** The tabs every conversation needs. The others join the strip once the conversation uses them (WorkPanelTabs). */
export const ALWAYS_SHOWN_TABS: ReadonlySet<WorkPanelTab> = new Set(['board', 'judge', 'files']);

export const isWorkPanelTab = (value: unknown): value is WorkPanelTab =>
  typeof value === 'string' && (WORK_PANEL_TABS as readonly string[]).includes(value);

export type WorkPanelMemory = { open: boolean; tab: WorkPanelTab; width: number };

/** The narrowest the panel gets: a 900px window with the sidebar open (639px) keeps it beside a 360px transcript. */
export const WORK_PANEL_MIN_WIDTH = 270;
export const WORK_PANEL_DEFAULT_WIDTH = 360;

const STORAGE_KEY = 'mu-work-panel';
/** Conversations remembered in storage; the least recently changed are dropped first. */
const MAX_REMEMBERED = 200;
const DEFAULT_MEMORY: WorkPanelMemory = { open: false, tab: 'board', width: WORK_PANEL_DEFAULT_WIDTH };

/** One conversation's memory, and when it last changed. The memory object is kept as is while it holds. */
type Remembered = { memory: WorkPanelMemory; at: number };
type State = { last: WorkPanelMemory; conversations: Readonly<Record<string, Remembered>> };
type News = {
  unread: ReadonlySet<WorkPanelTab>;
  signatures: Readonly<Partial<Record<WorkPanelTab, string>>>;
  used: ReadonlySet<WorkPanelTab>;
};

const NO_UNREAD: ReadonlySet<WorkPanelTab> = new Set();
const NO_NEWS: News = { unread: NO_UNREAD, signatures: {}, used: NO_UNREAD };

let state: State | undefined;
const news = new Map<string, News>();
/** The tab the person is looking at, per conversation: news there is seen as it arrives. */
const viewing = new Map<string, WorkPanelTab>();
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

function readMemory(value: unknown): WorkPanelMemory | undefined {
  const row = record(value);
  if (!Object.keys(row).length) return undefined;
  const width =
    typeof row.width === 'number' && Number.isFinite(row.width)
      ? Math.max(WORK_PANEL_MIN_WIDTH, Math.round(row.width))
      : WORK_PANEL_DEFAULT_WIDTH;
  return { open: row.open === true, tab: isWorkPanelTab(row.tab) ? row.tab : DEFAULT_MEMORY.tab, width };
}

function load(): State {
  if (state) return state;
  let stored: Record<string, unknown> = {};
  try {
    stored = record(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    // Unreadable storage starts fresh: the panel is a convenience, never worth an error.
  }
  const conversations: Record<string, Remembered> = {};
  for (const [id, value] of Object.entries(record(stored.conversations))) {
    const memory = readMemory(value);
    const at = record(value).at;
    if (memory) conversations[id] = { memory, at: typeof at === 'number' ? at : 0 };
  }
  state = { last: readMemory(stored.last) ?? DEFAULT_MEMORY, conversations };
  return state;
}

function persist(next: State): void {
  const conversations = Object.fromEntries(
    Object.entries(next.conversations).map(([id, { memory, at }]) => [id, { ...memory, at }])
  );
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ last: next.last, conversations }));
  } catch {
    // Out of quota or no storage: the panel still remembers for this session.
  }
}

/**
 * What the panel shows for a conversation: its own memory, or the last choice for one it has not been used in. The
 * last tab carries over only when every conversation has it: a swarm or a web page opened elsewhere would otherwise
 * open this conversation on an empty 蜂群 or 浏览器.
 */
export function readWorkPanelMemory(conversationId: string | null): WorkPanelMemory {
  const current = load();
  const own = conversationId ? current.conversations[conversationId]?.memory : undefined;
  if (own) return own;
  return ALWAYS_SHOWN_TABS.has(current.last.tab) ? current.last : lastWithoutTab(current.last);
}

/** The last choice with the default tab, kept as one object per last choice so the snapshot stays stable. */
const fallbacks = new WeakMap<WorkPanelMemory, WorkPanelMemory>();
function lastWithoutTab(last: WorkPanelMemory): WorkPanelMemory {
  let memory = fallbacks.get(last);
  if (!memory) {
    memory = { ...last, tab: DEFAULT_MEMORY.tab };
    fallbacks.set(last, memory);
  }
  return memory;
}

/** Remember a change the person made to one conversation's panel. */
export function rememberWorkPanel(conversationId: string, patch: Partial<WorkPanelMemory>): void {
  const current = load();
  const before = readWorkPanelMemory(conversationId);
  const memory: WorkPanelMemory = {
    open: patch.open ?? before.open,
    tab: patch.tab ?? before.tab,
    width: patch.width === undefined ? before.width : Math.max(WORK_PANEL_MIN_WIDTH, Math.round(patch.width)),
  };
  const known = current.conversations[conversationId]?.memory;
  if (known && known.open === memory.open && known.tab === memory.tab && known.width === memory.width) return;
  const conversations: Record<string, Remembered> = {
    ...current.conversations,
    [conversationId]: { memory, at: Date.now() },
  };
  const ids = Object.keys(conversations);
  if (ids.length > MAX_REMEMBERED) {
    const oldest = ids.toSorted((a, b) => conversations[a].at - conversations[b].at);
    for (const id of oldest.slice(0, ids.length - MAX_REMEMBERED)) delete conversations[id];
  }
  state = { last: memory, conversations };
  persist(state);
  emit();
}

/**
 * An older build showed web pages in 预览. When the pages it was showing moved to 浏览器 (the browser store's
 * `handOver`), a conversation whose panel was left on 预览 follows them there; open or closed stays as it was.
 */
export function handPreviewToBrowser(conversationId: string): void {
  if (readWorkPanelMemory(conversationId).tab === 'preview') rememberWorkPanel(conversationId, { tab: 'browser' });
}

export function useWorkPanelMemory(conversationId: string | null): WorkPanelMemory {
  const snapshot = useCallback(() => readWorkPanelMemory(conversationId), [conversationId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const withTab = (tabs: ReadonlySet<WorkPanelTab>, tab: WorkPanelTab): ReadonlySet<WorkPanelTab> =>
  tabs.has(tab) ? tabs : new Set([...tabs, tab]);

function markUnread(conversationId: string, tab: WorkPanelTab, entry: News): void {
  const used = withTab(entry.used, tab);
  if (viewing.get(conversationId) === tab || entry.unread.has(tab)) {
    news.set(conversationId, { ...entry, used });
    if (used !== entry.used) emit();
    return;
  }
  news.set(conversationId, { ...entry, used, unread: withTab(entry.unread, tab) });
  emit();
}

/**
 * Something new in a tab: a changed file, a page the agent opened or browsed. Seen at once when the person is looking
 * at that tab; otherwise the tab gets its dot.
 */
export function bumpWorkPanelNews(conversationId: string, tab: WorkPanelTab): void {
  markUnread(conversationId, tab, news.get(conversationId) ?? NO_NEWS);
}

/**
 * What a kernel tab says now, as a signature ('' while it says nothing). The first signature a conversation shows is
 * where it stands, not news; a later, different one is. Coming back to a conversation compares against the last one
 * seen, so what changed while it was away gets its dot too. Nothing, after something, is a record being read again
 * (a new session starting): the last signature is kept, so the same words coming back are not news either.
 */
export function noteWorkPanelSignature(conversationId: string, tab: WorkPanelTab, signature: string): void {
  const entry = news.get(conversationId) ?? NO_NEWS;
  const previous = entry.signatures[tab];
  if (previous === signature || (previous && !signature)) return;
  const next: News = { ...entry, signatures: { ...entry.signatures, [tab]: signature } };
  if (previous !== undefined) markUnread(conversationId, tab, next);
  else if (!signature) news.set(conversationId, next);
  else {
    // Where the conversation stands is not news, but the tab has something to show.
    news.set(conversationId, { ...next, used: withTab(next.used, tab) });
    if (!entry.used.has(tab)) emit();
  }
}

/** The person opened a tab: it stays in the strip for this conversation. */
export function markWorkPanelUsed(conversationId: string, tab: WorkPanelTab): void {
  const entry = news.get(conversationId) ?? NO_NEWS;
  if (entry.used.has(tab)) return;
  news.set(conversationId, { ...entry, used: withTab(entry.used, tab) });
  emit();
}

export function markWorkPanelSeen(conversationId: string, tab: WorkPanelTab): void {
  const entry = news.get(conversationId);
  if (!entry?.unread.has(tab)) return;
  const unread = new Set(entry.unread);
  unread.delete(tab);
  news.set(conversationId, { ...entry, unread });
  emit();
}

/** The tab the person is looking at now (null: the panel is closed); what it shows is seen. */
export function setWorkPanelViewing(conversationId: string, tab: WorkPanelTab | null): void {
  if (!tab) {
    viewing.delete(conversationId);
    return;
  }
  viewing.set(conversationId, tab);
  markWorkPanelSeen(conversationId, tab);
}

export function useWorkPanelUnread(conversationId: string | null): ReadonlySet<WorkPanelTab> {
  const snapshot = useCallback(
    () => (conversationId ? (news.get(conversationId)?.unread ?? NO_UNREAD) : NO_UNREAD),
    [conversationId]
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useWorkPanelUsed(conversationId: string | null): ReadonlySet<WorkPanelTab> {
  const snapshot = useCallback(
    () => (conversationId ? (news.get(conversationId)?.used ?? NO_UNREAD) : NO_UNREAD),
    [conversationId]
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Forget everything, storage aside: tests start from a clean module. */
export function resetWorkPanelStoreForTest(): void {
  state = undefined;
  news.clear();
  viewing.clear();
}
