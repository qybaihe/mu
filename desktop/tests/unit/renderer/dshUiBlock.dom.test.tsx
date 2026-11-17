import { render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The fallback path highlights the raw JSON as code; the mock records that instead of pulling in highlight.js.
const highlighted = vi.hoisted(() => [] as { language: string; code: string }[]);

vi.mock('react-syntax-highlighter', () => {
  const Highlighter = ({ children, language }: { children: string; language: string }) => {
    highlighted.push({ language, code: children });
    return <div data-testid='highlighted'>{children}</div>;
  };
  return { default: Object.assign(Highlighter, { supportedLanguages: ['typescript', 'json', 'plaintext'] }) };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', () => ({
  Message: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/renderer/utils/ui/clipboard', () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@icon-park/react', () => ({
  Copy: () => <span />,
  Down: () => <span />,
  Up: () => <span />,
}));

import CodeBlock from '@/renderer/components/Markdown/CodeBlock';
import { DSH_UI_MAX_NODES, parseDshUiSpec } from '@/renderer/components/Markdown/DshUi/dshUiSpec';

const fence = (spec: unknown) => `${JSON.stringify(spec, null, 2)}\n`;

const validSpec = {
  title: '周报',
  items: [
    {
      type: 'row',
      items: [
        { type: 'stat', label: '新增客户', value: '12', delta: '+12.4%' },
        { type: 'stat', label: '流失客户', value: '3', delta: '-3%' },
      ],
    },
    { type: 'callout', tone: 'success', title: '达标', content: '**全部完成**，剩余 2 项' },
    {
      type: 'table',
      columns: ['航线', '箱量'],
      rows: [
        ['USWC', '120'],
        ['EU', '1,250'],
      ],
    },
  ],
};

const renderFence = (source: string) => render(<CodeBlock className='language-dsh-ui'>{source}</CodeBlock>);

const stat = (i: number) => ({ type: 'stat', label: `s${i}`, value: String(i) });

const nestedCols = (depth: number) => {
  let node: unknown = { type: 'text', content: 'bottom' };
  for (let i = 0; i < depth - 1; i += 1) node = { type: 'col', items: [node] };
  return { items: [node] };
};

describe('a dsh-ui fence in a reply', () => {
  beforeEach(() => {
    highlighted.length = 0;
  });

  it('renders a valid spec as components instead of code', () => {
    renderFence(fence(validSpec));
    expect(screen.getByText('周报')).toBeTruthy();
    expect(screen.getByText('新增客户')).toBeTruthy();
    expect(screen.getByText('USWC')).toBeTruthy();
    // `**bold**` inside text fields becomes a real <strong>, not markup text.
    expect(document.querySelector('strong')?.textContent).toBe('全部完成');
    expect(highlighted).toHaveLength(0);
  });

  it('stays a plain code block when the JSON does not parse', () => {
    renderFence('{\n  "items": [ {"type": "text", ');
    expect(highlighted).toMatchObject([{ language: 'text' }]);
    expect(highlighted[0].code).toContain('"items"');
  });

  it('stays a plain code block for an unknown component type', () => {
    renderFence(fence({ items: [{ type: 'holodeck' }] }));
    expect(highlighted).toMatchObject([{ language: 'text' }]);
  });

  it('stays a plain code block for an empty spec', () => {
    renderFence(fence({ items: [] }));
    renderFence(fence({ title: 'no items' }));
    expect(highlighted).toHaveLength(2);
  });

  it('truncates a spec over the node budget and says so', () => {
    renderFence(fence({ items: Array.from({ length: DSH_UI_MAX_NODES + 50 }, (_, i) => stat(i)) }));
    expect(screen.getByText('s199')).toBeTruthy();
    expect(screen.queryByText(`s${DSH_UI_MAX_NODES}`)).toBeNull();
    expect(screen.getByText('messages.dshUiTruncated')).toBeTruthy();
    expect(highlighted).toHaveLength(0);
  });

  it('also accepts the dshui alias', () => {
    render(<CodeBlock className='language-dshui'>{fence(validSpec)}</CodeBlock>);
    expect(screen.getByText('新增客户')).toBeTruthy();
  });
});

describe('parseDshUiSpec guards', () => {
  it('accepts nesting up to the depth limit and marks deeper trees truncated', () => {
    const atLimit = parseDshUiSpec(JSON.stringify(nestedCols(8)));
    expect(atLimit.ok && !atLimit.truncated).toBe(true);

    const overLimit = parseDshUiSpec(JSON.stringify(nestedCols(9)));
    expect(overLimit.ok && overLimit.truncated).toBe(true);
  });

  it('rejects a non-object or item-less payload without throwing', () => {
    for (const source of ['[1,2]', '"text"', '{}', '{ "items": "x" }', 'null']) {
      expect(parseDshUiSpec(source).ok).toBe(false);
    }
  });

  it('counts nodes inlined in lists and tables against the budget', () => {
    const spec = {
      items: [{ type: 'list', items: Array.from({ length: 205 }, (_, i) => ({ type: 'badge', label: `b${i}` })) }],
    };
    const parsed = parseDshUiSpec(JSON.stringify(spec));
    expect(parsed.ok && parsed.truncated).toBe(true);
  });
});
