/**
 * Comments on a diff's lines, as the person writes them in the preview: the line under the pointer offers the button,
 * the box opens under the line, and the comment goes to the send box with its file, line and the line itself; the
 * comments the send box holds show under their lines and can be taken back. Hunk headers take none, nor does the
 * side-by-side view. The send box's store is the test's own.
 */

import React, { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import preview from '@/renderer/services/i18n/locales/en-US/preview.json';
import type { DomSnippet } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { snippets: [] as DomSnippet[] };
  const set = (snippets: DomSnippet[]) => {
    state.snippets = snippets;
    for (const listener of listeners) listener();
  };
  return { state, listeners, set, added: [] as unknown[][] };
});

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => {
    const snippets = useSyncExternalStore(
      (listener) => {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
      () => store.state.snippets
    );
    return {
      domSnippets: snippets,
      addDomSnippet: (tag: string, html: string, about?: string, more?: Partial<DomSnippet>) => {
        store.added.push([tag, html, about, more]);
        store.set([...store.state.snippets, { id: `s${store.added.length}`, tag, html, about, ...more }]);
      },
      removeDomSnippet: (id: string) => store.set(store.state.snippets.filter((snippet) => snippet.id !== id)),
    };
  },
}));
vi.mock('@/renderer/utils/platform', () => ({ isMacOS: () => true, openExternalUrl: vi.fn() }));
vi.mock('@/renderer/pages/conversation/Preview/components/renderers/SelectionToolbar', () => ({ default: () => null }));

import DiffPreview from '@/renderer/pages/conversation/Preview/components/viewers/diff/DiffViewer';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
  '',
].join('\n');

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: { common, preview } } } });
});
beforeEach(() => {
  store.set([]);
  store.added = [];
});
afterEach(cleanup);

const show = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <DiffPreview content={DIFF} hideToolbar />
    </I18nextProvider>
  );

/** The diff's row whose code holds this text. */
const row = (text: string) =>
  Array.from(document.querySelectorAll('tr')).find((each) =>
    each.querySelector('.d2h-code-line-ctn')?.textContent?.includes(text)
  ) as HTMLTableRowElement;
const hover = (target: Element) => fireEvent.mouseMove(target);
const addButton = () => screen.queryByTestId('diff-comment-add');
const editor = () => screen.getByTestId('diff-comment-editor');
const write = (text: string) =>
  fireEvent.change(within(editor()).getByRole('textbox', { name: preview.diffComment.placeholder }), {
    target: { value: text },
  });

describe('a comment on a line of a diff', () => {
  it('opens under the line the pointer is on, and goes to the send box with the file, the line and its code', () => {
    show();
    hover(row('const b = 3').querySelector('.d2h-code-line-ctn')!);
    expect(addButton()).toHaveAccessibleName(preview.diffComment.add);
    fireEvent.click(addButton()!);

    // The box is the row right under the line.
    expect(row('const b = 3').nextElementSibling).toContainElement(editor());
    expect(within(editor()).getByText(preview.diffComment.hint)).toBeInTheDocument();
    expect(screen.getByTestId('diff-comment-save')).toBeDisabled();
    write('Make it 30.');
    fireEvent.click(screen.getByTestId('diff-comment-save'));

    expect(store.added).toEqual([
      [
        'app.ts:2',
        '+const b = 3;',
        'Comment on `src/app.ts`, added line 2:\nMake it 30.',
        { fence: 'diff', comment: { file: 'src/app.ts', side: 'new', line: 2, text: 'Make it 30.' } },
      ],
    ]);
    expect(screen.queryByTestId('diff-comment-editor')).not.toBeInTheDocument();
    const card = screen.getByTestId('diff-comment');
    expect(card).toHaveTextContent('Make it 30.');
    expect(row('const b = 3').nextElementSibling).toContainElement(card);

    // Taken back: it leaves the send box and the diff.
    fireEvent.click(within(card).getByRole('button', { name: preview.diffComment.remove }));
    expect(store.state.snippets).toEqual([]);
    expect(screen.queryByTestId('diff-comment')).not.toBeInTheDocument();
  });

  it('numbers a removed line on the old side, and adds with Cmd+Enter', () => {
    show();
    hover(row('const b = 2'));
    fireEvent.click(addButton()!);
    write('Keep this one');
    fireEvent.keyDown(within(editor()).getByRole('textbox'), { key: 'Enter', metaKey: true });
    expect(store.added[0]).toEqual([
      'app.ts:2',
      '-const b = 2;',
      'Comment on `src/app.ts`, removed line 2 (old numbering):\nKeep this one',
      { fence: 'diff', comment: { file: 'src/app.ts', side: 'old', line: 2, text: 'Keep this one' } },
    ]);
  });

  it('closes the box on Escape or Cancel, adding nothing', () => {
    show();
    hover(row('const c = 4'));
    fireEvent.click(addButton()!);
    write('never mind');
    fireEvent.keyDown(within(editor()).getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByTestId('diff-comment-editor')).not.toBeInTheDocument();

    hover(row('const c = 4'));
    fireEvent.click(addButton()!);
    fireEvent.click(within(editor()).getByRole('button', { name: common.cancel }));
    expect(screen.queryByTestId('diff-comment-editor')).not.toBeInTheDocument();
    expect(store.added).toEqual([]);
  });

  it('offers nothing on a hunk header, and the button goes when the pointer leaves the diff', () => {
    const view = show();
    hover(row('const a = 1'));
    expect(addButton()).toBeInTheDocument();
    hover(document.querySelector('td.d2h-info')!);
    expect(addButton()).not.toBeInTheDocument();
    hover(row('const a = 1'));
    fireEvent.mouseLeave(view.container.querySelector('.relative')!);
    expect(addButton()).not.toBeInTheDocument();
  });

  it('shows the comments the send box holds under their lines, and none of another file', () => {
    act(() =>
      store.set([
        {
          id: 'mine',
          tag: 'app.ts:3',
          html: ' const c = 4;',
          fence: 'diff',
          comment: { file: 'src/app.ts', side: 'new', line: 3, text: 'Rename c' },
        },
        {
          id: 'other',
          tag: 'other.ts:3',
          html: ' x',
          fence: 'diff',
          comment: { file: 'src/other.ts', side: 'new', line: 3, text: 'Elsewhere' },
        },
        { id: 'element', tag: 'button', html: '<button></button>' },
      ])
    );
    show();
    expect(screen.getAllByTestId('diff-comment')).toHaveLength(1);
    expect(row('const c = 4').nextElementSibling).toHaveTextContent('Rename c');
  });

  it('takes no comments in the side-by-side view', () => {
    store.set([
      {
        id: 'mine',
        tag: 'app.ts:3',
        html: ' const c = 4;',
        fence: 'diff',
        comment: { file: 'src/app.ts', side: 'new', line: 3, text: 'Rename c' },
      },
    ]);
    render(
      <I18nextProvider i18n={i18n}>
        <DiffPreview content={DIFF} />
      </I18nextProvider>
    );
    expect(screen.getAllByTestId('diff-comment')).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('checkbox', { name: preview.sideBySide })[0]);
    expect(screen.queryByTestId('diff-comment')).not.toBeInTheDocument();
    hover(document.querySelector('.d2h-code-side-line') ?? document.body);
    expect(addButton()).not.toBeInTheDocument();
  });
});
