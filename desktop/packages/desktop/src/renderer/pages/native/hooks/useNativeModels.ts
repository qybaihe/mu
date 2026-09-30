/**
 * The model and thinking level of a native conversation, and the person's switch of them. What is in force comes from
 * the view (a running host's report) or, with no host, from what the session file said (`modelInForce`). The models
 * on offer are asked of pi when the person opens the menu (`get_available_models`, and the levels of the model in
 * use, `get_available_thinking_levels`), which starts the host when none runs. Only the person sets the thinking level.
 */
import { useCallback, useRef, useState } from 'react';
import type { NativeResult } from '@/common/kyrn/nativeBridge';
import {
  asList,
  asObject,
  asText,
  type NativeView,
  type PiCommand,
  type SessionSettings,
} from '@/common/utils/nativeHost';
import {
  modelInForce,
  offeredModels,
  splitModel,
  type ModelInForce,
  type OfferedModels,
} from '../components/composer/composerModel';

export type NativeModels = ModelInForce & {
  /** What pi offers, once asked; `levels` of the model in use are pi's own answer. */
  offer?: OfferedModels & { currentLevels?: string[] };
  /** The menu's list is being asked for. */
  loading: boolean;
  /** A switch is on its way. */
  switching: boolean;
  /** Asks pi what it offers (again, each time the menu opens: a provider set up meanwhile shows). */
  load: () => Promise<void>;
  /** Switches to `model`, then to `level` when one was picked: nothing is sent for what is already so. */
  pick: (model: string, level?: string) => Promise<void>;
};

export function useNativeModels(
  view: NativeView,
  settings: SessionSettings | undefined,
  request: (command: PiCommand) => Promise<NativeResult<unknown>>
): NativeModels {
  const inForce = modelInForce(view, settings);
  const [offer, setOffer] = useState<NativeModels['offer']>();
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const current = useRef(inForce);
  current.current = inForce;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [models, levels] = await Promise.all([
        request({ type: 'get_available_models' }),
        request({ type: 'get_available_thinking_levels' }),
      ]);
      if (models.ok === false) return;
      const offered = offeredModels(asList(asObject(models.data).models), current.current.model);
      const currentLevels = levels.ok ? asList(asObject(levels.data).levels).map(asText).filter(Boolean) : undefined;
      setOffer({ ...offered, ...(currentLevels?.length ? { currentLevels } : {}) });
    } finally {
      setLoading(false);
    }
  }, [request]);

  const pick = useCallback(
    async (model: string, level?: string) => {
      const before = current.current;
      setSwitching(true);
      try {
        if (model !== before.model) {
          const target = splitModel(model);
          if (!target) return;
          const switched = await request({ type: 'set_model', ...target });
          if (switched.ok === false) return;
        }
        // pi picks a level of its own when the model changes: the one picked is set after it, whatever pi chose.
        if (level && (model !== before.model || level !== before.level))
          await request({ type: 'set_thinking_level', level });
      } finally {
        setSwitching(false);
      }
    },
    [request]
  );

  return { ...inForce, ...(offer ? { offer } : {}), loading, switching, load, pick };
}
