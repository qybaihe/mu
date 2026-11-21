/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The group's risk-approval tier, window side (batch L ③): a compact select
 * on the group chat's header (the lead thread — the group's own setting,
 * never a member thread's). The pick persists in the per-team approval map
 * (clientSettings) and lands in the team workspace's AGENTS.md as the
 * approval managed block, which every seat reads in place of its own
 * position tier. `risk-only` is the default; the payment iron line rides
 * every tier, so the select's hint says so.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, Tooltip } from '@arco-design/web-react';
import { LockOne } from '@icon-park/react';
import { dispatchSeedBridge } from '@/common/chat/team/teamDispatch/dispatchSeedBridge';
import {
  TEAM_APPROVAL_DEFAULT,
  TEAM_APPROVAL_MODES,
  effectiveApprovalMode,
  type TeamApprovalMode,
} from '@/common/chat/team/teamDispatch/approvalCore';
import { getClientBusinessSetting, setClientBusinessSetting } from '@renderer/services/clientBusinessSettings';
import type { TTeam } from '@/common/types/team/teamTypes';

type Props = { team: TTeam };

const MODE_LABEL_KEY: Record<TeamApprovalMode, string> = {
  'risk-only': 'team.approval.riskOnly',
  all: 'team.approval.all',
  none: 'team.approval.none',
};

const TeamApprovalMode: React.FC<Props> = ({ team }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TeamApprovalMode | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getClientBusinessSetting('tools.teamApprovalModes')
      .then((modes) => {
        if (!cancelled) setMode(effectiveApprovalMode(modes?.[team.id]));
      })
      .catch(() => {
        if (!cancelled) setMode(TEAM_APPROVAL_DEFAULT);
      });
    return () => {
      cancelled = true;
    };
  }, [team.id]);

  const change = (next: TeamApprovalMode): void => {
    const previous = mode;
    setMode(next);
    void (async () => {
      try {
        const modes = (await getClientBusinessSetting('tools.teamApprovalModes')) ?? {};
        await setClientBusinessSetting('tools.teamApprovalModes', { ...modes, [team.id]: next });
        // The block is what the seats actually read: seed it right after the
        // setting, and roll the select back if it refuses (best-effort UI).
        if (team.workspace) {
          const answer = await dispatchSeedBridge.seedApproval.invoke({ workspace: team.workspace, mode: next });
          if (answer.ok === false) throw new Error(answer.error);
        }
      } catch (error) {
        console.warn('[teamApproval] setting the tier failed for team', team.id, error);
        setMode(previous);
      }
    })();
  };

  return (
    <Tooltip content={t('team.approval.hint')} position='bottom' mini>
      <div data-testid='team-approval-mode' className='flex items-center gap-4px'>
        <LockOne theme='outline' size='14' className='text-t-tertiary shrink-0' />
        <Select
          data-testid='team-approval-mode-select'
          size='mini'
          bordered={false}
          className='min-w-90px'
          value={mode}
          loading={mode === undefined}
          onChange={(value: TeamApprovalMode) => change(value)}
        >
          {TEAM_APPROVAL_MODES.map((entry) => (
            <Select.Option key={entry} value={entry}>
              {t(MODE_LABEL_KEY[entry])}
            </Select.Option>
          ))}
        </Select>
      </div>
    </Tooltip>
  );
};

export default TeamApprovalMode;
