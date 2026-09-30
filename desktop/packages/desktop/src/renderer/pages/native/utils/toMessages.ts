/**
 * A native conversation's view (common/utils/nativeHost/view.ts) as the rows the conversation's message list shows
 * (`TMessage`, the rows AionCore stores for a conversation), so the list and its row components are the ones every
 * conversation uses. Each row is shaped as the mu bridge's rows are (process/agent/kyrn/events.ts, KyrnAgent.ts):
 *
 * - the person's messages and mu's text as `text` rows (with the images the person sent as themselves), mu's thinking
 *   as `thinking` rows;
 * - a tool call as the `acp_tool_call` the bridge sends, its result or latest output as its content;
 * - Jev's verdict on a message as the `jev:` line under it, and Jev at work on the next one as a pending `jev:` line;
 * - what mu notified, a stopped reply, a reply that came after failed attempts, and a place where the conversation was
 *   compacted as `mu:notice:` lines;
 * - a failed request as the `tips` error the bridge's turn error becomes, in the bridge's fixed English, which the
 *   tips row words in the reader's language.
 *
 * The view says how the run stands, so no row is left to guess it: a thought is live only while the model writes it,
 * and a call that never ended in a run that is over reads as failed. Pure: the same view gives the same rows.
 */
import type {
  IMessageAcpToolCall,
  IMessageText,
  IMessageThinking,
  IMessageTips,
  TMessage,
} from '@/common/chat/chatLib';
import type {
  NativeView,
  ViewAssistantMessage,
  ViewImage,
  ViewMessage,
  ViewNotice,
  ViewToolCall,
  ViewToolResult,
  ViewUserMessage,
} from '@/common/utils/nativeHost';

type ToolUpdate = IMessageAcpToolCall['content']['update'];

/** Words the rows need that no row component has: the caller's, in the reader's language. */
export type MessageWords = {
  /** The line before a reply that came after `count` failed attempts. */
  retried: (count: number) => string;
  /** The line where the conversation was compacted, `tokens` of it condensed (0 when that is not known). */
  compacted: (tokens: number) => string;
};

/**
 * A message the person sent that is not in the conversation yet: pi takes it once Jev has classified it. `images`: the
 * images sent with it as themselves.
 */
export type OutgoingMessage = { id: string; text: string; at: number; images?: ViewImage[] };

export type MessageOptions = {
  conversationId: string;
  words: MessageWords;
  outgoing?: OutgoingMessage;
};

/** The bridge's fixed English for a failed request, which the tips row recognises (renderer/utils/chat/muTurnErrors.ts). */
export const MODEL_FAILED = 'Model request failed';
/** The English stand-in of a stopped reply's line; the line is worded by its code. */
const STOPPED_TITLE = 'You stopped this reply.';
/** pi's words when a command needs bash on Windows and finds none (the bridge's `bashMissing`). */
const NO_BASH = /No bash shell found/;
const BASH_MISSING_TITLE = 'mu needs Git for Windows to run commands.';

const isRunning = (view: NativeView): boolean => view.status === 'working' || view.status === 'thinking';

/** The tool's kind as the bridge names it: what the row's icon and target read. */
function kindOf(name: string): ToolUpdate['kind'] {
  if (['read', 'grep', 'find', 'ls'].includes(name)) return 'read';
  if (['write', 'edit'].includes(name)) return 'edit';
  return 'execute';
}

const TOOL_STATUS: Readonly<Record<ViewToolCall['status'], ToolUpdate['status']>> = {
  streaming: 'pending',
  pending: 'pending',
  running: 'in_progress',
  done: 'completed',
  error: 'failed',
};

const textContent = (text: string): NonNullable<ToolUpdate['content']> => [
  { type: 'content', content: { type: 'text', text } },
];

/** A line of its own in the conversation, as the bridge's notices come: shown as one line, never as a call. */
function noticeRow(
  conversationId: string,
  id: string,
  at: number,
  title: string,
  rawInput: Record<string, unknown>
): IMessageAcpToolCall {
  return {
    id,
    conversation_id: conversationId,
    type: 'acp_tool_call',
    position: 'left',
    created_at: at,
    content: {
      session_id: conversationId,
      update: {
        sessionUpdate: 'tool_call',
        tool_call_id: `mu:notice:${id}`,
        status: 'completed',
        title,
        kind: 'execute',
        rawInput,
      },
    },
  };
}

function textRow(
  conversationId: string,
  id: string,
  groupId: string,
  at: number,
  position: 'left' | 'right',
  content: string,
  images: readonly ViewImage[] = []
): IMessageText {
  return {
    id,
    msg_id: groupId,
    conversation_id: conversationId,
    type: 'text',
    position,
    created_at: at,
    content: images.length ? { content, images: images.slice() } : { content },
  };
}

/** The line under a message with Jev's verdict on it, as the bridge's `jev:` row after its verdict. */
function verdictRow(conversationId: string, message: ViewUserMessage, at: number): IMessageAcpToolCall | undefined {
  if (!message.verdict) return undefined;
  const turnType = typeof message.verdict.turnType === 'string' ? message.verdict.turnType : '';
  return {
    id: `${message.id}:jev`,
    msg_id: message.id,
    conversation_id: conversationId,
    type: 'acp_tool_call',
    position: 'left',
    created_at: at,
    content: {
      session_id: conversationId,
      update: {
        sessionUpdate: 'tool_call',
        tool_call_id: `jev:native:${message.id}`,
        status: 'completed',
        title: `Jev · ${turnType || 'Default'}`,
        kind: 'execute',
        rawOutput: { ...message.verdict, preflight: 'verdict' },
      },
    },
  };
}

/** What a result shows: its text as the row's output, and the whole result (details included) as the bridge sends it. */
function resultUpdate(result: ViewToolResult | undefined): Partial<ToolUpdate> {
  if (!result) return {};
  const rawOutput = {
    content: [{ type: 'text', text: result.text }],
    ...(result.details !== undefined ? { details: result.details } : {}),
  };
  return { content: textContent(result.text), rawOutput };
}

function toolRow(
  conversationId: string,
  message: ViewAssistantMessage,
  tool: ViewToolCall,
  open: boolean,
  at: number
): IMessageAcpToolCall {
  const ended = tool.status === 'done' || tool.status === 'error';
  // A call of a run that is over, or of a message the run has left behind, never ends now: it did not finish.
  const status: ToolUpdate['status'] = ended || open ? TOOL_STATUS[tool.status] : 'failed';
  const result = tool.result ?? tool.partial;
  const noBash = tool.status === 'error' && NO_BASH.test(result?.text ?? '');
  const path = tool.args.path;
  return {
    id: `${message.id}:${tool.id}`,
    msg_id: message.id,
    conversation_id: conversationId,
    type: 'acp_tool_call',
    position: 'left',
    created_at: at,
    content: {
      session_id: conversationId,
      update: {
        sessionUpdate: 'tool_call',
        tool_call_id: tool.id,
        status,
        title: tool.name,
        kind: kindOf(tool.name),
        rawInput: tool.args,
        // No bash on Windows: pi's error, meant for developers, makes way for the line that says what to do.
        ...(noBash ? { content: [], rawOutput: { notice: 'bash_missing' } } : resultUpdate(result)),
        ...(typeof path === 'string' && path ? { locations: [{ path }] } : {}),
      },
    },
  };
}

/** What a failed request says, as the bridge raises it: the fixed headline, then pi's own words. */
const failureText = (detail: string | undefined): string => (detail ? `${MODEL_FAILED}: ${detail}` : MODEL_FAILED);

function errorRow(conversationId: string, id: string, at: number, content: string): IMessageTips {
  return {
    id,
    conversation_id: conversationId,
    type: 'tips',
    position: 'center',
    created_at: at,
    content: { content, type: 'error' },
  };
}

type Context = {
  conversationId: string;
  words: MessageWords;
  /** The run goes, and this is its last assistant message: its calls may still be under way. */
  open: boolean;
  /** The model writes this message's last thinking block now. */
  thinking: boolean;
  /** Its bash-missing line was said by an earlier message. */
  bashSaid: boolean;
  at: number;
};

function assistantRows(message: ViewAssistantMessage, context: Context): TMessage[] {
  const { conversationId, at } = context;
  const rows: TMessage[] = [];
  if (message.retries)
    rows.push(
      noticeRow(conversationId, `${message.id}:retried`, at, context.words.retried(message.retries), { level: 'info' })
    );
  message.blocks.forEach((block, index) => {
    const id = `${message.id}:${index}`;
    if (block.type === 'text') {
      if (block.text.trim()) rows.push(textRow(conversationId, id, message.id, at, 'left', block.text));
      return;
    }
    if (block.type === 'thinking') {
      // Only the thinking the provider shows: a redacted block has none.
      if (block.redacted || !block.text.trim()) return;
      const live = context.thinking && index === message.blocks.length - 1;
      const row: IMessageThinking = {
        id,
        msg_id: message.id,
        conversation_id: conversationId,
        type: 'thinking',
        position: 'left',
        created_at: at,
        content: { content: block.text, status: live ? 'thinking' : 'done' },
      };
      rows.push(row);
      return;
    }
    rows.push(toolRow(conversationId, message, block, context.open, at));
  });
  const noBash = message.blocks.some(
    (block) => block.type === 'tool' && block.status === 'error' && NO_BASH.test(block.result?.text ?? '')
  );
  if (noBash && !context.bashSaid)
    rows.push(noticeRow(conversationId, `${message.id}:bash`, at, BASH_MISSING_TITLE, { notice: 'bash_missing' }));
  if (message.stopReason === 'aborted')
    rows.push(noticeRow(conversationId, `${message.id}:stopped`, at, STOPPED_TITLE, { notice: 'stopped' }));
  if (message.stopReason === 'error')
    rows.push(errorRow(conversationId, `${message.id}:error`, at, failureText(message.errorMessage)));
  return rows;
}

/** What mu notified, as the bridge shows it: its own words, or its checkpoint notice by code. */
function noticeOf(conversationId: string, notice: ViewNotice, at: number): IMessageAcpToolCall {
  const input: Record<string, unknown> =
    notice.code === 'checkpoint_off'
      ? { notice: 'checkpoint_off', ...(notice.reason ? { code: notice.reason } : {}), params: notice.params ?? {} }
      : { level: notice.level };
  return noticeRow(conversationId, `notice:${notice.id}`, at, notice.text, input);
}

const hasBashLine = (message: ViewMessage): boolean =>
  message.role === 'assistant' &&
  message.blocks.some(
    (block) => block.type === 'tool' && block.status === 'error' && NO_BASH.test(block.result?.text ?? '')
  );

type Cached = { key: string; rows: TMessage[] };

/**
 * A mapper that gives an unchanged message the rows it gave before, so the list redraws only the message that
 * streams. Its cache holds while the conversation and the words stay the same.
 */
export function createMessageMapper(): (view: NativeView, options: MessageOptions) => TMessage[] {
  let cache = new WeakMap<ViewMessage, Cached>();
  let noticeCache = new WeakMap<ViewNotice, Cached>();
  let cachedFor: { conversationId: string; words: MessageWords } | undefined;

  return (view, options) => {
    const { conversationId, words, outgoing } = options;
    if (cachedFor?.conversationId !== conversationId || cachedFor.words !== words) {
      cache = new WeakMap();
      noticeCache = new WeakMap();
      cachedFor = { conversationId, words };
    }
    const running = isRunning(view);
    let lastAssistant = -1;
    for (let index = view.messages.length - 1; index >= 0; index--)
      if (view.messages[index].role === 'assistant') {
        lastAssistant = index;
        break;
      }

    // Notices go after the message that was last when they came; one whose message is gone goes at the end.
    const known = new Set(view.messages.map((message) => message.id));
    const noticesAfter = new Map<string, ViewNotice[]>();
    for (const notice of view.host.notices) {
      const after = notice.after && known.has(notice.after) ? notice.after : notice.after ? '$end' : '';
      noticesAfter.set(after, [...(noticesAfter.get(after) ?? []), notice]);
    }
    const notices = (key: string, at: number): TMessage[] =>
      (noticesAfter.get(key) ?? []).map((notice) => {
        const cacheKey = `${at}`;
        const hit = noticeCache.get(notice);
        if (hit?.key === cacheKey) return hit.rows[0];
        const row = noticeOf(conversationId, notice, at);
        noticeCache.set(notice, { key: cacheKey, rows: [row] });
        return row;
      });

    const rows: TMessage[] = [...notices('', 0)];
    // Rows are ordered by time where the list sorts them (stably): each takes the latest time seen so far.
    let at = 0;
    let bashSaid = false;
    view.messages.forEach((message, index) => {
      if (message.role === 'user' || message.role === 'assistant') at = Math.max(at, message.timestamp);
      const open = running && index === lastAssistant;
      const thinking = open && view.status === 'thinking' && message.role === 'assistant' && message.streaming;
      const key = `${at}|${open}|${thinking}|${bashSaid}`;
      const hit = cache.get(message);
      let own: TMessage[];
      if (hit?.key === key) own = hit.rows;
      else {
        if (message.role === 'user') {
          const verdict = verdictRow(conversationId, message, at);
          own = [
            textRow(conversationId, message.id, message.id, at, 'right', message.text, message.images),
            ...(verdict ? [verdict] : []),
          ];
        } else if (message.role === 'custom') {
          own = message.text.trim() ? [textRow(conversationId, message.id, message.id, at, 'left', message.text)] : [];
        } else if (message.role === 'compaction') {
          own = [
            noticeRow(conversationId, `${message.id}:compacted`, at, words.compacted(message.tokensBefore), {
              level: 'info',
            }),
          ];
        } else own = assistantRows(message, { conversationId, words, open, thinking, bashSaid, at });
        cache.set(message, { key, rows: own });
      }
      rows.push(...own, ...notices(message.id, at));
      bashSaid ||= hasBashLine(message);
    });
    rows.push(...notices('$end', at));

    // A prompt pi refused ran nothing: no message failed, the run did.
    const last = lastAssistant >= 0 ? view.messages[lastAssistant] : undefined;
    if (view.status === 'error' && !(last?.role === 'assistant' && last.stopReason === 'error'))
      rows.push(errorRow(conversationId, 'refused', at, view.error || MODEL_FAILED));

    if (outgoing) {
      const sentAt = Math.max(at, outgoing.at);
      rows.push(textRow(conversationId, outgoing.id, outgoing.id, sentAt, 'right', outgoing.text, outgoing.images));
    }
    const classifying = view.live.classifying;
    if (classifying) {
      rows.push({
        id: `jev:classifying:${classifying.turn}`,
        conversation_id: conversationId,
        type: 'acp_tool_call',
        position: 'left',
        created_at: Math.max(at, outgoing?.at ?? 0),
        content: {
          session_id: conversationId,
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: `jev:native:turn-${classifying.turn}`,
            status: 'in_progress',
            title: 'Jev · Classifying',
            kind: 'execute',
            rawOutput: { preflight: 'pending', ...(classifying.judge ? { judge: classifying.judge } : {}) },
          },
        },
      });
    }
    return rows;
  };
}

/** The rows of one view, without a cache. */
export const toMessages = (view: NativeView, options: MessageOptions): TMessage[] =>
  createMessageMapper()(view, options);
