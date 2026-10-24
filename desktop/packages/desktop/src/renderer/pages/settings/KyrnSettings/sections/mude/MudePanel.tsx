import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Modal, Progress, Switch } from '@arco-design/web-react';
import { Down, Up } from '@icon-park/react';
import classNames from 'classnames';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { mutate } from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import {
  DOWNLOAD_GB_BYTES,
  MUDE_CHANGES_SETTINGS,
  MUDE_DOWNLOAD_GB,
  MUDE_MEMORY_GB,
  MUDE_MIN_RAM_GB,
  MUDE_PYTHON_GB,
  type MudeAction,
  type MudeState,
  type MudeStatus,
  type MudeStep,
  type MudeTask,
} from '@/common/kyrn/mude';
import { describeTier } from '@/renderer/components/kernel/kernelSummary';
import { KERNEL_SUMMARY_KEY } from '@/renderer/components/kernel/useKernelSummary';
import { formatNumber } from '@/renderer/services/i18n/format';
import { formatNameList } from '@/renderer/services/i18n/list';
import MuErrorMessage from '../../fields/MuErrorMessage';
import { toMuError, type MuError } from '../../fields/muError';
import Row from '../../fields/Row';
import { StatusDot, type DotState } from '../../providers/parts';
import { recheckMu } from '../../recheck';
import styles from '../sections.module.css';

/** Memory is counted in binary gigabytes; downloads in decimal ones (DOWNLOAD_GB_BYTES), as Hugging Face gives them. */
const GB = 1024 ** 3;
/** How often the state is read while a command runs, and while the server is starting. */
const BUSY_POLL_MS = 1000;
const STARTING_POLL_MS = 3000;
/** The steps that take a while, each said in the app's words while it runs; the others are said by what runs. */
const LONG_STEPS: ReadonlySet<MudeStep> = new Set(['download', 'python', 'start']);

/**
 * The last command whose change to mu.json was handed on: kept across mounts, so a command that ended while no page
 * showed mude is handed on when one does, and only once.
 */
let settledTask = 0;

/** mude as a screen sees it: what the main process last said, and a way to run one of mu's mude commands. */
export type MudeControl = {
  state?: MudeState;
  /** The bridge itself failed. */
  problem?: MuError;
  /** A command runs. */
  busy: boolean;
  run: (action: MudeAction, localOnly?: boolean) => Promise<void>;
  /** Reads the status again: after a command of the added models, which changes whether mude is the judge. */
  refresh: () => Promise<void>;
};

/**
 * mude's state, read on mount and while a command runs or its server starts. `onSettled` is told once of every
 * command that changed mu.json (install, enable, disable, uninstall) when it ended, done or not: the screen reads the
 * settings again. mu is checked again and the kernel bar read again here.
 */
export function useMude(onSettled?: (task: MudeTask) => void): MudeControl {
  const [state, setState] = useState<MudeState>();
  const [problem, setProblem] = useState<MuError>();
  const live = useRef(true);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  const take = useCallback((next: MudeState) => {
    if (!live.current) return;
    setState(next);
    const task = next.task;
    if (!task || task.phase === 'running' || task.id <= settledTask || !MUDE_CHANGES_SETTINGS.has(task.command)) return;
    settledTask = task.id;
    settled.current?.(task);
    void recheckMu();
    void mutate(KERNEL_SUMMARY_KEY);
  }, []);

  const read = useCallback(async () => {
    try {
      take(unwrap(await kyrnBridge.mudeState.invoke()));
    } catch (error) {
      if (live.current) setProblem(toMuError(error));
    }
  }, [take]);

  useEffect(() => {
    live.current = true;
    void read();
    return () => {
      live.current = false;
    };
  }, [read]);

  const busy = state?.task?.phase === 'running';
  const starting = Boolean(state?.status?.running && !state.status.ready);
  // The command moves on by itself, and a server takes a while to answer: the state is read meanwhile.
  useEffect(() => {
    if (!busy && !starting) return undefined;
    const timer = setInterval(() => void read(), busy ? BUSY_POLL_MS : STARTING_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, starting, read]);

  const run = useCallback(
    async (action: MudeAction, localOnly?: boolean) => {
      setProblem(undefined);
      try {
        take(unwrap(await kyrnBridge.mudeRun.invoke({ action, ...(localOnly === undefined ? {} : { localOnly }) })));
      } catch (error) {
        if (live.current) setProblem(toMuError(error));
      }
    },
    [take]
  );

  return { state, problem, busy, run, refresh: read };
}

/** Whether mude can be set up on this machine, as far as is known: unknown (still being read) counts as yes. */
export function mudeOffered(state: MudeState | undefined): boolean {
  if (!state) return true;
  if (!state.available) return false;
  if (state.status) return state.status.supported;
  return !state.problem;
}

/**
 * mude can run on this Mac, as its status says: it is then the recommended judge, shown first with a tag that says so.
 * Unlike `mudeOffered`, a state still being read is no: until the status says so, every choice stays as it was.
 */
export const mudeRecommended = (state: MudeState | undefined): boolean =>
  Boolean(state?.available && state.status?.supported);

/** mude is downloaded and its Python environment set up. */
export const mudeInstalled = (status: MudeStatus | undefined): boolean =>
  Boolean(status?.supported && status.installed && status.pythonReady);

/**
 * An install stopped part way, not one never started: some of the model is on disk (a partly downloaded file
 * included), or its Python environment is set up, but not all of it. Continuing it goes on from there.
 */
const mudeUnfinished = (status: MudeStatus | undefined): boolean =>
  Boolean(
    status && !mudeInstalled(status) && (status.installed || status.pythonReady || (status.downloadedBytes ?? 0) > 0)
  );

/** The last install was cancelled or failed: what it says of itself already tells that it did not finish. */
const installEnded = (task: MudeTask | undefined): boolean =>
  task?.command === 'install' && (task.phase === 'cancelled' || task.phase === 'failed');

/**
 * Why this machine cannot run mude: one plain sentence, and the command's reasons under it. `guide`: in the first-run
 * guide, which also says what mu does instead.
 */
export function MudeUnsupported({ state, guide = false }: { state?: MudeState; guide?: boolean }) {
  const { t, i18n } = useTranslation();
  const problems = state?.status?.problems ?? [];
  return (
    <span data-testid='mu-mude-unsupported'>
      {t('mu.judges.mude.needs', { ram: formatNumber(MUDE_MIN_RAM_GB, i18n.language) })}
      {guide ? ` ${t('mu.judges.mude.guide.instead')}` : null}
      {problems.map((line) => (
        <span key={line} className={styles.mudeReason} dir='ltr'>
          {line}
        </span>
      ))}
    </span>
  );
}

type MudePanelProps = {
  mude: MudeControl;
  /** The settings have unsaved changes: a command that changes mu.json waits until they are saved or discarded. */
  unsaved: boolean;
  /** A command of the added models runs: mude's that change the judge wait for it. */
  waiting?: boolean;
};

/**
 * mude chosen as the judge on the judges page: install it (after the consent, or straight on where an install stopped
 * part way), or where it is installed, its server, whether it is the only judge, its folder and uninstalling it. Each
 * applies at once through `mu judge mude` in the main process, outside the save bar.
 */
export default function MudePanel({ mude, unsaved, waiting = false }: MudePanelProps) {
  const { t, i18n } = useTranslation();
  const [modal, modalHolder] = Modal.useModal();
  const { state, problem, busy, run } = mude;
  if (!state)
    return problem ? (
      <div className={styles.choiceHint} role='alert'>
        <MuErrorMessage error={problem} />
      </div>
    ) : null;

  const { status, task } = state;
  const language = i18n.language;
  const installed = mudeInstalled(status);
  const supported = status?.supported !== false;
  const unfinished = mudeUnfinished(status);
  // The line under the status: what it takes while it runs (only where the status does not already say what it
  // uses), how much of an install that stopped part way is there, or what installing takes.
  let hint: string | undefined;
  if (installed) {
    if (!(status?.running && status.ready && status.memoryBytes))
      hint = t('mu.judges.mude.resources', { memory: formatNumber(MUDE_MEMORY_GB, language) });
  } else if (unfinished) hint = unfinishedLine(t, status, installEnded(task), language);
  else hint = consentLine(t, language);

  const install = () => {
    let localOnly = false;
    modal.confirm?.({
      title: t('mu.judges.mude.consent.title'),
      content: (
        <Consent
          fallback={status?.fallback ?? []}
          onLocalOnly={(next) => {
            localOnly = next;
          }}
        />
      ),
      okText: t('mu.judges.mude.consent.ok'),
      cancelText: t('common.cancel'),
      onOk: () => void run('install', localOnly),
    });
  };
  // An install that stopped part way goes on as it was agreed to: no consent again, and no "Only local" either way,
  // so the command keeps the choice the stopped install was started with.
  const resume = (): void => {
    void run('install');
  };
  const uninstall = () =>
    modal.confirm?.({
      title: t('mu.judges.mude.uninstallTitle'),
      content: t('mu.judges.mude.uninstallText', { size: gb(MUDE_DOWNLOAD_GB + MUDE_PYTHON_GB, language) }),
      okText: t('mu.judges.mude.uninstall'),
      okButtonProps: { status: 'danger' },
      cancelText: t('common.cancel'),
      onOk: () => void run('uninstall'),
    });

  return (
    <div className={styles.localJudge} data-testid='mu-mude'>
      {modalHolder}
      {!supported ? (
        <div className={styles.localJudgeModel}>
          <MudeUnsupported state={state} />
        </div>
      ) : busy && task ? (
        <Working task={task} />
      ) : status ? (
        <div className={styles.localJudgeStatus} data-testid='mu-mude-status'>
          <StatusDot state={dotOf(status, installed)} label={statusText(t, status, installed, language)} />
          <span>{statusText(t, status, installed, language)}</span>
        </div>
      ) : null}
      {supported && status && !busy && hint ? (
        <div className={styles.choiceHint} data-testid='mu-mude-hint'>
          {hint}
        </div>
      ) : null}
      {/* How the last command ended, above the button that runs it again. */}
      <Failure state={state} />
      <div className={styles.localJudgeActions}>
        {busy && task?.command === 'install' ? (
          <Button size='small' data-testid='mu-mude-cancel' onClick={() => void run('cancel')}>
            {t('common.cancel')}
          </Button>
        ) : null}
        {supported && status && !installed && !busy ? (
          <Button
            size='small'
            type='primary'
            disabled={unsaved || waiting}
            data-testid='mu-mude-install'
            onClick={unfinished ? resume : install}
          >
            {t(unfinished ? 'mu.judges.mude.continue' : 'mu.judges.mude.install')}
          </Button>
        ) : null}
        {supported && status && installed && !busy ? (
          <>
            {status.enabled ? null : (
              <Button
                size='small'
                type='primary'
                disabled={unsaved || waiting}
                data-testid='mu-mude-use'
                onClick={() => void run('enable')}
              >
                {t('mu.judges.mude.use')}
              </Button>
            )}
            {status.running ? (
              <Button size='small' data-testid='mu-mude-stop' onClick={() => void run('stop')}>
                {t('mu.judges.mude.stop')}
              </Button>
            ) : (
              <Button size='small' data-testid='mu-mude-start' onClick={() => void run('start')}>
                {t('mu.judges.mude.start')}
              </Button>
            )}
            <Button size='small' data-testid='mu-mude-open' onClick={() => void run('open')}>
              {t('mu.judges.mude.openFolder')}
            </Button>
            <Button
              size='small'
              status='danger'
              disabled={unsaved || waiting}
              data-testid='mu-mude-uninstall'
              onClick={uninstall}
            >
              {t('mu.judges.mude.uninstall')}
            </Button>
          </>
        ) : null}
      </div>
      {supported && status && unsaved && !busy ? (
        <div className={styles.choiceHint} data-testid='mu-mude-unsaved'>
          {t('mu.judges.mude.saveFirst')}
        </div>
      ) : null}
      {problem ? (
        <div className={styles.localJudgeProblem} role='alert'>
          <MuErrorMessage error={problem} />
        </div>
      ) : null}
      {supported && status && installed && status.enabled ? (
        <div>
          <Row title={t('mu.judges.mude.localOnly')} testId='mu-mude-local-only'>
            <Switch
              size='small'
              aria-label={t('mu.judges.mude.localOnly')}
              checked={status.localOnly}
              disabled={busy || unsaved || waiting}
              onChange={(on: boolean) => void run('enable', on)}
            />
          </Row>
          <div className={styles.choiceHint} data-testid='mu-mude-local-only-help'>
            {localOnlyText(t, status.localOnly, status.fallback, language)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type MudeSetupProps = {
  mude: MudeControl;
  /** The guide's settings ask mude first. */
  judged: boolean;
};

/**
 * mude in the first-run guide, set up where it is picked: what it takes, one button, the install's progress, why it
 * failed with a way to try again, how much of an install that stopped part way is there with a way to continue it,
 * and that it is the judge once it is. With the judges behind it as usual; the settings have the rest.
 */
export function MudeSetup({ mude, judged }: MudeSetupProps) {
  const { t, i18n } = useTranslation();
  const { state, problem, busy, run } = mude;
  if (!state)
    return problem ? (
      <div className={styles.localJudgeProblem} role='alert'>
        <MuErrorMessage error={problem} />
      </div>
    ) : null;
  const { status, task } = state;
  const language = i18n.language;
  if (busy && task)
    return (
      <div className={styles.localJudge} data-testid='mu-mude'>
        <Working task={task} />
        {task.command === 'install' ? (
          <div className={styles.localJudgeActions}>
            <Button size='small' data-testid='mu-mude-cancel' onClick={() => void run('cancel')}>
              {t('common.cancel')}
            </Button>
          </div>
        ) : null}
      </div>
    );
  if (judged && status?.enabled)
    return (
      <div className={styles.localJudge} data-testid='mu-mude'>
        <div className={styles.localJudgeStatus} role='status' data-testid='mu-mude-ready'>
          <StatusDot state={status.running ? 'ready' : 'off'} label={t('mu.judges.mude.guide.ready')} />
          <span>{t(status.running ? 'mu.judges.mude.guide.ready' : 'mu.judges.mude.guide.readyStopped')}</span>
        </div>
      </div>
    );
  const installed = mudeInstalled(status);
  const unfinished = mudeUnfinished(status);
  const failed = task?.phase === 'failed' && (task.command === 'install' || task.command === 'enable');
  // The line above the button: what mude takes while it runs, how much of an install that stopped part way is there
  // (it goes on as agreed to when it started, so not what installing takes again), or what installing takes. Not
  // after a failure, which says why under it, unless an install stopped part way.
  let hint: string | undefined;
  if (unfinished) hint = unfinishedLine(t, status, failed || installEnded(task), language);
  else if (failed) hint = undefined;
  else if (installed) hint = t('mu.judges.mude.resources', { memory: formatNumber(MUDE_MEMORY_GB, language) });
  else hint = consentLine(t, language);
  return (
    <div className={styles.localJudge} data-testid='mu-mude'>
      {hint ? (
        <div className={styles.choiceHint} data-testid='mu-mude-hint'>
          {hint}
        </div>
      ) : null}
      {/* Why the last command failed, or a cancelled install, above the button that goes on. */}
      <Failure state={state} />
      <div className={styles.localJudgeActions}>
        {failed ? (
          <Button
            size='small'
            type='primary'
            data-testid='mu-mude-retry'
            onClick={() => void run(task.command === 'enable' && installed ? 'enable' : 'install')}
          >
            {t(unfinished ? 'mu.judges.mude.continue' : 'mu.judges.mude.retry')}
          </Button>
        ) : (
          <Button
            size='small'
            type='primary'
            data-testid='mu-mude-install'
            onClick={() => void run(installed ? 'enable' : 'install')}
          >
            {t(installed ? 'mu.judges.mude.use' : unfinished ? 'mu.judges.mude.continue' : 'mu.judges.mude.install')}
          </Button>
        )}
      </div>
      {problem ? (
        <div className={styles.localJudgeProblem} role='alert'>
          <MuErrorMessage error={problem} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * What runs, in the app language: the step that takes a while (the download, the Python environment, the server's
 * start), else the command; and the last Python lines. An install shows its progress too, the download's share of it
 * (full once the download is done and the later steps run), in decimal gigabytes as the consent gives the size. The
 * command's own English sentence for the step is not shown: it says the size a second time, in other units.
 */
function Working({ task }: { task: MudeTask }) {
  const { t, i18n } = useTranslation();
  const { download, step } = task;
  const label =
    step && LONG_STEPS.has(step) ? t(`mu.judges.mude.step.${step}`) : t(`mu.judges.mude.working.${task.command}`);
  const downloaded = download && download.total > 0 ? Math.floor((download.done / download.total) * 100) : 0;
  const percent = step && step !== 'download' ? 100 : Math.min(100, downloaded);
  return (
    <>
      <div className={styles.localJudgeStatus} data-testid='mu-mude-status'>
        <StatusDot state='busy' label={label} />
        <span>{label}</span>
      </div>
      {task.command === 'install' ? (
        <div data-testid='mu-mude-progress'>
          <Progress percent={percent} size='small' color='var(--text-primary)' />
          {task.step === 'download' && download ? (
            <div className={styles.choiceHint} data-testid='mu-mude-download'>
              {download.checking
                ? t('mu.judges.mude.checking')
                : t('mu.judges.mude.downloaded', {
                    done: gb(download.done / DOWNLOAD_GB_BYTES, i18n.language),
                    total: gb(download.total / DOWNLOAD_GB_BYTES, i18n.language),
                  })}
            </div>
          ) : null}
        </div>
      ) : null}
      {task.log.length ? (
        <pre className={styles.localJudgeOutput} dir='ltr' data-testid='mu-mude-log'>
          {task.log.join('\n')}
        </pre>
      ) : null}
    </>
  );
}

/**
 * Why the last command failed, or that the install was cancelled; why the status could not be read. The command's own
 * output stays folded behind "Error details": a few lines of English that would push the rest (the guide's Back and
 * Next) out of a small window.
 */
function Failure({ state }: { state: MudeState }) {
  const { t } = useTranslation();
  const [details, setDetails] = useState(false);
  const { task } = state;
  if (task?.phase === 'cancelled')
    return (
      <div className={styles.choiceHint} data-testid='mu-mude-cancelled'>
        {t('mu.judges.mude.cancelled')}
      </div>
    );
  if (task?.phase === 'failed') {
    const kind = task.error?.kind;
    const known = kind === 'access' || kind === 'network' || kind === 'integrity' || kind === 'unsupported';
    return (
      <>
        <div className={styles.localJudgeProblem} role='alert' data-testid='mu-mude-failed'>
          {known ? t(`mu.judges.mude.error.${kind}`) : t(`mu.judges.mude.failed.${task.command}`)}
        </div>
        {/* The command's own words, in English, under a sentence that does not already say it all. */}
        {task.error?.message && kind !== 'access' ? (
          <>
            <Button
              size='mini'
              type='text'
              className={styles.mudeDetails}
              aria-expanded={details}
              data-testid='mu-mude-details'
              icon={details ? <Up theme='outline' size='12' /> : <Down theme='outline' size='12' />}
              onClick={() => setDetails((open) => !open)}
            >
              {t('common.error_details')}
            </Button>
            {details ? (
              <pre className={styles.localJudgeOutput} dir='ltr' data-testid='mu-mude-error'>
                {[...task.log.slice(-4), task.error.message].join('\n')}
              </pre>
            ) : null}
          </>
        ) : null}
      </>
    );
  }
  if (state.problem && !state.status)
    return (
      <div className={styles.localJudgeProblem} role='alert' data-testid='mu-mude-problem'>
        {t('mu.judges.mude.noStatus', { reason: state.problem })}
      </div>
    );
  return null;
}

/** The consent before installing: what it takes, and whether mude is to be the only judge. */
function Consent({ fallback, onLocalOnly }: { fallback: string[]; onLocalOnly: (localOnly: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const [localOnly, setLocalOnly] = useState(false);
  const language = i18n.language;
  return (
    <div className={styles.choiceFields} data-testid='mu-mude-consent'>
      <div>
        {t('mu.judges.mude.consent.download', {
          download: gb(MUDE_DOWNLOAD_GB, language),
          python: gb(MUDE_PYTHON_GB, language),
        })}
      </div>
      <div>{t('mu.judges.mude.consent.memory', { memory: formatNumber(MUDE_MEMORY_GB, language) })}</div>
      <div>{t('mu.judges.mude.consent.after')}</div>
      <div className={styles.choiceField}>
        <Checkbox
          className={styles.mudeConsentCheck}
          checked={localOnly}
          onChange={(next: boolean) => {
            setLocalOnly(next);
            onLocalOnly(next);
          }}
        >
          {t('mu.judges.mude.localOnly')}
        </Checkbox>
        {/* Both explanations take their place, the one not chosen unseen: ticking the box never resizes the dialog. */}
        <div className={styles.mudeConsentHelp}>
          {[false, true].map((only) => (
            <div
              key={String(only)}
              className={classNames(styles.choiceHint, only !== localOnly && styles.mudeConsentHidden)}
              aria-hidden={only !== localOnly}
              data-testid={only === localOnly ? 'mu-mude-consent-help' : undefined}
            >
              {localOnlyText(t, only, fallback.length ? fallback : ['jev'], language)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The one line that says what installing takes, where it is started from a button. */
const consentLine = (t: TFunction, language: string): string =>
  t('mu.judges.mude.guide.consent', {
    download: gb(MUDE_DOWNLOAD_GB, language),
    python: gb(MUDE_PYTHON_GB, language),
    memory: formatNumber(MUDE_MEMORY_GB, language),
  });

/**
 * How much of an install that stopped part way is there, said where it is continued: the model's share on disk, and
 * that continuing picks up from there. `ended`: how the install ended (cancelled, failed) is said beside it, and says
 * what is kept; then only the amount, or nothing when none of the model is there.
 */
function unfinishedLine(
  t: TFunction,
  status: MudeStatus | undefined,
  ended: boolean,
  language: string
): string | undefined {
  const bytes = status?.downloadedBytes ?? 0;
  if (bytes <= 0) return ended ? undefined : t('mu.judges.mude.unfinished');
  // In decimal gigabytes as the consent gives the size, and never more than all of it.
  const amount = {
    done: gb(Math.min(bytes / DOWNLOAD_GB_BYTES, MUDE_DOWNLOAD_GB), language),
    total: gb(MUDE_DOWNLOAD_GB, language),
  };
  return ended ? t('mu.judges.mude.downloadedSoFar', amount) : t('mu.judges.mude.unfinishedDownloaded', amount);
}

/** Gigabytes with one decimal, in the app language. */
const gb = (value: number, language: string): string =>
  formatNumber(value, language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Whether every judge behind mude runs on this Mac too: then nothing leaves it. */
const allLocal = (list: string[]): boolean =>
  list.every((name) => name === 'mock' || describeTier(name, {}).via === 'local');

/**
 * What "only local" means, said where it is chosen: with it on, mude alone; with it off, the judges behind mude (by
 * their names, each once) get what it cannot answer and two security checks, and a hosted one takes what it reads off
 * this Mac.
 */
function localOnlyText(t: TFunction, localOnly: boolean, fallback: string[], language: string) {
  if (localOnly) return t('mu.judges.mude.localOnlyOn');
  if (fallback.length === 0) return t('mu.judges.mude.localOnlyNone');
  const judges = formatNameList([...new Set(fallback.map((name) => describeTier(name, {}).judge))], language);
  return allLocal(fallback)
    ? t('mu.judges.mude.localOnlyOffLocal', { judges })
    : t('mu.judges.mude.localOnlyOff', { judges });
}

function dotOf(status: MudeStatus, installed: boolean): DotState {
  if (status.running) return status.ready ? 'ready' : 'busy';
  return installed ? 'off' : 'attention';
}

function statusText(t: TFunction, status: MudeStatus, installed: boolean, language: string): string {
  if (!installed) return t('mu.judges.mude.notInstalled');
  if (!status.running) return t('mu.judges.mude.status.stopped');
  if (!status.ready) return t('mu.judges.mude.status.starting');
  return status.memoryBytes
    ? t('mu.judges.mude.status.runningMemory', { port: status.port, memory: gb(status.memoryBytes / GB, language) })
    : t('mu.judges.mude.status.running', { port: status.port });
}
