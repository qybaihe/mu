/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import MuSelect from '@/renderer/components/base/MuSelect';
import { DROPDOWN_SEARCH_THRESHOLD } from '@/renderer/components/agent/runtimeSelectorOptions';
import { SYSTEM_FONT_FAMILY } from '@/common/config/fontFamilies';
import useSystemFonts from '@renderer/hooks/ui/font/useSystemFonts';

type FontFamilySelectProps = {
  /** Selected family name; '' means "system default (no override)". */
  value: string;
  onChange: (family: string) => void;
};

/**
 * Font-family picker for one appearance region. The machine's installed fonts
 * are enumerated lazily: the Local Font Access query fires when the dropdown
 * opens (a user gesture, which the API requires), never on mount. A search box
 * appears once the list is long. The always-present first option clears the
 * override back to the built-in default stack.
 */
const FontFamilySelect: React.FC<FontFamilySelectProps> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const { fonts, status, load } = useSystemFonts();

  const systemDefault = t('settings.fontFamilySystemDefault');
  const options = useMemo(() => {
    const list: { label: React.ReactNode; value: string }[] = [{ label: systemDefault, value: SYSTEM_FONT_FAMILY }];
    for (const family of fonts) {
      // Render each option in its own face so the menu previews the font; a name cut in the menu is whole on hover.
      list.push({
        label: (
          <span style={{ fontFamily: `"${family}"` }} title={family}>
            {family}
          </span>
        ),
        value: family,
      });
    }
    return list;
  }, [fonts, systemDefault]);

  const notFoundContent =
    status === 'loading'
      ? t('settings.fontFamilyLoading')
      : status === 'error'
        ? t('settings.fontFamilyError')
        : t('settings.fontFamilyNoResults');

  return (
    <MuSelect
      // As wide as its label and the default's words ("システムのデフォルト" is not cut), at least 240px, whatever is
      // chosen: the four rows line up, and a family name longer than that is cut, whole on hover and in the menu's
      // tooltip.
      className='w-max min-w-240px max-w-full'
      // Two selects side by side in a row: each says what it picks.
      prefix={<span className='text-t-secondary'>{t('settings.fontFamilyLabel')}</span>}
      aria-label={t('settings.fontFamilyLabel')}
      value={value}
      onChange={(next) => onChange(typeof next === 'string' ? next : SYSTEM_FONT_FAMILY)}
      options={options}
      // The default's words hold the width, seen only when it is chosen. A chosen family, in its own face, fills the
      // whole value area (the grid spans it) and adds no width of its own (w-0 min-w-full).
      renderFormat={(_, chosen) => {
        const family = typeof chosen === 'string' ? chosen : SYSTEM_FONT_FAMILY;
        const own = family !== SYSTEM_FONT_FAMILY;
        return (
          <span className='inline-grid w-full'>
            <span
              className={own ? 'col-start-1 row-start-1 invisible' : 'col-start-1 row-start-1'}
              aria-hidden={own || undefined}
            >
              {systemDefault}
            </span>
            {own ? (
              <span
                className='col-start-1 row-start-1 w-0 min-w-full truncate'
                style={{ fontFamily: `"${family}"` }}
                title={family}
              >
                {family}
              </span>
            ) : null}
          </span>
        );
      }}
      loading={status === 'loading'}
      showSearch={fonts.length > DROPDOWN_SEARCH_THRESHOLD}
      // Options carry JSX labels (font previews), so match on the value (family name) instead.
      filterOption={(inputValue, option) =>
        String((option?.props as { value?: unknown } | undefined)?.value ?? '')
          .toLowerCase()
          .includes(inputValue.toLowerCase())
      }
      notFoundContent={notFoundContent}
      onVisibleChange={(visible) => {
        if (visible) load();
      }}
    />
  );
};

export default FontFamilySelect;
