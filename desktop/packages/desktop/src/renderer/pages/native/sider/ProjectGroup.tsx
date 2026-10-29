/**
 * One project in the sidebar's native group (NativeSiderGroup.tsx): its folder's name, which folds it, and at its end,
 * under the pointer, with the keyboard's focus in the row, or while its menu is open, a new conversation in it and its
 * menu (archive it with its conversations, or remove an empty one). Under it its conversations, newest first: the first
 * few, all of them when asked, and the one open always.
 */
import { Dropdown, Menu, Tooltip } from '@arco-design/web-react';
import { DeleteOne, FolderClose, MoreOne, Plus } from '@icon-park/react';
import classNames from 'classnames';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeConversation } from '@/common/kyrn/nativeBridge';
import WorkspaceCollapse from '@/renderer/pages/conversation/components/WorkspaceCollapse';
import { folderName } from '../utils/paths';
import type { Project } from './projects';

/** Rows a project shows before "show all". */
export const SHOWN = 5;

/** The conversations a project shows: the first few, all of them when asked, and the one open always. */
export const shownRows = (
  conversations: readonly NativeConversation[],
  all: boolean,
  activeId?: string
): readonly NativeConversation[] =>
  all ? conversations : conversations.filter((conversation, index) => index < SHOWN || conversation.id === activeId);

/** A key on a span that acts as a button: Enter or Space acts, and the row under it does not fold. */
const pressed = (action: () => void) => (event: React.KeyboardEvent) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  action();
};

const ACTION =
  'flex-center cursor-pointer transition-colors text-t-secondary hover:text-t-primary size-20px rd-4px sider-action-btn';
/**
 * When the buttons show: under the pointer, or with the keyboard's focus on the row or on one of them. Not for a focus a
 * click left behind (`:focus-visible` is the keyboard's), so they go with the pointer after a click.
 */
const SHOWN_ON = 'hidden group-hover:flex group-focus-visible:flex group-has-[:focus-visible]:flex';

type Props = {
  project: Project;
  folded: boolean;
  onToggle: () => void;
  /** The conversation on screen, if it is one of this project's: shown even past the first few. */
  activeId?: string;
  /** All its conversations are shown, not only the first few (the group keeps it: it publishes the rows' order). */
  all: boolean;
  onToggleAll: () => void;
  renderRow: (conversation: NativeConversation) => React.ReactNode;
  /** A new conversation in the project's folder. */
  onNew: () => void;
  /** Archives the project and its conversations, or removes it when it has none. */
  onArchive: () => void;
};

const ProjectGroup: React.FC<Props> = ({
  project,
  folded,
  onToggle,
  activeId,
  all,
  onToggleAll,
  renderRow,
  onNew,
  onArchive,
}) => {
  const { t } = useTranslation();
  // Its menu is open: both buttons stay where they are while the pointer is in the menu.
  const [menuOpen, setMenuOpen] = useState(false);
  const shownOn = menuOpen ? 'flex' : SHOWN_ON;
  const { conversations } = project;
  const empty = conversations.length === 0;
  const shown = shownRows(conversations, all, activeId);
  return (
    <div className='min-w-0' data-testid='native-project-group' data-folder={project.folder}>
      <WorkspaceCollapse
        expanded={!folded}
        onToggle={onToggle}
        stickyHeader
        stickyTop={28}
        header={
          <span className='text-14px font-[500] truncate flex-1 text-t-primary min-w-0' title={project.folder}>
            {folderName(project.folder)}
          </span>
        }
        trailing={
          <span className='flex items-center gap-6px'>
            <Tooltip content={t('conversation.history.newConversationInProject')} position='top'>
              <span
                role='button'
                tabIndex={0}
                aria-label={t('conversation.history.newConversationInProject')}
                data-testid='native-project-new'
                className={classNames(ACTION, shownOn)}
                onClick={onNew}
                onKeyDown={pressed(onNew)}
              >
                <Plus theme='outline' size='14' fill='currentColor' className='block leading-none' />
              </span>
            </Tooltip>
            <Dropdown
              trigger='click'
              position='br'
              getPopupContainer={() => document.body}
              onVisibleChange={setMenuOpen}
              droplist={
                <Menu onClickMenuItem={onArchive}>
                  <Menu.Item key='archive' data-testid='native-project-archive'>
                    <span className='flex items-center gap-8px'>
                      {empty ? <DeleteOne theme='outline' size='14' /> : <FolderClose theme='outline' size='14' />}
                      {empty ? t('mu.native.sider.removeProject') : t('conversation.history.archiveProject')}
                    </span>
                  </Menu.Item>
                </Menu>
              }
            >
              <span
                role='button'
                tabIndex={0}
                aria-label={t('conversation.history.projectActions')}
                aria-haspopup='menu'
                aria-expanded={menuOpen}
                data-testid='native-project-menu'
                className={classNames(ACTION, shownOn)}
              >
                <MoreOne theme='outline' size='14' fill='currentColor' className='block leading-none' />
              </span>
            </Dropdown>
          </span>
        }
      >
        <div className='flex flex-col min-w-0 mt-1px'>
          {shown.map(renderRow)}
          {conversations.length > SHOWN ? (
            <span
              role='button'
              tabIndex={0}
              className='ms-40px me-12px my-2px self-start cursor-pointer text-12px text-t-tertiary hover:text-t-primary'
              data-testid='native-sidebar-more'
              onClick={onToggleAll}
              onKeyDown={pressed(onToggleAll)}
            >
              {all ? t('mu.native.sider.fewer') : t('mu.native.sider.all', { count: conversations.length })}
            </span>
          ) : null}
        </div>
      </WorkspaceCollapse>
    </div>
  );
};

export default ProjectGroup;
