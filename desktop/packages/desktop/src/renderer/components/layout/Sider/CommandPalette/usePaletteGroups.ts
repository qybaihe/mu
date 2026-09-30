/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSlashCommands } from '@/renderer/hooks/chat/useSlashCommands';
import { useConversationHistoryContext } from '@/renderer/hooks/context/ConversationHistoryContext';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { useNativeConversations, useNativeEnabled } from '@/renderer/pages/native/hooks/useNativeConversations';
import { buildPaletteGroups, type PaletteGroup } from './paletteGroups';

/**
 * `useSlashCommands` fetches once an agent status is known. The palette only lists the commands of the conversation
 * on screen, whose page has already brought its runtime up, so it asks right away and never starts a runtime itself:
 * opening a search box must not wake an agent.
 */
const ASK_NOW = 'palette';
const RUNTIME_ALREADY_UP = (): Promise<void> => Promise.resolve();

/**
 * The palette's groups for a query. The conversations are the sidebar's list; the settings pages are the pages of
 * the settings rail (`SETTINGS_PAGES` in `settingsNav`); the commands are what the harness offers in the open
 * conversation, fetched the way the send box fetches them. Only an ACP conversation's send box takes a command sent from outside (`sendbox.command`), so other
 * conversations list none.
 */
export const usePaletteGroups = (query: string): PaletteGroup[] => {
  const { t, i18n } = useTranslation();
  const { conversations } = useConversationHistoryContext();
  const openConversationId = useCurrentConversation();
  const openConversation = conversations.find((conversation) => conversation.id === openConversationId);
  const commandTarget = openConversation?.type === 'acp' ? openConversation.id : null;
  const commands = useSlashCommands(commandTarget ?? '', {
    conversation_type: openConversation?.type,
    agentStatus: ASK_NOW,
    prepareRuntime: RUNTIME_ALREADY_UP,
  });
  // With the native host on, its conversations are listed too (read when the palette opens, kept as they change).
  const { conversations: nativeConversations } = useNativeConversations(useNativeEnabled() === true);
  // One clock per opening: the relative times do not tick while the palette is open.
  const [now] = useState(() => Date.now());

  return useMemo(
    () =>
      buildPaletteGroups({
        query,
        conversations,
        nativeConversations,
        commandTarget,
        commands,
        t,
        language: i18n.language,
        now,
      }),
    [commandTarget, commands, conversations, i18n.language, nativeConversations, now, query, t]
  );
};
