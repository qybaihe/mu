import { mutate } from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { refreshManagedAgentCatalogAndAssistants } from '@/renderer/hooks/agent/useManagedAgents';
import { MODEL_NAMES_KEY } from '@/renderer/hooks/agent/useModelNames';
import { emitter } from '@/renderer/utils/emitter';

/**
 * After a change to what mu offers (a save, a sign-in, a sign-out): the backend checks mu again, and the model pickers
 * and the / menu read what it found. They read a snapshot the backend keeps from its last check of mu, which the app's
 * start makes. Without this, a model set up on a fresh profile was missing from the home page's pill (默认模型, with no
 * list) until the app was started again. The settings' own copy of the snapshot and the models' names are read again
 * too: without that, a signed-out account's models stayed in the default model's picker until the settings were left.
 */
export async function recheckMu(): Promise<void> {
  try {
    unwrap(await kyrnBridge.recheck.invoke());
  } catch {
    // mu did not answer the check. The pickers keep what they had; the next start checks again.
  }
  emitter.emit('mu.rechecked');
  await Promise.all([
    refreshManagedAgentCatalogAndAssistants().catch((): undefined => undefined),
    mutate(MODEL_NAMES_KEY).catch((): undefined => undefined),
  ]);
}
