/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { hasThinkTags, stripThinkTags } from './thinkTagFilter';
import { hasSkillSuggest, stripSkillSuggest } from './skillSuggestParser';

/**
 * Turn-level copy support. An AI reply can be split into several stored text
 * messages (tool calls and thinking interleave and break the stream into
 * segments). The hover copy row appears once per turn, on the turn's LAST
 * text message — but copying only that message loses every earlier segment.
 * This module groups the timeline into turns so the button copies the whole
 * reply the user actually read.
 */

/** Structural subset of a processed timeline item the grouping needs. */
export interface TurnCopyItem {
  id: string;
  type?: string;
  position?: string;
  content?: unknown;
}

export interface AiCopyRows {
  /** Ids of the text messages that carry the per-turn copy/timestamp row. */
  copyRowIds: Set<string>;
  /** Copy-row id → raw contents of EVERY text segment in that turn, in order. */
  turnTextsById: Map<string, string[]>;
  /** Copy-row id → whether the turn ran any tool (the claims marker's `worked`). */
  turnWorkedById: Map<string, boolean>;
}

/** Pseudo timeline entries that neither end a turn nor carry copyable text. */
const PSEUDO_TYPES = new Set(['file_summary', 'tool_summary', 'artifact']);

/** A teammate's group-chat bubble: real text, but not the assistant's own words — it closes the assistant's turn, then stands alone. */
const isTeammateText = (item: TurnCopyItem): boolean =>
  item.type === 'text' && Boolean((item.content as { teammateMessage?: unknown } | undefined)?.teammateMessage);

/** Timeline entries that mean real work happened in the turn (a tool ran). */
const TOOL_TYPES = new Set(['tool_call', 'tool_group', 'acp_tool_call']);

/**
 * Group the visible timeline into AI turns. A turn runs until the next user
 * (right) message; tool/thinking/pseudo items neither end it nor contribute
 * text. While the conversation is still streaming, the final turn's row (and
 * its texts) is withheld so the row does not appear and then shift down as
 * more text streams in.
 */
export function collectAiCopyRows(items: TurnCopyItem[], isProcessing: boolean): AiCopyRows {
  const copyRowIds = new Set<string>();
  const turnTextsById = new Map<string, string[]>();
  const turnWorkedById = new Map<string, boolean>();
  let pendingTextId: string | undefined;
  let turnTexts: string[] = [];
  let turnWorked = false;

  const flush = () => {
    if (pendingTextId) {
      copyRowIds.add(pendingTextId);
      turnTextsById.set(pendingTextId, turnTexts);
      turnWorkedById.set(pendingTextId, turnWorked);
      // Tools count per visible reply: once a reply closed the burst, the next
      // one starts clean. A burst that ends without any text (a mid-turn user
      // message arriving before the agent wrote anything) keeps its tool use:
      // the reply that follows answers both messages and ran in the same turn.
      turnWorked = false;
    }
    pendingTextId = undefined;
    turnTexts = [];
  };

  for (const item of items) {
    if (item.type && PSEUDO_TYPES.has(item.type)) {
      continue;
    }
    if (item.position === 'right' || isTeammateText(item)) {
      flush();
      continue;
    }
    if (item.type && TOOL_TYPES.has(item.type)) {
      turnWorked = true;
      continue;
    }
    if (item.type === 'text') {
      pendingTextId = item.id;
      const raw = (item.content as { content?: unknown } | undefined)?.content;
      if (typeof raw === 'string' && raw.trim()) {
        turnTexts.push(raw);
      }
    }
  }
  // The final turn is the one that may still be streaming; hide its row until done.
  const lastTurnTextId = pendingTextId;
  flush();
  if (isProcessing && lastTurnTextId) {
    copyRowIds.delete(lastTurnTextId);
    turnTextsById.delete(lastTurnTextId);
    turnWorkedById.delete(lastTurnTextId);
  }
  return { copyRowIds, turnTextsById, turnWorkedById };
}

/**
 * Join a turn's text segments into one clipboard payload: each segment is
 * cleaned the same way rendering cleans it (think tags and skill-suggest
 * blocks stripped), empties dropped, and the rest joined with a blank line —
 * the reply as the user read it, in Markdown source form.
 */
export function buildTurnClipboardText(segments: string[]): string {
  return segments
    .map((segment) => {
      let cleaned = segment;
      if (hasThinkTags(cleaned)) {
        cleaned = stripThinkTags(cleaned);
      }
      if (hasSkillSuggest(cleaned)) {
        cleaned = stripSkillSuggest(cleaned);
      }
      return cleaned.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}
