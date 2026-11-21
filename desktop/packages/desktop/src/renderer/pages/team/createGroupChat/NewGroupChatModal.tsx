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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, InputNumber, Message, Radio, Select, Switch } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import { supervisorBridge } from '@/common/chat/team/supervisor/supervisorBridge';
import type { TTeam } from '@/common/types/team/teamTypes';
import MuModal from '@renderer/components/base/MuModal';
import { useConversationAssistants } from '@renderer/pages/conversation/hooks/useConversationAssistants';
import { usePositionRoster } from '@renderer/pages/positions/usePositionRoster';
import { getConversationCreateErrorMessage } from '@renderer/pages/conversation/utils/conversationCreateError';
import { selectableAssistants } from '@renderer/utils/model/assistantSelection';
import { ensureTeamDispatchSeeded } from '@renderer/pages/team/core/teamDispatchSeed';
import RecipePanel, { type RecipeGroupPlan } from '@renderer/pages/team/createGroupChat/RecipePanel';
import { applySlotThinkingLevels } from '@renderer/pages/team/createGroupChat/applySlotThinking';
import { applySlotModels } from '@renderer/pages/team/createGroupChat/applySlotModels';
import { TEAM_TTL_MAX_DAYS, TEAM_TTL_MIN_DAYS } from '@/common/chat/team/supervisor/supervisorCore';
import {
  GROUP_NAME_MAX_LENGTH,
  MAX_GROUP_POSITIONS,
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
  // the full-MU lineup is the rule. The kept assistant also names the models
  // the per-seat model dropdowns offer (the agent's own configured list).
  const assistant = useMemo(
    () => selectableAssistants(presetAssistants.filter((a) => a.team_selectable))[0],
    [presetAssistants]
  );
  const assistantId = assistant?.id ?? '';
  const offeredModels = assistant?.models ?? [];

  const [form, setForm] = useState<GroupChatFormState>(initialGroupChatFormState);
  const [creating, setCreating] = useState(false);
  // Recipe mode: the panel picks the seats; manual mode keeps the form's
  // multi-select. The plan rides in a ref too — the panel hands the final
  // version over a callback, and the submit must read that exact one.
  const [mode, setMode] = useState<'manual' | 'recipe'>('manual');
  const [plan, setPlan] = useState<RecipeGroupPlan | null>(null);
  const planRef = useRef<RecipeGroupPlan | null>(null);

  // A closed dialog forgets its form; the next open starts fresh.
  useEffect(() => {
    if (open) return;
    setForm(initialGroupChatFormState());
    setMode('manual');
    setPlan(null);
    planRef.current = null;
  }, [open]);

  const closeAndReset = useCallback(() => {
    setCreating(false);
    setForm(initialGroupChatFormState());
    onClose();
  }, [onClose]);

  const validation =
    mode === 'manual'
      ? validateGroupChatForm(form)
      : plan === null
        ? 'recipeNoPlan'
        : plan.positionIds.length === 0
          ? 'noPositions'
          : plan.positionIds.length > MAX_GROUP_POSITIONS
            ? 'tooManyPositions'
            : null;
  const seatIds = mode === 'recipe' ? (plan?.positionIds ?? []) : form.positionIds;
  const picked = positionsByIds(seatIds, positions);
  const resolvedName = form.name.trim() || (picked.length > 0 ? autoGroupName(picked) : '');

  const submit = useCallback(
    async (recipePlan?: RecipeGroupPlan | null) => {
      if (creating) return;
      const effectivePlan = recipePlan ?? planRef.current;
      const ids = effectivePlan ? effectivePlan.positionIds : form.positionIds;
      if (ids.length === 0 || ids.length > MAX_GROUP_POSITIONS) return;
      if (!assistantId) return;
      setCreating(true);
      try {
        // The recipe path may carry seats the dialog's roster snapshot does
        // not know yet (it was created moments ago): the plan's own seat
        // entries fill the gaps before the create call looks anyone up.
        const rosterForCreate = [...positions];
        if (effectivePlan) {
          for (const seat of effectivePlan.seatInfos) {
            if (!rosterForCreate.some((position) => position.name === seat.name)) rosterForCreate.push(seat);
          }
        }
        const user = await ipcBridge.auth.currentUser.invoke().catch((): undefined => undefined);
        const team = await ipcBridge.team.create.invoke(
          buildGroupChatCreateInput({ ...form, positionIds: ids }, rosterForCreate, assistantId, user?.id ?? '')
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
              positions: positionsByIds(ids, rosterForCreate).map((position) => position.name),
              teamId: team.id,
              leadConversationId,
              ...groupChatLifecycle(form),
            })
            .catch((): undefined => undefined);
        }
        // A recipe's declared tiers ride the fresh seats, best-effort (a
        // dormant teammate keeps its model's start level until its first task).
        if (effectivePlan) await applySlotThinkingLevels(team, effectivePlan.thinkingBySeat);
        // The seats' picked models ride along the same way: config-options
        // first, the agent route for a slot the conversation one cannot reach.
        const seatModels = effectivePlan ? effectivePlan.modelsBySeat : form.modelsBySeat.slice(0, ids.length);
        if (seatModels.some((model) => model && model !== 'default')) await applySlotModels(team, seatModels);
        onCreated(team);
        closeAndReset();
      } catch (error) {
        console.error('[NewGroupChatModal] create failed', error);
        Message.error(
          getConversationCreateErrorMessage(error, t, (detail) =>
            t('team.groupChat.errorWithDetail', { error: detail })
          )
        );
        setCreating(false);
      }
    },
    [assistantId, closeAndReset, creating, form, onCreated, positions, t]
  );

  // The panel's live plan drives the footer; the panel's ready callback hands
  // the exact final plan and runs the creation itself.
  const handlePlan = useCallback((next: RecipeGroupPlan | null) => {
    planRef.current = next;
    setPlan(next);
  }, []);
  const handlePlanReady = useCallback(
    (readyPlan: RecipeGroupPlan) => {
      handlePlan(readyPlan);
      void submit(readyPlan);
    },
    [handlePlan, submit]
  );

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
        {/* The two ways in: hand-pick positions, or start from a recipe card. */}
        <Radio.Group
          data-testid='new-group-chat-mode'
          type='button'
          size='small'
          value={mode}
          disabled={creating}
          onChange={(value) => setMode(value as 'manual' | 'recipe')}
        >
          <Radio value='manual'>{t('team.recipes.modeManual')}</Radio>
          <Radio value='recipe'>{t('team.recipes.modeRecipe')}</Radio>
        </Radio.Group>

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

        {mode === 'manual' ? (
          <div>
            <div className='mb-6px text-13px font-500 text-t-primary'>{t('team.groupChat.positionsLabel')}</div>
            <Select
              className='w-full'
              mode='multiple'
              data-testid='new-group-chat-positions'
              aria-label={t('team.groupChat.positionsLabel')}
              value={form.positionIds}
              placeholder={t('team.groupChat.positionsPlaceholder')}
              onChange={(value) =>
                setForm((prev) => {
                  const positionIds = (value ?? []) as string[];
                  // The per-seat model picks stay parallel to the seats: a
                  // removed seat drops its pick, a new one starts on default.
                  const modelsBySeat = positionIds.map((_, index) => prev.modelsBySeat[index] ?? '');
                  return { ...prev, positionIds, modelsBySeat };
                })
              }
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
            {picked.length > 0 ? (
              <div className='mt-10px flex flex-col gap-6px'>
                <div className='text-12px font-500 text-t-secondary'>{t('team.groupChat.modelLabel')}</div>
                {picked.map((position, index) => (
                  <div key={position.name} className='flex items-center gap-8px'>
                    <span className='text-12px text-t-tertiary w-96px shrink-0 truncate'>{position.displayName}</span>
                    <Select
                      className='flex-1'
                      size='small'
                      data-testid={`new-group-chat-model-${index}`}
                      aria-label={t('team.groupChat.modelLabel')}
                      value={form.modelsBySeat[index] || 'default'}
                      onChange={(value: string) =>
                        setForm((prev) => {
                          const modelsBySeat = [...prev.modelsBySeat];
                          modelsBySeat[index] = value === 'default' ? '' : value;
                          return { ...prev, modelsBySeat };
                        })
                      }
                    >
                      <Select.Option value='default'>{t('team.recipes.modelDefault')}</Select.Option>
                      {offeredModels.map((model) => (
                        <Select.Option key={model} value={model}>
                          {model}
                        </Select.Option>
                      ))}
                    </Select>
                    {index === 0 ? (
                      <span className='text-11px text-t-tertiary shrink-0'>{t('team.members.leadBadge')}</span>
                    ) : null}
                  </div>
                ))}
                <div className='text-12px text-t-tertiary'>{t('team.groupChat.modelHint')}</div>
              </div>
            ) : null}
          </div>
        ) : (
          <RecipePanel
            open={open}
            onPlan={handlePlan}
            onReadyToCreate={handlePlanReady}
            busy={creating}
            models={offeredModels}
          />
        )}

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
            {validation === 'recipeNoPlan' ? t('team.recipes.noPlan') : t(`team.groupChat.errors.${validation}`)}
          </div>
        ) : null}
      </div>
    </MuModal>
  );
};

export default NewGroupChatModal;
