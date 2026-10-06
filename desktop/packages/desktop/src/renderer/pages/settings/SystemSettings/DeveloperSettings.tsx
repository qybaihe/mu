/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import DevSettings from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/DevSettings';
import { SettingsPage } from '../components/SettingsPageHeader';

/**
 * For the people who build mu: the developer tools, and the in-app browser's debugging port with the MCP
 * configurations that reach it. They used to sit at the bottom of the system page.
 */
const DeveloperSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t('settings.developer.title')} description={t('settings.developer.description')}>
      <DevSettings />
    </SettingsPage>
  );
};

export default DeveloperSettings;
