/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import ToolsModalContent from '@/renderer/components/settings/SettingsModal/contents/ToolsModalContent';
import { SettingsPage } from '../components/SettingsPageHeader';

/** The tools mu may call: MCP servers, and the built-in image generation. */
const ToolsSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t('mu.capabilities.toolsClassic')} description={t('settings.toolsDescription')}>
      <ToolsModalContent />
    </SettingsPage>
  );
};

export default ToolsSettings;
