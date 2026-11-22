/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The webhook trigger's settings: the master switch (off until the user
 * turns it on — this one opens a socket, unlike the always-on schedules),
 * the URL and token to copy into an external system while it is on, and each
 * position's mode — `notify` (suggest only, the default) or `auto` (start
 * work) — straight into the backend's client KV, which the delivery path
 * reads per hook.
 */
import { webhookBridge, type WebhookStatus } from '@/common/chat/team/webhook/webhookBridge';
import type { WebhookPositionMode } from '@/common/chat/team/webhook/webhookCore';
import { Button, Message, Switch } from '@arco-design/web-react';
import { Copy } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getClientBusinessSetting,
  removeClientBusinessSetting,
  setClientBusinessSetting,
} from '@/renderer/services/clientBusinessSettings';
import MuSelect from '@/renderer/components/base/MuSelect';
import { usePositionRoster } from '@renderer/pages/positions/usePositionRoster';
import PreferenceRow from './PreferenceRow';

const WebhookSection: React.FC = () => {
  const { t } = useTranslation();
  const { positions } = usePositionRoster();
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [modes, setModes] = useState<Record<string, WebhookPositionMode>>({});

  useEffect(() => {
    let cancelled = false;
    webhookBridge.status
      .invoke()
      .then((answer) => {
        if (!cancelled) setStatus(answer);
      })
      .catch(() => {});
    void getClientBusinessSetting('tools.webhookPositionModes').then((stored) => {
      if (!cancelled && stored) setModes(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleEnabled = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        setStatus(await webhookBridge.setEnabled.invoke({ enabled }));
      } catch {
        Message.error(t('webhook.settings.updateFailed'));
      } finally {
        setBusy(false);
      }
    },
    [t]
  );

  const changeMode = useCallback(
    async (positionId: string, mode: WebhookPositionMode) => {
      setModes((previous) => ({ ...previous, [positionId]: mode }));
      try {
        const next: Record<string, WebhookPositionMode> = { ...modes, [positionId]: mode };
        // Persist exactly the deliberate choices: a position never touched
        // stays absent, which reads back as the conservative default. An empty
        // map must be REMOVED, not written — JSON.stringify drops an undefined
        // value, so a set-with-undefined would silently keep the stale autos.
        for (const key of Object.keys(next)) if (next[key] === 'notify') delete next[key];
        if (Object.keys(next).length > 0) await setClientBusinessSetting('tools.webhookPositionModes', next);
        else await removeClientBusinessSetting('tools.webhookPositionModes');
      } catch {
        Message.error(t('webhook.settings.updateFailed'));
      }
    },
    [modes, t]
  );

  const copy = useCallback(
    (value: string) => {
      void navigator.clipboard.writeText(value).then(() => {
        Message.success(t('common.copySuccess'));
      });
    },
    [t]
  );

  const enabled = status?.enabled === true;

  return (
    <div className='settings-list' data-testid='webhook-section'>
      <PreferenceRow label={t('webhook.settings.master')} description={t('webhook.settings.masterHint')}>
        <Switch
          size='small'
          checked={enabled}
          disabled={busy}
          onChange={toggleEnabled}
          data-testid='webhook-master-switch'
        />
      </PreferenceRow>
      {enabled && status?.listening ? (
        <>
          <PreferenceRow label={t('webhook.settings.url')} description={t('webhook.settings.urlHint')}>
            <div className='flex items-center gap-8px'>
              <code className='text-12px text-t-secondary break-all'>{status.urlTemplate}</code>
              <Button
                size='mini'
                icon={<Copy />}
                onClick={() => copy(String(status.urlTemplate))}
                aria-label={t('webhook.settings.copyUrl')}
              />
            </div>
          </PreferenceRow>
          <PreferenceRow label={t('webhook.settings.token')} description={t('webhook.settings.tokenHint')}>
            <div className='flex items-center gap-8px'>
              <code className='text-12px text-t-secondary'>{status.token}</code>
              <Button
                size='mini'
                icon={<Copy />}
                onClick={() => copy(status.token)}
                aria-label={t('webhook.settings.copyToken')}
              />
            </div>
          </PreferenceRow>
          {positions.length > 0 ? (
            <div className='ps-16px'>
              <div className='text-12px text-t-secondary py-8px'>{t('webhook.settings.modesTitle')}</div>
              {positions.map((position) => (
                <PreferenceRow key={position.name} label={position.displayName}>
                  <MuSelect
                    value={modes[position.name] ?? 'notify'}
                    onChange={(value: string) => changeMode(position.name, value === 'auto' ? 'auto' : 'notify')}
                    className='w-160px'
                    data-testid={`webhook-mode-${position.name}`}
                  >
                    <MuSelect.Option value='notify'>{t('webhook.settings.modeNotify')}</MuSelect.Option>
                    <MuSelect.Option value='auto'>{t('webhook.settings.modeAuto')}</MuSelect.Option>
                  </MuSelect>
                </PreferenceRow>
              ))}
            </div>
          ) : (
            <div className='ps-16px text-12px text-t-secondary py-8px'>{t('webhook.settings.noPositions')}</div>
          )}
          <div className='px-16px py-8px text-12px text-t-tertiary'>{t('webhook.settings.loopbackNote')}</div>
        </>
      ) : null}
    </div>
  );
};

export default WebhookSection;
