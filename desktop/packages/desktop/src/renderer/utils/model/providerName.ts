import { isSubscriptionProvider, MAKER_NAMED } from '@/common/kyrn/login';
import { BUILTIN_PROVIDER_NAMES } from '@/common/kyrn/models';

/** The names people gave the providers they set up by hand (mu's models.json), by provider id. */
export type ProviderNames = ReadonlyMap<string, string>;

/**
 * A model provider as people know it: one set up by hand by the name it was given in the settings (`names`), a
 * subscription by its product, in the sign-in screens' words (Claude for `anthropic`), one of pi's built-in providers
 * by its maker's name (OpenAI, whose API keys and ChatGPT sign-in share `openai`), and otherwise by its id.
 */
export const providerDisplayName = (t: (key: string) => string, id: string, names?: ProviderNames): string =>
  names?.get(id) ||
  (isSubscriptionProvider(id) && !MAKER_NAMED.includes(id)
    ? t(`mu.welcome.login.providers.${id}.name`)
    : (BUILTIN_PROVIDER_NAMES[id] ?? id));

/** The names mu last reported for the models it can use, by `provider/model-id` (the send box's model values). */
export type ModelNames = ReadonlyMap<string, string>;

/**
 * A model as the send box's picker names it: by the name mu reported for it (pi's own, "GPT-5.6 Terra"), found by its
 * `provider/model-id`; otherwise by its id without the provider, which the picker says as the group the model is in.
 */
export function modelDisplayName(ref: string, names?: ModelNames): string {
  const named = names?.get(ref);
  if (named) return named;
  const slash = ref.indexOf('/');
  return slash > 0 ? ref.slice(slash + 1) : ref;
}
