/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bumpWorkPanelNews,
  handPreviewToBrowser,
  markWorkPanelUsed,
  noteWorkPanelSignature,
  readWorkPanelMemory,
  rememberWorkPanel,
  resetWorkPanelStoreForTest,
  setWorkPanelViewing,
  useWorkPanelUnread,
  useWorkPanelUsed,
  WORK_PANEL_TABS,
} from '@/renderer/components/layout/WorkPanel/workPanelStore';
import { renderHook } from '@testing-library/react';

const STORAGE_KEY = 'mu-work-panel';

beforeEach(() => {
  localStorage.clear();
  resetWorkPanelStoreForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const unread = (conversationId: string) => renderHook(() => useWorkPanelUnread(conversationId)).result.current;
const used = (conversationId: string) => renderHook(() => useWorkPanelUsed(conversationId)).result.current;

describe('what the work panel remembers', () => {
  it('shows the kernel tabs, then the project workspace, then the browser', () => {
    expect(WORK_PANEL_TABS).toEqual(['board', 'judge', 'hive', 'lessons', 'files', 'preview', 'source', 'browser']);
  });

  it('starts closed on the board, 360px wide', () => {
    expect(readWorkPanelMemory('conv-1')).toEqual({ open: false, tab: 'board', width: 360 });
    expect(readWorkPanelMemory(null)).toEqual({ open: false, tab: 'board', width: 360 });
  });

  it('remembers open, tab and width per conversation, and starts a new one from the last choice', () => {
    rememberWorkPanel('conv-1', { open: true, tab: 'judge', width: 420.4 });
    rememberWorkPanel('conv-2', { open: false });
    expect(readWorkPanelMemory('conv-1')).toEqual({ open: true, tab: 'judge', width: 420 });
    // conv-2 took the last choice, then was closed.
    expect(readWorkPanelMemory('conv-2')).toEqual({ open: false, tab: 'judge', width: 420 });
    // A conversation the panel was never used in starts where the person left it last.
    expect(readWorkPanelMemory('conv-3')).toEqual({ open: false, tab: 'judge', width: 420 });
    rememberWorkPanel('conv-1', { tab: 'hive' });
    expect(readWorkPanelMemory('conv-2')).toEqual({ open: false, tab: 'judge', width: 420 });
  });

  it('comes back on the browser after a restart when that is where it was left', () => {
    rememberWorkPanel('conv-1', { open: true, tab: 'browser', width: 480 });
    rememberWorkPanel('conv-2', { open: false, tab: 'files' });
    resetWorkPanelStoreForTest();
    expect(readWorkPanelMemory('conv-1')).toEqual({ open: true, tab: 'browser', width: 480 });
    expect(readWorkPanelMemory('conv-2')).toEqual({ open: false, tab: 'files', width: 480 });

    // Written by hand, as storage holds it: a stored `browser` is a tab like any other.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ conversations: { 'conv-9': { open: true, tab: 'browser', width: 400, at: 1 } } })
    );
    resetWorkPanelStoreForTest();
    expect(readWorkPanelMemory('conv-9')).toEqual({ open: true, tab: 'browser', width: 400 });
  });

  it('follows web pages from 预览 to 浏览器 when an older build left the panel on 预览', () => {
    rememberWorkPanel('on-preview', { open: true, tab: 'preview', width: 420 });
    rememberWorkPanel('closed-on-preview', { open: false, tab: 'preview' });
    rememberWorkPanel('on-files', { open: true, tab: 'files' });

    handPreviewToBrowser('on-preview');
    handPreviewToBrowser('closed-on-preview');
    handPreviewToBrowser('on-files');

    expect(readWorkPanelMemory('on-preview')).toEqual({ open: true, tab: 'browser', width: 420 });
    // Open or closed stays as it was; only the tab follows the pages.
    expect(readWorkPanelMemory('closed-on-preview')).toEqual({ open: false, tab: 'browser', width: 420 });
    expect(readWorkPanelMemory('on-files').tab).toBe('files');

    // What was handed over is remembered like any choice, across a restart.
    resetWorkPanelStoreForTest();
    expect(readWorkPanelMemory('on-preview')).toEqual({ open: true, tab: 'browser', width: 420 });
  });

  it('never remembers a width below the minimum', () => {
    rememberWorkPanel('conv-1', { width: 100 });
    expect(readWorkPanelMemory('conv-1').width).toBe(270);
  });

  it('keeps its memory across a restart, and starts fresh from storage it cannot read', () => {
    rememberWorkPanel('conv-1', { open: true, tab: 'source', width: 500 });
    resetWorkPanelStoreForTest();
    expect(readWorkPanelMemory('conv-1')).toEqual({ open: true, tab: 'source', width: 500 });

    localStorage.setItem(STORAGE_KEY, '{not json');
    resetWorkPanelStoreForTest();
    expect(readWorkPanelMemory('conv-1')).toEqual({ open: false, tab: 'board', width: 360 });

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ conversations: { 'conv-1': { open: true, tab: 'somewhere', width: 'wide' } } })
    );
    resetWorkPanelStoreForTest();
    expect(readWorkPanelMemory('conv-1')).toEqual({ open: true, tab: 'board', width: 360 });
  });

  it('forgets the least recently changed conversations beyond 200', () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    for (let index = 0; index < 201; index++) rememberWorkPanel(`conv-${index}`, { width: 300 + index });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { conversations: Record<string, unknown> };
    expect(Object.keys(stored.conversations)).toHaveLength(200);
    expect(stored.conversations['conv-0']).toBeUndefined();
    expect(stored.conversations['conv-200']).toBeDefined();
  });
});

describe('which tabs have news', () => {
  it('takes the first signature a conversation shows as where it stands, and a later one as news', () => {
    noteWorkPanelSignature('conv-1', 'board', 'first board');
    expect(unread('conv-1').size).toBe(0);
    noteWorkPanelSignature('conv-1', 'board', 'first board');
    expect(unread('conv-1').size).toBe(0);
    noteWorkPanelSignature('conv-1', 'board', 'second board');
    expect([...unread('conv-1')]).toEqual(['board']);
    // News stays with its conversation.
    expect(unread('conv-2').size).toBe(0);
  });

  it('counts the first words after a silence as news, but not the same words read again', () => {
    noteWorkPanelSignature('conv-1', 'judge', '');
    noteWorkPanelSignature('conv-1', 'judge', 'verdict 1');
    expect([...unread('conv-1')]).toEqual(['judge']);

    setWorkPanelViewing('conv-1', 'judge');
    setWorkPanelViewing('conv-1', null);
    // A record read again from the start says nothing for a moment, then the same verdict: no news.
    noteWorkPanelSignature('conv-1', 'judge', '');
    noteWorkPanelSignature('conv-1', 'judge', 'verdict 1');
    expect(unread('conv-1').size).toBe(0);
  });

  it('shows no news for the tab being looked at, and clears a tab as soon as it is looked at', () => {
    setWorkPanelViewing('conv-1', 'board');
    noteWorkPanelSignature('conv-1', 'board', 'a');
    noteWorkPanelSignature('conv-1', 'board', 'b');
    bumpWorkPanelNews('conv-1', 'board');
    expect(unread('conv-1').size).toBe(0);

    bumpWorkPanelNews('conv-1', 'files');
    bumpWorkPanelNews('conv-1', 'preview');
    expect([...unread('conv-1')].toSorted()).toEqual(['files', 'preview']);
    setWorkPanelViewing('conv-1', 'files');
    expect([...unread('conv-1')]).toEqual(['preview']);
    // The panel closed: news for the tab it was on waits for the person again.
    setWorkPanelViewing('conv-1', null);
    bumpWorkPanelNews('conv-1', 'files');
    expect([...unread('conv-1')].toSorted()).toEqual(['files', 'preview']);
  });

  it('marks the browser, not the preview, for a page the agent opened, unless the person is looking at it', () => {
    bumpWorkPanelNews('conv-1', 'browser');
    expect([...unread('conv-1')]).toEqual(['browser']);
    setWorkPanelViewing('conv-1', 'browser');
    expect(unread('conv-1').size).toBe(0);
    bumpWorkPanelNews('conv-1', 'browser');
    expect(unread('conv-1').size).toBe(0);
  });
});

describe('which tabs a conversation used', () => {
  it('counts a tab the person opened, once, in that conversation only', () => {
    expect(used('conv-1').size).toBe(0);
    markWorkPanelUsed('conv-1', 'hive');
    const after = used('conv-1');
    expect([...after]).toEqual(['hive']);
    // Opened again: nothing changes, not even the set.
    markWorkPanelUsed('conv-1', 'hive');
    expect(used('conv-1')).toBe(after);
    expect(used('conv-2').size).toBe(0);
  });

  it('counts a kernel tab with something to show, but not one that says nothing yet', () => {
    noteWorkPanelSignature('conv-1', 'hive', 'run-1 scout thinking');
    noteWorkPanelSignature('conv-1', 'lessons', '');
    expect([...used('conv-1')]).toEqual(['hive']);
    // The first signature is where the conversation stands: used, not news.
    expect(unread('conv-1').size).toBe(0);

    // Its first words after that are news, and the tab is used from then on.
    noteWorkPanelSignature('conv-1', 'lessons', 'lesson-1 stored');
    expect([...used('conv-1')].toSorted()).toEqual(['hive', 'lessons']);
    expect([...unread('conv-1')]).toEqual(['lessons']);
  });

  it('counts a tab with news, and keeps it once the news is seen', () => {
    bumpWorkPanelNews('conv-1', 'browser');
    expect([...used('conv-1')]).toEqual(['browser']);
    setWorkPanelViewing('conv-1', 'browser');
    expect(unread('conv-1').size).toBe(0);
    expect([...used('conv-1')]).toEqual(['browser']);

    // News on the tab being looked at is seen at once, and still counts.
    setWorkPanelViewing('conv-1', 'preview');
    bumpWorkPanelNews('conv-1', 'preview');
    expect(unread('conv-1').size).toBe(0);
    expect([...used('conv-1')].toSorted()).toEqual(['browser', 'preview']);
  });
});

describe('the words of the work panel', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../../..');
  const config = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'packages/desktop/src/common/config/i18n-config.json'), 'utf8')
  ) as { supportedLanguages: string[] };

  it('has every tab, label and line in all 13 languages', () => {
    expect(config.supportedLanguages).toHaveLength(13);
    for (const language of config.supportedLanguages) {
      const common = JSON.parse(
        readFileSync(
          path.join(REPO_ROOT, 'packages/desktop/src/renderer/services/i18n/locales', language, 'common.json'),
          'utf8'
        )
      ) as { more: string; workPanel: Record<string, unknown> & { tabs: Record<string, string> } };
      for (const tab of WORK_PANEL_TABS) expect(common.workPanel.tabs[tab], `${language} ${tab}`).toBeTruthy();
      for (const key of [
        'label',
        'tabsLabel',
        'close',
        'resize',
        'noProject',
        'previewEmpty',
        'previewHidden',
        'browserEmpty',
      ])
        expect(common.workPanel[key], `${language} ${key}`).toBeTruthy();
      expect(common.workPanel.unread, language).toContain('{{tab}}');
      // 更多, where the tabs a conversation has not used wait.
      expect(common.more, `${language} more`).toBeTruthy();
    }
  });
});
