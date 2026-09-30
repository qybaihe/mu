/**
 * A native conversation wants its person, who may not be looking: a run ended or failed, or pi asks something (the
 * main process says so once a run has settled for a moment: NativeAttentionEvent). Two things follow, as they do for a
 * classic conversation:
 *
 * - a system notification, which the main process shows only when notifications are on and the window is not the one in
 *   front (`showNotification`); a click on it opens the conversation (`useNotificationClick`);
 * - a mark on the conversation's sidebar row until it is opened, unless it is the conversation on screen: a person
 *   looking at it knows, and a window that is not in front tells them by the notification instead.
 *
 * The marks are kept in the window's storage (idSetStore.ts), so they outlive a restart, and the person can mark a
 * conversation unread by hand from its row's menu. A mark goes when the conversation is opened, or is gone.
 */
import type { TFunction } from 'i18next';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import type { NativeAttentionEvent } from '@/common/kyrn/nativeBridge';
import { truncateConversationName } from '@/renderer/hooks/system/notification/browserNotificationCore';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { useNativeClient } from '../utils/nativeClient';
import { nativeConversationPath } from '../utils/paths';
import { createIdSetStore, useIdSet } from './idSetStore';

export const UNREAD_KEY = 'mu.native.unread';

const store = createIdSetStore(UNREAD_KEY);

/** The conversation wanted its person while it was not on screen (or the person marked it unread). */
export const markNativeUnread = (id: string): void => store.add(id);

/** The conversation was opened: what it wanted is seen. */
export const clearNativeUnread = (id: string): void => store.remove(id);

/** Marks the conversation unread, or read when it is. */
export const toggleNativeUnread = (id: string): void => store.toggle(id);

/** Drops the marks of conversations that are not in `keep` (they were deleted). */
export const pruneNativeUnread = (keep: ReadonlySet<string>): void => store.retain(keep);

/** Forgets every mark (a test starts from none). */
export const forgetNativeUnread = (): void => store.clear();

/** The conversations marked in the sidebar. */
export const useNativeUnread = (): ReadonlySet<string> => useIdSet(store);

/** What a notification says: the classic conversations' words for a finished reply and a question, ours for a failure. */
function bodyOf(t: TFunction, { kind, title }: NativeAttentionEvent): string {
  const name = truncateConversationName(title);
  switch (kind) {
    case 'question':
      return name
        ? t('settings.browserNotification.bodyConfirmationNamed', { name })
        : t('settings.browserNotification.bodyConfirmation');
    case 'error':
      return name ? t('mu.native.notify.failedNamed', { name }) : t('mu.native.notify.failed');
    case 'done':
      return name
        ? t('settings.browserNotification.bodyTurnCompletedNamed', { name })
        : t('settings.browserNotification.bodyTurnCompleted');
  }
}

/** Listens for the main process's word, for the whole app: mounted once, beside the classic turn notification. */
export function useNativeAttention(): void {
  const { t } = useTranslation();
  const client = useNativeClient();
  const { pathname } = useLocation();
  const viewing = useRef(pathname);
  useEffect(() => {
    viewing.current = pathname;
  }, [pathname]);

  useEffect(
    () =>
      client.onAttention((event) => {
        if (viewing.current !== nativeConversationPath(event.id)) markNativeUnread(event.id);
        // Cheap gate here; the main process still re-checks the setting and whether the window is in front.
        if (!isElectronDesktop() || configService.get('system.notificationEnabled') === false) return;
        void ipcBridge.notification.show.invoke({
          title: 'mu',
          body: bodyOf(t, event),
          conversation_id: event.id,
          native: true,
        });
      }),
    [client, t]
  );
}
