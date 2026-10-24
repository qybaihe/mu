/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import AboutModalContent from '@/renderer/components/settings/SettingsModal/contents/AboutModalContent';
import { SettingsPage } from '../components/SettingsPageHeader';

/** Which mu this is, its updates, and the way to its log folder. */
const AboutSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t('settings.about')}>
      <AboutModalContent />
    </SettingsPage>
  );
};

export default AboutSettings;
