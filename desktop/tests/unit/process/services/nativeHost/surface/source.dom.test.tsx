import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderGitStatus, GitChange } from '@/common/kyrn/gitBridge';
import NativeSource from '@/renderer/pages/native/components/source/NativeSource';
import { FOLDER_GIT_GAP_MS, forgetFolderGit } from '@/renderer/pages/native/hooks/useFolderGit';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import conversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import mu from '@/renderer/services/i18n/locales/en-US/mu.json';
import { emitter } from '@/renderer/utils/emitter';
import { Message } from '@arco-design/web-react';

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
  /** Stage, unstage and commit requests, and how each is answered (by default: done, nothing to say). */
  acts: [] as Array<[string, unknown]>,
  answer: {} as Record<string, unknown>,
  act(kind: string, request: unknown): unknown {
    this.acts.push([kind, request]);
    return this.answer[kind] ?? { ok: true, data: undefined };
  },
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
    stage: { invoke: async (request: unknown) => wires.act('stage', request) },
    unstage: { invoke: async (request: unknown) => wires.act('unstage', request) },
    commit: { invoke: async (request: unknown) => wires.act('commit', request) },
  },
}));
vi.mock('@/renderer/utils/platform', () => ({ isMacOS: () => true, openExternalUrl: vi.fn() }));
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
  wires.acts = [];
  wires.answer = {};
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

const show = (props: { visible?: boolean; refresh?: string; conversationId?: string } = {}) => {
  const view = (next: { visible?: boolean; refresh?: string; conversationId?: string }) => (
    <I18nextProvider i18n={i18n}>
      <NativeSource
        cwd='/work/app'
        visible={next.visible ?? true}
        refresh={next.refresh ?? 'r0'}
        conversationId={next.conversationId ?? props.conversationId}
      />
    </I18nextProvider>
  );
  const rendered = render(view(props));
  return { rerender: (next: { visible?: boolean; refresh?: string }) => rendered.rerender(view(next)) };
};

const tab = () => screen.getByTestId('native-source');
/** A file's row itself (it holds its stage or unstage button too). */
const rowButton = (row: Element | undefined): HTMLElement => row?.querySelector('[data-scm-resource]') as HTMLElement;
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
    // A row stages or unstages its file; a conflict has no button, and nothing is ever discarded here.
    const actions = (element: HTMLElement) =>
      [...element.querySelectorAll<HTMLElement>('[data-scm-action]')].map((button) => button.dataset.scmAction);
    expect(actions(row('notes/hello.txt', 'untracked'))).toEqual(['stage']);
    expect(actions(row('README.md', 'unstaged'))).toEqual(['stage']);
    expect(actions(row('a.txt', 'staged'))).toEqual(['unstage']);
    expect(actions(row('merge.txt', 'conflicted'))).toEqual([]);
    expect(tab().querySelectorAll('[data-scm-action="discard"]')).toHaveLength(0);
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
    fireEvent.click(rowButton(readme));
    await settle();
    expect(wires.diffCalls).toEqual([{ cwd: '/work/app', path: 'README.md', area: 'unstaged' }]);
    expect(wires.opened).toEqual([
      {
        content: 'diff --git a/README.md b/README.md\n-# app\n+# app, changed\n',
        type: 'diff',
        meta: { file_name: 'README.md', title: 'README.md' },
      },
    ]);
    expect(rowButton(readme)).toHaveAttribute('aria-current', 'true');

    // A rename asks with its old path.
    const renamed = screen.getAllByTestId('native-source-file').find((element) => element.dataset.path === 'b2.txt');
    fireEvent.click(rowButton(renamed));
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
      fireEvent.click(rowButton(row));
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
    expect(screen.getByTestId('native-source-more')).toHaveTextContent('5 more not shown');
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

describe('staging from the tab', () => {
  const changes: GitChange[] = [
    { path: 'b2.txt', from: 'b.txt', area: 'staged', kind: 'renamed' },
    { path: 'README.md', area: 'unstaged', kind: 'modified' },
    { path: 'notes/hello.txt', area: 'untracked', kind: 'untracked' },
    { path: 'notes/more.txt', area: 'untracked', kind: 'untracked' },
  ];
  const file = (path: string) =>
    screen.getAllByTestId('native-source-file').find((element) => element.dataset.path === path) as HTMLElement;
  const section = (area: string) =>
    screen.getAllByTestId('native-source-group').find((element) => element.dataset.group === area) as HTMLElement;

  it('stages a file from its row and a section’s files at once, unstages a rename with its old name, then reads again', async () => {
    wires.answers = [repository(changes)];
    show();
    await settle();
    const reads = wires.statusCalls.length;

    fireEvent.click(file('README.md').querySelector('[data-scm-action="stage"]') as HTMLElement);
    await settle();
    fireEvent.click(within(section('untracked')).getByTestId('native-source-section-action'));
    await settle();
    fireEvent.click(file('b2.txt').querySelector('[data-scm-action="unstage"]') as HTMLElement);
    await settle();
    expect(wires.acts).toEqual([
      ['stage', { cwd: '/work/app', paths: ['README.md'] }],
      ['stage', { cwd: '/work/app', paths: ['notes/hello.txt', 'notes/more.txt'] }],
      ['unstage', { cwd: '/work/app', paths: ['b2.txt', 'b.txt'] }],
    ]);
    expect(within(section('staged')).getByTestId('native-source-section-action')).toHaveAttribute(
      'data-action',
      'unstage'
    );
    // After each, the repository is read again.
    expect(wires.statusCalls.length).toBe(reads + 3);
  });

  it('says what git said when it refuses', async () => {
    wires.answers = [repository(changes)];
    wires.answer.stage = { ok: false, error: 'fatal: Unable to create index.lock: File exists.' };
    const said = vi.spyOn(Message, 'error').mockImplementation(() => () => {});
    show();
    await settle();
    fireEvent.click(file('README.md').querySelector('[data-scm-action="stage"]') as HTMLElement);
    await settle();
    expect(said).toHaveBeenCalledWith(
      mu.native.panel.source.actionFailed.replace('{{reason}}', 'fatal: Unable to create index.lock: File exists.')
    );
    said.mockRestore();
  });
});

describe('the commit box', () => {
  const staged: GitChange = { path: 'a.txt', area: 'staged', kind: 'modified' };
  const message = () => screen.getByTestId('native-commit-message');
  const commit = () => screen.getByTestId('native-commit');

  it('commits what is staged with the message, empties the box and says the commit', async () => {
    wires.answers = [repository([staged, changed('b.txt')])];
    wires.answer.commit = { ok: true, data: { committed: true, commit: 'def5678', subject: 'Fix the parser' } };
    const said = vi.spyOn(Message, 'success').mockImplementation(() => () => {});
    show();
    await settle();
    expect(commit()).toHaveTextContent(mu.native.panel.source.commit.commit);
    expect(commit()).toBeDisabled();
    fireEvent.change(message(), { target: { value: 'Fix the parser\n\nIt took dashes for options.' } });
    expect(commit()).toBeEnabled();
    const reads = wires.statusCalls.length;
    fireEvent.click(commit());
    await settle();
    expect(wires.acts).toEqual([
      ['commit', { cwd: '/work/app', message: 'Fix the parser\n\nIt took dashes for options.' }],
    ]);
    expect(message()).toHaveValue('');
    expect(said).toHaveBeenCalledWith('Committed def5678: Fix the parser');
    said.mockRestore();
    expect(wires.statusCalls.length).toBe(reads + 1);
  });

  it('commits every change when nothing is staged, and with ⌘Enter', async () => {
    wires.answers = [repository([changed('a.txt'), { path: 'new.txt', area: 'untracked', kind: 'untracked' }])];
    show();
    await settle();
    expect(commit()).toHaveTextContent(mu.native.panel.source.commit.commitAll);
    expect(commit()).toHaveAttribute('data-all', 'true');
    fireEvent.change(message(), { target: { value: 'Everything' } });
    fireEvent.keyDown(message(), { key: 'Enter', metaKey: true });
    await settle();
    expect(wires.acts).toEqual([['commit', { cwd: '/work/app', message: 'Everything', all: true }]]);
  });

  it('keeps the message and shows what git and the hooks wrote when git does not commit', async () => {
    wires.answers = [repository([staged])];
    wires.answer.commit = {
      ok: true,
      data: { committed: false, output: 'eslint: 2 problems\nhusky - pre-commit failed' },
    };
    show();
    await settle();
    fireEvent.change(message(), { target: { value: 'Lint me' } });
    fireEvent.click(commit());
    await settle();
    const refusal = screen.getByTestId('native-commit-refusal');
    expect(refusal).toHaveTextContent(mu.native.panel.source.commit.failed);
    expect(refusal).toHaveTextContent('husky - pre-commit failed');
    expect(message()).toHaveValue('Lint me');
    fireEvent.click(within(refusal).getByRole('button', { name: mu.native.panel.source.commit.dismiss }));
    expect(screen.queryByTestId('native-commit-refusal')).toBeNull();
  });

  it('commits nothing while a merge has conflicts', async () => {
    wires.answers = [repository([staged, { path: 'm.txt', area: 'conflicted', kind: 'conflicted' }])];
    show();
    await settle();
    fireEvent.change(message(), { target: { value: 'Merge' } });
    expect(commit()).toBeDisabled();
    expect(screen.getByTestId('native-commit-blocked')).toHaveTextContent(mu.native.panel.source.commit.conflicts);
  });

  it('asks mu to commit in the conversation beside the tab, and is not there with no changes', async () => {
    const sent = vi.spyOn(emitter, 'emit');
    wires.answers = [repository([staged])];
    show({ conversationId: 'c1' });
    await settle();
    fireEvent.click(screen.getByTestId('native-commit-ask'));
    expect(sent).toHaveBeenCalledWith('sendbox.command', '/commit', 'c1');
    sent.mockRestore();
    cleanup();

    // No conversation to send it to: no button. No changes: no box.
    forgetFolderGit();
    wires.answers = [repository([staged])];
    show();
    await settle();
    expect(screen.queryByTestId('native-commit-ask')).toBeNull();
    cleanup();
    forgetFolderGit();
    wires.answers = [repository([])];
    show({ conversationId: 'c1' });
    await settle();
    expect(screen.queryByTestId('native-commit-box')).toBeNull();
  });
});
