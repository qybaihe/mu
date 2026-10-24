/**
 * One project in the sidebar's native group (NativeSiderGroup.tsx): its folder's name, which folds it, and at its end,
 * on hover or focus, a new conversation in it and its menu (archive it with its conversations, or remove an empty
 * one). Under it its conversations, newest first: the first few, all of them when asked, and the one open always.
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

/** A key on a span that acts as a button: Enter or Space acts, and the row under it does not fold. */
const pressed = (action: () => void) => (event: React.KeyboardEvent) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  action();
};

const ACTION =
  'flex-center cursor-pointer transition-colors text-t-secondary hover:text-t-primary size-20px rd-4px sider-action-btn';

type Props = {
  project: Project;
  folded: boolean;
  onToggle: () => void;
  /** The conversation on screen, if it is one of this project's: shown even past the first few. */
  activeId?: string;
  renderRow: (conversation: NativeConversation) => React.ReactNode;
  /** A new conversation in the project's folder. */
  onNew: () => void;
  /** Archives the project and its conversations, or removes it when it has none. */
  onArchive: () => void;
};

const ProjectGroup: React.FC<Props> = ({ project, folded, onToggle, activeId, renderRow, onNew, onArchive }) => {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const { conversations } = project;
  const empty = conversations.length === 0;
  const shown = all
    ? conversations
    : conversations.filter((conversation, index) => index < SHOWN || conversation.id === activeId);
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
                className={classNames(ACTION, 'hidden group-hover:flex group-focus-within:flex')}
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
                data-testid='native-project-menu'
                className={classNames(ACTION, 'hidden group-hover:flex group-focus-within:flex')}
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
              onClick={() => setAll((old) => !old)}
              onKeyDown={pressed(() => setAll((old) => !old))}
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
