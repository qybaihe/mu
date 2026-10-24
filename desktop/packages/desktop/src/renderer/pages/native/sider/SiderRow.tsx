/**
 * One conversation in the sidebar's native group (NativeSiderGroup.tsx): its title, the folder it works in where the
 * place it is listed does not say it, and at its end a spinner while a run goes, a dot once it wanted its person, or
 * the green dot of a running host. Its menu pins it, marks it read or unread, renames, archives or restores, and
 * deletes it; its tooltip says the folder, how many messages, and what it was forked from.
 */
import { Dropdown, Menu, Spin } from '@arco-design/web-react';
import { DeleteOne, EditOne, FolderClose, FolderOpen, Inbox, MoreOne, Pushpin } from '@icon-park/react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeConversation } from '@/common/kyrn/nativeBridge';
import { iconColors } from '@/renderer/styles/colors';

type Translate = ReturnType<typeof useTranslation>['t'];

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

export type RowProps = {
  conversation: NativeConversation;
  /** The folder's name at the row's end, where the place it is listed does not say it. */
  folder?: string;
  /** Inside a project: lined up with the project's name. */
  indented?: boolean;
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

const SiderRow: React.FC<RowProps> = ({
  conversation,
  folder,
  indented = false,
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
        'group h-34px rd-8px flex items-center gap-8px pe-6px cursor-pointer min-w-0 shrink-0 transition-colors',
        indented ? 'ps-40px' : 'ps-12px',
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
      {/* The title comes first: it takes the room it needs, and the folder gives up its own before the title does,
          down to its first few letters (3em, or all of a shorter name), so a long folder name never leaves the title
          at two words. */}
      <span className='min-w-0 flex-auto truncate text-14px font-[500] lh-24px text-t-primary'>{title}</span>
      {folder ? (
        <span
          className='shrink-[100] min-w-[calc-size(max-content,min(size,3em))] max-w-40% truncate text-12px text-t-tertiary'
          data-testid='native-sidebar-folder'
        >
          {folder}
        </span>
      ) : null}
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

export default SiderRow;
