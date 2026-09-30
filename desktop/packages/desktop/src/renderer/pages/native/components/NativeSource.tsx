/**
 * The source tab beside a native conversation: the changes of the repository its folder is in, as the main process
 * reads them with git (common/kyrn/gitBridge.ts), in sections (a merge to resolve, staged, changes, untracked) drawn
 * with the classic source control's section and row. A click on a row opens the file's diff in the preview, as the
 * classic tab does. Read only: nothing is staged, discarded or committed here. When git cannot run, or the folder is
 * in no repository, the tab says so.
 */
import React, { useState } from 'react';
import { Button, Spin } from '@arco-design/web-react';
import { BranchTwo, Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { unwrap } from '@/common/kyrn/bridge';
import {
  kyrnGitBridge,
  type FolderGitStatus,
  type GitArea,
  type GitBranch,
  type GitChange,
} from '@/common/kyrn/gitBridge';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { ScmResourceRow } from '@/renderer/pages/conversation/SourceControl/ScmResourceRow';
import { ScmSection } from '@/renderer/pages/conversation/SourceControl/ScmSection';
import { useFolderGit } from '../hooks/useFolderGit';
import { changeKey, drifted, sectionsOf, toResource } from '../utils/gitRows';

/** What the tab shows (`data-state`). */
type SourceState = 'loading' | 'failed' | 'no-git' | 'not-repository' | 'clean' | 'changes';

const stateOf = (status: FolderGitStatus | undefined, error: string | undefined): SourceState => {
  if (error !== undefined) return 'failed';
  if (!status) return 'loading';
  if (status.state !== 'repository') return status.state;
  return status.changes.length > 0 ? 'changes' : 'clean';
};

/** The last name of a path, `/` or `\` between names. */
const folderName = (path: string): string =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) || path;

function Note({ text, detail }: { text: string; detail?: string }) {
  return (
    <p className='m-0 px-12px py-10px text-13px leading-20px text-t-secondary' data-testid='native-source-note'>
      {text}
      {detail ? (
        <span
          className='block mt-4px text-12px leading-18px text-t-tertiary break-words'
          dir='ltr'
          data-testid='native-source-reason'
        >
          {detail}
        </span>
      ) : null}
    </p>
  );
}

export default function NativeSource({ cwd, visible, refresh }: { cwd: string; visible: boolean; refresh: string }) {
  const { t } = useTranslation();
  const { status, error, reading, read } = useFolderGit(cwd, { visible, refresh });
  const { openPreview } = usePreviewContext();
  const [selected, setSelected] = useState<string>();
  const [diffFailed, setDiffFailed] = useState<{ path: string; reason: string }>();
  const [folded, setFolded] = useState<ReadonlySet<GitArea>>(() => new Set());
  const state = stateOf(status, error);
  const repository = status?.state === 'repository' ? status : undefined;

  const sectionTitle = (area: GitArea): string =>
    area === 'conflicted'
      ? t('conversation.explorer.scm.groups.blocked')
      : area === 'staged'
        ? t('conversation.explorer.scm.groups.staged')
        : area === 'unstaged'
          ? t('conversation.explorer.scm.groups.unstaged')
          : t('mu.native.panel.source.untracked');

  const showDiff = async (change: GitChange) => {
    setSelected(changeKey(change));
    setDiffFailed(undefined);
    try {
      const diff = unwrap(
        await kyrnGitBridge.diff.invoke({
          cwd,
          path: change.path,
          area: change.area,
          ...(change.from ? { from: change.from } : {}),
        })
      );
      // A diff the cap cut ends with a line that says so, where the reader's eye stops.
      const body = diff.binary
        ? t('conversation.explorer.scm.diff.binary')
        : !diff.patch
          ? t('conversation.explorer.scm.diff.empty')
          : diff.truncated
            ? `${diff.patch} ${t('conversation.explorer.scm.diff.truncated')}\n`
            : diff.patch;
      const name = change.path.split('/').at(-1) || change.path;
      openPreview(body, 'diff', { file_name: name, title: name });
    } catch (failure) {
      setDiffFailed({ path: change.path, reason: failure instanceof Error ? failure.message : String(failure) });
    }
  };

  const branchLine = (branch: GitBranch): string => {
    const head = branch.name ?? (branch.commit ? t('mu.native.panel.source.detached', { commit: branch.commit }) : '');
    return branch.commit ? head : `${head} · ${t('mu.native.panel.source.noCommits')}`;
  };

  const body = (): React.ReactNode => {
    if (state === 'loading')
      return (
        <div className='px-12px py-10px'>
          <Spin size={14} />
        </div>
      );
    if (state === 'failed') return <Note text={t('conversation.explorer.scm.loadFailed')} detail={error} />;
    if (status?.state === 'no-git') return <Note text={t('mu.native.panel.source.noGit')} detail={status.reason} />;
    if (state === 'not-repository') return <Note text={t('conversation.explorer.scm.notARepository')} />;
    if (!repository) return null;
    if (state === 'clean') return <Note text={t('conversation.explorer.scm.noChanges')} />;
    return (
      <>
        {sectionsOf(repository.changes).map(({ area, changes }) => (
          <div key={area} data-testid='native-source-group' data-group={area}>
            <ScmSection
              id={area}
              title={sectionTitle(area)}
              collapsed={folded.has(area)}
              badge={changes.length}
              onToggleCollapsed={() =>
                setFolded((old) => {
                  const next = new Set(old);
                  if (!next.delete(area)) next.add(area);
                  return next;
                })
              }
            >
              <div className='pb-4px'>
                {changes.map((change) => (
                  <div
                    key={changeKey(change)}
                    data-testid='native-source-file'
                    data-path={change.path}
                    data-group={change.area}
                    data-kind={change.kind}
                  >
                    <ScmResourceRow
                      resource={toResource(change)}
                      selected={selected === changeKey(change)}
                      onSelect={() => void showDiff(change)}
                      staging
                    />
                  </div>
                ))}
              </div>
            </ScmSection>
          </div>
        ))}
        {repository.more > 0 || repository.truncated ? (
          <p className='m-0 px-12px py-4px text-12px text-t-tertiary' data-testid='native-source-more'>
            {repository.truncated
              ? t('conversation.explorer.scm.truncated')
              : t('mu.native.panel.files.more', { count: repository.more })}
          </p>
        ) : null}
      </>
    );
  };

  return (
    <section
      className='h-full min-h-0 flex flex-col'
      data-testid='native-source'
      data-state={state}
      aria-label={t('mu.native.panel.source.label', { folder: folderName(cwd) })}
      aria-busy={reading}
    >
      <div
        className='flex items-center gap-6px px-12px h-32px flex-shrink-0'
        style={{ borderBottom: '1px solid var(--color-border-2)' }}
      >
        {repository ? <BranchTwo size={14} className='flex-shrink-0 text-t-tertiary' /> : null}
        <span
          className='min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-12px font-500 text-t-secondary'
          dir='ltr'
          title={repository ? repository.root : cwd}
          data-testid='native-source-branch'
        >
          {repository ? branchLine(repository.branch) : folderName(cwd)}
        </span>
        {repository && drifted(repository.branch) ? (
          <span
            className='flex-shrink-0 text-12px text-t-tertiary'
            dir='ltr'
            title={t('mu.native.panel.source.upstream', {
              upstream: repository.branch.upstream,
              ahead: repository.branch.ahead ?? 0,
              behind: repository.branch.behind ?? 0,
            })}
            data-testid='native-source-upstream'
          >
            {`↑${repository.branch.ahead ?? 0} ↓${repository.branch.behind ?? 0}`}
          </span>
        ) : null}
        <Button
          type='text'
          size='mini'
          icon={<Refresh size={14} />}
          loading={reading}
          aria-label={t('mu.native.panel.files.refresh')}
          title={t('mu.native.panel.files.refresh')}
          data-testid='native-source-refresh'
          onClick={read}
        />
      </div>
      <div className='flex-1 min-h-0 overflow-y-auto p-4px'>
        {body()}
        {diffFailed ? (
          <p
            className='m-0 px-12px py-4px text-12px text-danger'
            title={diffFailed.reason}
            data-testid='native-source-diff-failed'
          >
            {t('conversation.explorer.scm.diff.failed')}
            <span className='ms-6px' dir='ltr'>
              {diffFailed.path}
            </span>
          </p>
        ) : null}
      </div>
    </section>
  );
}
