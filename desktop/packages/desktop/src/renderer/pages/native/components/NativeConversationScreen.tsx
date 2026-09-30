/**
 * A native conversation on screen: its header, its transcript in the message list every conversation uses (its view
 * as the list's rows, the latest ones of a long conversation and the earlier ones once the reader scrolls up to them),
 * and its send box. The route follows a draft's id once its session gives it its own. The work panel beside it shows
 * this conversation, its Jev tabs fed from the view. With no transcript yet, the screen says where mu will work; a
 * conversation that cannot be opened says why, and can be tried again.
 */
import { Button, Message } from '@arco-design/web-react';
import { Attention } from '@icon-park/react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { IMessageText } from '@/common/chat/chatLib';
import type { NativeFailure } from '@/common/kyrn/nativeBridge';
import { wordsOf } from '@/common/utils/nativeHost';
import FlexFullContainer from '@/renderer/components/layout/FlexFullContainer';
import MessageList from '@/renderer/pages/conversation/Messages/MessageList';
import MuBrowserHost from '@/renderer/pages/conversation/Preview/browser/muBrowser/MuBrowserHost';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  MessageListRunProvider,
  MessagePaginationProvider,
  useUpdateMessageList,
  useUpdateMessageListLoading,
  useUpdateMessagePaginationState,
  type MessageListRun,
} from '@/renderer/pages/conversation/Messages/hooks';
import { CHAT_SURFACE_CONTAINER_CLASS } from '@/renderer/pages/conversation/utils/chatSurfaceWidth';
import { formatNumber } from '@/renderer/services/i18n/format';
import { iconColors } from '@/renderer/styles/colors';
import { emitter } from '@/renderer/utils/emitter';
import HOC from '@/renderer/utils/ui/HOC';
import { clearNativeUnread } from '../hooks/useNativeAttention';
import { useNativeConversation } from '../hooks/useNativeConversation';
import { useNativePanel } from '../hooks/useNativePanel';
import { errorKey } from '../utils/errorWords';
import { forkableIds, forkPoint } from '../utils/forkPoint';
import { folderName, nativeConversationPath } from '../utils/paths';
import { ROW_WINDOW, windowStart } from '../utils/rowWindow';
import { isWorking } from '../utils/statusRow';
import { createMessageMapper, type MessageWords } from '../utils/toMessages';
import NativeComposer from './NativeComposer';
import NativeHeader from './NativeHeader';

const OpenFailure: React.FC<{ failure: NativeFailure; onRetry: () => void }> = ({ failure, onRetry }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className='size-full flex items-center justify-center p-24px bg-1' data-testid='native-open-failed'>
      <div className='max-w-480px flex flex-col items-center gap-10px text-center'>
        <Attention theme='filled' size='24' fill={iconColors.danger} />
        <div className='text-15px font-500 text-t-primary'>{t(errorKey(failure.kind))}</div>
        <div className='text-12px leading-18px text-t-tertiary whitespace-pre-wrap [word-break:break-word]'>
          {failure.message}
        </div>
        <div className='flex gap-8px mt-6px'>
          <Button size='small' type='secondary' onClick={() => void navigate('/guid')}>
            {t('mu.native.open.home')}
          </Button>
          <Button size='small' type='primary' onClick={onRetry} data-testid='native-open-retry'>
            {t('mu.native.open.retry')}
          </Button>
        </div>
      </div>
    </div>
  );
};

/** A conversation with nothing in it yet: where mu will work, and what to do. */
const Empty: React.FC<{ cwd?: string }> = ({ cwd }) => {
  const { t } = useTranslation();
  return (
    <div className='max-w-420px flex flex-col items-center gap-6px text-center' data-testid='native-empty'>
      <div className='text-15px font-500 text-t-primary'>
        {cwd ? t('mu.native.empty.title', { folder: folderName(cwd) }) : t('mu.native.untitled')}
      </div>
      <div className='text-13px leading-20px text-t-secondary'>{t('mu.native.empty.body')}</div>
    </div>
  );
};

const NativeConversationScreen: React.FC<{ id: string }> = ({ id }) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const conversation = useNativeConversation(id);
  const { view, loading, failure, outgoing } = conversation;
  const cwd = conversation.conversation?.cwd;
  const updateList = useUpdateMessageList();
  const updateLoading = useUpdateMessageListLoading();

  const language = i18n?.language;
  const words = useMemo<MessageWords>(
    () => ({
      retried: (count) => t('mu.native.retried', { count }),
      compacted: (tokens) =>
        tokens > 0
          ? t('mu.native.compacted', { tokens: formatNumber(tokens, language) })
          : t('mu.native.compactedPlain'),
    }),
    [t, language]
  );
  const [mapper] = useState(createMessageMapper);
  const rows = useMemo(
    () => mapper(view, { conversationId: conversation.id, words, ...(outgoing ? { outgoing } : {}) }),
    [conversation.id, mapper, outgoing, view, words]
  );

  // Only the latest rows are drawn, and the ones before come as the reader scrolls up to them (utils/rowWindow.ts). The
  // window is pinned to the row it starts at, so rows that arrive at the end do not push its first row out from under
  // a reader who is looking at it. A view that was replaced (another session) is windowed anew: its row ids repeat
  // the old ones', so a pin belongs to one epoch of the view.
  const epoch = conversation.epoch;
  const [pin, setPin] = useState<{ epoch: number; id: string }>();
  const pinned = pin?.epoch === epoch ? rows.findIndex((row) => row.id === pin.id) : -1;
  const start = pinned >= 0 ? pinned : windowStart(rows, ROW_WINDOW);
  const shown = useMemo(() => (start > 0 ? rows.slice(start) : rows), [rows, start]);
  useLayoutEffect(() => {
    if (start > 0 && pinned < 0) setPin({ epoch, id: rows[start].id });
  }, [epoch, pinned, rows, start]);
  // A step up shows the rows before the window; the list asks when the reader reaches its top, one step at a time.
  const loadEarlier = useCallback((): boolean => {
    if (start <= 0) return false;
    setPin({ epoch, id: rows[windowStart(rows, ROW_WINDOW, start)].id });
    return true;
  }, [epoch, rows, start]);
  const setPagination = useUpdateMessagePaginationState();
  const hasEarlier = start > 0;
  useLayoutEffect(() => {
    setPagination({ hasMoreBefore: hasEarlier, hasMoreAfter: false, isLoadingBefore: false, isLoadingAnchor: false });
  }, [hasEarlier, setPagination]);

  // Before the paint, so a record never shows a frame late.
  useLayoutEffect(() => updateList(shown), [shown, updateList]);
  useLayoutEffect(() => updateLoading(loading), [loading, updateLoading]);

  // A draft's id gave way to its session's: the route follows, and the screen stays (`samePage`: the route's boundary
  // keeps the page mounted, with what the send box holds).
  useEffect(() => {
    if (conversation.id !== id)
      void navigate(nativeConversationPath(conversation.id), { replace: true, state: { samePage: true } });
  }, [conversation.id, id, navigate]);

  useNativePanel(conversation.id, view, conversation.epoch, loading, failure, cwd);

  // What the conversation wanted of its person (a run ended, a question) is seen once it is on screen.
  useEffect(() => {
    clearNativeUnread(conversation.id);
  }, [conversation.id]);

  // A message's fork button: pi forks the session there (utils/forkPoint.ts). The conversation goes on in the fork (its
  // id changes, the route follows) and the old session stays in the list as a conversation of its own; the person's own
  // message comes back into the send box, to edit. It reads the view when it is clicked, not when the row is drawn.
  const viewNow = useRef(view);
  useLayoutEffect(() => {
    viewNow.current = view;
  });
  const { request } = conversation;
  const fork = useCallback(
    async (message: IMessageText): Promise<void> => {
      const point = forkPoint(viewNow.current, message.msg_id ?? message.id);
      if (!point) {
        Message.error(t('messages.fork.errorGeneric', { message: t('mu.native.forkNoEntry') }));
        return;
      }
      const result = await request(point.command);
      if (!result.ok) return;
      const { text, cancelled } = (result.data ?? {}) as { text?: unknown; cancelled?: unknown };
      // pi answers with the message as it saved it: a host's preamble in front of it is not what the person wrote.
      if (point.fill && cancelled !== true && typeof text === 'string' && text)
        emitter.emit('sendbox.fill', wordsOf(text));
    },
    [request, t]
  );

  const working = isWorking(view) || Boolean(outgoing);
  // The messages a fork button is drawn under: found again only when the view changes while nothing runs.
  const forkable = useMemo(() => (working ? undefined : forkableIds(view)), [view, working]);
  const run = useMemo<MessageListRun>(
    () => ({
      conversationId: conversation.id,
      isProcessing: working,
      hydrated: !loading,
      ...(cwd ? { workspace: cwd } : {}),
      loadEarlier,
      ...(forkable
        ? {
            fork: (message: IMessageText) =>
              forkable.has(message.msg_id ?? message.id) ? () => void fork(message) : undefined,
          }
        : {}),
    }),
    [conversation.id, cwd, fork, forkable, loadEarlier, loading, working]
  );

  if (failure) return <OpenFailure failure={failure} onRetry={conversation.retry} />;

  return (
    <div
      className='size-full flex flex-col min-h-0 bg-1'
      data-testid='native-conversation'
      data-id={conversation.id}
      data-loading={loading ? 'true' : undefined}
    >
      {/* Keyed like the send box: a title being renamed belongs to one conversation, whose draft id may give way. */}
      <NativeHeader
        key={conversation.key}
        conversation={conversation.conversation}
        host={conversation.host}
        onRename={conversation.rename}
      />
      <div className={`${CHAT_SURFACE_CONTAINER_CLASS} flex-1 flex flex-col px-20px min-h-0`}>
        <MessageListRunProvider value={run}>
          <FlexFullContainer>
            <MessageList className='flex-1' emptySlot={loading ? undefined : <Empty cwd={cwd} />} />
          </FlexFullContainer>
        </MessageListRunProvider>
        <NativeComposer key={conversation.key} conversation={conversation} />
      </div>
      {/* mu's browse loop opens its tabs in this conversation's browser panel and asks its questions here. */}
      <MuBrowserHost conversationId={conversation.id} />
    </div>
  );
};

export default HOC.Wrapper(
  MessageListProvider,
  MessageListLoadingProvider,
  MessagePaginationProvider
)(NativeConversationScreen);
