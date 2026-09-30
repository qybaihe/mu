import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { Message } from '@arco-design/web-react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localFileRef, uploadFileRef, type ChatFileRef } from '@/common/types/chatFile';
import { DEFAULT_RECENT_WS_KEY } from '@/renderer/components/workspace/recentWorkspaces';
import GuidWorkspaceFootnote from '@/renderer/pages/guid/components/GuidWorkspaceFootnote';
import { useGuidNativeSend, type GuidNativeSendDeps } from '@/renderer/pages/guid/hooks/useGuidNativeSend';
import { withNativeFolders } from '@/renderer/pages/guid/hooks/useNativeFolders';
import { NativeClientContext, type NativeClient } from '@/renderer/pages/native/utils/nativeClient';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import { createFakeHost, type FakeHost } from './fakeClient';

/**
 * The home page while the native host is on: its send starts a native conversation (the folder, the permission mode,
 * the model the pill picked, the message with its files) and opens it; a send that cannot says why and keeps what was
 * typed; its folder list takes in the native conversations' folders, and stays as it was while the host is off.
 */

afterEach(cleanup);

const i18n = createInstance();
void i18n.init({
  lng: 'en',
  resources: { en: { translation: { mu: enMu } } },
  interpolation: { escapeValue: false },
});

type Setters = {
  setInput: ReturnType<typeof vi.fn>;
  setFiles: ReturnType<typeof vi.fn>;
  setDir: ReturnType<typeof vi.fn>;
  setLoading: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
};

function home(client: NativeClient, patch: Partial<GuidNativeSendDeps> = {}) {
  const setters: Setters = {
    setInput: vi.fn(),
    setFiles: vi.fn(),
    setDir: vi.fn(),
    setLoading: vi.fn(),
    navigate: vi.fn(async () => undefined),
  };
  const deps: GuidNativeSendDeps = {
    input: 'fix the build',
    files: [],
    dir: '/work/app',
    loading: false,
    selectedMode: '',
    selectedAcpModel: null,
    t: i18n.t.bind(i18n) as never,
    readImage: async () => undefined,
    ...setters,
    navigate: setters.navigate as never,
    setInput: setters.setInput as never,
    setFiles: setters.setFiles as never,
    setDir: setters.setDir as never,
    setLoading: setters.setLoading as never,
    ...patch,
  };
  const hook = renderHook(() => useGuidNativeSend(deps), {
    wrapper: ({ children }) => <NativeClientContext.Provider value={client}>{children}</NativeClientContext.Provider>,
  });
  const send = async () => {
    await act(async () => {
      hook.result.current.sendMessageHandler();
    });
    await act(async () => {});
  };
  return { hook, setters, send };
}

/** The folders the home page's folder list shows, in order. */
const listed = () => [...document.querySelectorAll('[class*="wsDropdownItemName"]')].map((row) => row.textContent);

const requests = (host: FakeHost) =>
  host.calls.filter((call) => call.method === 'request').map((call) => ({ id: call.id, command: call.command }));

describe('the home page’s send on the native host', () => {
  beforeEach(() => {
    vi.spyOn(Message, 'warning').mockImplementation(() => undefined as never);
    vi.spyOn(Message, 'error').mockImplementation(() => undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('makes the conversation in the folder and mode, sets the model, sends the message with its files, opens it', async () => {
    const host = createFakeHost();
    // pi names the session while it takes the message: the page opens under the session's id.
    host.answer((id, command) => {
      if (command.type === 'prompt')
        host.change({
          conversation: { id: 's-1', cwd: '/work/app', title: '', createdAt: 1, updatedAt: 1, live: true },
          replaces: id,
        });
      return { ok: true, data: undefined };
    });
    const files: ChatFileRef[] = [localFileRef('/shots/screen.PNG'), uploadFileRef('/uploads/spec.pdf')];
    const readImage = vi.fn(async () => 'data:image/png;base64,AAAA');
    const { hook, setters, send } = home(host.client, {
      selectedMode: 'ask',
      selectedAcpModel: 'e2e/e2e-fake-model-2',
      files,
      readImage,
    });
    expect(hook.result.current.isButtonDisabled).toBe(false);
    await send();
    expect(host.calls.find((call) => call.method === 'create')).toEqual({
      method: 'create',
      cwd: '/work/app',
      permissions: 'ask',
    });
    expect(requests(host)).toEqual([
      { id: 'draft-1', command: { type: 'set_model', provider: 'e2e', modelId: 'e2e-fake-model-2' } },
      {
        id: 'draft-1',
        command: {
          type: 'prompt',
          message: 'fix the build\n\n[[AION_FILES]]\n/uploads/spec.pdf',
          images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
        },
      },
    ]);
    expect(readImage).toHaveBeenCalledTimes(1);
    expect(setters.navigate).toHaveBeenCalledWith('/conversation/native/s-1');
    expect(setters.setInput).toHaveBeenCalledWith('');
    expect(setters.setFiles).toHaveBeenCalledWith([]);
    expect(setters.setDir).toHaveBeenCalledWith('');
    expect(host.calls.some((call) => call.method === 'remove')).toBe(false);
  });

  it('sends an image it cannot read as its path, a mode that is not mu’s and a model without a provider not at all', async () => {
    const host = createFakeHost();
    const { send } = home(host.client, {
      selectedMode: 'bypassPermissions',
      selectedAcpModel: 'default',
      files: [localFileRef('/shots/gone.png')],
    });
    await send();
    expect(host.calls.find((call) => call.method === 'create')).toEqual({ method: 'create', cwd: '/work/app' });
    expect(requests(host)).toEqual([
      {
        id: 'draft-1',
        command: { type: 'prompt', message: 'fix the build\n\n[[AION_FILES]]\n/shots/gone.png' },
      },
    ]);
  });

  it('sets the thinking level the person picked after the model and before the message', async () => {
    const host = createFakeHost();
    const { send } = home(host.client, { selectedAcpModel: 'e2e/e2e-fake-thinker', pickedThoughtLevel: 'high' });
    await send();
    // The model first: `set_model` sets the level back.
    expect(requests(host).map(({ command }) => command)).toEqual([
      { type: 'set_model', provider: 'e2e', modelId: 'e2e-fake-thinker' },
      { type: 'set_thinking_level', level: 'high' },
      { type: 'prompt', message: 'fix the build' },
    ]);
  });

  it('sets a level picked on the model the pill already showed without setting a model, and sends none the pill only shows', async () => {
    const shown = createFakeHost();
    await home(shown.client, { pickedThoughtLevel: 'low' }).send();
    expect(requests(shown).map(({ command }) => command.type)).toEqual(['set_thinking_level', 'prompt']);
    const unpicked = createFakeHost();
    await home(unpicked.client, { selectedAcpModel: 'e2e/e2e-fake-thinker' }).send();
    expect(requests(unpicked).map(({ command }) => command.type)).toEqual(['set_model', 'prompt']);
  });

  it('leaves no conversation behind when pi refuses the level, and keeps what was typed', async () => {
    const host = createFakeHost();
    host.answer((_id, command) =>
      command.type === 'set_thinking_level'
        ? { ok: false, kind: 'command', message: 'Unknown thinking level bogus' }
        : { ok: true, data: undefined }
    );
    const { setters, send } = home(host.client, { pickedThoughtLevel: 'bogus' });
    await send();
    expect(Message.error).toHaveBeenCalledWith(expect.stringContaining('Unknown thinking level bogus'));
    expect(host.calls.map((call) => call.method)).toEqual(['create', 'request', 'remove']);
    expect(setters.navigate).not.toHaveBeenCalled();
    expect(setters.setInput).not.toHaveBeenCalled();
  });

  it('starts an empty conversation when nothing is typed, as the classic page does', async () => {
    const host = createFakeHost();
    const { setters, send } = home(host.client, { input: '   ' });
    await send();
    expect(host.calls.map((call) => call.method)).toEqual(['create']);
    expect(setters.navigate).toHaveBeenCalledWith('/conversation/native/draft-1');
  });

  it('says a folder is needed, and makes nothing', async () => {
    const host = createFakeHost();
    const { setters, send } = home(host.client, { dir: '' });
    await send();
    expect(Message.warning).toHaveBeenCalledWith('Choose a folder for mu to work in first.');
    expect(host.calls).toEqual([]);
    expect(setters.navigate).not.toHaveBeenCalled();
    expect(setters.setInput).not.toHaveBeenCalled();
  });

  it('says why the conversation could not be made, and keeps what was typed', async () => {
    const host = createFakeHost();
    const { setters, send } = home({
      ...host.client,
      create: async () => ({ ok: false, kind: 'no-harness', message: 'no mu at /opt/mu' }),
    });
    await send();
    expect(Message.error).toHaveBeenCalledWith('The app cannot find a mu to run. no mu at /opt/mu');
    expect(setters.navigate).not.toHaveBeenCalled();
    expect(setters.setInput).not.toHaveBeenCalled();
    expect(setters.setLoading).toHaveBeenLastCalledWith(false);
  });

  it('leaves no conversation behind when mu does not start, and keeps what was typed', async () => {
    const host = createFakeHost();
    host.answer(() => ({ ok: false, kind: 'failed', message: 'spawn ENOENT' }));
    const { setters, send } = home(host.client);
    await send();
    expect(Message.error).toHaveBeenCalledWith('mu stopped before it started. spawn ENOENT');
    expect(host.calls.map((call) => call.method)).toEqual(['create', 'request', 'remove']);
    expect(host.calls.at(-1)).toEqual({ method: 'remove', id: 'draft-1' });
    expect(setters.navigate).not.toHaveBeenCalled();
    expect(setters.setInput).not.toHaveBeenCalled();
  });
});

describe('the home page’s folder list', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('puts the native conversations’ folders after the recent ones, each once', () => {
    expect(withNativeFolders(['/a', '/b'], ['/b', '/c'])).toEqual(['/a', '/b', '/c']);
    expect(withNativeFolders([], [])).toEqual([]);
  });

  const footnote = (client: NativeClient) =>
    render(
      <I18nextProvider i18n={i18n}>
        <NativeClientContext.Provider value={client}>
          <GuidWorkspaceFootnote workspaceDir='' onSelectWorkspace={() => {}} onClearWorkspace={() => {}} />
        </NativeClientContext.Provider>
      </I18nextProvider>
    );

  it('offers the native conversations’ folders while the host is on', async () => {
    localStorage.setItem(DEFAULT_RECENT_WS_KEY, JSON.stringify(['/work/beta']));
    const host = createFakeHost();
    host.add({ id: 'a', cwd: '/work/alpha', updatedAt: 2 });
    host.add({ id: 'b', cwd: '/work/beta', updatedAt: 1 });
    footnote(host.client);
    await waitFor(() => expect(host.calls.some((call) => call.method === 'list')).toBe(true));
    await act(async () => {});
    fireEvent.click(screen.getByTestId('workspace-selector-btn'));
    await waitFor(() => expect(listed()).toEqual(['beta', 'alpha']));
  });

  it('is as it was while the host is off', async () => {
    localStorage.setItem(DEFAULT_RECENT_WS_KEY, JSON.stringify(['/work/beta']));
    const host = createFakeHost();
    host.enable(false);
    host.add({ id: 'a', cwd: '/work/alpha' });
    footnote(host.client);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('workspace-selector-btn'));
    await waitFor(() => expect(listed()).toEqual(['beta']));
    expect(host.calls).toEqual([]);
  });
});
