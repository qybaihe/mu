/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-slot models for a freshly built group, window side — the model sibling
 * of {@link applySlotThinkingLevels}. After the team exists, each seat's
 * picked model rides its conversation through the team config-options route
 * (read the options, set the 'model' select); when that route cannot take the
 * value — a dormant teammate answers 409 until its first task — the
 * agent-level `updateAgentModel` PATCH is the fallback, so the backend holds
 * the pick until the runtime wakes. Best-effort by contract: a slot that
 * cannot be switched gets a warn and keeps its default model. Never fatal to
 * the creation.
 */
import { ipcBridge } from '@/common';
import type { AcpConfigOptionDto } from '@/common/types/platform/acpTypes';
import type { TTeam } from '@/common/types/team/teamTypes';

/** The model select of one conversation's config options (category first, then the known id). */
export const modelOptionOf = (
  options: readonly AcpConfigOptionDto[] | undefined
): { id: string; values: string[]; current: string } | undefined => {
  const found = options?.find((option) => option.category === 'model' || option.id === 'model');
  if (!found) return undefined;
  return {
    id: found.id,
    values: (found.options ?? []).map((choice) => choice.value),
    current: typeof found.current_value === 'string' ? found.current_value : '',
  };
};

/**
 * The model id a select actually takes: the offered one with the same id, or
 * — when both carry `provider/model` — the offered one with the same model
 * tail (the assistant list may spell a provider the select spells
 * differently). `undefined` = not offered, leave alone.
 */
export const offeredModelId = (wanted: string, offered: readonly string[]): string | undefined => {
  const exact = offered.find((value) => value === wanted);
  if (exact !== undefined) return exact;
  const tailOf = (value: string): string | undefined => {
    const slash = value.indexOf('/');
    return slash > 0 ? value.slice(slash + 1) : undefined;
  };
  const wantedTail = tailOf(wanted);
  return wantedTail === undefined ? undefined : offered.find((value) => tailOf(value) === wantedTail);
};

/**
 * Applies one model per seat, by seat index (`'default'` or empty leaves the
 * slot on its default). Every failure warns and moves on — a model pick must
 * never break a creation.
 */
export async function applySlotModels(team: TTeam, modelsBySeatIndex: readonly string[]): Promise<void> {
  await Promise.allSettled(
    team.assistants.map(async (agent, index) => {
      const wanted = modelsBySeatIndex[Math.min(index, modelsBySeatIndex.length - 1)];
      if (!wanted || wanted === 'default' || !agent.conversation_id) return;
      try {
        const options = await ipcBridge.team.getConfigOptions.invoke({
          team_id: team.id,
          conversation_id: agent.conversation_id,
        });
        const option = modelOptionOf(options.config_options);
        const value = option ? offeredModelId(wanted, option.values) : undefined;
        if (option && value) {
          await ipcBridge.team.setConfigOption.invoke({
            team_id: team.id,
            conversation_id: agent.conversation_id,
            option_id: option.id,
            value,
          });
          return;
        }
      } catch (error) {
        console.warn(
          `[recipe] model config-option not applied to seat ${index} (${agent.assistant_name}), trying the agent route`,
          error instanceof Error ? error.message : error
        );
      }
      // The fallback: an agent-level PATCH the backend holds for a dormant
      // member. Also the only route when the model select was not offered.
      try {
        await ipcBridge.team.updateAgentModel.invoke({ team_id: team.id, slot_id: agent.slot_id, model_id: wanted });
      } catch (error) {
        console.warn(
          `[recipe] model not applied to seat ${index} (${agent.assistant_name})`,
          error instanceof Error ? error.message : error
        );
      }
    })
  );
}
