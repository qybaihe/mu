import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderGitStatus, GitChange } from '@/common/kyrn/gitBridge';
import NativeSource from '@/renderer/pages/native/components/NativeSource';
import { FOLDER_GIT_GAP_MS, forgetFolderGit } from '@/renderer/pages/native/hooks/useFolderGit';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import conversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import mu from '@/renderer/services/i18n/locales/en-US/mu.json';

/**
 * The source tab beside a native conversation (docs/native-host-ui.md): the folder's repository as the main process
 * reads it with git, its states (git cannot run, no repository, clean, changed, a failed read), the sections and rows,
 * a row's diff in the preview, and when the tab reads again.
 */

type Answer = { ok: true; data: unknown } | { ok: false; error: string; code?: string };

const wires = vi.hoisted(() => ({
  /** Status answers, in order; the last one repeats. */
  answers: [] as unknown[],
  statusCalls: [] as string[],
  diffs: {} as Record<string, unknown>,
  diffCalls: [] as unknown[],
  opened: [] as Array<{ content: string; type: string; meta: unknown }>,
}));

vi.mock('@/common/kyrn/gitBridge', () => ({
  kyrnGitBridge: {
    status: {
      invoke: async ({ cwd }: { cwd: string }) => {
        wires.statusCalls.push(cwd);
        return wires.answers.length > 1 ? wires.answers.shift() : wires.answers[0];
      },
    },
    diff: {
      invoke: async (request: { path: string }) => {
        wires.diffCalls.push(request);
        return wires.diffs[request.path] ?? { ok: false, error: 'git diff ended with 128', code: 'unknown' };
      },
    },
  },
}));
vi.mock('@/common/kyrn/bridge', () => ({
  unwrap: (result: Answer) => {
    if (!result.ok) throw new Error(result.error);
    return result.data;
  },
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    openPreview: (content: string, type: string, meta: unknown) => wires.opened.push({ content, type, meta }),
  }),
}));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { common, conversation, mu } } },
    interpolation: { escapeValue: false },
  });
});

beforeEach(() => {
  forgetFolderGit();
  wires.answers = [];
  wires.statusCalls = [];
  wires.diffs = {};
  wires.diffCalls = [];
  wires.opened = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ok = (data: FolderGitStatus): Answer => ({ ok: true, data });
const repository = (changes: GitChange[], more: Partial<Extract<FolderGitStatus, { state: 'repository' }>> = {}) =>
  ok({
    state: 'repository',
    root: '/work/app',
    branch: { name: 'main', commit: 'abc1234' },
    changes,
    more: 0,
    truncated: false,
    ...more,
  });

const settle = () =>
  act(async () => {
    // oxlint-disable-next-line no-await-in-loop -- one microtask after another, as the answers resolve
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });

const show = (props: { visible?: boolean; refresh?: string } = {}) => {
  const view = (next: { visible?: boolean; refresh?: string }) => (
    <I18nextProvider i18n={i18n}>
      <NativeSource cwd='/work/app' visible={next.visible ?? true} refresh={next.refresh ?? 'r0'} />
    </I18nextProvider>
  );
  const rendered = render(view(props));
  return { rerender: (next: { visible?: boolean; refresh?: string }) => rendered.rerender(view(next)) };
};

const tab = () => screen.getByTestId('native-source');
const note = () => screen.getByTestId('native-source-note');
const rows = () =>
  screen
    .getAllByTestId('native-source-file')
    .map((row) => `${row.dataset.group}:${row.dataset.path}:${row.dataset.kind}`);

describe('what the tab says when there is nothing to list', () => {
  it('says plainly that git cannot run, with what git said', async () => {
    wires.answers = [ok({ state: 'no-git', reason: 'You have not agreed to the Xcode license agreements.' })];
    show();
    await settle();
    expect(tab()).toHaveAttribute('data-state', 'no-git');
    expect(note()).toHaveTextContent(mu.native.panel.source.noGit);
    expect(screen.getByTestId('native-source-reason')).toHaveTextContent(
      'You have not agreed to the Xcode license agreements.'
    );
    expect(tab()).toHaveAccessibleName('Changes in app');
  });

  it('says the folder is in no repository', async () => {
    wires.answers = [ok({ state: 'not-repository' })];
    show();
    await settle();
    expect(tab()).toHaveAttribute('data-state', 'not-repository');
    expect(note()).toHaveTextContent(conversation.explorer.scm.notARepository);
    expect(screen.getByTestId('native-source-branch')).toHaveTextContent('app');
  });

  it('says a clean repository has no changes, under its branch', async () => {
    wires.answers = [repository([])];
    show();
    await settle();
    expect(tab()).toHaveAttribute('data-state', 'clean');
    expect(note()).toHaveTextContent(conversation.explorer.scm.noChanges);
    expect(screen.getByTestId('native-source-branch')).toHaveTextContent('main');
  });

  it('says a read failed, with the reason', async () => {
    wires.answers = [{ ok: false, error: 'git status ended with 128', code: 'unknown' }];
    show();
    await settle();
    expect(tab()).toHaveAttribute('data-state', 'failed');
    expect(note()).toHaveTextContent(conversation.explorer.scm.loadFailed);
    expect(screen.getByTestId('native-source-reason')).toHaveTextContent('git status ended with 128');
  });
});

describe('a repository with changes', () => {
  const changes: GitChange[] = [
    { path: 'notes/hello.txt', area: 'untracked', kind: 'untracked' },
    { path: 'README.md', area: 'unstaged', kind: 'modified' },
    { path: 'a.txt', area: 'staged', kind: 'modified' },
    { path: 'a.txt', area: 'unstaged', kind: 'modified' },
    { path: 'b2.txt', area: 'staged', kind: 'renamed', from: 'b.txt' },
    { path: 'gone.txt', area: 'unstaged', kind: 'deleted' },
    { path: 'merge.txt', area: 'conflicted', kind: 'conflicted' },
  ];

  it('lists sections in order, a row per file and side with its letter', async () => {
    wires.answers = [repository(changes)];
    show();
    await settle();
    expect(tab()).toHaveAttribute('data-state', 'changes');
    const groups = screen.getAllByTestId('native-source-group');
    expect(groups.map((group) => group.dataset.group)).toEqual(['conflicted', 'staged', 'unstaged', 'untracked']);
    expect(within(groups[0]).getByText(conversation.explorer.scm.groups.blocked)).toBeInTheDocument();
    expect(within(groups[1]).getByText(conversation.explorer.scm.groups.staged)).toBeInTheDocument();
    expect(within(groups[3]).getByText(mu.native.panel.source.untracked)).toBeInTheDocument();
    expect(rows()).toEqual([
      'conflicted:merge.txt:conflicted',
      'staged:a.txt:modified',
      'staged:b2.txt:renamed',
      'unstaged:README.md:modified',
      'unstaged:a.txt:modified',
      'unstaged:gone.txt:deleted',
      'untracked:notes/hello.txt:untracked',
    ]);
    const row = (path: string, group: string) =>
      screen
        .getAllByTestId('native-source-file')
        .find((element) => element.dataset.path === path && element.dataset.group === group) as HTMLElement;
    // The classic row's letters: A for a new file, M, D, R with the old name, ! for a conflict.
    expect(row('notes/hello.txt', 'untracked')).toHaveTextContent(
      `${conversation.explorer.scm.badge.created}hello.txt`
    );
    expect(row('README.md', 'unstaged')).toHaveTextContent(conversation.explorer.scm.badge.modified);
    expect(row('gone.txt', 'unstaged')).toHaveTextContent(conversation.explorer.scm.badge.deleted);
    expect(row('b2.txt', 'staged')).toHaveTextContent('b.txt → b2.txt');
    expect(row('merge.txt', 'conflicted')).toHaveTextContent(conversation.explorer.scm.badge.conflicted);
    // Read only: no stage, unstage or discard.
    expect(tab().querySelectorAll('[data-scm-action]')).toHaveLength(0);
  });

  it('opens a row’s diff in the preview, for the side the row is on', async () => {
    wires.answers = [repository(changes)];
    wires.diffs['README.md'] = {
      ok: true,
      data: { patch: 'diff --git a/README.md b/README.md\n-# app\n+# app, changed\n', binary: false, truncated: false },
    };
    show();
    await settle();
    const readme = screen.getAllByTestId('native-source-file').find((element) => element.dataset.path === 'README.md');
    fireEvent.click(within(readme as HTMLElement).getByRole('button'));
    await settle();
    expect(wires.diffCalls).toEqual([{ cwd: '/work/app', path: 'README.md', area: 'unstaged' }]);
    expect(wires.opened).toEqual([
      {
        content: 'diff --git a/README.md b/README.md\n-# app\n+# app, changed\n',
        type: 'diff',
        meta: { file_name: 'README.md', title: 'README.md' },
      },
    ]);
    expect(within(readme as HTMLElement).getByRole('button')).toHaveAttribute('aria-current', 'true');

    // A rename asks with its old path.
    const renamed = screen.getAllByTestId('native-source-file').find((element) => element.dataset.path === 'b2.txt');
    fireEvent.click(within(renamed as HTMLElement).getByRole('button'));
    await settle();
    expect(wires.diffCalls.at(-1)).toEqual({ cwd: '/work/app', path: 'b2.txt', area: 'staged', from: 'b.txt' });
  });

  it('says a file is binary, that a diff was cut, and that a diff could not be read', async () => {
    wires.answers = [
      repository([
        { path: 'image.png', area: 'untracked', kind: 'untracked' },
        { path: 'long.txt', area: 'untracked', kind: 'untracked' },
        { path: 'gone.txt', area: 'untracked', kind: 'untracked' },
      ]),
    ];
    wires.diffs['image.png'] = { ok: true, data: { patch: '', binary: true, truncated: false } };
    wires.diffs['long.txt'] = {
      ok: true,
      data: { patch: '@@ -0,0 +1,2 @@\n+one\n+two\n', binary: false, truncated: true },
    };
    show();
    await settle();
    const click = async (path: string) => {
      const row = screen.getAllByTestId('native-source-file').find((element) => element.dataset.path === path);
      fireEvent.click(within(row as HTMLElement).getByRole('button'));
      await settle();
    };
    await click('image.png');
    expect(wires.opened.at(-1)?.content).toBe(conversation.explorer.scm.diff.binary);
    await click('long.txt');
    expect(wires.opened.at(-1)?.content).toBe(
      `@@ -0,0 +1,2 @@\n+one\n+two\n ${conversation.explorer.scm.diff.truncated}\n`
    );
    expect(screen.queryByTestId('native-source-diff-failed')).not.toBeInTheDocument();
    await click('gone.txt');
    expect(wires.opened).toHaveLength(2);
    expect(screen.getByTestId('native-source-diff-failed')).toHaveTextContent(
      `${conversation.explorer.scm.diff.failed}gone.txt`
    );
    expect(screen.getByTestId('native-source-diff-failed')).toHaveAttribute('title', 'git diff ended with 128');
  });

  it('folds a section on its header', async () => {
    wires.answers = [repository(changes)];
    show();
    await settle();
    fireEvent.click(screen.getByText(mu.native.panel.source.untracked));
    expect(rows()).not.toContain('untracked:notes/hello.txt:untracked');
    fireEvent.click(screen.getByText(mu.native.panel.source.untracked));
    expect(rows()).toContain('untracked:notes/hello.txt:untracked');
  });

  it('counts the changes left out, and says when git wrote more than was read', async () => {
    wires.answers = [repository(changes.slice(0, 1), { more: 5 })];
    show();
    await settle();
    expect(screen.getByTestId('native-source-more')).toHaveTextContent('Not shown: 5 more');
    cleanup();
    wires.answers = [repository(changes.slice(0, 1), { truncated: true })];
    show();
    await settle();
    expect(screen.getByTestId('native-source-more')).toHaveTextContent(conversation.explorer.scm.truncated);
  });

  it('shows how the branch stands: ahead and behind, detached, before the first commit', async () => {
    wires.answers = [
      repository(changes, {
        branch: { name: 'main', commit: 'abc1234', upstream: 'origin/main', ahead: 2, behind: 1 },
      }),
    ];
    show();
    await settle();
    expect(screen.getByTestId('native-source-branch')).toHaveTextContent('main');
    expect(screen.getByTestId('native-source-upstream')).toHaveTextContent('↑2 ↓1');
    expect(screen.getByTestId('native-source-upstream')).toHaveAttribute('title', '2 ahead of origin/main, 1 behind');
    cleanup();
    wires.answers = [repository(changes, { branch: { commit: 'abc1234' } })];
    show();
    await settle();
    expect(screen.getByTestId('native-source-branch')).toHaveTextContent('Detached at abc1234');
    expect(screen.queryByTestId('native-source-upstream')).not.toBeInTheDocument();
    cleanup();
    wires.answers = [repository(changes, { branch: { name: 'trunk' } })];
    show();
    await settle();
    expect(screen.getByTestId('native-source-branch')).toHaveTextContent('trunk · No commits yet');
  });
});

describe('when the tab reads', () => {
  it('reads nothing while out of view, then when it comes into view', async () => {
    wires.answers = [repository([])];
    const { rerender } = show({ visible: false });
    await settle();
    expect(wires.statusCalls).toEqual([]);
    expect(tab()).toHaveAttribute('data-state', 'loading');
    rerender({ visible: true });
    await settle();
    expect(wires.statusCalls).toEqual(['/work/app']);
  });

  it('reads again after a run, at most once in two seconds, and at once on the button', async () => {
    vi.useFakeTimers();
    wires.answers = [repository([]), repository([{ path: 'notes/hello.txt', area: 'untracked', kind: 'untracked' }])];
    const { rerender } = show({ refresh: 'r0' });
    await settle();
    expect(wires.statusCalls).toHaveLength(1);
    expect(tab()).toHaveAttribute('data-state', 'clean');
    // A run ended right after the first read: the second waits for the gap.
    rerender({ refresh: 'r1' });
    await settle();
    expect(wires.statusCalls).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOLDER_GIT_GAP_MS);
    });
    await settle();
    expect(wires.statusCalls).toHaveLength(2);
    expect(tab()).toHaveAttribute('data-state', 'changes');
    // The button does not wait.
    fireEvent.click(screen.getByTestId('native-source-refresh'));
    await settle();
    expect(wires.statusCalls).toHaveLength(3);
    // Nothing more comes on its own: no poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(wires.statusCalls).toHaveLength(3);
  });
});

const changed = (path: string): GitChange => ({ path, area: 'unstaged', kind: 'modified' });

describe('when the tab comes back', () => {
  it('shows what it showed at once, while git is asked again', async () => {
    wires.answers = [repository([changed('a.txt')])];
    show();
    await settle();
    expect(rows()).toEqual(['unstaged:a.txt:modified']);
    // The tab is made again when the person comes back to it from the files: no spinner first.
    cleanup();
    wires.answers = [repository([changed('a.txt'), changed('b.txt')])];
    show();
    expect(tab()).toHaveAttribute('data-state', 'changes');
    expect(rows()).toEqual(['unstaged:a.txt:modified']);
    await settle();
    expect(rows()).toEqual(['unstaged:a.txt:modified', 'unstaged:b.txt:modified']);
  });

  it('starts another folder from nothing: the answer kept is the folder’s own', async () => {
    wires.answers = [repository([changed('a.txt')])];
    show();
    await settle();
    expect(rows()).toEqual(['unstaged:a.txt:modified']);
    cleanup();
    wires.answers = [ok({ state: 'not-repository' })];
    render(
      <I18nextProvider i18n={i18n}>
        <NativeSource cwd='/work/other' visible refresh='r0' />
      </I18nextProvider>
    );
    expect(tab()).toHaveAttribute('data-state', 'loading');
    await settle();
    expect(tab()).toHaveAttribute('data-state', 'not-repository');
  });
});
