/**
 * The pull request of the branch, under the source tab's branch line (docs/native-host-ui.md): its number and title,
 * which open it on GitHub, where it stands, and its checks, counted, each listed with the page that says more. GitHub's
 * own CLI reads them in the main process (common/kyrn/gitBridge.ts `pr`), as the person, when the tab reads the
 * repository, and every 30 seconds while a check is still running and the tab is in view. Without gh, signed out, or in
 * a repository GitHub does not hold, there is no row.
 *
 * A branch with none (not the repository's default one) offers to have mu open it: that puts the request into the send
 * box, for the person to send. The push and the pull request are then mu's work, asked about as any command is.
 */
import { Button, Popover } from '@arco-design/web-react';
import { CheckOne, CloseOne, PullRequests, Time } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { unwrap } from '@/common/kyrn/bridge';
import { kyrnGitBridge, type FolderGitPr, type GitCheck, type GitCheckState } from '@/common/kyrn/gitBridge';
import { emitter } from '@/renderer/utils/emitter';
import { openExternalUrl } from '@/renderer/utils/platform';

/** How often the checks are read again while one is still running and the tab is in view. */
export const PR_CHECKS_POLL_MS = 30_000;

const STATE_ICON: Record<GitCheckState, React.ReactNode> = {
  pass: <CheckOne theme='filled' size={12} className='text-success shrink-0' />,
  fail: <CloseOne theme='filled' size={12} className='text-danger shrink-0' />,
  pending: <Time theme='outline' size={12} className='text-warning shrink-0' />,
  skipped: <CheckOne theme='outline' size={12} className='text-t-tertiary shrink-0' />,
};

const count = (checks: readonly GitCheck[], state: GitCheckState): number =>
  checks.filter((check) => check.state === state).length;

const open = (url: string): void => {
  openExternalUrl(url).catch((): undefined => undefined);
};

export default function NativeSourcePr({
  cwd,
  branch,
  visible,
  refresh,
}: {
  cwd: string;
  /** The branch checked out; none when HEAD is detached. */
  branch?: string;
  visible: boolean;
  /** Changes when the tab reads the repository again: a run ended, its refresh button. */
  refresh: unknown;
}) {
  const { t } = useTranslation();
  const [pr, setPr] = useState<FolderGitPr | null>(null);

  const read = useCallback(() => {
    // No row rather than an error: the pull request is an addition to the tab.
    Promise.resolve()
      .then(() => kyrnGitBridge.pr.invoke({ cwd }))
      .then((answer) => setPr(unwrap(answer)))
      .catch(() => setPr(null));
  }, [cwd]);

  useEffect(() => {
    setPr(null);
  }, [cwd]);
  useEffect(() => {
    if (visible && branch) read();
  }, [visible, branch, refresh, read]);
  useEffect(() => {
    if (!visible || !branch) return undefined;
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, [visible, branch, read]);
  const running = pr?.state === 'pr' && pr.checks.some((check) => check.state === 'pending');
  useEffect(() => {
    if (!visible || !running) return undefined;
    const timer = setInterval(read, PR_CHECKS_POLL_MS);
    return () => clearInterval(timer);
  }, [visible, running, read]);

  if (!branch || !pr) return null;

  if (pr.state === 'none') {
    if (pr.defaultBranch === branch) return null;
    return (
      <div
        className='flex items-center gap-6px px-12px h-28px flex-shrink-0 text-12px text-t-tertiary'
        data-testid='native-source-pr'
        data-state='none'
      >
        <PullRequests size={14} className='flex-shrink-0' />
        <span className='min-w-0 flex-1 truncate'>{t('mu.native.panel.source.pr.none')}</span>
        <Button
          type='text'
          size='mini'
          data-testid='native-source-pr-ask'
          onClick={() => emitter.emit('sendbox.fill', t('mu.native.panel.source.pr.prompt'))}
        >
          {t('mu.native.panel.source.pr.ask')}
        </Button>
      </div>
    );
  }
  if (pr.state !== 'pr') return null;

  const passed = count(pr.checks, 'pass');
  const failed = count(pr.checks, 'fail');
  const pending = count(pr.checks, 'pending');
  const summary = t('mu.native.panel.source.pr.checks', { passed, failed, pending });
  const list = (
    <div className='w-300px max-w-[80vw] max-h-280px overflow-y-auto' data-testid='native-source-pr-check-list'>
      {pr.checks.map((check, index) => (
        <div
          key={`${check.name}-${index}`}
          className={`flex items-center gap-6px py-4px px-4px rd-4px text-12px ${check.url ? 'cursor-pointer hover:bg-fill-2' : ''}`}
          role={check.url ? 'link' : undefined}
          tabIndex={check.url ? 0 : undefined}
          title={check.url}
          data-testid='native-source-pr-check'
          data-state={check.state}
          onClick={check.url ? () => open(check.url as string) : undefined}
          onKeyDown={(event) => {
            if (check.url && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              open(check.url);
            }
          }}
        >
          {STATE_ICON[check.state]}
          <span className='min-w-0 flex-1 truncate text-t-primary'>{check.name}</span>
          <span className='shrink-0 text-t-tertiary'>{t(`mu.native.panel.source.pr.state.${check.state}`)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div
      className='flex items-center gap-6px px-12px h-28px flex-shrink-0 text-12px'
      data-testid='native-source-pr'
      data-state='pr'
      data-status={pr.status}
    >
      <PullRequests size={14} className='flex-shrink-0 text-t-tertiary' />
      <span
        className='min-w-0 flex-1 truncate cursor-pointer text-t-secondary hover:text-t-primary'
        role='link'
        tabIndex={0}
        title={`${pr.title}\n${pr.url}`}
        data-testid='native-source-pr-open'
        onClick={() => open(pr.url)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open(pr.url);
          }
        }}
      >
        <span className='font-500' dir='ltr'>{`#${pr.number}`}</span> {pr.title}
      </span>
      <span className='shrink-0 text-t-tertiary' data-testid='native-source-pr-status'>
        {t(`mu.native.panel.source.pr.status.${pr.status}`)}
      </span>
      {pr.checks.length > 0 ? (
        <Popover trigger='click' position='bl' content={list}>
          <Button
            type='text'
            size='mini'
            className='shrink-0'
            aria-label={summary}
            title={summary}
            data-testid='native-source-pr-checks'
            data-passed={passed}
            data-failed={failed}
            data-pending={pending}
          >
            <span className='inline-flex items-center gap-4px'>
              {failed > 0 ? STATE_ICON.fail : pending > 0 ? STATE_ICON.pending : STATE_ICON.pass}
              <span dir='ltr'>{`${passed}/${pr.checks.length}`}</span>
            </span>
          </Button>
        </Popover>
      ) : null}
    </div>
  );
}
