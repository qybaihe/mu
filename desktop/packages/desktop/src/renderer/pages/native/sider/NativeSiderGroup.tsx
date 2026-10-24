/**
 * The sidebar's native conversations, while the native host is on: mu's own sessions (the CLI's included, the ones the
 * backend's conversations run left out), kept as they change. The pinned ones first; then the projects (projects.ts),
 * each the conversations in its folder, the one changed last first, with a way to start one in a folder
 * (NativeNewConversation) and one to add a project by picking a folder; then an "Archived" fold, whose rows offer to
 * restore them. A row's menu (SiderRow.tsx) pins, marks as read or unread,
 * renames, archives (the session file is untouched) and deletes (the session file goes to the bin, after a
 * confirmation). Nothing at all while the host is off.
 */
import { Button, Input, Message, Modal, Spin } from '@arco-design/web-react';
import { FolderPlus, Right } from '@icon-park/react';
import classNames from 'classnames';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import type { NativeConversation, NativeFailure, NativeResult } from '@/common/kyrn/nativeBridge';
import NativeNewConversation from '../components/NativeNewConversation';
import { pruneNativeUnread, toggleNativeUnread, useNativeUnread } from '../hooks/useNativeAttention';
import { useNativeArchived } from '../hooks/useNativeArchived';
import { useNativeConversations, useNativeEnabled } from '../hooks/useNativeConversations';
import { useNativePins } from '../hooks/useNativePins';
import { errorKey } from '../utils/errorWords';
import { useNativeClient } from '../utils/nativeClient';
import { folderName, nativeConversationPath } from '../utils/paths';
import ProjectGroup from './ProjectGroup';
import { folderKey, groupProjects, type Project } from './projects';
import SiderRow from './SiderRow';
import { addProject, forgetProject, useAddedProjects, useFoldedProjects, useRepoRoots } from './useProjects';

type Translate = ReturnType<typeof useTranslation>['t'];

/** A failure as one line: the sentence for its kind, then its own words. */
const failureLine = (t: Translate, failure: Pick<NativeFailure, 'kind' | 'message'>): string =>
  `${t(errorKey(failure.kind))} ${failure.message}`.trim();

const Line: React.FC<{ children: React.ReactNode; testId?: string }> = ({ children, testId }) => (
  <div className='px-12px py-4px text-12px leading-18px text-t-tertiary [word-break:break-word]' data-testid={testId}>
    {children}
  </div>
);

/** Folders offered to start a conversation in: the ones the latest conversations worked in. */
const RECENT_FOLDERS = 5;

/** A section's label, which folds the section; `end` sits at its end, and its clicks do not fold it. */
const Label: React.FC<{
  title: string;
  folded: boolean;
  onToggle: () => void;
  testId: string;
  end?: React.ReactNode;
}> = ({ title, folded, onToggle, testId, end }) => (
  <div
    className='group/label sider-section-label flex items-center px-12px h-28px select-none sticky top-0 z-10 mt-8px cursor-pointer'
    role='button'
    tabIndex={0}
    aria-expanded={!folded}
    data-testid={testId}
    onClick={onToggle}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onToggle();
    }}
  >
    <span className='text-14px text-t-tertiary sider-section-title group-hover/label:text-t-primary transition-colors font-[500] leading-none'>
      {title}
    </span>
    <span className='ms-2px flex items-center justify-center opacity-0 group-hover/label:opacity-100 transition-opacity text-t-tertiary shrink-0'>
      <Right
        theme='outline'
        size={12}
        className={classNames('transition-transform duration-150', { 'rotate-90': !folded })}
      />
    </span>
    {end ? (
      <div className='ms-auto' onClick={(event) => event.stopPropagation()}>
        {end}
      </div>
    ) : null}
  </div>
);

const Group: React.FC<{ onSessionClick?: () => void }> = ({ onSessionClick }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const client = useNativeClient();
  const { conversations, loading, failure } = useNativeConversations(true);
  const { pinned, toggle: togglePin, unpin } = useNativePins();
  const { archived, archive, restore } = useNativeArchived();
  const unread = useNativeUnread();
  const added = useAddedProjects();
  const { folded: foldedProjects, toggle: toggleProject } = useFoldedProjects();
  const [pinsFolded, setPinsFolded] = useState(false);
  const [projectsFolded, setProjectsFolded] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [deleting, setDeleting] = useState<NativeConversation>();
  const [archiving, setArchiving] = useState<Project>();
  const [busy, setBusy] = useState(false);
  const folders = useMemo(() => [...new Set(conversations.map((conversation) => conversation.cwd))], [conversations]);
  const recent = useMemo(() => folders.slice(0, RECENT_FOLDERS), [folders]);
  const { roots, ready } = useRepoRoots(folders);
  // The archived ones are in a fold of their own under the list, the pinned ones above the projects.
  const listed = useMemo(
    () => conversations.filter((conversation) => !archived.has(conversation.id)),
    [conversations, archived]
  );
  const shelved = useMemo(
    () => conversations.filter((conversation) => archived.has(conversation.id)),
    [conversations, archived]
  );
  const pinnedRows = useMemo(() => listed.filter((conversation) => pinned.has(conversation.id)), [listed, pinned]);
  const projects = useMemo(
    () =>
      groupProjects(
        listed.filter((conversation) => !pinned.has(conversation.id)),
        added,
        roots
      ),
    [listed, pinned, added, roots]
  );
  // A conversation that is gone (deleted, here or by another mu) keeps no mark.
  useEffect(() => {
    if (loading || failure) return;
    pruneNativeUnread(new Set(conversations.map((conversation) => conversation.id)));
  }, [conversations, failure, loading]);
  const bySessionFile = useMemo(
    () =>
      new Map(
        conversations.flatMap((conversation) =>
          conversation.sessionFile ? [[conversation.sessionFile, conversation] as const] : []
        )
      ),
    [conversations]
  );
  const activeId = conversations.find((conversation) => pathname === nativeConversationPath(conversation.id))?.id;

  const open = (id: string) => {
    void navigate(nativeConversationPath(id));
    onSessionClick?.();
  };

  /** The home page, with the project's folder chosen: the next message starts a conversation there. */
  const startIn = (folder: string) => {
    void navigate('/guid', { state: { workspace: folder } });
    onSessionClick?.();
  };

  const addFolder = async () => {
    const folder = await client.pickFolder().catch((): undefined => undefined);
    if (!folder) return;
    addProject(folder);
    setProjectsFolded(false);
    if (foldedProjects.has(folderKey(folder))) toggleProject(folder);
    startIn(folder);
  };

  // Archiving unpins, as it does for a classic conversation; the page stays where it is.
  const archiveRow = (id: string) => {
    archive(id);
    unpin(id);
    Message.success(t('conversation.history.archiveSuccess'));
  };
  const restoreRow = (id: string) => {
    restore(id);
    Message.success(t('settings.archived.restoreSuccess'));
  };

  /**
   * Archives a project's conversations, those with a session file (a draft's id changes when pi names it, so it could
   * not be restored), and forgets its folder if it was added. An empty project is only forgotten.
   */
  const archiveProject = (project: Project) => {
    for (const conversation of project.conversations) {
      if (conversation.sessionFile) archive(conversation.id);
    }
    forgetProject(project.folder);
    if (project.conversations.length > 0) Message.success(t('conversation.history.archiveSuccess'));
  };

  /** Runs a call of the row menu's: says why it failed, if it did. */
  const act = async (call: () => Promise<NativeResult<unknown>>): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await call();
      if (result.ok === false) {
        Message.error(failureLine(t, result));
        return false;
      }
      return true;
    } catch (error) {
      Message.error(
        failureLine(t, { kind: 'failed', message: error instanceof Error ? error.message : String(error) })
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    const name = renaming?.name.trim();
    if (!renaming || !name || busy) return;
    if (!(await act(() => client.rename(renaming.id, name)))) return;
    setRenaming(undefined);
    Message.success(t('conversation.history.renameSuccess'));
  };

  const remove = async () => {
    const target = deleting;
    if (!target || busy) return;
    if (!(await act(() => client.remove(target.id)))) return;
    setDeleting(undefined);
    Message.success(t('common.deleteSuccess'));
    // Its page would say it no longer exists: the home page instead.
    if (pathname === nativeConversationPath(target.id)) void navigate('/guid');
  };

  const row = (
    conversation: NativeConversation,
    { folder, indented = false, shelf = false }: { folder?: string; indented?: boolean; shelf?: boolean } = {}
  ) => (
    <SiderRow
      key={conversation.id}
      conversation={conversation}
      folder={folder}
      indented={indented}
      parent={conversation.forkedFrom ? bySessionFile.get(conversation.forkedFrom) : undefined}
      active={conversation.id === activeId}
      pinned={!shelf && pinned.has(conversation.id)}
      archived={shelf}
      unread={!shelf && unread.has(conversation.id)}
      menuOpen={menuFor === conversation.id}
      onOpen={() => open(conversation.id)}
      onMenu={(visible) => setMenuFor(visible ? conversation.id : undefined)}
      onPin={() => togglePin(conversation.id)}
      onToggleUnread={() => toggleNativeUnread(conversation.id)}
      onArchive={() => archiveRow(conversation.id)}
      onRestore={() => restoreRow(conversation.id)}
      onRename={() => setRenaming({ id: conversation.id, name: conversation.title })}
      onDelete={() => setDeleting(conversation)}
    />
  );

  const addLabel = t('mu.native.sider.addProject');
  return (
    <div className='min-w-0' data-testid='native-sidebar-group'>
      {pinnedRows.length > 0 ? (
        <>
          <Label
            title={t('conversation.history.pinnedSection')}
            folded={pinsFolded}
            onToggle={() => setPinsFolded((old) => !old)}
            testId='native-sidebar-pinned-label'
          />
          {pinsFolded
            ? null
            : pinnedRows.map((conversation) => row(conversation, { folder: folderName(conversation.cwd) }))}
        </>
      ) : null}
      <Label
        title={t('conversation.history.projectsSection')}
        folded={projectsFolded}
        onToggle={() => setProjectsFolded((old) => !old)}
        testId='native-sidebar-projects-label'
        end={
          <NativeNewConversation
            recent={recent}
            onCreated={(conversation) => {
              setProjectsFolded(false);
              open(conversation.id);
            }}
          />
        }
      />
      {projectsFolded ? null : (
        <>
          {loading || !ready ? (
            <div className='px-12px py-6px'>
              <Spin size={12} />
            </div>
          ) : null}
          {failure ? <Line testId='native-sidebar-list-failed'>{failureLine(t, failure)}</Line> : null}
          {!loading && !failure && !conversations.length && !projects.length ? (
            <Line testId='native-sidebar-empty'>{t('mu.native.sider.empty')}</Line>
          ) : null}
          {loading || !ready
            ? null
            : projects.map((project) => (
                <ProjectGroup
                  key={folderKey(project.folder)}
                  project={project}
                  folded={foldedProjects.has(folderKey(project.folder))}
                  onToggle={() => toggleProject(project.folder)}
                  activeId={activeId}
                  renderRow={(conversation) =>
                    row(conversation, {
                      indented: true,
                      // The folder at the row's end only when it is not the project's own.
                      folder:
                        folderKey(conversation.cwd) === folderKey(project.folder)
                          ? undefined
                          : folderName(conversation.cwd),
                    })
                  }
                  onNew={() => startIn(project.folder)}
                  onArchive={() => (project.conversations.length > 0 ? setArchiving(project) : archiveProject(project))}
                />
              ))}
          <div
            role='button'
            tabIndex={0}
            data-testid='native-add-project-row'
            className='h-34px rd-8px flex items-center gap-8px ps-10px pe-8px cursor-pointer transition-colors text-t-secondary hover:text-t-primary hover:bg-fill-3 min-w-0'
            onClick={() => void addFolder()}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              void addFolder();
            }}
          >
            <span className='size-22px flex items-center justify-center shrink-0'>
              <FolderPlus theme='outline' size={16} fill='currentColor' className='line-height-0' />
            </span>
            <span className='text-14px truncate'>{addLabel}</span>
          </div>
          {shelved.length > 0 ? (
            <>
              <span
                role='button'
                tabIndex={0}
                className='mx-12px my-2px flex items-center gap-2px cursor-pointer text-12px text-t-tertiary hover:text-t-primary'
                data-testid='native-sidebar-archived-toggle'
                aria-expanded={shelfOpen}
                onClick={() => setShelfOpen((old) => !old)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  setShelfOpen((old) => !old);
                }}
              >
                <Right
                  theme='outline'
                  size={12}
                  className={classNames('transition-transform duration-150', { 'rotate-90': shelfOpen })}
                />
                {t('settings.archived.title')} ({shelved.length})
              </span>
              {shelfOpen
                ? shelved.map((conversation) =>
                    row(conversation, { folder: folderName(conversation.cwd), shelf: true })
                  )
                : null}
            </>
          ) : null}
        </>
      )}
      <Modal
        title={t('conversation.history.archiveProjectTitle')}
        visible={archiving !== undefined}
        onCancel={() => setArchiving(undefined)}
        style={{ borderRadius: '12px' }}
        alignCenter
        getPopupContainer={() => document.body}
        footer={
          <>
            <Button onClick={() => setArchiving(undefined)}>{t('common.cancel')}</Button>
            <Button
              type='primary'
              onClick={() => {
                if (archiving) archiveProject(archiving);
                setArchiving(undefined);
              }}
              data-testid='native-project-archive-confirm'
            >
              {t('conversation.history.archive')}
            </Button>
          </>
        }
      >
        <div
          className='text-14px leading-22px text-t-primary [word-break:break-word]'
          data-testid='native-project-archiving'
        >
          {archiving ? t('mu.native.sider.archiveProjectConfirm', { name: folderName(archiving.folder) }) : null}
        </div>
      </Modal>
      <Modal
        title={t('conversation.history.renameTitle')}
        visible={renaming !== undefined}
        onCancel={() => setRenaming(undefined)}
        style={{ borderRadius: '12px' }}
        alignCenter
        getPopupContainer={() => document.body}
        footer={
          <>
            <Button onClick={() => setRenaming(undefined)}>{t('conversation.history.cancelEdit')}</Button>
            <Button
              type='primary'
              loading={busy}
              disabled={!renaming?.name.trim()}
              onClick={() => void saveName()}
              data-testid='native-rename-save'
            >
              {t('conversation.history.saveName')}
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={renaming?.name ?? ''}
          onChange={(name) => setRenaming((old) => (old ? { ...old, name } : old))}
          onPressEnter={() => void saveName()}
          placeholder={t('conversation.history.renamePlaceholder')}
          allowClear
          data-testid='native-rename-input'
        />
      </Modal>
      <Modal
        title={t('conversation.history.deleteTitle')}
        visible={deleting !== undefined}
        onCancel={() => setDeleting(undefined)}
        style={{ borderRadius: '12px' }}
        alignCenter
        getPopupContainer={() => document.body}
        footer={
          <>
            <Button onClick={() => setDeleting(undefined)}>{t('common.cancel')}</Button>
            <Button
              type='primary'
              status='danger'
              loading={busy}
              onClick={() => void remove()}
              data-testid='native-delete-confirm'
            >
              {t('conversation.history.confirmDelete')}
            </Button>
          </>
        }
      >
        <div className='text-14px leading-22px text-t-primary [word-break:break-word]' data-testid='native-delete'>
          {deleting ? t('mu.native.sider.deleteConfirm', { title: deleting.title || t('mu.native.untitled') }) : null}
        </div>
      </Modal>
    </div>
  );
};

/** The group, or nothing while the native host is off (or the main process has not said). */
const NativeSiderGroup: React.FC<{ onSessionClick?: () => void }> = ({ onSessionClick }) =>
  useNativeEnabled() ? <Group onSessionClick={onSessionClick} /> : null;

export default NativeSiderGroup;
