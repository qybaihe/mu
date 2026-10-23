import React, { useEffect, useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Input, Radio } from '@arco-design/web-react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import JudgePulse from '@renderer/components/brand/JudgePulse';
import MuMark from '@renderer/components/brand/MuMark';
import { summarize } from '@renderer/components/kernel/kernelSummary';
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
import { dirtySections } from '@/renderer/pages/settings/KyrnSettings/draft';
import { ChoiceBody, JudgeChoiceTile } from '@/renderer/pages/settings/KyrnSettings/sections/JudgesSection';
import {
  MudeSetup,
  MudeUnsupported,
  mudeOffered,
  useMude,
  type MudeControl,
} from '@/renderer/pages/settings/KyrnSettings/sections/MudePanel';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import { useMuSettings } from '@/renderer/pages/settings/KyrnSettings/useMuSettings';
import ImportChatsModal from '@/renderer/pages/settings/SystemSettings/ImportChats/ImportChatsModal';
import ImportSources from '@/renderer/pages/settings/SystemSettings/ImportChats/ImportSources';
import { useNativeEnabled } from '@/renderer/pages/native/hooks/useNativeConversations';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { importableByTool, type FoundChat } from '@/common/kyrn/importChats';
import { isPlainRemoteEndpoint, type ListedModel } from '@/common/kyrn/models';
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

/**
 * One turn as the judge sees it, for the introduction: three real decision points, what each one's verdict said and
 * about how long it took. The ids and timings are data, not words; the verdicts are in the reader's language.
 */
const TURN = [
  { point: 'input.preflight', verdict: 'preflight', ms: 340 },
  { point: 'tool.approval', verdict: 'approval', ms: 205 },
  { point: 'turn.completion', verdict: 'completion', ms: 207 },
] as const;

/** A line that says what is already set up and works: nothing to do on this step. */
function Ready({ text, testId }: { text: string; testId: string }) {
  return (
    <div className={styles.ready} role='status' data-testid={testId}>
      <span className={styles.readyDot} aria-hidden='true' />
      <span>{text}</span>
    </div>
  );
}

/**
 * The first-run guide: what mu is, then connect a model, choose how much it does without asking, pick a judge, done. One question at a time, nothing that
 * can wait; all of it is written in one save at the end, and every step can be skipped. Everything here is also in
 * the settings. The first screen and the last step offer the Claude Code, Codex and ZCode conversations on this
 * computer, under each tool's mark, to go on with them in mu.
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
  // What the address's model list stated about each model: the provider's row starts from it.
  const [listedFacts, setListedFacts] = useState<Record<string, ListedModel>>({});
  const [tried, setTried] = useState(false);
  const [added, setAdded] = useState<string>();
  // The judge's service and key, folded away while the judge answers as it is.
  const [judgeMore, setJudgeMore] = useState(false);
  // mude, on a Mac: picked in the judge step, which sets it up right there through mu's own command. The command
  // writes mu.json itself (mude first, the judges from before behind it), so once it ends the guide's draft is moved
  // onto the files again, and the final save starts from them too: it never puts back the judge the draft held.
  const [mudePicked, setMudePicked] = useState(false);
  const mudeRan = useRef(false);
  const mudeNow = useMude((task) => {
    const judgeSet = task.phase === 'done' && (task.command === 'install' || task.command === 'enable');
    void mu.rebase(judgeSet ? 'files' : 'draft');
  });
  const mude: MudeControl = {
    ...mudeNow,
    run: (action, localOnly) => {
      mudeRan.current = true;
      return mudeNow.run(action, localOnly);
    },
  };
  const keys = useKeySetup();
  // Claude Code, Codex and ZCode conversations on this computer not brought in yet: the first screen and the last
  // step offer them.
  const native = useNativeEnabled() === true;
  // Models by the names the send box shows, not by their ids.
  const modelNames = useModelNames();
  const modelName = (provider: string, model: string) => modelDisplayName(`${provider}/${model}`, modelNames);
  const [found, setFound] = useState<FoundChat[]>([]);
  const [importing, setImporting] = useState(false);
  const [importRound, setImportRound] = useState(0);
  useEffect(() => {
    let gone = false;
    kyrnBridge.importList
      .invoke({ native })
      .then(unwrap)
      .then(({ conversations }) => {
        if (!gone) setFound(conversations);
      })
      // Nothing to offer is no failure of the guide.
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [native, importRound]);
  const importable = importableByTool(found).reduce((sum, source) => sum + source.count, 0);
  const importDialog = importing ? (
    <ImportChatsModal
      visible
      stay
      onClose={() => {
        setImporting(false);
        setImportRound((round) => round + 1);
      }}
    />
  ) : null;

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
  const apiInput = (api: GuideApi): ApiModel => ({ api, ...form, facts: listedFacts[form.model.trim()] });
  const apiWay = chosenWay === 'openai' || chosenWay === 'anthropic' ? chosenWay : undefined;
  const problem = apiWay ? apiModelProblem(apiInput(apiOf(apiWay))) : undefined;

  const nextFromModel = () => {
    if (!chosenWay) return setStep(after('model'));
    if (chosenWay === 'key') {
      setTried(true);
      if (!keys.choice || !draft) return;
      const { service, baseUrl, key, model, facts } = keys.choice;
      // A provider of its own, as for an address typed in: named after the service, its id made from the service's.
      const result = withApiModel(draft, { api: service.api, baseUrl, key, model, facts }, added, service);
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
    if (!mudeRan.current) {
      if (mu.dirty.size === 0 || (await mu.save())) leave();
      return;
    }
    // mude's command may have written mu.json since: the save starts from the files. With mude the last pick, the
    // judge is what the files say (mude first once it is set up, else the judge from before).
    const from = await mu.rebase(mudePicked ? 'files' : 'draft');
    if (!from) return;
    if (dirtySections(from.base, from.draft).size > 0 && !(await mu.save(from))) return;
    // Set up here but not the judge after all: its server (about 4 GB of memory) is not left running for nothing.
    if (from.draft.settings.mode === 'off' || choiceOf(from.draft.settings) !== 'mude') void mudeNow.run('stop');
    leave();
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
  // No judge: every decision point off, as the settings' switch sets it, so nothing is sent to a judge.
  const judgeOff = settings.mode === 'off';
  const judgeFree = !judgeOff && judge === 'jev' && answersFree(judgeProfile, settings.keys, draft.judgeKeys);
  const judgeKeyed =
    !judgeOff &&
    judge === 'jev' &&
    !judgeFree &&
    jevVariables(judgeProfile).every((variable) => Boolean(settings.keys[variable] || draft.judgeKeys[variable]));
  const judgeReady = judgeFree ? t('mu.welcome.judge.readyFree') : judgeKeyed ? t('mu.welcome.judge.readyKey') : '';

  let body: React.ReactNode;
  if (step === 'intro') {
    body = (
      <>
        <div className={styles.eyebrow}>
          <JudgePulse state='idle' />
          <span>{t('common.kyrn.brand.tagline')}</span>
        </div>
        <h1 className={styles.heroTitle}>{t('mu.welcome.intro.title')}</h1>
        <p className={styles.lead}>{t('mu.welcome.intro.lead')}</p>
        {importable > 0 ? (
          // Someone coming from another coding agent sees first that their conversations can come along.
          <section className={styles.importOffer} data-testid='mu-welcome-intro-import'>
            <div className={styles.importText}>
              <div className={styles.pointTitle}>{t('mu.welcome.intro.import.title')}</div>
              <div className={styles.pointText}>{t('mu.welcome.intro.import.text', { count: importable })}</div>
            </div>
            <ImportSources chats={found} />
            <Button
              className={styles.importButton}
              data-testid='mu-welcome-intro-import-open'
              onClick={() => setImporting(true)}
            >
              {t('mu.welcome.intro.import.open')}
            </Button>
            {importDialog}
          </section>
        ) : null}
        <figure className={styles.turn} data-testid='mu-welcome-turn'>
          <figcaption className={styles.turnLabel}>{t('mu.welcome.intro.turn.label')}</figcaption>
          <ol className={styles.turnRows}>
            {TURN.map((row) => (
              <li key={row.point} className={styles.turnRow}>
                <span className={styles.turnPoint} dir='ltr'>
                  {row.point}
                </span>
                <span className={styles.turnVerdict}>{t(`mu.welcome.intro.turn.${row.verdict}`)}</span>
                <span className={styles.turnMs} dir='ltr'>
                  {row.ms} ms
                </span>
              </li>
            ))}
          </ol>
        </figure>
        <ul className={styles.points}>
          {INTRO_POINTS.map((point) => (
            <li key={point} className={styles.point}>
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
                  <Field
                    label={t('mu.welcome.model.baseUrl')}
                    problem={fieldProblem('baseUrl')}
                    warning={isPlainRemoteEndpoint(form.baseUrl.trim()) ? t('mu.endpointPlain') : undefined}
                  >
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
                    onModels={(models, facts) => {
                      setListed(models);
                      setListedFacts(facts);
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
              tag={mode === 'judge' ? t('mu.welcome.permissions.recommended') : undefined}
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
        {judgeReady && !mudePicked ? <Ready testId='mu-welcome-judge-ready' text={judgeReady} /> : null}
        <div className={choiceStyles.choices} role='radiogroup' aria-label={t('mu.welcome.judge.title')}>
          {GUIDE_CHOICES.map((choice) => {
            if (choice === 'mude') {
              // Shown on every machine, so someone without a Mac that runs it learns it exists; never in the way.
              const disabled = !mudeOffered(mude.state);
              return (
                <JudgeChoiceTile
                  key={choice}
                  choice={choice}
                  active={!disabled && (mudePicked || (!judgeOff && judge === 'mude'))}
                  disabled={disabled}
                  description={disabled ? <MudeUnsupported state={mude.state} guide /> : undefined}
                  onPick={() => setMudePicked(true)}
                >
                  <MudeSetup mude={mude} judged={!judgeOff && judge === 'mude'} />
                </JudgeChoiceTile>
              );
            }
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
                active={!judgeOff && !mudePicked && judge === choice}
                // Picking a judge after "No judge" turns the verdicts back on; a stored shadow stays as it is.
                onPick={() => {
                  setMudePicked(false);
                  mu.editSettings((now) => ({
                    ...choose(now, choice),
                    mode: now.mode === 'off' ? 'active' : now.mode,
                  }));
                }}
              >
                {judgeOff ? null : folded ? (
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
          <ChoiceTile
            testId='mu-welcome-judge-none'
            title={t('mu.welcome.judge.none.title')}
            tag={t('mu.welcome.judge.none.tag')}
            description={t('mu.welcome.judge.none.description')}
            active={judgeOff && !mudePicked}
            onPick={() => {
              setMudePicked(false);
              mu.editSettings((now) => ({ ...now, mode: 'off' }));
            }}
          />
        </div>
      </>
    );
  } else {
    const { provider: startProvider, model } = settings.models.defaults;
    const needed = judge === 'jev' ? jevVariables(judgeProfile) : [];
    const keyReady = needed.every((variable) => Boolean(settings.keys[variable] || draft.judgeKeys[variable]));
    const free = judge === 'jev' && answersFree(judgeProfile, settings.keys, draft.judgeKeys);
    // What the kernel bar will say once this is saved, keys typed in the guide included.
    const typedKeys = Object.fromEntries(
      Object.entries(draft.judgeKeys).map(([name, value]) => [name, Boolean(value)])
    );
    const kernel = summarize({ ...settings, keys: { ...settings.keys, ...typedKeys } });
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
            <dd data-testid='mu-welcome-done-judge'>
              {judgeOff ? (
                t('mu.welcome.judge.none.title')
              ) : (
                <>
                  {judge ? <span className={styles.judgeMark} aria-hidden='true' /> : null}
                  {judge ? t(`mu.judges.choices.${judge}.title`) : t('mu.welcome.done.none')}
                  {free ? (
                    <span className={styles.note}>{t('mu.welcome.done.freeJev')}</span>
                  ) : judge === 'jev' && !keyReady ? (
                    <span className={styles.warn}>{t('mu.welcome.done.noKey')}</span>
                  ) : null}
                </>
              )}
            </dd>
          </div>
          {judge && !judgeOff && kernel.total > 0 ? (
            <div className={styles.summaryRow} data-testid='mu-welcome-kernel'>
              <dt>{t('common.kyrn.hero.kernel')}</dt>
              <dd className={styles.mono}>
                {t('common.kyrn.kernel.points', { active: kernel.active, total: kernel.total })}
              </dd>
            </div>
          ) : null}
          {importable > 0 ? (
            <div className={styles.summaryRow} data-testid='mu-welcome-import'>
              <dt>{t('mu.welcome.done.import')}</dt>
              <dd>
                {t('mu.welcome.done.importFound', { count: importable })}
                <ImportSources chats={found} />
                <Button size='mini' data-testid='mu-welcome-import-open' onClick={() => setImporting(true)}>
                  {t('mu.welcome.done.importOpen')}
                </Button>
              </dd>
            </div>
          ) : null}
        </dl>
        {importDialog}
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
            <MuMark size={step === 'intro' ? 44 : 28} halo={step === 'intro'} />
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
            <button type='button' className={styles.textButton} data-testid='mu-welcome-skip-all' onClick={leave}>
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
