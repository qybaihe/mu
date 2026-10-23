import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { mutate } from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { summarize } from '@/renderer/components/kernel/kernelSummary';
import { KERNEL_SUMMARY_KEY } from '@/renderer/components/kernel/useKernelSummary';
import type { AvailableModels } from '@/common/kyrn/models';
import type { KyrnSettings } from '@/common/kyrn/types';
import {
  completeSettings,
  dirtySections,
  isStale,
  newDraft,
  rebaseDraft,
  toSave,
  type Draft,
  type SectionId,
} from './draft';
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
  /** Loads the files again, then makes `change` in the new draft (unsaved, as an edit is). */
  reloadWith: (change: (settings: KyrnSettings) => KyrnSettings) => void;
  /**
   * After mu's own command changed the files (mude): reads them again and keeps what the draft changed (see
   * `rebaseDraft`). Answers with the new base and draft, for a save that must not wait for the next render; undefined
   * when the files could not be read.
   */
  rebase: (judge: 'files' | 'draft') => Promise<{ base: KyrnSettings; draft: Draft } | undefined>;
  discard: () => void;
  /** Saves the draft; `from`, a base and draft just made by `rebase`, instead of this render's. */
  save: (from?: { base: KyrnSettings; draft: Draft }) => Promise<boolean>;
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

  // What `rebase` moves the draft from: the newest, whichever render last saw it.
  const latest = useRef<{ base?: KyrnSettings; draft?: Draft }>({});
  latest.current = { base, draft };

  const load = useCallback((change?: (settings: KyrnSettings) => KyrnSettings) => {
    setLoading(true);
    setError(undefined);
    void kyrnBridge.settings
      .invoke()
      .then(unwrap)
      .then(completeSettings)
      .then((value) => {
        setBase(value);
        setDraft(change ? { ...newDraft(value), settings: change(value) } : newDraft(value));
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
  const reload = useCallback(() => load(), [load]);
  const reloadWith = useCallback((change: (settings: KyrnSettings) => KyrnSettings) => load(change), [load]);
  useEffect(reload, [reload]);

  const rebase = useCallback(async (judge: 'files' | 'draft') => {
    try {
      const fresh = completeSettings(unwrap(await kyrnBridge.settings.invoke()));
      const { base: before, draft: now } = latest.current;
      const next = before && now ? rebaseDraft(before, now, fresh, judge) : newDraft(fresh);
      latest.current = { base: fresh, draft: next };
      setBase(fresh);
      setDraft(next);
      return { base: fresh, draft: next };
    } catch (cause) {
      setError({ ...toMuError(cause), stale: false });
      return undefined;
    }
  }, []);

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

  const save = useCallback(
    async (from?: { base: KyrnSettings; draft: Draft }) => {
      const draftNow = from?.draft ?? draft;
      const baseNow = from?.base ?? base;
      if (!draftNow) return false;
      setSaving(true);
      setError(undefined);
      // The send boxes show the model a new conversation starts with: they read it again once a new one is saved.
      const newDefault = baseNow ? dirtySections(baseNow, draftNow).has('defaultModel') : false;
      try {
        const saved = completeSettings(unwrap(await kyrnBridge.save.invoke(toSave(draftNow, baseNow))));
        setBase(saved);
        setDraft(newDraft(saved));
        void recheckMu();
        if (newDefault) void mutate('mu.defaultModel');
        // The kernel bar names the judge and counts the decision points that act.
        void mutate(KERNEL_SUMMARY_KEY, summarize(saved), { revalidate: false });
        return true;
      } catch (cause) {
        const failure = toMuError(cause);
        setError({ ...failure, stale: isStale(failure) });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [draft, base]
  );

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
    reloadWith,
    rebase,
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
