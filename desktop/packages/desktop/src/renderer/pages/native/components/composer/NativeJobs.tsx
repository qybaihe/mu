/**
 * The commands mu runs in the background for the agent (`bg_start`: a dev server, a watcher, a long build), as a pill
 * at the left of the send box while one runs: how many, and a click lists them. Each shows its name, its command, how
 * long it has run or how it ended, its log (opened in the preview) and a stop button; with more than one running, one
 * button stops them all. Stopping is mu's own `/jobs stop <id|all>`, which runs at once, during a run too. The list
 * comes from mu's `background.*` frames (the view's `host.jobs`); a job that ended stays listed while another runs.
 */
import { Button, Popover } from '@arco-design/web-react';
import { Down, FileText, Terminal } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeResult } from '@/common/kyrn/nativeBridge';
import { isJobLive, type PiCommand, type ViewJob } from '@/common/utils/nativeHost';
import RuntimeSelectorPill from '@/renderer/components/agent/RuntimeSelectorPill';
import { useOptionalLocalFilePreview } from '@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview';
import { formatDuration } from '@/renderer/services/i18n/format';
import { iconColors } from '@/renderer/styles/colors';

/** How many jobs that ended the list keeps showing below the running ones. */
const ENDED_SHOWN = 3;

/** A job still has something running: itself, or processes it started. */

/** mu's command that stops a job, or every job that runs. */
export const stopCommand = (id: string | 'all'): string => `/jobs stop ${id}`;

function JobRow({
  job,
  now,
  busy,
  onStop,
  onLog,
}: {
  job: ViewJob;
  now: number;
  busy: boolean;
  onStop: () => void;
  onLog?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const time = (ms: number) => formatDuration(ms, i18n.language, 'narrow');
  const state =
    job.state === 'running'
      ? t('mu.native.jobs.runningFor', { time: time(now - job.startedAt) })
      : job.state === 'stopping'
        ? t('mu.native.jobs.stopping')
        : job.stoppedBy
          ? t('mu.native.jobs.stoppedAfter', { time: time(job.durationMs ?? 0) })
          : t('mu.native.jobs.exited', { code: job.exitCode ?? '?', time: time(job.durationMs ?? 0) });
  return (
    <div className='flex items-start gap-8px py-6px' data-testid='native-job' data-job={job.id} data-state={job.state}>
      <span
        aria-hidden='true'
        className={`mt-6px h-6px w-6px shrink-0 rd-full ${isJobLive(job) ? 'bg-success' : 'bg-fill-3'}`}
      />
      <div className='min-w-0 flex-1'>
        <div className='flex items-baseline gap-6px min-w-0'>
          <span className='text-13px text-t-primary truncate'>{job.name}</span>
          <span className='text-12px text-t-secondary shrink-0'>{state}</span>
        </div>
        <div className='text-12px text-t-secondary truncate font-mono' title={job.command} dir='ltr'>
          {job.command}
        </div>
        {job.lingering ? <div className='text-12px text-t-secondary'>{t('mu.native.jobs.lingering')}</div> : null}
      </div>
      <div className='flex items-center gap-2px shrink-0'>
        {job.logPath && onLog ? (
          <Button
            type='text'
            size='mini'
            icon={<FileText size={14} fill={iconColors.secondary} />}
            aria-label={t('mu.native.jobs.log')}
            title={t('mu.native.jobs.log')}
            data-testid='native-job-log'
            onClick={onLog}
          />
        ) : null}
        {isJobLive(job) ? (
          <Button
            size='mini'
            loading={busy}
            disabled={job.state === 'stopping'}
            onClick={onStop}
            data-testid='native-job-stop'
          >
            {t('mu.native.jobs.stop')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const NativeJobs: React.FC<{
  jobs: readonly ViewJob[] | undefined;
  /** The conversation's folder, where a log opens in the preview from. */
  cwd?: string;
  request: (command: PiCommand) => Promise<NativeResult<unknown>>;
}> = ({ jobs = [], cwd, request }) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [stopping, setStopping] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const openFile = useOptionalLocalFilePreview(cwd);
  const live = jobs.filter(isJobLive);
  const ended = jobs.filter((job) => !isJobLive(job)).slice(-ENDED_SHOWN);

  // The running time counts up while the list is open.
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);
  // Nothing runs any more: the list goes with the pill.
  useEffect(() => {
    if (!live.length) setVisible(false);
  }, [live.length]);

  if (!live.length) return null;

  const stop = async (id: string | 'all') => {
    setStopping(id);
    try {
      await request({ type: 'prompt', message: stopCommand(id) });
    } finally {
      setStopping(undefined);
    }
  };

  const list = (
    <div className='w-360px max-w-[80vw]' data-testid='native-jobs-list'>
      <div className='flex items-center justify-between gap-8px pb-4px'>
        <span className='text-13px font-500 text-t-primary'>{t('mu.native.jobs.title')}</span>
        {live.length > 1 ? (
          <Button
            size='mini'
            loading={stopping === 'all'}
            onClick={() => void stop('all')}
            data-testid='native-jobs-stop-all'
          >
            {t('mu.native.jobs.stopAll')}
          </Button>
        ) : null}
      </div>
      {[...live, ...ended].map((job) => (
        <JobRow
          key={job.id}
          job={job}
          now={now}
          busy={stopping === job.id || stopping === 'all'}
          onStop={() => void stop(job.id)}
          onLog={openFile && job.logPath ? () => openFile(job.logPath as string) : undefined}
        />
      ))}
    </div>
  );

  return (
    <Popover trigger='click' position='top' popupVisible={visible} onVisibleChange={setVisible} content={list}>
      <span data-testid='native-jobs' data-count={live.length} className='inline-flex'>
        <RuntimeSelectorPill
          testId='native-jobs-pill'
          className='sendbox-model-btn agent-mode-compact-pill'
          label={`${t('mu.native.jobs.label')} · ${live.length}`}
          leading={<Terminal theme='outline' size='14' fill={iconColors.secondary} className='shrink-0' />}
          trailing={<Down size={12} className='text-t-tertiary shrink-0' />}
          onClick={() => setVisible((open) => !open)}
        />
      </span>
    </Popover>
  );
};

export default NativeJobs;
