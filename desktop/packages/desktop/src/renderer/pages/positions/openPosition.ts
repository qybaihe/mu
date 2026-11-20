/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Opening a position's 1:1 conversation from the roster. The pure half: the
 * conversation a position already owns (its `extra.position` marker) and the
 * create parameters for its first open. The effectful half prepares the
 * workspace first — the main process writes the gate file the harness reads
 * when the session's first turn starts, so it must land before the
 * conversation exists — then creates the conversation on the default assistant
 * and lands the app in it. A position keeps one persistent conversation; an
 * existing marker reuses it, so the session's memory survives across chats.
 */
import { Message } from '@arco-design/web-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { findPositionConversationId } from '@/common/chat/team/positions/positionLibraryCore';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import { positionBridge } from '@/common/chat/team/positions/positionBridge';
import type { TChatConversation } from '@/common/config/storage';
import { resolveGuidAssistantDefaults } from '@renderer/pages/guid/utils/assistantDefaults';
import { emitter } from '@renderer/utils/emitter';

export { findPositionConversationId };

/**
 * The assistant's own default model: without one a conversation's runtime cannot start
 * (the backend rejects the ensure with "Provider '' not found"). A failure to
 * resolve it leaves the model unset for the caller to decide.
 */
export async function resolveAssistantModelId(assistantId: string, logName: string): Promise<string | undefined> {
  try {
    const detail = await ipcBridge.assistants.get.invoke({ id: assistantId });
    return detail ? resolveGuidAssistantDefaults(detail).modelId : undefined;
  } catch (error) {
    console.warn('[positions] resolving the assistant model failed for', logName, error);
    return undefined;
  }
}

/** What creating the position conversation asks for: one marker, one workspace, the default assistant and its model. */
export const positionCreateParams = (
  position: PositionInfo,
  workspace: string,
  assistant: { id: string; modelId?: string }
): {
  name: string;
  assistant: { id: string; conversation_overrides?: { model?: string } };
  extra: { workspace: string; custom_workspace: true; position: string };
} => ({
  // The conversation's display name is the position's; the marker stays the id.
  name: position.displayName,
  assistant: {
    id: assistant.id,
    ...(assistant.modelId ? { conversation_overrides: { model: assistant.modelId } } : {}),
  },
  extra: { workspace, custom_workspace: true, position: position.name },
});

/**
 * Opens the position's 1:1 conversation, creating it on first open: prepare
 * workspace → create conversation → refresh the history → navigate. Reuses
 * the position's existing conversation — the persistent session — when there
 * is one. `onError` carries the already-translated message.
 */
export const openPositionConversation = async (
  position: PositionInfo,
  deps: {
    conversations: ReadonlyArray<TChatConversation>;
    assistantId: string | null;
    navigate: (path: string) => void;
    onError: (message: string) => void;
    messages: { noAssistant: string; prepareFailed: string; openFailed: string };
  }
): Promise<void> => {
  const existing = findPositionConversationId(deps.conversations, position.name);
  if (existing) {
    deps.navigate(`/conversation/${existing}`);
    return;
  }
  if (!deps.assistantId) {
    deps.onError(deps.messages.noAssistant);
    return;
  }
  const modelId = await resolveAssistantModelId(deps.assistantId, position.name);

  let workspace: string | undefined;
  try {
    const answer = await positionBridge.ensureWorkspace.invoke({ name: position.name });
    workspace = answer.ok ? answer.data.workspace : undefined;
  } catch (error) {
    console.warn('[positions] preparing the workspace failed for', position.name, error);
  }
  if (!workspace) {
    deps.onError(deps.messages.prepareFailed);
    return;
  }

  let conversationId: string | undefined;
  try {
    const conversation = await ipcBridge.conversation.create.invoke(
      positionCreateParams(position, workspace, { id: deps.assistantId, modelId })
    );
    conversationId = conversation?.id;
  } catch (error) {
    console.warn('[positions] creating the conversation failed for', position.name, error);
  }
  if (!conversationId) {
    deps.onError(deps.messages.openFailed);
    return;
  }
  emitter.emit('chat.history.refresh');
  deps.navigate(`/conversation/${conversationId}`);
};

/** The app-side wrapper: toasts in the app's language, the router's navigate. */
export const useOpenPosition = (conversations: ReadonlyArray<TChatConversation>, assistantId: string | null) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (position: PositionInfo) => {
    void openPositionConversation(position, {
      conversations,
      assistantId,
      navigate: (path) => navigate(path),
      onError: (message) => Message.error(message),
      messages: {
        noAssistant: t('positions.noAssistant'),
        prepareFailed: t('positions.prepareFailed'),
        openFailed: t('positions.openFailed'),
      },
    });
  };
};
