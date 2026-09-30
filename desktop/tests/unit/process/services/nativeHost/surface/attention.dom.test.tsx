import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { IMessageText } from '@/common/chat/chatLib';
import { configService } from '@/common/config/configService';
import NativeConversationPage from '@/renderer/pages/native';
import NativeSiderGroup from '@/renderer/pages/native/components/NativeSiderGroup';
import {
  clearNativeUnread,
  forgetNativeUnread,
  markNativeUnread,
  useNativeAttention,
} from '@/renderer/pages/native/hooks/useNativeAttention';
import { NativeClientContext, type NativeClient } from '@/renderer/pages/native/utils/nativeClient';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import enMessages from '@/renderer/services/i18n/locales/en-US/messages.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import enSettings from '@/renderer/services/i18n/locales/en-US/settings.json';
import { createFakeHost } from './fakeClient';

/**
 * A native conversation that wants its person (hooks/useNativeAttention.ts): the main process says a run ended, failed,
 * or that pi asks something. The app tells the system (a notification, which the main process shows only when the window
 * is not in front) and marks the conversation's sidebar row until it is opened, unless it is the one on screen. The
 * sidebar's row shows a run in progress, that mark, or the host's green dot.
 */

const shown = vi.fn();
let notificationsOn: boolean | undefined = true;
let inDesktopApp = true;

vi.mock('@/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/platform')>()),
  isElectronDesktop: () => inDesktopApp,
}));
vi.mock('@/renderer/components/chat/SendBox', () => ({ default: () => <textarea data-testid='sendbox-input' /> }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageText', () => ({
  default: ({ message }: { message: IMessageText }) => <div>{message.content.content}</div>,
}));
// The parts of the page that pull in the preview and the browser have tests of their own.
vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Preview/browser/muBrowser/MuBrowserHost', () => ({ default: () => null }));

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

beforeEach(() => {
  shown.mockReset();
  notificationsOn = true;
  inDesktopApp = true;
  forgetNativeUnread();
  vi.spyOn(ipcBridge.notification.show, 'invoke').mockImplementation(async (options) => {
    shown(options);
  });
  vi.spyOn(configService, 'get').mockImplementation(((key: string) =>
    key === 'system.notificationEnabled' ? notificationsOn : undefined) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const Listening: React.FC = () => {
  useNativeAttention();
  return null;
};
const Where: React.FC = () => <div data-testid='where'>{useLocation().pathname}</div>;

/** The app-wide listener, the sidebar group, and the native page for the route: what the layout holds. */
function app(client: NativeClient, at: string) {
  return render(
    <I18nextProvider i18n={i18n}>
      <NativeClientContext.Provider value={client}>
        <MemoryRouter initialEntries={[at]}>
          <Listening />
          <NativeSiderGroup />
          <Routes>
            <Route path='/conversation/native/:id' element={<NativeConversationPage />} />
            <Route path='/guid' element={<div />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </NativeClientContext.Provider>
    </I18nextProvider>
  );
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-testid="native-sidebar-item"][data-id="${id}"]`);

function twoConversations() {
  const host = createFakeHost();
  host.add({ id: 'c1', cwd: '/work/alpha', title: 'Alpha', updatedAt: 2 });
  host.add({ id: 'c2', cwd: '/work/beta', title: 'Beta', updatedAt: 1 });
  return host;
}

const listed = () => waitFor(() => expect(row('c2')).not.toBeNull());

describe('a conversation that wants its person', () => {
  it('tells the system and marks its row when it is not the one on screen', async () => {
    const host = twoConversations();
    app(host.client, '/guid');
    await listed();
    act(() => host.attend({ id: 'c2', kind: 'done', title: 'Beta' }));
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith({
      title: 'mu',
      body: '"Beta" has finished responding',
      conversation_id: 'c2',
      native: true,
    });
    expect(row('c2')).toHaveAttribute('data-unread', 'true');
    expect(row('c2')?.querySelector('[data-testid="native-sidebar-unread"]')).not.toBeNull();
    expect(row('c1')).not.toHaveAttribute('data-unread');
  });

  it('tells the system but marks nothing when it is the conversation on screen', async () => {
    const host = twoConversations();
    app(host.client, '/conversation/native/c1');
    await listed();
    act(() => host.attend({ id: 'c1', kind: 'done', title: 'Alpha' }));
    expect(shown).toHaveBeenCalledTimes(1);
    expect(row('c1')).not.toHaveAttribute('data-unread');
  });

  it('says what happened in the words of the classic notifications, and of a failure', async () => {
    const host = twoConversations();
    app(host.client, '/guid');
    await listed();
    const bodies = () => shown.mock.calls.map(([options]) => (options as { body: string }).body);
    act(() => host.attend({ id: 'c2', kind: 'question', title: 'Beta' }));
    act(() => host.attend({ id: 'c2', kind: 'error', title: 'Beta' }));
    act(() => host.attend({ id: 'c2', kind: 'done', title: '' }));
    act(() => host.attend({ id: 'c2', kind: 'error', title: '' }));
    act(() => host.attend({ id: 'c2', kind: 'done', title: 'A conversation with a title that runs on and on' }));
    expect(bodies()).toEqual([
      '"Beta" is waiting for your confirmation',
      '"Beta" stopped with an error',
      'The agent has finished responding',
      'A run stopped with an error',
      '"A conversation with …" has finished responding',
    ]);
  });

  it('marks the row but sends no notification while notifications are off, or outside the desktop app', async () => {
    const host = twoConversations();
    app(host.client, '/guid');
    await listed();
    notificationsOn = false;
    act(() => host.attend({ id: 'c2', kind: 'done', title: 'Beta' }));
    expect(shown).not.toHaveBeenCalled();
    expect(row('c2')).toHaveAttribute('data-unread', 'true');
    act(() => clearNativeUnread('c2'));
    notificationsOn = true;
    inDesktopApp = false;
    act(() => host.attend({ id: 'c2', kind: 'done', title: 'Beta' }));
    expect(shown).not.toHaveBeenCalled();
    expect(row('c2')).toHaveAttribute('data-unread', 'true');
  });

  it('takes its mark off once the conversation is opened', async () => {
    const host = twoConversations();
    app(host.client, '/guid');
    await listed();
    act(() => host.attend({ id: 'c2', kind: 'done', title: 'Beta' }));
    expect(row('c2')).toHaveAttribute('data-unread', 'true');
    fireEvent.click(row('c2') as HTMLElement);
    expect(screen.getByTestId('where')).toHaveTextContent('/conversation/native/c2');
    await waitFor(() => expect(row('c2')).not.toHaveAttribute('data-unread'));
    expect(row('c2')?.querySelector('[data-testid="native-sidebar-unread"]')).toBeNull();
  });

  it('keeps the mark of the conversation left behind, and clears the one moved to', async () => {
    const host = twoConversations();
    app(host.client, '/conversation/native/c1');
    await listed();
    act(() => host.attend({ id: 'c2', kind: 'question', title: 'Beta' }));
    expect(row('c2')).toHaveAttribute('data-unread', 'true');
    // Another conversation wants the person meanwhile: both are marked until each is opened.
    act(() => markNativeUnread('c1'));
    expect(row('c1')).toHaveAttribute('data-unread', 'true');
    expect(row('c2')).toHaveAttribute('data-unread', 'true');
  });
});

describe('the sidebar row’s end', () => {
  it('shows a spinner while a run goes, the mark once it wanted its person, else the green dot of a running host', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', cwd: '/work/alpha', title: 'Alpha', live: true });
    app(host.client, '/guid');
    await waitFor(() => expect(row('c1')).not.toBeNull());
    const mark = (id: string, kind: string) => row(id)?.querySelector(`[data-testid="native-sidebar-${kind}"]`);
    expect(mark('c1', 'live')).not.toBeNull();
    expect(mark('c1', 'running')).toBeNull();

    act(() =>
      host.change({
        conversation: {
          id: 'c1',
          cwd: '/work/alpha',
          title: 'Alpha',
          createdAt: 1,
          updatedAt: 1,
          live: true,
          running: true,
        },
      })
    );
    await waitFor(() => expect(row('c1')).toHaveAttribute('data-running', 'true'));
    expect(mark('c1', 'running')).not.toBeNull();
    expect(mark('c1', 'live')).toBeNull();

    // A mark waits behind the spinner and shows once the run is over.
    act(() => markNativeUnread('c1'));
    expect(mark('c1', 'unread')).toBeNull();
    act(() =>
      host.change({
        conversation: { id: 'c1', cwd: '/work/alpha', title: 'Alpha', createdAt: 1, updatedAt: 1, live: true },
      })
    );
    await waitFor(() => expect(mark('c1', 'unread')).not.toBeNull());
    expect(row('c1')).not.toHaveAttribute('data-running');
    expect(mark('c1', 'live')).toBeNull();
  });
});
