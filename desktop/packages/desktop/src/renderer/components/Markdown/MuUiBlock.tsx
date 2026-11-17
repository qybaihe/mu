/**
 * One file for both halves of a `mu-ui` fence: the parser that turns the fence's JSON into a bounded, typed
 * component tree, and the component that renders that tree as an inline structured card (stats, tables, callouts,
 * steps, charts, diagrams, images…) inside a chat reply. `CodeBlock` mounts it when a fence's language is `mu-ui`/`muui`.
 *
 * The JSON is model output, so the parser is a trust boundary: every field is checked, coerced, or bounded there,
 * and the renderer below works on the validated types alone. Anything structurally wrong — JSON that does not
 * parse, an unknown `type`, a non-object node — makes the whole spec invalid, and the block falls back to a plain
 * code block. One common model mistake is absorbed instead: components nested inside a chart's `data` list are
 * hoisted out as components after the chart (see the `chart` case).
 *
 * The card styles itself with inline styles over the app's CSS variables: markdown renders inside a Shadow DOM that
 * does not see the document's style sheets, while custom properties (and `color-mix` on them) inherit through the
 * shadow boundary — so the card follows the light/dark theme for free, like the rest of the Markdown blocks. The
 * copy button is the one piece styled from outside: its hover behaviour lives in `ShadowView`'s base style, the
 * shared sheet every shadow tree adopts (see `markdown-mu-ui-copy`).
 */
import { Message } from '@arco-design/web-react';
import { Copy } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '@/renderer/utils/ui/clipboard';

import MermaidBlock from './MermaidBlock';
import { EChartView, type MuUiEChartNode, type MuUiEChartPreset, sanitizeEChartsOption } from './MuUiEChart';
import {
  ChartView,
  type MuUiChartDatum,
  type MuUiChartKind,
  type MuUiChartNode,
  type MuUiChartSeries,
} from './MuUiChart';

export type { MuUiChartDatum, MuUiChartKind, MuUiChartSeries } from './MuUiChart';
export type { MuUiEChartNode, MuUiEChartPreset } from './MuUiEChart';

export const MU_UI_MAX_NODES = 200;
export const MU_UI_MAX_DEPTH = 8;
/** A single text value longer than this is cut where it stands and the spec flagged truncated. */
export const MU_UI_MAX_TEXT = 2000;
/** A chart with more points than this (or more series) is cut and the spec flagged truncated. */
export const MU_UI_MAX_CHART_POINTS = 60;
export const MU_UI_MAX_CHART_SERIES = 6;
/** Mermaid source longer than this is cut and the spec flagged truncated. */
export const MU_UI_MAX_MERMAID_CODE = 5000;

export type MuUiAccent = 'info' | 'success' | 'warning' | 'error';
export type MuUiBadgeTone = 'accent' | 'success' | 'warn' | 'danger';
export type MuUiTextSize = 'h1' | 'h2' | 'h3' | 'body' | 'muted' | 'caption';

/** A table cell or list entry may inline one node (e.g. a badge); it counts against the node budget like any other. */
export type MuUiCell = string | MuUiNode;
export type MuUiListItem = string | { title: string; desc?: string } | MuUiNode;
export type MuUiStep = string | { title: string; desc?: string };
export type MuUiTimelineItem = { title: string; desc?: string; time?: string };

export type MuUiNode =
  | { type: 'text'; content: string; size?: MuUiTextSize; center?: boolean }
  | { type: 'row' | 'col'; items: MuUiNode[]; gap?: number; wrap?: boolean }
  | { type: 'card'; title?: string; items: MuUiNode[]; accent?: MuUiAccent }
  | { type: 'divider' }
  | { type: 'spacer' }
  | { type: 'stat'; label: string; value: string; delta?: string }
  | { type: 'badge'; label: string; tone?: MuUiBadgeTone; icon?: string }
  | { type: 'progress'; label?: string; value: number; valueLabel?: string }
  | { type: 'list'; items: MuUiListItem[] }
  | { type: 'table'; columns: string[]; rows: MuUiCell[][] }
  | { type: 'keyvalue'; pairs: { key: string; value: string }[] }
  | { type: 'callout'; tone: MuUiAccent; title?: string; content: string }
  | { type: 'steps'; steps: MuUiStep[]; current?: number }
  | { type: 'timeline'; items: MuUiTimelineItem[] }
  | MuUiChartNode
  | MuUiEChartNode
  | { type: 'mermaid'; code: string }
  | { type: 'image'; src: string; alt?: string };

export type MuUiSpec = { title?: string; gap?: number; items: MuUiNode[] };

export type MuUiParseResult = { ok: true; spec: MuUiSpec; truncated: boolean } | { ok: false };

/** Raised while walking a tree whose shape the renderer cannot draw; the whole block then falls back to raw code. */
class InvalidSpec extends Error {}

type Budget = { count: number; truncated: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One huge string from the model must not reach the renderer whole — a single multi-megabyte `text` node would
 * stall the card — so it is cut at the limit and the spec flagged, reusing the truncation notice the node budget
 * already shows.
 */
const clampText = (text: string, budget: Budget, limit: number = MU_UI_MAX_TEXT): string => {
  if (text.length <= limit) return text;
  budget.truncated = true;
  return text.slice(0, limit);
};

/** Display text: strings (an over-long one cut by `clampText`), finite numbers as their string form, else empty. */
const asString = (value: unknown, budget: Budget): string => {
  if (typeof value === 'string') return clampText(value, budget);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

const asOptString = (value: unknown, budget: Budget): string | undefined =>
  typeof value === 'string' && value.length > 0 ? clampText(value, budget) : undefined;

/** A spacing value the renderer is willing to apply; keeps a model's `gap: 5000` from blowing up the layout. */
const asGap = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), 48) : undefined;

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

const CHART_KINDS: readonly MuUiChartKind[] = ['bars', 'line', 'donut'];
const ECHART_PRESETS: readonly MuUiEChartPreset[] = ['bar', 'line', 'area', 'pie', 'scatter'];
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** A color override the renderer is willing to paint; anything that is not `#hex` falls back to the palette. */
const asChartColor = (value: unknown): string | undefined =>
  typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim() : undefined;

/** A finite number the chart is willing to plot; anything else makes the whole spec invalid. */
const asChartValue = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidSpec();
  return value;
};

/** An image source the card is willing to fetch: an http(s) URL only, so a spec cannot probe local protocols. */
const asHttpUrl = (value: unknown, budget: Budget): string => {
  if (typeof value !== 'string' || value.length === 0) throw new InvalidSpec();
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new InvalidSpec();
  }
  if (protocol !== 'https:' && protocol !== 'http:') throw new InvalidSpec();
  return clampText(value, budget);
};

const ACCENTS: readonly MuUiAccent[] = ['info', 'success', 'warning', 'error'];
const BADGE_TONES: readonly MuUiBadgeTone[] = ['accent', 'success', 'warn', 'danger'];
const TEXT_SIZES: readonly MuUiTextSize[] = ['h1', 'h2', 'h3', 'body', 'muted', 'caption'];

/** A node that would live deeper than MU_UI_MAX_DEPTH, or past MU_UI_MAX_NODES, is dropped and the flag set. */
const walkNode = (raw: unknown, depth: number, budget: Budget): MuUiNode | undefined => {
  if (budget.count >= MU_UI_MAX_NODES || depth > MU_UI_MAX_DEPTH) {
    budget.truncated = true;
    return undefined;
  }
  if (!isRecord(raw)) throw new InvalidSpec();
  const type = raw.type;
  if (typeof type !== 'string') throw new InvalidSpec();
  budget.count += 1;
  switch (type) {
    case 'text': {
      return {
        type,
        content: asString(raw.content, budget),
        size: isOneOf(raw.size, TEXT_SIZES),
        center: raw.center === true,
      };
    }
    case 'row':
    case 'col': {
      return { type, items: walkItems(raw.items, depth + 1, budget), gap: asGap(raw.gap), wrap: raw.wrap === true };
    }
    case 'card': {
      return {
        type,
        title: asOptString(raw.title, budget),
        items: walkItems(raw.items, depth + 1, budget),
        accent: isOneOf(raw.accent, ACCENTS) ?? 'info',
      };
    }
    case 'divider':
      return { type };
    case 'spacer':
      return { type };
    case 'stat': {
      return {
        type,
        label: asString(raw.label, budget),
        value: asString(raw.value, budget),
        delta: asOptString(raw.delta, budget),
      };
    }
    case 'badge': {
      return {
        type,
        label: asString(raw.label, budget),
        tone: isOneOf(raw.tone, BADGE_TONES) ?? 'accent',
        icon: asOptString(raw.icon, budget),
      };
    }
    case 'progress': {
      const value = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : 0;
      return {
        type,
        label: asOptString(raw.label, budget),
        value: Math.min(Math.max(value, 0), 100),
        valueLabel: asOptString(raw.valueLabel, budget),
      };
    }
    case 'list': {
      return { type, items: walkListItems(raw.items, depth, budget) };
    }
    case 'table': {
      return { type, columns: walkColumns(raw.columns, budget), rows: walkRows(raw.rows, depth, budget) };
    }
    case 'keyvalue': {
      const rawPairs = Array.isArray(raw.pairs) ? raw.pairs : [];
      return {
        type,
        pairs: rawPairs.map((pair) =>
          isRecord(pair)
            ? { key: asString(pair.key, budget), value: asString(pair.value, budget) }
            : { key: '', value: '' }
        ),
      };
    }
    case 'callout': {
      return {
        type,
        tone: isOneOf(raw.tone, ACCENTS) ?? 'info',
        title: asOptString(raw.title, budget),
        content: asString(raw.content, budget),
      };
    }
    case 'steps': {
      const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
      const steps = rawSteps.map(
        (step): MuUiStep =>
          isRecord(step)
            ? { title: asString(step.title, budget), desc: asOptString(step.desc, budget) }
            : asString(step, budget)
      );
      const current = typeof raw.current === 'number' && Number.isFinite(raw.current) ? raw.current : undefined;
      return { type, steps, current };
    }
    case 'timeline': {
      const rawItems = Array.isArray(raw.items) ? raw.items : [];
      const items = rawItems.map(
        (item): MuUiTimelineItem =>
          isRecord(item)
            ? {
                title: asString(item.title, budget),
                desc: asOptString(item.desc, budget),
                time: asOptString(item.time, budget),
              }
            : { title: asString(item, budget) }
      );
      return { type, items };
    }
    case 'chart': {
      // `series` present means grouped bars (the vocabulary's rule); a flat `data` list picks its own `kind`.
      if (raw.series !== undefined) {
        const series = walkChartSeries(raw.series, budget);
        return { type, kind: 'bars', data: series[0].data, series };
      }
      // A model sometimes nests sibling components (a second chart, a callout) inside a chart's `data` list, which
      // is for `{label, value}` points alone. Rejecting the whole spec for that would show raw JSON where the model
      // meant a card, so a node-shaped entry (a record with a `type`) is hoisted out as a component after the chart;
      // anything else that is not a point still makes the spec invalid.
      const entries = Array.isArray(raw.data) ? raw.data : [];
      const pointEntries: unknown[] = [];
      const nested: MuUiNode[] = [];
      for (const entry of entries) {
        if (isRecord(entry) && typeof entry.type === 'string') {
          const node = walkNode(entry, depth + 1, budget);
          if (node !== undefined) nested.push(node);
        } else {
          pointEntries.push(entry);
        }
      }
      const data = walkChartData(pointEntries, budget);
      if (data.length === 0) {
        if (nested.length === 0) throw new InvalidSpec();
        // The chart was nothing but the mistake: what it held is the content.
        return nested.length === 1 ? nested[0] : { type: 'col', items: nested };
      }
      const chart: MuUiNode = { type, kind: isOneOf(raw.kind, CHART_KINDS) ?? 'bars', data };
      return nested.length === 0 ? chart : { type: 'col', items: [chart, ...nested] };
    }
    case 'echart': {
      // Full-option mode: an `option` object wins over preset data — a spec carrying both meant the option.
      let option: Record<string, unknown> | undefined;
      if (raw.option !== undefined) {
        if (!isRecord(raw.option)) throw new InvalidSpec();
        // Throws past the option's depth/size budgets; the fence then falls back to a code block.
        option = sanitizeEChartsOption(raw.option);
      }
      let data: MuUiChartDatum[] | undefined;
      let series: MuUiChartSeries[] | undefined;
      if (option === undefined && raw.series !== undefined) {
        series = walkChartSeries(raw.series, budget);
      } else if (option === undefined) {
        data = walkChartData(raw.data, budget);
        if (data.length === 0) throw new InvalidSpec();
      }
      const rawHeight = typeof raw.height === 'number' && Number.isFinite(raw.height) ? raw.height : 300;
      return {
        type,
        title: asOptString(raw.title, budget),
        height: Math.min(Math.max(Math.round(rawHeight), 120), 720),
        preset: isOneOf(raw.preset, ECHART_PRESETS),
        data,
        series,
        option,
      };
    }
    case 'mermaid': {
      const code = typeof raw.code === 'string' ? raw.code : '';
      if (code.trim().length === 0) throw new InvalidSpec();
      return { type, code: clampText(code, budget, MU_UI_MAX_MERMAID_CODE) };
    }
    case 'image': {
      return { type, src: asHttpUrl(raw.src, budget), alt: asOptString(raw.alt, budget) };
    }
    default:
      throw new InvalidSpec();
  }
};

/** Chart points: past the point budget the rest is dropped and the spec flagged; a bad value rejects the spec. */
const walkChartData = (raw: unknown, budget: Budget): MuUiChartDatum[] => {
  const entries = Array.isArray(raw) ? raw : [];
  const data: MuUiChartDatum[] = [];
  for (const entry of entries) {
    if (data.length >= MU_UI_MAX_CHART_POINTS) {
      budget.truncated = true;
      break;
    }
    if (!isRecord(entry)) throw new InvalidSpec();
    data.push({
      label: asString(entry.label, budget),
      value: asChartValue(entry.value),
      color: asChartColor(entry.color),
    });
  }
  return data;
};

/** Chart series (grouped mode, shared by `chart` and `echart`): capped, named, each with at least one point. */
const walkChartSeries = (raw: unknown, budget: Budget): MuUiChartSeries[] => {
  const entries = Array.isArray(raw) ? raw : [];
  const series: MuUiChartSeries[] = [];
  for (const entry of entries) {
    if (series.length >= MU_UI_MAX_CHART_SERIES) {
      budget.truncated = true;
      break;
    }
    if (!isRecord(entry)) throw new InvalidSpec();
    const data = walkChartData(entry.data, budget);
    if (data.length === 0) throw new InvalidSpec();
    series.push({ name: asOptString(entry.name, budget) ?? `S${series.length + 1}`, data });
  }
  if (series.length === 0) throw new InvalidSpec();
  return series;
};

const walkItems = (rawItems: unknown, depth: number, budget: Budget): MuUiNode[] => {
  const entries = Array.isArray(rawItems) ? rawItems : [];
  const items: MuUiNode[] = [];
  for (const entry of entries) {
    const node = walkNode(entry, depth, budget);
    if (node !== undefined) items.push(node);
  }
  return items;
};

const walkListItems = (rawItems: unknown, depth: number, budget: Budget): MuUiListItem[] => {
  const entries = Array.isArray(rawItems) ? rawItems : [];
  const items: MuUiListItem[] = [];
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.type === 'string') {
      const node = walkNode(entry, depth + 1, budget);
      if (node !== undefined) items.push(node);
    } else if (isRecord(entry)) {
      items.push({ title: asString(entry.title, budget), desc: asOptString(entry.desc, budget) });
    } else {
      items.push(asString(entry, budget));
    }
  }
  return items;
};

const walkColumns = (rawColumns: unknown, budget: Budget): string[] =>
  Array.isArray(rawColumns) ? rawColumns.map((column) => asString(column, budget)) : [];

const walkRows = (rawRows: unknown, depth: number, budget: Budget): MuUiCell[][] => {
  const entries = Array.isArray(rawRows) ? rawRows : [];
  return entries.map((row) => {
    const cells = Array.isArray(row) ? row : [row];
    return cells.map((cell): MuUiCell => {
      if (isRecord(cell)) {
        const node = walkNode(cell, depth + 1, budget);
        if (node === undefined) return '';
        return node;
      }
      return asString(cell, budget);
    });
  });
};

/**
 * Parses one fence's JSON. Tolerant where the renderer is tolerant (missing display text renders empty); a spec
 * with no renderable nodes at all is rejected so the block keeps showing as source code.
 */
export const parseMuUiSpec = (source: string): MuUiParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items) || parsed.items.length === 0) return { ok: false };
  const budget: Budget = { count: 0, truncated: false };
  try {
    const items = walkItems(parsed.items, 1, budget);
    if (items.length === 0) return { ok: false };
    return {
      ok: true,
      spec: { title: asOptString(parsed.title, budget), gap: asGap(parsed.gap), items },
      truncated: budget.truncated,
    };
  } catch {
    return { ok: false };
  }
};

const ACCENT_COLOR: Record<MuUiAccent, string> = {
  info: 'var(--info)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  error: 'var(--danger)',
};

const BADGE_COLOR: Record<MuUiBadgeTone, string> = {
  accent: 'var(--primary)',
  success: 'var(--success)',
  warn: 'var(--warning)',
  danger: 'var(--danger)',
};

const TEXT_SIZE_STYLE: Record<MuUiTextSize, React.CSSProperties> = {
  h1: { fontSize: '20px', fontWeight: 700 },
  h2: { fontSize: '17px', fontWeight: 700 },
  h3: { fontSize: '15px', fontWeight: 600 },
  body: { fontSize: '14px' },
  muted: { fontSize: '14px', color: 'var(--text-secondary)' },
  caption: { fontSize: '12px', color: 'var(--text-secondary)' },
};

/** A translucent wash of a theme color, in place of the hardcoded tints of the reference renderer. */
const tint = (color: string, percent: number): string => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

const CELL_BORDER = '1px solid var(--border-base)';
const CELL_PADDING: React.CSSProperties = { padding: '6px 10px' };

/** mu-ui text fields carry one piece of markup: `**bold**`; newlines become line breaks. */
function MdText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, index) => (
        <React.Fragment key={index}>
          {index > 0 && <br />}
          {line.split('**').map((segment, part) => (part % 2 === 1 ? <strong key={part}>{segment}</strong> : segment))}
        </React.Fragment>
      ))}
    </>
  );
}

function Stack({ items, gap }: { items: MuUiNode[]; gap: number }) {
  return (
    // width: 100% keeps the chain from the card down percentage-defined; block-level cards (echart) must not
    // size their column by content.
    <div style={{ display: 'flex', flexDirection: 'column', gap, width: '100%' }}>
      {items.map((item, index) => (
        <NodeView key={index} node={item} />
      ))}
    </div>
  );
}

function CellView({ cell }: { cell: MuUiCell }) {
  return typeof cell === 'string' ? <MdText text={cell} /> : <NodeView node={cell} />;
}

function ListItemView({ item }: { item: MuUiListItem }) {
  if (typeof item === 'string') return <MdText text={item} />;
  if ('type' in item) return <NodeView node={item} />;
  return (
    <>
      <MdText text={item.title} />
      {item.desc !== undefined && (
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginLeft: '4px' }}>
          {'—— '}
          <MdText text={item.desc} />
        </span>
      )}
    </>
  );
}

/** A column whose every cell is a plain numeric-looking string is right-aligned, as in the reference renderer. */
const NUMERIC_CELL = /^[+-]?[\d,.]+%?$/;

const numericColumn = (rows: MuUiCell[][], column: number): boolean => {
  if (rows.length === 0) return false;
  return rows.every((row) => {
    const cell = row[column];
    return typeof cell === 'string' && cell.length > 0 && NUMERIC_CELL.test(cell.trim());
  });
};

/** The one image type: lazy, http(s) only (checked at parse), with a placeholder when it fails to load. */
function ImageView({ node }: { node: Extract<MuUiNode, { type: 'image' }> }) {
  const { t } = useTranslation();
  const [failed, setFailed] = React.useState(false);
  if (failed) {
    return (
      <div
        data-testid='mu-ui-image-failed'
        style={{
          border: CELL_BORDER,
          borderRadius: '8px',
          background: 'var(--bg-2)',
          padding: '18px 12px',
          fontSize: '13px',
          color: 'var(--text-secondary)',
          textAlign: 'center',
        }}
      >
        {t('messages.muUiImageLoadFailed')}
      </div>
    );
  }
  return (
    <img
      data-testid='mu-ui-image'
      src={node.src}
      alt={node.alt ?? ''}
      loading='lazy'
      decoding='async'
      onError={() => setFailed(true)}
      style={{ display: 'block', maxWidth: '100%', maxHeight: '380px', borderRadius: '8px', margin: '0 auto' }}
    />
  );
}

function NodeView({ node }: { node: MuUiNode }) {
  switch (node.type) {
    case 'text': {
      const sizeStyle = TEXT_SIZE_STYLE[node.size ?? 'body'];
      return (
        <div style={{ ...sizeStyle, textAlign: node.center ? 'center' : undefined, margin: '2px 0' }}>
          <MdText text={node.content} />
        </div>
      );
    }
    case 'row':
    case 'col': {
      const isRow = node.type === 'row';
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: isRow ? 'row' : 'column',
            flexWrap: isRow && node.wrap !== false ? 'wrap' : 'nowrap',
            gap: node.gap ?? (isRow ? 10 : 8),
            minWidth: 0,
          }}
        >
          {node.items.map((child, index) => (
            <NodeView key={index} node={child} />
          ))}
        </div>
      );
    }
    case 'card': {
      const color = ACCENT_COLOR[node.accent ?? 'info'];
      return (
        <div
          style={{
            border: CELL_BORDER,
            borderLeft: `3px solid ${color}`,
            borderRadius: '8px',
            padding: '10px 12px',
            background: tint(color, 6),
          }}
        >
          {node.title !== undefined && (
            <div style={{ fontWeight: 600, marginBottom: '6px' }}>
              <MdText text={node.title} />
            </div>
          )}
          <Stack items={node.items} gap={8} />
        </div>
      );
    }
    case 'divider':
      return <div style={{ borderTop: CELL_BORDER, margin: '8px 0' }} />;
    case 'spacer':
      return <div style={{ height: '14px' }} />;
    case 'stat': {
      const down = node.delta !== undefined && (node.delta.startsWith('-') || node.delta.includes('▼'));
      return (
        <div
          style={{
            border: CELL_BORDER,
            borderRadius: '8px',
            padding: '10px 12px',
            flex: '1 1 120px',
            background: 'var(--bg-base)',
          }}
        >
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{node.label}</div>
          <div style={{ fontSize: '22px', fontWeight: 700, margin: '2px 0' }}>{node.value}</div>
          {node.delta !== undefined && (
            <div style={{ fontSize: '12px', color: down ? 'var(--danger)' : 'var(--success)' }}>{node.delta}</div>
          )}
        </div>
      );
    }
    case 'badge': {
      const color = BADGE_COLOR[node.tone ?? 'accent'];
      return (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 8px',
            borderRadius: '999px',
            fontSize: '12px',
            fontWeight: 500,
            background: tint(color, 12),
            color,
          }}
        >
          {node.icon !== undefined && <span>{node.icon}</span>}
          {node.label}
        </span>
      );
    }
    case 'progress':
      return (
        <div>
          {(node.label !== undefined || node.valueLabel !== undefined) && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              <span>{node.label}</span>
              {node.valueLabel !== undefined && <span>{node.valueLabel}</span>}
            </div>
          )}
          <div style={{ height: '6px', borderRadius: '3px', background: 'var(--bg-3)', overflow: 'hidden' }}>
            <div
              style={{ width: `${node.value}%`, height: '100%', borderRadius: '3px', background: 'var(--primary)' }}
            />
          </div>
        </div>
      );
    case 'list':
      return (
        <ul style={{ listStyle: 'disc', margin: 0, paddingLeft: '18px' }}>
          {node.items.map((item, index) => (
            <li key={index} style={{ margin: '3px 0' }}>
              <ListItemView item={item} />
            </li>
          ))}
        </ul>
      );
    case 'table': {
      const numeric = node.columns.map((_, column) => numericColumn(node.rows, column));
      const cellAlign = (column: number): React.CSSProperties =>
        numeric[column] ? { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } : {};
      return (
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '13px' }}>
            <thead>
              <tr>
                {node.columns.map((column, index) => (
                  <th
                    key={index}
                    style={{
                      background: 'var(--bg-2)',
                      fontWeight: 600,
                      textAlign: 'left',
                      border: CELL_BORDER,
                      ...CELL_PADDING,
                      ...cellAlign(index),
                    }}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ border: CELL_BORDER, ...CELL_PADDING, ...cellAlign(cellIndex) }}>
                      <CellView cell={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'keyvalue':
      return (
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '13px' }}>
          <tbody>
            {node.pairs.map((pair, index) => (
              <tr key={index}>
                <td
                  style={{
                    border: CELL_BORDER,
                    ...CELL_PADDING,
                    background: 'var(--bg-2)',
                    fontWeight: 600,
                    width: '38%',
                    textAlign: 'left',
                  }}
                >
                  {pair.key}
                </td>
                <td style={{ border: CELL_BORDER, ...CELL_PADDING }}>
                  <MdText text={pair.value} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'callout': {
      const color = ACCENT_COLOR[node.tone];
      return (
        <div style={{ borderRadius: '8px', padding: '10px 12px', background: tint(color, 10), color }}>
          {node.title !== undefined && <div style={{ fontWeight: 600, marginBottom: '2px' }}>{node.title}</div>}
          <div>
            <MdText text={node.content} />
          </div>
        </div>
      );
    }
    case 'steps':
      return (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {node.steps.map((step, index) => {
            const title = typeof step === 'string' ? step : step.title;
            const desc = typeof step === 'string' ? undefined : step.desc;
            const done = node.current === undefined || index <= node.current;
            const isCurrent = node.current === index;
            return (
              <li key={index} style={{ position: 'relative', padding: '4px 0 4px 30px' }}>
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: '4px',
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    background: done ? 'var(--primary)' : 'var(--bg-4)',
                    color: 'var(--text-white)',
                    fontSize: '12px',
                    lineHeight: '20px',
                    textAlign: 'center',
                    fontWeight: 600,
                  }}
                >
                  {index + 1}
                </span>
                <span style={{ fontWeight: isCurrent ? 700 : 400 }}>
                  <MdText text={title} />
                </span>
                {desc !== undefined && (
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginLeft: '4px' }}>
                    {'—— '}
                    <MdText text={desc} />
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      );
    case 'timeline':
      return (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {node.items.map((item, index) => (
            <li
              key={index}
              style={{
                position: 'relative',
                paddingLeft: '20px',
                paddingBottom: index === node.items.length - 1 ? 0 : '12px',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  top: '5px',
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  border: '2px solid var(--primary)',
                  background: 'var(--bg-base)',
                  boxSizing: 'border-box',
                }}
              />
              {index !== node.items.length - 1 && (
                <span
                  style={{
                    position: 'absolute',
                    left: '3.5px',
                    top: '18px',
                    bottom: 0,
                    width: '1px',
                    background: 'var(--border-base)',
                  }}
                />
              )}
              <div>
                <span style={{ fontWeight: 500 }}>
                  <MdText text={item.title} />
                </span>
                {item.time !== undefined && (
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginLeft: '8px' }}>
                    {item.time}
                  </span>
                )}
              </div>
              {item.desc !== undefined && (
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  <MdText text={item.desc} />
                </div>
              )}
            </li>
          ))}
        </ul>
      );
    case 'chart':
      return <ChartView node={node} />;
    case 'echart':
      return <EChartView node={node} />;
    case 'mermaid':
      // Embedded in the card the diagram stays static (no pan/zoom); open-in-panel still works via the preview context.
      return <MermaidBlock code={node.code} enablePanZoom={false} />;
    case 'image':
      return <ImageView node={node} />;
  }
}

type MuUiBlockProps = { spec: MuUiSpec; source: string; truncated: boolean; style?: React.CSSProperties };

/**
 * Memoised on its validated spec: while a reply streams, the fence's JSON is re-parsed on every chunk, and a block
 * that parses keeps its object identity until the source actually changes enough to parse differently.
 */
const MuUiBlock = React.memo(function MuUiBlock({ spec, source, truncated, style }: MuUiBlockProps) {
  const { t } = useTranslation();

  const handleCopy = () => {
    void copyText(source)
      .then(() => {
        try {
          Message.success(t('common.copySuccess'));
        } catch {
          /* Shadow DOM portal may fail silently */
        }
      })
      .catch(() => {
        try {
          Message.error(t('common.copyFailed'));
        } catch {
          /* ignore */
        }
      });
  };

  return (
    <div
      // The spec is JSON and its content is data; keep it left-to-right under an RTL document.
      dir='ltr'
      style={{ width: '100%', minWidth: 0, ...style }}
    >
      <div
        className='markdown-mu-ui-card'
        style={{
          position: 'relative',
          width: '100%',
          border: CELL_BORDER,
          borderRadius: '10px',
          padding: '12px 14px',
          background: 'var(--bg-1)',
          fontSize: '14px',
          lineHeight: 1.6,
          color: 'var(--text-primary)',
          boxSizing: 'border-box',
        }}
      >
        {spec.title !== undefined && (
          <div
            style={{
              fontSize: '15px',
              fontWeight: 600,
              paddingBottom: '8px',
              borderBottom: '1px solid var(--border-light)',
              marginBottom: '10px',
              // Room for the copy button pinned to the card's top-right corner.
              paddingRight: '34px',
            }}
          >
            <MdText text={spec.title} />
          </div>
        )}
        <Stack items={spec.items} gap={spec.gap ?? 8} />
        {truncated && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'center' }}>
            {t('messages.muUiTruncated')}
          </div>
        )}
        {/* The card's copy button, mirroring the code block's: the fence's raw JSON, feedback via toast. Its
            hover behaviour lives in ShadowView's base style — the one sheet the shadow tree sees. */}
        <span data-testid='mu-ui-copy' className='markdown-mu-ui-copy' title={t('common.copy')} onClick={handleCopy}>
          <Copy theme='outline' size='14' style={{ display: 'block' }} fill='currentColor' />
        </span>
      </div>
    </div>
  );
});

export default MuUiBlock;
