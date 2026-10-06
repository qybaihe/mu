import React from 'react';
import { Alert, Button, Switch } from '@arco-design/web-react';
import { ArrowLeft, Left, Right } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import {
  defaultFeatureState,
  isDefaultFeatureState,
  localized,
  type FeatureInfo,
  type FeatureState,
  type HarnessManifest,
  type Localized,
} from '@/common/kyrn/manifest';
import type { KyrnSettings } from '@/common/kyrn/types';
import OneLine from '@/renderer/components/settings/OneLine';
import { FEATURED_FEATURES, optionParts, setCompaction } from '../draft';
import OptionField from '../fields/OptionField';
import { ModifiedMark } from '../fields/Row';
import SectionShell from './SectionShell';
import styles from './sections.module.css';

/**
 * Options that have a place of their own in the settings, by feature, with the sentence that points there. The mode a
 * new conversation starts in has none: it is an option of the permission modes feature, on that feature's page.
 */
export const ELSEWHERE: Record<string, { key: string; where: string }> = {
  board: { key: 'model', where: 'mu.features.boardModelElsewhere' },
};

export type Change = (change: (settings: KyrnSettings) => KyrnSettings) => void;

/** A feature's options that are set on this feature's own page: the ones with a place elsewhere are not. */
export const ownOptions = (feature: FeatureInfo) =>
  feature.options.filter((option) => option.key !== ELSEWHERE[feature.name]?.key);

/** Writes a feature's state; the summary-free compaction carries the old beta flag along. */
export const setFeature = (onChange: Change, feature: FeatureInfo, state: FeatureState) =>
  onChange((now) => {
    const next = { ...now, features: { ...now.features, [feature.name]: state } };
    return feature.name === 'compaction' ? setCompaction(next, state.enabled) : next;
  });

/** Whether a feature's state differs from its default, leaving out an option set elsewhere. */
export const isModified = (feature: FeatureInfo, state: FeatureState) =>
  !isDefaultFeatureState({ ...feature, options: ownOptions(feature) }, state);

/** A feature's state as the draft has it, or its default when the draft has none. */
export const stateOf = (settings: KyrnSettings, feature: FeatureInfo): FeatureState =>
  settings.features[feature.name] ?? defaultFeatureState(feature);

type CoreFeaturesSectionProps = {
  settings: KyrnSettings;
  manifest?: HarnessManifest;
  onChange: Change;
  /** Opens the page of the details the feature is on, at its row. */
  onDetails: (feature: string) => void;
};

/**
 * The switches that say what mu is, one row each: its name, one sentence, its switch, and the way to its row among the
 * details, where its options and the decision points it asks are. The switch is the feature's one switch, shown here
 * too, not a second one.
 */
export default function CoreFeaturesSection({ settings, manifest, onChange, onDetails }: CoreFeaturesSectionProps) {
  const { t, i18n } = useTranslation();
  const say = (text?: Localized) => localized(text, i18n.language);
  const byName = new Map(manifest?.features.map((feature) => [feature.name, feature]));
  const features = FEATURED_FEATURES.map((name) => byName.get(name)).filter((feature): feature is FeatureInfo =>
    Boolean(feature)
  );

  return (
    <SectionShell id='features' title={t('mu.sections.coreFeatures')} description={t('mu.features.lead')}>
      {!manifest ? <Alert type='warning' content={t('mu.harness.tooOld')} /> : null}
      {manifest && !features.length ? <div className={styles.empty}>{t('mu.features.none')}</div> : null}
      {features.length ? (
        <div className={styles.plainList} data-testid='mu-feature-list-features'>
          {features.map((feature) => {
            const state = stateOf(settings, feature);
            const title = say(feature.title);
            return (
              <div key={feature.name} className={styles.plainRow} data-testid={`mu-feature-${feature.name}`}>
                <div className={styles.plainMain}>
                  <div className={styles.plainText}>
                    <div className={styles.plainTitle}>
                      <span>{title}</span>
                      {feature.beta ? <span className={styles.featureBeta}>{t('mu.features.beta')}</span> : null}
                      <ModifiedMark show={isModified(feature, state)} />
                    </div>
                    <OneLine text={say(feature.summary)} />
                  </div>
                  <div className={styles.featureControls}>
                    <Button
                      type='text'
                      size='small'
                      data-testid={`mu-feature-area-${feature.name}`}
                      aria-label={`${title}: ${t('mu.features.details')}`}
                      onClick={() => onDetails(feature.name)}
                    >
                      <span className={styles.featureOpen}>
                        {t('mu.features.details')}
                        <Right theme='outline' size='12' className='rtl-mirror' />
                      </span>
                    </Button>
                    <Switch
                      size='small'
                      aria-label={title}
                      checked={state.enabled}
                      onChange={(enabled) => setFeature(onChange, feature, { ...state, enabled })}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </SectionShell>
  );
}

type FeatureOptionsProps = {
  /** The name of the page the feature's row is on: the way back says where it leads. */
  backTitle: string;
  name: string;
  /** Which page of the options is shown, from 1, for a feature with more than a page of them. */
  part?: number;
  settings: KyrnSettings;
  manifest?: HarnessManifest;
  onChange: Change;
  /** Back to the page the feature's row is on. */
  onBack: () => void;
  /** To another page of the same feature's options. */
  onPart?: (part: number) => void;
};

/**
 * The page of one feature: its switch next to its name, then its options, each drawn from its description alone. A
 * feature with more options than a page holds has them on consecutive pages (see {@link optionParts}), each with the
 * way to the one before and after. An option with a place of its own elsewhere is pointed to, not repeated.
 */
export function FeatureOptions({
  backTitle,
  name,
  part = 1,
  settings,
  manifest,
  onChange,
  onBack,
  onPart,
}: FeatureOptionsProps) {
  const { t, i18n } = useTranslation();
  const say = (text?: Localized) => localized(text, i18n.language);
  const back = (
    <div>
      <Button type='text' size='small' data-testid='mu-feature-back' onClick={onBack}>
        <span className={styles.featureOpen}>
          <ArrowLeft theme='outline' size='14' className='rtl-mirror' />
          {backTitle}
        </span>
      </Button>
    </div>
  );
  const feature = manifest?.features.find((each) => each.name === name);
  if (!feature)
    return (
      <SectionShell id='feature' title={backTitle} back={back}>
        <div className={styles.empty}>{t('mu.features.noSuchFeature')}</div>
      </SectionShell>
    );

  const state = stateOf(settings, feature);
  const elsewhere = ELSEWHERE[feature.name];
  const own = ownOptions(feature);
  const parts = optionParts(own);
  // A link to a page past the last one (the harness dropped options since) shows the last.
  const at = Math.min(Math.max(Math.trunc(part), 1), parts.length);
  const modified = isModified(feature, state);
  const reset = (): FeatureState => {
    const next = defaultFeatureState(feature);
    // An option set elsewhere is not reset from here: it is not on this page.
    if (elsewhere && elsewhere.key in state.options) next.options[elsewhere.key] = state.options[elsewhere.key];
    return next;
  };
  const title = say(feature.title);

  return (
    <SectionShell
      id={`feature-${feature.name}`}
      title={title}
      description={say(feature.summary)}
      back={back}
      actions={
        <Switch
          size='small'
          aria-label={title}
          checked={state.enabled}
          onChange={(enabled) => setFeature(onChange, feature, { ...state, enabled })}
        />
      }
    >
      {elsewhere && own.length < feature.options.length ? (
        <div className={styles.plainNote}>{t(elsewhere.where)}</div>
      ) : null}
      {own.length ? (
        <div
          className={classNames(styles.list, !state.enabled && styles.dim)}
          data-testid={`mu-feature-details-${feature.name}`}
        >
          {parts[at - 1].map((option) => (
            <OptionField
              key={option.key}
              scope={feature.name}
              option={option}
              value={state.options[option.key]}
              onChange={(value) =>
                setFeature(onChange, feature, { ...state, options: { ...state.options, [option.key]: value } })
              }
            />
          ))}
        </div>
      ) : (
        <div className={styles.empty}>{t('mu.features.noOptions')}</div>
      )}
      {parts.length > 1 ? (
        <div className={styles.featureParts} data-testid='mu-feature-parts'>
          <span>{t('mu.features.part', { part: at, parts: parts.length })}</span>
          <Button
            size='small'
            type='text'
            disabled={at === 1}
            data-testid='mu-feature-part-previous'
            onClick={() => onPart?.(at - 1)}
          >
            <span className={styles.featureOpen}>
              <Left theme='outline' size='12' className='rtl-mirror' />
              {t('mu.features.previousPart')}
            </span>
          </Button>
          <Button
            size='small'
            type='text'
            disabled={at === parts.length}
            data-testid='mu-feature-part-next'
            onClick={() => onPart?.(at + 1)}
          >
            <span className={styles.featureOpen}>
              {t('mu.features.nextPart')}
              <Right theme='outline' size='12' className='rtl-mirror' />
            </span>
          </Button>
        </div>
      ) : null}
      {modified ? (
        <div className={styles.featureReset}>
          <ModifiedMark show />
          <Button size='small' type='text' onClick={() => setFeature(onChange, feature, reset())}>
            {t('mu.features.reset')}
          </Button>
        </div>
      ) : null}
    </SectionShell>
  );
}
