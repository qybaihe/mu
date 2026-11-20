/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deliver a receipt into the supervisor's conversation when a team run
 * completes or fails. The supervisor is the dispatcher of every registered
 * team, so closing the loop means it must learn the outcome: the receipt is a
 * real user message (it triggers one supervisor turn) whose body is the
 * `[[MU_TEAM_RECEIPT]]` marker payload — `MessageText` renders it localized
 * and the supervisor's injected rules tell it to acknowledge in one line.
 *
 * The verdict filter mirrors the notification chain (lead completions and any
 * failure are "the team answered you"), terminal events merge inside one
 * window (`RECEIPT_MERGE_WINDOW_MS`) so a burst costs one turn, and a receipt
 * without a supervisor conversation (never opened) is dropped — there is no
 * one to inform, the same best-effort rule a deleted team gets there.
 */
import { useEffect, useRef } from 'react';
import { ipcBridge } from '@/common';
import { SUPERVISOR_POSITION_NAME } from '@/common/chat/team/supervisor/supervisorCore';
import { findPositionConversationId } from '@/common/chat/team/positions/positionLibraryCore';
import { useConversationHistoryContext } from '@renderer/hooks/context/ConversationHistoryContext';
import {
  buildReceiptContent,
  createSupervisorReceiptBuffer,
  receiptEventFromRunEvent,
  type TeamReceiptFlush,
} from './teamReceiptCore';

/** The team's display name for the receipt; the id is the honest fallback (a team may be gone by flush time). */
const resolveTeamName = async (teamId: string): Promise<string> => {
  try {
    const team = await ipcBridge.team.get.invoke({ id: teamId });
    if (team?.name) return team.name;
  } catch {
    // A deleted team still finished its run; report it under its id.
  }
  return teamId;
};

export const useSupervisorTeamReceipt = (): void => {
  const { conversations } = useConversationHistoryContext();
  // The subscription outlives every conversation-list change; read through a ref.
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  useEffect(() => {
    const buffer = createSupervisorReceiptBuffer();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deliver = async (flush: TeamReceiptFlush): Promise<void> => {
      const conversationId = findPositionConversationId(conversationsRef.current, SUPERVISOR_POSITION_NAME);
      if (!conversationId) return;
      const teams = await Promise.all(
        flush.teams.map(async ({ teamId, completed, failed }) => ({
          teamId,
          name: await resolveTeamName(teamId),
          completed,
          failed,
        }))
      );
      const input = buildReceiptContent({ v: 1, teams, at: flush.at });
      try {
        await ipcBridge.conversation.sendMessage.invoke({ conversation_id: conversationId, input });
      } catch (error) {
        console.warn('[useSupervisorTeamReceipt] delivery failed', error);
      }
    };

    const armTimer = (): void => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const flush = buffer.flush(Date.now());
        if (flush) void deliver(flush);
      }, buffer.windowMs);
    };

    const onRunEvent = (
      event: Parameters<typeof receiptEventFromRunEvent>[0],
      channel: 'completed' | 'failed'
    ): void => {
      const receiptEvent = receiptEventFromRunEvent(event, channel);
      if (!receiptEvent) return;
      if (buffer.push(receiptEvent, Date.now())) armTimer();
    };

    const disposeCompleted = ipcBridge.team.runCompleted.on((event) => onRunEvent(event, 'completed'));
    const disposeFailed = ipcBridge.team.runFailed.on((event) => onRunEvent(event, 'failed'));
    return () => {
      disposeCompleted();
      disposeFailed();
      if (timer) clearTimeout(timer);
    };
  }, []);
};
