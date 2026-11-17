/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end guard for the split-segment repair: the backend persists one
 * streamed reply as several `text` rows (each with its own msg_id), which cut
 * the mu-ui fence of conversation 81f6ca8e in half - the fence stopped parsing
 * and the card fell back to a code block. Replays the two real rows
 * (2c55b8c9 + 86ea6505) through the history-load coalescing, then through
 * MarkdownView: the merged text must render the mu-ui card, and the second
 * (dsh-ui) fence in the same reply must stay a plain code block.
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

const shadowHtml = (container: HTMLElement): string => {
  const host = container.querySelector('.markdown-shadow') as (HTMLElement & { shadowRoot?: ShadowRoot }) | null;
  return host?.shadowRoot?.innerHTML ?? '(no shadow)';
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

  it('renders the repaired fence as a card, and the dsh-ui fence stays code', () => {
    const coalesced = coalesceAdjacentTextSegments([
      segment('2c55b8c9', SEG_2C55B8C9),
      segment('86ea6505', SEG_86EA6505),
    ]);
    const merged = (coalesced[0] as IMessageText).content.content;

    const { container } = render(<MarkdownView>{merged}</MarkdownView>);
    const html = shadowHtml(container);

    // The mu-ui fence parses again and renders as the structured card. The
    // callout's `**...**` markdown only becomes <strong> through the card's
    // own MdText renderer - as a code block it would stay literal asterisks,
    // and at top level it sits inside a fence, so <strong> here proves the
    // card rendered.
    expect(html).toContain('<strong>分支 feat/mu-ui-block @ 247a05d</strong>');
    // The mu-ui fence never falls back to a code-block footer (the card also
    // shows the literal text "mu-ui" as a stat value, so assert on the footer
    // shape, and on the second fence's footer instead).
    expect(html).toContain('>dsh-ui</span>');
    const muUiFooters = html.match(/border-bottom[^>]*>\s*<span[^>]*>mu-ui<\/span>/g) ?? [];
    expect(muUiFooters).toHaveLength(0);
  });
});
