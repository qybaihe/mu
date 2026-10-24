import type { SignOutSwitch, SwitchedModel } from '../../../../common/kyrn/login';
import type { AvailableModels, ModelDefaults } from '../../../../common/kyrn/models';

/** What a sign-out moves: the default model in pi's settings, and the conversations that run. */
export type SignOutParts = {
  /** The model new sessions start on (SettingsStore.defaultModel). */
  defaults: () => ModelDefaults;
  /** It becomes `next`, or none (SettingsStore.replaceDefaultModel). */
  replaceDefault: (next?: { provider: string; model: string }) => unknown;
  /**
   * Every running conversation on one of `provider`'s models goes on with `wanted`, else its pi's first model; the
   * models they went on with (NativeConversations.leave).
   */
  conversations: (provider: string, wanted?: { provider: string; id: string }) => Promise<SwitchedModel[]>;
};

/**
 * What a sign-out of `provider` changes besides its credential, once mu was checked again: `usable` is what it reports
 * now (config/available.ts). The model new sessions start on, when it was one of the account's and mu no longer offers
 * it, becomes the first model mu offers, or none when there is none. Then every running conversation on one of the
 * account's models goes on with the default. A model mu still offers stays: the provider takes an API key too (OpenAI,
 * Grok), and one is set.
 */
export async function leaveProvider(
  provider: string,
  usable: AvailableModels,
  parts: SignOutParts
): Promise<SignOutSwitch> {
  const offered = usable.providers.flatMap((entry) =>
    entry.models.map((model): SwitchedModel => ({ provider: entry.id, model: model.id, name: model.name }))
  );
  const before = parts.defaults();
  const defaultMoved =
    before.provider === provider &&
    Boolean(before.model) &&
    !offered.some((model) => model.provider === before.provider && model.model === before.model);
  const first = offered[0];
  if (defaultMoved) parts.replaceDefault(first && { provider: first.provider, model: first.model });
  const wanted = defaultMoved ? first : before.model ? before : undefined;
  const switched = await parts.conversations(provider, wanted && { provider: wanted.provider, id: wanted.model });
  const to = (defaultMoved ? first : undefined) ?? switched[0];
  return { defaultMoved, conversations: switched.length, ...(to ? { to } : {}) };
}
