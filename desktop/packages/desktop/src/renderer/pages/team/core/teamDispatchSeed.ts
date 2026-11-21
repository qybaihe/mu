/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Team workspace guideline seeding, window side. Every team the store fetches
 * gets its dispatch rules seeded exactly once per session, before the lead
 * runtime can need it (the lead's process warms up at team creation, but pi
 * reads the context file when its first turn starts — a write that lands any
 * time before the first message wins), and its approval block seeded to the
 * group's effective tier (`risk-only` unless the per-team setting says
 * otherwise — batch L ③). A failure forgets the team so the next fetch
 * retries.
 */
import { dispatchSeedBridge } from '@/common/chat/team/teamDispatch/dispatchSeedBridge';
import { effectiveApprovalMode } from '@/common/chat/team/teamDispatch/approvalCore';
import { getClientBusinessSetting } from '@renderer/services/clientBusinessSettings';
import type { TTeam } from '@/common/types/team/teamTypes';

const seededTeamIds = new Set<string>();

export async function ensureTeamDispatchSeeded(team: TTeam): Promise<void> {
  if (!team.workspace || seededTeamIds.has(team.id)) return;
  seededTeamIds.add(team.id);
  let dispatched = false;
  try {
    const answer = await dispatchSeedBridge.seed.invoke({ workspace: team.workspace });
    if (answer.ok === false) {
      console.warn('[teamDispatch] seeding the dispatch rules failed for team', team.id, answer.error);
    } else {
      dispatched = true;
    }
  } catch (error) {
    console.warn('[teamDispatch] seeding the dispatch rules failed for team', team.id, error);
  }
  // The approval block rides the same file: the group's tier beside the
  // dispatch rules. Its failure never undoes a successful dispatch seed —
  // the header's tier select re-seeds it on the next change anyway.
  try {
    const modes = await getClientBusinessSetting('tools.teamApprovalModes');
    const mode = effectiveApprovalMode(modes?.[team.id]);
    const answer = await dispatchSeedBridge.seedApproval.invoke({ workspace: team.workspace, mode });
    if (answer.ok === false) {
      console.warn('[teamDispatch] seeding the approval block failed for team', team.id, answer.error);
    }
  } catch (error) {
    console.warn('[teamDispatch] seeding the approval block failed for team', team.id, error);
  }
  if (!dispatched) seededTeamIds.delete(team.id);
}
