import React from 'react';
import { Input, Tag } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { CLM_DEFAULT_ADDRESS, CLM_DEFAULT_MODEL } from '@/common/kyrn/clm';
import { isSafeEndpoint } from '@/common/kyrn/models';
import type { JudgeSettings, KyrnSettings } from '@/common/kyrn/types';
import AionSelect from '@/renderer/components/base/AionSelect';
import { formatNumber } from '@/renderer/services/i18n/format';
import type { Draft } from '../draft';
import ChoiceTile from '../fields/ChoiceTile';
import Row from '../fields/Row';
import fieldStyles from '../fields/fields.module.css';
import {
  CLOUDFLARE_ACCOUNT_VARIABLE,
  choiceOf,
  classifierVariables,
  choose,
  clmKeyVariable,
  defaultModelOf,
  JEV_SERVICES,
  JUDGE_CHOICES,
  type JevService,
  type JudgeChoice,
  jevVariables,
  kindOf,
  profileFor,
  serviceOf,
  withJevService,
} from '../judgeChoice';
import ClmServerCheck from './ClmServerCheck';
import SectionShell, { Card, GroupTitle } from './SectionShell';
import LocalJudgePanel from './LocalJudgePanel';
import styles from './sections.module.css';

type JudgesSectionProps = {
  draft: Draft;
  base: KyrnSettings;
  onChange: (change: (settings: KyrnSettings) => KyrnSettings) => void;
  onKey: (variable: string, value: string) => void;
};

/**
 * The judges page. First the choice most people make once: which judge answers the small questions mu asks while it
 * works, and under it what that choice needs (Jev a service and its key, Laya the one-click panel, CLM its server's
 * address). Below it the judge tiers: the order in which several judges are asked, and what each one needs.
 */
export default function JudgesSection({ draft, base, onChange, onKey }: JudgesSectionProps) {
  const { t } = useTranslation();
  return (
    <SectionShell id='judges' title={t('mu.sections.judges')} description={t('mu.judges.intro')}>
      <JudgeChoices draft={draft} onChange={onChange} onKey={onKey} />
      <JudgeTiers draft={draft} base={base} onChange={onChange} onKey={onKey} />
    </SectionShell>
  );
}

type JudgeChoicesProps = Pick<JudgesSectionProps, 'draft' | 'onChange' | 'onKey'>;

/** The choice itself: which judge answers the small questions, and what that choice needs. */
export function JudgeChoices({ draft, onChange, onKey }: JudgeChoicesProps) {
  const { t } = useTranslation();
  const { settings } = draft;
  const current = choiceOf(settings);
  return (
    <>
      <div className={styles.choices} role='radiogroup' aria-label={t('mu.judges.choose')}>
        {JUDGE_CHOICES.map((choice) => (
          <JudgeChoiceTile
            key={choice}
            choice={choice}
            active={current === choice}
            onPick={() => onChange((now) => choose(now, choice))}
          >
            {current === choice ? <ChoiceBody choice={choice} draft={draft} onChange={onChange} onKey={onKey} /> : null}
          </JudgeChoiceTile>
        ))}
      </div>
      {current === undefined ? <div className={styles.meta}>{t('mu.judges.custom')}</div> : null}
    </>
  );
}

type TileProps = { choice: JudgeChoice; active: boolean; onPick: () => void; children?: React.ReactNode };

/** One of the three judge choices, worded from the mu i18n module. */
export function JudgeChoiceTile({ choice, active, onPick, children }: TileProps) {
  const { t } = useTranslation();
  return (
    <ChoiceTile
      testId={`mu-judge-choice-${choice}`}
      title={t(`mu.judges.choices.${choice}.title`)}
      tag={t(`mu.judges.choices.${choice}.tag`)}
      description={t(`mu.judges.choices.${choice}.description`)}
      active={active}
      onPick={onPick}
    >
      {children}
    </ChoiceTile>
  );
}

type BodyProps = {
  choice: JudgeChoice;
  draft: Draft;
  /** In the first-run guide, which sets a judge up: Laya's address and its Stop belong to the settings. */
  guide?: boolean;
  onChange: JudgesSectionProps['onChange'];
  onKey: JudgesSectionProps['onKey'];
};

/**
 * What a choice needs: Jev the service it is reached through (with the address of a service that has one to set) and
 * that service's key, Laya to be installed and running (one click each), CLM the address of its server, the key of a
 * server that asks for one, and word from the server.
 */
export function ChoiceBody({ choice, draft, guide = false, onChange, onKey }: BodyProps) {
  const { t } = useTranslation();
  const { settings } = draft;
  const name = profileFor(settings, choice);
  const judge = name ? settings.judges[name] : undefined;

  if (choice === 'clm') {
    if (!name || !judge) return null;
    const variable = clmKeyVariable(judge);
    const set = settings.keys[variable];
    const problem = clmAddressProblem(t, judge.baseUrl);
    return (
      <div className={styles.choiceFields}>
        <div className={styles.choiceField}>
          <label className={styles.choiceLabel}>{t('mu.judges.clm.address')}</label>
          <Input
            className={styles.choiceInput}
            aria-label={t('mu.judges.clm.address')}
            placeholder={CLM_DEFAULT_ADDRESS}
            status={problem ? 'error' : undefined}
            value={judge.baseUrl}
            onChange={(baseUrl) => onChange((now) => withProfile(now, name, { baseUrl }))}
          />
          {problem ? (
            <div className={fieldStyles.problem} role='alert'>
              {problem}
            </div>
          ) : (
            <div className={styles.choiceHint}>{t('mu.judges.clm.addressHelp', { address: CLM_DEFAULT_ADDRESS })}</div>
          )}
        </div>
        <div className={styles.choiceField}>
          <label className={styles.choiceLabel}>
            {t('mu.judges.clm.key')}
            <Tag size='small'>{t(set ? 'mu.keyState.set' : 'mu.keyState.none')}</Tag>
          </label>
          <Input.Password
            className={styles.choiceInput}
            aria-label={t('mu.judges.clm.key')}
            autoComplete='new-password'
            value={draft.judgeKeys[variable] ?? ''}
            placeholder={set ? t('mu.keyKeep') : t('mu.judges.clm.keyPlaceholder')}
            onChange={(value) => onKey(variable, value)}
          />
          <div className={styles.choiceHint}>{t('mu.judges.clm.keyHelp')}</div>
        </div>
        <div className={styles.choiceField}>
          <ClmServerCheck
            baseUrl={judge.baseUrl}
            model={judge.model || CLM_DEFAULT_MODEL}
            keySet={Boolean(set || draft.judgeKeys[variable])}
          />
          <div className={styles.choiceHint}>{t('mu.judges.clm.unmeasured')}</div>
        </div>
      </div>
    );
  }

  if (choice === 'jev') {
    const service = serviceOf(judge) ?? 'auto';
    const address = addressOf(t, service, judge?.baseUrl ?? '');
    return (
      <div className={styles.choiceFields}>
        <div className={styles.choiceField}>
          <label className={styles.choiceLabel}>{t('mu.judges.service')}</label>
          <AionSelect
            className={styles.choiceInput}
            aria-label={t('mu.judges.service')}
            value={service}
            // The Jev the order asks first: the one this choice stands for.
            onChange={(next: JevService) =>
              onChange((now) => withJevService(now, now.tiers.indexOf(profileFor(now, 'jev') ?? ''), next))
            }
            options={serviceOptions(t)}
          />
          <div className={styles.choiceHint}>{t(`mu.judges.services.${service}.help`)}</div>
        </div>
        {address && name ? (
          <div className={styles.choiceField}>
            <label className={styles.choiceLabel}>{t('mu.judges.baseUrl')}</label>
            <Input
              className={styles.choiceInput}
              aria-label={t('mu.judges.baseUrl')}
              placeholder={address.placeholder}
              status={address.problem ? 'error' : undefined}
              value={judge?.baseUrl}
              onChange={(baseUrl) => onChange((now) => withProfile(now, name, { baseUrl }))}
            />
            {address.problem ? (
              <div className={fieldStyles.problem} role='alert'>
                {address.problem}
              </div>
            ) : (
              <div className={styles.choiceHint}>{address.help}</div>
            )}
          </div>
        ) : null}
        {jevVariables(judge).map((variable) => {
          const label = variableLabel(t, service, variable);
          return (
            <div className={styles.choiceField} key={variable}>
              <label className={styles.choiceLabel}>
                {label}
                <Tag size='small'>{t(settings.keys[variable] ? 'mu.keyState.set' : 'mu.keyState.none')}</Tag>
              </label>
              <VariableInput
                className={styles.choiceInput}
                variable={variable}
                label={label}
                set={settings.keys[variable]}
                draft={draft}
                onKey={onKey}
              />
              <div className={styles.choiceHint}>{variableHelp(t, variable)}</div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={styles.choiceField}>
      <LocalJudgePanel guide={guide} />
      {guide ? null : (
        <div className={styles.choiceHint}>
          {t('mu.judges.localAddress', { address: judge?.baseUrl || t('mu.judges.endpointDefault') })}
        </div>
      )}
    </div>
  );
}

/**
 * The judge tiers, under the choice: the order, by the judges' names (Jev, Laya, CLM), then a group per judge in that
 * order with what it needs. Jev: the service it is reached through, its model and the service's address where it has
 * one. CLM: its server's address and its model. The one thing a judge needs to run (Jev's key, Laya's install, CLM's
 * server) is asked for in the choice above when it is the judge chosen there, the first; a judge further down the
 * order needs it here, where it is the only place. A judge of another kind (a model as judge, a self-hosted HTTP
 * service) goes by the name it was given.
 */
function JudgeTiers({ draft, base, onChange, onKey }: JudgesSectionProps) {
  const { t, i18n } = useTranslation();
  const { settings } = draft;
  const nameOf = (profile: string): string => {
    const kind = kindOf(settings.judges[profile]);
    return kind ? t(`mu.judges.choices.${kind}.title`) : profile;
  };
  // Every judge in the order, Jev, Laya and CLM when they are not in it yet, and the other classifier models (Clef).
  const offered = [
    ...settings.tiers,
    ...JUDGE_CHOICES.filter((choice) => !settings.tiers.some((name) => kindOf(settings.judges[name]) === choice))
      .map((choice) => profileFor(settings, choice))
      .filter((name): name is string => name !== undefined),
    ...Object.keys(settings.judges).filter(
      (name) =>
        !settings.tiers.includes(name) &&
        settings.judges[name].type === 'classifier' &&
        kindOf(settings.judges[name]) === undefined
    ),
  ];
  return (
    <div className={styles.stack} data-testid='mu-judge-tiers'>
      <div className={styles.groupHead}>
        <GroupTitle>{t('mu.sections.judgeTiers')}</GroupTitle>
        <div className={styles.groupHelp}>{t('mu.judges.tiersHelp')}</div>
      </div>
      <Card>
        <Row
          title={t('mu.judges.order')}
          help={t('mu.judges.orderHelp')}
          modified={base.tiers.join() !== settings.tiers.join()}
        >
          <AionSelect
            mode='multiple'
            size='small'
            className={fieldStyles.wide}
            aria-label={t('mu.judges.order')}
            value={settings.tiers}
            onChange={(tiers: string[]) => tiers.length && onChange((now) => ({ ...now, tiers }))}
            options={offered.map((name) => ({ value: name, label: nameOf(name) }))}
          />
        </Row>
      </Card>
      {settings.tiers.map((name, index) => {
        const judge = settings.judges[name];
        const kind = kindOf(judge);
        const classifier = kind === undefined && judge?.type === 'classifier';
        const summary =
          kind === 'local'
            ? t('mu.judges.types.localHelp')
            : kind === 'clm'
              ? t('mu.judges.types.clmHelp')
              : classifier
                ? t('mu.judges.types.classifierHelp', { model: judge.model })
                : kind === undefined
                  ? t('mu.judges.customTier')
                  : undefined;
        return (
          <Card
            key={`${index}:${name}`}
            testId={`mu-judge-tier-${index}`}
            title={t('mu.judges.tierTitle', { index: formatNumber(index + 1, i18n.language), name: nameOf(name) })}
            summary={summary}
          >
            {kind === 'jev' ? (
              <JevFields draft={draft} base={base} index={index} onChange={onChange} onKey={onKey} />
            ) : kind === 'clm' ? (
              <ClmFields draft={draft} base={base} index={index} onChange={onChange} onKey={onKey} />
            ) : classifier ? (
              <ClassifierFields draft={draft} index={index} onKey={onKey} />
            ) : kind === 'local' && index > 0 ? (
              // The first judge is the one chosen above, whose choice installs and starts it.
              <div className={styles.tierPanel}>
                <LocalJudgePanel />
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

/** TypeSafe's own System One address, shown when a direct TypeSafe judge has no address of its own yet. */
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/** What a custom service's address looks like, shown until one is typed. */
const CUSTOM_ENDPOINT = 'https://relay.example.com/v1/systemone';

/** The services Jev is reached through, by their names in the app language. */
const serviceOptions = (t: TFunction) =>
  JEV_SERVICES.map((value) => ({ value, label: t(`mu.judges.services.${value}.name`) }));

/**
 * The address of a Jev profile, for the services that have one to set: TypeSafe's may be moved (empty is TypeSafe's
 * own), a custom service's is needed, since its key goes there and nowhere else. Any address follows the rule for
 * every address a key is sent to. The store refuses a change that leaves either problem.
 */
function addressOf(t: TFunction, service: JevService, baseUrl: string) {
  if (service !== 'typesafe' && service !== 'custom') return undefined;
  const custom = service === 'custom';
  let problem: string | undefined;
  if (baseUrl) problem = isSafeEndpoint(baseUrl) ? undefined : t('mu.endpointRule');
  else if (custom) problem = t('mu.judges.baseUrlNeeded');
  return {
    placeholder: custom ? CUSTOM_ENDPOINT : TYPESAFE_ENDPOINT,
    help: t(custom ? 'mu.judges.customUrlHelp' : 'mu.judges.baseUrlHelp'),
    problem,
  };
}

/** The label of one of a Jev service's variables: its key, or Cloudflare's account ID. */
const variableLabel = (t: TFunction, service: JevService, variable: string): string =>
  variable === CLOUDFLARE_ACCOUNT_VARIABLE
    ? t('mu.judges.services.cloudflare.account')
    : t(`mu.judges.services.${service}.key`);

const variableHelp = (t: TFunction, variable: string): string =>
  t(variable === CLOUDFLARE_ACCOUNT_VARIABLE ? 'mu.judges.services.cloudflare.accountHelp' : 'mu.keyHelp');

type VariableInputProps = {
  className: string;
  size?: 'small';
  variable: string;
  label: string;
  set: boolean | undefined;
  draft: Draft;
  onKey: JudgesSectionProps['onKey'];
};

/** Where a Jev service's variable is typed: a key hidden as it is typed, Cloudflare's account ID in plain sight. */
function VariableInput({ className, size, variable, label, set, draft, onKey }: VariableInputProps) {
  const { t } = useTranslation();
  const account = variable === CLOUDFLARE_ACCOUNT_VARIABLE;
  const props = {
    size,
    className,
    'aria-label': label,
    value: draft.judgeKeys[variable] ?? '',
    placeholder: set
      ? t('mu.keyKeep')
      : t(account ? 'mu.judges.services.cloudflare.accountPlaceholder' : 'mu.judges.keyPlaceholder'),
    onChange: (value: string) => onKey(variable, value),
  };
  return account ? <Input {...props} autoComplete='off' /> : <Input.Password {...props} autoComplete='new-password' />;
}

/** The settings with fields of one judge's profile changed. */
const withProfile = (settings: KyrnSettings, name: string, patch: Partial<JudgeSettings>): KyrnSettings => ({
  ...settings,
  judges: { ...settings.judges, [name]: { ...settings.judges[name], ...patch } },
});

/**
 * What is wrong with a CLM server's address, if anything: the rule for every address mu sends a judge's questions
 * to, since they hold what the person wrote. Empty is clm-serve's default on this machine. The store refuses the same.
 */
const clmAddressProblem = (t: TFunction, baseUrl: string): string | undefined =>
  baseUrl && !isSafeEndpoint(baseUrl) ? t('mu.endpointRule') : undefined;

/**
 * Jev in the order: the service it is reached through, its model and the service's address where it has one to set,
 * and the service's key when it is not the judge chosen on the judges page.
 */
function JevFields({ draft, base, index, onChange, onKey }: JudgesSectionProps & { index: number }) {
  const { t } = useTranslation();
  const { settings } = draft;
  const name = settings.tiers[index];
  const judge = settings.judges[name];
  const service = serviceOf(judge) ?? 'auto';
  const before = base.judges[base.tiers[index] ?? ''];
  const saved = base.judges[name];
  const address = addressOf(t, service, judge.baseUrl);
  // The first judge's key is asked for in the choice above.
  const keyHere = index > 0;
  return (
    <>
      <Row
        title={t('mu.judges.service')}
        help={t(`mu.judges.services.${service}.help`)}
        modified={before !== undefined && serviceOf(before) !== service}
      >
        <AionSelect
          size='small'
          className={fieldStyles.wide}
          aria-label={t('mu.judges.service')}
          value={service}
          onChange={(next: JevService) => onChange((now) => withJevService(now, index, next))}
          options={serviceOptions(t)}
        />
      </Row>
      {judge.type === 'classifier' ? null : (
        // A classifier model's id is its service: the free Jev and the paid one are two services.
        <Row title={t('mu.judges.model')} modified={saved !== undefined && saved.model !== judge.model}>
          <Input
            size='small'
            className={fieldStyles.wide}
            aria-label={t('mu.judges.model')}
            placeholder={defaultModelOf(service)}
            value={judge.model}
            onChange={(model) => onChange((now) => withProfile(now, name, { model }))}
          />
        </Row>
      )}
      {address ? (
        <Row
          title={t('mu.judges.baseUrl')}
          help={address.problem ? undefined : address.help}
          problem={address.problem}
          modified={saved !== undefined && saved.baseUrl !== judge.baseUrl}
        >
          <Input
            size='small'
            className={fieldStyles.wide}
            aria-label={t('mu.judges.baseUrl')}
            placeholder={address.placeholder}
            status={address.problem ? 'error' : undefined}
            value={judge.baseUrl}
            onChange={(baseUrl) => onChange((now) => withProfile(now, name, { baseUrl }))}
          />
        </Row>
      ) : null}
      {keyHere
        ? jevVariables(judge).map((variable) => {
            const label = variableLabel(t, service, variable);
            return (
              <Row
                key={variable}
                title={label}
                help={variableHelp(t, variable)}
                modified={Boolean(draft.judgeKeys[variable])}
                badges={<Tag size='small'>{t(settings.keys[variable] ? 'mu.keyState.set' : 'mu.keyState.none')}</Tag>}
              >
                <VariableInput
                  size='small'
                  className={fieldStyles.wide}
                  variable={variable}
                  label={label}
                  set={settings.keys[variable]}
                  draft={draft}
                  onKey={onKey}
                />
              </Row>
            );
          })
        : null}
    </>
  );
}

/**
 * A classifier model in the order that is not Jev (Clef): the key of its provider where this page keeps it, asked for
 * here wherever it stands, since no choice above stands for it.
 */
function ClassifierFields({ draft, index, onKey }: Pick<JudgesSectionProps, 'draft' | 'onKey'> & { index: number }) {
  const { t } = useTranslation();
  const { settings } = draft;
  const judge = settings.judges[settings.tiers[index]];
  const service: JevService = judge.model.startsWith('opencode/') ? 'opencode' : 'cloudflare';
  return (
    <>
      {classifierVariables(judge).map((variable) => {
        const label = variableLabel(t, service, variable);
        return (
          <Row
            key={variable}
            title={label}
            help={variableHelp(t, variable)}
            modified={Boolean(draft.judgeKeys[variable])}
            badges={<Tag size='small'>{t(settings.keys[variable] ? 'mu.keyState.set' : 'mu.keyState.none')}</Tag>}
          >
            <VariableInput
              size='small'
              className={fieldStyles.wide}
              variable={variable}
              label={label}
              set={settings.keys[variable]}
              draft={draft}
              onKey={onKey}
            />
          </Row>
        );
      })}
    </>
  );
}

/**
 * CLM in the order: its server's address and the model it asks for, and, when it is not the judge chosen on the
 * judges page, the key of a server that asks for one and word from the server.
 */
function ClmFields({ draft, base, index, onChange, onKey }: JudgesSectionProps & { index: number }) {
  const { t } = useTranslation();
  const { settings } = draft;
  const name = settings.tiers[index];
  const judge = settings.judges[name];
  const saved = base.judges[name];
  const variable = clmKeyVariable(judge);
  const set = settings.keys[variable];
  const problem = clmAddressProblem(t, judge.baseUrl);
  // The first judge's key and server are in the choice above.
  const here = index > 0;
  return (
    <>
      <Row
        title={t('mu.judges.clm.address')}
        help={problem ? undefined : t('mu.judges.clm.addressHelp', { address: CLM_DEFAULT_ADDRESS })}
        problem={problem}
        modified={saved !== undefined && saved.baseUrl !== judge.baseUrl}
      >
        <Input
          size='small'
          className={fieldStyles.wide}
          aria-label={t('mu.judges.clm.address')}
          placeholder={CLM_DEFAULT_ADDRESS}
          status={problem ? 'error' : undefined}
          value={judge.baseUrl}
          onChange={(baseUrl) => onChange((now) => withProfile(now, name, { baseUrl }))}
        />
      </Row>
      <Row title={t('mu.judges.model')} modified={saved !== undefined && saved.model !== judge.model}>
        <Input
          size='small'
          className={fieldStyles.wide}
          aria-label={t('mu.judges.model')}
          placeholder={CLM_DEFAULT_MODEL}
          value={judge.model}
          onChange={(model) => onChange((now) => withProfile(now, name, { model }))}
        />
      </Row>
      {here ? (
        <>
          <Row
            title={t('mu.judges.clm.key')}
            help={t('mu.judges.clm.keyHelp')}
            modified={Boolean(draft.judgeKeys[variable])}
            badges={<Tag size='small'>{t(set ? 'mu.keyState.set' : 'mu.keyState.none')}</Tag>}
          >
            <Input.Password
              size='small'
              className={fieldStyles.wide}
              aria-label={t('mu.judges.clm.key')}
              autoComplete='new-password'
              value={draft.judgeKeys[variable] ?? ''}
              placeholder={set ? t('mu.keyKeep') : t('mu.judges.clm.keyPlaceholder')}
              onChange={(value) => onKey(variable, value)}
            />
          </Row>
          <div className={styles.tierPanel}>
            <ClmServerCheck
              baseUrl={judge.baseUrl}
              model={judge.model || CLM_DEFAULT_MODEL}
              keySet={Boolean(set || draft.judgeKeys[variable])}
            />
          </div>
        </>
      ) : null}
    </>
  );
}
