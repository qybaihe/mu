/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The context steward's window half: every finished turn of every
 * conversation (the shared WS event, open or not) is offered to the main
 * process, which reads the session's live token count and — only at the
 * check line — asks once and acts. The window filters to the steward's
 * constituency (position/supervisor conversations and team threads carry
 * their markers in `extra`) so ordinary chats never pay the round trip, and
 * writes the ⚡ receipt rows the conversation flow shows. A switch also
 * follows the person: viewing the old part lands in the new one.
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ipcBridge } from '@/common';
import { contextStewardBridge } from '@/common/chat/team/contextSteward/contextStewardBridge';
import type { TChatConversation } from '@/common/config/storage';
import { appendContextStewardNote } from '@renderer/pages/team/core/notes/contextStewardNotes';
import { emitter } from '@renderer/utils/emitter';
import { useConversationHistoryContext } from '@renderer/hooks/context/ConversationHistoryContext';

/** The markers of one conversation's `extra`: undefined when it has none the steward reads, null when the list does not know the conversation at all (too new, or stale). */
const stewardMarkersOf = (
  conversation: TChatConversation | undefined
): { position?: string; teamId?: string } | null | undefined => {
  if (!conversation) return null; // Not in the (possibly stale) list — let the main side decide.
  const extra = conversation.extra as Record<string, unknown> | null | undefined;
  if (!extra) return undefined;
  const position = typeof extra.position === 'string' && extra.position ? extra.position : undefined;
  const teamId = typeof extra.team_id === 'string' && extra.team_id ? extra.team_id : undefined;
  return position || teamId ? { position, teamId } : undefined;
};

export const useContextSteward = (): void => {
  const { conversations } = useConversationHistoryContext();
  // The subscription outlives every list change; read through a ref.
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const navigate = useNavigate();

  useEffect(() => {
    const check = async (conversationId: string): Promise<void> => {
      const markers = stewardMarkersOf(conversationsRef.current.find((item) => item.id === conversationId));
      // A conversation the list KNOWS carries no marker is an ordinary chat — the
      // cheap skip. One the list does not know (just created, or the list lags a
      // beat) still goes to the main side, which reads the conversation itself.
      if (markers === undefined) return;
      const answer = await contextStewardBridge.run.invoke({ conversationId }).catch((): undefined => undefined);
      if (!answer?.ok || !answer.data) return;
      const outcome = answer.data;
      if (outcome.action !== 'compact' && outcome.action !== 'switch') return;
      appendContextStewardNote(conversationId, outcome);
      emitter.emit('chat.history.refresh');
      if (outcome.action === 'switch' && window.location.pathname === `/conversation/${conversationId}`) {
        navigate(`/conversation/${outcome.newConversationId}`);
      }
    };
    return ipcBridge.conversation.turnCompleted.on((event) => {
      // A failed turn decided nothing; its context still grew, but the steward
      // reads state, not intentions — the next finished turn re-offers it.
      if (event.status && event.status !== 'finished') return;
      const conversationId = event.session_id;
      if (!conversationId) return;
      void check(conversationId);
    });
  }, [navigate]);
};
