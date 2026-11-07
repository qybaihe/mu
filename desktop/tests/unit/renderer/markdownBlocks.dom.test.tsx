import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { describe, expect, it } from 'vitest';
import { MARKDOWN_REMARK_PLUGINS } from '@/renderer/components/Markdown/markdownComponents';
import { splitMarkdownBlocks } from '@/renderer/components/Markdown/markdownUtils';

/**
 * A reply is parsed one top-level block at a time, so a growing reply parses again only its last block. A cut must
 * never change what the Markdown says: each sample is drawn whole and block by block, and the two must match.
 */

// The whole text puts a line break between its top-level elements; that is whitespace between blocks, which draws as
// nothing, so it is left out of the comparison.
const html = (text: string) =>
  renderToStaticMarkup(<ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{text}</ReactMarkdown>).replace(
    />\n</g,
    '><'
  );
const byBlocks = (text: string) => splitMarkdownBlocks(text).map(html).join('');

const SAMPLES: Record<string, string> = {
  paragraphs: 'First paragraph.\n\nSecond **bold** paragraph.\n\nThird.',
  headingAndList: '# Title\n\nIntro line.\n\n- one\n- two\n\n- three, loose\n\nAfter the list.',
  orderedLoose: '1. first\n\n2. second\n\n3. third\n\nDone.',
  nestedList: '- top\n\n  continued under top\n\n  - nested\n\nOut.',
  fenceWithBlankLines: 'Before.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.',
  tildeFence: '~~~\nraw\n\nstill raw\n~~~\n\nText.',
  openFence: 'Before.\n\n```py\nprint(1)\n\nprint(2)',
  mathBlock: 'Formula:\n\n$$\na = b\n\nc = d\n$$\n\nAfter.',
  blockquote: '> quoted\n>\n> more quote\n\nPlain.',
  table: '| a | b |\n|---|---|\n| 1 | 2 |\n\nBelow the table.',
  indentedCode: 'Para.\n\n    code line\n\n    more code\n\nPara again.',
  setextHeading: 'Heading\n=======\n\nBody.',
  cjk: '这是**粗体**文字。\n\n第二段。',
  thematicBreak: 'Above.\n\n---\n\nBelow.',
};

describe('a reply cut into its blocks', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    it(`draws ${name} exactly as the whole does`, () => {
      expect(byBlocks(text)).toBe(html(text));
    });
  }

  it('cuts between paragraphs, so a growing reply parses again only its last block', () => {
    expect(splitMarkdownBlocks('One.\n\nTwo.\n\nThr')).toEqual(['One.\n', 'Two.\n', 'Thr']);
  });

  it('keeps a code fence whole, blank lines and all, even before it closes', () => {
    expect(splitMarkdownBlocks('Intro.\n\n```\na\n\nb\n```\n\nEnd.')).toEqual([
      'Intro.\n',
      '```\na\n\nb\n```\n',
      'End.',
    ]);
    expect(splitMarkdownBlocks('Intro.\n\n```\na\n\nb')).toEqual(['Intro.\n', '```\na\n\nb']);
  });

  it('does not cut text whose links are defined elsewhere in it, nor one with an HTML comment', () => {
    const referenced = 'See [the docs][d].\n\nMore.\n\n[d]: https://example.com';
    expect(splitMarkdownBlocks(referenced)).toEqual([referenced]);
    expect(byBlocks(referenced)).toBe(html(referenced));
    const commented = 'A\n\n<!-- a\n\nb -->\n\nB';
    expect(splitMarkdownBlocks(commented)).toEqual([commented]);
  });

  it('keeps a reply with no blank line as one block', () => {
    expect(splitMarkdownBlocks('just one line')).toEqual(['just one line']);
  });
});
