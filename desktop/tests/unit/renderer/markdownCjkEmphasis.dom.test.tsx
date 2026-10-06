/**
 * Bold after Chinese punctuation. Plain CommonMark does not close `**` that sits between a punctuation mark and a
 * letter, so a model's `**确认一个范围问题：**你说的` showed its asterisks. The shared plugin set reads it as bold.
 */

import { render } from '@testing-library/react';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import { describe, expect, it } from 'vitest';

import { MARKDOWN_REMARK_PLUGINS } from '@renderer/components/Markdown/markdownComponents';

const rendered = (markdown: string) =>
  render(<ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{markdown}</ReactMarkdown>).container;

describe('emphasis next to CJK punctuation', () => {
  it('closes bold after a full-width colon followed by a letter', () => {
    const page = rendered('**确认一个范围问题：**你说的是哪一种？');
    expect(page.querySelector('strong')).toHaveTextContent('确认一个范围问题：');
    expect(page).not.toHaveTextContent('**');
  });

  it('opens bold before a full-width bracket', () => {
    const page = rendered('这是**（重点）**内容，也是**「引号」**里的。');
    expect([...page.querySelectorAll('strong')].map((node) => node.textContent)).toEqual(['（重点）', '「引号」']);
  });

  it('leaves English emphasis as it was', () => {
    const page = rendered('Some **bold**, and 2 * 3 * 4 stays as it is.');
    expect(page.querySelector('strong')).toHaveTextContent('bold');
    expect(page).toHaveTextContent('2 * 3 * 4');
  });
});
