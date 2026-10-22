/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageTips } from '@/common/chat/chatLib';
import { showAsMu } from '@/common/kyrn/displayName';
import { Button, Collapse, Tag } from '@arco-design/web-react';
import { Attention, CheckOne, Info } from '@icon-park/react';
import classNames from 'classnames';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import MarkdownView from '@renderer/components/Markdown';
import ButlerDiagnoseButton from '@renderer/components/base/ButlerDiagnoseButton';
import CollapsibleContent from '@renderer/components/chat/CollapsibleContent';
import { iconColors } from '@/renderer/styles/colors';
import { findMuTurnError, muTurnErrorKey, noModelDetail } from '@/renderer/utils/chat/muTurnErrors';

// One entry per `IMessageTips['type']`. `info` was missing, and the render
// falls back to `warning`, so every informational tip was drawn with the alarm
// icon — a backend that deliberately downgrades a notice to Info still reached
// the user as a warning.
export const icon = {
  success: <CheckOne theme='filled' size='16' fill={iconColors.success} className='m-t-2px' />,
  info: <Info theme='filled' size='16' strokeLinejoin='bevel' className='m-t-2px' fill={iconColors.brand} />,
  warning: <Attention theme='filled' size='16' strokeLinejoin='bevel' className='m-t-2px' fill={iconColors.warning} />,
  error: <Attention theme='filled' size='16' strokeLinejoin='bevel' className='m-t-2px' fill={iconColors.danger} />,
};

const useFormatContent = (content: string) => {
  return useMemo(() => {
    try {
      const json = JSON.parse(content);
      return {
        json: true,
        data: json,
      };
    } catch {
      return { data: content };
    }
  }, [content]);
};

const ownershipColor = {
  mu: 'red',
  user_agent: 'orange',
  user_llm_provider: 'arcoblue',
  unknown_upstream: 'gray',
};

const resolveAgentTipBody = (
  content: string,
  code: IMessageTips['content']['code'],
  params: IMessageTips['content']['params'],
  t: ReturnType<typeof useTranslation>['t']
) => {
  // Tip text without a code is the backend's own words; a translated one already passed the i18n post-processor.
  if (!code) return showAsMu(content);
  return t(`conversation.agentTip.codes.${code}.body`, {
    ...params,
    defaultValue: content,
  });
};

/**
 * mu has no model to answer with (none set up, or none with a key): what to do about it, and the way to the providers'
 * settings where it is done. pi's own text tells a terminal user to run `/login` and names a harness doc; neither is
 * shown, only the provider it names, if any, as a detail.
 */
const NoModelCard: React.FC<{ detail: string }> = ({ detail }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const page = t('mu.sections.providers');
  const place = `${t('common.settings')} › ${page}`;
  return (
    <div className='w-full' data-testid='mu-no-model'>
      <div className='bg-message-tips rd-8px p-x-12px p-y-10px flex flex-col gap-8px'>
        <div className='flex items-start gap-6px'>
          {icon.warning}
          <div className='flex-1 min-w-0 flex flex-col gap-6px'>
            <div className='font-500 text-t-primary [word-break:break-word]'>{t('mu.noModel.title')}</div>
            <div className='text-t-secondary whitespace-break-spaces [word-break:break-word]'>
              {t('mu.noModel.body', { place })}
            </div>
            {detail && (
              <div className='text-t-tertiary text-12px whitespace-break-spaces [word-break:break-word]'>{detail}</div>
            )}
          </div>
        </div>
        <div className='flex justify-end'>
          <Button
            type='primary'
            size='small'
            data-testid='mu-no-model-open'
            onClick={() => void navigate('/settings/providers')}
          >
            {t('mu.noModel.open', { page })}
          </Button>
        </div>
      </div>
    </div>
  );
};

const MessageTips: React.FC<{ message: IMessageTips }> = ({ message }) => {
  const { t } = useTranslation();
  const { content, type, code, params } = message.content;
  const structuredError = type === 'error' ? message.content.error : undefined;
  const localizedTipBody = resolveAgentTipBody(content, code, params, t);
  const { json, data } = useFormatContent(localizedTipBody);

  const displayContent = json ? '' : localizedTipBody;
  // An error the mu bridge raised in fixed English: headline in the reader's language, the original as a detail.
  const muError =
    type === 'error' ? findMuTurnError([structuredError?.detail, structuredError?.message, content]) : undefined;
  const muErrorHeadline = muError ? t(muTurnErrorKey(muError)) : undefined;
  if (muError === 'noModel')
    return <NoModelCard detail={noModelDetail(structuredError?.detail || structuredError?.message || content || '')} />;
  // The Butler chip shows on every error — environment issues are exactly
  // what the Butler diagnoses best.
  const shouldShowButler = type === 'error';

  if (structuredError) {
    const errorCode = structuredError.code;
    const ownership = structuredError.ownership;
    const title = errorCode
      ? t(`conversation.agentError.codes.${errorCode}.title`, {
          defaultValue: t('conversation.agentError.fallbackTitle'),
        })
      : t('conversation.agentError.fallbackTitle');
    const body = muErrorHeadline
      ? muErrorHeadline
      : errorCode
        ? t(
            structuredError.workspacePath
              ? `conversation.agentError.codes.${errorCode}.bodyWithPath`
              : `conversation.agentError.codes.${errorCode}.body`,
            {
              workspacePath: structuredError.workspacePath,
              defaultValue: structuredError.message || content,
            }
          )
        : showAsMu(structuredError.message || content);
    const ownershipLabel = ownership
      ? t(`conversation.agentError.ownership.${ownership}`, {
          defaultValue: t('conversation.agentError.ownership.unknown_upstream'),
        })
      : null;
    const retryHint =
      structuredError.retryable === undefined
        ? null
        : structuredError.retryable
          ? t('conversation.agentError.retryable')
          : t('conversation.agentError.notRetryable');
    const resolutionHint = structuredError.resolution
      ? `${t('conversation.agentError.resolutionPrefix')}${t(
          `conversation.agentError.resolution.${structuredError.resolution.kind}`
        )}`
      : null;
    const detailParts = [
      errorCode ? t('conversation.agentError.errorCodeValue', { code: errorCode }) : '',
      showAsMu(structuredError.detail || structuredError.message || ''),
    ].filter(Boolean);

    return (
      <div className='w-full'>
        <div className='bg-message-tips rd-8px p-x-12px p-y-10px flex flex-col gap-8px'>
          <div className='flex items-start gap-6px'>
            {icon.error}
            <div className='flex-1 min-w-0 flex flex-col gap-6px'>
              <div className='flex flex-wrap items-center gap-6px'>
                {ownershipLabel && (
                  <Tag size='small' color={ownership ? ownershipColor[ownership] : 'gray'}>
                    {ownershipLabel}
                  </Tag>
                )}
                {retryHint && (
                  <Tag size='small' color={structuredError.retryable ? 'green' : 'gray'}>
                    {retryHint}
                  </Tag>
                )}
              </div>
              <div className='font-500 text-t-primary [word-break:break-word]'>{title}</div>
              <div className='text-t-secondary whitespace-break-spaces [word-break:break-word]'>{body}</div>
              {resolutionHint && (
                <div className='text-t-secondary whitespace-break-spaces [word-break:break-word]'>{resolutionHint}</div>
              )}
              {detailParts.length > 0 && (
                <Collapse bordered={false} className='bg-transparent' defaultActiveKey={['technical-details']}>
                  <Collapse.Item
                    name='technical-details'
                    header={<span className='text-12px text-t-tertiary'>{t('common.technical_details')}</span>}
                  >
                    <div className='text-t-tertiary text-12px whitespace-break-spaces [word-break:break-word]'>
                      {detailParts.join('\n')}
                    </div>
                  </Collapse.Item>
                </Collapse>
              )}
            </div>
          </div>
          {shouldShowButler && (
            <div className='flex justify-end'>
              <ButlerDiagnoseButton errorText={[title, body, ...detailParts].filter(Boolean).join('\n')} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'info') {
    return (
      <div className='w-full'>
        <div className='p-x-12px p-y-4px'>
          <div className='text-center text-13px text-t-secondary whitespace-break-spaces [word-break:break-word]'>
            {localizedTipBody}
          </div>
        </div>
      </div>
    );
  }

  if (json)
    return (
      <div className='w-full'>
        <div className={classNames('bg-message-tips rd-8px p-x-12px p-y-8px flex flex-col gap-4px')}>
          <div className='flex items-start gap-4px'>
            {icon[type] || icon.warning}
            <div className='flex-1 min-w-0'>
              <MarkdownView>{`\`\`\`json\n${showAsMu(JSON.stringify(data, null, 2))}\n\`\`\``}</MarkdownView>
            </div>
          </div>
          {type === 'error' && (
            <div className='flex justify-end'>
              <ButlerDiagnoseButton errorText={showAsMu(JSON.stringify(data, null, 2))} />
            </div>
          )}
        </div>
      </div>
    );
  return (
    <div className='w-full'>
      <div className={classNames('bg-message-tips rd-8px  p-x-12px p-y-8px flex flex-col gap-4px')}>
        <div className='flex items-start gap-4px'>
          {icon[type] || icon.warning}
          <div className='flex-1 min-w-0'>
            <CollapsibleContent maxHeight={48} defaultCollapsed={true} useMask={true}>
              {muErrorHeadline ? (
                <div className='flex flex-col gap-2px'>
                  <span className='whitespace-break-spaces text-t-primary [word-break:break-word]'>
                    {muErrorHeadline}
                  </span>
                  <span className='whitespace-break-spaces text-12px text-t-secondary [word-break:break-word]'>
                    {displayContent}
                  </span>
                </div>
              ) : (
                <span className='whitespace-break-spaces text-t-primary [word-break:break-word]'>{displayContent}</span>
              )}
            </CollapsibleContent>
          </div>
        </div>
        {shouldShowButler && (
          <div className='flex justify-end'>
            <ButlerDiagnoseButton
              errorText={muErrorHeadline ? `${muErrorHeadline}\n${displayContent}` : displayContent}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageTips;
