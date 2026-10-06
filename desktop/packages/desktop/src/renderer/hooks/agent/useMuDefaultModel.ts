import { Message } from '@arco-design/web-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { THINKING_LEVELS, type ModelDefaults, type ThinkingLevel } from '@/common/kyrn/models';
import { splitModel } from '@/renderer/pages/native/components/composer/composerModel';

export type MuDefaultModel = {
  /** The model new conversations start on, as `provider/model-id`; undefined when none is set or it cannot be read. */
  model?: string;
  /** Its thinking level; '' when none is set. */
  level: ThinkingLevel | '';
  /**
   * Makes `model` (`provider/model-id`) the default, and `level` with it when it is one of pi's, and says how it went;
   * true when it took.
   */
  makeDefault: (model: string, level?: string) => Promise<boolean>;
};

const KEY = 'mu.defaultModel';

const asLevel = (value?: string): ThinkingLevel | undefined => THINKING_LEVELS.find((level) => level === value);

async function readDefault(): Promise<ModelDefaults | null> {
  try {
    return unwrap(await kyrnBridge.defaultModel.invoke());
  } catch {
    return null;
  }
}

/**
 * The model new conversations start on (pi's `defaultProvider` and `defaultModel`, the settings' default model), and
 * the send box's "make default". A model picked in a send box is for that conversation only; this is how it becomes
 * the default. Every send box shares one read, refreshed after a change.
 */
export function useMuDefaultModel(): MuDefaultModel {
  const { t } = useTranslation();
  const { data, mutate } = useSWR(KEY, readDefault, { revalidateOnFocus: true });
  const makeDefault = useCallback(
    async (model: string, level?: string) => {
      const target = splitModel(model);
      if (!target) return false;
      const thinkingLevel = asLevel(level);
      try {
        const saved = unwrap(
          await kyrnBridge.setDefaultModel.invoke({
            provider: target.provider,
            model: target.modelId,
            ...(thinkingLevel ? { thinkingLevel } : {}),
          })
        );
        await mutate(saved, { revalidate: false });
        Message.success(t('conversation.composer.madeDefault'));
        return true;
      } catch {
        Message.error(t('conversation.composer.makeDefaultFailed'));
        return false;
      }
    },
    [mutate, t]
  );
  return {
    ...(data?.provider && data.model ? { model: `${data.provider}/${data.model}` } : {}),
    level: data?.thinkingLevel ?? '',
    makeDefault,
  };
}
