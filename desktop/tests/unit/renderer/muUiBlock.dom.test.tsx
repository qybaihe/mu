import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  PreviewOpen: () => <span />,
  ZoomIn: () => <span />,
  ZoomOut: () => <span />,
  Refresh: () => <span />,
  Close: () => <span />,
}));

// The embedded mermaid type renders through MermaidBlock; its mermaid dependency and preview context are mocked,
// following mermaidBlockPanZoom.dom.test.tsx.
const mermaidRender = vi.hoisted(() => vi.fn().mockResolvedValue({ svg: '<svg width="120" height="80"></svg>' }));

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: mermaidRender },
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ openPreview: vi.fn() }),
}));

import { Message } from '@arco-design/web-react';
import CodeBlock from '@/renderer/components/Markdown/CodeBlock';
import { MU_UI_MAX_NODES, MU_UI_MAX_TEXT, parseMuUiSpec } from '@/renderer/components/Markdown/MuUiBlock';
import { copyText } from '@/renderer/utils/ui/clipboard';

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

const renderFence = (source: string) => render(<CodeBlock className='language-mu-ui'>{source}</CodeBlock>);

const stat = (i: number) => ({ type: 'stat', label: `s${i}`, value: String(i) });

const nestedCols = (depth: number) => {
  let node: unknown = { type: 'text', content: 'bottom' };
  for (let i = 0; i < depth - 1; i += 1) node = { type: 'col', items: [node] };
  return { items: [node] };
};

describe('a mu-ui fence in a reply', () => {
  beforeEach(() => {
    highlighted.length = 0;
    vi.mocked(copyText).mockClear();
    vi.mocked(Message.success).mockClear();
    vi.mocked(Message.error).mockClear();
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
    renderFence(fence({ items: Array.from({ length: MU_UI_MAX_NODES + 50 }, (_, i) => stat(i)) }));
    expect(screen.getByText('s199')).toBeTruthy();
    expect(screen.queryByText(`s${MU_UI_MAX_NODES}`)).toBeNull();
    expect(screen.getByText('messages.muUiTruncated')).toBeTruthy();
    expect(highlighted).toHaveLength(0);
  });

  it('also accepts the muui alias', () => {
    render(<CodeBlock className='language-muui'>{fence(validSpec)}</CodeBlock>);
    expect(screen.getByText('新增客户')).toBeTruthy();
  });

  it('no longer recognizes a dsh-ui fence and leaves it a plain code block', () => {
    render(<CodeBlock className='language-dsh-ui'>{fence(validSpec)}</CodeBlock>);
    expect(screen.queryByText('周报')).toBeNull();
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0].code).toContain('"新增客户"');
  });

  it('copies the raw spec JSON from the copy button on the card', async () => {
    const source = fence(validSpec);
    renderFence(source);
    fireEvent.click(screen.getByTitle('common.copy'));
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    // The button copies the fence's source as written, not a re-serialised spec.
    expect(copyText).toHaveBeenCalledWith(source);
    expect(Message.success).toHaveBeenCalledWith('common.copySuccess');
  });
});

describe('parseMuUiSpec guards', () => {
  it('accepts nesting up to the depth limit and marks deeper trees truncated', () => {
    const atLimit = parseMuUiSpec(JSON.stringify(nestedCols(8)));
    expect(atLimit.ok && !atLimit.truncated).toBe(true);

    const overLimit = parseMuUiSpec(JSON.stringify(nestedCols(9)));
    expect(overLimit.ok && overLimit.truncated).toBe(true);
  });

  it('rejects a non-object or item-less payload without throwing', () => {
    for (const source of ['[1,2]', '"text"', '{}', '{ "items": "x" }', 'null']) {
      expect(parseMuUiSpec(source).ok).toBe(false);
    }
  });

  it('counts nodes inlined in lists and tables against the budget', () => {
    const spec = {
      items: [{ type: 'list', items: Array.from({ length: 205 }, (_, i) => ({ type: 'badge', label: `b${i}` })) }],
    };
    const parsed = parseMuUiSpec(JSON.stringify(spec));
    expect(parsed.ok && parsed.truncated).toBe(true);
  });

  it('cuts a single over-long text value and flags the spec truncated', () => {
    const parsed = parseMuUiSpec(
      JSON.stringify({
        title: 'x'.repeat(MU_UI_MAX_TEXT + 1),
        items: [{ type: 'text', content: 'y'.repeat(MU_UI_MAX_TEXT + 500) }],
      })
    );
    expect(parsed.ok && parsed.truncated).toBe(true);
    const node = parsed.ok ? parsed.spec.items[0] : undefined;
    if (!node || node.type !== 'text') throw new Error('expected a text node');
    expect(node.content).toHaveLength(MU_UI_MAX_TEXT);
    expect(parsed.ok ? parsed.spec.title : undefined).toHaveLength(MU_UI_MAX_TEXT);
  });

  it('leaves a value at the text limit whole and unflagged', () => {
    const parsed = parseMuUiSpec(JSON.stringify({ items: [{ type: 'text', content: 'x'.repeat(MU_UI_MAX_TEXT) }] }));
    expect(parsed.ok && !parsed.truncated).toBe(true);
    const node = parsed.ok ? parsed.spec.items[0] : undefined;
    if (!node || node.type !== 'text') throw new Error('expected a text node');
    expect(node.content).toHaveLength(MU_UI_MAX_TEXT);
  });
});

describe('a chart node in a mu-ui fence', () => {
  beforeEach(() => {
    highlighted.length = 0;
    mermaidRender.mockClear();
    mermaidRender.mockResolvedValue({ svg: '<svg width="120" height="80"></svg>' });
  });

  it('draws bars as SVG with the value labelled, negative bars flat but still labelled', () => {
    renderFence(
      fence({
        items: [
          {
            type: 'chart',
            kind: 'bars',
            data: [
              { label: '一月', value: 12 },
              { label: '二月', value: -5 },
              { label: '三月', value: 0 },
            ],
          },
        ],
      })
    );
    const bars = screen.getAllByTestId('mu-ui-chart-bar');
    expect(bars).toHaveLength(3);
    // A negative value draws a zero-height bar whose rect sits on the baseline.
    expect(bars[1].querySelector('rect')?.getAttribute('height')).toBe('0');
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('-5')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
    expect(highlighted).toHaveLength(0);
  });

  it('draws a line chart with a polyline, points and a zero line for negative ranges', () => {
    renderFence(
      fence({
        items: [
          {
            type: 'chart',
            kind: 'line',
            data: [
              { label: 'a', value: -3 },
              { label: 'b', value: 6 },
            ],
          },
        ],
      })
    );
    expect(document.querySelector('polyline[data-testid="mu-ui-chart-line"]')).toBeTruthy();
    expect(document.querySelectorAll('circle')).toHaveLength(2);
    expect(document.querySelector('line[stroke-dasharray]')).toBeTruthy();
  });

  it('draws a donut with percentage labels and zero arcs for negative values', () => {
    renderFence(
      fence({
        items: [
          {
            type: 'chart',
            kind: 'donut',
            data: [
              { label: 'a', value: 75 },
              { label: 'b', value: 25 },
              { label: 'c', value: -25 },
            ],
          },
        ],
      })
    );
    const legend = screen.getAllByTestId('mu-ui-donut-legend');
    expect(legend).toHaveLength(3);
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('draws grouped bars from series with a legend', () => {
    renderFence(
      fence({
        items: [
          {
            type: 'chart',
            series: [
              { name: '本季', data: [{ label: 'USWC', value: 10 }] },
              { name: '上季', data: [{ label: 'USWC', value: 20 }] },
            ],
          },
        ],
      })
    );
    expect(screen.getByText('本季')).toBeTruthy();
    expect(screen.getByText('上季')).toBeTruthy();
    expect(screen.getAllByTestId('mu-ui-chart-bar')).toHaveLength(2);
  });

  it('falls back to code for a non-numeric value, an unknown kind colour, or empty data', () => {
    renderFence(fence({ items: [{ type: 'chart', data: [{ label: 'a', value: '12' }] }] }));
    renderFence(fence({ items: [{ type: 'chart', data: [{ label: 'a', value: 'x', color: 'red' }] }] }));
    renderFence(fence({ items: [{ type: 'chart', series: [{ name: 'x', data: 'nope' }] }] }));
    renderFence(fence({ items: [{ type: 'chart', data: [] }] }));
    expect(highlighted).toHaveLength(4);
  });

  it('ignores a non-hex colour and paints the palette default instead', () => {
    renderFence(fence({ items: [{ type: 'chart', data: [{ label: 'a', value: 1, color: 'red' }] }] }));
    const bar = screen.getByTestId('mu-ui-chart-bar');
    expect(bar.querySelector('rect')?.getAttribute('fill')).toBe('var(--primary)');
  });

  it('honours a hex colour override per point', () => {
    renderFence(fence({ items: [{ type: 'chart', data: [{ label: 'a', value: 1, color: '#0f0' }] }] }));
    const bar = screen.getByTestId('mu-ui-chart-bar');
    expect(bar.querySelector('rect')?.getAttribute('fill')).toBe('#0f0');
  });
});

describe('a mermaid node in a mu-ui fence', () => {
  beforeEach(() => {
    highlighted.length = 0;
    mermaidRender.mockClear();
    mermaidRender.mockResolvedValue({ svg: '<svg width="120" height="80"></svg>' });
  });

  it('renders through MermaidBlock with the given code', async () => {
    renderFence(fence({ items: [{ type: 'mermaid', code: 'graph TD\nA-->B' }] }));
    expect(await screen.findByTestId('mermaid-diagram')).toBeTruthy();
    expect(mermaidRender).toHaveBeenCalledWith(expect.any(String), 'graph TD\nA-->B');
    // MermaidBlock starts in its source view and flips to the diagram once mermaid resolves, so the
    // highlighter flashing once here is its own behaviour — the diagram's presence proves the fence rendered.
  });

  it('falls back to code for blank mermaid source', () => {
    renderFence(fence({ items: [{ type: 'mermaid', code: '   ' }] }));
    expect(highlighted).toHaveLength(1);
  });
});

describe('an image node in a mu-ui fence', () => {
  beforeEach(() => {
    highlighted.length = 0;
    mermaidRender.mockClear();
  });

  it('renders a lazy image with alt text for an http(s) source', () => {
    renderFence(fence({ items: [{ type: 'image', src: 'https://example.com/a.png', alt: '结果图' }] }));
    const img = screen.getByTestId('mu-ui-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://example.com/a.png');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.alt).toBe('结果图');
  });

  it('rejects every protocol other than http(s), and bare paths, back to code', () => {
    renderFence(fence({ items: [{ type: 'image', src: 'file:///C:/x.png' }] }));
    renderFence(fence({ items: [{ type: 'image', src: 'data:image/png;base64,AAAA' }] }));
    renderFence(fence({ items: [{ type: 'image', src: '/mmx-files/a.png' }] }));
    renderFence(fence({ items: [{ type: 'image', src: 'C:\\x.png' }] }));
    renderFence(fence({ items: [{ type: 'image', src: 'javascript:alert(1)' }] }));
    expect(highlighted).toHaveLength(5);
  });

  it('shows the failure placeholder when the image fails to load', () => {
    renderFence(fence({ items: [{ type: 'image', src: 'https://example.com/gone.png' }] }));
    fireEvent.error(screen.getByTestId('mu-ui-image'));
    expect(screen.getByTestId('mu-ui-image-failed')).toBeTruthy();
    expect(screen.getByText('messages.muUiImageLoadFailed')).toBeTruthy();
  });
});
