/**
 * The number on the app's Dock icon (hooks/system/notification/useAppBadge.ts): the conversations the sidebar marks
 * as waiting, native and classic, each once; told to the main process whenever it changes.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => [] as number[]);
const classic = vi.hoisted(() => ({
  completionUnreadConversationIds: new Set<string>(['c1']),
  manualUnreadConversationIds: new Set<string>(['c1', 'c2']),
  waitingConfirmationConversationIds: new Set<string>(['c3']),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    notification: {
      badge: {
        invoke: async ({ count }: { count: number }) => {
          sent.push(count);
        },
      },
    },
  },
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync', () => ({
  useConversationListSync: () => classic,
}));
vi.mock('@/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/platform')>()),
  isElectronDesktop: () => true,
}));

import { useAppBadge, waitingCount } from '@/renderer/hooks/system/notification/useAppBadge';
import { clearNativeUnread, forgetNativeUnread, markNativeUnread } from '@/renderer/pages/native/hooks/useNativeAttention';

afterEach(() => {
  forgetNativeUnread();
  sent.length = 0;
});

describe('the number on the app’s icon', () => {
  it('counts each waiting conversation once, whatever marks it', () => {
    expect(waitingCount(new Set(['a', 'b']), new Set(['b', 'c']), new Set())).toBe(3);
    expect(waitingCount()).toBe(0);
  });

  it('follows the native conversations’ marks as they come and go, with the classic ones', () => {
    renderHook(() => useAppBadge());
    expect(sent.at(-1)).toBe(3);
    act(() => markNativeUnread('n1'));
    expect(sent.at(-1)).toBe(4);
    act(() => clearNativeUnread('n1'));
    expect(sent.at(-1)).toBe(3);
  });
});
