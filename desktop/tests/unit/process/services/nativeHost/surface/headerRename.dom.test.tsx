import { Message } from '@arco-design/web-react';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NativeHeader from '@/renderer/pages/native/components/NativeHeader';
import { useNativeConversation } from '@/renderer/pages/native/hooks/useNativeConversation';
import { NativeClientContext, type NativeClient } from '@/renderer/pages/native/utils/nativeClient';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import { createFakeHost, type FakeHost } from './fakeClient';

/**
 * The native header's title, renamed where it stands against an in-memory host: a click makes it a field, Enter or
 * leaving it saves through the bridge's `rename`, Esc leaves it as it was, the new title comes back as the
 * conversation's change; an unchanged or empty name asks nothing, and a refused one keeps the field.
 */

// Arco's toasts render through a React DOM API jsdom's React has not: what they are asked to say is enough here.
let said: { success: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };
beforeEach(() => {
  said = {
    success: vi.spyOn(Message, 'success').mockImplementation(() => undefined as never),
    error: vi.spyOn(Message, 'error').mockImplementation(() => undefined as never),
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const i18n = createInstance();
void i18n.init({
  lng: 'en',
  resources: { en: { translation: { common: enCommon, conversation: enConversation, mu: enMu } } },
  interpolation: { escapeValue: false },
});

const Harness: React.FC<{ id: string }> = ({ id }) => {
  const conversation = useNativeConversation(id);
  return (
    <NativeHeader conversation={conversation.conversation} host={conversation.host} onRename={conversation.rename} />
  );
};

async function mount(host: FakeHost, client: NativeClient = host.client) {
  render(
    <I18nextProvider i18n={i18n}>
      <NativeClientContext.Provider value={client}>
        <Harness id='c1' />
      </NativeClientContext.Provider>
    </I18nextProvider>
  );
  await waitFor(() => expect(screen.getByTestId('native-header-title')).toHaveTextContent('fix the build'));
}

const renames = (host: FakeHost) => host.calls.filter((call) => call.method === 'rename');
const title = () => screen.getByTestId('native-header-title');
const field = () => screen.getByTestId('native-header-title-input');

describe('renaming a native conversation from its header', () => {
  it('saves on Enter, and shows the name the change brings', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', title: 'fix the build' });
    await mount(host);
    fireEvent.click(title());
    expect(field()).toHaveValue('fix the build');
    fireEvent.change(field(), { target: { value: '  Release notes  ' } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter', keyCode: 13 });
    });
    expect(renames(host)).toEqual([{ method: 'rename', id: 'c1', name: 'Release notes' }]);
    await waitFor(() => expect(title()).toHaveTextContent('Release notes'));
    expect(screen.queryByTestId('native-header-title-input')).toBeNull();
    expect(said.success).toHaveBeenCalledWith('Renamed successfully');
  });

  it('leaves the title as it was on Esc, and asks nothing for an unchanged or empty name', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', title: 'fix the build' });
    await mount(host);
    fireEvent.click(title());
    fireEvent.change(field(), { target: { value: 'Something else' } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Escape', code: 'Escape' });
    });
    expect(screen.queryByTestId('native-header-title-input')).toBeNull();
    expect(title()).toHaveTextContent('fix the build');
    // Enter opens it from the keyboard too.
    fireEvent.keyDown(title(), { key: 'Enter' });
    fireEvent.change(field(), { target: { value: '   ' } });
    await act(async () => {
      fireEvent.blur(field());
    });
    expect(screen.queryByTestId('native-header-title-input')).toBeNull();
    fireEvent.click(title());
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter', keyCode: 13 });
    });
    expect(renames(host)).toEqual([]);
  });

  it('saves when the field is left, as a classic title does', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', title: 'fix the build' });
    await mount(host);
    fireEvent.click(title());
    fireEvent.change(field(), { target: { value: 'Left behind' } });
    await act(async () => {
      fireEvent.blur(field());
    });
    expect(renames(host)).toEqual([{ method: 'rename', id: 'c1', name: 'Left behind' }]);
    await waitFor(() => expect(title()).toHaveTextContent('Left behind'));
  });

  it('keeps the field open when the rename is refused', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', title: 'fix the build' });
    const tried: string[] = [];
    await mount(host, {
      ...host.client,
      rename: async (_id, name) => {
        tried.push(name);
        return { ok: false, kind: 'invalid', message: 'A name is at most 500 characters' };
      },
    });
    fireEvent.click(title());
    fireEvent.change(field(), { target: { value: 'Too long, say' } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter', keyCode: 13 });
    });
    expect(tried).toEqual(['Too long, say']);
    expect(field()).toHaveValue('Too long, say');
    expect(field()).not.toBeDisabled();
    expect(said.error).toHaveBeenCalledTimes(1);
  });
});
