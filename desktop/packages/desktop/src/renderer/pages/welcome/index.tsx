import React, { useEffect, useState } from 'react';
import { Alert, AutoComplete, Button, Input, Radio } from '@arco-design/web-react';
import { Check } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import MuMark from '@renderer/components/brand/MuMark';
import LanguageSwitcher from '@/renderer/components/settings/LanguageSwitcher';
import ChoiceTile from '@/renderer/pages/settings/KyrnSettings/fields/ChoiceTile';
import MuErrorMessage from '@/renderer/pages/settings/KyrnSettings/fields/MuErrorMessage';
import {
  answersFree,
  choiceOf,
  choose,
  GUIDE_CHOICES,
  jevVariables,
  profileFor,
} from '@/renderer/pages/settings/KyrnSettings/judgeChoice';
import {
  blankModel,
  blankProvider,
  ENDPOINT_PLACEHOLDER,
  providerLabel,
} from '@/renderer/pages/settings/KyrnSettings/providers/endpoints';
import ConnectionTest from '@/renderer/pages/settings/KyrnSettings/providers/ConnectionTest';
import { ChoiceBody, JudgeChoiceTile } from '@/renderer/pages/settings/KyrnSettings/sections/JudgesSection';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import { useMuSettings } from '@/renderer/pages/settings/KyrnSettings/useMuSettings';
import ImportChatsModal from '@/renderer/pages/settings/SystemSettings/ImportChats/ImportChatsModal';
import { useNativeEnabled } from '@/renderer/pages/native/hooks/useNativeConversations';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { useModelNames } from '@/renderer/hooks/agent/useModelNames';
import { modelDisplayName } from '@/renderer/utils/model/providerName';
import Field from './Field';
import KeyPaste from './KeyPaste';
import {
  apiModelProblem,
  type ApiModel,
  type GuideApi,
  markOnboardingSeen,
  permissionModesOf,
  withApiModel,
  withPermissionMode,
  withSignedInModel,
} from './onboarding';
import SubscriptionLogin from './SubscriptionLogin';
import { useKeySetup } from './useKeySetup';
import styles from './Welcome.module.css';

type Step = 'intro' | 'model' | 'permissions' | 'judge' | 'done';
/**
 * A tile of the model step: an API key of a service mu knows, an account mu is signed in to, or one of the two API
 * families at an address typed in.
 */
type Way = 'key' | 'signedIn' | 'openai' | 'anthropic';
const API_WAYS = ['openai', 'anthropic'] as const;
type ApiWay = (typeof API_WAYS)[number];
type OpenAiApi = Extract<GuideApi, 'openai-completions' | 'openai-responses'>;
const OPENAI_APIS: readonly OpenAiApi[] = ['openai-completions', 'openai-responses'];
const INTRO_POINTS = ['judge', 'control', 'ready'] as const;

/** The check on a pastel mark: dark, as every pastel fill carries dark ink. */
const MARK_INK = '#3b2f6b';

/** A line that says what is already set up and works: nothing to do on this step. */
function Ready({ text, testId }: { text: string; testId: string }) {
  return (
    <div className={styles.ready} role='status' data-testid={testId}>
      <span className={styles.readyMark} aria-hidden='true'>
        <Check theme='outline' size='12' strokeWidth={5} fill={MARK_INK} />
      </span>
      <span>{text}</span>
    </div>
  );
}

/**
 * The first-run guide: what mu is, then connect a model, choose how much it does without asking, pick a judge, done. One question at a time, nothing that
 * can wait; all of it is written in one save at the end, and every step can be skipped. Everything here is also in
 * the settings. The last step also offers the Claude Code and Codex conversations on this computer, to go on with
 * them in mu.
 */
export default function Welcome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mu = useMuSettings();
  const [step, setStep] = useState<Step>('intro');
  const [way, setWay] = useState<Way>();
  const [openaiApi, setOpenaiApi] = useState<OpenAiApi>('openai-completions');
  const [form, setForm] = useState<Omit<ApiModel, 'api'>>({ baseUrl: '', key: '', model: '' });
  const [signedIn, setSignedIn] = useState('');
  const [listed, setListed] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [added, setAdded] = useState<string>();
  // The judge's service and key, folded away while the judge answers as it is.
  const [judgeMore, setJudgeMore] = useState(false);
  const keys = useKeySetup();
  // Claude Code and Codex conversations on this computer not brought in yet: the last step offers them.
  const native = useNativeEnabled() === true;
  // Models by the names the send box shows, not by their ids.
  const modelNames = useModelNames();
  const modelName = (provider: string, model: string) => modelDisplayName(`${provider}/${model}`, modelNames);
  const [importable, setImportable] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importRound, setImportRound] = useState(0);
  useEffect(() => {
    if (step !== 'done') return undefined;
    let gone = false;
    kyrnBridge.importList
      .invoke({ native })
      .then(unwrap)
      .then(({ conversations }) => {
        if (!gone) setImportable(conversations.filter((chat) => !chat.conversationId).length);
      })
      // Nothing to offer is no failure of the guide.
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [native, step, importRound]);

  const { base, draft } = mu;
  const chosenWay: Way | undefined = way;
  // The steps of the setup itself; the introduction before them is not one. The permission step only when this mu
  // has permission modes and they are on.
  const permissionModes =
    base && draft?.settings.features.permissions?.enabled !== false ? permissionModesOf(base) : [];
  const steps: Step[] = permissionModes.length ? ['model', 'permissions', 'judge', 'done'] : ['model', 'judge', 'done'];
  const after = (now: Step): Step => steps[steps.indexOf(now) + 1] ?? 'done';

  const leave = () => {
    markOnboardingSeen();
    navigate('/guid', { replace: true });
  };

  const apiOf = (tile: ApiWay): GuideApi => (tile === 'openai' ? openaiApi : 'anthropic-messages');
  const apiInput = (api: GuideApi): ApiModel => ({ api, ...form });
  const apiWay = chosenWay === 'openai' || chosenWay === 'anthropic' ? chosenWay : undefined;
  const problem = apiWay ? apiModelProblem(apiInput(apiOf(apiWay))) : undefined;

  const nextFromModel = () => {
    if (!chosenWay) return setStep(after('model'));
    if (chosenWay === 'key') {
      setTried(true);
      if (!keys.choice || !draft) return;
      const { service, baseUrl, key, model } = keys.choice;
      // A provider of its own, as for an address typed in: named after the service, its id made from the service's.
      const result = withApiModel(draft, { api: service.api, baseUrl, key, model }, added, service);
      mu.edit(() => result.draft);
      setAdded(result.id);
      setTried(false);
      return setStep(after('model'));
    }
    if (chosenWay === 'signedIn') {
      const [provider, ...rest] = signedIn.split('/');
      const model = rest.join('/');
      setTried(true);
      if (!provider || !model) return;
      mu.edit((now) => withSignedInModel(now, provider, model, added));
      setAdded(undefined);
      setTried(false);
      return setStep(after('model'));
    }
    setTried(true);
    if (problem || !draft) return;
    const result = withApiModel(draft, apiInput(apiOf(chosenWay)), added);
    mu.edit(() => result.draft);
    setAdded(result.id);
    setStep(after('model'));
  };

  const finish = async () => {
    if (mu.dirty.size === 0 || (await mu.save())) leave();
  };

  if (!base || !draft) {
    return (
      <div className={styles.screen} data-testid='mu-welcome'>
        <div className={styles.drag} />
        <main className={styles.column}>
          {mu.error ? (
            <Alert
              type='error'
              title={t('mu.load.failed')}
              content={<MuErrorMessage error={mu.error} />}
              action={<Button onClick={mu.reload}>{t('mu.reload')}</Button>}
            />
          ) : (
            <MuMark size={48} halo />
          )}
        </main>
      </div>
    );
  }

  const { settings } = draft;
  const judge = choiceOf(settings);
  const judgeProfile = judge ? settings.judges[profileFor(settings, judge) ?? ''] : undefined;
  const provider = (api: GuideApi) => ({
    ...blankProvider(added ?? 'onboarding'),
    api,
    baseUrl: form.baseUrl.trim(),
    models: [blankModel(form.model.trim())],
  });
  const fieldProblem = (field: 'baseUrl' | 'key' | 'model') =>
    tried && problem === field ? t(`mu.welcome.model.problems.${field}`) : undefined;
  const fieldStatus = (field: 'baseUrl' | 'key' | 'model'): 'error' | undefined =>
    fieldProblem(field) ? 'error' : undefined;
  // What already works, so someone who set mu up before is not asked again as if it were the first time.
  const saved = base.models.defaults;
  const savedModel =
    saved.provider && saved.model
      ? t('mu.welcome.model.ready', {
          provider: providerLabel(t, base.models, saved.provider),
          model: modelName(saved.provider, saved.model),
        })
      : undefined;
  const judgeFree = judge === 'jev' && answersFree(judgeProfile, settings.keys, draft.judgeKeys);
  const judgeKeyed =
    judge === 'jev' &&
    !judgeFree &&
    jevVariables(judgeProfile).every((variable) => Boolean(settings.keys[variable] || draft.judgeKeys[variable]));
  const judgeReady = judgeFree ? t('mu.welcome.judge.readyFree') : judgeKeyed ? t('mu.welcome.judge.readyKey') : '';

  let body: React.ReactNode;
  if (step === 'intro') {
    body = (
      <>
        <h1 className={styles.heroTitle}>{t('mu.welcome.intro.title')}</h1>
        <p className={styles.lead}>{t('mu.welcome.intro.lead')}</p>
        <ul className={styles.points}>
          {INTRO_POINTS.map((point) => (
            <li key={point} className={styles.point}>
              <span className={styles.pointMark} aria-hidden='true'>
                <Check theme='outline' size='12' strokeWidth={5} fill={MARK_INK} />
              </span>
              <div>
                <div className={styles.pointTitle}>{t(`mu.welcome.intro.points.${point}.title`)}</div>
                <div className={styles.pointText}>{t(`mu.welcome.intro.points.${point}.text`)}</div>
              </div>
            </li>
          ))}
        </ul>
      </>
    );
  } else if (step === 'model') {
    body = (
      <>
        <h1 className={styles.title}>{t('mu.welcome.model.title')}</h1>
        <p className={styles.subtitle}>{t('mu.welcome.model.subtitle')}</p>
        {savedModel ? <Ready testId='mu-welcome-model-ready' text={savedModel} /> : null}
        <div className={choiceStyles.choices} role='radiogroup' aria-label={t('mu.welcome.model.title')}>
          <ChoiceTile
            testId='mu-welcome-way-key'
            title={t('mu.welcome.apiKey.title')}
            tag={t('mu.welcome.apiKey.tag')}
            description={t('mu.welcome.apiKey.description')}
            active={chosenWay === 'key'}
            onPick={() => {
              setWay('key');
              setTried(false);
            }}
          >
            <KeyPaste setup={keys} tried={tried} />
          </ChoiceTile>
          <ChoiceTile
            testId='mu-welcome-way-signedIn'
            title={t('mu.welcome.model.signedIn.title')}
            tag={t('mu.welcome.model.signedIn.tag')}
            description={t('mu.welcome.model.signedIn.description')}
            active={chosenWay === 'signedIn'}
            onPick={() => {
              setWay('signedIn');
              setTried(false);
            }}
          >
            <SubscriptionLogin value={signedIn} onChange={setSignedIn} />
            {tried && !signedIn ? (
              <div className={styles.problem} role='alert'>
                {t('mu.welcome.login.needAccount')}
              </div>
            ) : null}
          </ChoiceTile>
          {/* The ways that need an address typed in: for a relay, or a service the key tile does not know. */}
          <div className={styles.otherWays}>{t('mu.welcome.model.other')}</div>
          {API_WAYS.map((tile) => {
            const api = apiOf(tile);
            return (
              <ChoiceTile
                key={tile}
                testId={`mu-welcome-way-${tile}`}
                title={t(`mu.welcome.model.${tile}.title`)}
                // The Anthropic tile's description already names Claude: a tag saying it again adds nothing.
                tag={tile === 'openai' ? t('mu.welcome.model.openai.tag') : undefined}
                description={t(`mu.welcome.model.${tile}.description`)}
                active={chosenWay === tile}
                onPick={() => {
                  setWay(tile);
                  setTried(false);
                }}
              >
                <div className={styles.fields}>
                  {tile === 'openai' ? (
                    <Field label={t('mu.welcome.model.openaiApi.label')}>
                      <Radio.Group
                        type='button'
                        aria-label={t('mu.welcome.model.openaiApi.label')}
                        value={openaiApi}
                        onChange={(value: OpenAiApi) => setOpenaiApi(value)}
                        options={OPENAI_APIS.map((value) => ({
                          value,
                          label: t(`mu.welcome.model.openaiApi.${value}`),
                        }))}
                      />
                      <div className={choiceStyles.choiceHint}>{t(`mu.welcome.model.openaiApi.${openaiApi}Hint`)}</div>
                    </Field>
                  ) : null}
                  <Field label={t('mu.welcome.model.baseUrl')} problem={fieldProblem('baseUrl')}>
                    <Input
                      aria-label={t('mu.welcome.model.baseUrl')}
                      status={fieldStatus('baseUrl')}
                      value={form.baseUrl}
                      placeholder={ENDPOINT_PLACEHOLDER[api]}
                      onChange={(baseUrl) => setForm((now) => ({ ...now, baseUrl }))}
                    />
                  </Field>
                  <Field label={t('mu.welcome.model.key')} problem={fieldProblem('key')}>
                    <Input.Password
                      aria-label={t('mu.welcome.model.key')}
                      status={fieldStatus('key')}
                      autoComplete='new-password'
                      value={form.key}
                      placeholder={t('mu.welcome.model.keyPlaceholder')}
                      onChange={(key) => setForm((now) => ({ ...now, key }))}
                    />
                  </Field>
                  <Field label={t('mu.welcome.model.modelId')} problem={fieldProblem('model')}>
                    <AutoComplete
                      aria-label={t('mu.welcome.model.modelId')}
                      status={fieldStatus('model')}
                      value={form.model}
                      data={listed}
                      placeholder={t(`mu.welcome.model.${tile}.modelPlaceholder`)}
                      onChange={(model: string) => setForm((now) => ({ ...now, model }))}
                    />
                  </Field>
                  <ConnectionTest
                    provider={provider(api)}
                    typedKey={form.key.trim()}
                    disabled={apiModelProblem({ ...apiInput(api), model: form.model || 'x' }) === 'baseUrl'}
                    onModels={(models) => {
                      setListed(models);
                      // A service that lists one model has named it: nothing is left to choose.
                      if (models.length === 1)
                        setForm((now) => (now.model.trim() ? now : { ...now, model: models[0] }));
                    }}
                  />
                </div>
              </ChoiceTile>
            );
          })}
        </div>
      </>
    );
  } else if (step === 'permissions') {
    body = (
      <>
        <h1 className={styles.title}>{t('mu.welcome.permissions.title')}</h1>
        <p className={styles.subtitle}>{t('mu.welcome.permissions.subtitle')}</p>
        <div className={choiceStyles.choices} role='radiogroup' aria-label={t('mu.welcome.permissions.title')}>
          {permissionModes.map((mode) => (
            <ChoiceTile
              key={mode}
              testId={`mu-welcome-permission-${mode}`}
              title={t(`mu.permissions.modes.${mode}.title`)}
              tag={mode === 'jev' ? t('mu.welcome.permissions.recommended') : undefined}
              description={t(`mu.permissions.modes.${mode}.description`)}
              active={settings.permissions.mode === mode}
              onPick={() => mu.editSettings((now) => withPermissionMode(now, mode))}
            />
          ))}
        </div>
      </>
    );
  } else if (step === 'judge') {
    body = (
      <>
        <h1 className={styles.title}>{t('mu.welcome.judge.title')}</h1>
        <p className={styles.subtitle}>{t('mu.welcome.judge.subtitle')}</p>
        {judgeReady ? <Ready testId='mu-welcome-judge-ready' text={judgeReady} /> : null}
        <div className={choiceStyles.choices} role='radiogroup' aria-label={t('mu.welcome.judge.title')}>
          {GUIDE_CHOICES.map((choice) => {
            const fields = (
              <ChoiceBody
                choice={choice}
                draft={draft}
                guide
                onChange={mu.editSettings}
                onKey={(variable, value) =>
                  mu.edit((now) => ({ ...now, judgeKeys: { ...now.judgeKeys, [variable]: value } }))
                }
              />
            );
            // A Jev that already answers needs nothing here: its service and key wait behind one quiet link.
            const folded = choice === 'jev' && Boolean(judgeReady);
            return (
              <JudgeChoiceTile
                key={choice}
                choice={choice}
                active={judge === choice}
                onPick={() => mu.editSettings((now) => choose(now, choice))}
              >
                {folded ? (
                  <>
                    <button
                      type='button'
                      className={styles.textButton}
                      aria-expanded={judgeMore}
                      data-testid='mu-welcome-judge-more'
                      onClick={() => setJudgeMore((open) => !open)}
                    >
                      {t(judgeMore ? 'mu.welcome.judge.less' : 'mu.welcome.judge.more')}
                    </button>
                    {judgeMore ? fields : null}
                  </>
                ) : (
                  fields
                )}
              </JudgeChoiceTile>
            );
          })}
        </div>
      </>
    );
  } else {
    const { provider: startProvider, model } = settings.models.defaults;
    const needed = judge === 'jev' ? jevVariables(judgeProfile) : [];
    const keyReady = needed.every((variable) => Boolean(settings.keys[variable] || draft.judgeKeys[variable]));
    const free = judge === 'jev' && answersFree(judgeProfile, settings.keys, draft.judgeKeys);
    body = (
      <>
        <h1 className={styles.title}>{t('mu.welcome.done.title')}</h1>
        <p className={styles.subtitle}>{t('mu.welcome.done.subtitle')}</p>
        <dl className={styles.summary}>
          <div className={styles.summaryRow}>
            <dt>{t('mu.welcome.done.model')}</dt>
            <dd>
              {startProvider && model
                ? t('mu.welcome.done.modelValue', {
                    provider: providerLabel(t, settings.models, startProvider),
                    model: modelName(startProvider, model),
                  })
                : t('mu.welcome.done.none')}
            </dd>
          </div>
          {permissionModes.length ? (
            <div className={styles.summaryRow}>
              <dt>{t('mu.welcome.done.permissions')}</dt>
              <dd>{t(`mu.permissions.modes.${settings.permissions.mode}.title`)}</dd>
            </div>
          ) : null}
          <div className={styles.summaryRow}>
            <dt>{t('mu.welcome.done.judge')}</dt>
            <dd>
              {judge ? t(`mu.judges.choices.${judge}.title`) : t('mu.welcome.done.none')}
              {free ? (
                <span className={styles.note}>{t('mu.welcome.done.freeJev')}</span>
              ) : judge === 'jev' && !keyReady ? (
                <span className={styles.warn}>{t('mu.welcome.done.noKey')}</span>
              ) : null}
            </dd>
          </div>
          {importable > 0 ? (
            <div className={styles.summaryRow} data-testid='mu-welcome-import'>
              <dt>{t('mu.welcome.done.import')}</dt>
              <dd>
                {t('mu.welcome.done.importFound', { count: importable })}
                <Button size='mini' data-testid='mu-welcome-import-open' onClick={() => setImporting(true)}>
                  {t('mu.welcome.done.importOpen')}
                </Button>
              </dd>
            </div>
          ) : null}
        </dl>
        {importing ? (
          <ImportChatsModal
            visible
            stay
            onClose={() => {
              setImporting(false);
              setImportRound((round) => round + 1);
            }}
          />
        ) : null}
        {mu.error ? (
          <Alert
            type='error'
            content={
              <MuErrorMessage error={mu.error} frame={(reason) => t('mu.welcome.done.saveFailed', { reason })} />
            }
          />
        ) : null}
      </>
    );
  }

  const index = steps.indexOf(step);
  const back = () => setStep(index <= 0 ? 'intro' : steps[index - 1]);
  return (
    <div className={styles.screen} data-testid='mu-welcome'>
      <div className={styles.drag} />
      <main className={classNames(styles.column, step === 'intro' && styles.columnIntro)}>
        <header className={styles.header}>
          <div className={styles.headerTop}>
            <MuMark size={step === 'intro' ? 64 : 40} halo />
            {/* Someone on a system in another language can switch before reading a word of the guide. */}
            <div
              className={styles.language}
              role='group'
              aria-label={t('settings.language')}
              data-testid='mu-welcome-language'
            >
              <span>{t('settings.language')}</span>
              <LanguageSwitcher />
            </div>
          </div>
          {step === 'intro' ? null : (
            <ol className={styles.steps} aria-label={t('mu.welcome.progress')}>
              {steps.map((name, position) => (
                <li
                  key={name}
                  aria-current={name === step ? 'step' : undefined}
                  className={classNames(styles.stepItem, position <= index && styles.stepReached)}
                >
                  <span className={styles.stepDot} aria-hidden='true' />
                  {t(`mu.welcome.steps.${name}`)}
                </li>
              ))}
            </ol>
          )}
        </header>
        <section key={step} className={styles.body} data-testid={`mu-welcome-step-${step}`}>
          {body}
        </section>
        <footer className={styles.footer}>
          {step === 'intro' ? (
            <button type='button' className={styles.textButton} onClick={leave}>
              {t('mu.welcome.skipAll')}
            </button>
          ) : (
            <button type='button' className={styles.textButton} onClick={back}>
              {t('mu.welcome.back')}
            </button>
          )}
          <span className={styles.spacer} />
          {/* Skipping is a quiet text button on the steps that ask for something (the permission step always has a
              mode chosen); the lavender button is always the way on. */}
          {step === 'model' || step === 'judge' ? (
            <button
              type='button'
              className={styles.textButton}
              data-testid='mu-welcome-skip'
              onClick={() => setStep(after(step))}
            >
              {t('mu.welcome.skipStep')}
            </button>
          ) : null}
          {step === 'intro' ? (
            <Button type='primary' shape='round' data-testid='mu-welcome-begin' onClick={() => setStep('model')}>
              {t('mu.welcome.intro.start')}
            </Button>
          ) : step === 'model' ? (
            <Button
              type='primary'
              shape='round'
              data-testid='mu-welcome-next'
              // A key being checked: Next waits for what the service says.
              loading={chosenWay === 'key' && keys.check.phase === 'checking'}
              onClick={nextFromModel}
            >
              {t('mu.welcome.next')}
            </Button>
          ) : step === 'judge' || step === 'permissions' ? (
            <Button type='primary' shape='round' data-testid='mu-welcome-next' onClick={() => setStep(after(step))}>
              {t('mu.welcome.next')}
            </Button>
          ) : (
            <Button
              type='primary'
              shape='round'
              data-testid='mu-welcome-start'
              loading={mu.saving}
              onClick={() => void finish()}
            >
              {t('mu.welcome.start')}
            </Button>
          )}
        </footer>
      </main>
    </div>
  );
}
