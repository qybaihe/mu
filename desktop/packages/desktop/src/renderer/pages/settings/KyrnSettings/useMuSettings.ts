import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { mutate } from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import type { AvailableModels } from '@/common/kyrn/models';
import type { KyrnSettings } from '@/common/kyrn/types';
import { completeSettings, dirtySections, isStale, newDraft, toSave, type Draft, type SectionId } from './draft';
import { toMuError, type MuError } from './fields/muError';
import { recheckMu } from './recheck';

export type MuSettings = {
  /** What is on disk, as of the last load or save. */
  base?: KyrnSettings;
  draft?: Draft;
  available: AvailableModels;
  dirty: Set<SectionId>;
  loading: boolean;
  saving: boolean;
  /** Why loading or saving failed; `stale` when another program changed the files since they were loaded. */
  error?: MuError & { stale: boolean };
  /** Counts discards and loads: sections are drawn afresh on each, so no field keeps a choice that was dropped. */
  generation: number;
  edit: (change: (draft: Draft) => Draft) => void;
  editSettings: (change: (settings: KyrnSettings) => KyrnSettings) => void;
  reload: () => void;
  discard: () => void;
  save: () => Promise<boolean>;
};

const NOTHING: AvailableModels = { providers: [], thinkingLevels: [] };

/** One draft for the whole settings area: sections edit their part, one bar saves them all under one revision. */
export function useMuSettings(): MuSettings {
  const [base, setBase] = useState<KyrnSettings>();
  const [draft, setDraft] = useState<Draft>();
  const [available, setAvailable] = useState<AvailableModels>(NOTHING);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MuSettings['error']>();
  const [generation, setGeneration] = useState(0);

  const reload = useCallback(() => {
    setLoading(true);
    setError(undefined);
    void kyrnBridge.settings
      .invoke()
      .then(unwrap)
      .then(completeSettings)
      .then((value) => {
        setBase(value);
        setDraft(newDraft(value));
        setGeneration((now) => now + 1);
      })
      .catch((cause: unknown) => setError({ ...toMuError(cause), stale: false }))
      .finally(() => setLoading(false));
    // What is usable right now is a nicety: without it the section still works.
    void kyrnBridge.availableModels
      .invoke()
      .then(unwrap)
      .then(setAvailable)
      .catch(() => setAvailable(NOTHING));
  }, []);
  useEffect(reload, [reload]);

  const edit = useCallback((change: (draft: Draft) => Draft) => setDraft((now) => (now ? change(now) : now)), []);
  const editSettings = useCallback(
    (change: (settings: KyrnSettings) => KyrnSettings) => edit((now) => ({ ...now, settings: change(now.settings) })),
    [edit]
  );
  const discard = useCallback(() => {
    setError(undefined);
    setDraft(base ? newDraft(base) : undefined);
    setGeneration((now) => now + 1);
  }, [base]);

  const save = useCallback(async () => {
    if (!draft) return false;
    setSaving(true);
    setError(undefined);
    // The send boxes show the model a new conversation starts with: they read it again once a new one is saved.
    const newDefault = base ? dirtySections(base, draft).has('defaultModel') : false;
    try {
      const saved = completeSettings(unwrap(await kyrnBridge.save.invoke(toSave(draft, base))));
      setBase(saved);
      setDraft(newDraft(saved));
      void recheckMu();
      if (newDefault) void mutate('mu.defaultModel');
      return true;
    } catch (cause) {
      const failure = toMuError(cause);
      setError({ ...failure, stale: isStale(failure) });
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, base]);

  const dirty = useMemo(() => (base && draft ? dirtySections(base, draft) : new Set<SectionId>()), [base, draft]);
  return {
    base,
    draft,
    available,
    dirty,
    loading,
    saving,
    error,
    generation,
    edit,
    editSettings,
    reload,
    discard,
    save,
  };
}

const MuSettingsContext = createContext<MuSettings | undefined>(undefined);

/**
 * One draft for every settings page. It sits around the settings routes, above the pages, so a page left for another
 * one (a route change draws the page afresh) keeps what was typed and not saved, until the settings are left.
 */
export function MuSettingsProvider({ children }: { children?: ReactNode }) {
  return createElement(MuSettingsContext.Provider, { value: useMuSettings() }, children);
}

/** The draft the settings pages share; undefined outside {@link MuSettingsProvider}. */
export const useSharedMuSettings = (): MuSettings | undefined => useContext(MuSettingsContext);
