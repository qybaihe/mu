import useSWR from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import type { ModelNames } from '@/renderer/utils/model/providerName';

const NONE: ModelNames = new Map();

/** The names' shared read: read again once mu was checked again (recheckMu). */
export const MODEL_NAMES_KEY = 'mu.modelNames';

/** The names mu last reported for its models, by `provider/model-id`; nothing when they cannot be read. */
async function readModelNames(): Promise<ModelNames> {
  try {
    const { providers } = unwrap(await kyrnBridge.availableModels.invoke());
    return new Map(
      providers.flatMap((provider) =>
        provider.models.map((model): [string, string] => [`${provider.id}/${model.id}`, model.name])
      )
    );
  } catch {
    return NONE;
  }
}

/**
 * The models' names as the send box's picker shows them, for a view that has only a model's id, such as a sub-agent's
 * (`modelDisplayName`). The backend keeps what mu last reported, so reading it starts nothing. Read when a view first
 * mounts, again on the next mount, and after mu was checked again.
 */
export function useModelNames(): ModelNames {
  const { data } = useSWR(MODEL_NAMES_KEY, readModelNames, { revalidateOnFocus: false });
  return data ?? NONE;
}
