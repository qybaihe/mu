import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyView, reduceAll, type NativeView, type PiRecord } from '@/common/utils/nativeHost';
import {
  setWorkPanelFollow,
  setWorkPanelViewing,
  useWorkPanelUnread,
} from '@/renderer/components/layout/WorkPanel/workPanelStore';
import { useNativePanel } from '@/renderer/pages/native/hooks/useNativePanel';
import { finishedEditPaths, finishedEdits } from '@/renderer/pages/native/utils/editNews';
import { ended, reply, text, toolCall } from './records';

/**
 * The files tab's dot for a native conversation (utils/editNews.ts, hooks/useNativePanel.ts): a `write` or `edit` the
 * model finished is news, unless the person is looking at that tab; what a view held when it came is not.
 */

/** The files the preview was asked to show, as the conversation's folder reads them. */
const opened = vi.hoisted(() => [] as string[]);
vi.mock('@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview', () => ({
  useOptionalLocalFilePreview: () => async (path: string) => {
    opened.push(path);
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  opened.length = 0;
  setWorkPanelFollow(true);
});

/** One call of `tool`, as pi's records tell it: the assistant's message, the call running, and its end unless `end` is left out. */
const call = (
  id: string,
  tool: string,
  options: { end?: boolean; error?: boolean; path?: string } = {}
): PiRecord[] => [
  ended(reply([toolCall(id, tool, { path: options.path ?? 'a.txt', content: 'x' })], { stopReason: 'toolUse' })),
  { type: 'tool_execution_start', toolCallId: id, toolName: tool, args: { path: options.path ?? 'a.txt', content: 'x' } },
  ...(options.end === false
    ? []
    : [
        {
          type: 'tool_execution_end',
          toolCallId: id,
          toolName: tool,
          result: { content: [text(options.error ? 'failed' : 'ok')] },
          isError: options.error === true,
        } as PiRecord,
      ]),
];

const viewOf = (...calls: PiRecord[][]): NativeView => reduceAll(calls.flat());

/**
 * The panel hook of one conversation as the conversation hook feeds it: the view of the epoch it is in (`open`, a view
 * replaced by a fork: a new epoch; a record folded in: the same one), and the tabs it has news for. The panel reads the
 * view at most twice a second.
 */
function mount(id: string) {
  vi.useFakeTimers();
  let epoch = 1;
  const rendered = renderHook(
    (props: { view: NativeView; epoch: number; loading: boolean }) => {
      useNativePanel(id, props.view, props.epoch, props.loading, undefined, '/work/app');
      return [...useWorkPanelUnread(id)];
    },
    { initialProps: { view: emptyView(), epoch, loading: true } }
  );
  const later = () => act(() => vi.advanceTimersByTime(600));
  return {
    unread: () => rendered.result.current,
    /** The snapshot came, or the session was replaced by another: the whole view is another one. */
    open: (view: NativeView) => {
      rendered.rerender({ view, epoch: ++epoch, loading: false });
      later();
    },
    /** Records were folded into the view. */
    fold: (view: NativeView) => {
      rendered.rerender({ view, epoch, loading: false });
      later();
    },
  };
}

describe('finishedEdits', () => {
  it('counts the writes and edits that finished without an error, and nothing else', () => {
    expect(finishedEdits(emptyView())).toBe(0);
    expect(
      finishedEdits(
        viewOf(
          call('t1', 'write'),
          call('t2', 'edit'),
          call('t3', 'write', { error: true }),
          call('t4', 'write', { end: false }),
          call('t5', 'bash'),
          call('t6', 'read')
        )
      )
    ).toBe(2);
  });
});

describe('finishedEditPaths', () => {
  it('names the file of each finished write and edit, in order', () => {
    expect(
      finishedEditPaths(
        viewOf(call('t1', 'write', { path: 'src/a.ts' }), call('t2', 'bash'), call('t3', 'edit', { path: '/abs/b.md' }))
      )
    ).toEqual(['src/a.ts', '/abs/b.md']);
  });
});

describe('following the agent to the file it changed', () => {
  it('shows the latest file in the preview while the person looks at the workspace, and only then', () => {
    const panel = mount('edit-follow-1');
    panel.open(viewOf(call('t1', 'write')));
    // Not looking at the panel: the dot only.
    panel.fold(viewOf(call('t1', 'write'), call('t2', 'write', { path: 'src/b.ts' })));
    expect(opened).toEqual([]);

    act(() => setWorkPanelViewing('edit-follow-1', 'files'));
    panel.fold(
      viewOf(
        call('t1', 'write'),
        call('t2', 'write', { path: 'src/b.ts' }),
        call('t3', 'edit', { path: 'src/c.ts' }),
        call('t4', 'write', { path: 'src/d.ts' })
      )
    );
    expect(opened).toEqual(['src/d.ts']);

    act(() => setWorkPanelFollow(false));
    panel.fold(
      viewOf(
        call('t1', 'write'),
        call('t2', 'write', { path: 'src/b.ts' }),
        call('t3', 'edit', { path: 'src/c.ts' }),
        call('t4', 'write', { path: 'src/d.ts' }),
        call('t5', 'write', { path: 'src/e.ts' })
      )
    );
    expect(opened).toEqual(['src/d.ts']);
    act(() => setWorkPanelViewing('edit-follow-1', null));
  });
});

describe('the files tab’s dot', () => {
  it('comes when a write finishes; what the conversation held when it opened is not news', () => {
    const panel = mount('edit-news-1');
    panel.open(viewOf(call('t1', 'write')));
    expect(panel.unread()).toEqual([]);
    panel.fold(viewOf(call('t1', 'write'), call('t2', 'edit')));
    expect(panel.unread()).toEqual(['files']);
  });

  it('is not made by the snapshot, which the panel reads half a second after it came', () => {
    const panel = mount('edit-news-2');
    // The throttle still holds the empty view the screen started with when the snapshot with two edits arrives.
    panel.open(viewOf(call('t1', 'write'), call('t2', 'write')));
    expect(panel.unread()).toEqual([]);
  });

  it('does not come for a call that has not finished, failed, or is no edit of pi’s', () => {
    const panel = mount('edit-news-3');
    panel.open(viewOf(call('t1', 'write')));
    panel.fold(
      viewOf(
        call('t1', 'write'),
        call('t2', 'write', { end: false }),
        call('t3', 'edit', { error: true }),
        call('t4', 'bash')
      )
    );
    expect(panel.unread()).toEqual([]);
  });

  it('does not come while the person looks at the files tab', () => {
    const panel = mount('edit-news-4');
    panel.open(viewOf(call('t1', 'write')));
    act(() => setWorkPanelViewing('edit-news-4', 'files'));
    panel.fold(viewOf(call('t1', 'write'), call('t2', 'write')));
    expect(panel.unread()).toEqual([]);
    act(() => setWorkPanelViewing('edit-news-4', null));
  });

  it('is not made by another view (a fork), and counts again from the one that took its place', () => {
    const panel = mount('edit-news-5');
    panel.open(viewOf(call('t1', 'write'), call('t2', 'write')));
    // The fork holds less than the session it was made from did.
    panel.open(viewOf(call('t1', 'write')));
    expect(panel.unread()).toEqual([]);
    panel.fold(viewOf(call('t1', 'write'), call('t3', 'write')));
    expect(panel.unread()).toEqual(['files']);
  });

  it('is not made by another conversation with more edits than the one before it', () => {
    const panel = mount('edit-news-6');
    panel.open(viewOf(call('t1', 'write')));
    panel.open(viewOf(call('t1', 'write'), call('t2', 'write'), call('t3', 'edit')));
    expect(panel.unread()).toEqual([]);
  });
});
