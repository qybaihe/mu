/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BadgeProps } from '@arco-design/web-react';
import { Badge, Button, Message, Tooltip } from '@arco-design/web-react';
import { Down, Download, Right } from '@icon-park/react';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { getAcpImageFileName } from '@/common/chat/acpToolCallOutput';
import type { NormalizedToolCall, NormalizedToolStatus, ToolMessage } from '@/common/chat/normalizeToolCall';
import { normalizeToolMessages } from '@/common/chat/normalizeToolCall';
import LocalImageView from '@/renderer/components/media/LocalImageView';
import { HiveToolCard } from '@/renderer/pages/conversation/KyrnPanel/Hive';
import { swarmProgressText } from '@/renderer/pages/conversation/KyrnPanel/Hive/codes';
import { formatNumber } from '@/renderer/services/i18n/format';
import { downloadFileFromPath } from '@/renderer/utils/file/download';
import { useMessageListRun } from '../hooks';
import styles from './MessageToolGroupSummary.module.css';
import ToolKindIcon from './ToolKindIcon';
import {
  clipOutput,
  shouldFoldActivity,
  summarizeToolActivity,
  toolActivityDenied,
  toolActivityErrors,
  toolErrorLine,
  toolLabel,
  type ToolLabel,
} from './toolActivity';

const statusToBadge = (status: NormalizedToolStatus, denied?: boolean): BadgeProps['status'] => {
  // A call the person said no to never ran: no failure, no success.
  if (denied) return 'default';
  switch (status) {
    case 'completed':
      return 'success';
    case 'error':
      return 'error';
    case 'running':
      return 'processing';
    case 'canceled':
    case 'pending':
    default:
      return 'default';
  }
};

/** `tools.status.*` uses the legacy tool-group wording for the same states; a refused call did not run. */
const statusLabelKey = (status: NormalizedToolStatus, denied?: boolean): string =>
  denied ? 'denied' : status === 'running' ? 'executing' : status === 'completed' ? 'success' : status;

/** "read src/a.ts", "bash npm test": what the reader sees on a folded line. */
const labelText = ({ verb, target }: ToolLabel): string => (target ? `${verb} ${target}` : verb);

/**
 * What a call ran on, whole on hover. A path cut for a narrow row gives up the middle of its folders, never its own
 * name: `/Users/me/project/src/…/index.ts`, not `/Users/me/project/src/comp…`.
 */
const CallTarget: React.FC<{ label: ToolLabel }> = ({ label }) => {
  const { target } = label;
  if (!target) return null;
  if (!label.path)
    return (
      <code className={styles.callPreview} title={target}>
        {target}
      </code>
    );
  const cut = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')) + 1;
  return (
    <code className={`${styles.callPreview} ${styles.pathPreview}`} title={target} data-testid='tool-call-path'>
      <span className={styles.pathHead}>{target.slice(0, cut)}</span>
      <span className={styles.pathTail}>{target.slice(cut)}</span>
    </code>
  );
};

const ClippedOutput: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const clip = useMemo(() => clipOutput(text), [text]);
  if (!clip.clipped) return <pre className={styles.detailContent}>{text}</pre>;
  return (
    <>
      <pre className={styles.detailContent}>{full ? text : `${clip.text}\n…`}</pre>
      <Button className={styles.moreButton} type='text' size='mini' onClick={() => setFull((value) => !value)}>
        {t(full ? 'tools.execution.showLess' : 'tools.execution.showMore')}
      </Button>
    </>
  );
};

const ToolItemDetail: React.FC<{ item: NormalizedToolCall }> = ({ item }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [fullItem, setFullItem] = useState<NormalizedToolCall | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const displayItem = fullItem ?? item;
  const label = toolLabel(displayItem);
  const statusKey = statusLabelKey(item.status, item.denied);
  // A refused call's output is mu's refusal, written for the model: the row says what happened instead.
  const output = item.denied ? undefined : displayItem.output;
  const hasDetail = Boolean(displayItem.input || output || item.truncated || item.imagePath);
  const [messageApi, messageContext] = Message.useMessage();
  const handleDownloadImage = useCallback(
    async (path: string) => {
      try {
        await downloadFileFromPath(path, getAcpImageFileName(path));
        messageApi.success(t('acp.image.download_success'));
      } catch (error) {
        console.error('[MessageToolGroupSummary] Failed to download image:', error);
        messageApi.error(t('acp.image.download_error'));
      }
    },
    [messageApi, t]
  );

  const loadFullItem = async () => {
    if (!item.truncated || fullItem || loadingFull || !item.conversationId || !item.messageId) return;
    setLoadingFull(true);
    setLoadError(false);
    try {
      const message = await ipcBridge.database.getConversationMessage.invoke({
        conversation_id: item.conversationId,
        message_id: item.messageId,
      });
      const next = normalizeToolMessages([message as ToolMessage]).find((candidate) => candidate.key === item.key);
      if (next) setFullItem(next);
    } catch {
      setLoadError(true);
    } finally {
      setLoadingFull(false);
    }
  };

  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded) void loadFullItem();
  };

  const line = (
    <>
      <Badge
        status={statusToBadge(item.status, item.denied)}
        className={item.status === 'running' ? styles.breathing : undefined}
      />
      <ToolKindIcon name={displayItem.name} />
      <span className={styles.callName}>{label.verb}</span>
      <CallTarget label={label} />
    </>
  );

  // A native conversation's end-to-end tests read each call by pi's tool name and how it stands.
  const native = useMessageListRun() !== undefined;
  return (
    <div
      className={styles.call}
      {...(native
        ? {
            'data-testid': 'native-tool-call',
            'data-tool': item.name,
            'data-status': item.denied ? 'denied' : item.status,
          }
        : {})}
    >
      {messageContext}
      {displayItem.hive ? (
        <>
          <HiveToolCard
            data={displayItem.hive}
            conversationId={item.conversationId}
            runId={item.key}
            status={item.status}
          />
          {hasDetail && (
            <Button type='text' size='mini' aria-expanded={expanded} onClick={toggleExpanded}>
              {t('common.kyrn.hiveView.raw')}
            </Button>
          )}
        </>
      ) : hasDetail ? (
        <Button
          className={styles.callButton}
          type='text'
          size='mini'
          aria-label={t('tools.execution.callAria', { name: displayItem.name, status: t(`tools.status.${statusKey}`) })}
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          {line}
          {expanded ? <Down size={12} /> : <Right size={12} />}
        </Button>
      ) : (
        <div className={styles.callStatic}>{line}</div>
      )}
      {/* A failure says what went wrong without asking for a click; a refused call, quietly, that it did not run. */}
      {item.denied && (
        <div className={styles.callDenied} data-testid='tool-call-denied'>
          {t('tools.execution.denied')}
        </div>
      )}
      {!item.denied && item.status === 'error' && !expanded && !displayItem.hive && (
        <div className={styles.callError}>{toolErrorLine(displayItem)}</div>
      )}
      {expanded && hasDetail && (
        <div className={styles.detailPanel}>
          {loadingFull && <div className={styles.detailLabel}>{t('tools.execution.loading')}</div>}
          {loadError && (
            <div className={styles.loadError}>
              <span>{t('tools.execution.loadError')}</span>
              <Button type='text' size='mini' onClick={() => void loadFullItem()}>
                {t('tools.execution.retry')}
              </Button>
            </div>
          )}
          {displayItem.input && (
            <div className={styles.detailSection}>
              <div className={styles.detailLabel}>{t('tools.execution.input')}</div>
              <ClippedOutput text={displayItem.input} />
            </div>
          )}
          {output && (
            <div className={styles.detailSection}>
              <div className={styles.detailLabel}>{t('tools.execution.output')}</div>
              <ClippedOutput text={swarmProgressText(t, displayItem.swarmProgress, output)} />
            </div>
          )}
        </div>
      )}
      {item.imagePath && (
        <div className={styles.imagePreview}>
          <LocalImageView
            src={item.imagePath}
            alt={getAcpImageFileName(item.imagePath)}
            className='max-w-full max-h-320px object-contain rounded'
          />
          <Tooltip content={t('acp.image.download')}>
            <Button
              aria-label={t('acp.image.download_aria')}
              className={styles.downloadImage}
              type='secondary'
              size='mini'
              shape='circle'
              icon={<Download theme='outline' size='14' />}
              onClick={() => void handleDownloadImage(item.imagePath)}
            />
          </Tooltip>
        </div>
      )}
    </div>
  );
};

const ToolRows: React.FC<{ tools: NormalizedToolCall[] }> = ({ tools }) => (
  <>
    {tools.map((item) => (
      <ToolItemDetail key={item.key} item={item} />
    ))}
  </>
);

/**
 * A run of tool calls folded into one line: how many steps ran, and what is running right now. It opens in place to
 * the calls themselves and stays closed when the turn ends, so a finished reply reads as a reply. Failures never fold
 * away — each failed step keeps its own line under the closed header.
 */
const ToolActivityGroup: React.FC<{ tools: NormalizedToolCall[]; language?: string | null }> = ({
  tools,
  language,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => summarizeToolActivity(tools), [tools]);
  const errors = useMemo(() => toolActivityErrors(tools), [tools]);
  const refused = useMemo(() => toolActivityDenied(tools), [tools]);
  const steps = formatNumber(summary.steps, language);
  const headline =
    summary.status === 'running'
      ? t('tools.activity.running', { steps, label: summary.running ? labelText(summary.running) : '' })
      : summary.failed > 0
        ? t('tools.activity.summaryFailed', { steps, failed: formatNumber(summary.failed, language) })
        : t('tools.activity.summary', { steps });

  return (
    <div className={styles.activity} data-testid='tool-activity-group'>
      <Button
        className={styles.activityHeader}
        type='text'
        size='mini'
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Badge
          status={summary.status === 'running' ? 'processing' : summary.failed > 0 ? 'error' : 'default'}
          className={summary.status === 'running' ? styles.breathing : undefined}
        />
        <span className={styles.activitySummary}>{headline}</span>
        {expanded ? <Down size={12} /> : <Right size={12} />}
      </Button>
      {!expanded &&
        errors.map((error) => (
          <div key={error.key} className={styles.activityError} data-testid='tool-activity-error'>
            <span className={styles.callName}>{error.label.verb}</span>
            <span className={styles.activityErrorLine}>{error.line}</span>
          </div>
        ))}
      {!expanded &&
        refused.map((call) => (
          <div key={call.key} className={styles.activityError} data-testid='tool-activity-denied'>
            <span className={styles.callName}>{call.label.verb}</span>
            <span className={styles.activityDeniedLine}>
              {call.label.target ? `${call.label.target} · ` : ''}
              {t('tools.execution.denied')}
            </span>
          </div>
        ))}
      {expanded && (
        <div className={styles.activityBody}>
          <ToolRows tools={tools} />
        </div>
      )}
    </div>
  );
};

/**
 * The tools a stretch of the reply ran. One call is its own quiet line; several fold into one activity line that
 * opens to them (user, 2026-09-22: a "tool activity" header over a single call was one box too many).
 *
 * A stored "running" is not proof of activity: only a conversation that is processing runs anything (`live`), and a
 * call already seen running while it was idle (`stale`, by message id) belongs to a turn that ended without it, as
 * when mu's process closed mid-call. Those read as over, a sub-agent card with them.
 */
const MessageToolGroupSummary: React.FC<{
  messages: ToolMessage[];
  live?: boolean;
  stale?: ReadonlySet<string>;
}> = ({ messages, live = true, stale }) => {
  const { t, i18n } = useTranslation();
  const tools = useMemo(() => {
    const calls = normalizeToolMessages(messages);
    for (const call of calls) {
      const over = !live || (call.messageId !== undefined && stale?.has(call.messageId));
      if (over && (call.status === 'running' || call.status === 'pending')) call.status = 'canceled';
    }
    return calls;
  }, [messages, live, stale]);
  if (!tools.length) return null;
  // A sub-agent run is its own panel, never a step in a fold.
  const folds = shouldFoldActivity(tools) && !tools.some((item) => item.hive);
  return (
    <div className={styles.summary} role='group' aria-label={t('tools.execution.title')}>
      {folds ? <ToolActivityGroup tools={tools} language={i18n?.language} /> : <ToolRows tools={tools} />}
    </div>
  );
};

export default React.memo(MessageToolGroupSummary);
