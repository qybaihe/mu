import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NativeConversation } from '@/common/kyrn/nativeBridge';
import { useNativeConversations, useNativeEnabled } from '@/renderer/pages/native/hooks/useNativeConversations';
import { NativeClientContext, type NativeClient } from '@/renderer/pages/native/utils/nativeClient';
import { createFakeHost } from './fakeClient';

/** The sidebar's native conversations, and whether the native host is on. */

const wrapperOf =
  (client: NativeClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <NativeClientContext.Provider value={client}>{children}</NativeClientContext.Provider>
  );

const conversation = (id: string, updatedAt: number, extra: Partial<NativeConversation> = {}): NativeConversation => ({
  id,
  cwd: '/project',
  title: id,
  createdAt: 1,
  updatedAt,
  live: false,
  ...extra,
});

describe('useNativeConversations', () => {
  it('lists the conversations newest first, and keeps the list as it changes', async () => {
    const host = createFakeHost();
    host.add(conversation('a', 1));
    host.add(conversation('b', 3));
    const { result } = renderHook(() => useNativeConversations(true), { wrapper: wrapperOf(host.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conversations.map((each) => each.id)).toEqual(['b', 'a']);
    act(() => host.change({ conversation: conversation('draft-3', 5) }));
    act(() => host.change({ conversation: conversation('s-3', 6, { live: true }), replaces: 'draft-3' }));
    act(() => host.change({ conversation: conversation('a', 7, { title: 'Renamed' }) }));
    act(() => host.change({ removed: 'b' }));
    expect(result.current.conversations.map((each) => [each.id, each.title])).toEqual([
      ['a', 'Renamed'],
      ['s-3', 's-3'],
    ]);
  });

  it('reads nothing while the native host is off', async () => {
    const host = createFakeHost();
    const { result } = renderHook(() => useNativeConversations(false), { wrapper: wrapperOf(host.client) });
    expect(result.current).toEqual({ conversations: [], loading: false });
    expect(host.calls).toEqual([]);
  });

  it('says why the list could not be read', async () => {
    const host = createFakeHost();
    const client: NativeClient = { ...host.client, list: async () => ({ ok: false, kind: 'off', message: 'off' }) };
    const { result } = renderHook(() => useNativeConversations(true), { wrapper: wrapperOf(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failure).toMatchObject({ kind: 'off' });
  });
});

describe('useNativeEnabled', () => {
  it('is unknown until the main process says whether the host is on', async () => {
    const host = createFakeHost();
    const { result } = renderHook(() => useNativeEnabled(), { wrapper: wrapperOf(host.client) });
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(true));
    const off = createFakeHost();
    off.enable(false);
    const second = renderHook(() => useNativeEnabled(), { wrapper: wrapperOf(off.client) });
    await act(async () => {});
    expect(second.result.current).toBe(false);
  });
});
