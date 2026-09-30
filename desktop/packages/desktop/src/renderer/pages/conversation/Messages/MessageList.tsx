/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IConversationArtifact } from '@/common/adapter/ipcBridge';
import type {
  IMessageAcpToolCall,
  IMessageThinking,
  IMessageToolCall,
  IMessageToolGroup,
  TMessage,
} from '@/common/chat/chatLib';
import { hasRunningToolMessages } from '@/common/chat/normalizeToolCall';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { getChatSurfaceWidthClass } from '@/renderer/pages/conversation/utils/chatSurfaceWidth';
import { iconColors } from '@/renderer/styles/colors';
import { CHAT_MESSAGE_JUMP_EVENT, type ChatMessageJumpDetail } from '@/renderer/utils/chat/chatMinimapEvents';
import { collectAiCopyRows, type TurnCopyItem } from '@/renderer/utils/chat/turnCopy';
import { Image } from '@arco-design/web-react';
import { Down } from '@icon-park/react';
import MessageAcpPermission from '@renderer/pages/conversation/Messages/acp/MessageAcpPermission';
import MessageQuestion from './MessageQuestion';
import MessagePermission from './components/MessagePermission';
import MessageAcpTerminalOutput from '@renderer/pages/conversation/Messages/acp/MessageAcpTerminalOutput';
import MessageAcpToolCall from '@renderer/pages/conversation/Messages/acp/MessageAcpToolCall';
import MessageJevLine from '@renderer/pages/conversation/Messages/acp/MessageJevLine';
import { jevLine } from '@renderer/pages/conversation/Messages/acp/jevLine';
import MessageMuNotice from '@renderer/pages/conversation/Messages/acp/MessageMuNotice';
import { muNotice } from '@renderer/pages/conversation/Messages/acp/muNotice';
import { questionsBeforeCalls } from './permissionOrder';
import classNames from 'classnames';
import React, { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { uuid } from '@renderer/utils/common';
import './messages.css';
import HOC from '@renderer/utils/ui/HOC';
import type { FileChangeInfo } from './MessageFileChanges';
import MessageFileChanges, { parseDiff } from './MessageFileChanges';
import { useConversationArtifacts } from './artifacts';
import { MessageAnchorRail } from './anchorRail';
import {
  useLoadAnchorMessageWindow,
  useLoadPreviousMessagePage,
  useMessageList,
  useMessageListLoading,
  useMessageListRun,
  useMessagePaginationState,
} from './hooks';
import MessageAgentStatus from './components/MessageAgentStatus';
import MessageTips from './components/MessageTips';
import MessageToolCall from './components/MessageToolCall';
import MessageToolGroup from './components/MessageToolGroup';
import MessageToolGroupSummary from './components/MessageToolGroupSummary';
import MessageCronTrigger from './components/MessageCronTrigger';
import MessageSkillSuggest from './components/MessageSkillSuggest';
import MessageText from './components/MessageText';
import MessageThinking, { ThoughtHistory } from './components/MessageThinking';
import type { WriteFileResult } from './types';
import { useAutoScroll } from './useAutoScroll';
import { useCoalescedMessages } from './useCoalescedMessages';
import SelectionReplyButton from './components/SelectionReplyButton';

type IMessageVO =
  | TMessage
  | {
      type: 'file_summary';
      id: string;
      diffs: FileChangeInfo[];
      sourceMessageIds: string[];
      /** The rows the diffs were read from — used only to tell an unchanged summary from a rebuilt one. */
      sources: TMessage[];
      created_at: number;
    }
  | {
      type: 'tool_summary';
      id: string;
      messages: Array<IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall>;
      sourceMessageIds: string[];
      created_at: number;
    };
type IArtifactVO = { type: 'artifact'; id: string; artifact: IConversationArtifact; created_at: number };
type IThoughtHistoryVO = {
  type: 'thinking_history';
  id: string;
  messages: IMessageThinking[];
  sourceMessageIds: string[];
  created_at: number;
};
type IProcessedItem = IMessageVO | IArtifactVO | IThoughtHistoryVO;

type CompactAcpToolCallContent = IMessageAcpToolCall['content'] & {
  _compact?: {
    truncated?: boolean;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasRenderableAcpDiff = (message: IMessageAcpToolCall): boolean => {
  const content = message.content as CompactAcpToolCallContent | undefined;
  if (!content?.update) return false;

  // Compact history may truncate either side of a diff, making its line counts unreliable.
  if (content._compact?.truncated === true) return false;

  const updateContent: unknown = content.update.content;
  if (!Array.isArray(updateContent)) return false;

  const contentItems = updateContent.filter(isRecord);
  if (contentItems.length !== updateContent.length) return false;

  const diffItems = contentItems.filter((item) => item.type === 'diff');
  return (
    diffItems.length > 0 &&
    diffItems.every(
      (item) =>
        typeof item.path === 'string' &&
        item.path.trim().length > 0 &&
        (typeof item.old_text === 'string' || typeof item.new_text === 'string')
    )
  );
};

const isWriteFileResult = (value: unknown): value is WriteFileResult =>
  isRecord(value) &&
  'file_diff' in value &&
  typeof value.file_diff === 'string' &&
  value.file_diff.length > 0 &&
  'file_name' in value &&
  typeof value.file_name === 'string';

type ConversationLocationState = {
  targetMessageId?: string;
  fromConversationSearch?: boolean;
};

const getProcessedItemSourceMessageIds = (item: IProcessedItem): string[] => {
  if ('type' in item && item.type === 'artifact') {
    return [item.id];
  }
  if ('type' in item && item.type === 'tool_summary') {
    return item.sourceMessageIds;
  }
  if ('type' in item && item.type === 'thinking_history') {
    return item.sourceMessageIds;
  }
  if ('type' in item && item.type === 'file_summary') {
    return item.sourceMessageIds;
  }
  return 'id' in item ? [item.id] : [];
};

const matchesTargetMessage = (item: IProcessedItem, targetMessageId?: string): boolean => {
  if (!targetMessageId) {
    return false;
  }
  return getProcessedItemSourceMessageIds(item).includes(targetMessageId);
};

const getProcessedItemAnchorId = (item: IProcessedItem): string => {
  const sourceIds = getProcessedItemSourceMessageIds(item);
  return sourceIds[0] || ('id' in item ? item.id : uuid());
};

/**
 * React identity of a row. A thought history is keyed by its turn, not by its first listed thought:
 * that one changes as thoughts complete, and re-keying would remount the disclosure and close it.
 */
const getProcessedItemKey = (item: IProcessedItem): string =>
  'type' in item && item.type === 'thinking_history' ? item.id : getProcessedItemAnchorId(item);

/**
 * The reader's place while a native conversation draws the rows before the ones on screen: the row that was first, and
 * where it was from the top of the list. The rows push it down, and their content grows after they are drawn (a
 * message's text is rendered in a second pass), so the list puts the row back to where it was for as long as they
 * keep growing (`KEEP_PLACE_MS` after they were drawn), until the reader scrolls.
 */
type KeptPlace = {
  scroller: HTMLDivElement;
  /** The DOM id of the row that was first: the rows are drawn when another row is first. */
  anchor: string;
  /** Where that row was, from the top of the list, when the rows were asked for. */
  offset: number;
  /** The list's height when the rows were asked for. */
  height: number;
  at: number;
  /** When the rows were drawn. */
  drawnAt?: number;
  /** The anchor was gone when the rows were drawn, and the list was put back by its growth instead. */
  approximated?: boolean;
};

const KEEP_PLACE_MS = 1500;
/** How long the rows asked for may take to be drawn before the request is forgotten. */
const EARLIER_ROWS_MS = 2000;

/** The grouped rows are memoised so an unchanged group is not redrawn when another row streams. */
const ThoughtHistoryRow = React.memo(ThoughtHistory);
const FileChangesRow = React.memo(MessageFileChanges);

const sameRefs = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * The grouped rows — a run of tool calls, a turn's thoughts, a set of file changes — are rebuilt on every chunk of a
 * streamed reply, and a rebuilt group is a new object even when nothing in it moved. Handing React the previous
 * object instead lets those rows stand still while another row streams.
 */
const reuseUnchangedGroups = (previous: Map<string, IProcessedItem>, items: IProcessedItem[]): IProcessedItem[] =>
  items.map((item) => {
    if (!('type' in item)) return item;
    const before = previous.get(item.id);
    if (!before || before === item || !('type' in before) || before.type !== item.type) return item;
    if (item.type === 'tool_summary' && before.type === 'tool_summary' && sameRefs(item.messages, before.messages)) {
      return before;
    }
    if (
      item.type === 'thinking_history' &&
      before.type === 'thinking_history' &&
      sameRefs(item.messages, before.messages)
    ) {
      return before;
    }
    if (item.type === 'file_summary' && before.type === 'file_summary' && sameRefs(item.sources, before.sources)) {
      return before;
    }
    return item;
  });

const getProcessedItemCreatedAt = (item: IProcessedItem): number => {
  if ('type' in item && ['file_summary', 'tool_summary', 'thinking_history', 'artifact'].includes(item.type)) {
    return item.created_at;
  }
  return item.created_at ?? 0;
};

const isToolMessage = (message: TMessage): message is IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall =>
  message.type === 'tool_group' || message.type === 'acp_tool_call' || message.type === 'tool_call';

/** Rows that never render, so they cannot stand between a thought and the end of the list. */
const isUnrenderedRow = (message: TMessage): boolean =>
  message.hidden === true || message.type === 'available_commands' || message.type === 'plan';

/**
 * The one thought allowed to show as live. A stored `thinking` status is not proof of activity: a
 * cancelled or failed turn, a missed completion frame and reloaded history all leave it behind.
 * Only the last rendered row of a conversation that is processing right now qualifies, and never a
 * thought that was already lying there while the conversation was known to be idle.
 */
const resolveActiveThinkingId = (
  list: TMessage[],
  isProcessing: boolean,
  staleThoughtIds: ReadonlySet<string>
): string | undefined => {
  if (!isProcessing) return undefined;
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index];
    if (isUnrenderedRow(message)) continue;
    if (message.type !== 'thinking' || message.content.status !== 'thinking') return undefined;
    return staleThoughtIds.has(message.id) ? undefined : message.id;
  }
  return undefined;
};

const highlightStyle: React.CSSProperties = {
  backgroundColor: 'var(--color-aou-1)',
  boxShadow: '0 0 0 1px var(--color-aou-6-brand) inset',
  borderRadius: '12px',
};

const getUnhandledMessageType = (_message: never): string => 'unknown';

/**
 * A row's test id. A native conversation's list names the person's and mu's messages as its end-to-end tests read
 * them; every other list keeps the generic ids.
 */
const rowTestId = (message: TMessage, native: boolean): string => {
  if (native && message.type === 'text' && message.position === 'right') return 'native-message-user';
  if (native && message.type === 'text' && message.position === 'left') return 'native-message-assistant';
  return `message-${message.type}-${message.position}`;
};

// Image preview context
export const ImagePreviewContext = createContext<{ inPreviewGroup: boolean }>({ inPreviewGroup: false });

const MessageListSkeleton: React.FC<{ rowWidthClass: string }> = ({ rowWidthClass }) => {
  const rows = [
    { align: 'left', bubbleWidth: '100%', lines: [72, 58, 64] },
    { align: 'right', bubbleWidth: '82%', lines: [54, 48] },
    { align: 'left', bubbleWidth: '100%', lines: [68, 76, 44] },
    { align: 'left', bubbleWidth: '100%', lines: [46, 52] },
    { align: 'right', bubbleWidth: '78%', lines: [60, 42, 36] },
    { align: 'left', bubbleWidth: '100%', lines: [74, 62] },
    { align: 'right', bubbleWidth: '84%', lines: [52, 66] },
    { align: 'left', bubbleWidth: '100%', lines: [64, 56, 40] },
    { align: 'right', bubbleWidth: '80%', lines: [58, 46] },
  ] as const;

  return (
    <div
      className='flex-1 h-full overflow-y-auto pb-10px box-border'
      data-testid='message-list-skeleton'
      style={{ minHeight: '100%' }}
    >
      <div className='min-h-full flex flex-col justify-between py-10px box-border'>
        {rows.map((row, index) => (
          <div
            key={index}
            className={classNames(`${rowWidthClass} min-w-0 flex items-start message-item px-8px m-t-10px`, {
              'justify-start': row.align === 'left',
              'justify-end': row.align === 'right',
            })}
          >
            <div
              className='flex-none min-w-0 rd-16px p-14px'
              style={{
                width: row.bubbleWidth,
                maxWidth: '100%',
                background: 'var(--color-fill-1)',
                border: '1px solid var(--color-border-2)',
              }}
            >
              <div className='flex flex-col gap-10px'>
                {row.lines.map((width, lineIndex) => (
                  <div
                    key={lineIndex}
                    className='h-12px rd-999px'
                    style={{
                      width: `${width}%`,
                      background:
                        'linear-gradient(90deg, var(--color-fill-2) 0%, var(--color-fill-3) 50%, var(--color-fill-2) 100%)',
                      backgroundSize: '200% 100%',
                      animation: 'message-list-skeleton-shimmer 1.4s ease-in-out infinite',
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      <style>{`
        @keyframes message-list-skeleton-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
};

type ThoughtExpandedChange = (messageId: string, expanded: boolean) => void;

const MessageItem: React.FC<{
  message: TMessage;
  highlighted?: boolean;
  rowWidthClass: string;
  showCopyRow?: boolean;
  isLastMessage?: boolean;
  hasForkAnchor?: boolean;
  turnTexts?: string[];
  thinkingActive?: boolean;
  thinkingExpanded?: boolean;
  onThinkingExpandedChange?: ThoughtExpandedChange;
}> = React.memo(
  HOC((props) => {
    const { message, highlighted, rowWidthClass } = props as {
      message: TMessage;
      highlighted?: boolean;
      rowWidthClass: string;
    };
    const native = useMessageListRun() !== undefined;
    return (
      <div
        id={`message-${message.id}`}
        data-testid={rowTestId(message, native)}
        data-message-type={message.type}
        data-message-position={message.position}
        className={classNames(
          `${rowWidthClass} min-w-0 flex items-start message-item [&>div]:max-w-full px-8px m-t-10px`,
          message.type,
          {
            'justify-center': message.position === 'center',
            'justify-end': message.position === 'right',
            'justify-start': message.position === 'left',
          }
        )}
        style={highlighted ? highlightStyle : undefined}
      >
        {props.children}
      </div>
    );
  })(
    ({
      message,
      showCopyRow,
      isLastMessage,
      hasForkAnchor,
      turnTexts,
      thinkingActive,
      thinkingExpanded,
      onThinkingExpandedChange,
    }: {
      message: TMessage;
      highlighted?: boolean;
      rowWidthClass: string;
      showCopyRow?: boolean;
      isLastMessage?: boolean;
      hasForkAnchor?: boolean;
      turnTexts?: string[];
      thinkingActive?: boolean;
      thinkingExpanded?: boolean;
      onThinkingExpandedChange?: ThoughtExpandedChange;
    }) => {
      const { t } = useTranslation();
      switch (message.type) {
        case 'text':
          return (
            <MessageText
              message={message}
              showCopyRow={showCopyRow}
              isLastMessage={isLastMessage}
              hasForkAnchor={hasForkAnchor}
              turnTexts={turnTexts}
            ></MessageText>
          );
        case 'tips':
          return <MessageTips message={message}></MessageTips>;
        case 'tool_call':
          return <MessageToolCall message={message}></MessageToolCall>;
        case 'tool_group':
          return <MessageToolGroup message={message}></MessageToolGroup>;
        case 'agent_status':
          return <MessageAgentStatus message={message}></MessageAgentStatus>;
        case 'permission':
          return <MessagePermission message={message}></MessagePermission>;
        case 'acp_permission':
          return <MessageAcpPermission message={message}></MessageAcpPermission>;
        case 'ask':
          return <MessageQuestion message={message}></MessageQuestion>;
        case 'acp_tool_call': {
          const jev = jevLine(message);
          if (jev) return <MessageJevLine line={jev} />;
          const notice = muNotice(message);
          return notice ? (
            <MessageMuNotice notice={notice} />
          ) : (
            <MessageAcpToolCall message={message}></MessageAcpToolCall>
          );
        }
        case 'acp_terminal_output':
          return <MessageAcpTerminalOutput message={message}></MessageAcpTerminalOutput>;
        case 'thinking':
          return (
            <MessageThinking
              message={message}
              active={thinkingActive}
              expanded={thinkingExpanded}
              onExpandedChange={onThinkingExpandedChange}
            ></MessageThinking>
          );
        // Both are filtered out of `processedList` above and never reach this
        // switch. These arms exist only to keep the `default` branch's
        // exhaustiveness check (`getUnhandledMessageType`) satisfied — a plan
        // renders in ConversationPlanBar, not as a stream row.
        case 'available_commands':
        case 'plan':
          return null;
        default:
          return <div>{t('messages.unknownMessageType', { type: getUnhandledMessageType(message) })}</div>;
      }
    }
  ),
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.position === next.message.position &&
    prev.message.type === next.message.type &&
    prev.highlighted === next.highlighted &&
    prev.rowWidthClass === next.rowWidthClass &&
    prev.showCopyRow === next.showCopyRow &&
    prev.isLastMessage === next.isLastMessage &&
    prev.hasForkAnchor === next.hasForkAnchor &&
    prev.thinkingActive === next.thinkingActive &&
    prev.thinkingExpanded === next.thinkingExpanded &&
    prev.onThinkingExpandedChange === next.onThinkingExpandedChange &&
    // Compare by content: the map is rebuilt per render, so reference equality
    // would defeat the memo for the one row that carries the copy button.
    (prev.turnTexts === next.turnTexts ||
      (prev.turnTexts?.length === next.turnTexts?.length &&
        (prev.turnTexts ?? []).every((segment, i) => segment === next.turnTexts?.[i])))
);

const MessageList: React.FC<{
  className?: string;
  emptySlot?: React.ReactNode;
  /** Shown above the first message once the list reaches it, e.g. where an imported conversation came from. */
  headerSlot?: React.ReactNode;
}> = ({ emptySlot, headerSlot }) => {
  // At most one redraw a frame while a reply streams; a new or removed row still lands at once.
  const list = useCoalescedMessages(useMessageList());
  const isMessageListLoading = useMessageListLoading();
  const pagination = useMessagePaginationState();
  const artifacts = useConversationArtifacts();
  const conversationContext = useConversationContextSafe();
  // A native conversation's list: its host says whether a run goes, and AionCore has no pages of it.
  const run = useMessageListRun();
  const conversationId = run ? run.conversationId : conversationContext?.conversation_id;
  const rowWidthClass = getChatSurfaceWidthClass();
  const loadPreviousMessagePage = useLoadPreviousMessagePage(run ? undefined : conversationId);
  const loadAnchorMessageWindow = useLoadAnchorMessageWindow(run ? undefined : conversationId);
  // While the agent is still streaming, the in-progress turn's last text keeps
  // moving down, so we defer its copy/timestamp row until the turn finishes to
  // avoid the row flashing in and the layout reflowing mid-stream.
  const runtime = useConversationRuntimeView(run ? '' : (conversationId ?? ''));
  const { isProcessing, hydrated } = run ?? runtime;
  const { t } = useTranslation();
  const location = useLocation();
  const locationState = (location.state || {}) as ConversationLocationState;
  const targetMessageId = locationState.targetMessageId;
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | undefined>();
  const handledTargetKeyRef = useRef<string>('');
  const loadingTargetKeyRef = useRef<string>('');
  const scrollerElementRef = useRef<HTMLDivElement | null>(null);
  // Last render's grouped rows, so a group that did not change keeps the object React already drew.
  const previousItemsRef = useRef<Map<string, IProcessedItem>>(new Map());
  const contentElementRef = useRef<HTMLDivElement | null>(null);
  // Where the reader was when a native conversation was asked for the rows before those drawn (see the scroll handler).
  const keptPlaceRef = useRef<KeptPlace | undefined>(undefined);
  // The rows a native conversation drew above the reader push the reader's rows down: the list is scrolled by as much as
  // the row that was first has moved, in the render that draws them, before the page is painted, and again each time
  // the list's height changes for a moment after (their content is rendered in a second pass), so the reader's place
  // does not move.
  const keepPlace = useCallback((): void => {
    const kept = keptPlaceRef.current;
    if (!kept?.drawnAt) return;
    if (Date.now() - kept.drawnAt > KEEP_PLACE_MS) {
      keptPlaceRef.current = undefined;
      return;
    }
    const anchor = document.getElementById(kept.anchor);
    if (!anchor) {
      // The row is gone: a run of steps it began was extended upwards by the rows drawn, and is named by its new first
      // step. Nothing to measure the reader's row by, so the list goes down by as much as it grew, once.
      if (!kept.approximated) {
        kept.approximated = true;
        kept.scroller.scrollTop += kept.scroller.scrollHeight - kept.height;
      }
      return;
    }
    const shift = anchor.getBoundingClientRect().top - kept.scroller.getBoundingClientRect().top - kept.offset;
    if (Math.abs(shift) >= 1) kept.scroller.scrollTop += shift;
  }, []);
  // Thoughts the reader opened. An opened thought keeps its own row, still open, after it stops
  // being live, so completion or cancellation never collapses what is being read.
  const [openThoughtIds, setOpenThoughtIds] = useState<ReadonlySet<string>>(() => new Set());
  const handleThoughtExpandedChange = useCallback<ThoughtExpandedChange>((messageId, expanded) => {
    setOpenThoughtIds((current) => {
      if (current.has(messageId) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(messageId);
      else next.delete(messageId);
      return next;
    });
  }, []);
  // Thoughts still marked `thinking` while the conversation was known to be idle. They belong to a
  // turn that already ended; the next turn must not revive them before its own rows arrive.
  const staleThoughtIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!hydrated || isProcessing) return;
    for (const message of list) {
      if (message.type === 'thinking' && message.content.status === 'thinking') {
        staleThoughtIdsRef.current.add(message.id);
      }
    }
  }, [hydrated, isProcessing, list]);
  // Calls still marked running while the conversation was known to be idle: their turn ended without their end (mu's
  // process closed mid-call). Like those thoughts, they read as over, and the next turn does not revive them.
  const staleCallIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!hydrated || isProcessing) return;
    for (const message of list) {
      if (isToolMessage(message) && hasRunningToolMessages([message])) staleCallIdsRef.current.add(message.id);
    }
  }, [hydrated, isProcessing, list]);

  // Pre-process message list to group tool outputs into summary cards
  const { items: processedList, activeThinkingId } = useMemo(() => {
    const result: Array<IMessageVO | IThoughtHistoryVO> = [];
    const liveThoughtId = resolveActiveThinkingId(list, isProcessing, staleThoughtIdsRef.current);
    const hasOwnRow = (message: IMessageThinking): boolean =>
      message.id === liveThoughtId || openThoughtIds.has(message.id);
    const thoughtHistoryByAnchor = new Map<string, { id: string; messages: IMessageThinking[] }>();
    let turnThoughts: IMessageThinking[] = [];

    const addTurnThoughtHistory = () => {
      const history = turnThoughts.filter((message) => !hasOwnRow(message));
      if (history.length > 0) {
        // Identified by the turn's first thought, not by whichever thought currently leads the
        // history, so the disclosure keeps its open state while thoughts move in and out of it.
        thoughtHistoryByAnchor.set(history[0].id, {
          id: `thinking-history-${turnThoughts[0].id}`,
          messages: history,
        });
      }
      turnThoughts = [];
    };

    for (const message of list) {
      if (message.type === 'text' && message.position === 'right') {
        addTurnThoughtHistory();
      }
      if (message.type === 'thinking' && !message.hidden) {
        turnThoughts.push(message);
      }
    }
    addTurnThoughtHistory();
    let diffsChanges: FileChangeInfo[] = [];
    let diffsSourceMessageIds: string[] = [];
    let diffsSources: TMessage[] = [];
    let toolList: Array<IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall> = [];
    let toolSourceMessageIds: string[] = [];

    const pushFileDiffChanges = (changes: FileChangeInfo, source: TMessage, created_at: number) => {
      if (!diffsChanges.length) {
        diffsSourceMessageIds = [];
        diffsSources = [];
        result.push({
          type: 'file_summary',
          id: `summary-${source.id}`,
          diffs: diffsChanges,
          sourceMessageIds: diffsSourceMessageIds,
          sources: diffsSources,
          created_at,
        });
      }
      diffsChanges.push(changes);
      diffsSourceMessageIds.push(source.id);
      diffsSources.push(source);
      toolList = [];
      toolSourceMessageIds = [];
    };
    const pushToolList = (message: IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall) => {
      if (!toolList.length) {
        toolSourceMessageIds = [];
        result.push({
          type: 'tool_summary',
          id: `tool-summary-${message.id}`,
          messages: toolList,
          sourceMessageIds: toolSourceMessageIds,
          created_at: message.created_at ?? 0,
        });
      }
      toolList.push(message);
      toolSourceMessageIds.push(message.id);
      diffsChanges = [];
      diffsSourceMessageIds = [];
      diffsSources = [];
    };
    const pushStandaloneMessage = (message: TMessage) => {
      toolList = [];
      toolSourceMessageIds = [];
      diffsChanges = [];
      diffsSourceMessageIds = [];
      diffsSources = [];
      result.push(message);
    };
    const resetGroupedItems = () => {
      toolList = [];
      toolSourceMessageIds = [];
      diffsChanges = [];
      diffsSourceMessageIds = [];
      diffsSources = [];
    };
    // A conversation without a judge says so once, not under every message.
    let saidNoJudge = false;
    // mu's questions read before what came of the calls they ask about.
    const ordered = questionsBeforeCalls(list);

    for (let i = 0, len = ordered.length; i < len; i++) {
      const message = ordered[i];
      // Skip hidden and available_commands messages
      if (message.hidden) continue;
      if (message.type === 'available_commands') continue;
      // A plan renders in ConversationPlanBar, never in the stream. Filtered
      // here rather than rendered as null: a null row still occupies a slot.
      if (message.type === 'plan') continue;
      if (message.type === 'thinking') {
        const history = thoughtHistoryByAnchor.get(message.id);
        if (history) {
          resetGroupedItems();
          result.push({
            type: 'thinking_history',
            id: history.id,
            messages: history.messages,
            sourceMessageIds: history.messages.map((thought) => thought.id),
            created_at: message.created_at ?? 0,
          });
        } else if (hasOwnRow(message)) {
          pushStandaloneMessage(message);
        } else {
          // A history disclosure is anchored at the first thought of its turn;
          // still split adjacent tool summaries at every hidden thought so the
          // original thought-to-tool ordering remains intact.
          resetGroupedItems();
        }
        continue;
      }
      if (message.type === 'tool_group') {
        const writeFileResults = message.content.flatMap((item) =>
          item.name === 'WriteFile' && isWriteFileResult(item.result_display) ? [item.result_display] : []
        );
        if (writeFileResults.length > 0 && writeFileResults.length === message.content.length) {
          writeFileResults.forEach((writeFileResult) => {
            pushFileDiffChanges(
              parseDiff(writeFileResult.file_diff, writeFileResult.file_name),
              message,
              message.created_at ?? 0
            );
          });
          continue;
        }
        pushToolList(message);
        continue;
      }
      if (message.type === 'acp_tool_call') {
        const jev = jevLine(message);
        // A classification switched off or skipped says nothing; a missing judge is said at its first message only.
        if (jev?.stage === 'quiet' || (jev?.stage === 'noJudge' && saidNoJudge)) continue;
        if (jev?.stage === 'noJudge') saidNoJudge = true;
        // Jev's class for the message and the bridge's notices are lines of their own, not calls in the tool box.
        if (hasRenderableAcpDiff(message) || jev || muNotice(message)) {
          pushStandaloneMessage(message);
          continue;
        }
        pushToolList(message);
        continue;
      }
      if (message.type === 'tool_call') {
        pushToolList(message);
        continue;
      }
      pushStandaloneMessage(message);
    }
    const visibleArtifacts = artifacts
      .filter((artifact) => {
        if (artifact.kind === 'cron_trigger') return artifact.status === 'active';
        if (artifact.kind === 'skill_suggest') return artifact.status === 'pending';
        return false;
      })
      .map<IArtifactVO>((artifact) => ({
        type: 'artifact',
        id: artifact.id,
        artifact,
        created_at: artifact.created_at,
      }));

    const items = reuseUnchangedGroups(
      previousItemsRef.current,
      [...result, ...visibleArtifacts].toSorted((a, b) => getProcessedItemCreatedAt(a) - getProcessedItemCreatedAt(b))
    );
    previousItemsRef.current = new Map(items.map((item) => [item.id, item]));
    return { items, activeThinkingId: liveThoughtId };
  }, [artifacts, isProcessing, list, openThoughtIds]);

  // An AI reply can be split into several messages (thinking / multiple text /
  // tool blocks). The hover copy + timestamp row should appear once per turn,
  // after the turn's last text — not under every intermediate text block.
  // Collect the id of the last AI text in each turn; a turn runs until the next
  // user (right) message. Tool/file/artifact items don't end a turn and, per the
  // fallback strategy, the row stays on the turn's last text even when followed
  // by tool blocks. While the conversation is still streaming, the final turn's
  // row is withheld (it would otherwise appear then shift down as more text
  // streams in); earlier, already-finished turns always keep their row.
  const { copyRowIds: aiCopyRowTextIds, turnTextsById: aiTurnTextsById } = useMemo(
    () => collectAiCopyRows(processedList as TurnCopyItem[], isProcessing),
    [processedList, isProcessing]
  );

  // The last REAL message in the visible timeline (pseudo entries like
  // file/tool summaries don't count). HEAD-fork backends (claude/ACP) only
  // show the fork entry point here — see `isForkEnabled`.
  const lastMessageId = useMemo(() => {
    for (let i = processedList.length - 1; i >= 0; i--) {
      const item = processedList[i];
      if (
        'type' in item &&
        (item.type === 'file_summary' ||
          item.type === 'tool_summary' ||
          item.type === 'thinking_history' ||
          item.type === 'artifact')
      ) {
        continue;
      }
      return (item as TMessage).id;
    }
    return undefined;
  }, [processedList]);

  // Mirror of the server's fork-anchor resolution ("nearest backend_turn_id at
  // or before the message"): a message is mid-history forkable once ANY message
  // at-or-before it carries a turn anchor. Legacy/copied rows before the first
  // anchor stay un-forkable and their entry is hidden instead of 422-ing.
  const forkAnchoredIds = useMemo(() => {
    const ids = new Set<string>();
    let seenAnchor = false;
    for (const item of processedList) {
      if (
        'type' in item &&
        (item.type === 'file_summary' ||
          item.type === 'tool_summary' ||
          item.type === 'thinking_history' ||
          item.type === 'artifact')
      ) {
        continue;
      }
      const message = item as TMessage;
      if (message.backend_turn_id) seenAnchor = true;
      if (seenAnchor) ids.add(message.id);
    }
    return ids;
  }, [processedList]);

  // Use auto-scroll hook
  const {
    handleScrollerRef,
    handleContentRef,
    handleScroll,
    handleWheel,
    handlePointerDown,
    showScrollButton,
    scrollToBottom,
    scrollElementIntoView,
    hideScrollButton,
  } = useAutoScroll({
    messages: list,
    itemCount: processedList.length,
    onContentResize: keepPlace,
  });

  const setScrollerRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollerElementRef.current = element;
      handleScrollerRef(element);
    },
    [handleScrollerRef]
  );

  const setContentRef = useCallback(
    (element: HTMLDivElement | null) => {
      contentElementRef.current = element;
      handleContentRef(element);
    },
    [handleContentRef]
  );

  /** Asks for the rows before the first, when the reader is at the top of the list and there are any. */
  const requestEarlier = useCallback(
    (scroller: HTMLDivElement) => {
      if (!pagination.hasMoreBefore || pagination.isLoadingBefore || scroller.scrollTop > 160) {
        return;
      }

      const previousHeight = contentElementRef.current?.scrollHeight ?? 0;
      // A native conversation that shows only its latest rows draws the ones before on request, and they reach this
      // list in a render of their own: the reader's place is kept from that render (below), not from a frame.
      if (run?.loadEarlier) {
        const asked = keptPlaceRef.current;
        if (asked && !asked.drawnAt) return;
        const first = contentElementRef.current?.querySelector<HTMLElement>('[id^="message-"]');
        if (!first) return;
        keptPlaceRef.current = {
          scroller,
          anchor: first.id,
          offset: first.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
          height: scroller.scrollHeight,
          at: Date.now(),
        };
        if (!run.loadEarlier()) keptPlaceRef.current = undefined;
        return;
      }
      void loadPreviousMessagePage().then((loaded) => {
        if (!loaded) return;
        requestAnimationFrame(() => {
          const nextHeight = contentElementRef.current?.scrollHeight ?? previousHeight;
          scroller.scrollTop += nextHeight - previousHeight;
        });
      });
    },
    [loadPreviousMessagePage, pagination.hasMoreBefore, pagination.isLoadingBefore, run?.loadEarlier]
  );

  const handleMessageListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      handleScroll(event);
      requestEarlier(event.currentTarget);
    },
    [handleScroll, requestEarlier]
  );

  useLayoutEffect(() => {
    const kept = keptPlaceRef.current;
    if (!kept) return;
    if (!kept.drawnAt) {
      if (Date.now() - kept.at > EARLIER_ROWS_MS) {
        // The rows never came: forget the request, so a later change is not taken for them.
        keptPlaceRef.current = undefined;
        return;
      }
      const first = contentElementRef.current?.querySelector('[id^="message-"]');
      if (first?.id === kept.anchor) return;
      kept.drawnAt = Date.now();
    }
    keepPlace();
  }, [keepPlace, processedList]);

  // The reader takes over: rows that grow after this are theirs to scroll past.
  const handleListWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (keptPlaceRef.current?.drawnAt) keptPlaceRef.current = undefined;
      // A reader who is already at the top has no scroll to make (the list does not move, so it sends no scroll event):
      // the wheel asks for the rows before, as the scroll would have.
      if (event.deltaY < 0 && event.currentTarget.scrollTop <= 0) requestEarlier(event.currentTarget);
      handleWheel(event);
    },
    [handleWheel, requestEarlier]
  );
  const handleListPointerDown = useCallback(() => {
    if (keptPlaceRef.current?.drawnAt) keptPlaceRef.current = undefined;
    handlePointerDown();
  }, [handlePointerDown]);

  useEffect(() => {
    if (!targetMessageId || processedList.length === 0) {
      return;
    }

    const targetKey = `${location.key}:${targetMessageId}`;
    if (handledTargetKeyRef.current === targetKey) {
      return;
    }

    const targetIndex = processedList.findIndex((item) => matchesTargetMessage(item, targetMessageId));
    if (targetIndex === -1) {
      if (loadingTargetKeyRef.current !== targetKey) {
        loadingTargetKeyRef.current = targetKey;
        void loadAnchorMessageWindow(targetMessageId).then((loaded) => {
          if (!loaded) {
            loadingTargetKeyRef.current = '';
          }
        });
      }
      return;
    }

    handledTargetKeyRef.current = targetKey;
    loadingTargetKeyRef.current = '';
    setHighlightedMessageId(targetMessageId);
    hideScrollButton();

    requestAnimationFrame(() => {
      const targetElement = document.getElementById(`message-${getProcessedItemAnchorId(processedList[targetIndex])}`);
      scrollElementIntoView(targetElement, {
        behavior: 'smooth',
        block: 'center',
      });
    });

    const timer = window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === targetMessageId ? undefined : current));
    }, 2400);

    return () => window.clearTimeout(timer);
  }, [hideScrollButton, loadAnchorMessageWindow, location.key, processedList, scrollElementIntoView, targetMessageId]);

  useEffect(() => {
    const handleMessageJump = (event: Event) => {
      const detail = (event as CustomEvent<ChatMessageJumpDetail>).detail;
      if (!detail || !detail.conversation_id) return;
      if (!conversationId || detail.conversation_id !== conversationId) return;

      const targetIndex = processedList.findIndex((item) => {
        if (
          (item as { type?: string }).type === 'file_summary' ||
          (item as { type?: string }).type === 'tool_summary' ||
          (item as { type?: string }).type === 'thinking_history' ||
          (item as { type?: string }).type === 'artifact'
        ) {
          return false;
        }
        const message = item as TMessage;
        if (detail.messageId && message.id === detail.messageId) return true;
        if (detail.msgId && message.msg_id === detail.msgId) return true;
        return false;
      });
      if (targetIndex < 0) {
        const anchorMessageId = detail.messageId;
        if (!anchorMessageId) return;
        void loadAnchorMessageWindow(anchorMessageId).then((loaded) => {
          if (!loaded) return;
          setHighlightedMessageId(anchorMessageId);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const targetElement = document.getElementById(`message-${anchorMessageId}`);
              scrollElementIntoView(targetElement, {
                block: detail.align || 'start',
                behavior: detail.behavior || 'smooth',
              });
            });
          });
        });
        return;
      }

      hideScrollButton();
      requestAnimationFrame(() => {
        const targetElement = document.getElementById(
          `message-${getProcessedItemAnchorId(processedList[targetIndex])}`
        );
        scrollElementIntoView(targetElement, {
          block: detail.align || 'start',
          behavior: detail.behavior || 'smooth',
        });
      });
    };

    window.addEventListener(CHAT_MESSAGE_JUMP_EVENT, handleMessageJump);
    return () => {
      window.removeEventListener(CHAT_MESSAGE_JUMP_EVENT, handleMessageJump);
    };
  }, [conversationId, hideScrollButton, loadAnchorMessageWindow, processedList, scrollElementIntoView]);

  // Click scroll button
  const handleScrollButtonClick = () => {
    hideScrollButton();
    scrollToBottom('smooth');
  };

  const renderItem = (_index: number, item: (typeof processedList)[0]) => {
    const highlighted = matchesTargetMessage(item, highlightedMessageId);
    if ('type' in item && item.type === 'artifact') {
      return (
        <div
          key={item.id}
          id={`message-${getProcessedItemAnchorId(item)}`}
          data-conversation-artifact-kind={item.artifact.kind}
          data-testid={`conversation-artifact-${item.artifact.kind}`}
          className={`${rowWidthClass} min-w-0 message-item px-8px m-t-10px`}
          style={highlighted ? highlightStyle : undefined}
        >
          {item.artifact.kind === 'cron_trigger' ? (
            <MessageCronTrigger artifact={item.artifact} />
          ) : (
            <MessageSkillSuggest artifact={item.artifact} />
          )}
        </div>
      );
    }
    if ('type' in item && item.type === 'thinking_history') {
      return (
        <div
          key={item.id}
          id={`message-${getProcessedItemAnchorId(item)}`}
          className={`${rowWidthClass} min-w-0 message-item px-8px m-t-10px thinking_history`}
          style={highlighted ? highlightStyle : undefined}
        >
          <ThoughtHistoryRow messages={item.messages} />
        </div>
      );
    }
    if ('type' in item && ['file_summary', 'tool_summary'].includes(item.type)) {
      return (
        <div
          key={item.id}
          id={`message-${getProcessedItemAnchorId(item)}`}
          className={`${rowWidthClass} min-w-0 message-item px-8px m-t-10px ${item.type}`}
          style={highlighted ? highlightStyle : undefined}
        >
          {item.type === 'file_summary' && <FileChangesRow diffsChanges={item.diffs} />}
          {item.type === 'tool_summary' && (
            <MessageToolGroupSummary
              messages={item.messages}
              live={!hydrated || isProcessing}
              stale={staleCallIdsRef.current}
            />
          )}
        </div>
      );
    }
    const message = item as TMessage;
    // User messages keep their own copy row; AI text only shows it at the turn end.
    const showCopyRow = message.position !== 'left' || message.type !== 'text' || aiCopyRowTextIds.has(message.id);
    const isThought = message.type === 'thinking';
    return (
      <MessageItem
        message={message}
        key={message.id}
        highlighted={highlighted}
        rowWidthClass={rowWidthClass}
        showCopyRow={showCopyRow}
        isLastMessage={message.id === lastMessageId}
        hasForkAnchor={forkAnchoredIds.has(message.id)}
        turnTexts={aiTurnTextsById.get(message.id)}
        thinkingActive={isThought ? message.id === activeThinkingId : undefined}
        thinkingExpanded={isThought ? openThoughtIds.has(message.id) : undefined}
        onThinkingExpandedChange={isThought ? handleThoughtExpandedChange : undefined}
      ></MessageItem>
    );
  };

  if (processedList.length === 0 && isMessageListLoading) {
    return <MessageListSkeleton rowWidthClass={rowWidthClass} />;
  }

  if (processedList.length === 0 && emptySlot) {
    return <div className='relative flex-1 h-full flex items-center justify-center'>{emptySlot}</div>;
  }

  return (
    <div className='relative flex-1 h-full'>
      {/* Use PreviewGroup to wrap all messages for cross-message image preview */}
      <Image.PreviewGroup actionsLayout={['zoomIn', 'zoomOut', 'originalSize', 'rotateLeft', 'rotateRight']}>
        <ImagePreviewContext.Provider value={{ inPreviewGroup: true }}>
          <div
            ref={setScrollerRef}
            data-testid='message-list-scroller'
            // Break out of the parent's 20px horizontal padding so the scrollbar hugs the
            // window edge, while re-applying that padding inside to keep message content inset.
            className='message-list-scroller flex-1 h-full overflow-y-auto pb-10px box-border -mx-20px px-20px'
            style={{ overflowAnchor: 'none' }}
            onPointerDown={handleListPointerDown}
            onScroll={handleMessageListScroll}
            onWheel={handleListWheel}
          >
            <div
              ref={setContentRef}
              data-testid='message-list-content'
              style={{
                overflowAnchor: 'none',
                fontFamily: 'var(--chat-font-family, inherit)',
                fontWeight: 'var(--chat-font-weight, inherit)',
              }}
            >
              <div className='h-10px' />
              {headerSlot && !pagination.hasMoreBefore ? headerSlot : null}
              {processedList.map((item, index) => (
                <React.Fragment key={getProcessedItemKey(item) || index}>{renderItem(index, item)}</React.Fragment>
              ))}
              <div className='h-20px' />
            </div>
          </div>
        </ImagePreviewContext.Provider>
      </Image.PreviewGroup>

      {/* Released from the bottom: one small pill offers the way back, and nothing else moves. */}
      {showScrollButton && (
        <div className='absolute bottom-16px left-50% transform -translate-x-50% z-100'>
          <button
            type='button'
            data-testid='jump-to-latest'
            className='flex items-center gap-6px h-28px ps-10px pe-8px rd-999px bg-base cursor-pointer border-1 border-solid border-3 text-12px text-t-secondary hover:text-t-primary transition-colors duration-150'
            onClick={handleScrollButtonClick}
            aria-label={t('messages.scrollToBottom')}
          >
            {t('messages.scrollToBottom')}
            <Down theme='outline' size='12' fill={iconColors.secondary} style={{ display: 'block' }} />
          </button>
        </div>
      )}

      <SelectionReplyButton messages={list} />

      <MessageAnchorRail />
    </div>
  );
};

export default MessageList;
