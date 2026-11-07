/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { iconColors } from '@/renderer/styles/colors';
import { Button, Form, Tooltip } from '@arco-design/web-react';
import { FolderOpen } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * One folder of the system page, as a settings row: its name on the left, and on the right the path in a field that
 * opens the folder picker when clicked, with the picker's button at its end. The name sits inside the form item, so
 * the row is one item of the form's list.
 */
const DirInputItem: React.FC<{
  label: string;
  field: string;
}> = ({ label, field }) => {
  const { t } = useTranslation();
  return (
    <Form.Item field={field} className='!mb-0'>
      {(_value, form) => {
        const current_value = form.getFieldValue(field) || '';
        const actionTooltip = field === 'workDir' ? t('settings.changeWorkDir') : t('settings.changeLogDir');

        const handlePick = () => {
          ipcBridge.dialog.showOpen
            .invoke({
              defaultPath: current_value,
              properties: ['openDirectory', 'createDirectory'],
            })
            .then((data) => {
              if (data?.[0]) {
                form.setFieldValue(field, data[0]);
              }
            })
            .catch((error) => {
              console.error('Failed to open directory dialog:', error);
            });
        };

        const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          handlePick();
        };

        return (
          <div className='flex flex-col gap-8px py-12px md:flex-row md:items-center md:justify-between md:gap-24px'>
            <div className='min-w-0 text-14px font-500 leading-22px text-t-primary'>{label}</div>
            <div
              className='mu-dir-input box-border h-32px w-full md:w-360px md:shrink-0 flex items-center overflow-hidden rounded-6px border border-solid border-[var(--border-base)] hover:border-[var(--bg-4)] ps-12px bg-base cursor-pointer transition-colors'
              tabIndex={0}
              onClick={handlePick}
              onKeyDown={handleKeyDown}
            >
              <Tooltip content={current_value || t('settings.dirNotConfigured')} position='top'>
                {/* Paths are code-like; without dir=ltr the leading slash flips to the end under RTL. */}
                <div dir='ltr' className='flex-1 min-w-0 text-13px text-t-primary truncate rtl-text-right'>
                  {current_value || t('settings.dirNotConfigured')}
                </div>
              </Tooltip>
              <Tooltip content={actionTooltip} position='top'>
                <Button
                  type='text'
                  aria-label={actionTooltip}
                  className='!h-30px !rounded-none'
                  style={{ borderInlineStart: '1px solid var(--border-base)' }}
                  icon={<FolderOpen theme='outline' size='16' fill={iconColors.secondary} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePick();
                  }}
                />
              </Tooltip>
            </div>
          </div>
        );
      }}
    </Form.Item>
  );
};

export default DirInputItem;
