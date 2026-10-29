/**
 * The number on the app's Dock icon (macOS) or launcher entry (Linux): how many conversations wait for the person, the
 * ones the sidebar marks. A native conversation that ended, failed or asks something while it was not on screen
 * (useNativeAttention), and a classic one that finished a reply out of view, waits for a confirmation or was marked
 * unread by hand. Each counts once; opening it takes it off. Mounted once, with the layout.
 */
import { useEffect, useMemo } from 'react';
import { ipcBridge } from '@/common';
import { useConversationListSync } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { useNativeUnread } from '@/renderer/pages/native/hooks/useNativeAttention';
import { isElectronDesktop } from '@/renderer/utils/platform';

/** How many distinct conversations the marks name. */
export function waitingCount(...marks: ReadonlyArray<ReadonlySet<string>>): number {
  return new Set(marks.flatMap((ids) => [...ids])).size;
}

export function useAppBadge(): void {
  const native = useNativeUnread();
  const { completionUnreadConversationIds, manualUnreadConversationIds, waitingConfirmationConversationIds } =
    useConversationListSync();
  const count = useMemo(
    () =>
      waitingCount(
        native,
        completionUnreadConversationIds,
        manualUnreadConversationIds,
        waitingConfirmationConversationIds
      ),
    [native, completionUnreadConversationIds, manualUnreadConversationIds, waitingConfirmationConversationIds]
  );
  useEffect(() => {
    if (!isElectronDesktop()) return;
    void ipcBridge.notification.badge.invoke({ count }).catch(() => {
      // An older main process has no badge: the sidebar's marks still say it.
    });
  }, [count]);
}
