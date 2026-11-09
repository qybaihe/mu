/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import classNames from 'classnames';
import React, { useState } from 'react';
import { Down, PreviewOpen } from '@icon-park/react';
import { diffColors, iconColors } from '@/renderer/styles/colors';
import { useTranslation } from 'react-i18next';

/**
 * 文件变更项数据 / File change item data
 */
export interface FileChangeItem {
  /** 文件名 / File name */
  file_name: string;
  /** 完整路径 / Full path */
  fullPath: string;
  /** 新增行数 / Number of insertions */
  insertions: number;
  /** 删除行数 / Number of deletions */
  deletions: number;
}

/**
 * 文件变更面板属性 / File changes panel props
 */
export interface FileChangesPanelProps {
  /** 面板标题 / Panel title */
  title: string;
  /** 文件变更列表 / File changes list */
  files: FileChangeItem[];
  /** 默认是否展开 / Default expanded state */
  defaultExpanded?: boolean;
  /** 点击预览按钮的回调 / Callback when preview button is clicked */
  onFileClick?: (file: FileChangeItem) => void;
  /** 点击变更统计的回调（+8/-3 数字触发，打开 diff 对比）/ Callback when change stats are clicked (opens diff view) */
  onDiffClick?: (file: FileChangeItem) => void;
  /** 额外的类名 / Additional class name */
  className?: string;
}

/**
 * 文件变更面板组件
 * File changes panel component
 *
 * 用于显示会话中生成/修改的文件列表，支持展开收起
 * Used to display generated/modified files in conversation, supports expand/collapse
 */
const FileChangesPanel: React.FC<FileChangesPanelProps> = ({
  title,
  files,
  defaultExpanded = true,
  onFileClick,
  onDiffClick,
  className,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (files.length === 0) {
    return null;
  }

  if (files.length === 1) {
    const [file] = files;

    return (
      <div
        className={classNames(
          'w-full box-border rounded-8px overflow-hidden border border-solid border-[var(--color-border-2)]',
          className
        )}
        style={{ width: '100%' }}
      >
        <div className='group flex items-center justify-between px-12px py-7px hover:bg-fill-2 transition-colors'>
          <div className='flex items-center min-w-0 gap-8px'>
            <span className='w-6px h-6px rounded-full shrink-0' style={{ backgroundColor: diffColors.addition }} />
            <span className='text-12.5px text-t-primary font-mono font-medium truncate'>{file.file_name}</span>
          </div>
          <div className='flex items-center gap-6px shrink-0'>
            {(file.insertions > 0 || file.deletions > 0) && (
              <span
                className={classNames(
                  'flex items-center gap-4px rd-4px px-4px py-1px font-mono',
                  onDiffClick && 'cursor-pointer hover:bg-fill-3 transition-colors'
                )}
                onClick={() => onDiffClick?.(file)}
              >
                {file.insertions > 0 && (
                  <span className='text-12px font-medium' style={{ color: diffColors.addition }}>
                    +{file.insertions}
                  </span>
                )}
                {file.deletions > 0 && (
                  <span className='text-12px font-medium' style={{ color: diffColors.deletion }}>
                    -{file.deletions}
                  </span>
                )}
              </span>
            )}
            <span
              className='opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center gap-4px text-12px text-t-secondary hover:text-t-primary cursor-pointer rd-4px px-4px py-1px hover:bg-fill-3'
              onClick={() => onFileClick?.(file)}
            >
              <PreviewOpen className='line-height-8px' theme='outline' size='13' fill={iconColors.secondary} />
              {t('preview.preview')}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={classNames(
        'w-full box-border rounded-8px overflow-hidden border border-solid border-[var(--color-border-2)]',
        className
      )}
      style={{ width: '100%' }}
    >
      {/* 标题栏 / Header */}
      <div
        className='flex items-center justify-between px-12px py-8px cursor-pointer select-none hover:bg-fill-2 transition-colors'
        onClick={() => setExpanded(!expanded)}
      >
        <div className='flex items-center gap-8px'>
          {/* 绿色圆点 / Green dot */}
          <span className='w-6px h-6px rounded-full shrink-0' style={{ backgroundColor: diffColors.addition }}></span>
          {/* 标题 / Title */}
          <span className='text-13px text-t-primary font-medium'>{title}</span>
        </div>
        {/* 展开/收起箭头 / Expand/collapse arrow */}
        <Down
          theme='outline'
          size='14'
          fill={iconColors.secondary}
          className={classNames('transition-transform duration-200', expanded && 'rotate-180')}
        />
      </div>

      {/* 文件列表 / File list */}
      {expanded && (
        <div className='w-full bg-2'>
          {files.map((file, index) => (
            <div
              key={`${file.fullPath}-${index}`}
              className={classNames(
                'group flex items-center justify-between px-12px py-6px border-t border-solid border-[var(--color-border-1)] hover:bg-fill-2 transition-colors'
              )}
            >
              {/* 文件名 / File name */}
              <div className='flex items-center min-w-0'>
                <span className='text-12.5px text-t-primary font-mono truncate'>{file.file_name}</span>
              </div>
              {/* 变更统计 + 预览按钮 / Change statistics + Preview button */}
              <div className='flex items-center gap-6px shrink-0'>
                {/* 变更统计 - 点击打开 diff 对比 / Change stats - click to open diff view */}
                {(file.insertions > 0 || file.deletions > 0) && (
                  <span
                    className={classNames(
                      'flex items-center gap-4px rd-4px px-4px py-1px font-mono',
                      onDiffClick && 'cursor-pointer hover:bg-fill-3 transition-colors'
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDiffClick?.(file);
                    }}
                  >
                    {file.insertions > 0 && (
                      <span className='text-12px font-medium' style={{ color: diffColors.addition }}>
                        +{file.insertions}
                      </span>
                    )}
                    {file.deletions > 0 && (
                      <span className='text-12px font-medium' style={{ color: diffColors.deletion }}>
                        -{file.deletions}
                      </span>
                    )}
                  </span>
                )}
                {/* 预览按钮 - 点击打开文件预览 / Preview button - click to open file preview */}
                <span
                  className='opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0 ms-4px flex items-center gap-4px text-12px text-t-secondary hover:text-t-primary cursor-pointer rd-4px px-4px py-1px hover:bg-fill-3'
                  onClick={(e) => {
                    e.stopPropagation();
                    onFileClick?.(file);
                  }}
                >
                  <PreviewOpen className='line-height-8px' theme='outline' size='13' fill={iconColors.secondary} />
                  {t('preview.preview')}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default FileChangesPanel;
