/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';
import type { Activity } from '@/common/kyrn/types';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import mu from '@/renderer/services/i18n/locales/en-US/mu.json';

type StreamMessage = { type: string; data: unknown; conversation_id?: string };

const wires = vi.hoisted(() => ({
  /** Each conversation's kernel record, as the bridge hands it out page by page. */
  records: {} as Record<string, unknown[]>,
  /** Each conversation's lessons, as the main process folds them from mu's file; and which conversations read them. */
  lessons: {} as Record<string, unknown>,
  lessonReads: [] as string[],
  /** A native conversation's folder: its lessons, the changes asked for, its directories, which ones were read. */
  folderLessons: {} as Record<string, unknown>,
  folderLessonReads: [] as string[],
  folderChanges: [] as unknown[],
  folders: {} as Record<string, Record<string, unknown[]>>,
  folderReads: [] as string[],
  /** A native conversation's repository, as git reads it; and which folders were read. */
  gitReads: [] as string[],
  /** Files opened in the preview, by their full path. */
  opened: [] as string[],
  stream: undefined as undefined | ((message: StreamMessage) => void),
  preview: {
    isOpen: false,
    activeTab: null as null | { id: string },
    tabs: [] as { id: string }[],
    isMaximized: false,
    showPreview: () => {},
  },
}));

vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: {
    activity: {
      invoke: async ({ conversationId, cursor }: { conversationId: string; cursor: number }) => {
        const all = wires.records[conversationId] ?? [];
        return {
          ok: true,
          data: { sessionId: 'session', cursor: all.length, more: false, events: all.slice(cursor) },
        };
      },
    },
    lessons: {
      invoke: async ({ conversationId }: { conversationId: string }) => {
        wires.lessonReads.push(conversationId);
        return { ok: true, data: wires.lessons[conversationId] ?? { project: '', lessons: [] } };
      },
    },
  },
  unwrap: (result: { data: unknown }) => result.data,
}));
vi.mock('@/common/kyrn/folderBridge', () => ({
  kyrnFolderBridge: {
    lessons: {
      invoke: async ({ cwd }: { cwd: string }) => {
        wires.folderLessonReads.push(cwd);
        return { ok: true, data: wires.folderLessons[cwd] ?? { project: cwd, lessons: [] } };
      },
    },
    lessonsChange: {
      invoke: async (change: { cwd: string }) => {
        wires.folderChanges.push(change);
        return { ok: true, data: wires.folderLessons[change.cwd] };
      },
    },
    files: {
      invoke: async ({ cwd, path }: { cwd: string; path: string }) => {
        wires.folderReads.push(`${cwd}:${path}`);
        return { ok: true, data: { path, entries: wires.folders[cwd]?.[path] ?? [], more: 0 } };
      },
    },
  },
}));
vi.mock('@/common/kyrn/gitBridge', () => ({
  kyrnGitBridge: {
    status: {
      invoke: async ({ cwd }: { cwd: string }) => {
        wires.gitReads.push(cwd);
        return {
          ok: true,
          data: {
            state: 'repository',
            root: cwd,
            branch: { name: 'main', commit: 'abc1234' },
            changes: [{ path: 'notes/hello.txt', area: 'untracked', kind: 'untracked' }],
            more: 0,
            truncated: false,
          },
        };
      },
    },
    diff: { invoke: async () => ({ ok: false, error: 'not in this test' }) },
  },
}));
vi.mock('@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview', () => ({
  useLocalFilePreview: () => async (path: string) => {
    wires.opened.push(path);
  },
}));
vi.mock('@/common', () => ({
  ipcBridge: {
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
  },
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => wires.preview,
  PreviewPanel: () => <div data-testid='preview-panel' />,
}));
// The browser itself has tests of its own (tests/unit/preview/browser/browserPanel.dom.test.tsx).
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserPanel', () => ({
  default: ({ maximized, onToggleMaximize }: { maximized: boolean; onToggleMaximize?: () => void }) => (
    <div data-testid='browser-panel' data-maximized={maximized ? 'true' : 'false'}>
      {onToggleMaximize ? (
        <button type='button' onClick={onToggleMaximize}>
          fill the page
        </button>
      ) : null}
    </div>
  ),
}));
vi.mock('@/renderer/pages/conversation/explorer/ExplorerContainer', () => ({
  ExplorerContainer: ({
    view,
    onViewChange,
  }: {
    view?: string;
    onViewChange?: (view: 'files' | 'changes') => void;
  }) => (
    <div data-testid='explorer' data-view={view}>
      <button type='button' onClick={() => onViewChange?.('files')}>
        reveal in files
      </button>
    </div>
  ),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useVisibleConversationIds', () => ({
  useVisibleConversationIds: () => [],
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true, isMacOS: () => true }));

import WorkPanelHost, { panelGeometry } from '@/renderer/components/layout/WorkPanel';
import {
  readWorkPanelMemory,
  rememberWorkPanel,
  resetWorkPanelStoreForTest,
} from '@/renderer/components/layout/WorkPanel/workPanelStore';
import { useConversationShortcuts } from '@/renderer/hooks/ui/useConversationShortcuts';
import {
  resetCurrentConversationForTest,
  setCurrentConversation,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';
import {
  resetCurrentProjectForTest,
  setCurrentProject,
} from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { requestHiveFocus } from '@/renderer/pages/conversation/KyrnPanel';
import { publishNativeActivity } from '@/renderer/pages/native/utils/nativeActivityStore';
import {
  browserNow,
  openBrowserPage,
  resetBrowserStoreForTest,
  switchBrowserScope,
} from '@/renderer/pages/conversation/Preview/browser/browserStore';
import { announcePreviewOpened } from '@/renderer/pages/conversation/Preview/context/previewOpeners';
import {
  dispatchWorkspaceToggleEvent,
  WORKSPACE_STATE_EVENT,
  type WorkspaceStateDetail,
} from '@/renderer/utils/workspace/workspaceEvents';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { common, mu } } },
    interpolation: { escapeValue: false },
  });
});

let next = 0;
const event = (kind: string, payload: Record<string, unknown>, extra: Partial<Activity> = {}): Activity => ({
  id: `e${++next}`,
  at: 1_000 + next,
  kind,
  payload,
  ...extra,
});
const board = (now: string) =>
  event('board.update', {
    progress: 'Half the tests pass.',
    now,
    confirm: [],
    phase: 'fixing',
    needsUser: false,
    done: 1,
    total: 2,
    by: 'model',
    ended: false,
  });

/** The conversation page as far as the panel is concerned: the common shortcuts and the panel beside the chat. */
function Page({ isMobile = false }: { isMobile?: boolean }) {
  useConversationShortcuts({ navigate: vi.fn() as unknown as NavigateFunction, toggleSider: () => {} });
  return <WorkPanelHost rowWidth={1400} isMobile={isMobile} />;
}
/** The panel in a row of the given width, as the Layout measures it. */
const Row = ({ rowWidth }: { rowWidth: number }) => <WorkPanelHost rowWidth={rowWidth} isMobile={false} />;
const show = (props: { isMobile?: boolean } = {}) =>
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <Page {...props} />
      </MemoryRouter>
    </I18nextProvider>
  );

/** Let the kernel record's next read land. */
const poll = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
/** One animation frame. */
const frame = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });

const panel = () => screen.getByTestId('work-panel');
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });
const selected = () => screen.getByRole('tab', { selected: true });
const dots = () =>
  screen.queryAllByTestId('work-panel-dot').map((dot) => dot.closest('[role="tab"]')?.getAttribute('data-tab'));
/** The tabs listed under the strip's 更多, once it is opened. */
const moreTabs = () => screen.queryAllByTestId('work-panel-more-tab').map((item) => item.getAttribute('data-tab'));
const moreTab = (name: string) =>
  screen.getAllByTestId('work-panel-more-tab').find((item) => item.getAttribute('data-tab') === name) as HTMLElement;
/** A tab the conversation has not used yet, opened the way a person does: from 更多. */
const fromMore = (name: string) => {
  fireEvent.click(screen.getByTestId('work-panel-more'));
  fireEvent.click(moreTab(name));
};
const shortcut = (key: string) => {
  const keydown = new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(keydown);
  });
  return keydown;
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetWorkPanelStoreForTest();
  resetBrowserStoreForTest();
  resetCurrentConversationForTest();
  resetCurrentProjectForTest();
  wires.records = {};
  wires.lessons = {};
  wires.lessonReads = [];
  wires.folderLessons = {};
  wires.folderLessonReads = [];
  wires.folderChanges = [];
  wires.folders = {};
  wires.folderReads = [];
  wires.gitReads = [];
  wires.opened = [];
  publishNativeActivity(undefined);
  wires.preview = { isOpen: false, activeTab: null, tabs: [], isMaximized: false, showPreview: () => {} };
  setCurrentConversation('conv-1');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the work panel', () => {
  it('shows board, judge and files in one strip, the tabs the conversation used in their place, the rest under 更多', async () => {
    show();
    await settle();
    const strip = () => screen.getAllByRole('tab').map((item) => item.textContent);
    expect(strip()).toEqual(['Board', 'Judge', 'Files']);
    expect(screen.getByRole('tablist')).toHaveAccessibleName(common.workPanel.tabsLabel);
    fireEvent.click(screen.getByTestId('work-panel-more'));
    expect(moreTabs()).toEqual(['hive', 'lessons', 'preview', 'source', 'browser']);

    // Opened from there, a tab joins the strip in its order, and stays once the person moves on.
    fireEvent.click(moreTab('source'));
    expect(selected()).toHaveTextContent('Source');
    fireEvent.click(tab('Board'));
    expect(strip()).toEqual(['Board', 'Judge', 'Files', 'Source']);
    // So does a tab with news: a page the agent opened.
    act(() => {
      openBrowserPage('https://agent.test/', { by: 'agent' });
    });
    expect(strip()).toEqual(['Board', 'Judge', 'Files', 'Source', 'Browser']);
    fromMore('hive');
    fireEvent.click(tab('Board'));
    expect(strip()).toEqual(['Board', 'Judge', 'Hive', 'Files', 'Source', 'Browser']);
  });

  it('is closed until asked, and then out of the way: no width, nothing to reach inside', async () => {
    show();
    await settle();
    expect(panel()).toHaveAttribute('data-open', 'false');
    expect(panel()).toHaveAttribute('inert');
    expect(panel().style.width).toBe('0px');
  });

  it('opens and closes from the titlebar’s toggle and from Cmd+J, and tells the titlebar each time', async () => {
    const states: boolean[] = [];
    const hear = (heard: Event) => states.push((heard as CustomEvent<WorkspaceStateDetail>).detail.collapsed);
    window.addEventListener(WORKSPACE_STATE_EVENT, hear);
    try {
      show();
      await settle();
      let handled = false;
      act(() => {
        handled = dispatchWorkspaceToggleEvent();
      });
      expect(handled).toBe(true);
      expect(panel()).toHaveAttribute('data-open', 'true');
      expect(panel()).not.toHaveAttribute('inert');
      expect(panel().style.width).toBe('360px');

      const chord = shortcut('j');
      expect(chord.defaultPrevented).toBe(true);
      expect(panel()).toHaveAttribute('data-open', 'false');
      shortcut('j');
      expect(panel()).toHaveAttribute('data-open', 'true');
      // The close button in the strip.
      fireEvent.click(screen.getByRole('button', { name: common.workPanel.close }));
      expect(panel()).toHaveAttribute('data-open', 'false');
      expect(states).toEqual([true, false, true, false, true]);
    } finally {
      window.removeEventListener(WORKSPACE_STATE_EVENT, hear);
    }
  });

  it('remembers, per conversation, whether it is open, on which tab and how wide', async () => {
    show();
    await settle();
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.click(tab('Judge'));
    fireEvent.keyDown(screen.getByTestId('work-panel-resize'), { key: 'ArrowLeft' });
    expect(panel().style.width).toBe('376px');

    // A conversation it was never used in starts from that choice; closing it there changes only that one.
    act(() => setCurrentConversation('conv-2'));
    await settle();
    expect(panel()).toHaveAttribute('data-open', 'true');
    expect(selected()).toHaveTextContent('Judge');
    fromMore('hive');
    fireEvent.click(screen.getByRole('button', { name: common.workPanel.close }));

    act(() => setCurrentConversation('conv-1'));
    await settle();
    expect(panel()).toHaveAttribute('data-open', 'true');
    expect(selected()).toHaveTextContent('Judge');
    expect(panel().style.width).toBe('376px');

    act(() => setCurrentConversation('conv-2'));
    await settle();
    expect(panel()).toHaveAttribute('data-open', 'false');
    expect(selected()).toHaveTextContent('Hive');

    // And after a restart.
    resetWorkPanelStoreForTest();
    expect(readWorkPanelMemory('conv-1')).toEqual({ open: true, tab: 'judge', width: 376 });
    expect(readWorkPanelMemory('conv-2')).toEqual({ open: false, tab: 'hive', width: 376 });
  });

  it('puts a dot on a tab with a new board update until it is looked at', async () => {
    wires.records['conv-1'] = [board('Reading the code')];
    show();
    await settle();
    // The board already there is where the conversation stands, not news.
    expect(dots()).toEqual([]);

    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.click(tab('Judge'));
    wires.records['conv-1'] = [...wires.records['conv-1'], board('Running the tests')];
    await poll();
    expect(dots()).toEqual(['board']);
    expect(tab('Board')).toHaveAccessibleName(`Board, new`);

    fireEvent.click(tab('Board'));
    expect(dots()).toEqual([]);
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('Running the tests');
    fireEvent.click(tab('Judge'));
    expect(dots()).toEqual([]);
  });

  it('never opens itself for news: a board update while it is closed waits behind its dot', async () => {
    wires.records['conv-1'] = [board('Reading the code')];
    show();
    await settle();
    // Last left on the judge tab.
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.click(tab('Judge'));
    fireEvent.click(screen.getByRole('button', { name: common.workPanel.close }));

    wires.records['conv-1'] = [...wires.records['conv-1'], board('Running the tests')];
    await poll();
    expect(panel()).toHaveAttribute('data-open', 'false');
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    expect(selected()).toHaveTextContent('Judge');
    expect(dots()).toEqual(['board']);
  });

  it('puts a dot on the lessons tab for a lesson event, and reads the lessons only once they are shown', async () => {
    const lesson = {
      id: 'lesson-1',
      kind: 'pitfall',
      trigger: 'Running the desktop tests',
      lesson: 'Run vitest with Node 24.',
      scope: { cwd: '/work/app' },
      source: { origin: 'outcome' },
      status: 'active',
      uses: { recalled: 1, applied: 0 },
      created: '2026-09-23T00:00:00.000Z',
      updated: '2026-09-23T00:00:00.000Z',
    };
    wires.records['conv-1'] = [event('memory.stored', lesson)];
    wires.lessons['conv-1'] = { project: '/work/app', lessons: [lesson] };
    show();
    await settle();
    // A lesson stored before the conversation was opened is where it stands, not news.
    expect(dots()).toEqual([]);

    wires.records['conv-1'] = [...wires.records['conv-1'], event('memory.recalled', { ids: ['lesson-1'], turn: 2 })];
    await poll();
    expect(dots()).toEqual(['lessons']);
    expect(tab('Lessons')).toHaveAccessibleName('Lessons, new');
    expect(wires.lessonReads).toEqual([]);

    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.click(tab('Lessons'));
    await settle();
    expect(dots()).toEqual([]);
    expect(wires.lessonReads).toEqual(['conv-1']);
    // An app conversation's lessons are read by the conversation, as before the native host: never by a folder.
    expect(wires.folderLessonReads).toEqual([]);
    expect(screen.getByTestId('mu-lessons')).toHaveTextContent('Run vitest with Node 24.');
    expect(screen.getByTestId('mu-lessons-notes')).toHaveTextContent('This turn brought in 1 lesson');
  });

  it('marks the files tab for an edit the agent finished, in the conversation it belongs to', async () => {
    show();
    await settle();
    const edit = (conversation: string, id: string) =>
      act(() =>
        wires.stream?.({
          type: 'acp_tool_call',
          conversation_id: conversation,
          data: { update: { tool_call_id: id, kind: 'edit', status: 'completed' } },
        })
      );
    edit('conv-2', 'a');
    expect(dots()).toEqual([]);
    edit('conv-1', 'b');
    expect(dots()).toEqual(['files']);
    act(() => setCurrentConversation('conv-2'));
    await settle();
    expect(dots()).toEqual(['files']);
  });

  it('comes up on its preview when the person opens something, and only marks the preview when the agent does', async () => {
    show();
    await settle();
    act(() => announcePreviewOpened('agent'));
    expect(panel()).toHaveAttribute('data-open', 'false');
    expect(dots()).toEqual(['preview']);

    act(() => announcePreviewOpened('user'));
    expect(panel()).toHaveAttribute('data-open', 'true');
    expect(selected()).toHaveTextContent('Preview');
    expect(dots()).toEqual([]);
    expect(screen.getByText(common.workPanel.previewEmpty)).toBeInTheDocument();

    // Something the agent does where the person can see it comes up in view.
    fireEvent.click(tab('Board'));
    act(() => announcePreviewOpened('agent-watched'));
    expect(selected()).toHaveTextContent('Preview');
  });

  it('comes up on its browser when the person opens a web page, and only marks the browser when the agent does', async () => {
    show();
    await settle();
    act(() => {
      openBrowserPage('https://agent.test/', { by: 'agent' });
    });
    expect(panel()).toHaveAttribute('data-open', 'false');
    expect(dots()).toEqual(['browser']);

    act(() => {
      openBrowserPage('https://person.test/', { by: 'user' });
    });
    expect(panel()).toHaveAttribute('data-open', 'true');
    expect(selected()).toHaveTextContent('Browser');
    expect(dots()).toEqual([]);
    const body = document.querySelector('[data-body="browser"]') as HTMLElement;
    expect(body).toHaveAttribute('data-active', 'true');
    expect(within(body).getByTestId('browser-panel')).toBeInTheDocument();

    // Already looking at the browser: the agent's next page comes to the front there, with no dot.
    let agentPage: string | null = null;
    act(() => {
      agentPage = openBrowserPage('https://agent.test/next', { by: 'agent' });
    });
    expect(browserNow().activeTabId).toBe(agentPage);
    expect(dots()).toEqual([]);

    // Elsewhere in the panel, the agent's page is news on the browser only.
    fromMore('preview');
    act(() => {
      openBrowserPage('https://agent.test/third', { by: 'agent' });
    });
    expect(selected()).toHaveTextContent('Preview');
    expect(dots()).toEqual(['browser']);

    // mu about to type into its page, or asking the person to confirm a step, brings the browser into view.
    fireEvent.click(tab('Board'));
    act(() => announcePreviewOpened('agent-watched', 'browser'));
    expect(selected()).toHaveTextContent('Browser');
    expect(dots()).toEqual([]);
  });

  it('marks the browser while the agent’s browser tool is at work, in the conversation it belongs to', async () => {
    show();
    await settle();
    const browse = (conversation: string, status: string) =>
      act(() =>
        wires.stream?.({
          type: 'tool_group',
          conversation_id: conversation,
          data: [{ name: 'aionui-browser__navigate_page', status }],
        })
      );
    browse('conv-2', 'Executing');
    expect(dots()).toEqual([]);
    browse('conv-1', 'Success');
    expect(dots()).toEqual([]);
    browse('conv-1', 'Executing');
    expect(dots()).toEqual(['browser']);
    act(() => setCurrentConversation('conv-2'));
    await settle();
    expect(dots()).toEqual(['browser']);
  });

  it('follows the web pages an older build kept in 预览 over to 浏览器, once', async () => {
    // An older build: the project's pages among the preview's tabs, one of them in front, the panel on 预览.
    localStorage.setItem(
      'preview-ui:project-1',
      JSON.stringify({
        isOpen: true,
        activeTabId: 'browser-old',
        tabs: [
          { id: 'md-1', content: '# Notes', content_type: 'markdown', title: 'notes.md' },
          { id: 'browser-old', content: 'https://docs.test/', content_type: 'browser', title: 'Docs' },
        ],
      })
    );
    rememberWorkPanel('conv-1', { open: true, tab: 'preview' });
    show();
    await settle();
    expect(selected()).toHaveTextContent('Preview');

    // The preview's scope switch brings the browser along (PreviewContext calls it with its own).
    act(() => switchBrowserScope('project-1'));
    expect(browserNow().tabs.map((page) => page.url)).toEqual(['https://docs.test/']);
    expect(selected()).toHaveTextContent('Browser');
    expect(readWorkPanelMemory('conv-1')).toMatchObject({ open: true, tab: 'browser' });

    // Once: going back to 预览 and returning to the project leaves the panel where the person put it.
    fireEvent.click(tab('Preview'));
    act(() => switchBrowserScope('project-2'));
    act(() => switchBrowserScope('project-1'));
    expect(browserNow().tabs.map((page) => page.url)).toEqual(['https://docs.test/']);
    expect(selected()).toHaveTextContent('Preview');
  });

  it('lets the browser fill the page by its own button, apart from the preview', async () => {
    show();
    await settle();
    act(() => {
      openBrowserPage('https://person.test/', { by: 'user' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'fill the page' }));
    expect(panel()).toHaveAttribute('data-maximized', 'true');
    expect(screen.getByTestId('browser-panel')).toHaveAttribute('data-maximized', 'true');

    // The preview is not maximized: on its tab the panel is its usual width, and back on the browser it fills again.
    fromMore('preview');
    expect(panel()).not.toHaveAttribute('data-maximized');
    fireEvent.click(tab('Browser'));
    expect(panel()).toHaveAttribute('data-maximized', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'fill the page' }));
    expect(panel()).not.toHaveAttribute('data-maximized');
  });

  it('opens on the hive tab, at the sub-agent clicked in the transcript', async () => {
    wires.records['conv-1'] = [
      event(
        'swarm.snapshot',
        {
          kind: 'hive',
          title: 'Why do the tests flake?',
          bees: [
            { name: 'scout', status: 'thinking', said: 'Reading the retry.' },
            { name: 'critic', status: 'done', said: 'The fix holds.' },
          ],
        },
        { run: 'run-1' }
      ),
    ];
    show();
    await settle();
    // Another conversation's sub-agent changes nothing here.
    act(() => requestHiveFocus({ conversationId: 'conv-2', runId: 'run-1', beeName: 'scout' }));
    expect(panel()).toHaveAttribute('data-open', 'false');

    act(() => requestHiveFocus({ conversationId: 'conv-1', runId: 'run-1', beeName: 'critic' }));
    await settle();
    expect(panel()).toHaveAttribute('data-open', 'true');
    expect(selected()).toHaveTextContent('Hive');
    const critic = document.querySelector('[data-bee="critic"]') as HTMLElement;
    expect(within(critic).getByRole('button', { expanded: true })).toBeInTheDocument();
  });

  it('shares one explorer between files and source, each tab choosing its view', async () => {
    setCurrentProject('project-1');
    show();
    await settle();
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fromMore('source');
    expect(screen.getByTestId('explorer')).toHaveAttribute('data-view', 'changes');
    // The explorer asks for its files view itself (a search hit revealed): the files tab comes forward.
    fireEvent.click(screen.getByText('reveal in files'));
    expect(selected()).toHaveTextContent('Files');
    expect(screen.getAllByTestId('explorer')).toHaveLength(1);
  });

  it('says there are no files in a conversation without a project folder', async () => {
    show();
    await settle();
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.click(tab('Files'));
    expect(screen.getByText(common.workPanel.noProject)).toBeInTheDocument();
    expect(screen.queryByTestId('explorer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('native-files')).not.toBeInTheDocument();
    expect(wires.folderReads).toEqual([]);
  });

  it('moves between tabs with the arrow keys', async () => {
    show();
    await settle();
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    fireEvent.keyDown(tab('Board'), { key: 'ArrowRight' });
    expect(selected()).toHaveTextContent('Judge');
    expect(document.activeElement).toBe(tab('Judge'));
    // Hive and lessons, not used here, wait under 更多: the next tab is files.
    fireEvent.keyDown(tab('Judge'), { key: 'ArrowRight' });
    expect(selected()).toHaveTextContent('Files');
    expect(document.activeElement).toBe(tab('Files'));
    fireEvent.keyDown(tab('Files'), { key: 'Home' });
    expect(selected()).toHaveTextContent('Board');
    fireEvent.keyDown(tab('Board'), { key: 'End' });
    expect(selected()).toHaveTextContent('Files');

    // A web page the person opened puts the browser in the strip, at its end.
    act(() => {
      openBrowserPage('https://person.test/', { by: 'user' });
    });
    fireEvent.keyDown(tab('Browser'), { key: 'Home' });
    expect(selected()).toHaveTextContent('Board');
    fireEvent.keyDown(tab('Board'), { key: 'End' });
    expect(selected()).toHaveTextContent('Browser');
    expect(document.activeElement).toBe(tab('Browser'));
  });

  it('is resized by its handle: live while dragging, remembered when the drag ends, within its bounds', async () => {
    show();
    await settle();
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    const handle = screen.getByTestId('work-panel-resize');
    fireEvent.pointerDown(handle, { clientX: 1_000, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 900 });
    await frame();
    expect(panel().style.width).toBe('460px');
    expect(readWorkPanelMemory('conv-1').width).toBe(360);
    fireEvent.pointerUp(window);
    expect(readWorkPanelMemory('conv-1').width).toBe(460);

    // Never wider than 60% of the window (jsdom's is 1024px wide), nor narrower than 270px.
    fireEvent.pointerDown(handle, { clientX: 1_000, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 0 });
    fireEvent.pointerUp(window);
    expect(readWorkPanelMemory('conv-1').width).toBe(614);
    fireEvent.pointerDown(handle, { clientX: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 1_000 });
    fireEvent.pointerUp(window);
    expect(readWorkPanelMemory('conv-1').width).toBe(270);
    // A double click goes back to the default.
    fireEvent.doubleClick(handle);
    expect(readWorkPanelMemory('conv-1').width).toBe(360);
  });

  it('is a sheet over the chat on a phone, closed by its backdrop', async () => {
    show({ isMobile: true });
    await settle();
    expect(panel()).toHaveAttribute('data-mode', 'sheet');
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
    expect(screen.queryByTestId('work-panel-resize')).not.toBeInTheDocument();
    // A sheet cannot fill the page: the browser offers no button for it.
    expect(within(screen.getByTestId('browser-panel')).queryByRole('button')).not.toBeInTheDocument();
    const backdrop = document.querySelector('[aria-hidden="true"][class*="backdrop"]') as HTMLElement;
    fireEvent.click(backdrop);
    expect(panel()).toHaveAttribute('data-open', 'false');
  });

  it('shows nothing without a conversation', () => {
    act(() => setCurrentConversation(null));
    show();
    expect(screen.queryByTestId('work-panel')).not.toBeInTheDocument();
  });
});

describe('beside a native conversation', () => {
  const lesson = {
    id: 'lesson-1',
    kind: 'pitfall',
    trigger: 'Running the desktop tests',
    lesson: 'Run vitest with Node 24.',
    scope: { cwd: '/work/app' },
    source: { origin: 'outcome' },
    status: 'active',
    uses: { recalled: 1, applied: 0 },
    created: '2026-09-23T00:00:00.000Z',
    updated: '2026-09-23T00:00:00.000Z',
  };
  /** What the native page publishes: its view as activity, and its folder once known. */
  const native = (events: Activity[] = [], cwd: string | null = '/work/app') =>
    act(() => {
      publishNativeActivity({
        conversationId: 'conv-1',
        activity: { events, loading: false, settled: true },
        ...(cwd ? { cwd } : {}),
      });
    });
  const openPanel = () =>
    act(() => {
      dispatchWorkspaceToggleEvent();
    });
  const files = () => screen.queryAllByTestId('native-file').map((row) => row.dataset.path);

  it('reads its lessons by the folder it works in, and retires one there', async () => {
    wires.folderLessons['/work/app'] = { project: '/work/app', lessons: [lesson] };
    native();
    show();
    await settle();
    openPanel();
    fromMore('lessons');
    await settle();
    expect(wires.folderLessonReads).toEqual(['/work/app']);
    expect(wires.lessonReads).toEqual([]);
    expect(screen.getByTestId('mu-lessons')).toHaveTextContent('Run vitest with Node 24.');

    wires.folderLessons['/work/app'] = { project: '/work/app', lessons: [{ ...lesson, status: 'retired' }] };
    const row = screen.getByTestId('mu-lesson');
    fireEvent.click(within(row).getAllByRole('button')[0]);
    fireEvent.click(within(row).getByRole('button', { name: common.kyrn.lessonsView.retire }));
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: common.kyrn.lessonsView.retire }));
    });
    expect(wires.folderChanges).toEqual([{ cwd: '/work/app', id: 'lesson-1', action: 'retire' }]);
    expect(screen.queryAllByTestId('mu-lesson')).toHaveLength(0);
  });

  it('says its lessons show once the conversation has opened, while its folder is not known', async () => {
    native([], null);
    show();
    await settle();
    openPanel();
    fromMore('lessons');
    await settle();
    expect(screen.getByTestId('kernel-no-lessons')).toHaveTextContent(mu.native.panel.noLessons);
    expect(wires.folderLessonReads).toEqual([]);
  });

  it('lists its folder under files, again after each run, and opens a file in the preview', async () => {
    wires.folders['/work/app'] = {
      '': [
        { name: 'notes', path: 'notes', kind: 'dir' },
        { name: 'README.md', path: 'README.md', kind: 'file' },
      ],
      notes: [],
    };
    native();
    show();
    await settle();
    // Nothing is read while the tab is not shown.
    expect(wires.folderReads).toEqual([]);
    openPanel();
    fireEvent.click(tab('Files'));
    await settle();
    expect(screen.queryByTestId('explorer')).not.toBeInTheDocument();
    expect(screen.getByTestId('native-files')).toHaveAccessibleName('Files in app');
    expect(files()).toEqual(['notes', 'README.md']);
    fireEvent.click(screen.getByText('notes'));
    await settle();
    expect(screen.getByText('notes').closest('button')).toHaveAttribute('aria-expanded', 'true');

    // The model wrote a file; the run's end has the folder and its open directory read again.
    wires.folders['/work/app'].notes = [{ name: 'hello.txt', path: 'notes/hello.txt', kind: 'file' }];
    wires.folderReads = [];
    native([event('agent_start', {}), event('agent_settled', {})]);
    await settle();
    expect(wires.folderReads.toSorted()).toEqual(['/work/app:', '/work/app:notes']);
    expect(files()).toEqual(['notes', 'notes/hello.txt', 'README.md']);
    fireEvent.click(screen.getByText('hello.txt'));
    expect(wires.opened).toEqual(['/work/app/notes/hello.txt']);
  });

  it('shows its folder’s changes under source, read with git by the folder', async () => {
    native();
    show();
    await settle();
    openPanel();
    expect(wires.gitReads).toEqual([]);
    fromMore('source');
    await settle();
    expect(screen.getByTestId('native-source')).toHaveAttribute('data-state', 'changes');
    expect(screen.getByTestId('native-source')).toHaveAccessibleName('Changes in app');
    expect(screen.getByTestId('native-source-file')).toHaveAttribute('data-path', 'notes/hello.txt');
    expect(wires.gitReads).toEqual(['/work/app']);
    expect(screen.queryByTestId('explorer')).not.toBeInTheDocument();
  });

  it('keeps an app conversation’s source tab the project explorer’s, and reads no folder with git', async () => {
    setCurrentProject('project-1');
    native();
    show();
    await settle();
    openPanel();
    fromMore('source');
    await settle();
    expect(screen.getByTestId('explorer')).toHaveAttribute('data-view', 'changes');
    expect(screen.queryByTestId('native-source')).not.toBeInTheDocument();
    expect(wires.gitReads).toEqual([]);
  });

  it('keeps an app conversation’s project explorer when both are known', async () => {
    setCurrentProject('project-1');
    native();
    show();
    await settle();
    openPanel();
    fireEvent.click(tab('Files'));
    expect(screen.getByTestId('explorer')).toHaveAttribute('data-view', 'files');
    expect(screen.queryByTestId('native-files')).not.toBeInTheDocument();
  });
});

describe('where the panel sits', () => {
  it('beside the transcript while both fit, in its place when the row is too narrow, as a sheet on a phone', () => {
    // 60% of the window at most, 360px left to the transcript beside the panel's 1px edge, 270px at least.
    expect(panelGeometry(1400, 1024, false, 360)).toEqual({ mode: 'dock', width: 360, max: 614 });
    expect(panelGeometry(1400, 1024, false, 900)).toEqual({ mode: 'dock', width: 614, max: 614 });
    expect(panelGeometry(900, 1600, false, 600)).toEqual({ mode: 'dock', width: 539, max: 539 });
    // A 900px window with the sidebar open leaves the row 639px: the transcript shrinks, nothing is covered (B4).
    expect(panelGeometry(639, 900, false, 360)).toEqual({ mode: 'dock', width: 278, max: 278 });
    // 600px cannot hold 360 + 1 + 270: the panel takes the row instead of lying over the transcript.
    expect(panelGeometry(600, 1024, false, 360)).toEqual({ mode: 'fill', width: 600, max: 600 });
    expect(panelGeometry(390, 390, true, 360)).toEqual({ mode: 'sheet', width: 332, max: 332 });
  });

  describe('in a row too narrow for both', () => {
    const showRow = (rowWidth: number) =>
      render(
        <I18nextProvider i18n={i18n}>
          <MemoryRouter>
            <Row rowWidth={rowWidth} />
          </MemoryRouter>
        </I18nextProvider>
      );
    const open = async () => {
      act(() => {
        dispatchWorkspaceToggleEvent();
      });
      await frame();
    };

    it('takes the whole row, and leads its strip with a named way back to the conversation', async () => {
      showRow(600);
      await settle();
      await open();

      expect(panel()).toHaveAttribute('data-mode', 'fill');
      expect(panel().style.width).toBe('');
      // Nothing to drag: the panel has the row.
      expect(screen.queryByTestId('work-panel-resize')).not.toBeInTheDocument();

      const back = screen.getByTestId('work-panel-back');
      expect(back).toHaveTextContent('Back to Chat');
      fireEvent.click(back);
      expect(panel()).toHaveAttribute('data-open', 'false');
    });

    it('docks beside the transcript, without a way back of its own, once the row holds both', async () => {
      showRow(1400);
      await settle();
      await open();

      expect(panel()).toHaveAttribute('data-mode', 'dock');
      expect(screen.getByTestId('work-panel-resize')).toBeInTheDocument();
      expect(screen.queryByTestId('work-panel-back')).not.toBeInTheDocument();
    });
  });
});
