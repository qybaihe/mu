import MuSelect from '@/renderer/components/base/MuSelect';
import type { SelectHandle } from '@arco-design/web-react/es/Select/interface';
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage } from '@/renderer/services/i18n';
import { languageListOrder, nativeLanguageName } from './languageOrder';

const LanguageSwitcher: React.FC = () => {
  const { t, i18n } = useTranslation();
  const selectRef = useRef<SelectHandle>(null);

  const handleLanguageChange = useCallback((value: string) => {
    // 切换前先 blur 触发元素，避免弹层和语言切换竞争布局
    // Blur before switching to avoid dropdown and language change fighting for layout
    selectRef.current?.blur?.();

    const applyLanguage = () => {
      changeLanguage(value).catch((error: Error) => {
        console.error('Failed to change language:', error);
      });
    };

    if (typeof window !== 'undefined' && 'requestAnimationFrame' in window) {
      // 延迟到下一帧执行，确保 DOM 动画已完成 / defer to next frame so DOM animations finish
      window.requestAnimationFrame(() => window.requestAnimationFrame(applyLanguage));
    } else {
      setTimeout(applyLanguage, 0);
    }
  }, []);

  return (
    <div className='flex items-center gap-8px'>
      <MuSelect
        ref={selectRef}
        className='w-160px'
        value={i18n.language}
        onChange={handleLanguageChange}
        aria-label={t('settings.language')}
      >
        {/* The language in use on top, the others by their own names (see languageOrder). */}
        {languageListOrder(i18n.language).map((language) => (
          <MuSelect.Option key={language} value={language}>
            {nativeLanguageName(language)}
          </MuSelect.Option>
        ))}
      </MuSelect>
    </div>
  );
};

export default LanguageSwitcher;
