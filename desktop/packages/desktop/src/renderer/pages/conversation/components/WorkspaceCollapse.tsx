/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { FolderClose, FolderOpen } from '@icon-park/react';
import classNames from 'classnames';
import React from 'react';

interface WorkspaceCollapseProps {
  /** 是否展开 */
  expanded: boolean;
  /** 切换展开状态的回调 */
  onToggle: () => void;
  /** 折叠面板的标题 */
  header: React.ReactNode;
  /** 折叠面板的内容 */
  children: React.ReactNode;
  /** 额外的类名 */
  className?: string;
  /** 侧栏是否折叠 - 折叠时隐藏组标题并移除缩进 */
  siderCollapsed?: boolean;
  /** 标题尾部插槽 - 例如 hover 显示的菜单按钮，点击不会触发 onToggle */
  trailing?: React.ReactNode;
  /** 让头部在滚动时吸顶常驻 - 用于会话过长的项目组，下滑时逐个切换项目标题 */
  stickyHeader?: boolean;
  /** 吸顶时距滚动容器顶部的偏移(px)，用于让位给上方常驻的分区标题 */
  stickyTop?: number;
  /** The header's key among the rows the arrow keys move through (`useRovingRows`), and its place in the Tab order. */
  rowKey?: string;
  tabIndex?: number;
}

/**
 * 工作空间折叠组件 - 简单的折叠面板，用于工作空间分组
 */
const WorkspaceCollapse: React.FC<WorkspaceCollapseProps> = ({
  expanded,
  onToggle,
  header,
  children,
  className,
  siderCollapsed = false,
  trailing,
  stickyHeader = false,
  stickyTop,
  rowKey,
  tabIndex = 0,
}) => {
  // 侧栏折叠时，强制展开内容并隐藏头部
  const showContent = siderCollapsed || expanded;
  // 仅在展开状态吸顶：折叠的项目头部无需常驻，避免多个折叠头堆叠在顶部
  const stickyEnabled = stickyHeader && expanded && !siderCollapsed;

  return (
    <div className={classNames('workspace-collapse min-w-0', className)}>
      {/* 折叠头部 - 侧栏折叠时隐藏。吸顶时外层用不透明 bg-2 作遮罩，
          内层的半透明 hover 高亮叠在遮罩上而非透出下方滚动内容。 */}
      {!siderCollapsed && (
        <div
          className={classNames(stickyEnabled && 'sticky z-[9] bg-[var(--bg-2)]')}
          style={stickyEnabled ? { top: stickyTop ?? 0 } : undefined}
        >
          {/* A button for the keyboard too: Tab reaches the header, Enter or Space folds or unfolds the project. Keys
              pressed on the buttons at its end bubble up here and are theirs. */}
          <div
            className='flex items-center gap-8px h-34px ps-10px pe-8px cursor-pointer hover:bg-fill-3 rd-8px transition-colors min-w-0 group'
            role='button'
            tabIndex={tabIndex}
            data-roving-row={rowKey}
            aria-expanded={expanded}
            onClick={onToggle}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onToggle();
            }}
          >
            <span className='size-22px flex items-center justify-center shrink-0 text-t-primary'>
              {expanded ? (
                <FolderOpen theme='outline' size={16} fill='currentColor' className='line-height-0' />
              ) : (
                <FolderClose theme='outline' size={16} fill='currentColor' className='line-height-0' />
              )}
            </span>

            {/* 标题内容 — flex 容器让内部 header span 的 truncate 生效 */}
            <div className='flex-1 min-w-0 flex items-center overflow-hidden'>{header}</div>

            {/* The slot at the end: as wide as what it shows. Buttons that show on hover take their width from the title
                then, so the title ends in an ellipsis before them instead of under them. */}
            {trailing && (
              <div className='shrink-0 flex items-center justify-end' onClick={(e) => e.stopPropagation()}>
                {trailing}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 折叠内容 — row 保持全宽以便选中态 bg 填满整行；视觉缩进由 ConversationRow 的 dimIcon 分支自行处理 */}
      {showContent && <div className='workspace-collapse-content min-w-0'>{children}</div>}
    </div>
  );
};

export default WorkspaceCollapse;
