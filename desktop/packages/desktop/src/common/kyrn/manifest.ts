/**
 * What the harness says about itself: every decision point and every feature with its options, in Chinese and
 * English at least. The types mirror `packages/kyrn-judge/src/manifest.ts` of the harness repository (copied, not imported:
 * the two repositories are separate). The settings screen renders whatever the manifest contains, so a decision or
 * a feature added to the harness shows up here without a change to the desktop.
 */

/**
 * A text in the harness's words. Chinese and English are always there; a newer harness may add exact locales
 * ('zh-TW', 'ja-JP') or base languages ('ja', 'de'), which `localized` prefers. The desktop's own translations never
 * come from here.
 */
export type Localized = { zh: string; en: string; [locale: string]: string };

export type DecisionMode = 'off' | 'shadow' | 'active';

export type DecisionInfo = {
  /** The spec id, which is also the key under `modes` in mu.json. */
  id: string;
  group: string;
  /** The feature that asks it: switching that feature off silences the decision. */
  feature: string;
  title: Localized;
  summary: Localized;
  /**
   * The point's own built-in mode, when the harness gives it one: it keeps that mode whatever the default mode says,
   * until mu.json sets one for the point. Absent (and in a harness from before it): the point follows the default mode.
   */
  defaultMode?: DecisionMode;
};

type OptionBase = { key: string; label: Localized; help?: Localized };

export type OptionInfo =
  | (OptionBase & { kind: 'boolean'; default: boolean })
  | (OptionBase & { kind: 'number'; default: number; min?: number; max?: number; unit?: Localized })
  | (OptionBase & { kind: 'text'; default: string })
  | (OptionBase & { kind: 'list'; default: string[] })
  | (OptionBase & { kind: 'numbers'; default: number[] })
  | (OptionBase & { kind: 'choice'; default: string; choices: { value: string; label: Localized }[] });

export type OptionValue = boolean | number | string | string[] | number[];

export type FeatureInfo = {
  /** The key under `features` in mu.json. `false` there switches the feature off. */
  name: string;
  title: Localized;
  summary: Localized;
  defaultEnabled: boolean;
  beta?: boolean;
  options: OptionInfo[];
};

export type HarnessManifest = {
  version: 1;
  groups: Record<string, Localized>;
  modes: { value: DecisionMode; label: Localized; help: Localized }[];
  decisions: DecisionInfo[];
  features: FeatureInfo[];
};

/** `missing`: the harness has no manifest.json (too old). `unsupported`: it has one this app cannot read. */
export type HarnessState =
  | { status: 'ok'; manifest: HarnessManifest }
  | { status: 'missing' }
  | { status: 'unsupported'; version: string };

/** A feature as the settings screen edits it: one value for every option the manifest describes. */
export type FeatureState = { enabled: boolean; options: Record<string, OptionValue> };

export const MANIFEST_VERSION = 1;
export const DECISION_MODES: DecisionMode[] = ['active', 'shadow', 'off'];
const LIST_LIMIT = 64;
const TEXT_LIMIT = 1000;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** A BCP 47 tag as the harness writes one: 'ja', 'zh-TW', 'pt-BR'. */
const LOCALE_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const isLocalized = (value: unknown): value is Localized =>
  isRecord(value) && typeof value.zh === 'string' && typeof value.en === 'string';
/** Only `zh`, `en` and other locales with a text are kept: anything else in the entry is not a translation. */
function readLocalized(value: Localized): Localized {
  const text: Localized = { zh: value.zh, en: value.en };
  for (const [locale, entry] of Object.entries(value))
    if (LOCALE_TAG.test(locale) && typeof entry === 'string' && entry) text[locale] = entry;
  return text;
}
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isNumbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));
const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function parseOption(value: unknown): OptionInfo | undefined {
  if (!isRecord(value) || typeof value.key !== 'string' || !value.key || !isLocalized(value.label)) return undefined;
  const base: OptionBase = {
    key: value.key,
    label: readLocalized(value.label),
    ...(isLocalized(value.help) ? { help: readLocalized(value.help) } : {}),
  };
  const fallback = value.default;
  if (value.kind === 'boolean' && typeof fallback === 'boolean') return { ...base, kind: 'boolean', default: fallback };
  if (value.kind === 'text' && typeof fallback === 'string') return { ...base, kind: 'text', default: fallback };
  if (value.kind === 'list' && isStrings(fallback)) return { ...base, kind: 'list', default: fallback };
  if (value.kind === 'numbers' && isNumbers(fallback)) return { ...base, kind: 'numbers', default: fallback };
  if (value.kind === 'number' && typeof fallback === 'number')
    return {
      ...base,
      kind: 'number',
      default: fallback,
      min: optionalNumber(value.min),
      max: optionalNumber(value.max),
      ...(isLocalized(value.unit) ? { unit: readLocalized(value.unit) } : {}),
    };
  if (value.kind === 'choice' && typeof fallback === 'string' && Array.isArray(value.choices)) {
    const choices = value.choices
      .filter(
        (choice): choice is { value: string; label: Localized } =>
          isRecord(choice) && typeof choice.value === 'string' && isLocalized(choice.label)
      )
      .map((choice) => ({ value: choice.value, label: readLocalized(choice.label) }));
    if (choices.length) return { ...base, kind: 'choice', default: fallback, choices };
  }
  // A kind this app does not know: the option is left out, and its value in the file is left alone.
  return undefined;
}

/**
 * Reads manifest.json defensively: it comes from another repository, possibly a newer or an older one.
 * An entry that does not have the expected shape is left out instead of failing the whole screen.
 */
export function parseManifest(value: unknown): HarnessState {
  if (!isRecord(value)) return { status: 'missing' };
  if (value.version !== MANIFEST_VERSION) return { status: 'unsupported', version: String(value.version ?? '') };
  const groups: Record<string, Localized> = {};
  for (const [id, label] of Object.entries(isRecord(value.groups) ? value.groups : {}))
    if (isLocalized(label)) groups[id] = readLocalized(label);
  const modes = (Array.isArray(value.modes) ? value.modes : [])
    .filter(
      (mode): mode is HarnessManifest['modes'][number] =>
        isRecord(mode) &&
        DECISION_MODES.includes(mode.value as DecisionMode) &&
        isLocalized(mode.label) &&
        isLocalized(mode.help)
    )
    .map((mode) => ({ value: mode.value, label: readLocalized(mode.label), help: readLocalized(mode.help) }));
  const decisions = (Array.isArray(value.decisions) ? value.decisions : [])
    .filter(
      (decision): decision is DecisionInfo =>
        isRecord(decision) &&
        typeof decision.id === 'string' &&
        decision.id !== 'default' &&
        typeof decision.group === 'string' &&
        typeof decision.feature === 'string' &&
        isLocalized(decision.title) &&
        isLocalized(decision.summary)
    )
    .map((decision) => {
      const read: DecisionInfo = {
        id: decision.id,
        group: decision.group,
        feature: decision.feature,
        title: readLocalized(decision.title),
        summary: readLocalized(decision.summary),
      };
      if (decision.defaultMode && DECISION_MODES.includes(decision.defaultMode))
        read.defaultMode = decision.defaultMode;
      return read;
    });
  const features: FeatureInfo[] = [];
  for (const feature of Array.isArray(value.features) ? value.features : []) {
    if (!isRecord(feature) || typeof feature.name !== 'string' || !feature.name) continue;
    if (!isLocalized(feature.title) || !isLocalized(feature.summary)) continue;
    features.push({
      name: feature.name,
      title: readLocalized(feature.title),
      summary: readLocalized(feature.summary),
      defaultEnabled: feature.defaultEnabled !== false,
      ...(feature.beta === true ? { beta: true } : {}),
      options: (Array.isArray(feature.options) ? feature.options : [])
        .map(parseOption)
        .filter((option): option is OptionInfo => option !== undefined),
    });
  }
  return { status: 'ok', manifest: { version: 1, groups, modes, decisions, features } };
}

/**
 * The mode a decision point has when mu.json sets none for it: its built-in one, else the default mode. With the
 * default mode off, the built-in one gives way too (the kernel's DecisionEngine.getMode): no point asks the judge.
 */
export function defaultModeOf(decision: DecisionInfo, mode: DecisionMode): DecisionMode {
  return mode === 'off' ? 'off' : (decision.defaultMode ?? mode);
}

/**
 * The text for the app language: the exact locale first ('zh-TW'), then its base language ('zh'), then English.
 * So zh-TW reads the harness's Simplified Chinese until the harness has Traditional, and ja-JP reads English until
 * it has Japanese. Locale keys match without regard to case.
 */
export function localized(text: Localized | undefined, language: string): string {
  if (!text) return '';
  const entries = Object.entries(text);
  const pick = (tag: string): string | undefined =>
    tag ? entries.find(([locale, value]) => locale.toLowerCase() === tag && value)?.[1] : undefined;
  const exact = (language ?? '').trim().toLowerCase();
  return pick(exact) ?? pick(exact.split('-')[0]) ?? text.en;
}

/** Every text of an entry, in all its languages: search finds an entry by any of them. */
export function localizedTexts(text: Localized | undefined): string[] {
  return text ? Object.values(text) : [];
}

export function optionEquals(a: OptionValue | undefined, b: OptionValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => item === b[i]);
  return a === b;
}

/** Why a value cannot be saved for this option, or undefined when it can. The codes are translated by the screen. */
export type OptionProblem = 'type' | 'range' | 'choice' | 'length';
export function checkOption(option: OptionInfo, value: unknown): OptionProblem | undefined {
  switch (option.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'type';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'type';
      return (option.min !== undefined && value < option.min) || (option.max !== undefined && value > option.max)
        ? 'range'
        : undefined;
    case 'text':
      if (typeof value !== 'string') return 'type';
      return value.length > TEXT_LIMIT ? 'length' : undefined;
    case 'choice':
      if (typeof value !== 'string') return 'type';
      return option.choices.some((choice) => choice.value === value) ? undefined : 'choice';
    case 'list':
      if (!isStrings(value)) return 'type';
      return value.length > LIST_LIMIT || value.some((item) => !item.trim() || item.length > TEXT_LIMIT)
        ? 'length'
        : undefined;
    case 'numbers':
      if (!isNumbers(value)) return 'type';
      return value.length > LIST_LIMIT ? 'length' : undefined;
  }
}

/** The state of a feature nobody has configured. */
export function defaultFeatureState(feature: FeatureInfo): FeatureState {
  const options: Record<string, OptionValue> = {};
  for (const option of feature.options)
    options[option.key] = Array.isArray(option.default) ? ([...option.default] as OptionValue) : option.default;
  return { enabled: feature.defaultEnabled, options };
}

export function isDefaultFeatureState(feature: FeatureInfo, state: FeatureState): boolean {
  return (
    state.enabled === feature.defaultEnabled &&
    feature.options.every((option) => optionEquals(state.options[option.key], option.default))
  );
}

export function sameFeatureState(feature: FeatureInfo, a: FeatureState, b: FeatureState): boolean {
  return (
    a.enabled === b.enabled &&
    feature.options.every((option) => optionEquals(a.options[option.key], b.options[option.key]))
  );
}
