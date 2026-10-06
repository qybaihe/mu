import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Switch } from '@arco-design/web-react';
import { Right } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import {
  localized,
  type DecisionInfo,
  type DecisionMode,
  type FeatureInfo,
  type HarnessManifest,
  type Localized,
} from '@/common/kyrn/manifest';
import type { KyrnSettings } from '@/common/kyrn/types';
import OneLine from '@/renderer/components/settings/OneLine';
import type { DetailArea } from '../../settingsNav';
import { areaRows } from '../draft';
import { shownMode } from '../fields/mode';
import { ModifiedMark } from '../fields/Row';
import ContextRows from './ContextRows';
import { ELSEWHERE, isModified, ownOptions, setFeature, stateOf, type Change } from './FeaturesSection';
import SectionShell from './SectionShell';
import styles from './sections.module.css';

/** How long the row a link pointed to stays marked after the page scrolled to it. */
const FOCUS_MS = 1600;

type DetailsSectionProps = {
  area: DetailArea;
  settings: KyrnSettings;
  base: KyrnSettings;
  manifest?: HarnessManifest;
  onChange: Change;
  /** Opens the page of one feature's options. */
  onOpen: (feature: string) => void;
  /** The feature whose row the page scrolls to and marks for a moment: where the core features page led. */
  focus?: string;
};

/**
 * One area of the details: every feature that acts there, one row each with its switch and the way to its options,
 * and under it, indented, each decision point it asks the judge, with a switch for whether Jev's verdict there takes
 * effect. A point of a feature that is off is not asked: its row is greyed and says so. A point whose feature the
 * harness does not describe is a row of its own. The context page starts with the compaction settings.
 */
export default function DetailsSection({
  area,
  settings,
  base,
  manifest,
  onChange,
  onOpen,
  focus,
}: DetailsSectionProps) {
  const { t, i18n } = useTranslation();
  const say = (text?: Localized) => localized(text, i18n.language);
  const rows = areaRows(manifest, area);
  const elements = useRef(new Map<string, HTMLElement>());
  const [lit, setLit] = useState<string>();

  useEffect(() => {
    if (!focus) return undefined;
    elements.current.get(focus)?.scrollIntoView?.({ block: 'center' });
    setLit(focus);
    const timer = setTimeout(() => setLit(undefined), FOCUS_MS);
    return () => clearTimeout(timer);
  }, [focus]);

  const keep = (name: string) => (element: HTMLElement | null) => {
    if (element) elements.current.set(name, element);
    else elements.current.delete(name);
  };

  const setMode = (id: string, mode: DecisionMode | undefined) =>
    onChange((now) => {
      const { [id]: _removed, ...rest } = now.decisionModes;
      return { ...now, decisionModes: mode ? { ...rest, [id]: mode } : rest };
    });

  const decisionRow = (decision: DecisionInfo, feature: FeatureInfo | undefined, off: boolean) => {
    const point = say(decision.title);
    const own = settings.decisionModes[decision.id];
    // Under its feature the row needs no name when the point is the feature's own: it is the judge's say in it.
    const title =
      feature && say(feature.title) === point ? t('mu.details.askJev') : t('mu.details.askJevAbout', { point });
    const label = t('mu.details.askJevAbout', { point });
    return (
      <div
        key={decision.id}
        className={feature ? undefined : styles.plainRow}
        data-testid={`mu-decision-${decision.id}`}
      >
        <div className={classNames(styles.plainMain, feature && styles.nestedMain, off && styles.plainMuted)}>
          <div className={styles.plainText}>
            <div className={feature ? styles.nestedTitle : styles.plainTitle}>{feature ? title : point}</div>
            <OneLine text={say(decision.summary)} />
            {off ? <div className={styles.plainNote}>{t('mu.details.featureOff')}</div> : null}
          </div>
          <div className={styles.plainControl}>
            <Switch
              size='small'
              aria-label={label}
              disabled={off}
              checked={shownMode(own ?? settings.mode) === 'active'}
              onChange={(on) => setMode(decision.id, on ? 'active' : 'off')}
            />
            {own ? (
              <Button
                size='mini'
                type='text'
                disabled={off}
                data-testid={`mu-decision-default-${decision.id}`}
                onClick={() => setMode(decision.id, undefined)}
              >
                {t('mu.decisions.useDefault', {
                  mode: t(shownMode(settings.mode) === 'active' ? 'mu.modes.active' : 'mu.modes.off'),
                })}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  return (
    <SectionShell
      id={`details-${area}`}
      title={t(`mu.pages.details.${area}`)}
      description={t(area === 'context' ? 'mu.context.lead' : 'mu.details.lead')}
    >
      {area === 'context' ? <ContextRows settings={settings} base={base} onChange={onChange} /> : null}
      {!manifest ? <Alert type='warning' content={t('mu.harness.tooOld')} /> : null}
      {manifest && !rows.length ? <div className={styles.empty}>{t('mu.features.none')}</div> : null}
      {rows.length ? (
        <div className={styles.plainList} data-testid={`mu-feature-list-${area}`}>
          {rows.map((row) => {
            const { feature } = row;
            if (!feature) return row.decisions.map((decision) => decisionRow(decision, undefined, false));
            const state = stateOf(settings, feature);
            const elsewhere = ELSEWHERE[feature.name];
            const own = ownOptions(feature);
            const title = say(feature.title);
            return (
              <div
                key={feature.name}
                ref={keep(feature.name)}
                className={classNames(styles.plainRow, lit === feature.name && styles.focused)}
                data-testid={`mu-feature-${feature.name}`}
                data-focused={lit === feature.name ? 'true' : undefined}
              >
                <div className={styles.plainMain}>
                  <div className={styles.plainText}>
                    <div className={styles.plainTitle}>
                      <span>{title}</span>
                      {feature.beta ? <span className={styles.featureBeta}>{t('mu.features.beta')}</span> : null}
                      <ModifiedMark show={isModified(feature, state)} />
                    </div>
                    <OneLine text={say(feature.summary)} />
                    {/* A feature whose one option lives elsewhere says where, instead of a page of nothing. */}
                    {elsewhere && !own.length ? <div className={styles.plainNote}>{t(elsewhere.where)}</div> : null}
                  </div>
                  <div className={styles.featureControls}>
                    {own.length ? (
                      <Button
                        type='text'
                        size='small'
                        data-testid={`mu-feature-open-${feature.name}`}
                        aria-label={`${title}: ${t('mu.features.options')}`}
                        onClick={() => onOpen(feature.name)}
                      >
                        <span className={styles.featureOpen}>
                          {t('mu.features.options')}
                          <Right theme='outline' size='12' className='rtl-mirror' />
                        </span>
                      </Button>
                    ) : null}
                    <Switch
                      size='small'
                      aria-label={title}
                      checked={state.enabled}
                      onChange={(enabled) => setFeature(onChange, feature, { ...state, enabled })}
                    />
                  </div>
                </div>
                {row.decisions.length ? (
                  <div className={styles.nestedList}>
                    {row.decisions.map((decision) => decisionRow(decision, feature, !state.enabled))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </SectionShell>
  );
}
