/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import AppearanceModalContent from '@/renderer/components/settings/SettingsModal/contents/AppearanceModalContent';
import { SettingsPage } from '../components/SettingsPageHeader';

/** How mu looks: the language, the theme, the type and the scale. */
const AppearanceSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t('settings.appearancePanel')}>
      <AppearanceModalContent />
    </SettingsPage>
  );
};

export default AppearanceSettings;
