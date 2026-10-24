import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, Progress } from '@arco-design/web-react';
import { Down, Up } from '@icon-park/react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { mutate } from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import {
  type DecisionModel,
  DOWNLOAD_GB_BYTES,
  type ModelRequest,
  type ModelsState,
  type ModelTask,
} from '@/common/kyrn/mude';
import { KERNEL_SUMMARY_KEY } from '@/renderer/components/kernel/useKernelSummary';
import { formatNumber } from '@/renderer/services/i18n/format';
import MuErrorMessage from '../../fields/MuErrorMessage';
import { toMuError, type MuError } from '../../fields/muError';
import { StatusDot, type DotState } from '../../providers/parts';
import { recheckMu } from '../../recheck';
import styles from '../sections.module.css';

/** How often the list is read while a command runs. */
const BUSY_POLL_MS = 1000;
/** The steps said in the app's words while they run; the others are said by the command that runs. */
const LONG_STEPS: ReadonlySet<string> = new Set(['resolve', 'download', 'python', 'start']);
/** The kinds of failure said in the app's words; the others by what failed. */
const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  'usage',
  'access',
  'notFound',
  'notRunnable',
  'network',
  'integrity',
  'unsupported',
]);

/** The last command handed on (see useMude's settledTask): across mounts, each one once. */
let settledTask = 0;

/** The decision models from Hugging Face as a screen sees them, and a way to run `mu judge model`. */
export type ModelsControl = {
  state?: ModelsState;
  /** The bridge itself failed. */
  problem?: MuError;
  busy: boolean;
  run: (request: ModelRequest) => Promise<void>;
  /** Reads the list again: after one of mude's commands, which changes which model is the judge. */
  refresh: () => Promise<void>;
};

/**
 * The list, read on mount and while a command runs. `onSettled` is told once of every command when it ended, done or
 * not: each changes mu.json or what is on this Mac, so the screen reads the settings (and mude's status) again.
 */
export function useDecisionModels(onSettled?: (task: ModelTask) => void): ModelsControl {
  const [state, setState] = useState<ModelsState>();
  const [problem, setProblem] = useState<MuError>();
  const live = useRef(true);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  const take = useCallback((next: ModelsState) => {
    if (!live.current) return;
    setState(next);
    const task = next.task;
    if (!task || task.phase === 'running' || task.id <= settledTask) return;
    settledTask = task.id;
    settled.current?.(task);
    void recheckMu();
    void mutate(KERNEL_SUMMARY_KEY);
  }, []);

  const refresh = useCallback(async () => {
    try {
      take(unwrap(await kyrnBridge.modelsState.invoke()));
    } catch (error) {
      if (live.current) setProblem(toMuError(error));
    }
  }, [take]);

  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
    };
  }, [refresh]);

  const busy = state?.task?.phase === 'running';
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => void refresh(), BUSY_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const run = useCallback(
    async (request: ModelRequest) => {
      setProblem(undefined);
      try {
        take(unwrap(await kyrnBridge.modelsRun.invoke(request)));
      } catch (error) {
        if (live.current) setProblem(toMuError(error));
      }
    },
    [take]
  );

  return { state, problem, busy, run, refresh };
}

type DecisionModelsProps = {
  models: ModelsControl;
  /** The settings have unsaved changes: a command that changes mu.json waits until they are saved or discarded. */
  unsaved: boolean;
  /** One of mude's commands runs: these wait for it. */
  mudeBusy: boolean;
};

/**
 * The decision models added from Hugging Face, under mude on the judges page: each with where it stands and a way to
 * make it the judge, continue its download or remove it, and a field that adds one from its link or owner/name. Each
 * applies at once through `mu judge model` in the main process, outside the save bar.
 */
export default function DecisionModels({ models, unsaved, mudeBusy }: DecisionModelsProps) {
  const { t, i18n } = useTranslation();
  const [modal, modalHolder] = Modal.useModal();
  const [link, setLink] = useState('');
  const { state, problem, busy, run } = models;
  if (!state?.available) return null;
  const language = i18n.language;
  const task = state.task;
  const added = (state.models ?? []).filter((model) => !model.builtIn);
  const locked = busy || mudeBusy || unsaved;

  const add = () => {
    const target = link.trim();
    if (!target || locked) return;
    void run({ action: 'add', target }).then(() => setLink(''));
  };
  const remove = (model: DecisionModel) =>
    modal.confirm?.({
      title: t('mu.judges.models.removeTitle', { name: model.name }),
      content: t('mu.judges.models.removeText', { name: model.name, size: gb(model.bytes, language) }),
      okText: t('mu.judges.models.remove'),
      okButtonProps: { status: 'danger' },
      cancelText: t('common.cancel'),
      onOk: () => void run({ action: 'remove', target: model.name }),
    });

  return (
    <div className={styles.localJudge} data-testid='mu-models'>
      {modalHolder}
      <div className={styles.modelsTitle}>{t('mu.judges.models.title')}</div>
      {added.map((model) => (
        <div key={model.name} className={styles.modelRow} data-testid={`mu-model-${model.name}`}>
          <div className={styles.modelName}>
            <StatusDot state={dotOf(model)} label={stateText(t, model, language)} />
            <span className={styles.modelId}>{model.name}</span>
            <span className={styles.choiceHint} dir='ltr'>
              {model.repo}
            </span>
            <span className={styles.choiceHint}>{stateText(t, model, language)}</span>
          </div>
          <div className={styles.localJudgeActions}>
            {model.installed && !model.enabled ? (
              <Button
                size='small'
                type='primary'
                disabled={locked}
                data-testid={`mu-model-use-${model.name}`}
                onClick={() => void run({ action: 'use', target: model.name })}
              >
                {t('mu.judges.models.use')}
              </Button>
            ) : null}
            {model.installed ? null : (
              <Button
                size='small'
                type='primary'
                disabled={locked}
                data-testid={`mu-model-continue-${model.name}`}
                onClick={() => void run({ action: 'add', target: model.name })}
              >
                {t('mu.judges.models.continue')}
              </Button>
            )}
            <Button
              size='small'
              status='danger'
              disabled={locked}
              data-testid={`mu-model-remove-${model.name}`}
              onClick={() => remove(model)}
            >
              {t('mu.judges.models.remove')}
            </Button>
          </div>
        </div>
      ))}
      {busy && task ? <Working task={task} /> : null}
      <Failure task={task} />
      {state.problem && !state.models ? (
        <div className={styles.localJudgeProblem} role='alert' data-testid='mu-models-problem'>
          {t('mu.judges.models.noList', { reason: state.problem })}
        </div>
      ) : null}
      {busy && task?.command === 'add' ? (
        <div className={styles.localJudgeActions}>
          <Button size='small' data-testid='mu-models-cancel' onClick={() => void run({ action: 'cancel' })}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : null}
      <div className={styles.modelsAdd}>
        <Input
          size='small'
          value={link}
          onChange={setLink}
          onPressEnter={add}
          disabled={busy}
          placeholder={t('mu.judges.models.placeholder')}
          aria-label={t('mu.judges.models.placeholder')}
          data-testid='mu-models-link'
        />
        <Button
          size='small'
          type='primary'
          disabled={locked || !link.trim()}
          data-testid='mu-models-add'
          onClick={add}
        >
          {t('mu.judges.models.add')}
        </Button>
      </div>
      <div className={styles.choiceHint} data-testid='mu-models-trust'>
        {t('mu.judges.models.trust')}
      </div>
      {problem ? (
        <div className={styles.localJudgeProblem} role='alert'>
          <MuErrorMessage error={problem} />
        </div>
      ) : null}
    </div>
  );
}

/** What runs: its step in the app's words, and the download's progress. */
function Working({ task }: { task: ModelTask }) {
  const { t, i18n } = useTranslation();
  const { download, step } = task;
  const name = task.name ?? task.target;
  const label =
    step && LONG_STEPS.has(step)
      ? t(`mu.judges.models.step.${step}`, { name })
      : t(`mu.judges.models.working.${task.command}`, { name });
  const downloaded = download && download.total > 0 ? Math.floor((download.done / download.total) * 100) : 0;
  const percent = step === 'download' ? Math.min(100, downloaded) : step === 'resolve' ? 0 : 100;
  return (
    <>
      <div className={styles.localJudgeStatus} data-testid='mu-models-status'>
        <StatusDot state='busy' label={label} />
        <span>{label}</span>
      </div>
      {task.command === 'add' ? (
        <div data-testid='mu-models-progress'>
          <Progress percent={percent} size='small' color='var(--text-primary)' />
          {step === 'download' && download ? (
            <div className={styles.choiceHint} data-testid='mu-models-download'>
              {download.checking
                ? t('mu.judges.mude.checking')
                : t('mu.judges.mude.downloaded', {
                    done: gb(download.done, i18n.language),
                    total: gb(download.total, i18n.language),
                  })}
            </div>
          ) : null}
        </div>
      ) : null}
      {task.log.length ? (
        <pre className={styles.localJudgeOutput} dir='ltr' data-testid='mu-models-log'>
          {task.log.join('\n')}
        </pre>
      ) : null}
    </>
  );
}

/** How the last command ended when it did not finish: in the app's words, with the command's own folded under. */
function Failure({ task }: { task?: ModelTask }) {
  const { t } = useTranslation();
  const [details, setDetails] = useState(false);
  if (task?.phase === 'cancelled')
    return (
      <div className={styles.choiceHint} data-testid='mu-models-cancelled'>
        {t('mu.judges.models.cancelled')}
      </div>
    );
  if (task?.phase !== 'failed') return null;
  const kind = task.error?.kind;
  return (
    <>
      <div className={styles.localJudgeProblem} role='alert' data-testid='mu-models-failed'>
        {kind && KNOWN_ERRORS.has(kind)
          ? t(`mu.judges.models.error.${kind}`)
          : t(`mu.judges.models.failed.${task.command}`)}
      </div>
      {task.error?.message ? (
        <>
          <Button
            size='mini'
            type='text'
            className={styles.mudeDetails}
            aria-expanded={details}
            data-testid='mu-models-details'
            icon={details ? <Up theme='outline' size='12' /> : <Down theme='outline' size='12' />}
            onClick={() => setDetails((open) => !open)}
          >
            {t('common.error_details')}
          </Button>
          {details ? (
            <pre className={styles.localJudgeOutput} dir='ltr' data-testid='mu-models-error'>
              {[...task.log.slice(-4), task.error.message].join('\n')}
            </pre>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** Decimal gigabytes of `bytes`, with one decimal, as Hugging Face gives sizes. */
const gb = (bytes: number, language: string): string =>
  formatNumber(bytes / DOWNLOAD_GB_BYTES, language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function dotOf(model: DecisionModel): DotState {
  if (model.running) return model.ready ? 'ready' : 'busy';
  return model.installed ? 'off' : 'attention';
}

/** Where a model stands, with its size: the judge, running, installed, or how much of it is downloaded. */
function stateText(t: TFunction, model: DecisionModel, language: string): string {
  const size = gb(model.bytes, language);
  if (!model.installed) {
    return model.downloadedBytes > 0
      ? t('mu.judges.models.state.partial', {
          done: gb(Math.min(model.downloadedBytes, model.bytes), language),
          total: size,
        })
      : t('mu.judges.models.state.notDownloaded', { size });
  }
  if (model.enabled) return t('mu.judges.models.state.judge', { size });
  return t(model.running ? 'mu.judges.models.state.running' : 'mu.judges.models.state.installed', { size });
}
