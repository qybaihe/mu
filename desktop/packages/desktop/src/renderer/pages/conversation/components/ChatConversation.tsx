/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ChatFileRef } from '@/common/types/chatFile';
import { quickDecisionBridge } from '@/common/chat/team/quickDecision/quickDecisionBridge';
import { appendQuickDecisionNote } from '@renderer/pages/team/core/notes/quickDecisionNotes';
import type { IConversationMcpStatus, IProvider, TChatConversation, TProviderWithModel } from '@/common/config/storage';
import { uuid } from '@/common/utils';
import addChatIcon from '@/renderer/assets/icons/add-chat.svg';
import { CronJobManager } from '@/renderer/pages/cron';
import { resolveCronJobId } from '@/renderer/pages/cron/cronUtils';
import { classifyConfigSetError, useAcpConfigOptions } from '@/renderer/hooks/agent/useAcpConfigOptions';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { usePresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { iconColors } from '@/renderer/styles/colors';
import { Button, Dropdown, Menu, Message, Tooltip, Typography } from '@arco-design/web-react';
import { History } from '@icon-park/react';
import React, { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { emitter } from '../../../utils/emitter';
import AcpChat from '../platforms/acp/AcpChat';
import ImportedChatNotice from '../platforms/acp/ImportedChat';
import { importMarkOf } from '@/common/kyrn/importChats';
import ChatLayout from './ChatLayout';
import ChatSlider from './ChatSlider.tsx';
import AcpRuntimeRestartButton from '@/renderer/components/agent/AcpRuntimeRestartButton';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { getConversationCreateErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import BuiltinAgentChat from '../platforms/builtinAgent/BuiltinAgentChat';
import BuiltinAgentModelSelector from '../platforms/builtinAgent/BuiltinAgentModelSelector';
import { useBuiltinAgentModelSelection } from '../platforms/builtinAgent/useBuiltinAgentModelSelection';
import { useConversationRuntimeView } from '../runtime/useConversationRuntimeView';
import { isLegacyReadOnlyConversationType } from '../utils/conversationRuntime';
import { resolveConversationBackend } from '../utils/conversationAssistantIdentity';
import LegacyReadOnlyConversation from '../platforms/legacy/LegacyReadOnlyConversation';
import SingleChatEmptyState from './SingleChatEmptyState';
import TeamChatSearch from './TeamChatSearch';
import TeamHeaderIdentity from '@renderer/pages/team/components/TeamHeaderIdentity';
import { stripGroupChatMarker } from '@renderer/pages/team/core/teamIdentity';
import { useActiveLease } from '../hooks/useActiveLease';
import { BUILTIN_AGENT, type BuiltinAgent } from '@/common/platform/backendNames';
// import SkillRuleGenerator from './components/SkillRuleGenerator'; // Temporarily hidden

const configErrorMessageKey = (error: unknown) => {
  const errorKind = classifyConfigSetError(error);
  if (errorKind === 'command_ack') return 'agent.config.commandAck';
  if (errorKind === 'confirmation_timeout') return 'agent.config.timeout';
  if (errorKind === 'config_update_in_progress') return 'agent.config.busy';
  return 'agent.config.failed';
};

const _AssociatedConversation: React.FC<{ conversation_id: string }> = ({ conversation_id }) => {
  const { data } = useSWR(['getAssociateConversation', conversation_id], () =>
    ipcBridge.conversation.getAssociateConversation.invoke({ conversation_id })
  );
  const navigate = useNavigate();
  const list = useMemo(() => {
    if (!data?.length) return [];
    return data.filter((conversation) => conversation.id !== conversation_id);
  }, [data]);
  if (!list.length) return null;
  return (
    <Dropdown
      droplist={
        <Menu
          onClickMenuItem={(key) => {
            Promise.resolve(navigate(`/conversation/${key}`)).catch((error) => {
              console.error('Navigation failed:', error);
            });
          }}
        >
          {list.map((conversation) => {
            return (
              <Menu.Item key={conversation.id}>
                <Typography.Ellipsis className={'max-w-300px'}>{conversation.name}</Typography.Ellipsis>
              </Menu.Item>
            );
          })}
        </Menu>
      }
      trigger={['click']}
    >
      <Button
        size='mini'
        icon={
          <History
            theme='filled'
            size='14'
            fill={iconColors.primary}
            strokeWidth={2}
            strokeLinejoin='miter'
            strokeLinecap='square'
          />
        }
      ></Button>
    </Dropdown>
  );
};

const _AddNewConversation: React.FC<{ conversation: TChatConversation }> = ({ conversation }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isCreatingRef = useRef(false);
  if (!conversation.extra?.workspace) return null;
  return (
    <Tooltip content={t('conversation.workspace.createNewConversation')}>
      <Button
        size='mini'
        icon={
          <img
            src={addChatIcon}
            alt={t('conversation.workspace.createNewConversation')}
            className='w-14px h-14px block m-auto'
          />
        }
        onClick={async () => {
          if (isCreatingRef.current) return;
          isCreatingRef.current = true;
          try {
            const id = uuid();
            // Fetch latest conversation from DB to ensure session_mode is current
            const latest = await getConversationOrNull(conversation.id);
            const source = latest || conversation;
            await ipcBridge.conversation.createWithConversation.invoke({
              conversation: {
                ...source,
                id,
                created_at: Date.now(),
                modified_at: Date.now(),
                // Clear ACP session fields to prevent new conversation from inheriting old session context
                extra:
                  // Antigravity stores its resume anchor in the same fields, so
                  // it must be cleared too — otherwise the clone resumes the
                  // source conversation's agy session instead of starting clean.
                  source.type === 'acp' || source.type === 'antigravity'
                    ? { ...source.extra, acp_session_id: undefined, acp_session_updated_at: undefined }
                    : source.extra,
              } as TChatConversation,
            });
            void navigate(`/conversation/${id}`);
            emitter.emit('chat.history.refresh');
          } catch (error) {
            console.error('Failed to create conversation:', error);
            Message.error(getConversationCreateErrorMessage(error, t));
          } finally {
            isCreatingRef.current = false;
          }
        }}
      />
    </Tooltip>
  );
};

type BuiltinAgentConversation = Extract<TChatConversation, { type: BuiltinAgent }>;

const BuiltinAgentConversationPanel: React.FC<{
  conversation: BuiltinAgentConversation;
  sliderTitle: React.ReactNode;
}> = ({ conversation, sliderTitle }) => {
  const runtimeView = useConversationRuntimeView(conversation.id);
  const onSelectModel = useCallback(
    async (_provider: IProvider, modelName: string) => {
      const selected = { ..._provider, use_model: modelName } as TProviderWithModel;
      // Kill running agent on model switch — will be rebuilt with new model on next message
      if (runtimeView.activeTurnId) {
        const result = await ipcBridge.conversation.stop.invoke({
          conversation_id: conversation.id,
          turn_id: runtimeView.activeTurnId,
        });
        runtimeView.markStopAcknowledged(runtimeView.activeTurnId, result.runtime);
      }
      const ok = await ipcBridge.conversation.update.invoke({ id: conversation.id, updates: { model: selected } });
      return Boolean(ok);
    },
    [conversation.id, runtimeView]
  );

  const modelSelection = useBuiltinAgentModelSelection({
    initialModel: conversation.model,
    onSelectModel,
  });
  // Project conversations get the Layout-level Explorer column (stage3 FULL);
  // ChatLayout's own right sider is only for no-project (legacy tree), so it does
  // not double up or reserve an empty column.
  const workspaceEnabled = Boolean(conversation.extra?.workspace) && !conversation.project_id;
  const cronJobId = resolveCronJobId(conversation.extra);
  const { info: presetAssistantInfo } = usePresetAssistantInfo(conversation);
  const builtinAgentAssistantId = presetAssistantInfo?.assistantId;
  const layout = useLayoutContext();
  // Mobile: model selection moved into the sendbox `+` action sheet to free up
  // header space; the dropdown stays available on desktop and tablets ≥768px.
  const isMobile = Boolean(layout?.isMobile);
  const { t } = useTranslation();
  const runtimeConfig = useAcpConfigOptions({
    conversation_id: conversation.id,
    enabled: !isMobile,
  });
  const handleThoughtLevelSetOption = useCallback(
    async (optionId: string, value: string) => {
      try {
        const result = await runtimeConfig.setConfigOption(optionId, value);
        Message.success(t('agent.thoughtLevel.switchSuccess'));
        return result;
      } catch (error) {
        Message.error(t(configErrorMessageKey(error)));
        throw error;
      }
    },
    [runtimeConfig, t]
  );

  const chatLayoutProps = {
    title: conversation.name,
    siderTitle: sliderTitle,
    sider: <ChatSlider conversation={conversation} />,
    headerExtra: (
      <div className='flex items-center gap-8px'>
        <CronJobManager conversation_id={conversation.id} cron_job_id={cronJobId} />
        {!isMobile && (
          <BuiltinAgentModelSelector
            selection={modelSelection}
            thoughtLevel={runtimeConfig.thoughtLevel}
            setStatus={runtimeConfig.setStatus}
            onSetThoughtLevel={handleThoughtLevelSetOption}
          />
        )}
      </div>
    ),
    workspaceEnabled,
    // The Layout's work panel holds preview, files and the kernel tabs for every
    // conversation (structurally persistent across conversation switches — no
    // remount). ChatLayout then renders chat only.
    panelHosted: true,
    workspacePath: conversation.extra?.workspace,
    // Key the workspace-panel collapse preference per-project (falls back to
    // conversation_id inside ChatLayout when there is no project) so the panel's
    // open/closed state restores when switching conversations within a project.
    workspacePreferenceKey: conversation.project_id,
    isTemporaryWorkspace: (conversation.extra as { is_temporary_workspace?: boolean } | undefined)
      ?.is_temporary_workspace,
    backend: BUILTIN_AGENT,
    presetAssistant: presetAssistantInfo ? { ...presetAssistantInfo, id: builtinAgentAssistantId } : undefined,
  };

  const emptySlot = (
    <SingleChatEmptyState
      conversation_id={conversation.id}
      assistant_name={presetAssistantInfo?.name}
      assistant_backend={presetAssistantInfo?.backend}
    />
  );

  return (
    <ChatLayout {...chatLayoutProps} conversation_id={conversation.id}>
      <BuiltinAgentChat
        conversation_id={conversation.id}
        workspace={conversation.extra.workspace}
        emptySlot={emptySlot}
        modelSelection={modelSelection}
        session_mode={conversation.extra?.session_mode}
        cron_job_id={cronJobId}
        positionMarker={(conversation.extra as { position?: string } | undefined)?.position}
        loadedSkills={(conversation.extra as { skills?: string[] } | undefined)?.skills}
        loadedMcpServers={(conversation.extra as { mcp_servers?: string[] } | undefined)?.mcp_servers}
        loadedMcpStatuses={
          (conversation.extra as { mcp_statuses?: IConversationMcpStatus[] } | undefined)?.mcp_statuses
        }
        agent_name={presetAssistantInfo?.name}
        assistantId={builtinAgentAssistantId}
        forkCapability={conversation.fork_capability}
      />
    </ChatLayout>
  );
};

/**
 * The header's restart button for an ACP conversation. It waits, disabled, until the runtime has answered for its
 * options once: restarting a runtime that is still starting would only start it twice. The model and thinking level
 * live in the composer's chip, so the header carries no picker of its own.
 */
const AcpHeaderRestartButton: React.FC<{ conversation_id: string }> = ({ conversation_id }) => {
  const { isRuntimeReady } = useAcpConfigOptions({ conversation_id });
  return (
    <AcpRuntimeRestartButton
      conversation_id={conversation_id}
      availability={isRuntimeReady ? 'ready' : 'initializing'}
    />
  );
};

const ChatConversation: React.FC<{
  conversation?: TChatConversation;
  hideSendBox?: boolean;
}> = ({ conversation, hideSendBox }) => {
  const { t } = useTranslation();
  useActiveLease({ type: 'conversation', id: conversation?.id });
  const workspaceEnabled = Boolean(conversation?.extra?.workspace) && !conversation?.project_id;
  const cronJobId = resolveCronJobId(conversation?.extra);
  // A conversation owned by a team never sends through the ordinary route:
  // the backend rejects that with FORBIDDEN. The lead addresses the whole
  // team; a teammate slot is addressed directly.
  const teamExtra = (conversation?.extra ?? {}) as { teamId?: string; slot_id?: string; role?: string };
  const teamId = teamExtra.teamId;
  const teamSlotId = teamExtra.slot_id;
  const teamRole = teamExtra.role;
  const teamSendMessage = useMemo(() => {
    if (!teamId) return undefined;
    return async ({ input, files }: { input: string; files: ChatFileRef[] }) => {
      if (teamRole === 'lead' || !teamSlotId) {
        // The group-chat routing short-circuit: a whole-team send with no
        // attachments and no slash command may be one the message itself
        // addresses to a single teammate (「货代，继续查」). The decision layer
        // delivers such a message to that member's slot directly and answers
        // `direct` — every doubt answers `full` and the whole-team send runs
        // unchanged. The layer must never break a send.
        if (files.length === 0 && input.trim().length > 0 && !input.trimStart().startsWith('/')) {
          try {
            const routed = await quickDecisionBridge.routeTeamMessage.invoke({ input, teamId });
            const verdict = routed.ok ? routed.data : undefined;
            if (verdict?.action === 'direct') {
              appendQuickDecisionNote(conversation.id, input, verdict);
              emitter.emit('chat.history.refresh');
              return;
            }
          } catch {
            // An unreachable decision layer is the ordinary whole-team send.
          }
        }
        await ipcBridge.team.sendMessage.invoke({ team_id: teamId, input, files });
        return;
      }
      await ipcBridge.team.sendMessageToAgent.invoke({ team_id: teamId, slot_id: teamSlotId, input, files });
    };
  }, [teamId, teamRole, teamSlotId, conversation?.id]);
  const layout = useLayoutContext();
  const isMobile = Boolean(layout?.isMobile);

  const isBuiltinAgentConversation = conversation?.type === BUILTIN_AGENT;
  const isLegacyReadOnlyConversation = isLegacyReadOnlyConversationType(conversation?.type);
  const resolvedHideSendBox = hideSendBox || isLegacyReadOnlyConversationType(conversation?.type);

  // 使用统一的 Hook 获取预设助手信息（ACP/Codex 会话）
  // Use unified hook for preset assistant info (ACP/Codex conversations)
  const acpConversation = isBuiltinAgentConversation ? undefined : conversation;
  const { info: presetAssistantInfo, isLoading: isLoadingPreset } = usePresetAssistantInfo(acpConversation);
  const acpAssistantId = presetAssistantInfo?.assistantId;
  const resolvedConversationBackend = resolveConversationBackend(conversation, presetAssistantInfo?.backend);

  const conversationAgentName = (conversation?.extra as { agent_name?: string } | undefined)?.agent_name;
  const assistantDisplayName = presetAssistantInfo?.name || conversationAgentName;

  const conversationNode = useMemo(() => {
    if (!conversation || isBuiltinAgentConversation) return null;
    // A conversation made from a Claude Code, Codex or ZCode conversation says so where a new one greets, then stays
    // above its first message.
    const imported = importMarkOf(conversation.extra);
    // Greeting shown while the conversation has no messages yet (freshly created
    // or cloned window). Each *Chat forwards it to MessageList's empty slot.
    const emptySlot = imported ? (
      <ImportedChatNotice conversationId={conversation.id} mark={imported} />
    ) : (
      <SingleChatEmptyState
        conversation_id={conversation.id}
        assistant_name={assistantDisplayName}
        assistant_backend={resolvedConversationBackend}
      />
    );
    const headerSlot = imported ? <ImportedChatNotice conversationId={conversation.id} mark={imported} inline /> : null;
    if (isLegacyReadOnlyConversation) {
      return <LegacyReadOnlyConversation key={conversation.id} conversation={conversation} emptySlot={emptySlot} />;
    }
    switch (conversation.type) {
      case 'acp':
      // Antigravity reports its own conversation type but renders through the
      // ACP chat surface: same extra payload, same event stream, same send box.
      // Without this case it falls to `default: null` — the chat area renders
      // empty, no send box mounts, and the queued initial message in
      // `acp_initial_message_<id>` is never delivered, so the turn never starts.
      case 'antigravity':
        return (
          <AcpChat
            key={conversation.id}
            conversation_id={conversation.id}
            workspace={conversation.extra?.workspace}
            backend={resolvedConversationBackend || 'claude'}
            session_mode={conversation.extra?.session_mode}
            agent_name={assistantDisplayName}
            cron_job_id={cronJobId}
            hideSendBox={resolvedHideSendBox}
            emptySlot={emptySlot}
            headerSlot={headerSlot}
            teamSendMessage={teamSendMessage}
            positionMarker={(conversation.extra as { position?: string } | undefined)?.position}
            loadedSkills={(conversation.extra as { skills?: string[] } | undefined)?.skills}
            loadedMcpServers={(conversation.extra as { mcp_servers?: string[] } | undefined)?.mcp_servers}
            loadedMcpStatuses={
              (conversation.extra as { mcp_statuses?: IConversationMcpStatus[] } | undefined)?.mcp_statuses
            }
            assistantId={acpAssistantId}
            forkCapability={conversation.fork_capability}
            promptCapability={conversation.prompt_capability}
          ></AcpChat>
        );
      default:
        return null;
    }
  }, [
    conversation,
    isBuiltinAgentConversation,
    isLegacyReadOnlyConversation,
    resolvedConversationBackend,
    assistantDisplayName,
    cronJobId,
    resolvedHideSendBox,
    acpAssistantId,
  ]);

  const sliderTitle = useMemo(() => {
    return (
      <div className='flex items-center justify-between'>
        <span className='text-16px font-bold text-t-primary'>{t('conversation.workspace.title')}</span>
      </div>
    );
  }, [t]);

  if (conversation && conversation.type === BUILTIN_AGENT) {
    return (
      <BuiltinAgentConversationPanel key={conversation.id} conversation={conversation} sliderTitle={sliderTitle} />
    );
  }

  // 如果有预设助手信息，使用预设助手的 logo 和名称；加载中时不进入 fallback；否则使用 backend 的 logo
  // If preset assistant info exists, use preset logo/name; while loading, avoid fallback; otherwise use backend logo
  const chatLayoutProps = presetAssistantInfo
    ? {
        presetAssistant: { ...presetAssistantInfo, id: acpAssistantId },
      }
    : isLoadingPreset
      ? {} // Still loading custom agents — avoid showing backend logo prematurely
      : {
          backend: resolvedConversationBackend,
          agent_name: conversationAgentName,
        };

  // The group conversation's own search lives in its header; teammate
  // conversations keep the plain header (their flow is a private thread).
  const groupTeamId = teamExtra.teamId && teamExtra.role === 'lead' ? teamExtra.teamId : undefined;
  // A team conversation carries its team's identity in place of the agent
  // logo — the member strip and the pill that says which kind of thread this
  // is. The lead's title drops the “（群聊）” marker: the pill already says it.
  const teamIdentity = teamId ? <TeamHeaderIdentity teamId={teamId} role={teamRole} /> : undefined;
  const displayedTitle =
    teamId && teamRole === 'lead' && conversation ? stripGroupChatMarker(conversation.name) : conversation?.name;

  const headerExtraNode = (
    <div className='flex items-center gap-8px'>
      {groupTeamId ? <TeamChatSearch teamId={groupTeamId} /> : null}
      {conversation && (
        <div className='shrink-0'>
          <CronJobManager conversation_id={conversation.id} cron_job_id={cronJobId} />
        </div>
      )}
      {conversation && conversation.type === 'acp' && !isMobile && !isLegacyReadOnlyConversation && (
        <div className='shrink-0'>
          <AcpHeaderRestartButton key={conversation.id} conversation_id={conversation.id} />
        </div>
      )}
    </div>
  );

  return (
    <ChatLayout
      title={displayedTitle}
      {...chatLayoutProps}
      headerLeading={teamIdentity}
      headerExtra={headerExtraNode}
      siderTitle={sliderTitle}
      sider={<ChatSlider conversation={conversation} />}
      workspaceEnabled={workspaceEnabled}
      panelHosted
      workspacePath={conversation?.extra?.workspace}
      workspacePreferenceKey={conversation?.project_id}
      isTemporaryWorkspace={
        (conversation?.extra as { is_temporary_workspace?: boolean } | undefined)?.is_temporary_workspace
      }
      conversation_id={conversation?.id}
    >
      {conversationNode}
    </ChatLayout>
  );
};

export default ChatConversation;
