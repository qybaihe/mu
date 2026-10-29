import React from 'react';
import { Message } from '@arco-design/web-react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IMessageText } from '@/common/chat/chatLib';
import type { NativeConversation, NativeHostStatus } from '@/common/kyrn/nativeBridge';
import { useMessageListRun } from '@/renderer/pages/conversation/Messages/hooks';
import { getCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { getCurrentProject, setCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { KernelBody } from '@/renderer/pages/conversation/KyrnPanel';
import NativeConversationPage from '@/renderer/pages/native';
import NativeSiderGroup from '@/renderer/pages/native/sider/NativeSiderGroup';
import { forgetNativeUnread } from '@/renderer/pages/native/hooks/useNativeAttention';
import { forgetProjects, forgetRepoRoots } from '@/renderer/pages/native/sider/useProjects';
import { NativeClientContext, type NativeClient } from '@/renderer/pages/native/utils/nativeClient';
import { useNativeActivity, useNativeFolder } from '@/renderer/pages/native/utils/nativeActivityStore';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import enMessages from '@/renderer/services/i18n/locales/en-US/messages.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import enSettings from '@/renderer/services/i18n/locales/en-US/settings.json';
import { createFakeHost, type FakeHost } from './fakeClient';
import { ended, frame, reply, text, user } from './records';

/**
 * The native conversation page and the sidebar group against an in-memory host: the page in each state of its host,
 * one that cannot be opened, a flag that is off, a draft whose session gives it its id, the work panel's feed, and the
 * sidebar's list and new conversation. The message list runs for real; its text rows and tool box are stood in for.
 */

type BoxProps = { value?: string; onChange?: (value: string) => void; testIds?: { input?: string } };

vi.mock('@/renderer/components/chat/SendBox', () => ({
  default: ({ value = '', onChange, testIds }: BoxProps) => (
    <textarea
      data-testid={testIds?.input ?? 'sendbox-input'}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageText', () => ({
  default: ({ message }: { message: IMessageText }) => {
    // The real row's fork and rewind buttons, when the list's host forks its own session and takes checkpoints.
    const run = useMessageListRun();
    const fork = run?.fork?.(message);
    const rewind = message.position === 'right' ? run?.rewind?.(message) : undefined;
    return (
      <div data-testid={`row-text-${message.position}`}>
        {message.content.content}
        {fork ? <button type='button' data-testid='row-fork' onClick={fork} /> : null}
        {rewind ? <button type='button' data-testid='row-rewind' onClick={rewind} /> : null}
      </div>
    );
  },
}));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary', () => ({
  default: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid='tool-summary'>{messages.map((message) => message.id).join(',')}</div>
  ),
}));

// The browser's side of mu's browse loop has tests of its own (tests/unit/kyrn/browser/); here: which conversation it
// serves.
vi.mock('@/renderer/pages/conversation/Preview/browser/muBrowser/MuBrowserHost', () => ({
  default: ({ conversationId }: { conversationId?: string }) => (
    <div data-testid='browser-host' data-conversation={conversationId} />
  ),
}));

afterEach(() => {
  cleanup();
  forgetProjects();
  forgetRepoRoots();
});

const i18n = createInstance();
void i18n.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        common: enCommon,
        conversation: enConversation,
        messages: enMessages,
        mu: enMu,
        settings: enSettings,
      },
    },
  },
  interpolation: { escapeValue: false },
});

/** Where the app is: the route, and the folder the home page was asked to start in (`state.workspace`). */
const Where: React.FC = () => {
  const { pathname, state } = useLocation();
  return (
    <div data-testid='where' data-workspace={(state as { workspace?: string } | null)?.workspace ?? ''}>
      {pathname}
    </div>
  );
};

const Panel: React.FC<{ id: string }> = ({ id }) => {
  const activity = useNativeActivity(id);
  const folder = useNativeFolder(id);
  return (
    <div data-testid='panel' data-folder={folder ?? ''}>
      {activity ? `${activity.events.length}:${String(activity.settled)}` : 'none'}
    </div>
  );
};

function page(client: NativeClient, id = 'c1', extra?: React.ReactNode) {
  return render(
    <I18nextProvider i18n={i18n}>
      <NativeClientContext.Provider value={client}>
        <MemoryRouter initialEntries={[`/conversation/native/${id}`]}>
          <Routes>
            <Route path='/conversation/native/:id' element={<NativeConversationPage />} />
            <Route path='/guid' element={<div data-testid='home' />} />
          </Routes>
          <Where />
          {extra}
        </MemoryRouter>
      </NativeClientContext.Provider>
    </I18nextProvider>
  );
}

const opened = async () => {
  await waitFor(() => expect(screen.getByTestId('native-header')).toBeInTheDocument());
  await act(async () => {});
};

const phase = () => screen.getByTestId('native-header-phase');

/** mu's checkpoint entry #`id`, taken in the turn the person's message `entryId` started. */
const checkpoint = (id: number, entryId: string) => ({
  type: 'entry_appended',
  entry: { type: 'custom', id: `k${id}`, customType: 'kyrn.checkpoint', data: { id, turn: id, entryId, label: '' } },
});

describe('the native conversation page', () => {
  it('shows a new conversation where mu will work, and the host as it goes from idle to running', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', cwd: '/work/alpha', title: '' });
    page(host.client);
    await opened();
    expect(screen.getByRole('heading')).toHaveTextContent('New conversation');
    expect(screen.getByTestId('native-header-folder')).toHaveTextContent('alpha');
    expect(screen.getByTestId('native-empty')).toHaveTextContent('New conversation in alpha');
    expect(phase()).toHaveAttribute('data-phase', 'idle');
    expect(phase()).toHaveTextContent('Not running');
    const steps: Array<[NativeHostStatus, string]> = [
      [{ phase: 'starting' }, 'Starting'],
      // Up and waiting for a message: nothing to see, as before it starts; screen readers still hear it.
      [{ phase: 'running' }, 'Ready'],
      [{ phase: 'needs-model' }, 'No model'],
      [{ phase: 'failed', error: { kind: 'failed', message: 'spawn ENOENT', stderr: '' } }, 'Stopped'],
    ];
    for (const [status, words] of steps) {
      act(() => host.setStatus('c1', status));
      expect(phase()).toHaveTextContent(words);
    }
    expect(screen.getByTestId('native-failed')).toHaveTextContent('mu stopped before it could start.');
  });

  it('says Working only while a turn runs, and nothing once it has ended', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', title: 'Fix the build' });
    page(host.client);
    await opened();
    act(() => host.setStatus('c1', { phase: 'running' }));
    expect(phase()).toHaveClass('sr-only');
    act(() => host.play('c1', [{ type: 'agent_start' }, ended(user('fix the build'))]));
    await waitFor(() => expect(phase()).toHaveTextContent('Working'));
    expect(phase()).toHaveAttribute('data-working', 'true');
    expect(phase()).not.toHaveClass('sr-only');
    act(() => host.play('c1', [{ type: 'agent_settled' }]));
    await waitFor(() => expect(phase()).toHaveTextContent('Ready'));
    expect(phase()).toHaveClass('sr-only');
    expect(phase()).toHaveAttribute('data-phase', 'running');
  });

  it('shows the transcript as the host plays it, in the shared message list', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', title: 'Fix the build' });
    page(host.client);
    await opened();
    act(() => {
      host.play('c1', [
        { type: 'agent_start' },
        ended(user('fix the build')),
        ended({
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          stopReason: 'stop',
          timestamp: 2,
        }),
        { type: 'agent_settled' },
      ]);
    });
    await waitFor(() => expect(screen.getByTestId('row-text-left')).toHaveTextContent('Done.'));
    expect(screen.getByTestId('row-text-right')).toHaveTextContent('fix the build');
    // The rows as the end-to-end tests find them.
    expect(screen.getByTestId('native-message-user')).toHaveTextContent('fix the build');
    expect(screen.getByTestId('native-message-assistant')).toHaveTextContent('Done.');
    expect(screen.getByRole('heading')).toHaveTextContent('Fix the build');
  });

  it('says why a conversation cannot be opened, and opens it when tried again', async () => {
    const host = createFakeHost();
    page(host.client, 'gone');
    await waitFor(() => expect(screen.getByTestId('native-open-failed')).toBeInTheDocument());
    expect(screen.getByTestId('native-open-failed')).toHaveTextContent('This conversation no longer exists.');
    host.add({ id: 'gone', title: 'Back again' });
    fireEvent.click(screen.getByTestId('native-open-retry'));
    await opened();
    expect(screen.getByRole('heading')).toHaveTextContent('Back again');
  });

  it('goes home while the native host is off', async () => {
    const host = createFakeHost();
    host.enable(false);
    host.add({ id: 'c1' });
    page(host.client);
    await waitFor(() => expect(screen.getByTestId('home')).toBeInTheDocument());
    expect(host.calls.filter((call) => call.method === 'open')).toEqual([]);
  });

  it('follows a draft to its session’s id and keeps what was being typed', async () => {
    const host = createFakeHost();
    host.add({ id: 'draft-1', cwd: '/work/app' });
    page(host.client, 'draft-1');
    await opened();
    // mu's browser tool opens its tabs beside this conversation, by the id it has now.
    expect(screen.getByTestId('browser-host')).toHaveAttribute('data-conversation', 'draft-1');
    fireEvent.change(screen.getByTestId('native-send-input'), { target: { value: 'half typed' } });
    const session: NativeConversation = {
      id: 's-1',
      cwd: '/work/app',
      title: 'Ship it',
      createdAt: 1,
      updatedAt: 2,
      live: true,
    };
    act(() => host.change({ conversation: session, replaces: 'draft-1' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/conversation/native/s-1'));
    expect(screen.getByRole('heading')).toHaveTextContent('Ship it');
    expect(screen.getByTestId('native-send-input')).toHaveValue('half typed');
    expect(screen.getByTestId('browser-host')).toHaveAttribute('data-conversation', 's-1');
    expect(host.calls.filter((call) => call.method === 'open')).toHaveLength(1);
  });

  it('forks at a message: pi is asked, the person’s message comes back into the box, and the id follows the fork', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', cwd: '/work/app', title: 'Two turns' });
    host.answer((_id, command) =>
      command.type === 'fork'
        ? { ok: true, data: { text: 'second question', cancelled: false } }
        : { ok: true, data: undefined }
    );
    page(host.client);
    await opened();
    act(() =>
      host.play('c1', [
        ended(user('first question'), 'u1'),
        ended(reply([text('first answer')]), 'a1'),
        ended(user('second question'), 'u2'),
        ended(reply([text('second answer')]), 'a2'),
      ])
    );
    // A button on each message, while nothing runs.
    const buttons = screen.getAllByTestId('row-fork');
    expect(buttons).toHaveLength(4);
    fireEvent.click(buttons[2]);
    await waitFor(() =>
      expect(host.calls.filter((call) => call.method === 'request' && call.command?.type === 'fork')).toEqual([
        { method: 'request', id: 'c1', command: { type: 'fork', entryId: 'u2' } },
      ])
    );
    await waitFor(() => expect(screen.getByTestId('native-send-input')).toHaveValue('second question'));
    // The main process moves the conversation to the fork: its id changes, the page stays and the route follows.
    const fork: NativeConversation = {
      id: 's-fork',
      cwd: '/work/app',
      title: 'Two turns',
      createdAt: 1,
      updatedAt: 2,
      live: true,
      forkedFrom: '/sessions/c1.jsonl',
    };
    act(() => host.change({ conversation: fork, replaces: 'c1' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/conversation/native/s-fork'));
    expect(screen.getByTestId('native-send-input')).toHaveValue('second question');
  });

  it('forks a reply where it ends, and puts nothing into the box; the last reply is cloned', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', cwd: '/work/app' });
    host.answer((_id, command) =>
      command.type === 'fork' ? { ok: true, data: { text: 'second question' } } : { ok: true, data: undefined }
    );
    page(host.client);
    await opened();
    act(() =>
      host.play('c1', [
        ended(user('first question'), 'u1'),
        ended(reply([text('first answer')]), 'a1'),
        ended(user('second question'), 'u2'),
        ended(reply([text('second answer')]), 'a2'),
      ])
    );
    fireEvent.click(screen.getAllByTestId('row-fork')[1]);
    await waitFor(() =>
      expect(host.calls.filter((call) => call.method === 'request' && call.command?.type === 'fork')).toHaveLength(1)
    );
    expect(screen.getByTestId('native-send-input')).toHaveValue('');
    fireEvent.click(screen.getAllByTestId('row-fork')[3]);
    await waitFor(() =>
      expect(host.calls.filter((call) => call.method === 'request' && call.command?.type === 'clone')).toHaveLength(1)
    );
    expect(screen.getByTestId('native-send-input')).toHaveValue('');
  });

  it('goes back to before a message that changed files with mu’s /rewind, and the request comes back into the box', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', cwd: '/work/app' });
    host.answer(() => ({ ok: true, data: undefined }));
    page(host.client);
    await opened();
    act(() =>
      host.play('c1', [
        ended(user('just asking'), 'u1'),
        ended(reply([text('an answer')]), 'a1'),
        ended(user('write the docs'), 'u2'),
        checkpoint(1, 'u2'),
        ended(reply([text('written')]), 'a2'),
      ])
    );
    // Only the message whose turn changed files has one.
    const rows = [...screen.getAllByTestId('row-text-right')];
    expect(rows.map((row) => within(row).queryByTestId('row-rewind') !== null)).toEqual([false, true]);
    fireEvent.click(within(rows[1]).getByTestId('row-rewind'));
    await waitFor(() =>
      expect(host.calls.filter((call) => call.method === 'request' && call.command?.type === 'prompt')).toEqual([
        { method: 'request', id: 'c1', command: { type: 'prompt', message: '/rewind 1' } },
      ])
    );
    // mu went back and gives the request back to send again: it goes into the box, before what was typed.
    fireEvent.change(screen.getByTestId('native-send-input'), { target: { value: 'and the tests' } });
    act(() =>
      host.play('c1', [{ type: 'extension_ui_request', id: 'e1', method: 'set_editor_text', text: 'write the docs' }])
    );
    expect(screen.getByTestId('native-send-input')).toHaveValue('write the docs\n\nand the tests');
    // Once: the same text again later is another request of mu's.
    act(() => host.play('c1', [{ type: 'extension_ui_request', id: 'e2', method: 'set_editor_text', text: '' }]));
    expect(screen.getByTestId('native-send-input')).toHaveValue('write the docs\n\nand the tests');
  });

  it('draws the button under the messages that have a fork point only', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', cwd: '/work/app' });
    page(host.client);
    await opened();
    act(() =>
      host.play('c1', [
        // A record of a harness that does not say which entry a message is: no point for the person's message.
        ended(user('old question')),
        ended(reply([text('old answer')])),
        ended(user('new question'), 'u2'),
        ended(reply([text('new answer')]), 'a2'),
      ])
    );
    const rows = [...screen.getAllByTestId(/^row-text-/)];
    expect(rows.map((row) => within(row).queryByTestId('row-fork') !== null)).toEqual([false, true, true, true]);
  });

  it('offers no fork while a run goes, nor when pi refuses one', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', cwd: '/work/app' });
    host.answer((_id, command) =>
      command.type === 'fork'
        ? { ok: false, kind: 'command', message: 'Cannot fork now' }
        : { ok: true, data: undefined }
    );
    page(host.client);
    await opened();
    act(() => host.play('c1', [ended(user('first question'), 'u1'), ended(reply([text('first answer')]), 'a1')]));
    // pi refused: the failure shows above the box, the box is untouched.
    fireEvent.click(screen.getAllByTestId('row-fork')[0]);
    await waitFor(() => expect(screen.getByTestId('native-command-failed')).toHaveTextContent('Cannot fork now'));
    expect(screen.getByTestId('native-send-input')).toHaveValue('');
    act(() => host.play('c1', [{ type: 'agent_start' }]));
    expect(screen.queryAllByTestId('row-fork')).toEqual([]);
  });

  it('makes itself the current conversation and feeds the work panel from its view', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    // The conversation shown before had a project: the explorer must not keep showing it.
    setCurrentProject('project-of-the-last-conversation');
    const view = page(host.client, 'c1', <Panel id='c1' />);
    await opened();
    expect(getCurrentConversation()).toBe('c1');
    expect(getCurrentProject()).toBeNull();
    await waitFor(() => expect(screen.getByTestId('panel')).toHaveTextContent('0:true'));
    // The folder it works in comes with it: the panel reads its lessons and files by it.
    expect(screen.getByTestId('panel')).toHaveAttribute('data-folder', '/project');
    act(() => {
      host.play('c1', [{ type: 'agent_start' }, frame('preflight.pending', { judge: 'mude' })]);
    });
    // The panel reads the view at most twice a second.
    await waitFor(() => expect(screen.getByTestId('panel')).toHaveTextContent('2:true'));
    view.unmount();
    expect(getCurrentConversation()).toBeNull();
  });

  it('says a native conversation’s lessons show once it has opened, while its folder is not known', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <KernelBody
            tab='lessons'
            conversationId='c1'
            activity={{ events: [], loading: false, settled: true }}
            lessons={false}
          />
        </MemoryRouter>
      </I18nextProvider>
    );
    expect(screen.getByTestId('kernel-no-lessons')).toHaveTextContent('Lessons appear once the conversation opens.');
  });
});

function sider(client: NativeClient, at = '/guid') {
  return render(
    <I18nextProvider i18n={i18n}>
      <NativeClientContext.Provider value={client}>
        <MemoryRouter initialEntries={[at]}>
          <NativeSiderGroup />
          <Where />
        </MemoryRouter>
      </NativeClientContext.Provider>
    </I18nextProvider>
  );
}

const items = () => screen.queryAllByTestId('native-sidebar-item');
/** What this window keeps in its storage under `key`: a list of ids. */
const stored = (key: string): string[] => JSON.parse(localStorage.getItem(key) ?? '[]');
const shownIds = () => items().map((item) => item.dataset.id);
const projectFolders = () => screen.queryAllByTestId('native-project-group').map((group) => group.dataset.folder);
const projectOf = (folder: string) =>
  document.querySelector<HTMLElement>(`[data-testid="native-project-group"][data-folder="${folder}"]`);
const creates = (host: FakeHost) => host.calls.filter((call) => call.method === 'create');
const openNew = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('native-new'));
  });
  await waitFor(() => expect(screen.getByTestId('native-new-panel')).toBeVisible());
};

describe('the sidebar’s native group', () => {
  it('is not there while the native host is off', async () => {
    const host = createFakeHost();
    host.enable(false);
    const { container } = sider(host.client);
    await act(async () => {});
    expect(container.querySelector('[data-testid="native-sidebar-group"]')).toBeNull();
    expect(host.calls).toEqual([]);
  });

  it('lists mu’s conversations newest first, and opens one', async () => {
    const host = createFakeHost();
    host.add({ id: 'a', cwd: '/work/alpha', title: '', updatedAt: 1 });
    host.add({ id: 'b', cwd: '/work/beta', title: 'Fix the build', updatedAt: 3, live: true });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['b', 'a']));
    expect(screen.getByTestId('native-sidebar-group')).toBeInTheDocument();
    // Each in its folder's project, the one changed last first: a row does not repeat its project's folder.
    expect(projectFolders()).toEqual(['/work/beta', '/work/alpha']);
    const [b, a] = items();
    expect(b).toHaveTextContent(/^Fix the build$/);
    expect(b.querySelector('[aria-label="Running"]')).not.toBeNull();
    expect(a).toHaveTextContent(/^New conversation$/);
    fireEvent.click(a);
    expect(screen.getByTestId('where')).toHaveTextContent('/conversation/native/a');
  });

  it('starts a conversation in a picked folder or a recent one, in the permission mode chosen', async () => {
    const host = createFakeHost();
    host.add({ id: 'a', cwd: '/work/alpha', updatedAt: 1 });
    host.add({ id: 'b', cwd: '/work/beta', updatedAt: 3 });
    host.add({ id: 'c', cwd: '/work/beta', updatedAt: 2 });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['b', 'c', 'a']));
    await openNew();
    // The folders recent conversations worked in, each once, newest first.
    expect(screen.getAllByTestId('native-recent-folder').map((row) => row.getAttribute('title'))).toEqual([
      '/work/beta',
      '/work/alpha',
    ]);
    // No folder picked: nothing is made.
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-project'));
    });
    expect(host.calls.filter((call) => call.method === 'pickFolder')).toHaveLength(1);
    expect(creates(host)).toEqual([]);
    host.pick('/work/gamma');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-project'));
    });
    expect(creates(host)).toEqual([{ method: 'create', cwd: '/work/gamma' }]);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/conversation/native/draft-4'));
    await waitFor(() => expect(shownIds()).toContain('draft-4'));
    // In a project of its own: the folder is in no repository and under no added folder.
    expect(projectOf('/work/gamma')?.querySelector('[data-id="draft-4"]')).not.toBeNull();

    // Again, in a recent folder, with the judge approving what mu does.
    await openNew();
    const mode = screen.getByTestId('native-permissions');
    expect(mode).toHaveTextContent("mu's default");
    await act(async () => {
      fireEvent.click(mode);
    });
    await act(async () => {
      fireEvent.click(within(mode.parentElement ?? document.body).getByRole('option', { name: 'Judge mode' }));
    });
    expect(mode).toHaveTextContent('Judge mode');
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('native-recent-folder')[1]);
    });
    expect(creates(host).at(-1)).toEqual({ method: 'create', cwd: '/work/alpha', permissions: 'judge' });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/conversation/native/draft-5'));
  });

  it('says why a conversation could not be made', async () => {
    const host = createFakeHost();
    host.pick('/work/app');
    sider({ ...host.client, create: async () => ({ ok: false, kind: 'no-harness', message: 'no mu at /opt/mu' }) });
    await waitFor(() => expect(screen.getByTestId('native-sidebar-empty')).toHaveTextContent('No conversations yet'));
    await openNew();
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-project'));
    });
    expect(screen.getByTestId('native-create-failed')).toHaveTextContent(
      "The app can't find mu to run. no mu at /opt/mu"
    );
    expect(screen.getByTestId('where')).toHaveTextContent('/guid');
  });

  it('reads the list again when the window comes back to the front: a session made outside the app shows', async () => {
    const host = createFakeHost();
    host.add({ id: 'a', title: 'Made here', updatedAt: 1 });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['a']));
    // The command line made one: nothing in this app did, so no change came.
    host.add({ id: 'cli', title: 'From the command line', updatedAt: 2 });
    const front = () => act(async () => void window.dispatchEvent(new Event('focus')));
    // Read a moment ago: not again yet.
    await front();
    expect(shownIds()).toEqual(['a']);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await front();
    await waitFor(() => expect(shownIds()).toEqual(['cli', 'a']));
    expect(host.calls.filter((call) => call.method === 'list')).toHaveLength(2);
    // A window that is only being left does not read.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    expect(host.calls.filter((call) => call.method === 'list')).toHaveLength(2);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('keeps a change that comes while the list is being read again', async () => {
    const host = createFakeHost();
    host.add({ id: 'a', title: 'Made here', updatedAt: 1 });
    let gate: (() => void) | undefined;
    let slow = false;
    const client: NativeClient = {
      ...host.client,
      list: async () => {
        const result = await host.client.list();
        if (slow) await new Promise<void>((resolve) => (gate = resolve));
        return result;
      },
    };
    sider(client);
    await waitFor(() => expect(shownIds()).toEqual(['a']));
    slow = true;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await act(async () => void window.dispatchEvent(new Event('focus')));
    // The answer was made before this conversation was: the change still shows once the answer is in.
    act(() =>
      host.change({
        conversation: { id: 'new', cwd: '/project', title: 'Just made', createdAt: 3, updatedAt: 3, live: false },
      })
    );
    await waitFor(() => expect(shownIds()).toEqual(['new', 'a']));
    await act(async () => gate?.());
    expect(shownIds()).toEqual(['new', 'a']);
  });

  it('shows the newest few of a project, and all of them when asked', async () => {
    const host = createFakeHost();
    for (let index = 1; index <= 10; index++) host.add({ id: `c${index}`, updatedAt: index });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toHaveLength(5));
    expect(shownIds()[0]).toBe('c10');
    expect(shownIds()).not.toContain('c5');
    expect(screen.getByTestId('native-sidebar-more')).toHaveTextContent('Show all (10)');
    fireEvent.click(screen.getByTestId('native-sidebar-more'));
    expect(shownIds()).toHaveLength(10);
    expect(shownIds()).toContain('c1');
  });

  const menuOf = async (id: string) => {
    const row = items().find((item) => item.dataset.id === id);
    if (!row) throw new Error(`no row ${id}`);
    await act(async () => {
      fireEvent.click(within(row).getByTestId('native-sidebar-item-menu'));
    });
    await waitFor(() => expect(screen.getByTestId('native-sidebar-rename')).toBeVisible());
  };

  /** The pins as the window's storage holds them (what another window's change shows as): `ids` when given. */
  const pinsAre = (ids: string[] = []) => {
    if (ids.length > 0) localStorage.setItem('mu.native.pinned', JSON.stringify(ids));
    else localStorage.removeItem('mu.native.pinned');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'mu.native.pinned' }));
    });
  };

  it('pins a conversation from its row’s menu: it goes above the others, and unpinning puts it back', async () => {
    pinsAre();
    const host = createFakeHost();
    for (let index = 1; index <= 4; index++)
      host.add({ id: `c${index}`, updatedAt: index, sessionFile: `/s/c${index}.jsonl` });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['c4', 'c3', 'c2', 'c1']));
    await menuOf('c2');
    expect(screen.getByTestId('native-sidebar-pin')).toHaveTextContent('Pin');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-sidebar-pin'));
    });
    expect(shownIds()).toEqual(['c2', 'c4', 'c3', 'c1']);
    expect(items()[0]).toHaveAttribute('data-pinned', 'true');
    expect(within(items()[0]).getByTestId('native-sidebar-pinned')).toBeInTheDocument();
    expect(within(items()[1]).queryByTestId('native-sidebar-pinned')).toBeNull();
    expect(JSON.parse(localStorage.getItem('mu.native.pinned') ?? '[]')).toEqual(['c2']);
    // Pinning opened no conversation.
    expect(screen.getByTestId('where')).toHaveTextContent('/guid');
    await menuOf('c2');
    expect(screen.getByTestId('native-sidebar-pin')).toHaveTextContent('Unpin');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-sidebar-pin'));
    });
    expect(shownIds()).toEqual(['c4', 'c3', 'c2', 'c1']);
    expect(JSON.parse(localStorage.getItem('mu.native.pinned') ?? '[]')).toEqual([]);
  });

  it('keeps a pinned conversation in view past the newest few, and takes in a pin made in another window', async () => {
    pinsAre(['c1']);
    const host = createFakeHost();
    for (let index = 1; index <= 10; index++)
      host.add({ id: `c${index}`, updatedAt: index, sessionFile: `/s/c${index}.jsonl` });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toHaveLength(6));
    // The oldest, pinned, above the project; then the project's newest five, of the nine it has.
    expect(shownIds()).toEqual(['c1', 'c10', 'c9', 'c8', 'c7', 'c6']);
    expect(screen.getByTestId('native-sidebar-pinned-label')).toHaveTextContent('Pinned');
    expect(screen.getByTestId('native-sidebar-more')).toHaveTextContent('Show all (9)');
    pinsAre(['c1', 'c2']);
    expect(shownIds()).toEqual(['c2', 'c1', 'c10', 'c9', 'c8', 'c7', 'c6']);
    expect(screen.getByTestId('native-sidebar-more')).toHaveTextContent('Show all (8)');
    pinsAre();
    expect(shownIds()).toEqual(['c10', 'c9', 'c8', 'c7', 'c6']);
    expect(screen.queryByTestId('native-sidebar-pinned-label')).toBeNull();
  });

  it('offers no pin to a conversation with no session file yet: its id changes when pi names it', async () => {
    pinsAre();
    const host = createFakeHost();
    host.add({ id: 'draft-1', title: 'Just started' });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['draft-1']));
    await menuOf('draft-1');
    expect(screen.queryByTestId('native-sidebar-pin')).toBeNull();
    expect(screen.getByTestId('native-sidebar-rename')).toBeVisible();
  });

  /** A set this window keeps in its storage (`mu.native.archived`, `mu.native.unread`), as another window's change shows it. */
  const setIs = (key: string, ids: string[] = []) => {
    if (ids.length > 0) localStorage.setItem(key, JSON.stringify(ids));
    else localStorage.removeItem(key);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key }));
    });
  };

  it('marks a conversation unread from its row’s menu, and read again; the mark is kept in the window’s storage', async () => {
    forgetNativeUnread();
    const host = createFakeHost();
    for (let index = 1; index <= 3; index++)
      host.add({ id: `c${index}`, updatedAt: index, sessionFile: `/s/c${index}.jsonl` });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['c3', 'c2', 'c1']));
    expect(items().some((item) => item.dataset.unread === 'true')).toBe(false);
    await menuOf('c2');
    expect(screen.getByTestId('native-sidebar-mark')).toHaveTextContent('Mark as unread');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-sidebar-mark'));
    });
    const c2 = () => items().find((item) => item.dataset.id === 'c2')!;
    expect(c2()).toHaveAttribute('data-unread', 'true');
    expect(within(c2()).getByTestId('native-sidebar-unread')).toBeInTheDocument();
    expect(stored('mu.native.unread')).toEqual(['c2']);
    // Marking opened nothing.
    expect(screen.getByTestId('where')).toHaveTextContent('/guid');
    await menuOf('c2');
    expect(screen.getByTestId('native-sidebar-mark')).toHaveTextContent('Mark as read');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-sidebar-mark'));
    });
    expect(c2()).not.toHaveAttribute('data-unread');
    expect(stored('mu.native.unread')).toEqual([]);
    // Another window's mark shows here too.
    setIs('mu.native.unread', ['c1']);
    expect(items().find((item) => item.dataset.id === 'c1')).toHaveAttribute('data-unread', 'true');
    forgetNativeUnread();
  });

  it('drops the mark of a conversation that is gone once the list has loaded', async () => {
    forgetNativeUnread();
    setIs('mu.native.unread', ['gone', 'c1']);
    const host = createFakeHost();
    host.add({ id: 'c1', updatedAt: 1, sessionFile: '/s/c1.jsonl' });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['c1']));
    await waitFor(() => expect(stored('mu.native.unread')).toEqual(['c1']));
    forgetNativeUnread();
  });

  it('archives a conversation: it leaves the list for the Archived fold, which restores it', async () => {
    const success = vi.spyOn(Message, 'success').mockImplementation(() => undefined as never);
    setIs('mu.native.archived');
    pinsAre(['c2']);
    const host = createFakeHost();
    for (let index = 1; index <= 3; index++)
      host.add({ id: `c${index}`, updatedAt: index, sessionFile: `/s/c${index}.jsonl` });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['c2', 'c3', 'c1']));
    expect(screen.queryByTestId('native-sidebar-archived-toggle')).toBeNull();
    await menuOf('c2');
    expect(screen.getByTestId('native-sidebar-archive')).toHaveTextContent('Archive');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-sidebar-archive'));
    });
    // Out of the list, and unpinned as a classic conversation is when it is archived; nothing was opened or deleted.
    expect(success).toHaveBeenLastCalledWith('Archived');
    expect(shownIds()).toEqual(['c3', 'c1']);
    expect(stored('mu.native.archived')).toEqual(['c2']);
    expect(stored('mu.native.pinned')).toEqual([]);
    expect(screen.getByTestId('where')).toHaveTextContent('/guid');
    expect(host.calls.filter((call) => call.method === 'remove')).toEqual([]);
    // The fold says how many, and is shut until it is asked.
    const toggle = screen.getByTestId('native-sidebar-archived-toggle');
    expect(toggle).toHaveTextContent('Archived (1)');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(shownIds()).toEqual(['c3', 'c1', 'c2']);
    const archived = items()[2];
    expect(archived).toHaveAttribute('data-archived', 'true');
    // An archived row: open it, restore it, rename it, delete it; no pin, mark or archive.
    fireEvent.click(archived);
    expect(screen.getByTestId('where')).toHaveTextContent('/conversation/native/c2');
    await act(async () => {
      fireEvent.click(within(archived).getByTestId('native-sidebar-item-menu'));
    });
    await waitFor(() => expect(screen.getByTestId('native-sidebar-restore')).toBeVisible());
    expect(screen.getByTestId('native-sidebar-restore')).toHaveTextContent('Restore');
    expect(screen.getByTestId('native-sidebar-rename')).toBeVisible();
    expect(screen.getByTestId('native-sidebar-delete')).toBeVisible();
    for (const gone of ['pin', 'mark', 'archive']) expect(screen.queryByTestId(`native-sidebar-${gone}`)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-sidebar-restore'));
    });
    expect(success).toHaveBeenLastCalledWith('Restored');
    expect(shownIds()).toEqual(['c3', 'c2', 'c1']);
    expect(screen.queryByTestId('native-sidebar-archived-toggle')).toBeNull();
    expect(stored('mu.native.archived')).toEqual([]);
    pinsAre();
    success.mockRestore();
  });

  it('counts only the conversations in the list when it offers all of them, and takes in an archive made in another window', async () => {
    setIs('mu.native.archived', ['c1', 'c2']);
    const host = createFakeHost();
    for (let index = 1; index <= 11; index++)
      host.add({ id: `c${index}`, updatedAt: index, sessionFile: `/s/c${index}.jsonl` });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toHaveLength(5));
    expect(shownIds()).not.toContain('c1');
    expect(screen.getByTestId('native-sidebar-more')).toHaveTextContent('Show all (9)');
    expect(screen.getByTestId('native-sidebar-archived-toggle')).toHaveTextContent('Archived (2)');
    setIs('mu.native.archived');
    expect(screen.queryByTestId('native-sidebar-archived-toggle')).toBeNull();
    expect(screen.getByTestId('native-sidebar-more')).toHaveTextContent('Show all (11)');
  });

  it('offers no mark and no archive to a conversation with no session file yet', async () => {
    setIs('mu.native.archived');
    const host = createFakeHost();
    host.add({ id: 'draft-1', title: 'Just started' });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['draft-1']));
    await menuOf('draft-1');
    expect(screen.queryByTestId('native-sidebar-mark')).toBeNull();
    expect(screen.queryByTestId('native-sidebar-archive')).toBeNull();
    expect(screen.getByTestId('native-sidebar-delete')).toBeVisible();
  });

  it('says the folder, how many messages and what a conversation was forked from in its row’s tooltip', async () => {
    const host = createFakeHost();
    host.add({
      id: 'p',
      cwd: '/work/app',
      title: 'The plan',
      sessionFile: '/s/p.jsonl',
      messageCount: 4,
      updatedAt: 1,
    });
    host.add({ id: 'f', cwd: '/work/app', title: 'Try B', forkedFrom: '/s/p.jsonl', messageCount: 6, updatedAt: 2 });
    host.add({ id: 'g', cwd: '/work/app', title: '', forkedFrom: '/s/gone.jsonl', updatedAt: 3 });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['g', 'f', 'p']));
    const [g, f, p] = items();
    expect(p.getAttribute('title')).toBe('The plan\n/work/app\nMessages: 4');
    expect(f.getAttribute('title')).toBe('Try B\n/work/app\nMessages: 6\nForked from "The plan"');
    // The parent is not in the list; how many messages is not known.
    expect(g.getAttribute('title')).toBe('New conversation\n/work/app\nForked conversation');
  });

  it('renames a conversation from its row’s menu', async () => {
    const host = createFakeHost();
    host.add({ id: 'a', cwd: '/work/alpha', title: 'Old name' });
    const success = vi.spyOn(Message, 'success').mockImplementation(() => undefined as never);
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['a']));
    await menuOf('a');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-sidebar-rename'));
    });
    const field = await screen.findByTestId('native-rename-input');
    expect(field).toHaveValue('Old name');
    fireEvent.change(field, { target: { value: '   ' } });
    expect(screen.getByTestId('native-rename-save')).toBeDisabled();
    fireEvent.change(field, { target: { value: '  Login work ' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-rename-save'));
    });
    expect(host.calls.filter((call) => call.method === 'rename')).toEqual([
      { method: 'rename', id: 'a', name: 'Login work' },
    ]);
    await waitFor(() => expect(items()[0]).toHaveTextContent('Login work'));
    expect(success).toHaveBeenCalledWith('Renamed');
    // Opening the menu did not open the conversation.
    expect(screen.getByTestId('where')).toHaveTextContent('/guid');
    success.mockRestore();
  });

  it('says why a rename failed, and keeps the name being typed', async () => {
    const host = createFakeHost();
    host.add({ id: 'a', title: 'Old name' });
    const error = vi.spyOn(Message, 'error').mockImplementation(() => undefined as never);
    sider({
      ...host.client,
      rename: async () => ({ ok: false, kind: 'command', message: 'Session name cannot be empty' }),
    });
    await waitFor(() => expect(shownIds()).toEqual(['a']));
    await menuOf('a');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-sidebar-rename'));
    });
    fireEvent.change(await screen.findByTestId('native-rename-input'), { target: { value: 'New' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-rename-save'));
    });
    expect(error).toHaveBeenCalledWith('mu rejected the request. Session name cannot be empty');
    expect(screen.getByTestId('native-rename-input')).toHaveValue('New');
    error.mockRestore();
  });

  it('deletes a conversation after a confirmation, and leaves its page for home', async () => {
    const host = createFakeHost();
    host.add({ id: 'a', cwd: '/work/alpha', title: 'Keep me', updatedAt: 1 });
    host.add({ id: 'b', cwd: '/work/beta', title: 'Fix the build', updatedAt: 2 });
    const success = vi.spyOn(Message, 'success').mockImplementation(() => undefined as never);
    sider(host.client, '/conversation/native/b');
    await waitFor(() => expect(shownIds()).toEqual(['b', 'a']));
    await menuOf('b');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-sidebar-delete'));
    });
    expect(await screen.findByTestId('native-delete')).toHaveTextContent(
      'Delete "Fix the build"? Its file moves to the trash, so you can still restore it.'
    );
    // Cancelled: nothing goes.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(host.calls.filter((call) => call.method === 'remove')).toEqual([]);
    expect(success).not.toHaveBeenCalled();

    await menuOf('b');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-sidebar-delete'));
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('native-delete-confirm'));
    });
    expect(host.calls.filter((call) => call.method === 'remove')).toEqual([{ method: 'remove', id: 'b' }]);
    await waitFor(() => expect(shownIds()).toEqual(['a']));
    expect(screen.getByTestId('where')).toHaveTextContent('/guid');
    expect(success).toHaveBeenCalledWith('Deleted');
    success.mockRestore();
  });

  it('opens the menu on a right click, and a key on its button does not open the conversation', async () => {
    const host = createFakeHost();
    host.add({ id: 'a', title: 'Old name' });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['a']));
    await act(async () => {
      fireEvent.contextMenu(items()[0]);
    });
    await waitFor(() => expect(screen.getByTestId('native-sidebar-delete')).toBeVisible());
    fireEvent.keyDown(within(items()[0]).getByTestId('native-sidebar-item-menu'), { key: 'Enter' });
    expect(screen.getByTestId('where')).toHaveTextContent('/guid');
  });

  const rowsOf = (folder: string) =>
    [...(projectOf(folder)?.querySelectorAll<HTMLElement>('[data-testid="native-sidebar-item"]') ?? [])].map(
      (row) => row.dataset.id
    );
  const headOf = (folder: string) => {
    const head = projectOf(folder)?.querySelector<HTMLElement>('[aria-expanded]');
    if (!head) throw new Error(`no project ${folder}`);
    return head;
  };

  it('groups the conversations by the repository their folder is in, else by the folder; a new folder makes its project', async () => {
    const host = createFakeHost();
    host.repo('/work/mu');
    host.add({ id: 'a', cwd: '/work/mu', title: 'At the top', updatedAt: 1 });
    host.add({ id: 'b', cwd: '/work/mu/packages/app', title: 'In a package', updatedAt: 3 });
    host.add({ id: 'c', cwd: '/work/notes', title: 'Notes', updatedAt: 2 });
    sider(host.client);
    await waitFor(() => expect(projectFolders()).toEqual(['/work/mu', '/work/notes']));
    expect(headOf('/work/mu')).toHaveTextContent('mu');
    expect(rowsOf('/work/mu')).toEqual(['b', 'a']);
    expect(rowsOf('/work/notes')).toEqual(['c']);
    // A row says its folder where it is not the project's own.
    expect(items()[0]).toHaveTextContent(/^In a packageapp$/);
    expect(items()[1]).toHaveTextContent(/^At the top$/);

    // Started from the command line in a folder no project has: a project of its own, at the top.
    act(() =>
      host.change({
        conversation: { id: 'd', cwd: '/work/site', title: 'Site', createdAt: 4, updatedAt: 4, live: false },
      })
    );
    await waitFor(() => expect(projectFolders()).toEqual(['/work/site', '/work/mu', '/work/notes']));
    // In another folder of a repository the list has: into its project, no project of its own on the way.
    act(() =>
      host.change({
        conversation: { id: 'e', cwd: '/work/mu/docs', title: 'Docs', createdAt: 5, updatedAt: 5, live: false },
      })
    );
    expect(projectFolders()).toEqual(['/work/mu', '/work/site', '/work/notes']);
    expect(rowsOf('/work/mu')).toEqual(['e', 'b', 'a']);
  });

  it('adds a project from a picked folder: it shows, empty, and the home page opens to start a conversation there', async () => {
    const host = createFakeHost();
    host.repo('/work/mu');
    host.add({ id: 'a', cwd: '/work/mu', updatedAt: 1 });
    sider(host.client);
    await waitFor(() => expect(projectFolders()).toEqual(['/work/mu']));
    const add = screen.getByTestId('native-add-project-row');
    expect(add).toHaveTextContent('Add project');
    // No folder picked: nothing changes.
    await act(async () => {
      fireEvent.click(add);
    });
    expect(projectFolders()).toEqual(['/work/mu']);
    expect(screen.getByTestId('where')).toHaveAttribute('data-workspace', '');

    host.pick('/work/new');
    await act(async () => {
      fireEvent.click(add);
    });
    expect(projectFolders()).toEqual(['/work/new', '/work/mu']);
    expect(rowsOf('/work/new')).toEqual([]);
    expect(stored('mu.native.projects')).toEqual([{ folder: '/work/new', addedAt: expect.any(Number) }]);
    expect(screen.getByTestId('where')).toHaveTextContent('/guid');
    expect(screen.getByTestId('where')).toHaveAttribute('data-workspace', '/work/new');
    // What is started in it, or in a folder inside it, is in it.
    act(() =>
      host.change({
        conversation: { id: 'n', cwd: '/work/new/api', title: 'API', createdAt: 9, updatedAt: 9, live: false },
      })
    );
    await waitFor(() => expect(rowsOf('/work/new')).toEqual(['n']));
    expect(projectFolders()).toEqual(['/work/new', '/work/mu']);
  });

  it('starts a conversation in a project from its "+", and folds a project, which stays folded', async () => {
    const host = createFakeHost();
    host.add({ id: 'a', cwd: '/work/alpha', updatedAt: 1 });
    host.add({ id: 'b', cwd: '/work/beta', updatedAt: 2 });
    sider(host.client, '/conversation/native/b');
    await waitFor(() => expect(projectFolders()).toEqual(['/work/beta', '/work/alpha']));
    await act(async () => {
      fireEvent.click(within(projectOf('/work/alpha')!).getByTestId('native-project-new'));
    });
    expect(screen.getByTestId('where')).toHaveTextContent('/guid');
    expect(screen.getByTestId('where')).toHaveAttribute('data-workspace', '/work/alpha');
    // A click on the "+" does not fold the project.
    expect(headOf('/work/alpha')).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(headOf('/work/alpha'));
    expect(headOf('/work/alpha')).toHaveAttribute('aria-expanded', 'false');
    expect(shownIds()).toEqual(['b']);
    expect(stored('mu.native.foldedProjects')).toEqual(['/work/alpha']);
    cleanup();
    sider(host.client);
    await waitFor(() => expect(projectFolders()).toEqual(['/work/beta', '/work/alpha']));
    expect(shownIds()).toEqual(['b']);
    fireEvent.keyDown(headOf('/work/alpha'), { key: 'Enter' });
    expect(shownIds()).toEqual(['b', 'a']);
    expect(stored('mu.native.foldedProjects')).toEqual([]);
  });

  it('keeps the open conversation in view past the newest few of its project', async () => {
    const host = createFakeHost();
    for (let index = 1; index <= 7; index++) host.add({ id: `c${index}`, updatedAt: index });
    sider(host.client, '/conversation/native/c1');
    await waitFor(() => expect(shownIds()).toEqual(['c7', 'c6', 'c5', 'c4', 'c3', 'c1']));
    expect(items().at(-1)).toHaveAttribute('aria-current', 'page');
  });

  it('archives a project with its conversations after a confirmation, and removes an empty one', async () => {
    const success = vi.spyOn(Message, 'success').mockImplementation(() => undefined as never);
    setIs('mu.native.archived');
    const host = createFakeHost();
    host.add({ id: 'a', cwd: '/work/alpha', updatedAt: 1, sessionFile: '/s/a.jsonl' });
    host.add({ id: 'a2', cwd: '/work/alpha', updatedAt: 2, sessionFile: '/s/a2.jsonl' });
    // A draft keeps its place: its id changes when pi names its session, so it could not be restored.
    host.add({ id: 'draft-1', cwd: '/work/alpha', updatedAt: 3 });
    host.add({ id: 'b', cwd: '/work/beta', updatedAt: 4, sessionFile: '/s/b.jsonl' });
    sider(host.client);
    await waitFor(() => expect(projectFolders()).toEqual(['/work/beta', '/work/alpha']));
    const menu = async (folder: string) => {
      await act(async () => {
        fireEvent.click(within(projectOf(folder)!).getByTestId('native-project-menu'));
      });
      await waitFor(() => expect(screen.getByTestId('native-project-archive')).toBeVisible());
    };
    await menu('/work/alpha');
    expect(screen.getByTestId('native-project-archive')).toHaveTextContent('Archive project');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-project-archive'));
    });
    expect(await screen.findByTestId('native-project-archiving')).toHaveTextContent(
      'Archive "alpha" and its conversations? You can restore them from Archived at the end of the list.'
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-project-archive-confirm'));
    });
    expect(stored('mu.native.archived').toSorted()).toEqual(['a', 'a2']);
    expect(rowsOf('/work/alpha')).toEqual(['draft-1']);
    expect(screen.getByTestId('native-sidebar-archived-toggle')).toHaveTextContent('Archived (2)');
    expect(success).toHaveBeenLastCalledWith('Archived');

    // An added project with nothing in it is only removed.
    host.pick('/work/empty');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-add-project-row'));
    });
    expect(projectFolders()).toContain('/work/empty');
    await menu('/work/empty');
    expect(screen.getByTestId('native-project-archive')).toHaveTextContent('Remove project');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-project-archive'));
    });
    // No confirmation asked.
    expect(screen.getByTestId('native-project-archiving')).toBeEmptyDOMElement();
    expect(projectFolders()).not.toContain('/work/empty');
    expect(stored('mu.native.projects')).toEqual([]);
    setIs('mu.native.archived');
    success.mockRestore();
  });

  it('shows a project’s "+" and menu under the pointer or the keyboard’s focus, and while its menu is open', async () => {
    const host = createFakeHost();
    host.add({ id: 'a', cwd: '/work/alpha', updatedAt: 1, sessionFile: '/s/a.jsonl' });
    sider(host.client);
    await waitFor(() => expect(projectFolders()).toEqual(['/work/alpha']));
    const project = within(projectOf('/work/alpha')!);
    const buttons = () => [project.getByTestId('native-project-new'), project.getByTestId('native-project-menu')];
    // Not for any focus inside the row: a click leaves its button focused, and they would stay after the pointer left.
    for (const button of buttons()) {
      expect(button).toHaveClass(
        'hidden',
        'group-hover:flex',
        'group-focus-visible:flex',
        'group-has-[:focus-visible]:flex'
      );
      expect(button).not.toHaveClass('group-focus-within:flex');
    }
    await act(async () => {
      fireEvent.click(project.getByTestId('native-project-menu'));
    });
    await waitFor(() => expect(screen.getByTestId('native-project-archive')).toBeVisible());
    expect(project.getByTestId('native-project-menu')).toHaveAttribute('aria-expanded', 'true');
    // The pointer goes into the menu: both stay where they are.
    for (const button of buttons()) {
      expect(button).toHaveClass('flex');
      expect(button).not.toHaveClass('hidden');
    }
    await act(async () => {
      fireEvent.click(project.getByTestId('native-project-menu'));
    });
    expect(project.getByTestId('native-project-menu')).toHaveAttribute('aria-expanded', 'false');
    for (const button of buttons()) expect(button).toHaveClass('hidden');
  });

  it('gives a row’s title the room before its folder: the folder gives way first, down to a few letters', async () => {
    pinsAre(['b']);
    const host = createFakeHost();
    host.add({ id: 'b', cwd: '/work/release-notes-drafts', title: 'Draft the release notes', updatedAt: 2 });
    host.add({ id: 'c', cwd: '/work/notes', updatedAt: 1 });
    sider(host.client);
    await waitFor(() => expect(shownIds()).toEqual(['b', 'c']));
    const folder = within(items()[0]).getByTestId('native-sidebar-folder');
    expect(folder).toHaveTextContent('release-notes-drafts');
    // The title grows and shrinks from its own width; the folder shrinks a hundred times as fast, down to 3em (or all
    // of a shorter name).
    expect(folder.previousElementSibling).toHaveClass('flex-auto', 'min-w-0', 'truncate');
    expect(folder).toHaveClass('shrink-[100]', 'min-w-[calc-size(max-content,min(size,3em))]', 'max-w-40%', 'truncate');
    expect(folder).not.toHaveClass('shrink-0');
    pinsAre();
  });

  it('keeps a project the person added when its only conversation is pinned; one its conversations made goes', async () => {
    pinsAre();
    const host = createFakeHost();
    host.add({ id: 'a', cwd: '/work/alpha', updatedAt: 1, sessionFile: '/s/a.jsonl' });
    host.add({ id: 'b', cwd: '/work/beta', updatedAt: 2, sessionFile: '/s/b.jsonl' });
    sider(host.client);
    await waitFor(() => expect(projectFolders()).toEqual(['/work/beta', '/work/alpha']));
    host.pick('/work/alpha');
    await act(async () => {
      fireEvent.click(screen.getByTestId('native-add-project-row'));
    });
    expect(stored('mu.native.projects')).toEqual([{ folder: '/work/alpha', addedAt: expect.any(Number) }]);
    pinsAre(['a', 'b']);
    // Both rows are above the projects; the added project stays, empty, with its "+" and menu.
    expect(shownIds()).toEqual(['b', 'a']);
    expect(projectFolders()).toEqual(['/work/alpha']);
    expect(rowsOf('/work/alpha')).toEqual([]);
    expect(within(projectOf('/work/alpha')!).getByTestId('native-project-new')).toBeInTheDocument();
    pinsAre();
    expect(projectFolders()).toEqual(['/work/alpha', '/work/beta']);
  });
});
