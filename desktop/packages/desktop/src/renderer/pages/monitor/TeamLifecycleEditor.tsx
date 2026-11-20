/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The team card's lifecycle editor: the popover a team card's TTL chip opens.
 * A day count (1-365) and the permanent switch; saving writes the shared
 * index through the supervisor bridge — the card re-reads its chip from the
 * answer. Pure presentational state on top of one bridge call.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, InputNumber, Switch } from '@arco-design/web-react';
import { TEAM_TTL_MAX_DAYS, TEAM_TTL_MIN_DAYS } from '@/common/chat/team/supervisor/supervisorCore';

export type TeamLifecycleEditorProps = {
  /** The day count the row carries now; the default 7 when the index lacks one. */
  ttlDays: number;
  permanent: boolean;
  /** Saves the pair; resolves when the index has the new lifecycle. */
  onApply: (ttlDays: number, permanent: boolean) => Promise<void>;
  /** Closes the popover without saving. */
  onCancel: () => void;
};

const TeamLifecycleEditor: React.FC<TeamLifecycleEditorProps> = ({ ttlDays, permanent, onApply, onCancel }) => {
  const { t } = useTranslation();
  const [days, setDays] = useState<number>(ttlDays);
  const [forever, setForever] = useState<boolean>(permanent);
  const [saving, setSaving] = useState(false);

  const apply = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onApply(days, forever);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid='team-lifecycle-editor' className='flex flex-col gap-10px p-4px w-200px'>
      <div className='text-12px font-500 text-t-secondary'>{t('monitor.teams.lifecycle.label')}</div>
      <div className='flex items-center gap-10px'>
        <InputNumber
          data-testid='team-lifecycle-days'
          aria-label={t('monitor.teams.lifecycle.days')}
          value={days}
          min={TEAM_TTL_MIN_DAYS}
          max={TEAM_TTL_MAX_DAYS}
          step={1}
          precision={0}
          disabled={forever}
          onChange={(value) => setDays(typeof value === 'number' ? value : ttlDays)}
        />
        <span className='text-12px text-t-tertiary shrink-0'>{t('monitor.teams.lifecycle.days')}</span>
      </div>
      <div className='flex items-center gap-10px'>
        <Switch
          data-testid='team-lifecycle-permanent'
          aria-label={t('monitor.teams.lifecycle.permanent')}
          size='small'
          checked={forever}
          onChange={(checked) => setForever(checked)}
        />
        <span className='text-12px text-t-secondary'>{t('monitor.teams.lifecycle.permanent')}</span>
      </div>
      <div className='flex items-center justify-end gap-8px'>
        <Button size='mini' onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          data-testid='team-lifecycle-apply'
          size='mini'
          type='primary'
          loading={saving}
          onClick={() => void apply()}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
};

export default TeamLifecycleEditor;
