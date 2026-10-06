import type { TFunction } from 'i18next';
import { MCP_SOURCES, SKILL_SOURCES, type McpSource, type SkillSource } from '@/common/kyrn/capabilities';
import { isKyrnErrorCode, type KyrnErrorCode, type KyrnErrorParams } from '@/common/kyrn/errors';
import { localized, type HarnessManifest, type OptionProblem } from '@/common/kyrn/manifest';
import { formatNumber } from '@/renderer/services/i18n/format';
import { formatNameList } from '@/renderer/services/i18n/list';

/** A failure as mu's screens keep it: the code the main process gave, its params, and its plain English message. */
export type MuError = { code: KyrnErrorCode; params: KyrnErrorParams; message: string };

/** What to show: a translated sentence, and the raw message as a secondary detail where it says more ('' if not). */
export type MuErrorText = { text: string; detail: string };

/** Any caught value as a `MuError`. A `KyrnError` from `unwrap` keeps its code; anything else is `unknown`. */
export function toMuError(cause: unknown): MuError {
  const record = (cause !== null && typeof cause === 'object' ? cause : {}) as Record<string, unknown>;
  const message =
    cause instanceof Error ? cause.message : typeof record.message === 'string' ? record.message : String(cause);
  const params = record.params !== null && typeof record.params === 'object' ? record.params : {};
  return {
    code: isKyrnErrorCode(record.code) ? record.code : 'unknown',
    params: params as KyrnErrorParams,
    message,
  };
}

const OPTION_PROBLEMS: readonly OptionProblem[] = ['type', 'range', 'choice', 'length'];
/** Where a skill or MCP server can come from, each with words in `mu.capabilities.from`. */
const CAPABILITY_SOURCES = [...new Set<SkillSource | McpSource>([...SKILL_SOURCES, ...MCP_SOURCES])];
const MCP_FIELDS = ['command', 'url', 'env', 'headers'] as const;
/** A sentence that says everything: no detail under it. */
const only = (text: string): MuErrorText => ({ text, detail: '' });
const word = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** The option's label in the app language, found through the manifest; its dotted key when the manifest lacks it. */
function optionName(params: KyrnErrorParams, language: string, manifest?: HarnessManifest): string {
  const feature = manifest?.features.find((entry) => entry.name === params.feature);
  const option = feature?.options.find((entry) => entry.key === params.option);
  return option ? localized(option.label, language) : [word(params.feature), word(params.option)].join('.');
}

/**
 * The words for a failure in the app language. Codes whose sentence already says everything get no detail; a file,
 * backend or unexpected failure keeps its raw message (a JSON position, an OS error) as the detail.
 */
export function muErrorText(t: TFunction, language: string, error: MuError, manifest?: HarnessManifest): MuErrorText {
  const { params, message } = error;
  const withDetail = (text: string): MuErrorText => ({ text, detail: message });
  const number = (value: unknown): string => (typeof value === 'number' ? formatNumber(value, language) : word(value));
  switch (error.code) {
    case 'stale':
      return only(t('mu.save.stale'));
    case 'contextLimit':
      // The save bar is shared by every section, so the sentence names the setting.
      return only(t('mu.errors.contextLimit', { min: number(params.min), max: number(params.max) }));
    case 'credential':
      return only(t('mu.errors.credential'));
    case 'keyVariable':
      return only(t('mu.errors.keyVariable', { name: word(params.name) }));
    case 'sharedKey': {
      const ids = Array.isArray(params.providers) ? params.providers : [];
      return only(t('mu.errors.sharedKey', { providers: formatNameList(ids, language) }));
    }
    case 'pickBoth':
      return only(t('mu.errors.pickBoth'));
    case 'modelsUnreadable':
      return only(t('mu.errors.modelsUnreadable'));
    case 'modelsCommented':
      return only(t('mu.errors.modelsCommented'));
    case 'endpoint':
      return only(t('mu.endpointRule'));
    case 'judgeEndpoint':
      return only(t('mu.errors.judgeEndpoint'));
    case 'harnessOld':
      return only(t('mu.harness.tooOld'));
    case 'optionValue': {
      const problem = OPTION_PROBLEMS.find((code) => code === params.problem);
      if (!problem) return withDetail(t('mu.errors.invalid'));
      return only(t(`mu.errors.option.${problem}`, { name: optionName(params, language, manifest) }));
    }
    case 'invalidJson':
    case 'unreadable':
    case 'unwritable': {
      const file = word(params.file);
      if (!file) return withDetail(t('mu.errors.unknown'));
      return withDetail(t(`mu.errors.${error.code}`, { file }));
    }
    case 'runtimeOffline':
      return only(t('mu.errors.runtimeOffline'));
    case 'otherRegistration':
      return only(t('mu.errors.otherRegistration'));
    case 'installPath':
      return only(t('mu.errors.installPath'));
    case 'backend':
      return withDetail(t('mu.errors.backend', { status: word(params.status) }));
    case 'importMissing':
      return only(t('mu.errors.importMissing'));
    case 'importFailed':
      return withDetail(t('mu.errors.importFailed'));
    case 'skillInvalid':
      return only(t('mu.errors.skillInvalid'));
    case 'skillTooLarge':
      return only(t('mu.errors.skillTooLarge'));
    case 'skillName':
    case 'skillExists':
    case 'notFound':
    case 'mcpName':
    case 'mcpExists':
      return only(t(`mu.errors.${error.code}`, { name: word(params.name) }));
    case 'notMine': {
      const source = CAPABILITY_SOURCES.find((entry) => entry === params.source);
      return only(
        t('mu.errors.notMine', {
          name: word(params.name),
          source: source ? t(`mu.capabilities.from.${source}`) : word(params.source),
        })
      );
    }
    case 'mcpInvalid': {
      // A command's arguments are part of the command line the person typed.
      const field = MCP_FIELDS.find((entry) => entry === params.field) ?? 'command';
      return only(t(`mu.errors.mcpInvalid.${field}`));
    }
    case 'invalid':
      return withDetail(t('mu.errors.invalid'));
    case 'unknown':
      return withDetail(t('mu.errors.unknown'));
  }
}
