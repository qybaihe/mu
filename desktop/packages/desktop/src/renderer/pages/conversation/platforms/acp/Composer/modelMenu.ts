import type { ModelThinkingLevels } from '@/common/kyrn/models';
import type { AcpConfigOptionDto } from '@/common/types/platform/acpTypes';
import {
  classifyConfigSetError,
  deriveSelectOption,
  type AcpDerivedOption,
} from '@/renderer/hooks/agent/useAcpConfigOptions';

/** The ids a thinking-level option goes by when it has no category, as `useAcpConfigOptions` reads it. */
const THOUGHT_LEVEL_IDS = ['thought_level', 'reasoning_effort'];

/** A thinking level as the picker lists it: the value the runtime takes, and the name the agent gave it, if any. */
export type MenuLevel = { value: string; label?: string };

export type MenuModel = {
  /** The model option's value: `provider/model-id` for mu. */
  value: string;
  label: string;
  /** What the agent says the model is, when it says: shown on hover. */
  description?: string;
  /** The levels this model takes, weakest first; empty when nothing says, and then the row switches the model only. */
  levels: MenuLevel[];
};

/** Models of one provider; `title` is empty when the values name no provider (another agent's own ids). */
export type MenuModelGroup = { key: string; title: string; models: MenuModel[] };

/** One choice of a select option, as the session or the home page's remembered list gives it. */
type Choice = { value: string; label?: string | null; description?: string | null };

/** The models to choose from, and the one in use: the session's `model` option, or what the home page remembers. */
export type ModelChoices = { currentValue?: string | null; options: ReadonlyArray<Choice> };

const providerOf = (value: string): string => {
  const slash = value.indexOf('/');
  return slash > 0 ? value.slice(0, slash) : '';
};

/**
 * The picker's rows: every model on offer, by provider, each with the thinking levels it takes. The model in use takes
 * the levels reported right now; any other takes what the adapter recorded for it. A provider is titled by
 * `providerName` (its name, where the id is all the value says). mu describes each model by its provider's id, which
 * the title already says in words: such a description is left out.
 */
export function modelMenu(
  model: ModelChoices,
  thoughtLevel: { options: ReadonlyArray<Choice> } | null,
  recorded: ModelThinkingLevels,
  providerName: (id: string) => string = (id) => id
): MenuModelGroup[] {
  const groups = new Map<string, MenuModelGroup>();
  for (const option of model.options) {
    const levels: MenuLevel[] =
      option.value === model.currentValue && thoughtLevel
        ? thoughtLevel.options.map((level) => ({ value: level.value, label: level.label ?? undefined }))
        : (recorded[option.value] ?? []).map((level) => ({ value: level }));
    const key = providerOf(option.value);
    const group = groups.get(key) ?? { key, title: key ? providerName(key) : '', models: [] };
    group.models.push({
      value: option.value,
      label: option.label || option.value,
      ...(option.description && option.description !== key ? { description: option.description } : {}),
      levels,
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The rows whose name or id holds the query, case-insensitive; groups left empty are dropped. */
export function filterModelMenu(groups: MenuModelGroup[], query: string): MenuModelGroup[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return groups;
  return groups
    .map((group) => ({
      ...group,
      models: group.models.filter(
        (entry) => entry.label.toLowerCase().includes(keyword) || entry.value.toLowerCase().includes(keyword)
      ),
    }))
    .filter((group) => group.models.length > 0);
}

export type ConfigOptionSetter = (optionId: string, value: string) => Promise<AcpConfigOptionDto[] | null | undefined>;

/**
 * Switches to the picked model at the picked level, through the session's own options: the model first, when it
 * changes, then the thinking level, when the one in force differs. pi chooses a level of its own when the model
 * changes (that model's default, or the one before), so the level in force is read from the switch's answer, never
 * assumed from before it. Nothing is sent for what is already so.
 */
export async function applyModelPick(
  setConfigOption: ConfigOptionSetter,
  now: { model: AcpDerivedOption; thoughtLevel: AcpDerivedOption | null },
  pick: { model: string; level?: string }
): Promise<void> {
  let thinking = now.thoughtLevel;
  if (pick.model !== now.model.currentValue) {
    const answered = await setConfigOption(now.model.id, pick.model);
    thinking = deriveSelectOption(answered, 'thought_level', THOUGHT_LEVEL_IDS) ?? thinking;
  }
  if (pick.level && thinking && pick.level !== thinking.currentValue) await setConfigOption(thinking.id, pick.level);
}

/** The message for a switch the runtime did not take, by why. */
export function configErrorMessageKey(error: unknown): string {
  const kind = classifyConfigSetError(error);
  if (kind === 'command_ack') return 'agent.config.commandAck';
  if (kind === 'confirmation_timeout') return 'agent.config.timeout';
  if (kind === 'config_update_in_progress') return 'agent.config.busy';
  return 'agent.config.failed';
}
