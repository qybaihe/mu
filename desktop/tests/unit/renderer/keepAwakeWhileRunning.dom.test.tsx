/**
 * What the window tells the main process about sleep (hooks/system/useKeepAwakeWhileRunning.ts): hold it off while a
 * native conversation's run or a classic reply goes, and the person has not turned that off.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sent: [] as boolean[],
  native: [] as Array<{ id: string; running?: boolean }>,
  generating: new Set<string>(),
  setting: undefined as boolean | undefined,
  listeners: new Set<(value: unknown) => void>(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    systemSettings: {
      keepAwakeWhileRunning: {
        invoke: async ({ on }: { on: boolean }) => {
          state.sent.push(on);
        },
      },
    },
  },
}));
vi.mock('@/common/config/configService', () => ({
  configService: {
    get: () => state.setting,
    subscribe: (_key: string, listener: (value: unknown) => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  },
}));
vi.mock('@/renderer/pages/native/hooks/useNativeConversations', () => ({
  useNativeEnabled: () => true,
  useNativeConversations: () => ({ conversations: state.native, loading: false }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync', () => ({
  useConversationActivitySets: () => ({ generatingConversationIds: state.generating }),
}));
vi.mock('@/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/platform')>()),
  isElectronDesktop: () => true,
}));

import { useKeepAwakeWhileRunning } from '@/renderer/hooks/system/useKeepAwakeWhileRunning';

afterEach(() => {
  state.sent = [];
  state.native = [];
  state.generating = new Set();
  state.setting = undefined;
  state.listeners.clear();
});

describe('keeping the computer awake while a conversation runs', () => {
  it('asks for it while a native run or a classic reply goes, and lets it sleep after', () => {
    const view = renderHook(() => useKeepAwakeWhileRunning());
    expect(state.sent).toEqual([false]);

    state.native = [{ id: 'n1', running: true }];
    view.rerender();
    expect(state.sent.at(-1)).toBe(true);

    state.native = [{ id: 'n1' }];
    state.generating = new Set(['c1']);
    view.rerender();
    // Still running, now the classic one: nothing new to say.
    expect(state.sent).toEqual([false, true]);

    state.generating = new Set();
    view.rerender();
    expect(state.sent.at(-1)).toBe(false);
  });

  it('never asks while the person turned it off, and follows the setting as it changes', () => {
    state.setting = false;
    state.native = [{ id: 'n1', running: true }];
    renderHook(() => useKeepAwakeWhileRunning());
    expect(state.sent).toEqual([false]);

    act(() => {
      for (const listener of state.listeners) listener(true);
    });
    expect(state.sent.at(-1)).toBe(true);
  });
});
