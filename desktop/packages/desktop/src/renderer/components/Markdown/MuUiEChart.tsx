/**
 * The ECharts half of the mu-ui `echart` type: the validated node type, the sanitizer that makes a model-authored
 * `option` safe to hand to ECharts, the preset builder that turns `data`/`series` into a themed ECharts option, and
 * the view that lazily loads ECharts (a dynamic import — its bundle is pulled only when the first `echart` appears),
 * draws a canvas inside the Shadow DOM, follows the app theme, and cleans up after itself.
 *
 * `MuUiBlock`'s parser validates the spec and builds a `MuUiEChartNode`; only the sanitizer, the builder and the
 * drawing live here.
 */
import type { ECharts, EChartsOption } from 'echarts';
import React from 'react';
import { useTranslation } from 'react-i18next';

import type { MuUiChartDatum, MuUiChartSeries } from './MuUiChart';

export type MuUiEChartPreset = 'bar' | 'line' | 'area' | 'pie' | 'scatter';

/**
 * A validated echart node. Exactly one mode carries the payload: `option` set means full-option mode (ECharts native
 * config, sanitized at parse); otherwise preset mode over `data` (and optionally `series`), both in the same shape as
 * the `chart` type.
 */
export type MuUiEChartNode = {
  type: 'echart';
  title?: string;
  height: number;
  preset?: MuUiEChartPreset;
  data?: MuUiChartDatum[];
  series?: MuUiChartSeries[];
  option?: Record<string, unknown>;
};

/** A serialized option bigger than this rejects the whole fence, mirroring the node/text budgets of the other types. */
export const MU_UI_MAX_ECHART_OPTION = 65536;
/** Nesting past this depth rejects the option: a model cannot stack arrays a hundred deep and mean it. */
export const MU_UI_MAX_ECHART_OPTION_DEPTH = 100;

/**
 * Makes a model-authored ECharts option safe to draw. This is the trust boundary for full-option mode: ECharts
 * accepts functions in an option (formatters, callbacks), and a node not proven to come from `JSON.parse` — which
 * can never yield a function — must not be allowed to smuggle one in, so every function field is dropped (object
 * keys removed, array slots nulled to keep indices aligned). Non-finite numbers become `null` too: ECharts reads
 * that as a data gap, where `Infinity` would poison the axis scale. JSON source cannot be cyclic, so the walk needs
 * no cycle guard. Throws when the option is not an object, nests too deep, or serializes over the size budget; the
 * fence then falls back to a plain code block.
 */
export const sanitizeEChartsOption = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('echart option must be an object');
  }

  const walk = (item: unknown, depth: number): unknown => {
    if (depth > MU_UI_MAX_ECHART_OPTION_DEPTH) throw new Error('echart option nested too deep');
    if (typeof item === 'function') return undefined;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (Array.isArray(item)) return item.map((entry) => walk(entry, depth + 1) ?? null);
    if (typeof item === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item)) {
        const kept = walk(entry, depth + 1);
        if (kept !== undefined) out[key] = kept;
      }
      return out;
    }
    return null;
  };

  const option = walk(value, 0) as Record<string, unknown>;
  if (JSON.stringify(option).length > MU_UI_MAX_ECHART_OPTION) throw new Error('echart option over the size budget');
  return option;
};

/** The theme a preset draws with, read from the CSS variables the shadow tree inherits; hex fallbacks for a context without them. */
type EChartTheme = { palette: string[]; textPrimary: string; textSecondary: string; border: string };

const cssVar = (element: HTMLElement, name: string, fallback: string): string => {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
};

const themeOf = (element: HTMLElement): EChartTheme => ({
  palette: [
    cssVar(element, '--primary', '#165dff'),
    cssVar(element, '--success', '#00b42a'),
    cssVar(element, '--warning', '#ff7d00'),
    cssVar(element, '--danger', '#f53f3f'),
    cssVar(element, '--info', '#165dff'),
  ],
  textPrimary: cssVar(element, '--text-primary', '#1d2129'),
  textSecondary: cssVar(element, '--text-secondary', '#86909c'),
  border: cssVar(element, '--border-base', '#e5e6eb'),
});

/** A per-datum `#hex` override rides along as an itemStyle; plain values otherwise (the palette assigns colors). */
const toData = (data: MuUiChartDatum[]): (number | { value: number; itemStyle: { color: string } })[] =>
  data.map((datum) =>
    datum.color !== undefined ? { value: datum.value, itemStyle: { color: datum.color } } : datum.value
  );

/**
 * The option to draw. Preset mode builds a themed option over the same `data`/`series` the `chart` type takes (the
 * palette and axis colors come from the app's CSS variables, re-read whenever the theme flips); full-option mode
 * passes the author's option through untouched — sanitizing happened at parse, and theming there is the author's
 * choice, not ours.
 */
const buildEChartsOption = (node: MuUiEChartNode, theme: EChartTheme): EChartsOption => {
  if (node.option !== undefined) return node.option as EChartsOption;

  const series = node.series ?? [];
  const flat = node.data ?? series[0]?.data ?? [];
  const labels = flat.map((datum) => datum.label);
  const preset = node.preset ?? 'bar';
  const title =
    node.title !== undefined
      ? { text: node.title, left: 0, top: 0, textStyle: { color: theme.textPrimary, fontSize: 14, fontWeight: 600 } }
      : undefined;

  if (preset === 'pie') {
    return {
      ...(title !== undefined ? { title } : {}),
      color: theme.palette,
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { color: theme.textSecondary } },
      series: [
        {
          type: 'pie',
          radius: ['42%', '68%'],
          center: ['50%', '54%'],
          data: flat.map((datum) =>
            datum.color !== undefined
              ? { name: datum.label, value: datum.value, itemStyle: { color: datum.color } }
              : { name: datum.label, value: datum.value }
          ),
          label: { color: theme.textSecondary },
        },
      ],
    };
  }

  const xAxis = {
    type: 'category' as const,
    data: labels,
    axisLabel: { color: theme.textSecondary },
    axisLine: { lineStyle: { color: theme.border } },
  };
  const yAxis = {
    type: 'value' as const,
    axisLabel: { color: theme.textSecondary },
    axisLine: { show: false },
    splitLine: { lineStyle: { color: theme.border } },
  };
  const shape = (name: string | undefined, data: MuUiChartDatum[]) => {
    // Per-datum colours only make sense for one series over a flat list; grouped series take one colour each.
    const values = preset === 'bar' && series.length === 0 ? toData(data) : data.map((datum) => datum.value);
    const base = { name, type: preset === 'area' ? ('line' as const) : preset, data: values };
    if (preset === 'line') return { ...base, symbol: 'circle', symbolSize: 6 };
    if (preset === 'area') return { ...base, symbol: 'circle', symbolSize: 6, areaStyle: { opacity: 0.16 } };
    if (preset === 'scatter') return { ...base, symbolSize: 9 };
    return base;
  };
  const drawn = series.length > 0 ? series.map((one) => shape(one.name, one.data)) : [shape(undefined, flat)];

  return {
    ...(title !== undefined ? { title } : {}),
    color: theme.palette,
    tooltip: { trigger: 'axis' },
    ...(series.length > 1 ? { legend: { bottom: 0, textStyle: { color: theme.textSecondary } } } : {}),
    grid: {
      left: 8,
      right: 16,
      top: node.title !== undefined ? 36 : 24,
      bottom: series.length > 1 ? 28 : 8,
      containLabel: true,
    },
    xAxis,
    yAxis,
    series: drawn,
  };
};

/**
 * Draws one validated echart node. ECharts loads on first use only (the dynamic import keeps its bundle out of the
 * initial chunk); the canvas lives in the shadow tree, so theme colors are re-read from the CSS variables and the
 * chart redrawn when the page's theme flips. A failure while loading or drawing re-throws during render, which the
 * fence boundary in `CodeBlock` turns into the code-block fallback — never a blank chart area.
 */
export function EChartView({ node }: { node: MuUiEChartNode }) {
  const { t } = useTranslation();
  const holder = React.useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const container = holder.current;
    if (!container) return;
    let chart: ECharts | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let disposed = false;

    const draw = () => {
      if (chart !== undefined) chart.setOption(buildEChartsOption(node, themeOf(container)));
    };

    void (async () => {
      try {
        const echarts = await import('echarts');
        if (disposed) return;

        // ECharts pins its canvas to the container's client width at init, and a shadow tree may not be laid out
        // yet at mount. A 0-width init would both draw a blank chart and feed that width back into the card's
        // shrink-to-fit ancestors (the collapsed-card bug), so init only on a measured non-zero width — the
        // ResizeObserver's first callback delivers one when the mount-time width was still 0.
        const tryInit = (reportedWidth?: number): void => {
          if (disposed || chart !== undefined) return;
          if ((reportedWidth ?? container.clientWidth) <= 0) return;
          chart = echarts.init(container);
          draw();
          setReady(true);
        };

        tryInit();
        resizeObserver = new ResizeObserver((entries) => {
          if (chart === undefined) {
            for (const entry of entries) tryInit(entry.contentRect.width);
            return;
          }
          chart.resize();
        });
        resizeObserver.observe(container);
        themeObserver = new MutationObserver(draw);
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme', 'class', 'style'],
        });
      } catch (error) {
        console.warn('mu-ui echart failed to render; falling back to the code block', error);
        setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      chart?.dispose();
    };
  }, [node]);

  // Turns a failure first seen in the effect (a rejected import, a throwing init/setOption) into a render-time throw,
  // so the fence boundary in CodeBlock swaps the whole card back to the code block.
  if (failed) throw new Error('mu-ui echart failed to render');

  return (
    <div
      data-testid='mu-ui-echart'
      // Every wrapper down from the card carries an inline width so the chain stays percentage-defined — the
      // shadow tree only sees inline styles, and a px-sized canvas left to size the chain is what collapsed cards.
      style={{ position: 'relative', width: '100%', height: node.height, minHeight: node.height }}
    >
      {!ready && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
            color: 'var(--text-secondary)',
          }}
        >
          {t('messages.muUiEChartLoading')}
        </div>
      )}
      {/* ECharts owns this div's contents once it inits; the loading caption above unmounts then. */}
      <div ref={holder} data-testid='mu-ui-echart-holder' style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
