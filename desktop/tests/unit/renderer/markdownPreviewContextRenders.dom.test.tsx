/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Every message of a conversation reads the preview panel's context, which changes whenever a tab opens, loads or
 * updates. When that redrew each message's markdown, every code block of the conversation was highlighted again: a
 * turn in a 30-turn conversation spent two of its three seconds highlighting code nobody changed. A change in the
 * panel leaves the markdown alone, and a link still opens in the panel as it is now.
 */

import React, { createContext, useContext, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownView from '@/renderer/components/Markdown';

type Panel = { openBrowserTab: (url?: string) => void; tabs: string[] };

const codeRenders = vi.hoisted(() => ({ count: 0 }));
const TestPreviewContext = vi.hoisted(() => ({ current: null as React.Context<Panel | null> | null }));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => useContext(TestPreviewContext.current as React.Context<Panel | null>),
}));

vi.mock('@/renderer/components/Markdown/ShadowView', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/Markdown/CodeBlock', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => {
    codeRenders.count += 1;
    return <code>{children}</code>;
  },
}));

vi.mock('@/renderer/components/media/LocalImageView', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

vi.mock('@/renderer/utils/chat/latexDelimiters', () => ({
  convertLatexDelimiters: (text: string) => text,
}));

vi.mock('@/renderer/utils/platform', () => ({
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

// react-i18next hands out the same translation function until the language changes.
const translation = vi.hoisted(() => ({
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => translation,
}));

TestPreviewContext.current = createContext<Panel | null>(null);

const TEXT = [
  'A reply with a link to [the docs](https://example.com/docs).',
  '',
  '```ts',
  'const a = 1;',
  'const b = 2;',
  '```',
].join('\n');

let setPanel: (panel: Panel) => void = () => {};

function Host({ first }: { first: Panel }) {
  const [panel, set] = useState(first);
  setPanel = set;
  const Provider = (TestPreviewContext.current as React.Context<Panel | null>).Provider;
  return (
    <Provider value={panel}>
      <MarkdownView>{TEXT}</MarkdownView>
    </Provider>
  );
}

describe('MarkdownView and the preview panel', () => {
  beforeEach(() => {
    codeRenders.count = 0;
  });

  it('does not draw its code again when the preview panel changes', () => {
    render(<Host first={{ openBrowserTab: vi.fn(), tabs: [] }} />);
    const drawn = codeRenders.count;
    expect(drawn).toBeGreaterThan(0);

    act(() => setPanel({ openBrowserTab: vi.fn(), tabs: ['a.ts'] }));
    act(() => setPanel({ openBrowserTab: vi.fn(), tabs: ['a.ts', 'b.ts'] }));

    expect(codeRenders.count).toBe(drawn);
  });

  it('opens a link in the preview panel as it is when the link is clicked', () => {
    const before = vi.fn();
    const after = vi.fn();
    render(<Host first={{ openBrowserTab: before, tabs: [] }} />);

    act(() => setPanel({ openBrowserTab: after, tabs: ['a.ts'] }));
    fireEvent.click(screen.getByText('the docs'));

    expect(before).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledWith('https://example.com/docs');
  });
});

describe('MarkdownView while a reply grows', () => {
  beforeEach(() => {
    codeRenders.count = 0;
  });

  it('does not draw again a code block the reply has already written past', () => {
    const head = ['Here is the change:', '', '```ts', 'const a = 1;', '```', '', 'And then'].join('\n');
    const { rerender } = render(<MarkdownView>{head}</MarkdownView>);
    const drawn = codeRenders.count;
    expect(drawn).toBeGreaterThan(0);

    rerender(<MarkdownView>{`${head} the rest`}</MarkdownView>);
    rerender(<MarkdownView>{`${head} the rest of the reply.`}</MarkdownView>);

    expect(codeRenders.count).toBe(drawn);
    expect(screen.getByText('And then the rest of the reply.')).toBeInTheDocument();
  });
});
