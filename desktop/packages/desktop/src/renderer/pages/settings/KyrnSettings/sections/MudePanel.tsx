import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Modal, Progress, Switch } from '@arco-design/web-react';
import classNames from 'classnames';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { mutate } from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import {
  MUDE_CHANGES_SETTINGS,
  MUDE_DOWNLOAD_GB,
  MUDE_MEMORY_GB,
  MUDE_PYTHON_GB,
  type MudeAction,
  type MudeState,
  type MudeStatus,
  type MudeTask,
} from '@/common/kyrn/mude';
import { describeTier } from '@/renderer/components/kernel/kernelSummary';
import { KERNEL_SUMMARY_KEY } from '@/renderer/components/kernel/useKernelSummary';
import { formatNumber } from '@/renderer/services/i18n/format';
import { formatNameList } from '@/renderer/services/i18n/list';
import MuErrorMessage from '../fields/MuErrorMessage';
import { toMuError, type MuError } from '../fields/muError';
import Row from '../fields/Row';
import { StatusDot, type DotState } from '../providers/parts';
import { recheckMu } from '../recheck';
import { Card } from './SectionShell';
import styles from './sections.module.css';

const GB = 1024 ** 3;
/** How often the state is read while a command runs, and while the server is starting. */
const BUSY_POLL_MS = 1000;
const STARTING_POLL_MS = 3000;

/**
 * The last command whose change to mu.json the settings have read: kept across mounts, so a command that ended while
 * this page was not shown is read when it is shown again, and only once.
 */
let settledTask = 0;

type MudePanelProps = {
  /** The settings have unsaved changes: a command that changes mu.json waits until they are saved or discarded. */
  unsaved: boolean;
  /** mu.json was changed by mu's command: the settings are read again. */
  onSettingsChanged?: () => void;
};

/**
 * mude, mu's own judge, on a Mac with Apple silicon: install it, switch it on and off, choose whether it is the only
 * judge, start and stop its server, uninstall it. Each applies at once through `mu judge mude` in the main process,
 * outside the save bar; the settings are read again after a command that changed mu.json. Nothing is shown where the
 * app does not offer mude (anything but macOS).
 */
export default function MudePanel({ unsaved, onSettingsChanged }: MudePanelProps) {
  const { t, i18n } = useTranslation();
  const [modal, modalHolder] = Modal.useModal();
  const [state, setState] = useState<MudeState>();
  const [problem, setProblem] = useState<MuError>();
  const live = useRef(true);
  const settings = useRef({ unsaved, onSettingsChanged });
  settings.current = { unsaved, onSettingsChanged };

  const take = useCallback((next: MudeState) => {
    if (!live.current) return;
    setState(next);
    const task = next.task;
    if (!task || task.phase === 'running' || task.id <= settledTask || !MUDE_CHANGES_SETTINGS.has(task.command)) return;
    settledTask = task.id;
    // Unsaved changes stay: their save is then refused as stale, and the page offers to reload.
    if (!settings.current.unsaved) settings.current.onSettingsChanged?.();
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

  const task = state?.task;
  const busy = task?.phase === 'running';
  const starting = Boolean(state?.status?.running && !state.status.ready);
  // The command moves on by itself, and a server takes a while to answer: the state is read meanwhile.
  useEffect(() => {
    if (!busy && !starting) return undefined;
    const timer = setInterval(() => void read(), busy ? BUSY_POLL_MS : STARTING_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, starting, read]);

  const run = async (action: MudeAction, localOnly?: boolean) => {
    setProblem(undefined);
    try {
      take(unwrap(await kyrnBridge.mudeRun.invoke({ action, ...(localOnly === undefined ? {} : { localOnly }) })));
    } catch (error) {
      if (live.current) setProblem(toMuError(error));
    }
  };

  if (!state)
    return problem ? (
      <div className={styles.choiceHint} role='alert'>
        <MuErrorMessage error={problem} />
      </div>
    ) : null;
  if (!state.available) return null;

  const { status } = state;
  const names = (list: string[]) => fallbackNames(list, i18n.language);

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
  const uninstall = () =>
    modal.confirm?.({
      title: t('mu.judges.mude.uninstallTitle'),
      content: t('mu.judges.mude.uninstallText', { size: gb(MUDE_DOWNLOAD_GB + MUDE_PYTHON_GB, i18n.language) }),
      okText: t('mu.judges.mude.uninstall'),
      okButtonProps: { status: 'danger' },
      cancelText: t('common.cancel'),
      onOk: () => void run('uninstall'),
    });

  const installed = Boolean(status?.installed && status.pythonReady);
  const supported = status?.supported !== false;

  return (
    <Card
      title={t('mu.judges.mude.title')}
      judge
      summary={t('mu.judges.mude.intro')}
      testId='mu-mude'
      badges={<span className={styles.choiceTag}>{t('mu.judges.mude.tag')}</span>}
    >
      {modalHolder}
      <div className={classNames(styles.tierPanel, styles.localJudge)}>
        {!supported && status ? (
          <div className={styles.localJudgeModel} data-testid='mu-mude-unsupported'>
            <div>{t('mu.judges.mude.unsupported')}</div>
            {status.problems.map((line) => (
              <div key={line} dir='ltr'>
                {line}
              </div>
            ))}
          </div>
        ) : busy ? (
          <Working task={task} />
        ) : status ? (
          <div className={styles.localJudgeStatus} data-testid='mu-mude-status'>
            <StatusDot state={dotOf(status, installed)} label={statusText(t, status, installed, i18n.language)} />
            <span>{statusText(t, status, installed, i18n.language)}</span>
          </div>
        ) : null}
        {supported && status && installed && !busy ? (
          <div className={styles.choiceHint}>
            {t('mu.judges.mude.resources', { memory: formatNumber(MUDE_MEMORY_GB, i18n.language) })}
          </div>
        ) : null}
        {supported && status && !installed && !busy && (status.installed || status.pythonReady) ? (
          <div className={styles.choiceHint}>{t('mu.judges.mude.unfinished')}</div>
        ) : null}
        <div className={styles.localJudgeActions}>
          {busy && task.command === 'install' ? (
            <Button size='small' data-testid='mu-mude-cancel' onClick={() => void run('cancel')}>
              {t('common.cancel')}
            </Button>
          ) : null}
          {supported && status && !installed && !busy ? (
            <Button size='small' type='primary' disabled={unsaved} data-testid='mu-mude-install' onClick={install}>
              {t('mu.judges.mude.install')}
            </Button>
          ) : null}
          {supported && status && installed && !busy ? (
            <>
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
                disabled={unsaved}
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
        <Failure state={state} />
        {problem ? (
          <div className={styles.localJudgeProblem} role='alert'>
            <MuErrorMessage error={problem} />
          </div>
        ) : null}
      </div>
      {supported && status && installed ? (
        <>
          <Row title={t('mu.judges.mude.use')} help={t('mu.judges.mude.useHelp')} testId='mu-mude-use'>
            <Switch
              size='small'
              aria-label={t('mu.judges.mude.use')}
              checked={status.enabled}
              loading={busy && (task.command === 'enable' || task.command === 'disable')}
              disabled={busy || unsaved}
              onChange={(on: boolean) => void run(on ? 'enable' : 'disable')}
            />
          </Row>
          <Row title={t('mu.judges.mude.localOnly')} testId='mu-mude-local-only'>
            <Switch
              size='small'
              aria-label={t('mu.judges.mude.localOnly')}
              checked={status.localOnly}
              disabled={busy || unsaved || !status.enabled}
              onChange={(on: boolean) => void run('enable', on)}
            />
          </Row>
          <div className={styles.choiceHint} data-testid='mu-mude-local-only-help'>
            {localOnlyText(t, status.localOnly, status.fallback, names)}
          </div>
        </>
      ) : null}
    </Card>
  );
}

/** What runs: the command's sentence for its step, the download's progress, the Python installer's last lines. */
function Working({ task }: { task: MudeTask }) {
  const { t, i18n } = useTranslation();
  const { download } = task;
  const label = task.message || t(`mu.judges.mude.working.${task.command}`);
  const percent =
    download && download.total > 0 ? Math.min(100, Math.floor((download.done / download.total) * 100)) : 0;
  return (
    <>
      <div className={styles.localJudgeStatus} data-testid='mu-mude-status'>
        <StatusDot state='busy' label={label} />
        <span dir={task.message ? 'ltr' : undefined}>{label}</span>
      </div>
      {task.step === 'download' && download ? (
        <div data-testid='mu-mude-download'>
          <Progress percent={percent} size='small' color='var(--text-primary)' />
          <div className={styles.choiceHint}>
            {download.checking
              ? t('mu.judges.mude.checking')
              : t('mu.judges.mude.downloaded', {
                  done: gb(download.done / GB, i18n.language),
                  total: gb(download.total / GB, i18n.language),
                })}
          </div>
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

/** Why the last command failed, or that the install was cancelled; why the status could not be read. */
function Failure({ state }: { state: MudeState }) {
  const { t } = useTranslation();
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
          <pre className={styles.localJudgeOutput} dir='ltr' data-testid='mu-mude-error'>
            {[...task.log.slice(-4), task.error.message].join('\n')}
          </pre>
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
          checked={localOnly}
          onChange={(next: boolean) => {
            setLocalOnly(next);
            onLocalOnly(next);
          }}
        >
          {t('mu.judges.mude.localOnly')}
        </Checkbox>
        <div className={styles.choiceHint}>
          {localOnlyText(t, localOnly, fallback.length ? fallback : ['jev'], (list) => fallbackNames(list, language))}
        </div>
      </div>
    </div>
  );
}

/** Gigabytes with one decimal, in the app language. */
const gb = (value: number, language: string): string =>
  formatNumber(value, language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** The judges behind mude by their names (Jev, Laya), each once. */
const fallbackNames = (list: string[], language: string): string =>
  formatNameList([...new Set(list.map((name) => describeTier(name, {}).judge))], language);

/** Whether every judge behind mude runs on this Mac too: then nothing leaves it. */
const allLocal = (list: string[]): boolean =>
  list.every((name) => name === 'mock' || describeTier(name, {}).via === 'local');

/**
 * What "only local" means, said where it is chosen: with it on, mude alone; with it off, the judges behind mude get
 * what it cannot answer and two security checks, and a hosted judge takes what it reads off this Mac.
 */
function localOnlyText(t: TFunction, localOnly: boolean, fallback: string[], names: (list: string[]) => string) {
  if (localOnly) return t('mu.judges.mude.localOnlyOn');
  if (fallback.length === 0) return t('mu.judges.mude.localOnlyNone');
  const judges = names(fallback);
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
