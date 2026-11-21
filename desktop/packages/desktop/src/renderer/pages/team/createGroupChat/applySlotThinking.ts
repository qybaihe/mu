/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-slot thinking levels for a recipe-built group, window side. After the
 * team exists, each role's declared tier rides its conversation through the
 * team config-options route — read the options, clamp to what the model
 * offers, PUT the value — the same semantics the supervisor's `teams.cjs
 * add` applies to declared levels. Best-effort by contract: the team warms
 * its lead at creation while teammates stay dormant and answer 409 until
 * their first task, so a slot that cannot be switched gets a warn and keeps
 * what its model starts on (the position md still declares the tier; the
 * lead's dispatch duty re-sets it per task). Never fatal to the creation.
 */
import { ipcBridge } from '@/common';
import { clampThinkingLevelTo, type PositionThinkingLevel } from '@/common/chat/team/thinkingLevel/thinkingLevelCore';
import type { AcpConfigOptionDto } from '@/common/types/platform/acpTypes';
import type { TTeam } from '@/common/types/team/teamTypes';

/** The thinking option of one conversation's config options (category first, then known ids). */
const thoughtOptionOf = (
  options: readonly AcpConfigOptionDto[] | undefined
): { id: string; values: string[] } | undefined => {
  const found = options?.find(
    (option) =>
      option.category === 'thought_level' || ['thinking', 'thought_level', 'reasoning_effort'].includes(option.id)
  );
  if (!found) return undefined;
  return { id: found.id, values: (found.options ?? []).map((choice) => choice.value) };
};

/**
 * Applies one tier per slot, by seat index (the recipe's role order is the
 * seats' order; a single-position group's duplicated second seat takes the
 * same tier). A missing tier leaves its slot alone; every failure warns and
 * moves on — the levels must never break a creation.
 */
export async function applySlotThinkingLevels(
  team: TTeam,
  levelsBySeatIndex: readonly (PositionThinkingLevel | undefined)[]
): Promise<void> {
  try {
    await ipcBridge.team.ensureSession.invoke({ team_id: team.id });
  } catch {
    // The creation just made the lead warm; a refusal here still allows the per-slot reads below.
  }
  await Promise.allSettled(
    team.assistants.map(async (agent, index) => {
      const level = levelsBySeatIndex[Math.min(index, levelsBySeatIndex.length - 1)];
      if (!level || !agent.conversation_id) return;
      try {
        const options = await ipcBridge.team.getConfigOptions.invoke({
          team_id: team.id,
          conversation_id: agent.conversation_id,
        });
        const option = thoughtOptionOf(options.config_options);
        if (!option) return;
        const clamped = clampThinkingLevelTo(level, option.values);
        if (!clamped) return;
        await ipcBridge.team.setConfigOption.invoke({
          team_id: team.id,
          conversation_id: agent.conversation_id,
          option_id: option.id,
          value: clamped,
        });
      } catch (error) {
        console.warn(
          `[recipe] thinking level not applied to seat ${index} (${agent.assistant_name})`,
          error instanceof Error ? error.message : error
        );
      }
    })
  );
}
