/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Group-chat member management: the popover the header's identity strip
 * opens on the group's own thread (a teammate's private thread never shows
 * it). It lists the current members — the lead marked, not removable; every
 * other member one click from removal — and offers the roster's not-yet-seated
 * positions to add. Every change goes straight to the backend's team agents
 * API, then the shared TEAMS.md positions are refreshed and the team list
 * refetched, so the header's member strip and pill move at once. A removed
 * member's thread is deleted with the slot (the backend's behavior); the
 * group chat itself — the lead's thread — is never touched.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Message, Popover, Select } from '@arco-design/web-react';
import { Close, People } from '@icon-park/react';
import classNames from 'classnames';
import { ipcBridge } from '@/common';
import { supervisorBridge } from '@/common/chat/supervisor/supervisorBridge';
import type { TTeam } from '@/common/types/team/teamTypes';
import { usePositionRoster } from '@renderer/pages/positions/usePositionRoster';
import { leadConversationIdOf, teammateThreadName } from '@renderer/pages/team/createGroupChat/groupChatCore';
import { refreshTeamsList } from './teamStore';
import { addablePositions, isLeaderSlot, positionsAfterChange } from './teamMembersCore';

type TeamMembersManagerProps = {
  team: TTeam;
};

const TeamMembersManager: React.FC<TeamMembersManagerProps> = ({ team }) => {
  const { t } = useTranslation();
  const { positions: roster } = usePositionRoster();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const addable = useMemo(() => addablePositions(team, roster), [team, roster]);

  /** Writes the group's new positions into the shared index, then refetches the list. */
  const syncRegistration = async (keptNames: string[], addedIds: string[]): Promise<void> => {
    const added = roster.filter((position) => addedIds.includes(position.name));
    const leadConversationId = leadConversationIdOf(team);
    if (leadConversationId) {
      await supervisorBridge.registerTeam
        .invoke({
          name: team.name,
          positions: positionsAfterChange(keptNames, added, roster),
          teamId: team.id,
          leadConversationId,
        })
        .catch((): undefined => undefined);
    }
    refreshTeamsList();
  };

  const removeMember = async (slotId: string, memberName: string): Promise<void> => {
    setBusy(true);
    try {
      await ipcBridge.team.removeAgent.invoke({ team_id: team.id, slot_id: slotId });
      // The index records every seat's position — the lead's included.
      const kept = team.assistants
        .filter((assistant) => assistant.slot_id !== slotId)
        .map((assistant) => assistant.assistant_name);
      await syncRegistration(kept, []);
      setSelectedIds([]);
    } catch (error) {
      console.error('[TeamMembersManager] remove failed', error);
      Message.error(t('team.members.removeFailed', { name: memberName }));
    } finally {
      setBusy(false);
    }
  };

  const addSelected = async (): Promise<void> => {
    if (selectedIds.length === 0 || busy) return;
    setBusy(true);
    try {
      // Every slot of a group chat is the mu agent: the lead's own assistant
      // id is the one the added positions take too (the full-MU lineup rule).
      const leadAssistantId = team.assistants.find((assistant) => isLeaderSlot(assistant))?.assistant_id ?? '';
      const kept = team.assistants.map((a) => a.assistant_name);
      // Added one by one, chained (never parallel): the backend seats each new
      // slot in call order, so the group's member order follows the picked order.
      const additions = selectedIds.flatMap((id) => {
        const position = roster.find((candidate) => candidate.name === id);
        return position ? [position] : [];
      });
      await additions.reduce<Promise<unknown>>(
        (chain, position) =>
          chain
            .then(() =>
              ipcBridge.team.addAgent.invoke({
                team_id: team.id,
                assistant: {
                  role: 'teammate',
                  assistant_name: position.displayName,
                  model: 'default',
                  assistant_id: leadAssistantId,
                },
              })
            )
            // The new member's thread says whose it is, like every teammate thread;
            // a rename must not fail the addition.
            .then((added) =>
              added.conversation_id
                ? ipcBridge.conversation.update
                    .invoke({
                      id: added.conversation_id,
                      updates: { name: teammateThreadName(position.displayName, team.name), name_source: 'user' },
                    })
                    .catch((): undefined => undefined)
                : undefined
            ),
        Promise.resolve()
      );
      await syncRegistration(kept, selectedIds);
      setSelectedIds([]);
    } catch (error) {
      console.error('[TeamMembersManager] add failed', error);
      Message.error(t('team.members.addFailed'));
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <div className='flex flex-col gap-10px w-260px py-4px' data-testid='team-members-popover'>
      <div className='text-12px font-500 text-t-primary'>
        {t('team.members.listTitle', { count: team.assistants.length })}
      </div>
      <div className='flex flex-col gap-2px max-h-200px overflow-y-auto'>
        {team.assistants.map((assistant) => {
          const leader = isLeaderSlot(assistant);
          return (
            <div
              key={assistant.slot_id}
              data-testid={`team-member-row-${assistant.slot_id}`}
              className='flex items-center gap-8px h-28px px-6px rd-6px hover:bg-fill-2 min-w-0'
            >
              <span className='text-13px truncate flex-1'>{assistant.assistant_name}</span>
              {leader ? (
                <span className='text-11px px-4px rd-full bg-[rgba(var(--primary-6),0.12)] text-primary shrink-0'>
                  {t('team.members.leadBadge')}
                </span>
              ) : (
                <Button
                  size='mini'
                  type='text'
                  disabled={busy}
                  aria-label={t('team.members.removeA11y', { name: assistant.assistant_name })}
                  onClick={() => void removeMember(assistant.slot_id, assistant.assistant_name)}
                >
                  <Close theme='outline' size='12' />
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {addable.length > 0 ? (
        <div className='flex flex-col gap-6px pt-6px border-t-1px border-t-solid border-[var(--color-border-2)]'>
          <div className='text-12px font-500 text-t-primary'>{t('team.members.addLabel')}</div>
          <Select
            className='w-full'
            mode='multiple'
            data-testid='team-members-add-select'
            aria-label={t('team.members.addLabel')}
            value={selectedIds}
            placeholder={t('team.members.addPlaceholder')}
            onChange={(value) => setSelectedIds((value ?? []) as string[])}
          >
            {addable.map((position) => (
              <Select.Option key={position.name} value={position.name}>
                {position.displayName}
              </Select.Option>
            ))}
          </Select>
          <Button
            data-testid='team-members-add-apply'
            size='small'
            type='primary'
            disabled={selectedIds.length === 0}
            loading={busy}
            onClick={() => void addSelected()}
          >
            {t('team.members.addApply')}
          </Button>
        </div>
      ) : (
        <div className='text-12px text-t-tertiary'>{t('team.members.addAllOnTeam')}</div>
      )}
    </div>
  );

  return (
    <Popover
      content={content}
      trigger='click'
      position='bottom'
      unmountOnExit
      popupVisible={open}
      onVisibleChange={(visible) => setOpen(visible)}
    >
      <span
        data-testid='team-members-manage'
        role='button'
        tabIndex={0}
        aria-label={t('team.members.manageA11y')}
        className={classNames(
          'size-20px rd-6px flex-center text-t-tertiary hover:text-t-primary hover:bg-fill-3 active:bg-fill-4 cursor-pointer shrink-0'
        )}
      >
        <People
          theme='outline'
          size='13'
          fill='currentColor'
          className='block leading-none'
          style={{ lineHeight: 0 }}
        />
      </span>
    </Popover>
  );
};

export default TeamMembersManager;
