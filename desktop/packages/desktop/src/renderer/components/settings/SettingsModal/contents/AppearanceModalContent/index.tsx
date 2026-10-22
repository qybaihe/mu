/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '@/renderer/components/settings/LanguageSwitcher';
import ScaleControl from '@/renderer/components/settings/ScaleControl';
import CssThemeSettings from '@renderer/pages/settings/AppearanceSettings/CssThemeSettings';
import MuScrollArea from '@/renderer/components/base/MuScrollArea';
import { FONT_SIZE_KEYS, FONT_SIZE_SPECS, FONT_SIZE_STEP, type FontSizeKey } from '@/common/config/fontSizes';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';
import { useSettingsViewMode } from '../../settingsViewContext';
import FontSizeStepper from './FontSizeStepper';
import FontFamilySelect from './FontFamilySelect';
import FontWeightSelect from './FontWeightSelect';

/**
 * Map each appearance region to its row-label i18n key. Regions match
 * FONT_SIZE_KEYS one-for-one — 'app' is the global default the others inherit.
 */
const FONT_REGION_LABEL_KEY: Record<FontSizeKey, string> = {
  app: 'settings.fontRegionApp',
  chat: 'settings.fontRegionChat',
  markdown: 'settings.fontRegionMarkdown',
  code: 'settings.fontRegionCode',
};

/**
 * 偏好设置行组件 / Preference row component
 * 用于显示标签和对应的控件，统一的水平布局 / Used for displaying labels and corresponding controls in a unified horizontal layout
 */
const PreferenceRow: React.FC<{
  /** 标签文本 / Label text */
  label: string;
  /** 控件元素 / Control element */
  children: React.ReactNode;
}> = ({ label, children }) => (
  <div className='flex flex-col items-stretch gap-10px py-12px md:flex-row md:items-center md:justify-between md:gap-24px'>
    <div className='text-14px font-500 text-t-primary leading-22px'>{label}</div>
    <div className='w-full flex md:flex-1 md:justify-end'>{children}</div>
  </div>
);

/**
 * 外观设置内容组件 / Appearance settings content component
 *
 * 提供外观相关的配置选项，包括界面语言、主题画廊、字体（字族 + 字号）和缩放
 * Provides appearance-related configuration options including the interface
 * language, theme gallery, fonts (family + size) and scale.
 *
 * @features
 * - 界面语言 / Interface language
 * - 统一主题画廊（浅色、深色及装饰主题）/ Unified theme gallery (light, dark, decorative)
 * - 分区字体：全局/聊天/Markdown/代码，每区可选字族与字号，未选字族的区继承全局
 *   Per-region fonts: global/chat/markdown/code, each with a family + size;
 *   regions without a family inherit the global one
 * - 缩放比例控制 / Zoom scale control
 */
const AppearanceModalContent: React.FC = () => {
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const { fontSizes, setFontSize, fontFamilies, setFontFamily, fontWeights, setFontWeight } = useThemeContext();

  return (
    <div className='flex flex-col h-full w-full'>
      {/* 内容区域 / Content Area */}
      <MuScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        {/* Quiet lists and groups, no boxes: the language, the theme gallery, the fonts, the scale. */}
        <div className='flex flex-col gap-16px'>
          {/* 语言 / Language */}
          <div className='settings-list' data-testid='appearance-language'>
            <PreferenceRow label={t('settings.language')}>
              <LanguageSwitcher />
            </PreferenceRow>
          </div>

          {/* 主题画廊 / Theme Gallery */}
          <section className='settings-group'>
            <h3 className='settings-group__title'>{t('settings.theme')}</h3>
            <CssThemeSettings />
          </section>

          {/* 字体（字族 + 字号）/ Fonts (family + size) */}
          <section className='settings-group'>
            <h3 className='settings-group__title'>{t('settings.fonts')}</h3>
            <div className='settings-list'>
              {FONT_SIZE_KEYS.map((key) => (
                <PreferenceRow key={key} label={t(FONT_REGION_LABEL_KEY[key])}>
                  <div className='flex items-center gap-12px flex-wrap justify-end'>
                    <FontFamilySelect
                      value={fontFamilies[key]}
                      onChange={(family) => void setFontFamily(key, family)}
                    />
                    <FontWeightSelect value={fontWeights[key]} onChange={(weight) => void setFontWeight(key, weight)} />
                    <FontSizeStepper
                      value={fontSizes[key]}
                      min={FONT_SIZE_SPECS[key].min}
                      max={FONT_SIZE_SPECS[key].max}
                      step={FONT_SIZE_STEP}
                      defaultValue={FONT_SIZE_SPECS[key].default}
                      resetLabel={t('settings.fontSizeStepperReset')}
                      onChange={(px) => void setFontSize(key, px)}
                    />
                  </div>
                </PreferenceRow>
              ))}
            </div>
          </section>

          {/* 缩放控制 / Scale Control */}
          <div className='settings-list'>
            <PreferenceRow label={t('settings.scale')}>
              <ScaleControl />
            </PreferenceRow>
          </div>
        </div>
      </MuScrollArea>
    </div>
  );
};

export default AppearanceModalContent;
