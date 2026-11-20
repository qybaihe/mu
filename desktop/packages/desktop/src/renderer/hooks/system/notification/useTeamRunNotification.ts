/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fire a native system notification for team runs: the lead's run completed,
 * a run failed, or the run stalled waiting on a teammate.
 *
 * The stall notification is subscribed from the shared wait watcher — the same
 * verdict that adds the attention row — so the two presentations stay one fact.
 * The main-process notification bridge decides whether anything is actually
 * shown (it skips when the main window is focused and respects
 * `system.notificationEnabled`); clicks are handled by `useNotificationClick`,
 * which navigates to the originating conversation.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { subscribeTeamWait } from '@renderer/pages/workbench/attention/teamWaitStore';
import { createTeamRunNotificationController, type TeamRunNotification } from './teamRunNotificationCore';

/** Resolve the team's name and the conversation a slot id lives in, for the notification
 *  body and the click target. The run names slots, never conversations. */
const resolveTeam = async (
  teamId: string,
  slotId?: string
): Promise<{ teamName?: string; conversationId?: string }> => {
  try {
    const team = await ipcBridge.team.get.invoke({ id: teamId });
    if (!team) return {};
    const conversationId = slotId
      ? team.assistants?.find((assistant) => assistant.slot_id === slotId)?.conversation_id
      : team.assistants?.find((assistant) => assistant.role === 'leader')?.conversation_id;
    return { teamName: team.name, conversationId };
  } catch {
    // A deleted team has nothing to point at; the notification is dropped.
    return {};
  }
};

/** Fires a native system notification when one of the user's team runs completes, fails or stalls; no-op off Electron. */
export const useTeamRunNotification = (): void => {
  const { t } = useTranslation();

  useEffect(() => {
    if (!isElectronDesktop()) return;

    const show = (body: string, conversationId?: string): void => {
      if (configService.get('system.notificationEnabled') === false) return;
      void ipcBridge.notification.show.invoke({ title: 'mu', body, conversation_id: conversationId });
    };

    const controller = createTeamRunNotificationController({
      notify: ({ kind, teamId, slotId }: TeamRunNotification) => {
        void resolveTeam(teamId, slotId).then(({ teamName, conversationId }) => {
          if (kind === 'runCompleted') {
            show(
              teamName
                ? t('team.notification.bodyRunCompletedNamed', { name: teamName })
                : t('team.notification.bodyRunCompleted'),
              conversationId
            );
            return;
          }
          show(
            teamName
              ? t('team.notification.bodyRunFailedNamed', { name: teamName })
              : t('team.notification.bodyRunFailed'),
            conversationId
          );
        });
      },
    });

    const disposeCompleted = ipcBridge.team.runCompleted.on(controller.onRunCompleted);
    const disposeFailed = ipcBridge.team.runFailed.on(controller.onRunFailed);
    // The stall verdict is shared with the attention row (one fact, two presentations).
    const disposeWait = subscribeTeamWait((event) => {
      if (event.type !== 'stalled') return;
      void ipcBridge.team.get
        .invoke({ id: event.teamId })
        .then((team) => {
          const teamName = team?.name;
          show(
            teamName
              ? t('team.notification.bodyWaitingStallNamed', { name: teamName })
              : t('team.notification.bodyWaitingStall'),
            event.leadConversationId
          );
        })
        .catch(() => {
          show(t('team.notification.bodyWaitingStall'), event.leadConversationId);
        });
    });

    return () => {
      disposeCompleted();
      disposeFailed();
      disposeWait();
    };
  }, [t]);
};
