/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Opening the supervisor's 1:1 conversation. The supervisor is the built-in
 * position that assembles and reuses temporary teams; its workspace carries
 * the injected rules, the teams.cjs script, and the TEAMS.md index, so — as
 * with a library position — the main process prepares the workspace before
 * the conversation exists, and the conversation binds to the position by its
 * `extra.position` marker (`findPositionConversationId`, the T1 seam). The
 * display name is the app's label, not the marker: the roster row says 主管,
 * the marker stays the stable ASCII identity.
 */
import { Message } from '@arco-design/web-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { SUPERVISOR_POSITION_NAME } from '@/common/chat/supervisor/supervisorCore';
import { supervisorBridge } from '@/common/chat/supervisor/supervisorBridge';
import { findPositionConversationId, resolveAssistantModelId } from '@renderer/pages/positions/openPosition';
import type { TChatConversation } from '@/common/config/storage';
import { emitter } from '@renderer/utils/emitter';

/** The create call: the app's label as the name, the marker as the position. */
export const supervisorCreateParams = (
  label: string,
  workspace: string,
  assistant: { id: string; modelId?: string }
): {
  name: string;
  assistant: { id: string; conversation_overrides?: { model?: string } };
  extra: { workspace: string; custom_workspace: true; position: string };
} => ({
  name: label,
  assistant: {
    id: assistant.id,
    ...(assistant.modelId ? { conversation_overrides: { model: assistant.modelId } } : {}),
  },
  extra: { workspace, custom_workspace: true, position: SUPERVISOR_POSITION_NAME },
});

/**
 * Opens the supervisor's conversation, creating it on first open: prepare
 * workspace → create conversation → refresh the history → navigate. Reuses
 * the supervisor's existing conversation — the persistent session — when
 * there is one. `onError` carries the already-translated message.
 */
export const openSupervisorConversation = async (deps: {
  conversations: ReadonlyArray<TChatConversation>;
  label: string;
  assistantId: string | null;
  navigate: (path: string) => void;
  onError: (message: string) => void;
  messages: { noAssistant: string; prepareFailed: string; openFailed: string };
}): Promise<void> => {
  const existing = findPositionConversationId(deps.conversations, SUPERVISOR_POSITION_NAME);
  if (existing) {
    deps.navigate(`/conversation/${existing}`);
    return;
  }
  if (!deps.assistantId) {
    deps.onError(deps.messages.noAssistant);
    return;
  }

  let workspace: string | undefined;
  try {
    const answer = await supervisorBridge.ensure.invoke();
    workspace = answer.ok ? answer.data.workspace : undefined;
  } catch (error) {
    console.warn('[supervisor] preparing the workspace failed', error);
  }
  if (!workspace) {
    deps.onError(deps.messages.prepareFailed);
    return;
  }
  const modelId = await resolveAssistantModelId(deps.assistantId, SUPERVISOR_POSITION_NAME);

  let conversationId: string | undefined;
  try {
    const conversation = await ipcBridge.conversation.create.invoke(
      supervisorCreateParams(deps.label, workspace, { id: deps.assistantId, modelId })
    );
    conversationId = conversation?.id;
  } catch (error) {
    console.warn('[supervisor] creating the conversation failed', error);
  }
  if (!conversationId) {
    deps.onError(deps.messages.openFailed);
    return;
  }
  emitter.emit('chat.history.refresh');
  deps.navigate(`/conversation/${conversationId}`);
};

/** The app-side wrapper: toasts in the app's language, the router's navigate. */
export const useOpenSupervisor = (conversations: ReadonlyArray<TChatConversation>, assistantId: string | null) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return () => {
    void openSupervisorConversation({
      conversations,
      label: t('supervisor.conversationName'),
      assistantId,
      navigate: (path) => navigate(path),
      onError: (message) => Message.error(message),
      messages: {
        noAssistant: t('supervisor.noAssistant'),
        prepareFailed: t('supervisor.prepareFailed'),
        openFailed: t('supervisor.openFailed'),
      },
    });
  };
};
