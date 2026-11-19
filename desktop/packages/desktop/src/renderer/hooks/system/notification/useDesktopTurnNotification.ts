/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { getSnapshotConversationName } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { completionSoundOn, playAttentionSound } from './attentionSound';
import { createBrowserNotificationController, truncateConversationName } from './browserNotificationCore';
import { teamInfoOf } from '@renderer/pages/workbench/team/claimsEnv';

/**
 * Fire a native system notification when an agent turn finishes.
 *
 * The renderer only reports "a turn finished"; the main-process notification
 * bridge decides whether to actually show it (it skips when the main window is
 * focused and respects `system.notificationEnabled`). Clicks are handled by
 * `useNotificationClick`, which navigates to the originating conversation.
 *
 * Team conversations are the team wire's territory: their turn-completed
 * notification comes from `useTeamRunNotification` (the lead's run completed),
 * so this hook yields the finish kind there — one fact, one notification.
 * Confirmation kinds still notify here on every conversation, team chats
 * included: "needs your input" is always the person's to see.
 */
export const useDesktopTurnNotification = (): void => {
  const { t } = useTranslation();

  useEffect(() => {
    if (!isElectronDesktop()) return;

    const streamEmitter = ipcBridge.conversation?.responseStream;
    if (!streamEmitter) return;

    const controller = createBrowserNotificationController({
      // Cheap renderer-side gate; the main process still re-checks the setting
      // and the window-focus condition before showing anything.
      shouldShow: () => configService.get('system.notificationEnabled') !== false || completionSoundOn(),
      bodyFor: (kind, conversationId) => {
        const name = conversationId ? getSnapshotConversationName(conversationId) : undefined;
        if (kind === 'confirmation') {
          return name
            ? t('settings.browserNotification.bodyConfirmationNamed', { name: truncateConversationName(name) })
            : t('settings.browserNotification.bodyConfirmation');
        }
        return name
          ? t('settings.browserNotification.bodyTurnCompletedNamed', { name: truncateConversationName(name) })
          : t('settings.browserNotification.bodyTurnCompleted');
      },
      show: ({ body, conversationId, kind }) => {
        // The chime, if the person turned it on (attentionSound.ts), whether the window is in front or not.
        if (completionSoundOn()) playAttentionSound(kind === 'confirmation' ? 'question' : 'done');
        if (configService.get('system.notificationEnabled') === false) return;
        // Team conversations: the team wire owns the finish notification (see the
        // module comment) — yield here so the same fact never notifies twice.
        if (kind === 'turnCompleted' && conversationId) {
          void teamInfoOf(conversationId).then((info) => {
            if (info?.teamId) return;
            void ipcBridge.notification.show.invoke({ title: 'mu', body, conversation_id: conversationId });
          });
          return;
        }
        // Both turn-completed and confirmation (permission / question) kinds
        // fire a native notification. The main process still gates on the
        // setting and skips when the window is focused.
        void ipcBridge.notification.show.invoke({ title: 'mu', body, conversation_id: conversationId });
      },
    });

    const disposeStream = streamEmitter.on(controller.onStreamMessage);
    return () => {
      disposeStream();
    };
  }, [t]);
};
