/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import BrowserDataSection from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/BrowserDataSection';
import { SettingsPage } from '../components/SettingsPageHeader';

/** The in-app browser: whether mu may use it, and clearing what it keeps (sign-ins, cache). */
const BrowserSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t('settings.browserData.title')}>
      <BrowserDataSection />
    </SettingsPage>
  );
};

export default BrowserSettings;
