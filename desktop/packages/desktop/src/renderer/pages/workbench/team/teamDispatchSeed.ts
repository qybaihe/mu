/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Team dispatch rules seeding, window side. Every team the store fetches gets
 * its workspace seeded exactly once per session, before the lead runtime can
 * need it (the lead's process warms up at team creation, but pi reads the
 * context file when its first turn starts — a write that lands any time before
 * the first message wins). A failure forgets the team so the next fetch
 * retries.
 */
import { dispatchSeedBridge } from '@/common/chat/teamDispatch/dispatchSeedBridge';
import type { TTeam } from '@/common/types/team/teamTypes';

const seededTeamIds = new Set<string>();

export async function ensureTeamDispatchSeeded(team: TTeam): Promise<void> {
  if (!team.workspace || seededTeamIds.has(team.id)) return;
  seededTeamIds.add(team.id);
  try {
    const answer = await dispatchSeedBridge.seed.invoke({ workspace: team.workspace });
    if (answer.ok === false) {
      console.warn('[teamDispatch] seeding the dispatch rules failed for team', team.id, answer.error);
    } else {
      return;
    }
  } catch (error) {
    console.warn('[teamDispatch] seeding the dispatch rules failed for team', team.id, error);
  }
  seededTeamIds.delete(team.id);
}
