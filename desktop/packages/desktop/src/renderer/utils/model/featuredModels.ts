/**
 * Which models the model picker lists before the person asks for all of them. Some providers list every model their
 * maker ever shipped: OpenAI's (an API key or a ChatGPT sign-in) and the older Codex sign-in list GPT-4, GPT-4o, the
 * o-series and every GPT-5 point release, which buries the few worth choosing. For those, the picker lists the newest
 * GPT series only, by version, so a new point release of a listed series (or a newer series) shows by itself. Every
 * other provider lists all of its models.
 */

/** A GPT version: major, then minor (`gpt-6` is 6.0). */
type GptVersion = readonly [major: number, minor: number];

/** The oldest GPT version OpenAI's providers list: GPT-5.6, then GPT-6, GPT-6.1 and anything newer. */
const OPENAI_FIRST_LISTED: GptVersion = [5, 6];

/** Providers whose models are listed from a GPT version up, by provider id. */
const FIRST_LISTED_VERSION: Readonly<Record<string, GptVersion>> = {
  openai: OPENAI_FIRST_LISTED,
  'openai-codex': OPENAI_FIRST_LISTED,
};

/**
 * The version a model id starts with: `gpt-6.1-sol` is 6.1, `gpt-6-astra` 6.0. Ids that name no version that way
 * (`gpt-4o`, `o3`, `gpt-realtime-2.1`, `gpt-daybreak-blue-latest`) have none.
 */
const GPT_VERSION = /^gpt-(\d+)(?:\.(\d+))?(?=-|$)/;

function gptVersion(id: string): GptVersion | undefined {
  const match = GPT_VERSION.exec(id);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : undefined;
}

/**
 * Whether the picker lists a model (`provider/model-id`, as the menu's values are) before "Show all models". A provider
 * listed from a GPT version lists the models at or above it; any other provider, or a value with no provider, lists
 * all.
 */
export function isFeaturedModel(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash <= 0) return true;
  const first = FIRST_LISTED_VERSION[value.slice(0, slash)];
  if (!first) return true;
  const version = gptVersion(value.slice(slash + 1));
  if (!version) return false;
  return version[0] > first[0] || (version[0] === first[0] && version[1] >= first[1]);
}
