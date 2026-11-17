/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DOM-level guard for the split-segment repair: the backend persists one
 * streamed reply as several `text` rows (each with its own msg_id), which can
 * cut a fenced block in half - the fence stopped parsing, and the tail of the
 * reply drew as loose paragraphs. Replays the two real rows (2c55b8c9 +
 * 86ea6505) through the history-load coalescing, then through MarkdownView:
 * the merged reply must draw one complete fenced block whose JSON body parses
 * again, and the second fence of the same reply stays a block of its own.
 */

import { render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { IMessageText } from '@/common/chat/chatLib';
import MarkdownView from '@renderer/components/Markdown';
import { coalesceAdjacentTextSegments } from '@renderer/pages/conversation/Messages/hooks';

// Real persisted segment texts (db: aionui-backend.db, conversation 81f6ca8e).
const SEG_2C55B8C9 =
  '```mu-ui\n{"title":"mu-ui 正名验证","items":[{"type":"row","items":[{"type":"stat","label":"dsh 残留","value":"0","delta":"-100%"},{"type":"stat","label":"单测","value":"10/10"},{"type":"stat","label":"围栏语言","value":"mu-ui"}]},{"type":"table","';
const SEG_86EA6505 =
  'columns":["语言标签","预期表现"],"rows":[["mu-ui","渲染成结构化卡片"],["dsh-ui","只显示为普通代码块"]]},{"type":"callout","tone":"success","title":"改名完成","content":"**分支 feat/mu-ui-block @ 247a05d**，正式版发布前仅 dev 生效"}]}\n```\n\n---第二段---\n\n```dsh-ui\n{"title":"mu-ui 正名验证","items":[{"type":"row","items":[{"type":"stat","label":"dsh 残留","value":"0","delta":"-100%"},{"type":"stat","label":"单测","value":"10/10"},{"type":"stat","label":"围栏语言","value":"mu-ui"}]},{"type":"table","columns":["语言标签","预期表现"],"rows":[["mu-ui","渲染成结构化卡片"],["dsh-ui","只显示为普通代码块"]]},{"type":"callout","tone":"success","title":"改名完成","content":"**分支 feat/mu-ui-block @ 247a05d**，正式版发布前仅 dev 生效"}]}\n```';

const segment = (id: string, content: string): IMessageText => ({
  id,
  msg_id: id,
  conversation_id: 'conv-1',
  type: 'text',
  position: 'left',
  created_at: 1,
  content: { content },
});

const shadowRootOf = (container: HTMLElement): ShadowRoot => {
  const host = container.querySelector('.markdown-shadow') as (HTMLElement & { shadowRoot?: ShadowRoot }) | null;
  expect(host?.shadowRoot).toBeTruthy();
  return host!.shadowRoot!;
};

/** The fenced blocks MarkdownView drew, as {label, code} pairs: a block's header carries a bottom border, its label span is the header's first child, the code follows as the header's next sibling. */
const fenceBlocks = (shadow: ShadowRoot): { label: string; code: string }[] =>
  Array.from(shadow.querySelectorAll('div'))
    .filter((div) => div.style.borderBottom !== '' && div.firstElementChild?.tagName === 'SPAN')
    .map((header) => ({
      label: header.firstElementChild?.textContent ?? '',
      code: header.nextElementSibling?.textContent ?? '',
    }));

const renderMerged = (segments: IMessageText[]) => {
  const coalesced = coalesceAdjacentTextSegments(segments);
  const merged = (coalesced[0] as IMessageText).content.content;
  const { container } = render(<MarkdownView>{merged}</MarkdownView>);
  return { merged, shadow: shadowRootOf(container) };
};

describe('a reply the backend persisted as split text segments', () => {
  it('coalesces into one message whose text is the byte-exact concatenation', () => {
    const coalesced = coalesceAdjacentTextSegments([
      segment('2c55b8c9', SEG_2C55B8C9),
      segment('86ea6505', SEG_86EA6505),
    ]);

    expect(coalesced).toHaveLength(1);
    expect((coalesced[0] as IMessageText).content.content).toBe(SEG_2C55B8C9 + SEG_86EA6505);
  });

  it('renders the repaired fence as one block whose JSON is whole again', () => {
    const { shadow } = renderMerged([segment('2c55b8c9', SEG_2C55B8C9), segment('86ea6505', SEG_86EA6505)]);

    const blocks = fenceBlocks(shadow);
    expect(blocks.map((block) => block.label)).toEqual(['mu-ui', 'dsh-ui']);

    // The split cut this JSON in half; joined, the block's body parses again.
    // (CodeBlock pretty-prints a body it can parse, so parse the drawn text.)
    const card = JSON.parse(blocks[0].code);
    expect(card).toMatchObject({ title: 'mu-ui 正名验证' });
    expect(card.items[1]).toMatchObject({ columns: ['语言标签', '预期表现'] });
    expect(() => JSON.parse(blocks[1].code)).not.toThrow();

    // The tail of the second segment no longer draws as loose paragraphs: the
    // only paragraph left is the prose between the two fences.
    expect(Array.from(shadow.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['---第二段---']);
  });

  it('without the repair the first segment alone stays unparseable', () => {
    // Documents what the coalescing fixes: the first row's fence is unterminated,
    // so its body is cut mid-JSON and never parses on its own.
    const { shadow } = renderMerged([segment('2c55b8c9', SEG_2C55B8C9)]);

    const blocks = fenceBlocks(shadow);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].label).toBe('mu-ui');
    expect(() => JSON.parse(blocks[0].code)).toThrow();
  });
});
