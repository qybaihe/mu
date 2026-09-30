/**
 * pi's records → a conversation view (view.ts), for a live run (`reduce`, one record at a time) and for a session read
 * back from its file (`fromEntries`). Both go through the same steps, so the same content gives the same view (what
 * only a live host says, `host`, aside):
 *
 * - A message counts once it is complete (`message_end`, a `message` entry). A live assistant message exists from its
 *   `message_start` and fills with its deltas until then; tool calls take their results from `toolResult` messages.
 *   A message carries the session entry it is saved as (`message_end.entryId`, the entry's id).
 * - A failed attempt that pi retries is hidden from the model by a `context_edit` naming its entry: the view folds it
 *   into the attempt that follows (`retries`). Nothing else a `context_edit` hides or replaces leaves the view:
 *   extensions edit what the model reads, not what the person saw.
 * - Jev's judgments are the ledger's `kyrn.decision` records: live they come twice (the `entry_appended` and the
 *   `decision` presentation frame), once in the file, and count once by record id. Each is filed under the turn that
 *   asked (`origin.turn`), not the turn during which it arrived.
 * - The verdict line of a message (`kyrn.verdict`) follows its user message, live and in the file.
 * - mu's goal is its latest `kyrn.goal` entry, or a `goal.state` frame after it (view.ts `ViewGoal`).
 * - The status comes from pi's events: `agent_start` to `agent_settled` is a run, a thinking block is `thinking`, and
 *   how the run ended is its last assistant message's stop reason. Nothing is inferred from timing.
 *
 * Pure: no I/O, no clock, and the view passed in is never changed.
 */
import {
  addFrame,
  addRunEvent,
  nextNumber,
  readPermission,
  takeCheckpointOff,
  takeNotify,
  takeQueue,
  takeResponse,
  takeSessionEvent,
  usageOf,
} from './host.ts';
import { readPresentation } from './presentation.ts';
import {
  asList,
  asNumber,
  asObject,
  asText,
  DIALOG_METHODS,
  type DialogMethod,
  type JsonObject,
  type PiRecord,
} from './records.ts';
import {
  emptyView,
  type NativeView,
  type TurnStatus,
  type ViewAssistantMessage,
  type ViewBlock,
  type ViewDialog,
  type ViewGoal,
  type ViewImage,
  type ViewJudgment,
  type ViewLive,
  type ViewMessage,
  type ViewToolCall,
  type ViewToolResult,
} from './view.ts';
import { wordsOf } from './words.ts';

/** The judgment layer's ledger entries (LEDGER_ENTRY_TYPE in the harness). */
export const DECISION_ENTRY = 'kyrn.decision';
/** The verdict line the preflight shows under a message (VERDICT_ENTRY in the harness). */
export const VERDICT_ENTRY = 'kyrn.verdict';
/** mu's goal, saved each time it changes (GOAL_ENTRY in the harness); its `goal.state` frame says the same. */
export const GOAL_ENTRY = 'kyrn.goal';
export const GOAL_FRAME = 'goal.state';

const GOAL_STATUSES: ReadonlySet<string> = new Set(['active', 'paused', 'met', 'cleared']);

/** A goal as a `kyrn.goal` entry or a `goal.state` frame says it, or undefined when it says nothing usable. */
export function readGoal(data: unknown): ViewGoal | undefined {
  const { status, text } = asObject(data);
  if (typeof status !== 'string' || !GOAL_STATUSES.has(status)) return undefined;
  if (typeof text !== 'string' || !text.trim()) return undefined;
  return { status: status as ViewGoal['status'], text };
}

/** The view with the goal `data` says, or as it was when `data` says nothing usable. */
function takeGoal(view: NativeView, data: unknown): NativeView {
  const goal = readGoal(data);
  return goal ? { ...view, goal } : view;
}

const isRunning = (status: TurnStatus): boolean => status === 'working' || status === 'thinking';

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : asList(content)
        .map(asObject)
        .filter((block) => block.type === 'text')
        .map((block) => asText(block.text))
        .join('\n');

const imagesOf = (content: unknown): ViewImage[] =>
  asList(content)
    .map(asObject)
    .filter((block) => block.type === 'image' && typeof block.data === 'string')
    .map((block) => ({ mimeType: asText(block.mimeType), data: asText(block.data) }));

/** A tool's result or partial result, or a `toolResult` message: both carry `content` and `details`. */
function resultOf(value: unknown, isError: boolean): ViewToolResult {
  const result = asObject(value);
  return {
    text: textOf(result.content),
    images: imagesOf(result.content),
    ...(result.details !== undefined ? { details: result.details } : {}),
    isError,
  };
}

function blockOf(value: unknown): ViewBlock | undefined {
  const block = asObject(value);
  if (block.type === 'text') return { type: 'text', text: asText(block.text) };
  // Only the thinking text the provider shows, never its signature or a redacted block's payload.
  if (block.type === 'thinking')
    return block.redacted === true
      ? { type: 'thinking', text: '', redacted: true }
      : { type: 'thinking', text: asText(block.thinking) };
  if (block.type === 'toolCall')
    return {
      type: 'tool',
      id: asText(block.id),
      name: asText(block.name),
      args: asObject(block.arguments),
      status: 'pending',
    };
  return undefined;
}

const blocksOf = (content: unknown): ViewBlock[] =>
  asList(content)
    .map(blockOf)
    .filter((block): block is ViewBlock => block !== undefined);

/** The id of the next message: one above the highest, so an id is never given twice. */
const nextId = (view: NativeView): string =>
  nextNumber(
    'm',
    view.messages.map((message) => message.id)
  );

/** The session entry id a record names, or undefined. */
const entryIdOf = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

function assistantOf(
  message: JsonObject,
  id: string,
  streaming: boolean,
  extra: Pick<ViewAssistantMessage, 'entryId' | 'retries'> = {}
): ViewAssistantMessage {
  const provider = asText(message.provider);
  const model = asText(message.model);
  const usage = streaming ? undefined : usageOf(message.usage);
  return {
    id,
    role: 'assistant',
    ...(extra.entryId ? { entryId: extra.entryId } : {}),
    blocks: blocksOf(message.content),
    timestamp: asNumber(message.timestamp) ?? 0,
    ...(provider && model ? { model: `${provider}/${model}` } : {}),
    ...(typeof message.stopReason === 'string' && !streaming ? { stopReason: message.stopReason } : {}),
    ...(typeof message.errorMessage === 'string' ? { errorMessage: message.errorMessage } : {}),
    streaming,
    ...(usage ? { usage } : {}),
    ...(extra.retries ? { retries: extra.retries } : {}),
  };
}

const withMessages = (view: NativeView, messages: ViewMessage[]): NativeView => ({ ...view, messages });

function replaceMessage(view: NativeView, index: number, message: ViewMessage): NativeView {
  const messages = view.messages.slice();
  messages[index] = message;
  return withMessages(view, messages);
}

function withLive(view: NativeView, live: ViewLive): NativeView {
  return { ...view, live };
}

/** The live part without one of its fields. */
function liveWithout(live: ViewLive, key: 'classifying' | 'progress' | 'retry' | 'permission'): ViewLive {
  const { [key]: _dropped, ...rest } = live;
  return rest;
}

function withStatus(view: NativeView, status: TurnStatus, error?: string): NativeView {
  const { error: _previous, ...rest } = view;
  return error === undefined ? { ...rest, status } : { ...rest, status, error };
}

/** Applies `update` to the tool call `toolCallId`, in the latest assistant message that has it. */
function updateTool(view: NativeView, toolCallId: string, update: (tool: ViewToolCall) => ViewToolCall): NativeView {
  if (!toolCallId) return view;
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index];
    if (message.role !== 'assistant') continue;
    const at = message.blocks.findIndex((block) => block.type === 'tool' && block.id === toolCallId);
    if (at < 0) continue;
    const blocks = message.blocks.slice();
    blocks[at] = update(blocks[at] as ViewToolCall);
    return replaceMessage(view, index, { ...message, blocks });
  }
  return view;
}

function finished(tool: ViewToolCall, result: ViewToolResult): ViewToolCall {
  const { partial: _partial, ...rest } = tool;
  return { ...rest, status: result.isError ? 'error' : 'done', result };
}

/**
 * A new assistant message starts: the failed attempt pi is retrying (the one a `context_edit` hid) makes way for it,
 * and the new message takes its id and counts it among its `retries`. Custom messages an extension added between the
 * two, and a compaction line, stay where they are.
 */
function addAssistant(view: NativeView, message: JsonObject, streaming: boolean, entryId?: string): NativeView {
  let retried = -1;
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const earlier = view.messages[index];
    if (earlier.role === 'custom' || earlier.role === 'compaction') continue;
    if (earlier.role === 'assistant' && earlier.retried) retried = index;
    break;
  }
  if (retried < 0)
    return withMessages(view, [...view.messages, assistantOf(message, nextId(view), streaming, { entryId })]);
  const failed = view.messages[retried] as ViewAssistantMessage;
  const next = assistantOf(message, failed.id, streaming, { entryId, retries: (failed.retries ?? 0) + 1 });
  return withMessages(view, [...view.messages.filter((_, index) => index !== retried), next]);
}

/** Where a new message starts: a live assistant message as soon as pi starts it, to stream into. */
function startMessage(view: NativeView, message: JsonObject): NativeView {
  if (message.role !== 'assistant') return view;
  return addAssistant(view, message, true);
}

/** A complete message: from `message_end` live, from a `message` entry in a file. */
function endMessage(view: NativeView, message: JsonObject, entryId?: string): NativeView {
  switch (message.role) {
    case 'assistant': {
      const last = view.messages.at(-1);
      const streamed = last?.role === 'assistant' && last.streaming;
      const next = streamed
        ? replaceMessage(
            view,
            view.messages.length - 1,
            assistantOf(message, last.id, false, { entryId, retries: last.retries })
          )
        : addAssistant(view, message, false, entryId);
      // A message that ends inside a thinking block leaves the run working, not thinking.
      return next.status === 'thinking' ? withStatus(next, 'working') : next;
    }
    case 'user':
      return withMessages(view, [
        ...view.messages,
        {
          id: nextId(view),
          role: 'user',
          ...(entryId ? { entryId } : {}),
          text: wordsOf(textOf(message.content)),
          images: imagesOf(message.content),
          timestamp: asNumber(message.timestamp) ?? 0,
        },
      ]);
    case 'toolResult':
      return updateTool(view, asText(message.toolCallId), (tool) =>
        finished(tool, resultOf(message, message.isError === true))
      );
    case 'custom':
      return customMessage(view, message, entryId);
    default:
      // The system prompt and the kinds pi keeps for itself are not part of the conversation.
      return view;
  }
}

/** Where pi compacted the conversation: a line of its own in the transcript. */
function compacted(view: NativeView, tokensBefore: number | undefined): NativeView {
  return withMessages(view, [
    ...view.messages,
    { id: nextId(view), role: 'compaction', tokensBefore: tokensBefore ?? 0 },
  ]);
}

/** A message an extension shows the person (`display: true`); one it gives only the model is not shown. */
function customMessage(view: NativeView, message: JsonObject, entryId?: string): NativeView {
  if (message.display !== true) return view;
  return withMessages(view, [
    ...view.messages,
    {
      id: nextId(view),
      role: 'custom',
      ...(entryId ? { entryId } : {}),
      customType: asText(message.customType),
      text: textOf(message.content),
    },
  ]);
}

/** A streaming delta of the live assistant message (`message_update`). */
function streamInto(view: NativeView, event: JsonObject): NativeView {
  const last = view.messages.at(-1);
  const index = asNumber(event.contentIndex);
  if (last?.role !== 'assistant' || !last.streaming || index === undefined || index < 0 || !Number.isInteger(index))
    return view;
  const blocks = last.blocks.slice();
  while (blocks.length < index) blocks.push({ type: 'text', text: '' });
  const current = blocks[index];
  let status = view.status;
  switch (event.type) {
    case 'text_start':
      blocks[index] = { type: 'text', text: '' };
      break;
    case 'text_delta':
      blocks[index] = { type: 'text', text: `${current?.type === 'text' ? current.text : ''}${asText(event.delta)}` };
      break;
    case 'text_end':
      blocks[index] = { type: 'text', text: asText(event.content) };
      break;
    case 'thinking_start':
      blocks[index] = { type: 'thinking', text: '' };
      status = 'thinking';
      break;
    case 'thinking_delta':
      blocks[index] = {
        type: 'thinking',
        text: `${current?.type === 'thinking' ? current.text : ''}${asText(event.delta)}`,
      };
      status = 'thinking';
      break;
    case 'thinking_end':
      blocks[index] = { type: 'thinking', text: asText(event.content) };
      status = 'working';
      break;
    case 'toolcall_start':
      blocks[index] = {
        type: 'tool',
        id: asText(event.id),
        name: asText(event.toolName),
        args: {},
        status: 'streaming',
      };
      break;
    case 'toolcall_end': {
      const call = asObject(event.toolCall);
      blocks[index] = {
        type: 'tool',
        id: asText(call.id) || (current?.type === 'tool' ? current.id : ''),
        name: asText(call.name) || (current?.type === 'tool' ? current.name : ''),
        args: asObject(call.arguments),
        status: 'pending',
      };
      break;
    }
    default:
      return view;
  }
  const next = replaceMessage(view, view.messages.length - 1, { ...last, blocks });
  return status === view.status || !isRunning(view.status) ? next : withStatus(next, status);
}

/**
 * One ledger record, under the turn that asked. A record seen before (the frame after its entry) counts once; a frame
 * may still name the turn of a record that did not carry it.
 */
function addJudgment(view: NativeView, data: JsonObject, frameTurn?: number): NativeView {
  const { state: _state, ...record } = data;
  const turn = asNumber(asObject(record.origin).turn) ?? frameTurn;
  const id = asText(record.id);
  const known = id ? view.judgments.findIndex((judgment) => judgment.id === id) : -1;
  if (known >= 0) {
    const judgment = view.judgments[known];
    if (judgment.turn !== undefined || turn === undefined) return view;
    const judgments = view.judgments.slice();
    judgments[known] = { ...judgment, turn };
    return { ...view, judgments };
  }
  const judgment: ViewJudgment = {
    id: id || `j${view.judgments.length + 1}`,
    ...(turn !== undefined ? { turn } : {}),
    record,
  };
  return { ...view, judgments: [...view.judgments, judgment] };
}

/** The verdict line of the latest user message. */
function attachVerdict(view: NativeView, verdict: JsonObject): NativeView {
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index];
    if (message.role === 'user') return replaceMessage(view, index, { ...message, verdict });
  }
  return view;
}

/**
 * A `context_edit` that hides an entry from the model (`replacement: null`). Only a failed assistant attempt is marked,
 * as one pi retries; any other edit is about what the model reads and changes nothing here.
 */
function contextEdit(view: NativeView, entry: JsonObject): NativeView {
  const target = asText(entry.targetId);
  if (!target || entry.replacement !== null) return view;
  const index = view.messages.findIndex((message) => message.role !== 'compaction' && message.entryId === target);
  const message = view.messages[index];
  if (message?.role !== 'assistant' || message.stopReason !== 'error' || message.retried) return view;
  return replaceMessage(view, index, { ...message, retried: true });
}

/** A session entry that is not a `message`: live from `entry_appended`, in a file as it is. */
function addEntry(view: NativeView, entry: JsonObject): NativeView {
  if (entry.type === 'custom') {
    if (entry.customType === DECISION_ENTRY) return addJudgment(view, asObject(entry.data));
    if (entry.customType === VERDICT_ENTRY) return attachVerdict(view, asObject(entry.data));
    if (entry.customType === GOAL_ENTRY) return takeGoal(view, entry.data);
    return view;
  }
  // Extensions' messages for the person that pi writes at a turn's boundary come only as entries.
  if (entry.type === 'custom_message') return customMessage(view, entry, entryIdOf(entry.id));
  if (entry.type === 'compaction') return compacted(view, asNumber(entry.tokensBefore));
  if (entry.type === 'context_edit') return contextEdit(view, entry);
  return view;
}

function openDialog(view: NativeView, record: PiRecord, method: DialogMethod): NativeView {
  const id = asText(record.id);
  if (!id) return view;
  const timeout = asNumber(record.timeout);
  const options = method === 'select' ? asList(record.options).map(asText) : undefined;
  // mu's permission question comes right after what it said about it (the CLI bridge pairs them the same way).
  const asked = view.live.permission;
  const permission =
    options && asked && asked.answers.length === options.length && asked.answers.every((a, i) => a === options[i])
      ? asked
      : undefined;
  const dialog: ViewDialog = {
    id,
    method,
    title: asText(record.title),
    ...(options ? { options } : {}),
    ...(method === 'confirm' ? { message: asText(record.message) } : {}),
    ...(method === 'input' && typeof record.placeholder === 'string' ? { placeholder: record.placeholder } : {}),
    ...(method === 'editor' && typeof record.prefill === 'string' ? { prefill: record.prefill } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    inRun: isRunning(view.status),
    ...(permission ? { permission } : {}),
  };
  const live = permission ? liveWithout(view.live, 'permission') : view.live;
  return { ...view, live, dialogs: [...view.dialogs.filter((open) => open.id !== id), dialog] };
}

function uiRequest(view: NativeView, record: PiRecord): NativeView {
  const method = asText(record.method);
  if ((DIALOG_METHODS as readonly string[]).includes(method)) return openDialog(view, record, method as DialogMethod);
  if (method === 'notify') return takeNotify(view, record);
  const frame = readPresentation(record);
  if (!frame || frame.version !== 1) return view;
  const shown = addFrame(view, frame);
  const turn = frame.correlation?.turnId;
  switch (frame.kind) {
    case 'decision':
      return addJudgment(shown, frame.payload, turn);
    case 'preflight.pending':
      return turn === undefined
        ? shown
        : withLive(shown, { ...shown.live, classifying: { turn, judge: asText(frame.payload.judge) } });
    case 'preflight.verdict':
    case 'preflight.wait_end':
      return shown.live.classifying && shown.live.classifying.turn === turn
        ? withLive(shown, liveWithout(shown.live, 'classifying'))
        : shown;
    case 'progress': {
      const code = asText(frame.payload.code);
      const step = asText(frame.payload.step);
      const params = frame.payload.params === undefined ? undefined : asObject(frame.payload.params);
      return withLive(shown, {
        ...shown.live,
        progress: {
          ...(turn !== undefined ? { turn } : {}),
          step,
          ...(code ? { code } : {}),
          ...(code && params ? { params } : {}),
        },
      });
    }
    case 'permissions.request': {
      const permission = readPermission(frame.payload);
      return permission ? withLive(shown, { ...shown.live, permission }) : shown;
    }
    case 'permissions.resolved': {
      // Answered, or given up when the run was stopped (mu then says `deny` and pi says nothing of the dialog).
      const toolCallId = asText(frame.payload.toolCallId);
      const dialogs = toolCallId
        ? shown.dialogs.filter((dialog) => dialog.permission?.toolCallId !== toolCallId)
        : shown.dialogs;
      return { ...withLive(shown, liveWithout(shown.live, 'permission')), dialogs };
    }
    case 'checkpoint.off':
      return takeCheckpointOff(shown, frame.payload);
    case GOAL_FRAME:
      return takeGoal(shown, frame.payload);
    default:
      return shown;
  }
}

/**
 * How the last run ended: its last assistant message's stop reason. A failed attempt pi meant to retry and never did
 * (the retry was stopped, or the compaction before it failed) ends the run with its error: a file cannot tell the two
 * apart, so a live run does not either.
 */
function outcome(messages: readonly ViewMessage[]): { status: TurnStatus; error?: string } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (message.stopReason === 'aborted') return { status: 'aborted' };
    if (message.stopReason === 'error') return { status: 'error', error: message.errorMessage ?? '' };
    return { status: 'settled' };
  }
  return { status: 'idle' };
}

/**
 * A run is over (`agent_settled`), or a file was read to its end: the status says how it ended, and what only a live
 * run has is dropped, dialogs pi no longer waits on included.
 */
function settle(view: NativeView): NativeView {
  const messages = view.messages.some((message) => message.role === 'assistant' && message.streaming)
    ? view.messages.map((message) =>
        message.role === 'assistant' && message.streaming ? { ...message, streaming: false } : message
      )
    : view.messages;
  const { status, error } = outcome(messages);
  return withStatus(
    {
      ...view,
      messages,
      dialogs: view.dialogs.filter((dialog) => !dialog.inRun),
      live: { compacting: view.live.compacting },
    },
    status,
    error
  );
}

/** The view after one more record of pi's stream. Records it does not use leave the view as it was. */
export function reduce(view: NativeView, record: PiRecord): NativeView {
  switch (record.type) {
    case 'agent_start':
      return addRunEvent(withStatus(view, 'working'), record);
    case 'agent_settled':
      return addRunEvent(settle(view), record);
    case 'message_start':
      return startMessage(view, asObject(record.message));
    case 'message_update':
      return streamInto(view, asObject(record.assistantMessageEvent));
    case 'message_end':
      return endMessage(view, asObject(record.message), entryIdOf(record.entryId));
    case 'tool_execution_start':
      return updateTool(view, asText(record.toolCallId), (tool) => ({ ...tool, status: 'running' }));
    case 'tool_execution_update':
      return updateTool(view, asText(record.toolCallId), (tool) => ({
        ...tool,
        partial: resultOf(record.partialResult, false),
      }));
    case 'tool_execution_end':
      return updateTool(view, asText(record.toolCallId), (tool) =>
        finished(tool, resultOf(record.result, record.isError === true))
      );
    case 'auto_retry_start':
      return withLive(view, {
        ...view.live,
        retry: {
          attempt: asNumber(record.attempt) ?? 0,
          maxAttempts: asNumber(record.maxAttempts) ?? 0,
          delayMs: asNumber(record.delayMs) ?? 0,
          error: asText(record.errorMessage),
        },
      });
    case 'auto_retry_end':
      return withLive(view, liveWithout(view.live, 'retry'));
    case 'compaction_start':
      return addRunEvent(withLive(view, { ...view.live, compacting: true }), record);
    case 'compaction_end': {
      const ended = addRunEvent(withLive(view, { ...view.live, compacting: false }), record);
      // pi saves a compaction entry that it does not announce as one: its end carries the result, or none when the
      // compaction was stopped or failed.
      const result = asObject(record.result);
      return record.aborted !== true && Object.keys(result).length > 0
        ? compacted(ended, asNumber(result.tokensBefore))
        : ended;
    }
    case 'queue_update':
      return takeQueue(view, record);
    case 'session_info_changed':
    case 'thinking_level_changed':
      return takeSessionEvent(view, record);
    case 'entry_appended':
      return addEntry(view, asObject(record.entry));
    case 'extension_ui_request':
      return uiRequest(view, record);
    case 'extension_ui_response':
      // The app's answer, handed on by the host manager: pi no longer waits on that dialog.
      return { ...view, dialogs: view.dialogs.filter((dialog) => dialog.id !== asText(record.id)) };
    case 'response': {
      // A prompt pi refused (no model, no key) ran nothing: no event says so, only its response.
      const told = takeResponse(view, record);
      return record.command === 'prompt' && record.success === false && !isRunning(view.status)
        ? withStatus(told, 'error', asText(record.error))
        : told;
    }
    default:
      return view;
  }
}

/**
 * The view of a session file: its entries (the `session` header may be among them) along the branch that ends at
 * `leafId`, which is the file's last entry when left out, as pi opens it. `null` is pi's empty branch.
 */
export function fromEntries(entries: readonly unknown[], leafId?: string | null): NativeView {
  const list = entries.map(asObject).filter((entry) => entry.type !== 'session' && typeof entry.id === 'string');
  const byId = new Map(list.map((entry) => [entry.id as string, entry]));
  const branch: JsonObject[] = [];
  const seen = new Set<string>();
  let current = leafId === null ? undefined : leafId ? byId.get(leafId) : list.at(-1);
  while (current && !seen.has(current.id as string)) {
    seen.add(current.id as string);
    branch.push(current);
    current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined;
  }
  let view = emptyView();
  for (const entry of branch.toReversed())
    view =
      entry.type === 'message' ? endMessage(view, asObject(entry.message), entryIdOf(entry.id)) : addEntry(view, entry);
  return settle(view);
}

/** The view of a whole recorded stream, from an empty one or from a view to continue (a resumed session). */
export const reduceAll = (records: readonly PiRecord[], from: NativeView = emptyView()): NativeView =>
  records.reduce(reduce, from);
