/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TTeam } from '@/common/types/team/teamTypes';

const seedBridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/common/chat/team/teamDispatch/dispatchSeedBridge', () => ({
  dispatchSeedBridge: { seed: seedBridge },
}));

import { ensureTeamDispatchSeeded } from '@/renderer/pages/workbench/team/teamDispatchSeed';

const team = (id: string, workspace: string): TTeam => ({
  id,
  user_id: 'u1',
  name: id,
  workspace,
  workspace_mode: 'shared',
  leader_assistant_id: 's1',
  assistants: [],
  created_at: 1,
  updated_at: 1,
});

describe('ensureTeamDispatchSeeded', () => {
  beforeEach(() => {
    seedBridge.invoke.mockReset();
  });

  it('seeds once per team, skipping teams without a workspace', async () => {
    seedBridge.invoke.mockResolvedValue({ ok: true, data: { changed: true } });
    await ensureTeamDispatchSeeded(team('t1', 'E:/w'));
    await ensureTeamDispatchSeeded(team('t1', 'E:/w'));
    await ensureTeamDispatchSeeded(team('t2', ''));
    expect(seedBridge.invoke).toHaveBeenCalledTimes(1);
    expect(seedBridge.invoke).toHaveBeenCalledWith({ workspace: 'E:/w' });
  });

  it('forgets a team whose seeding failed, so the next fetch retries it', async () => {
    seedBridge.invoke.mockResolvedValueOnce({ ok: false, error: 'nope', code: 'unwritable' });
    await ensureTeamDispatchSeeded(team('t3', 'E:/w3'));
    seedBridge.invoke.mockResolvedValue({ ok: true, data: { changed: false } });
    await ensureTeamDispatchSeeded(team('t3', 'E:/w3'));
    expect(seedBridge.invoke).toHaveBeenCalledTimes(2);
  });
});
