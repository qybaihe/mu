/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Layout-level wiring of the changed-files notes: team run events flow in,
 * the controller (core/notes/teamChangedFileNotes.ts) decides when a run's
 * write/edit rows are read back and noted. Mounted once, in the Layout, so a
 * run's files are noted whether or not the group chat is open — the note is
 * waiting when the conversation is next opened. Best-effort throughout, like
 * the receipt and notification chains it sits beside: a team that vanished or
 * a conversation that will not read simply yields no note.
 */
import { useEffect } from 'react';
import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import { loadConversationMessagePage } from '@renderer/utils/chat/messagePagination';
import {
  appendTeamChangedFilesNote,
  createTeamChangedFilesController,
  lastChangedFilesNoteAtOf,
  type ChangedFilesTeamShape,
} from '@renderer/pages/team/core/notes/teamChangedFileNotes';

/** How many pages of one conversation one aggregation reads (newest first). */
const ROW_PAGES = 2;
const ROW_PAGE_LIMIT = 200;

/** The team's conversations: the lead's (the group chat) and every member's. */
const teamConversationsOf = async (teamId: string): Promise<ChangedFilesTeamShape | undefined> => {
  try {
    const team = await ipcBridge.team.get.invoke({ id: teamId });
    if (!team?.assistants?.length) return undefined;
    // The lead by its slot id, not its role string: the wire says `lead`, the
    // type says `leader`, and both have been seen.
    const lead = team.assistants.find(
      (assistant) => team.leader_assistant_id && assistant.slot_id === team.leader_assistant_id
    );
    const ids = team.assistants.map((assistant) => assistant.conversation_id).filter((id) => typeof id === 'string');
    if (!lead?.conversation_id) return undefined;
    return { leadConversationId: lead.conversation_id, conversationIds: ids };
  } catch {
    return undefined;
  }
};

/** The conversation's stored rows, newest last, capped at two pages. */
const loadRows = async (conversationId: string): Promise<readonly TMessage[]> => {
  const latest = await loadConversationMessagePage(conversationId, { limit: ROW_PAGE_LIMIT, contentMode: 'compact' });
  if (!latest.has_more_before || !latest.oldest_cursor) return latest.items;
  const older = await loadConversationMessagePage(conversationId, {
    limit: ROW_PAGE_LIMIT,
    before: latest.oldest_cursor,
    contentMode: 'compact',
  });
  return [...older.items, ...latest.items];
};

/** Wires the changed-files controller to the team run events. No UI of its own. */
export const useTeamChangedFilesNotes = (): void => {
  useEffect(() => {
    const controller = createTeamChangedFilesController({
      now: () => Date.now(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      loadRows,
      teamConversationsOf,
      appendNote: appendTeamChangedFilesNote,
      lastNoteAtOf: lastChangedFilesNoteAtOf,
    });
    const disposeAccepted = ipcBridge.team.runAccepted.on((event) => controller.onRunAccepted(event));
    const disposeStarted = ipcBridge.team.runStarted.on((event) => controller.onRunStarted(event));
    const disposeCompleted = ipcBridge.team.runCompleted.on((event) => controller.onRunCompleted(event));
    return () => {
      disposeAccepted();
      disposeStarted();
      disposeCompleted();
    };
  }, []);
};
