/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The new-group-chat dialog: name the group (or leave it empty and the picked
 * positions name it), pick at least one position from the roster — each
 * becomes one mu slot, the first the lead. Creating seeds the workspace's
 * dispatch rules, renames the threads (the lead is the group chat itself,
 * `测试群（群聊）`; each member thread says whose it is), and registers the
 * group in the shared TEAMS.md index with the lifecycle the dialog picked
 * (days or permanent), so it carries the same reuse semantics as a
 * supervisor-assembled team.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, InputNumber, Message, Select, Switch } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import { supervisorBridge } from '@/common/chat/team/supervisor/supervisorBridge';
import type { TTeam } from '@/common/types/team/teamTypes';
import MuModal from '@renderer/components/base/MuModal';
import { useConversationAssistants } from '@renderer/pages/conversation/hooks/useConversationAssistants';
import { usePositionRoster } from '@renderer/pages/positions/usePositionRoster';
import { getConversationCreateErrorMessage } from '@renderer/pages/conversation/utils/conversationCreateError';
import { selectableAssistants } from '@renderer/utils/model/assistantSelection';
import { ensureTeamDispatchSeeded } from '@renderer/pages/team/core/teamDispatchSeed';
import { TEAM_TTL_MAX_DAYS, TEAM_TTL_MIN_DAYS } from '@/common/chat/team/supervisor/supervisorCore';
import {
  GROUP_NAME_MAX_LENGTH,
  autoGroupName,
  buildGroupChatCreateInput,
  groupChatLifecycle,
  initialGroupChatFormState,
  leadThreadName,
  leadConversationIdOf,
  positionsByIds,
  teammateThreadName,
  validateGroupChatForm,
  type GroupChatFormState,
} from './groupChatCore';

type NewGroupChatModalProps = {
  open: boolean;
  onClose: () => void;
  /** Receives the created team; the sidebar navigates to the lead's conversation. */
  onCreated: (team: TTeam) => void;
};

const NewGroupChatModal: React.FC<NewGroupChatModalProps> = ({ open, onClose, onCreated }) => {
  const { t } = useTranslation();
  const { positions } = usePositionRoster();
  const { presetAssistants } = useConversationAssistants();
  // The mu slot every position becomes: the shared selectable order puts mu first;
  // team capability narrows it. The dialog never offers per-slot agent choice —
  // the full-MU lineup is the rule.
  const assistantId = useMemo(
    () => selectableAssistants(presetAssistants.filter((a) => a.team_selectable))[0]?.id ?? '',
    [presetAssistants]
  );

  const [form, setForm] = useState<GroupChatFormState>(initialGroupChatFormState);
  const [creating, setCreating] = useState(false);

  // A closed dialog forgets its form; the next open starts fresh.
  useEffect(() => {
    if (!open) setForm(initialGroupChatFormState());
  }, [open]);

  const closeAndReset = useCallback(() => {
    setCreating(false);
    setForm(initialGroupChatFormState());
    onClose();
  }, [onClose]);

  const validation = validateGroupChatForm(form);
  const picked = positionsByIds(form.positionIds, positions);
  const resolvedName = form.name.trim() || (picked.length > 0 ? autoGroupName(picked) : '');

  const submit = useCallback(async () => {
    if (creating) return;
    if (validateGroupChatForm(form) !== null) return;
    if (!assistantId) return;
    setCreating(true);
    try {
      const user = await ipcBridge.auth.currentUser.invoke().catch((): undefined => undefined);
      const team = await ipcBridge.team.create.invoke(
        buildGroupChatCreateInput(form, positions, assistantId, user?.id ?? '')
      );
      const groupName = team.name;
      // Seed the workspace's dispatch rules before the first turn can need them;
      // the helper swallows its own failures (the team store retries).
      await ensureTeamDispatchSeeded(team);
      // Name the threads for the sidebar: the lead conversation IS the group
      // chat, each teammate thread says whose it is. A rename must not fail the
      // creation — the team already exists.
      await Promise.allSettled(
        team.assistants.flatMap((agent) => {
          if (!agent.conversation_id) return [];
          const label =
            agent.role === 'leader' ? leadThreadName(groupName) : teammateThreadName(agent.assistant_name, groupName);
          return [
            ipcBridge.conversation.update.invoke({
              id: agent.conversation_id,
              updates: { name: label, name_source: 'user' },
            }),
          ];
        })
      );
      // Register in the shared index: the lifecycle the dialog picked (days,
      // or permanent). A failed registration never fails the creation.
      const leadConversationId = leadConversationIdOf(team);
      if (leadConversationId) {
        await supervisorBridge.registerTeam
          .invoke({
            name: groupName,
            positions: positionsByIds(form.positionIds, positions).map((position) => position.name),
            teamId: team.id,
            leadConversationId,
            ...groupChatLifecycle(form),
          })
          .catch((): undefined => undefined);
      }
      onCreated(team);
      closeAndReset();
    } catch (error) {
      console.error('[NewGroupChatModal] create failed', error);
      Message.error(
        getConversationCreateErrorMessage(error, t, (detail) => t('team.groupChat.errorWithDetail', { error: detail }))
      );
      setCreating(false);
    }
  }, [assistantId, closeAndReset, creating, form, onCreated, positions, t]);

  return (
    <MuModal
      variant='standard'
      header={{ title: t('team.groupChat.title'), subtitle: t('team.groupChat.subtitle'), showClose: true }}
      visible={open}
      onCancel={creating ? undefined : closeAndReset}
      className='w-[min(520px,calc(100vw-32px))] max-w-520px'
      footer={{
        divider: true,
        render: () => (
          <div className='flex justify-end gap-10px'>
            <Button
              onClick={creating ? undefined : closeAndReset}
              className='px-20px min-w-80px'
              style={{ borderRadius: 8 }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              data-testid='new-group-chat-submit'
              type='primary'
              loading={creating}
              disabled={validation !== null || !assistantId}
              onClick={() => void submit()}
              className='px-20px min-w-80px'
              style={{ borderRadius: 8 }}
            >
              {t('team.groupChat.submit')}
            </Button>
          </div>
        ),
      }}
      unmountOnExit
    >
      <div className='flex flex-col gap-16px' data-testid='new-group-chat-form'>
        <div>
          <div className='mb-6px text-13px font-500 text-t-primary'>{t('team.groupChat.nameLabel')}</div>
          <Input
            data-testid='new-group-chat-name'
            aria-label={t('team.groupChat.nameLabel')}
            value={form.name}
            maxLength={GROUP_NAME_MAX_LENGTH}
            placeholder={t('team.groupChat.namePlaceholder')}
            onChange={(value) => setForm((prev) => ({ ...prev, name: value }))}
          />
          <div className='mt-4px text-12px text-t-tertiary'>
            {resolvedName ? t('team.groupChat.namePreview', { name: resolvedName }) : t('team.groupChat.nameAutoHint')}
          </div>
        </div>

        <div>
          <div className='mb-6px text-13px font-500 text-t-primary'>{t('team.groupChat.positionsLabel')}</div>
          <Select
            className='w-full'
            mode='multiple'
            data-testid='new-group-chat-positions'
            aria-label={t('team.groupChat.positionsLabel')}
            value={form.positionIds}
            placeholder={t('team.groupChat.positionsPlaceholder')}
            onChange={(value) => setForm((prev) => ({ ...prev, positionIds: (value ?? []) as string[] }))}
          >
            {positions.map((position) => (
              <Select.Option key={position.name} value={position.name}>
                <div className='flex items-center min-w-0'>
                  <span className='truncate'>{position.displayName}</span>
                </div>
              </Select.Option>
            ))}
          </Select>
          <div className='mt-4px text-12px text-t-tertiary'>{t('team.groupChat.positionsHint')}</div>
        </div>

        <div>
          <div className='mb-6px text-13px font-500 text-t-primary'>{t('team.groupChat.lifecycleLabel')}</div>
          <div className='flex items-center gap-10px'>
            <InputNumber
              data-testid='new-group-chat-ttl'
              aria-label={t('team.groupChat.lifecycleDays')}
              value={form.ttlDays}
              min={TEAM_TTL_MIN_DAYS}
              max={TEAM_TTL_MAX_DAYS}
              step={1}
              precision={0}
              disabled={form.permanent}
              onChange={(value) =>
                setForm((prev) => ({ ...prev, ttlDays: typeof value === 'number' ? value : prev.ttlDays }))
              }
            />
            <span className='text-13px text-t-secondary shrink-0'>{t('team.groupChat.lifecycleDays')}</span>
            <span className='flex-1' />
            <Switch
              data-testid='new-group-chat-permanent'
              aria-label={t('team.groupChat.lifecyclePermanent')}
              size='small'
              checked={form.permanent}
              onChange={(checked) => setForm((prev) => ({ ...prev, permanent: checked }))}
            />
            <span className='text-13px text-t-secondary shrink-0'>{t('team.groupChat.lifecyclePermanent')}</span>
          </div>
          <div className='mt-4px text-12px text-t-tertiary'>{t('team.groupChat.lifecycleHint')}</div>
        </div>

        {validation !== null ? (
          <div data-testid='new-group-chat-error' className='text-12px text-[rgb(var(--danger-6))]'>
            {t(`team.groupChat.errors.${validation}`)}
          </div>
        ) : null}
      </div>
    </MuModal>
  );
};

export default NewGroupChatModal;
