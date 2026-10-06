import React, { useState } from 'react';
import { Alert, Button, Message, Spin } from '@arco-design/web-react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { formatNameList } from '@/renderer/services/i18n/list';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { DETAIL_AREAS, SETTINGS_PAGES, detailsPageOf, type DetailArea } from '../settingsNav';
import { SECTIONS, areaOf, manifestOf, type SectionId } from './draft';
import MuErrorMessage from './fields/MuErrorMessage';
import DetailsSection from './sections/DetailsSection';
import CoreFeaturesSection, { FeatureOptions } from './sections/FeaturesSection';
import JudgesSection, { JudgeOrderSection } from './sections/JudgesSection';
import ProvidersSection, { BoardModelSection, DefaultModelSection } from './sections/ModelsSection';
import { useMuSettings, useSharedMuSettings, type MuSettings } from './useMuSettings';
import styles from './SettingsArea.module.css';

/** mu's own entries of the settings rail, in the rail's order: each is a page of this area. */
export const MU_PAGE_IDS = [
  'providers',
  'default-model',
  'board-model',
  'judges',
  'judge-order',
  'features',
  ...DETAIL_AREAS.map(detailsPageOf),
] as const;
export type MuPageId = (typeof MU_PAGE_IDS)[number];

export const isMuPage = (id: string): id is MuPageId => (MU_PAGE_IDS as readonly string[]).includes(id);

/** The area of the details a page shows, for a page of the details. */
const detailAreaOf = (page: MuPageId): DetailArea | undefined =>
  DETAIL_AREAS.find((area) => detailsPageOf(area) === page);

/** A page's name where it stands alone, as the rail's palette and title give it. */
const pageLabelKey = (id: MuPageId): string => SETTINGS_PAGES.find((page) => page.id === id)?.labelKey ?? id;

/** The parts of the draft each page edits: its dot in the list of pages when one of them has unsaved changes. */
const pageSections = (page: MuPageId): SectionId[] => {
  if (page === 'providers') return ['providers'];
  if (page === 'default-model') return ['defaultModel'];
  if (page === 'board-model') return ['boardModel'];
  if (page === 'judges' || page === 'judge-order') return ['judges'];
  if (page === 'features') return ['features'];
  return page === 'details-context' ? ['decisions', 'features', 'context'] : ['decisions', 'features'];
};

/**
 * What the area shows: one page; on a page of the details, the options of one feature, and which page of them (from
 * 1) when they fill more than one; or the row of one feature, scrolled to and marked for a moment.
 */
export type AreaView = { page: MuPageId; feature?: string; part?: number; focus?: string };

type SettingsAreaProps = {
  /** From the route: this page alone, with no list of pages (the settings rail is the list). */
  page?: MuPageId;
  /** On a page of the details: the feature whose options are open. */
  feature?: string;
  /** With a feature: the page of its options shown. */
  part?: number;
  /** On a page of the details: the feature whose row to scroll to. */
  focus?: string;
  /** A move made inside a routed page: to a feature's options, back to its page, to a feature's row elsewhere. */
  onView?: (view: AreaView) => void;
};

/**
 * Everything mu can be told: providers, the default model, the board's model, the judges and their order, the core
 * features and the details (every feature with the decision points it asks), the context. They share one draft and
 * one save, because the files behind them share one revision.
 *
 * In the settings the page comes from the route, and the draft from {@link MuSettingsProvider} around every settings
 * page: a change typed on one page is still there, unsaved, on the next. Alone (no route), the area loads its own
 * draft and shows a list of its pages to pick from.
 */
export default function SettingsArea(props: SettingsAreaProps = {}) {
  const shared = useSharedMuSettings();
  return shared ? <Area {...props} mu={shared} /> : <OwnDraft {...props} />;
}

function OwnDraft(props: SettingsAreaProps) {
  return <Area {...props} mu={useMuSettings()} />;
}

function Area({ page: routed, feature, part, focus, onView, mu }: SettingsAreaProps & { mu: MuSettings }) {
  const { t, i18n } = useTranslation();
  // The hook form needs no global React adapter, unlike the static Message.
  const [message, messageHolder] = Message.useMessage();
  const [picked, setPicked] = useState<AreaView>({ page: 'providers' });
  const view: AreaView = routed ? { page: routed, feature, part, focus } : picked;
  const go = (next: AreaView) => (routed ? onView?.(next) : setPicked(next));
  const { base, draft, dirty, error } = mu;
  const manifest = manifestOf(base);

  const save = async () => {
    if (await mu.save()) message.success?.(t('mu.save.saved'));
  };

  let content: React.ReactNode = null;
  if (base && draft) {
    const { settings } = draft;
    const { page } = view;
    const area = detailAreaOf(page);
    const onKey = (variable: string, value: string) =>
      mu.edit((now) => ({ ...now, judgeKeys: { ...now.judgeKeys, [variable]: value } }));
    if (page === 'providers')
      content = <ProvidersSection draft={draft} base={base} available={mu.available} onDraft={mu.edit} />;
    else if (page === 'default-model')
      content = <DefaultModelSection draft={draft} base={base} available={mu.available} onDraft={mu.edit} />;
    else if (page === 'board-model')
      content = <BoardModelSection draft={draft} base={base} available={mu.available} onDraft={mu.edit} />;
    else if (page === 'judges')
      content = <JudgesSection draft={draft} base={base} onChange={mu.editSettings} onKey={onKey} />;
    else if (page === 'judge-order')
      content = <JudgeOrderSection draft={draft} base={base} onChange={mu.editSettings} onKey={onKey} />;
    else if (page === 'features')
      content = (
        <CoreFeaturesSection
          settings={settings}
          manifest={manifest}
          onChange={mu.editSettings}
          onDetails={(name) => go({ page: detailsPageOf(areaOf(manifest, { name })), focus: name })}
        />
      );
    else if (area && view.feature) {
      const { feature: name } = view;
      content = (
        <FeatureOptions
          backTitle={t(`mu.pages.details.${area}`)}
          name={name}
          part={view.part}
          settings={settings}
          manifest={manifest}
          onChange={mu.editSettings}
          onBack={() => go({ page })}
          onPart={(next) => go({ page, feature: name, part: next })}
        />
      );
    } else if (area)
      content = (
        <DetailsSection
          area={area}
          settings={settings}
          base={base}
          manifest={manifest}
          onChange={mu.editSettings}
          onOpen={(name) => go({ page, feature: name })}
          focus={view.focus}
        />
      );
  }

  return (
    <div className={styles.area} data-testid='kyrn-settings'>
      {messageHolder}
      {/* Not sticky: the section list is what stays in view here. */}
      {routed ? null : <SettingsPageHeader sticky={false} title={t('mu.title')} description={t('mu.description')} />}
      {base?.harness.status === 'unsupported' ? (
        <Alert type='warning' content={t('mu.harness.unsupported', { version: base.harness.version })} />
      ) : null}
      {!base || !draft ? (
        error ? (
          <Alert
            type='error'
            title={t('mu.load.failed')}
            content={<MuErrorMessage error={error} />}
            action={<Button onClick={mu.reload}>{t('mu.reload')}</Button>}
          />
        ) : (
          <Spin />
        )
      ) : (
        <div className={classNames(styles.body, routed && styles.bodyRouted)}>
          {routed ? null : (
            <div className={styles.nav} role='tablist' aria-label={t('mu.title')}>
              {MU_PAGE_IDS.map((id) => (
                <div
                  key={id}
                  role='tab'
                  tabIndex={0}
                  aria-selected={view.page === id}
                  data-testid={`mu-nav-${id}`}
                  className={classNames(styles.navItem, view.page === id && styles.navItemActive)}
                  onClick={() => setPicked({ page: id })}
                  onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && setPicked({ page: id })}
                >
                  <span className={styles.navLabel}>{t(pageLabelKey(id))}</span>
                  {pageSections(id).some((section) => dirty.has(section)) ? (
                    <span className={styles.dot} aria-label={t('mu.save.unsavedDot')} />
                  ) : null}
                </div>
              ))}
            </div>
          )}
          <div className={styles.content} role={routed ? undefined : 'tabpanel'}>
            <React.Fragment key={mu.generation}>{content}</React.Fragment>
            {dirty.size || error ? (
              <div className={styles.saveBar} data-testid='mu-save-bar'>
                <span className={styles.saveText}>
                  {dirty.size
                    ? t('mu.save.unsaved', {
                        sections: formatNameList(
                          SECTIONS.filter((id) => dirty.has(id)).map((id) => t(`mu.sections.${id}`)),
                          i18n.language
                        ),
                      })
                    : t('mu.save.nothing')}
                  {/* When a change applies: said once, here, where a change is about to be saved. */}
                  <span className={styles.saveNote}>{t('mu.applyNote')}</span>
                </span>
                {error?.stale ? (
                  <Button size='small' onClick={mu.reload}>
                    {t('mu.reload')}
                  </Button>
                ) : null}
                <Button size='small' disabled={mu.saving || !dirty.size} onClick={mu.discard}>
                  {t('mu.save.discard')}
                </Button>
                <Button
                  size='small'
                  type='primary'
                  loading={mu.saving}
                  disabled={!dirty.size}
                  onClick={() => void save()}
                >
                  {t('common.save')}
                </Button>
                {error ? (
                  <div className={styles.saveError} role='alert'>
                    {error.stale ? (
                      t('mu.save.stale')
                    ) : (
                      <MuErrorMessage
                        error={error}
                        manifest={manifest}
                        frame={(reason) => t('mu.save.failed', { reason })}
                      />
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
