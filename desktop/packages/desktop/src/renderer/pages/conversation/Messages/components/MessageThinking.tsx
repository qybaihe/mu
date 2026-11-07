/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageThinking } from '@/common/chat/chatLib';
import { formatDuration } from '@/renderer/services/i18n/format';
import { Button, Spin } from '@arco-design/web-react';
import { Brain, Right } from '@icon-park/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './MessageThinking.module.css';

type MessageThinkingProps = {
  message: IMessageThinking;
  /**
   * Whether this is the conversation's live thought. A stored `thinking` status is not proof of
   * activity (cancelled turns and reloaded history keep it), so the list decides. Standalone use
   * falls back to the status.
   */
  active?: boolean;
  /** Controlled disclosure. Omit to let the row keep its own state. */
  expanded?: boolean;
  onExpandedChange?: (messageId: string, expanded: boolean) => void;
};

type ThoughtHistoryProps = {
  messages: IMessageThinking[];
};

/** A thinking span in whole seconds, in the app language ("1m 5s", "1分钟5秒"). */
const formatThinkingTime = (ms: number, language: string | undefined): string =>
  formatDuration(Math.floor(ms / 1000) * 1000, language, 'narrow');

const elapsedSeconds = (startedAt: number): number => Math.max(0, Math.floor((Date.now() - startedAt) / 1000));

/**
 * The newest stretch of a thought, for the one quiet line that streams under the header. Only the tail is shown: it
 * is where the model is now, and a fixed window means the row never grows as the thought does.
 */
export const THOUGHT_TAIL_CHARS = 120;

export function thoughtTail(text: string, limit = THOUGHT_TAIL_CHARS): string {
  const value = text.replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  const tail = value.slice(value.length - limit);
  const space = tail.indexOf(' ');
  // Cut on a word where there is one within reach, so the line does not open mid-word.
  return `…${space > 0 && space < 24 ? tail.slice(space + 1) : tail}`;
}

/** How long a run of thoughts took altogether; undefined while none of them reported a duration. */
export function totalThinkingTime(messages: IMessageThinking[]): number | undefined {
  const total = messages.reduce((sum, message) => sum + (message.content.duration ?? 0), 0);
  return total > 0 ? total : undefined;
}

const ThoughtHistory: React.FC<ThoughtHistoryProps> = ({ messages }) => {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const [expanded, setExpanded] = useState(false);
  const bodyId = `thinking-history-${messages[0]?.id ?? 'empty'}`;
  const total = totalThinkingTime(messages);

  if (messages.length === 0) {
    return null;
  }

  return (
    <div className={styles.container} data-testid='thinking-history'>
      <Button
        aria-controls={bodyId}
        aria-expanded={expanded}
        className={styles.header}
        size='mini'
        type='text'
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.headerIcon}>
          <Brain theme='outline' size='14' />
        </span>
        <span className={styles.summary}>
          {total === undefined
            ? t('conversation.thinking.history', { defaultValue: 'Thinking history' })
            : t('conversation.thinking.thoughtFor', { time: formatThinkingTime(total, language) })}
        </span>
        <span className={`${styles.arrow} ${expanded ? styles.arrowExpanded : ''}`}>
          <Right theme='outline' size='12' />
        </span>
      </Button>
      {expanded && (
        <div id={bodyId} className={styles.body}>
          {messages.map((message) => {
            // A thought that never reported completion (cancelled, failed or reloaded turn) is a
            // record, not live work: it must not read as "Thinking…" here.
            const status =
              message.content.status === 'done'
                ? t('conversation.thinking.completeWithTime', {
                    time: formatThinkingTime(message.content.duration ?? 0, language),
                  })
                : message.content.subject;
            return (
              <div key={message.id} className={styles.historyEntry}>
                {status && <div className={styles.historyStatus}>{status}</div>}
                {message.content.content}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/**
 * One thought. While it is the live one it reads as a quiet line of muted text that keeps moving — its newest words,
 * in a window two lines tall, so the row never grows with the thought. Once the reply starts it folds to a single
 * line ("thought for 12s"), which a click opens to the whole thing.
 */
const MessageThinking: React.FC<MessageThinkingProps> = ({ message, active, expanded, onExpandedChange }) => {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const { content: text, status, subject } = message.content;
  const duration = message.content.duration ?? (message.content as { duration_ms?: number }).duration_ms;
  const isDone = status === 'done';
  const isActive = active ?? !isDone;
  // One line by default, live or not: the body opens only when the reader asks for it, and then
  // stays open through completion or cancellation instead of collapsing under them.
  const [localExpanded, setLocalExpanded] = useState(false);
  const isExpanded = expanded ?? localExpanded;
  const startedAt = message.created_at ?? Date.now();
  const [elapsedTime, setElapsedTime] = useState(() => (isActive ? elapsedSeconds(startedAt) : 0));
  const startTimeRef = useRef<number>(startedAt);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tail = useMemo(() => (isActive && !isExpanded ? thoughtTail(text ?? '') : ''), [isActive, isExpanded, text]);

  // Elapsed timer for the live thought only; a leftover `thinking` status must not keep counting.
  useEffect(() => {
    if (!isActive) return;

    startTimeRef.current = message.created_at ?? Date.now();
    setElapsedTime(elapsedSeconds(startTimeRef.current));
    const timer = setInterval(() => {
      setElapsedTime(elapsedSeconds(startTimeRef.current));
    }, 1000);

    return () => clearInterval(timer);
  }, [isActive, message.created_at, message.msg_id]);

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    if (isActive && isExpanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, isActive, isExpanded]);

  const toggleExpanded = () => {
    const next = !isExpanded;
    if (expanded === undefined) setLocalExpanded(next);
    onExpandedChange?.(message.id, next);
  };

  const summaryText = isActive
    ? t('conversation.thinking.labelWithTime', {
        label: subject || t('conversation.thinking.label', { defaultValue: 'Thinking...' }),
        time: formatThinkingTime(elapsedTime * 1000, language),
      })
    : duration
      ? t('conversation.thinking.thoughtFor', { time: formatThinkingTime(duration, language) })
      : t('conversation.thinking.history', { defaultValue: 'Thinking history' });
  const bodyId = `thinking-${message.id}`;

  return (
    <div className={styles.container} data-testid={isActive ? 'thinking-active' : 'thinking-record'}>
      <Button
        aria-controls={bodyId}
        aria-expanded={isExpanded}
        className={styles.header}
        size='mini'
        type='text'
        onClick={toggleExpanded}
      >
        <span className={styles.headerIcon}>{isActive ? <Spin size={12} /> : <Brain theme='outline' size='14' />}</span>
        <span className={styles.summary}>{summaryText}</span>
        <span className={`${styles.arrow} ${isExpanded ? styles.arrowExpanded : ''}`}>
          <Right theme='outline' size='12' />
        </span>
      </Button>
      {tail && (
        <div className={styles.stream} data-testid='thinking-stream' aria-hidden='true'>
          {tail}
        </div>
      )}
      {isExpanded && (
        <div ref={bodyRef} id={bodyId} className={styles.body}>
          {isDone && (
            <div className={styles.historyStatus}>
              {t('conversation.thinking.completeWithTime', { time: formatThinkingTime(duration || 0, language) })}
            </div>
          )}
          {text}
        </div>
      )}
    </div>
  );
};

export { ThoughtHistory };
export default MessageThinking;
