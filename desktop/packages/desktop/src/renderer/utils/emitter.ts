/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import EventEmitter from 'eventemitter3';
import type { DependencyList } from 'react';
import { useEffect } from 'react';
import type { FileOrFolderItem } from '@/renderer/utils/file/fileTypes';
import type { PreviewContentType } from '@/common/types/office/preview';

/** What became of a command the app sent: waiting for the agent to be idle, sent, or dropped. */
export type SendBoxCommandState = 'waiting' | 'sent' | 'dropped';

export type ReplyQuote = {
  messageId: string;
  content: string;
  position: 'left' | 'right' | 'center' | 'pop';
};

interface EventTypes {
  // The 2nd arg is the target conversation id: only the send box whose
  // conversation matches consumes the event (team renders one send box per
  // member column, so a bare type prefix alone would leak to same-type peers).
  // `undefined` = no target = any same-type box accepts (back-compat).
  'builtinAgent.selected.file': [Array<string | FileOrFolderItem>, string | undefined];
  'builtinAgent.selected.file.append': [Array<string | FileOrFolderItem>, string | undefined];
  'builtinAgent.selected.file.clear': void;
  'builtinAgent.workspace.refresh': void;
  'acp.selected.file': [Array<string | FileOrFolderItem>, string | undefined];
  'acp.selected.file.append': [Array<string | FileOrFolderItem>, string | undefined];
  'acp.selected.file.clear': void;
  'acp.workspace.refresh': void;
  'codex.selected.file': [Array<string | FileOrFolderItem>, string | undefined];
  'codex.selected.file.append': [Array<string | FileOrFolderItem>, string | undefined];
  'codex.selected.file.clear': void;
  'codex.workspace.refresh': void;
  'chat.history.refresh': void;
  // 会话删除事件 / Conversation deletion event
  'conversation.deleted': [string]; // conversation_id
  // 预览面板事件 / Preview panel events
  'preview.open': [
    { content: string; contentType: PreviewContentType; metadata?: { title?: string; file_name?: string } },
  ];
  // 填充输入框事件 / Fill sendbox input event
  'sendbox.fill': [string]; // prompt text to fill
  'sendbox.reply': [ReplyQuote]; // reply/quote a message
  'sendbox.reply.clear': void; // clear reply quote
  /**
   * A command the app sends into a conversation for the person, as if typed: mu's board switch sends `/board on`.
   * Sent at once when the agent is idle; while it works, the latest one waits and goes out as soon as it is idle
   * (not through the message queue, whose default is to hold). The 2nd arg is the target conversation id; only that
   * conversation's send box reacts. The 3rd hears what became of it.
   */
  'sendbox.command': [string, string, ((state: SendBoxCommandState) => void)?];
  /**
   * Mention a conversation in the send box, target already resolved.
   *
   * Emitted by the conversation chip / delivery badge on an earlier message, so a
   * target that was hard to find once does not have to be found again — the chip
   * carries the id, which also side-steps the ambiguity of twenty conversations
   * sharing a name.
   *
   * Carries the id, NOT just the name: the send box inserts the token AND
   * attaches the reference, because a token with nothing behind it is exactly the
   * silent failure this feature keeps producing.
   *
   * The 2nd arg is the target conversation id, same as the file lanes above: only
   * the send box of that conversation may react.
   */
  'sendbox.mention.session': [{ id: string; name: string }, string | undefined];
  /** Open the command palette, or close it when it is open: Cmd/Ctrl+K and the sidebar's search entry. */
  'commandPalette.toggle': void;
  /** Open quick open, or close it when it is open: Cmd/Ctrl+P and the command palette's row. */
  'quickOpen.toggle': void;
  /** Go to the next native conversation that wants its person: the command palette's row (Cmd/Ctrl+Shift+A's twin). */
  'conversation.nextWaiting': void;
  /** Open the message search with a query already typed in: the command palette hands its query on. */
  'conversationSearch.open': [string];
  /**
   * The backend checked mu again (recheckMu: after a save, a sign-in, a sign-out): a copy of what mu offers is read
   * again, so a signed-out account's models leave every list at once.
   */
  'mu.rechecked': void;
  /** The app changed mu's settings files outside a settings save (a sign-out moved the default model). */
  'mu.files.changed': void;
}

export const emitter = new EventEmitter<EventTypes>();

export const addEventListener = <T extends EventEmitter.EventNames<EventTypes>>(
  event: T,
  fn: EventEmitter.EventListener<EventTypes, T>
) => {
  emitter.on(event, fn);
  return () => {
    emitter.off(event, fn);
  };
};

export const useAddEventListener = <T extends EventEmitter.EventNames<EventTypes>>(
  event: T,
  fn: EventEmitter.EventListener<EventTypes, T>,
  deps?: DependencyList
) => {
  useEffect(() => {
    return addEventListener(event, fn);
  }, deps || []);
};
