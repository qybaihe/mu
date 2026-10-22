/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import MuSelect from '@/renderer/components/base/MuSelect';
import { FONT_WEIGHT_TIERS, SYSTEM_FONT_WEIGHT } from '@/common/config/fontWeights';

type FontWeightSelectProps = {
  /** Selected weight tier; '' means "system default (no override)". */
  value: string;
  onChange: (weight: string) => void;
};

/**
 * Font-weight picker for one appearance region. Unlike the family picker, the
 * options are a small fixed set of standard tiers (no font enumeration, no lazy
 * load), each rendered in its own weight so the menu previews it. The
 * always-present first option clears the override back to the inherited weight.
 */
const FontWeightSelect: React.FC<FontWeightSelectProps> = ({ value, onChange }) => {
  const { t } = useTranslation();

  const options = useMemo(() => {
    const list: { label: React.ReactNode; value: string }[] = [
      { label: t('settings.fontWeightSystemDefault'), value: SYSTEM_FONT_WEIGHT },
    ];
    for (const tier of FONT_WEIGHT_TIERS) {
      // Render each option in its own weight so the menu previews the tier.
      list.push({ label: <span style={{ fontWeight: tier.value }}>{t(tier.labelKey)}</span>, value: tier.value });
    }
    return list;
  }, [t]);

  return (
    <MuSelect
      // As wide as its label and longest name, from 170px up to the row's width: "Systemstandard" is not cut.
      className='w-max min-w-170px max-w-full'
      prefix={<span className='text-t-secondary'>{t('settings.fontWeightLabel')}</span>}
      aria-label={t('settings.fontWeightLabel')}
      value={value}
      onChange={(next) => onChange(typeof next === 'string' ? next : SYSTEM_FONT_WEIGHT)}
      options={options}
      // Every name in one cell, only the chosen one seen: the select keeps the width of the longest name whatever is
      // chosen, so the four rows line up.
      renderFormat={(_, chosen) => (
        <span className='inline-grid'>
          {options.map((option) => (
            <span
              key={option.value}
              className={option.value === chosen ? 'col-start-1 row-start-1' : 'col-start-1 row-start-1 invisible'}
              aria-hidden={option.value === chosen ? undefined : true}
            >
              {option.label}
            </span>
          ))}
        </span>
      )}
    />
  );
};

export default FontWeightSelect;
