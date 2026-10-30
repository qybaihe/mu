/**
 * The bottom of a native conversation: what mu has queued, what the screen says about mu, a dialog pi waits on, the
 * status line and the send box. While a run goes, a message is sent as a steer, as Enter sends it in mu's terminal, and
 * mu decides when it reaches the work: at the run's next step, or after the run (`input.interjection`). The queue
 * above the box shows where each one went. The stop button stops the run (or the message the judge is still reading).
 * A command another panel sends to this conversation (the board's switch: `/board on`) goes to pi as it is.
 *
 * The send box carries what mu's other conversations have (docs/native-host-ui.md): files and images attached
 * (picked, dropped or pasted), mu's permission mode, the commands mu runs in the background (while one runs), the
 * model and its thinking level, pi's slash commands in the `/`
 * menu, and `@` mentions of the project's files. An image goes to pi as itself; a file as its full path. The box's
 * ↑/↓ history and `/copy` read the conversation's text. Above it, the goal mu works towards (`/goal <condition>`),
 * which the person can end; beside the send button, how full the model's context is.
 */
import { Button } from '@arco-design/web-react';
import type { TMessage } from '@/common/chat/chatLib';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ContextUsageIndicator from '@/renderer/components/agent/ContextUsageIndicator';
import SendBox from '@/renderer/components/chat/SendBox';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { MessageListProvider, useUpdateMessageList } from '@/renderer/pages/conversation/Messages/hooks';
import GoalLine from '@/renderer/pages/conversation/platforms/acp/Composer/GoalLine';
import { GOAL_CLEAR_COMMAND } from '@/renderer/pages/conversation/platforms/acp/Composer/goalState';
import { getChatSurfaceWidthClass } from '@/renderer/pages/conversation/utils/chatSurfaceWidth';
import { useAddEventListener, type SendBoxCommandState } from '@/renderer/utils/emitter';
import { mergeFileSelectionItems, type FileSelectionItem } from '@/renderer/utils/file/fileSelection';
import { useNativeAttachments } from '../hooks/useNativeAttachments';
import { useNativeCommands } from '../hooks/useNativeCommands';
import type { NativeConversationApi, NativeConversationState } from '../hooks/useNativeConversation';
import { useNativeModels } from '../hooks/useNativeModels';
import { contextUsageOf, goalOnScreen, showsContextRing } from '../utils/composerLines';
import { useNativeClient } from '../utils/nativeClient';
import { isWorking } from '../utils/statusRow';
import { mentionPath, permissionState, runsCommand, sendBoxMessages, withFiles } from './composer/composerModel';
import { NativeAttachButton, NativeAttachmentList } from './composer/NativeAttachments';
import NativeJobs from './composer/NativeJobs';
import NativeModelChip from './composer/NativeModelChip';
import NativePermissionPill from './composer/NativePermissionPill';
import NativeDialog from './NativeDialog';
import NativeHostNotice from './NativeHostNotice';
import NativeStatus from './NativeStatus';

type Conversation = NativeConversationState & NativeConversationApi;

/** What the native conversation's end-to-end tests call the send box's field and buttons. */
const SEND_BOX_IDS = { input: 'native-send-input', send: 'native-send', stop: 'native-abort' };

/**
 * Keeps the send box's list of messages (its ↑/↓ history and `/copy`) in step with the conversation: the shared
 * provider takes its value once, and follows only what is set through it.
 */
const SendBoxMessages: React.FC<{ rows: TMessage[] }> = ({ rows }) => {
  const update = useUpdateMessageList();
  useEffect(() => {
    update(rows);
  }, [rows, update]);
  return null;
};

/**
 * What pi holds to send, which shows where mu put each message: steering messages first (they go at the model's next
 * step), then the ones for after the run.
 */
const Queue: React.FC<{ steering: string[]; waiting: string[]; followUp: string[]; onTakeBack: () => void }> = ({
  steering,
  waiting,
  followUp,
  onTakeBack,
}) => {
  const { t } = useTranslation();
  // What waits on screen for the message before it goes next, as a steer of the run that message starts.
  const rows = [
    ...[...steering, ...waiting].map((text) => ({ text, when: t('mu.native.queue.steer') })),
    ...followUp.map((text) => ({ text, when: t('mu.native.queue.followUp') })),
  ];
  if (!rows.length) return null;
  return (
    <div
      className='mb-8px rd-12px border border-solid border-[var(--color-border-2)] bg-1 px-12px py-8px flex flex-col gap-4px'
      data-testid='native-queue'
    >
      <div className='flex items-center justify-between gap-8px'>
        <span className='text-12px text-t-tertiary'>{t('mu.native.queue.title')}</span>
        <Button type='text' size='mini' data-testid='native-queue-take-back' onClick={onTakeBack}>
          {t('mu.native.queue.takeBack')}
        </Button>
      </div>
      {rows.map((row, index) => (
        <div key={index} className='flex items-baseline gap-8px min-w-0 text-13px leading-20px'>
          <span className='shrink-0 text-12px text-t-tertiary'>{row.when}</span>
          <span className='min-w-0 truncate text-t-primary' title={row.text}>
            {row.text}
          </span>
        </div>
      ))}
    </div>
  );
};

/** The id of the view's latest `agent_settled`: a new one is a run that ended. */
function lastSettled(activity: Conversation['view']['host']['activity']): string | undefined {
  for (let index = activity.length - 1; index >= 0; index--)
    if (activity[index].kind === 'agent_settled') return activity[index].id;
  return undefined;
}

/**
 * pi's counts of the session (`get_session_stats`: its tokens, its cost, the context's fill) asked once a host runs and
 * after each run, so the context ring has them; the answer reaches every window as a record. A read that fails says
 * nothing: the ring keeps what it had.
 */
function useSessionStats(conversation: Conversation): void {
  const client = useNativeClient();
  const { id, host } = conversation;
  const settled = useMemo(() => lastSettled(conversation.view.host.activity), [conversation.view.host.activity]);
  const asked = useRef<string | undefined>(undefined);
  const running = host.phase === 'running';
  useEffect(() => {
    if (!running) {
      asked.current = undefined;
      return;
    }
    const run = settled ?? 'start';
    if (asked.current === run) return;
    asked.current = run;
    void client.request(id, { type: 'get_session_stats' });
  }, [client, id, running, settled]);
}

const NativeComposer: React.FC<{ conversation: Conversation }> = ({ conversation }) => {
  const { t } = useTranslation();
  const isMobile = useLayoutContext()?.isMobile ?? false;
  const { id, view, host, outgoing, closed, commandFailure, settings, request, send, abort, respond, expire } =
    conversation;
  const { clearFailure, waiting, returned, takeBackWaiting, settingUp } = conversation;
  const cwd = conversation.conversation?.cwd;
  const [draft, setDraft] = useState('');
  // The project's files the person mentioned with `@` (the send box keeps them in step with the text).
  const [mentioned, setMentioned] = useState<FileSelectionItem[]>([]);
  const files = useNativeAttachments();
  const picker = useRef<HTMLInputElement>(null);
  const models = useNativeModels(view, settings, request, settingUp);
  const permissions = useMemo(() => permissionState(view, settings), [settings, view]);
  const commands = useNativeCommands(host, draft, request);
  const working = isWorking(view);
  // A message on its way (mu starting, the judge reading it) or a compaction holds the box: pi takes no other prompt
  // then. One sent while a message is on its way waits its turn (`waiting`); a compaction takes none.
  const held = Boolean(outgoing) || view.live.compacting;
  const dialogs = view.dialogs.filter((dialog) => !closed.has(dialog.id));
  const { steering, followUp } = view.host.queue;
  const context = useMemo(() => ({ conversation_id: id, workspace: cwd, type: 'acp' as const }), [cwd, id]);
  const rows = useMemo(() => sendBoxMessages(view.messages, id), [id, view.messages]);
  const goal = useMemo(() => goalOnScreen(view, host), [host, view]);
  const usage = useMemo(() => contextUsageOf(view), [view]);
  useSessionStats(conversation);

  // Ending a goal is a command the person gives, `/goal clear`, as in mu's other conversations. pi runs an extension's
  // command at once, a run going or not; a run that goes is stopped as well, as the classic line stops it (a goal's run
  // does not end by itself: mu sends the agent back to work). Cleared first, so the stop does not pause it on the way.
  const endGoal = useCallback(
    (heard: (state: SendBoxCommandState) => void) => {
      const stop = working;
      void request({ type: 'prompt', message: GOAL_CLEAR_COMMAND }).then(async (result) => {
        heard(result.ok ? 'sent' : 'dropped');
        if (result.ok && stop) await abort();
      });
    },
    [abort, request, working]
  );

  useAddEventListener(
    'sendbox.command',
    (command, target, heard) => {
      if (target !== id || !command.trim()) return;
      heard?.('sent');
      void request({ type: 'prompt', message: command });
    },
    [id, request]
  );

  // Text another part of the screen puts into the box (the person's message a fork brings back, to edit): added to
  // what is there, as the classic box does.
  useAddEventListener('sendbox.fill', (text: string) => setDraft((old) => (old ? `${old}${text}` : text)), []);

  // Text mu put into the person's editor (a checkpoint rewind gives the request back, to send again): into the box,
  // before what was typed since. Each once; an empty one clears nothing the person typed. What the conversation's
  // snapshot already held was given before this box was opened: it isn't given again.
  const editorText = view.host.editorText;
  const tookEditorText = useRef<string | undefined>(editorText?.id);
  const loaded = useRef(false);
  useEffect(() => {
    if (conversation.loading) return;
    if (!loaded.current) {
      loaded.current = true;
      tookEditorText.current = editorText?.id;
      return;
    }
    if (!editorText || tookEditorText.current === editorText.id) return;
    tookEditorText.current = editorText.id;
    const text = editorText.text;
    if (text.trim()) setDraft((old) => (old.trim() ? `${text}\n\n${old}` : text));
  }, [conversation.loading, editorText]);

  // A first message that could not be sent comes back into the box, before what was typed since.
  const tookBack = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!returned || tookBack.current === returned.id) return;
    tookBack.current = returned.id;
    setDraft((old) => (old ? `${returned.text}\n\n${old}` : returned.text));
  }, [returned]);

  const onSend = useCallback(
    async (text: string, extras?: { images?: Array<{ data: string; mimeType: string }> }): Promise<void | false> => {
      const paths = [
        ...files.paths(),
        ...mentioned.flatMap((item): string[] => {
          const path = mentionPath(item, cwd);
          return path ? [path] : [];
        }),
      ];
      // The pictures of the elements picked in the browser go with the files' images.
      const images = [
        ...files.images(),
        ...(extras?.images ?? []).map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })),
      ];
      // The box is free at once, for the next message: this one may wait its turn behind the one on its way.
      const attached = files.attachments;
      const named = mentioned;
      files.clear();
      setMentioned([]);
      const result = await send(withFiles(text, paths), images, { command: runsCommand(text, commands.extensions) });
      if (result.ok !== false) return undefined;
      // What did not reach pi goes back into the box, attachments included.
      files.restore(attached);
      setMentioned((old) => mergeFileSelectionItems(named, old));
      return false;
    },
    [commands.extensions, cwd, files, mentioned, send]
  );

  // Files dropped or pasted into the box are read here, before the shared box would upload them.
  const onDropCapture = useCallback(
    (event: React.DragEvent) => {
      const dropped = [...(event.dataTransfer?.files ?? [])];
      if (dropped.length) void files.add(dropped);
    },
    [files]
  );
  const onPasteCapture = useCallback(
    (event: React.ClipboardEvent) => {
      const pasted = [...(event.clipboardData?.files ?? [])];
      if (!pasted.length) return;
      event.preventDefault();
      event.stopPropagation();
      void files.add(pasted);
    },
    [files]
  );

  const onStop = useCallback(async () => {
    await abort();
  }, [abort]);

  const takeBack = useCallback(async () => {
    // What waits on screen first: none of it goes once taken back, whatever pi answers.
    const mine = takeBackWaiting();
    const result = steering.length || followUp.length ? await request({ type: 'clear_queue' }) : undefined;
    const taken = (result?.ok ? (result.data ?? {}) : {}) as { steering?: string[]; followUp?: string[] };
    const texts = [...(taken.steering ?? []), ...mine, ...(taken.followUp ?? [])];
    if (texts.length) setDraft((old) => [...texts, old].filter(Boolean).join('\n\n'));
  }, [followUp.length, request, steering.length, takeBackWaiting]);

  return (
    // `data-composer-zone`: the work panel, floating in a narrow window, stops above this.
    <div
      data-composer-zone
      className={`${getChatSurfaceWidthClass()} flex flex-col mt-auto mb-16px`}
      onDropCapture={onDropCapture}
      onPasteCapture={onPasteCapture}
    >
      <Queue
        steering={steering}
        waiting={waiting.map((each) => each.text)}
        followUp={followUp}
        onTakeBack={() => void takeBack()}
      />
      <NativeHostNotice host={host} commandFailure={commandFailure} onClearFailure={clearFailure} />
      {dialogs.length ? (
        <div className='mb-8px'>
          <NativeDialog
            key={dialogs[0].id}
            conversationId={id}
            dialog={dialogs[0]}
            more={dialogs.length - 1}
            onAnswer={respond}
            onExpire={expire}
          />
        </div>
      ) : null}
      {/* Above the status line: the line tucks under the send box, and would cover what came between them. */}
      {goal ? <GoalLine key={goal.text} goal={goal} onEnd={endGoal} /> : null}
      <NativeStatus view={view} host={host} sendingSince={outgoing?.at} />
      <input
        ref={picker}
        type='file'
        multiple
        hidden
        data-testid='native-attach-input'
        onChange={(event) => {
          const picked = [...(event.target.files ?? [])];
          // The same file picked again is a change too.
          event.target.value = '';
          if (picked.length) void files.add(picked);
        }}
      />
      <ConversationProvider value={context}>
        <MessageListProvider value={rows}>
          <SendBoxMessages rows={rows} />
          <SendBox
            value={draft}
            onChange={setDraft}
            onSend={onSend}
            onStop={onStop}
            loading={working || held}
            allowSendWhileLoading={(working || Boolean(outgoing)) && !view.live.compacting}
            className='z-10'
            testIds={SEND_BOX_IDS}
            defaultMultiLine={!isMobile}
            lockMultiLine={!isMobile}
            placeholder={working ? t('mu.native.send.placeholderWorking') : t('mu.native.send.placeholder')}
            slash_commands={commands.items}
            onSlashBuiltinCommand={(name) => {
              if (name === 'open') picker.current?.click();
            }}
            selectedWorkspaceItems={mentioned}
            onSelectedWorkspaceItemsChange={setMentioned}
            hasPendingAttachments={files.attachments.length > 0 || mentioned.length > 0}
            compactActions={false}
            prefix={<NativeAttachmentList attachments={files.attachments} onRemove={files.remove} />}
            tools={
              // Left of the input: attachments, then what mu may do.
              <>
                <NativeAttachButton onClick={() => picker.current?.click()} />
                <NativePermissionPill state={permissions} held={held} request={request} />
                <NativeJobs jobs={view.host.jobs} cwd={cwd} refresh={working} request={request} />
              </>
            }
            rightTools={<NativeModelChip models={models} busy={working || held} />}
            sendButtonPrefix={
              // The context's fill against its window, once pi has said it (a host ran); nothing before. Beside the kernel
              // bar, which shows it too, only when the window runs short.
              usage && showsContextRing(usage, !isMobile) ? (
                <span
                  className='flex'
                  data-testid='native-context-usage'
                  data-tokens={usage.tokenUsage.total_tokens}
                  data-window={usage.contextLimit}
                >
                  <ContextUsageIndicator tokenUsage={usage.tokenUsage} context_limit={usage.contextLimit} />
                </span>
              ) : undefined
            }
          />
        </MessageListProvider>
      </ConversationProvider>
    </div>
  );
};

export default NativeComposer;
