import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UNOFFERED_PROVIDER_IDS } from '../../../../common/kyrn/models.ts';
import { asList, asObject, asText, hasModel } from '../../../../common/utils/nativeHost/records.ts';
import type { ConversationHost } from './types.ts';

/**
 * pi chooses a session's model when it starts, from the models it can use then. A host that started while another mu
 * process held the model store found none and runs without one; the store frees up within seconds. So a conversation
 * keeps looking for a while, takes the model new sessions start on (or the first one offered) as soon as pi lists it,
 * and chooses nothing when a model was set meanwhile. The same as the CLI bridge's (KyrnAgent.ts `lookForModel`).
 */

/** A host that started without a model looks for one after these waits: about six seconds in all. */
export const MODEL_WAITS_MS = [0, 500, 1000, 2000, 3000] as const;
/** A message sent while there is still no model looks once more, more briefly. */
export const PROMPT_MODEL_WAITS_MS = [0, 1000, 2000] as const;

export type ModelChoice = { provider: string; id: string };

/** pi's `defaultProvider` and `defaultModel` in the agent folder's settings: the model new sessions start on. */
export function readDefaultModel(agentDir: string): ModelChoice | undefined {
  try {
    const settings = asObject(JSON.parse(readFileSync(path.join(agentDir, 'settings.json'), 'utf8')));
    const provider = asText(settings.defaultProvider);
    const id = asText(settings.defaultModel);
    return provider && id ? { provider, id } : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });

/**
 * Looks for a model after each wait, and sets the first one found. `wanted` is the one to prefer; `still` says whether
 * the host is still the conversation's (it may have ended meanwhile). Resolves true when it set a model.
 */
export async function findModel(
  host: Pick<ConversationHost, 'request'>,
  options: { wanted?: ModelChoice; waits: readonly number[]; still: () => boolean }
): Promise<boolean> {
  for (const wait of options.waits) {
    // oxlint-disable-next-line no-await-in-loop -- one look after another, each after its wait
    if (wait) await sleep(wait);
    if (!options.still()) return false;
    // oxlint-disable-next-line no-await-in-loop -- as above
    const models = asList((await host.request({ type: 'get_available_models' })).models).map(asObject);
    const pick =
      models.find(
        (model) => asText(model.provider) === options.wanted?.provider && asText(model.id) === options.wanted?.id
      ) ??
      models.find(
        (model) => asText(model.provider) && asText(model.id) && !UNOFFERED_PROVIDER_IDS.has(asText(model.provider))
      );
    if (!pick) continue;
    // oxlint-disable-next-line no-await-in-loop -- as above
    if (hasModel((await host.request({ type: 'get_state' })).model) || !options.still()) return false;
    // oxlint-disable-next-line no-await-in-loop -- as above
    await host.request({ type: 'set_model', provider: asText(pick.provider), modelId: asText(pick.id) });
    return true;
  }
  return false;
}
