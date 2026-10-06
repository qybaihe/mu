/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import { useCrossSessionMessageEnabled } from '@/renderer/hooks/chat/useCrossSessionMessageEnabled';
import { getClientBusinessSetting, setClientBusinessSetting } from '@/renderer/services/clientBusinessSettings';
import {
  DEFAULT_TEXT_PREVIEW_LIMIT_MB,
  MAX_TEXT_PREVIEW_LIMIT_MB,
  MIN_TEXT_PREVIEW_LIMIT_MB,
  normalizeTextPreviewLimitMb,
} from '@/renderer/utils/file/previewPayload';
import { InputNumber, Message, Switch } from '@arco-design/web-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import PreferenceRow from './PreferenceRow';

/**
 * What a conversation may wait for and keep: how long a turn and an idle agent are given, how large a file the preview
 * shows, whether uploads are kept in the workspace, and whether conversations may message each other.
 */
const ConversationPreferences: React.FC = () => {
  const { t } = useTranslation();
  const [promptTimeout, setPromptTimeout] = useState<number>(300);
  const [agentIdleTimeout, setAgentIdleTimeout] = useState<number>(5);
  /**
   * The committed limit — what is stored, and what the field falls back to.
   *
   * The field itself is left uncontrolled while typing. Arco's `InputNumber` skips its
   * internal "user is typing" state whenever a `value` prop is present, and then
   * renders the number it parsed rather than the characters that were entered. `1.` is
   * not a number, so the dot was dropped on the keystroke that produced it and `1.5`
   * came out as `15`.
   *
   * Remounting on commit (via `key`) is what lets an uncontrolled field still show a
   * clamped result: type `0.2`, blur, and the field comes back as the accepted `1`.
   */
  const [previewLimitMb, setPreviewLimitMb] = useState<number>(DEFAULT_TEXT_PREVIEW_LIMIT_MB);
  const previewLimitDraftRef = useRef<string>(String(DEFAULT_TEXT_PREVIEW_LIMIT_MB));
  const [saveUploadToWorkspace, setSaveUploadToWorkspace] = useState(false);

  useEffect(() => {
    setSaveUploadToWorkspace(configService.get('upload.saveToWorkspace') ?? false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadAcpTimeouts = async () => {
      try {
        const [storedPromptTimeout, storedAgentIdleTimeout, storedPreviewLimitMb] = await Promise.all([
          getClientBusinessSetting('acp.promptTimeout'),
          getClientBusinessSetting('acp.agentIdleTimeout'),
          getClientBusinessSetting('preview.textSizeLimitMb'),
        ]);
        if (cancelled) {
          return;
        }

        if (typeof storedPromptTimeout === 'number' && storedPromptTimeout > 0) {
          setPromptTimeout(storedPromptTimeout);
        }
        if (typeof storedAgentIdleTimeout === 'number' && storedAgentIdleTimeout > 0) {
          setAgentIdleTimeout(storedAgentIdleTimeout);
        }
        // Normalized rather than range-checked inline: the same clamp guards the
        // stored value, the field, and the size check, so a hand-edited or legacy
        // entry cannot present one limit here and apply another when a file opens.
        if (storedPreviewLimitMb !== undefined) {
          const stored = normalizeTextPreviewLimitMb(storedPreviewLimitMb);
          setPreviewLimitMb(stored);
          previewLimitDraftRef.current = String(stored);
        }
      } catch {
        // Keep the in-memory defaults when backend settings are unavailable.
      }
    };

    void loadAcpTimeouts();

    return () => {
      cancelled = true;
    };
  }, []);

  const handlePromptTimeoutChange = useCallback((val: number | undefined) => {
    setPromptTimeout(val as number);
  }, []);

  const handlePromptTimeoutBlur = useCallback(() => {
    const clamped = Math.max(30, Math.min(3600, promptTimeout || 300));
    setPromptTimeout(clamped);
    void setClientBusinessSetting('acp.promptTimeout', clamped).catch(() => {});
  }, [promptTimeout]);

  const handleAgentIdleTimeoutChange = useCallback((val: number | undefined) => {
    setAgentIdleTimeout(val as number);
  }, []);

  const handleAgentIdleTimeoutBlur = useCallback(() => {
    const clamped = Math.max(1, Math.min(60, agentIdleTimeout || 5));
    setAgentIdleTimeout(clamped);
    void setClientBusinessSetting('acp.agentIdleTimeout', clamped).catch(() => {});
  }, [agentIdleTimeout]);

  /**
   * Keep what the user typed, not a number parsed from it.
   *
   * A decimal is typed one character at a time, and `1.` is a necessary intermediate
   * state on the way to `1.5`. Storing it as a number turns it back into `1`, the
   * controlled value re-renders the field as `"1"`, and the trailing dot is gone
   * before the next keystroke arrives — so `1.5` came out as `15`. Holding the raw
   * string lets the dot survive until the value is actually used.
   *
   * Nothing downstream sees this string: {@link handlePreviewLimitMbBlur} is the only
   * writer, and it normalizes first.
   */
  const handlePreviewLimitMbChange = useCallback((val: number | string) => {
    previewLimitDraftRef.current = val === undefined || val === null ? '' : String(val);
  }, []);

  /**
   * Persist on blur, not on every keystroke: the field is cleared to empty while
   * retyping, and writing that intermediate state would store a limit the user never
   * chose. The clamp runs here too, so the stored value is always one the size check
   * would accept.
   *
   * Only newly opened preview tabs see the new limit — tabs already open captured
   * theirs when they opened. That is deliberate: reclassifying an open tab would move
   * a file being edited into the "too large to show" state mid-edit.
   */
  const handlePreviewLimitMbBlur = useCallback(() => {
    const typed = previewLimitDraftRef.current.trim();
    // An emptied field means "unset", which normalize turns into the default; Number('')
    // would be 0 and clamp up to the minimum instead, silently choosing for the user.
    const clamped = normalizeTextPreviewLimitMb(typed === '' ? undefined : Number(typed));
    setPreviewLimitMb(clamped);
    previewLimitDraftRef.current = String(clamped);
    void setClientBusinessSetting('preview.textSizeLimitMb', clamped).catch(() => {});
  }, []);

  // Cross-session messaging master switch. Unlike its neighbours this one is a
  // typed column on `system_settings`, so it goes through `PATCH /api/settings`
  // (the hook owns that call); `changeLanguage` is the precedent for the
  // different channel.
  const { enabled: crossSessionMessageEnabled, setEnabled: setCrossSessionMessageEnabled } =
    useCrossSessionMessageEnabled();
  const handleCrossSessionMessageChange = useCallback(
    (checked: boolean) => {
      void setCrossSessionMessageEnabled(checked).catch(() => {
        // The hook already rolled the local state back; surface the failure so
        // the user does not believe a panic button took effect when it did not.
        Message.error(t('settings.crossSessionMessageUpdateFailed'));
      });
    },
    [setCrossSessionMessageEnabled, t]
  );

  const handleSaveUploadToWorkspaceChange = useCallback((checked: boolean) => {
    setSaveUploadToWorkspace(checked);
    configService.set('upload.saveToWorkspace', checked).catch(() => {
      setSaveUploadToWorkspace(!checked);
      configService.setLocal('upload.saveToWorkspace', !checked);
    });
  }, []);

  const preferenceItems = [
    {
      key: 'promptTimeout',
      label: t('settings.promptTimeout'),
      component: (
        <InputNumber
          value={promptTimeout}
          onChange={handlePromptTimeoutChange}
          onBlur={handlePromptTimeoutBlur}
          max={3600}
          step={30}
          style={{ width: 120 }}
          suffix={t('settings.promptTimeoutUnit')}
        />
      ),
    },
    {
      key: 'agentIdleTimeout',
      label: t('settings.agentIdleTimeout'),
      description: t('settings.agentIdleTimeoutDesc'),
      component: (
        <InputNumber
          value={agentIdleTimeout}
          onChange={handleAgentIdleTimeoutChange}
          onBlur={handleAgentIdleTimeoutBlur}
          max={60}
          step={5}
          style={{ width: 120 }}
          suffix={t('settings.agentIdleTimeoutUnit')}
        />
      ),
    },
    {
      key: 'previewTextSizeLimit',
      label: t('settings.previewTextSizeLimit'),
      description: t('settings.previewTextSizeLimitDesc'),
      component: (
        <InputNumber
          key={`preview-limit-${previewLimitMb}`}
          defaultValue={previewLimitMb}
          onChange={handlePreviewLimitMbChange}
          onBlur={handlePreviewLimitMbBlur}
          min={MIN_TEXT_PREVIEW_LIMIT_MB}
          max={MAX_TEXT_PREVIEW_LIMIT_MB}
          step={0.5}
          style={{ width: 120 }}
          suffix={t('settings.previewTextSizeLimitUnit')}
        />
      ),
    },
    {
      key: 'saveUploadToWorkspace',
      label: t('settings.saveUploadToWorkspace'),
      component: <Switch size='small' checked={saveUploadToWorkspace} onChange={handleSaveUploadToWorkspaceChange} />,
    },
    {
      // Positive wording, default on (spec §5.7): every other switch here is
      // phrased affirmatively, and a negated one would read as a double
      // negative next to them.
      key: 'crossSessionMessage',
      label: t('settings.crossSessionMessage'),
      description: t('settings.crossSessionMessageDesc'),
      component: (
        <Switch size='small' checked={crossSessionMessageEnabled} onChange={handleCrossSessionMessageChange} />
      ),
    },
  ];

  return (
    <div className='settings-list'>
      {preferenceItems.map((item) => (
        <PreferenceRow key={item.key} label={item.label} description={item.description}>
          {item.component}
        </PreferenceRow>
      ))}
    </div>
  );
};

export default ConversationPreferences;
