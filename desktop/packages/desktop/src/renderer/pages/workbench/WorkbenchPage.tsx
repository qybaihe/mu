/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Team Workbench: the one page the team's needs surface on. Phase 1 ships the
 * "Needs your attention" tab; the tab registry below is where later phases dock —
 * deliverables (browse what the team produced, by group) and the parallel call
 * orchestrator both land as siblings of the attention tab, never as new entries
 * elsewhere in the app.
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import classNames from 'classnames';
import SettingsPageHeader from '@renderer/pages/settings/components/SettingsPageHeader';
import {
  SETTINGS_PAGE_COLUMN,
  SETTINGS_PAGE_GUTTER,
  SETTINGS_PAGE_TOP,
} from '@renderer/pages/settings/components/SettingsPageWrapper';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import AttentionPanel from './attention/AttentionPanel';
import { useAttentionSnapshot } from './attention/attentionStore';

const ATTENTION_TAB = 'attention';

const WorkbenchPage: React.FC = () => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const snapshot = useAttentionSnapshot();

  // The dock for later phases: deliverables and the parallel-call orchestrator extend this
  // array; the header already renders a count badge per tab.
  const tabs = useMemo(
    () => [{ key: ATTENTION_TAB, label: t('team.workbench.attention'), count: snapshot.badgeCount }],
    [t, snapshot.badgeCount]
  );

  return (
    <div className='w-full h-full min-h-0 box-border bg-1 flex flex-col overflow-hidden' data-testid='workbench-page'>
      <div
        className={classNames(
          'shrink-0 bg-1',
          isMobile ? 'px-16px pt-14px pb-14px' : classNames(SETTINGS_PAGE_GUTTER, SETTINGS_PAGE_TOP, 'pb-16px')
        )}
      >
        <div className={classNames(SETTINGS_PAGE_COLUMN, 'box-border')}>
          <SettingsPageHeader
            sticky={false}
            data-testid='workbench-header'
            title={t('team.workbench.title')}
            description={t('team.workbench.description')}
            tabs={tabs}
            activeTab={ATTENTION_TAB}
          />
        </div>
      </div>
      <div
        className={classNames(
          'flex-1 min-h-0 overflow-y-auto',
          isMobile ? 'px-16px pb-16px' : classNames(SETTINGS_PAGE_GUTTER, 'pb-24px')
        )}
      >
        <div className={classNames(SETTINGS_PAGE_COLUMN, 'box-border')}>
          <AttentionPanel />
        </div>
      </div>
    </div>
  );
};

export default WorkbenchPage;
