/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PreviewContext 与浏览器的分工，以及 PreviewContext 自身那些"错了会很难查"的逻辑。
 *
 * 网页不再是预览的 tab：它们在工作面板的「浏览器」里（browserStore，另有测试）。这里锁住
 * 预览把网页交给浏览器、两者跟着同一个项目切换、旧版本存在预览里的网页不再回到预览；
 * 以及打开时的聚焦和 updateTab 的行为。
 *
 * What PreviewContext hands to the browser, and the PreviewContext behaviours whose failures are hard to diagnose.
 * Web pages are no longer preview tabs: they live in the work panel's 浏览器 tab (`browserStore`, tested on its own).
 * This pins the preview handing web pages over, the two following the same project, pages an older build kept in the
 * preview never coming back there, focus on open, and `updateTab`.
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StreamMessage = { type: string; data: unknown; conversation_id?: string };

const wires = vi.hoisted(() => ({
  stream: undefined as undefined | ((message: StreamMessage) => void),
  notified: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fileStream: { contentUpdate: { on: () => () => {} } },
    preview: { open: { on: () => () => {} } },
    conversation: {
      responseStream: {
        on: (listener: (message: StreamMessage) => void) => {
          wires.stream = listener;
          return () => {
            wires.stream = undefined;
          };
        },
      },
    },
    fs: { getFileContent: { invoke: vi.fn() }, writeFile: { invoke: vi.fn() } },
  },
}));

vi.mock('@/renderer/pages/conversation/Preview/browser/firstUseNotice', () => ({
  maybeNotifyFirstAgentBrowserUse: wires.notified,
}));

import {
  PreviewProvider,
  usePreviewContext,
  type PreviewContextValue,
} from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { browserNow, resetBrowserStoreForTest } from '@/renderer/pages/conversation/Preview/browser/browserStore';
import {
  onPreviewOpened,
  type OpenedIn,
  type PreviewOpener,
} from '@/renderer/pages/conversation/Preview/context/previewOpeners';
import { BUILTIN_MCP_SERVER_NAMES } from '@/common/platform/legacyNames';

let ctx: PreviewContextValue;

const Probe: React.FC = () => {
  ctx = usePreviewContext();
  return null;
};

const renderProvider = () =>
  render(
    <PreviewProvider>
      <Probe />
    </PreviewProvider>
  );

const pages = () => browserNow().tabs.map((tab) => tab.url);

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
  vi.clearAllMocks();
});

describe('PreviewContext and the browser', () => {
  it('opens a web page in the browser, never among the preview’s tabs', () => {
    renderProvider();
    act(() => ctx.openBrowserTab('https://example.com'));
    act(() => ctx.openBrowserTab());

    expect(pages()).toEqual(['https://example.com', 'about:blank']);
    expect(ctx.tabs).toEqual([]);
    expect(ctx.isOpen).toBe(false);
    expect(heard).toEqual([
      ['user', 'browser'],
      ['user', 'browser'],
    ]);
  });

  it('hands a page opened as a `url` or `browser` preview to the browser, with who opened it', () => {
    renderProvider();
    // What an agent's navigation tool opens arrives as a `url` preview.
    act(() =>
      ctx.openPreview('https://agent.test/', 'url', { title: 'Browser: https://agent.test/' }, { by: 'agent' })
    );
    act(() => ctx.openPreview('https://person.test/', 'browser'));

    expect(pages()).toEqual(['https://agent.test/', 'https://person.test/']);
    expect(ctx.tabs).toEqual([]);
    expect(heard).toEqual([
      ['agent', 'browser'],
      ['user', 'browser'],
    ]);

    // The same `url` again is the page already open, brought to the front, as the preview found its tab again.
    act(() => ctx.openPreview('https://agent.test/', 'url', undefined, { by: 'agent' }));
    expect(pages()).toEqual(['https://agent.test/', 'https://person.test/']);
    expect(browserNow().activeTabId).toBe(browserNow().tabs[0].id);
  });

  it('keeps files in the preview, and says so', () => {
    renderProvider();
    act(() => ctx.openPreview('const a = 1;', 'code', { file_name: 'a.ts' }, { by: 'agent' }));

    expect(ctx.tabs).toHaveLength(1);
    expect(browserNow().tabs).toEqual([]);
    expect(heard).toEqual([['agent', 'preview']]);
  });

  it('refuses to open the app itself as a page', () => {
    renderProvider();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(() => ctx.openBrowserTab(`${window.location.origin}/index.html#/login`));
    expect(browserNow().tabs).toHaveLength(0);
    expect(ctx.tabs).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('switches the browser to the project the preview switches to', () => {
    renderProvider();
    act(() => ctx.closePreviewIfScopeChanged('project-a'));
    act(() => ctx.openBrowserTab('https://example.com'));

    act(() => ctx.closePreviewIfScopeChanged('project-b'));
    expect(browserNow().tabs).toEqual([]);

    act(() => ctx.closePreviewIfScopeChanged('project-a'));
    expect(pages()).toEqual(['https://example.com']);
    // Kept by the browser, not in the preview's entry.
    expect(JSON.parse(localStorage.getItem('browser-ui:project-a') ?? '{}').tabs).toHaveLength(1);
    expect(localStorage.getItem('preview-ui:project-a') ?? '').not.toContain('https://example.com');
  });

  it('leaves the pages an older build kept among its tabs to the browser, and never writes them back', () => {
    localStorage.setItem(
      'preview-ui:project-a',
      JSON.stringify({
        isOpen: true,
        activeTabId: 'browser-1',
        tabs: [
          { id: 'md-1', content: '# Notes', content_type: 'markdown', title: 'notes.md' },
          { id: 'browser-1', content: 'https://docs.test/', content_type: 'browser', title: 'Docs' },
        ],
      })
    );
    renderProvider();
    act(() => ctx.closePreviewIfScopeChanged('project-a'));

    expect(ctx.tabs.map((tab) => tab.id)).toEqual(['md-1']);
    // The page that was in front went to the browser: the preview shows its file.
    expect(ctx.activeTabId).toBe('md-1');
    expect(pages()).toEqual(['https://docs.test/']);
    expect(browserNow().handOver).toBe(true);

    // The preview writes its entry on leaving the project; the page stays the browser's.
    act(() => ctx.closePreviewIfScopeChanged('project-b'));
    expect(localStorage.getItem('preview-ui:project-a') ?? '').not.toContain('https://docs.test/');
    act(() => ctx.closePreviewIfScopeChanged('project-a'));
    expect(ctx.tabs.map((tab) => tab.id)).toEqual(['md-1']);
    expect(pages()).toEqual(['https://docs.test/']);
  });

  it('marks the browser’s pages while the agent’s browser tool drives them, and says so the first time', () => {
    renderProvider();
    act(() => ctx.openBrowserTab('https://example.com'));
    const tool = (status: string) =>
      act(() =>
        wires.stream?.({
          type: 'tool_group',
          conversation_id: 'c1',
          data: [{ name: `${BUILTIN_MCP_SERVER_NAMES.browser}__click`, status }],
        })
      );

    tool('Executing');
    expect(browserNow().tabs.every((tab) => tab.agentActive)).toBe(true);
    expect(wires.notified).toHaveBeenCalledTimes(1);
    tool('Success');
    expect(browserNow().tabs.every((tab) => !tab.agentActive)).toBe(true);
  });
});

describe('PreviewContext focus on open', () => {
  /**
   * 回归测试：openPreview 曾把「该激活哪个 tab」的赋值写在 setTabs 的 updater 里，
   * 而 React 只在 fiber 没有待处理更新时才急切求值 updater —— 于是第一次打开正常，
   * 第二次之后打开的 tab 不会被激活。这个 bug 影响所有 tab 类型，不只是浏览器。
   *
   * Regression: openPreview used to decide the next active tab inside the setTabs
   * updater, but React only eagerly evaluates an updater while the fiber has no
   * pending update — so the first open focused correctly and every later one did
   * not. The bug affected every tab type, not just the browser.
   */
  it('focuses each newly opened tab, not only the first', () => {
    renderProvider();
    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts' }));
    const firstId = ctx.tabs[0].id;
    expect(ctx.activeTabId).toBe(firstId);

    act(() => ctx.openPreview('b', 'code', { file_name: 'b.ts' }));
    expect(ctx.tabs).toHaveLength(2);
    expect(ctx.activeTabId).toBe(ctx.tabs[1].id);

    act(() => ctx.openPreview('c', 'code', { file_name: 'c.ts' }));
    expect(ctx.tabs).toHaveLength(3);
    expect(ctx.activeTabId).toBe(ctx.tabs[2].id);
  });

  // Dedup keys on ChatFileRef identity. A file name is not identity — matching on it
  // merged same-named files from different directories into one tab, where they
  // overwrote each other. Two ref-less tabs therefore stay separate.
  it('re-focuses the existing tab when the same file is opened again', () => {
    const fileRef = { kind: 'project' as const, pe_id: 'peA', relative_path: 'src/a.ts' };
    const otherRef = { kind: 'project' as const, pe_id: 'peA', relative_path: 'src/b.ts' };
    renderProvider();
    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts', fileRef }));
    const firstId = ctx.tabs[0].id;
    act(() => ctx.openPreview('b', 'code', { file_name: 'b.ts', fileRef: otherRef }));
    expect(ctx.activeTabId).not.toBe(firstId);

    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts', fileRef }));

    expect(ctx.tabs).toHaveLength(2);
    expect(ctx.activeTabId).toBe(firstId);
  });

  it('keeps ref-less tabs separate rather than merging them by name', () => {
    renderProvider();
    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts' }));
    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts' }));

    // No identity to compare, so no dedup: an extra tab is the safe outcome, while
    // a wrong merge would let two files overwrite each other.
    expect(ctx.tabs).toHaveLength(2);
  });

  /**
   * `replace` 目前没有调用方（#3821 把文件树的 `{ replace: true }` 去掉了，改成追加
   * 新 tab）。但 openPreview 仍支持它，所以这里锁住行为，避免将来重构时被静默改坏
   * 或误删——语义是"复用当前 tab"，且当前 tab 有未保存修改时必须让位、另开新 tab。
   *
   * `replace` currently has no caller (#3821 dropped `{ replace: true }` from the
   * explorer in favor of appending). openPreview still supports it, so pin the
   * behavior against silent breakage in future refactors: reuse the active tab, but
   * fall back to a new tab when the active one has unsaved edits.
   */
  it('reuses the active tab when replace is requested', () => {
    renderProvider();
    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts' }));
    const firstId = ctx.tabs[0].id;

    act(() => ctx.openPreview('b', 'code', { file_name: 'b.ts' }, { replace: true }));

    expect(ctx.tabs).toHaveLength(1);
    expect(ctx.tabs[0].id).toBe(firstId);
    expect(ctx.tabs[0].content).toBe('b');
    expect(ctx.activeTabId).toBe(firstId);
  });

  it('opens a new tab instead of replacing when the active tab has unsaved edits', () => {
    renderProvider();
    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts' }));
    act(() => ctx.updateContent('a edited'));
    expect(ctx.tabs[0].isDirty).toBe(true);

    act(() => ctx.openPreview('b', 'code', { file_name: 'b.ts' }, { replace: true }));

    // 未保存的修改不能被覆盖掉 / Unsaved edits must not be discarded
    expect(ctx.tabs).toHaveLength(2);
    expect(ctx.tabs[0].content).toBe('a edited');
  });
});

describe('PreviewContext updateTab', () => {
  it('patches title, content and metadata of a specific tab', () => {
    renderProvider();
    act(() => ctx.openPreview('<p>a</p>', 'html', { file_name: 'a.html' }));
    const tabId = ctx.tabs[0].id;

    act(() => ctx.updateTab(tabId, { title: 'Renamed', content: '<p>b</p>', metadata: { targetLine: 12 } }));

    const tab = ctx.tabs[0];
    expect(tab.title).toBe('Renamed');
    expect(tab.content).toBe('<p>b</p>');
    expect(tab.metadata?.targetLine).toBe(12);
  });

  it('updates a background tab without stealing focus', () => {
    // 关键行为：更新后台 tab 不能把用户拽到那个 tab 上
    // Key behavior: updating a background tab must not drag the user over to it.
    renderProvider();
    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts' }));
    const firstId = ctx.tabs[0].id;
    act(() => ctx.openPreview('b', 'code', { file_name: 'b.ts' }));
    const secondId = ctx.tabs[1].id;

    act(() => ctx.updateTab(firstId, { title: 'First' }));

    expect(ctx.activeTabId).toBe(secondId);
    expect(ctx.tabs[0].title).toBe('First');
  });

  it('merges metadata instead of replacing it', () => {
    renderProvider();
    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts' }));
    const tabId = ctx.tabs[0].id;

    act(() => ctx.updateTab(tabId, { metadata: { targetLine: 3 } }));
    act(() => ctx.updateTab(tabId, { metadata: { targetColumn: 7 } }));

    expect(ctx.tabs[0].metadata?.targetLine).toBe(3);
    expect(ctx.tabs[0].metadata?.targetColumn).toBe(7);
    expect(ctx.tabs[0].metadata?.file_name).toBe('a.ts');
  });

  it('ignores an empty title so it cannot erase a good one', () => {
    renderProvider();
    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts' }));
    const tabId = ctx.tabs[0].id;
    act(() => ctx.updateTab(tabId, { title: 'Real Title' }));

    act(() => ctx.updateTab(tabId, { title: '' }));

    expect(ctx.tabs[0].title).toBe('Real Title');
  });

  it('is a no-op for an unknown tab id and for an empty id', () => {
    renderProvider();
    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts' }));
    const before = ctx.tabs[0];

    act(() => ctx.updateTab('does-not-exist', { title: 'Nope' }));
    act(() => ctx.updateTab('', { title: 'Nope' }));

    expect(ctx.tabs[0]).toEqual(before);
  });

  it('allows clearing the content to an empty string', () => {
    // content 用 typeof 检查而非真值检查，空字符串是合法的清空操作
    // content is checked with typeof rather than truthiness, so clearing is valid.
    renderProvider();
    act(() => ctx.openPreview('a', 'code', { file_name: 'a.ts' }));
    const tabId = ctx.tabs[0].id;

    act(() => ctx.updateTab(tabId, { content: '' }));

    expect(ctx.tabs[0].content).toBe('');
  });
});
