/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The backend persists a streaming reply snapshot-by-snapshot: one turn's reply
 * lands as several `text` rows, each with its own msg_id and no shared turn id,
 * and the turn end does not merge them. A reply whose text contains a fenced
 * block gets cut mid-fence, so the fence no longer parses and the card is lost.
 *
 * These tests replay the exact rows the backend wrote for two real turns
 * (conversation 81f6ca8e: 2c55b8c9 + 86ea6505, cut mid-JSON; conversation
 * ce2061d8: e2083ff1 + 57c9f02a, cut inside the CJK word "正名验证") through the
 * builders the renderer uses when loading history, prepending an earlier page,
 * reconciling a live list with a reload, and composing live frames.
 */

import { describe, expect, it } from 'vitest';
import type { IMessageText, TMessage } from '@/common/chat/chatLib';
import {
  buildMessageIndex,
  composeMessageWithIndex,
  coalesceAdjacentTextSegments,
  mergeLoadedPageWithCurrent,
  normalizeDbMessage,
  prependHistoryMessages,
} from '@/renderer/pages/conversation/Messages/hooks';

// Real persisted segment texts (db: aionui-backend.db, conversation 81f6ca8e).
const SEG_2C55B8C9 =
  '```mu-ui\n{"title":"mu-ui 正名验证","items":[{"type":"row","items":[{"type":"stat","label":"dsh 残留","value":"0","delta":"-100%"},{"type":"stat","label":"单测","value":"10/10"},{"type":"stat","label":"围栏语言","value":"mu-ui"}]},{"type":"table","';
const SEG_86EA6505 =
  'columns":["语言标签","预期表现"],"rows":[["mu-ui","渲染成结构化卡片"],["dsh-ui","只显示为普通代码块"]]},{"type":"callout","tone":"success","title":"改名完成","content":"**分支 feat/mu-ui-block @ 247a05d**，正式版发布前仅 dev 生效"}]}\n```\n\n---第二段---\n\n```dsh-ui\n{"title":"mu-ui 正名验证","items":[{"type":"row","items":[{"type":"stat","label":"dsh 残留","value":"0","delta":"-100%"},{"type":"stat","label":"单测","value":"10/10"},{"type":"stat","label":"围栏语言","value":"mu-ui"}]},{"type":"table","columns":["语言标签","预期表现"],"rows":[["mu-ui","渲染成结构化卡片"],["dsh-ui","只显示为普通代码块"]]},{"type":"callout","tone":"success","title":"改名完成","content":"**分支 feat/mu-ui-block @ 247a05d**，正式版发布前仅 dev 生效"}]}\n```';
// Real persisted segment texts (conversation ce2061d8), cut inside "正名验证".
const SEG_E2083FF1 = '```mu-ui\n{"title":"mu-ui 正';
const SEG_57C9F02A =
  '名验证","items":[{"type":"row","items":[{"type":"stat","label":"dsh 残留","value":"0","delta":"-100%"},{"type":"stat","label":"单测","value":"10/10"},{"type":"stat","label":"围栏语言","value":"mu-ui"}]},{"type":"table","columns":["语言标签","预期表现"],"rows":[["mu-ui","渲染成结构化卡片"],["dsh-ui","只显示为普通代码块"]]},{"type":"callout","tone":"success","title":"改名完成","content":"**分支 feat/mu-ui-block @ 247a05d**，正式版发布前仅 dev 生效"}]}\n```\n\n---第二段---\n\n```dsh-ui\n{"title":"mu-ui 正名验证","items":[{"type":"row","items":[{"type":"stat","label":"dsh 残留","value":"0","delta":"-100%"},{"type":"stat","label":"单测","value":"10/10"},{"type":"stat","label":"围栏语言","value":"mu-ui"}]},{"type":"table","columns":["语言标签","预期表现"],"rows":[["mu-ui","渲染成结构化卡片"],["dsh-ui","只显示为普通代码块"]]},{"type":"callout","tone":"success","title":"改名完成","content":"**分支 feat/mu-ui-block @ 247a05d**，正式版发布前仅 dev 生效"}]}\n```';
const REPLY_81F6 = SEG_2C55B8C9 + SEG_86EA6505;

const textRow = (id: string, content: string, position: 'left' | 'right' = 'left'): IMessageText => ({
  id,
  msg_id: id,
  conversation_id: 'conv-1',
  type: 'text',
  position,
  created_at: 1,
  content: { content },
});

// A row as it arrives from the REST page: content is a JSON string, normalized on load.
const dbTextRow = (id: string, raw: string): IMessageText =>
  normalizeDbMessage({ ...textRow(id, ''), content: JSON.stringify({ content: raw }) as unknown }) as IMessageText;

const thinkingRow = (id: string): TMessage => ({
  id,
  msg_id: id,
  conversation_id: 'conv-1',
  type: 'thinking',
  position: 'left',
  content: { content: 'a thought', status: 'done' },
});

const toolRow = (id: string): TMessage => ({
  id,
  msg_id: id,
  conversation_id: 'conv-1',
  type: 'acp_tool_call',
  position: 'left',
  content: {
    sessionId: 's',
    update: { sessionUpdate: 'tool_call_update', tool_call_id: id, status: 'completed', title: 't', kind: 'execute' },
  },
});

describe('coalescing backend-split text segments on history load', () => {
  it('joins the split rows of the 81f6ca8e reply into one message, byte-exact', () => {
    const coalesced = coalesceAdjacentTextSegments([
      dbTextRow('2c55b8c9', SEG_2C55B8C9),
      dbTextRow('86ea6505', SEG_86EA6505),
    ]);

    expect(coalesced).toHaveLength(1);
    const merged = coalesced[0] as IMessageText;
    expect(merged.content.content).toBe(REPLY_81F6);
    expect(merged.id).toBe('2c55b8c9');
    expect(merged.msg_id).toBe('2c55b8c9');
  });

  it('joins the ce2061d8 pair whose cut falls inside a CJK word', () => {
    expect(SEG_E2083FF1.endsWith('mu-ui 正')).toBe(true);
    expect(SEG_57C9F02A.startsWith('名验证')).toBe(true);

    const coalesced = coalesceAdjacentTextSegments([
      dbTextRow('e2083ff1', SEG_E2083FF1),
      dbTextRow('57c9f02a', SEG_57C9F02A),
    ]);
    expect(coalesced).toHaveLength(1);
    expect((coalesced[0] as IMessageText).content.content).toBe(SEG_E2083FF1 + SEG_57C9F02A);
  });

  it('leaves user rows, tool rows and thinking rows untouched around the merge', () => {
    const coalesced = coalesceAdjacentTextSegments([
      textRow('user-1', 'question', 'right'),
      toolRow('tool-1'),
      thinkingRow('think-1'),
      dbTextRow('2c55b8c9', SEG_2C55B8C9),
      dbTextRow('86ea6505', SEG_86EA6505),
    ]);

    expect(coalesced).toHaveLength(4);
    expect(coalesced[0].position).toBe('right');
    expect(coalesced[0].type).toBe('text');
    expect(coalesced[1].type).toBe('acp_tool_call');
    expect(coalesced[2].type).toBe('thinking');
    expect((coalesced[3] as IMessageText).content.content).toBe(REPLY_81F6);
  });

  it('does not merge text across an interleaved thinking row', () => {
    const coalesced = coalesceAdjacentTextSegments([
      dbTextRow('a', 'first part'),
      thinkingRow('think-1'),
      dbTextRow('b', 'second part'),
    ]);

    expect(coalesced).toHaveLength(3);
    expect((coalesced[0] as IMessageText).content.content).toBe('first part');
    expect((coalesced[2] as IMessageText).content.content).toBe('second part');
  });

  it('never merges user (right) rows into the reply above them', () => {
    const coalesced = coalesceAdjacentTextSegments([
      dbTextRow('a', 'reply'),
      textRow('u', 'next question', 'right'),
      dbTextRow('b', 'next reply'),
    ]);

    expect(coalesced).toHaveLength(3);
    expect(coalesced.map((row) => row.position)).toEqual(['left', 'right', 'left']);
  });

  it('never merges teammate rows', () => {
    const teammate = { ...textRow('t', 'teammate note'), content: { content: 'teammate note', teammateMessage: true } };

    const coalesced = coalesceAdjacentTextSegments([
      dbTextRow('a', 'reply'),
      teammate,
      dbTextRow('b', 'reply continues'),
    ]);

    expect(coalesced).toHaveLength(3);
    expect(coalesced.map((row) => row.id)).toEqual(['a', 't', 'b']);
  });

  it('drops a persisted duplicate of a segment the row above already absorbed', () => {
    const liveMerged = dbTextRow('2c55b8c9', REPLY_81F6);
    const persistedTail = dbTextRow('86ea6505', SEG_86EA6505);

    const coalesced = coalesceAdjacentTextSegments([liveMerged, persistedTail]);

    expect(coalesced).toHaveLength(1);
    expect((coalesced[0] as IMessageText).content.content).toBe(REPLY_81F6);
  });
});

describe('the loaded page paths the renderer uses', () => {
  it('mergeLoadedPageWithCurrent coalesces a fresh conversation load', () => {
    const page = [
      textRow('user-1', 'question', 'right'),
      thinkingRow('think-1'),
      dbTextRow('2c55b8c9', SEG_2C55B8C9),
      dbTextRow('86ea6505', SEG_86EA6505),
    ];

    const list = mergeLoadedPageWithCurrent('conv-1', page, []);

    expect(list).toHaveLength(3);
    expect((list[2] as IMessageText).content.content).toBe(REPLY_81F6);
  });

  it('mergeLoadedPageWithCurrent reconciling a live list does not double the text', () => {
    // Live: the turn's frames were composed live into one row, plus the pending user row.
    const liveList = [
      { ...textRow('user-1', 'question', 'right'), status: 'pending' as const },
      dbTextRow('2c55b8c9', REPLY_81F6),
    ];
    // The turn finished; the reload brings back the persisted split rows.
    const page = [
      textRow('user-1', 'question', 'right'),
      dbTextRow('2c55b8c9', SEG_2C55B8C9),
      dbTextRow('86ea6505', SEG_86EA6505),
    ];

    const list = mergeLoadedPageWithCurrent('conv-1', page, liveList);

    const textRows = list.filter((row) => row.type === 'text' && row.position === 'left');
    expect(textRows).toHaveLength(1);
    expect((textRows[0] as IMessageText).content.content).toBe(REPLY_81F6);
  });

  it('prependHistoryPages merges a reply split across the page boundary', () => {
    const currentList = [dbTextRow('86ea6505', SEG_86EA6505)];
    const olderPage = [thinkingRow('think-1'), dbTextRow('2c55b8c9', SEG_2C55B8C9)];

    const list = prependHistoryMessages(currentList, olderPage);

    expect(list).toHaveLength(2);
    expect(list[0].type).toBe('thinking');
    expect((list[1] as IMessageText).content.content).toBe(REPLY_81F6);
    expect(list[1].id).toBe('2c55b8c9');
  });
});

describe('composing live frames of one reply', () => {
  it('appends a continuation frame under a new msg_id to the row above it', () => {
    let list: TMessage[] = [];
    let index = buildMessageIndex(list);
    list = composeMessageWithIndex({ ...dbTextRow('2c55b8c9', SEG_2C55B8C9), status: 'work' }, list, index);
    index = buildMessageIndex(list);
    list = composeMessageWithIndex({ ...dbTextRow('86ea6505', SEG_86EA6505), status: 'work' }, list, index);

    expect(list).toHaveLength(1);
    expect((list[0] as IMessageText).content.content).toBe(REPLY_81F6);
    expect(list[0].id).toBe('2c55b8c9');
  });

  it('a third frame under the absorbed msg_id keeps growing the same row', () => {
    let list: TMessage[] = [];
    let index = buildMessageIndex(list);
    list = composeMessageWithIndex(dbTextRow('2c55b8c9', 'part1-'), list, index);
    index = buildMessageIndex(list);
    list = composeMessageWithIndex(dbTextRow('86ea6505', 'part2-'), list, index);
    index = buildMessageIndex(list);
    // buildMessageIndex rebuilt from the list: the absorbed msg_id must resolve to the merged row.
    list = composeMessageWithIndex({ ...dbTextRow('86ea6505', ''), content: { content: 'part3' } }, list, index);

    expect(list).toHaveLength(1);
    expect((list[0] as IMessageText).content.content).toBe('part1-part2-part3');
  });

  it('keeps separate rows when a user message sits between two left texts', () => {
    let list: TMessage[] = [];
    let index = buildMessageIndex(list);
    list = composeMessageWithIndex(dbTextRow('a', 'reply one'), list, index);
    index = buildMessageIndex(list);
    list = composeMessageWithIndex(textRow('u', 'question', 'right'), list, index);
    index = buildMessageIndex(list);
    list = composeMessageWithIndex(dbTextRow('b', 'reply two'), list, index);

    expect(list).toHaveLength(3);
    expect(list.map((row) => (row as IMessageText).content.content)).toEqual(['reply one', 'question', 'reply two']);
  });
});
