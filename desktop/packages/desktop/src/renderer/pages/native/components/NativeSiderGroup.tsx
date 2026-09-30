/**
 * The sidebar's native conversations, while the native host is on: mu's own sessions (the CLI's included, the ones
 * AionCore's conversations run left out), newest first and kept as they change, and a way to start one
 * (NativeNewConversation). A row has the menu classic rows have where it applies: pin (a pinned row stays above the
 * others), mark as unread or read, rename, archive (the row leaves the list for an "Archived" fold under it, whose rows
 * offer to restore it; the session file is untouched), and delete (the session file goes to the bin, after a
 * confirmation); its tooltip says the folder, how many messages, and what it was forked from. Nothing at all while
 * the host is off.
 */
import { Button, Dropdown, Input, Menu, Message, Modal, Spin } from '@arco-design/web-react';
import { DeleteOne, EditOne, FolderClose, FolderOpen, Inbox, MoreOne, Pushpin, Right } from '@icon-park/react';
import classNames from 'classnames';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import type { NativeConversation, NativeFailure, NativeResult } from '@/common/kyrn/nativeBridge';
import { iconColors } from '@/renderer/styles/colors';
import { pruneNativeUnread, toggleNativeUnread, useNativeUnread } from '../hooks/useNativeAttention';
import { useNativeArchived } from '../hooks/useNativeArchived';
import { useNativeConversations, useNativeEnabled } from '../hooks/useNativeConversations';
import { useNativePins } from '../hooks/useNativePins';
import { errorKey } from '../utils/errorWords';
import { useNativeClient } from '../utils/nativeClient';
import { folderName, nativeConversationPath } from '../utils/paths';
import NativeNewConversation from './NativeNewConversation';

/** Rows shown before "show all". */
const SHOWN = 8;
/** Folders offered to start a conversation in: the ones the latest conversations worked in. */
const RECENT_FOLDERS = 5;

type Translate = ReturnType<typeof useTranslation>['t'];

/** A failure as one line: the sentence for its kind, then its own words. */
const failureLine = (t: Translate, failure: Pick<NativeFailure, 'kind' | 'message'>): string =>
  `${t(errorKey(failure.kind))} ${failure.message}`.trim();

/** The row's tooltip: its title, its folder, how many messages it holds, what it was forked from. */
function tooltipOf(t: Translate, conversation: NativeConversation, parent: NativeConversation | undefined): string {
  const fork = conversation.forkedFrom
    ? parent
      ? t('conversation.history.forkedFrom', { name: parent.title || t('mu.native.untitled') })
      : t('conversation.history.forkedConversation')
    : '';
  return [
    conversation.title || t('mu.native.untitled'),
    conversation.cwd,
    conversation.messageCount === undefined ? '' : t('mu.native.sider.messages', { count: conversation.messageCount }),
    fork,
  ]
    .filter(Boolean)
    .join('\n');
}

type RowProps = {
  conversation: NativeConversation;
  /** The conversation it was forked from, when the list has it. */
  parent?: NativeConversation;
  active: boolean;
  pinned: boolean;
  /** Archived by the person: shown in the fold under the list, with a menu that restores it. */
  archived: boolean;
  /** It wanted its person (a run ended, a question) while another conversation was on screen, and was not opened since. */
  unread: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  onMenu: (open: boolean) => void;
  onPin: () => void;
  onToggleUnread: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onRename: () => void;
  onDelete: () => void;
};

const Row: React.FC<RowProps> = ({
  conversation,
  parent,
  active,
  pinned,
  archived,
  unread,
  menuOpen,
  onOpen,
  onMenu,
  onPin,
  onToggleUnread,
  onArchive,
  onRestore,
  onRename,
  onDelete,
}) => {
  const { t } = useTranslation();
  const title = conversation.title || t('mu.native.untitled');
  // What the row's end says: a run in progress, else that it wanted its person, else that its host runs.
  const mark = conversation.running
    ? 'running'
    : unread && !archived
      ? 'unread'
      : conversation.live
        ? 'live'
        : undefined;
  return (
    <div
      role='button'
      tabIndex={0}
      aria-current={active ? 'page' : undefined}
      aria-label={title}
      title={tooltipOf(t, conversation, parent)}
      data-testid='native-sidebar-item'
      data-id={conversation.id}
      data-pinned={pinned ? 'true' : undefined}
      data-archived={archived ? 'true' : undefined}
      data-running={conversation.running ? 'true' : undefined}
      data-unread={unread ? 'true' : undefined}
      className={classNames(
        'group h-34px rd-8px flex items-center gap-8px ps-12px pe-6px cursor-pointer min-w-0 shrink-0 transition-colors',
        active ? '!bg-fill-3' : 'hover:bg-fill-3',
        archived && 'opacity-70'
      )}
      onClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(true);
      }}
      onKeyDown={(event) => {
        // Keys on the menu button, or in the menu, are theirs.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen();
      }}
    >
      {pinned ? (
        <Pushpin theme='filled' size='12' className='shrink-0 text-t-tertiary' data-testid='native-sidebar-pinned' />
      ) : null}
      <span className='min-w-0 flex-1 truncate text-14px font-[500] lh-24px text-t-primary'>{title}</span>
      <span className='shrink-0 max-w-40% truncate text-12px text-t-tertiary'>{folderName(conversation.cwd)}</span>
      {/* The row's end: a spinner while a run goes, else a dot in the brand's colour once it wanted its person, else the
          green dot of a running host; in its place the menu's button while the row is hovered or focused or its menu is
          open. A slot of its own, so the button covers no text; its clicks are not the row's. */}
      <span className='relative size-20px shrink-0 flex-center' onClick={(event) => event.stopPropagation()}>
        {mark ? (
          <span
            className={classNames('flex-center', menuOpen ? 'hidden' : 'group-hover:hidden group-focus-within:hidden')}
            data-testid={`native-sidebar-${mark}`}
          >
            {mark === 'running' ? (
              <Spin size={12} aria-label={t('mu.native.sider.working')} />
            ) : mark === 'unread' ? (
              // Inline: the theme's `--primary-6` is comma separated, and the utility class for `rgb(var(--primary-6))`
              // adds `/ opacity` to it, which is no colour at all (the dot was there, and could not be seen).
              <span
                className='size-8px rd-full'
                style={{ background: 'rgb(var(--primary-6))', boxShadow: '0 0 0 2px rgba(var(--primary-6), 0.18)' }}
                aria-label={t('mu.native.sider.unread')}
              />
            ) : (
              <span
                className='size-6px rd-full'
                style={{ background: iconColors.success }}
                aria-label={t('mu.native.phase.running')}
              />
            )}
          </span>
        ) : null}
        <span
          className={classNames(
            'absolute inset-0 items-center justify-center',
            menuOpen ? 'flex' : 'hidden group-hover:flex group-focus-within:flex'
          )}
        >
          <Dropdown
            trigger='click'
            position='br'
            popupVisible={menuOpen}
            onVisibleChange={onMenu}
            getPopupContainer={() => document.body}
            droplist={
              <Menu
                onClickMenuItem={(key) => {
                  onMenu(false);
                  if (key === 'pin') onPin();
                  if (key === 'unread') onToggleUnread();
                  if (key === 'rename') onRename();
                  if (key === 'archive') onArchive();
                  if (key === 'restore') onRestore();
                  if (key === 'delete') onDelete();
                }}
              >
                {/* A conversation that has no session file yet has no id to keep: its id changes when pi names it. */}
                {conversation.sessionFile && !archived ? (
                  <Menu.Item key='pin' data-testid='native-sidebar-pin'>
                    <div className='flex items-center gap-8px'>
                      <Pushpin theme='outline' size='14' />
                      <span>{pinned ? t('conversation.history.unpin') : t('conversation.history.pin')}</span>
                    </div>
                  </Menu.Item>
                ) : null}
                {conversation.sessionFile && !archived ? (
                  <Menu.Item key='unread' data-testid='native-sidebar-mark'>
                    <div className='flex items-center gap-8px'>
                      <Inbox theme='outline' size='14' />
                      <span>
                        {unread ? t('conversation.history.markAsRead') : t('conversation.history.markAsUnread')}
                      </span>
                    </div>
                  </Menu.Item>
                ) : null}
                <Menu.Item key='rename' data-testid='native-sidebar-rename'>
                  <div className='flex items-center gap-8px'>
                    <EditOne theme='outline' size='14' />
                    <span>{t('conversation.history.rename')}</span>
                  </div>
                </Menu.Item>
                {conversation.sessionFile ? (
                  archived ? (
                    <Menu.Item key='restore' data-testid='native-sidebar-restore'>
                      <div className='flex items-center gap-8px'>
                        <FolderOpen theme='outline' size='14' />
                        <span>{t('settings.archived.restore')}</span>
                      </div>
                    </Menu.Item>
                  ) : (
                    <Menu.Item key='archive' data-testid='native-sidebar-archive'>
                      <div className='flex items-center gap-8px'>
                        <FolderClose theme='outline' size='14' />
                        <span>{t('conversation.history.archive')}</span>
                      </div>
                    </Menu.Item>
                  )
                ) : null}
                <Menu.Item key='delete' data-testid='native-sidebar-delete'>
                  <div className='flex items-center gap-8px text-danger'>
                    <DeleteOne theme='outline' size='14' />
                    <span>{t('conversation.history.deleteTitle')}</span>
                  </div>
                </Menu.Item>
              </Menu>
            }
          >
            <button
              type='button'
              className='size-20px rd-4px flex-center p-0 border-none bg-fill-3 cursor-pointer text-t-secondary hover:text-t-primary'
              aria-label={t('conversation.history.conversationActions')}
              aria-haspopup='menu'
              aria-expanded={menuOpen}
              data-testid='native-sidebar-item-menu'
            >
              <MoreOne theme='outline' size='14' fill='currentColor' className='block leading-none' />
            </button>
          </Dropdown>
        </span>
      </span>
    </div>
  );
};

const Line: React.FC<{ children: React.ReactNode; testId?: string }> = ({ children, testId }) => (
  <div className='px-12px py-4px text-12px leading-18px text-t-tertiary [word-break:break-word]' data-testid={testId}>
    {children}
  </div>
);

const Failure: React.FC<{ failure: NativeFailure; testId: string }> = ({ failure, testId }) => {
  const { t } = useTranslation();
  return <Line testId={testId}>{failureLine(t, failure)}</Line>;
};

const Group: React.FC<{ onSessionClick?: () => void }> = ({ onSessionClick }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const client = useNativeClient();
  const { conversations, loading, failure } = useNativeConversations(true);
  const { pinned, toggle: togglePin, unpin } = useNativePins();
  const { archived, archive, restore } = useNativeArchived();
  const unread = useNativeUnread();
  const [folded, setFolded] = useState(false);
  const [all, setAll] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [deleting, setDeleting] = useState<NativeConversation>();
  const [busy, setBusy] = useState(false);
  const recent = useMemo(
    () => [...new Set(conversations.map((conversation) => conversation.cwd))].slice(0, RECENT_FOLDERS),
    [conversations]
  );
  // The archived ones are in a fold of their own under the list.
  const listed = useMemo(
    () => conversations.filter((conversation) => !archived.has(conversation.id)),
    [conversations, archived]
  );
  const shelved = useMemo(
    () => conversations.filter((conversation) => archived.has(conversation.id)),
    [conversations, archived]
  );
  // Pinned rows first, each block in the list's order (newest first); a pinned row is always shown.
  const ordered = useMemo(
    () => [
      ...listed.filter((conversation) => pinned.has(conversation.id)),
      ...listed.filter((conversation) => !pinned.has(conversation.id)),
    ],
    [listed, pinned]
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

  const open = (id: string) => {
    void navigate(nativeConversationPath(id));
    onSessionClick?.();
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

  const room = Math.max(SHOWN, ordered.filter((conversation) => pinned.has(conversation.id)).length);
  const shown = all ? ordered : ordered.slice(0, room);
  return (
    <div className='min-w-0' data-testid='native-sidebar-group'>
      <div
        className='group/label sider-section-label flex items-center px-12px h-28px select-none sticky top-0 z-10 mt-8px cursor-pointer'
        role='button'
        tabIndex={0}
        aria-expanded={!folded}
        onClick={() => setFolded((old) => !old)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setFolded((old) => !old);
        }}
      >
        <span className='text-14px text-t-tertiary sider-section-title group-hover/label:text-t-primary transition-colors font-[500] leading-none'>
          {t('mu.native.sider.title')}
        </span>
        <span className='ms-2px flex items-center justify-center opacity-0 group-hover/label:opacity-100 transition-opacity text-t-tertiary shrink-0'>
          <Right
            theme='outline'
            size={12}
            className={classNames('transition-transform duration-150', { 'rotate-90': !folded })}
          />
        </span>
        {/* The popover's clicks bubble here through React's tree: they must not fold the group. */}
        <div className='ms-auto' onClick={(event) => event.stopPropagation()}>
          <NativeNewConversation
            recent={recent}
            onCreated={(conversation) => {
              setFolded(false);
              open(conversation.id);
            }}
          />
        </div>
      </div>
      {folded ? null : (
        <>
          {loading ? (
            <div className='px-12px py-6px'>
              <Spin size={12} />
            </div>
          ) : null}
          {failure ? <Failure failure={failure} testId='native-sidebar-list-failed' /> : null}
          {!loading && !failure && !conversations.length ? (
            <Line testId='native-sidebar-empty'>{t('mu.native.sider.empty')}</Line>
          ) : null}
          {shown.map((conversation) => (
            <Row
              key={conversation.id}
              conversation={conversation}
              parent={conversation.forkedFrom ? bySessionFile.get(conversation.forkedFrom) : undefined}
              active={pathname === nativeConversationPath(conversation.id)}
              pinned={pinned.has(conversation.id)}
              archived={false}
              unread={unread.has(conversation.id)}
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
          ))}
          {ordered.length > room ? (
            <button
              type='button'
              className='mx-12px my-2px p-0 border-none bg-transparent cursor-pointer text-12px text-t-tertiary hover:text-t-primary'
              data-testid='native-sidebar-more'
              onClick={() => setAll((old) => !old)}
            >
              {all ? t('mu.native.sider.fewer') : t('mu.native.sider.all', { count: listed.length })}
            </button>
          ) : null}
          {shelved.length > 0 ? (
            <>
              <button
                type='button'
                className='mx-12px my-2px p-0 border-none bg-transparent cursor-pointer flex items-center gap-2px text-12px text-t-tertiary hover:text-t-primary'
                data-testid='native-sidebar-archived-toggle'
                aria-expanded={shelfOpen}
                onClick={() => setShelfOpen((old) => !old)}
              >
                <Right
                  theme='outline'
                  size={12}
                  className={classNames('transition-transform duration-150', { 'rotate-90': shelfOpen })}
                />
                {t('settings.archived.title')} ({shelved.length})
              </button>
              {shelfOpen
                ? shelved.map((conversation) => (
                    <Row
                      key={conversation.id}
                      conversation={conversation}
                      parent={conversation.forkedFrom ? bySessionFile.get(conversation.forkedFrom) : undefined}
                      active={pathname === nativeConversationPath(conversation.id)}
                      pinned={false}
                      archived
                      unread={false}
                      menuOpen={menuFor === conversation.id}
                      onOpen={() => open(conversation.id)}
                      onMenu={(visible) => setMenuFor(visible ? conversation.id : undefined)}
                      onPin={() => {}}
                      onToggleUnread={() => {}}
                      onArchive={() => {}}
                      onRestore={() => restoreRow(conversation.id)}
                      onRename={() => setRenaming({ id: conversation.id, name: conversation.title })}
                      onDelete={() => setDeleting(conversation)}
                    />
                  ))
                : null}
            </>
          ) : null}
        </>
      )}
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
