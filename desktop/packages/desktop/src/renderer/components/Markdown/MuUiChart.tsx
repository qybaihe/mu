/**
 * The drawing half of the mu-ui `chart` type: bars (single or grouped), a line with points, and a donut with a
 * percentage legend — all hand-drawn SVG over the app's CSS variables, so light and dark themes both work with no
 * charting dependency. `MuUiBlock`'s parser validates the spec and hands over a `MuUiChartNode`; only drawing lives
 * here.
 */
import React from 'react';

export type MuUiChartKind = 'bars' | 'line' | 'donut';
/** One plotted value; `color` is an accepted-as-written hex override, else the palette color is used. */
export type MuUiChartDatum = { label: string; value: number; color?: string };
/** A named series over the same label axis; present only in grouped-bars mode. */
export type MuUiChartSeries = { name: string; data: MuUiChartDatum[] };
export type MuUiChartNode = { type: 'chart'; kind: MuUiChartKind; data: MuUiChartDatum[]; series?: MuUiChartSeries[] };

/** Entry point wired into `MuUiBlock`'s node switch: pick the drawing for the validated chart node. */
export function ChartView({ node }: { node: MuUiChartNode }) {
  if (node.series !== undefined) return <BarsView series={node.series} />;
  if (node.kind === 'line') return <LineView data={node.data} />;
  if (node.kind === 'donut') return <DonutView data={node.data} />;
  return <BarsView series={[{ name: '', data: node.data }]} />;
}

/** Chart colors default to theme variables so light and dark both work; a spec's `#hex` override wins per point. */
const CHART_PALETTE = ['var(--primary)', 'var(--success)', 'var(--warning)', 'var(--danger)', 'var(--info)'];

const formatValue = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));

const shortenLabel = (label: string, max: number): string =>
  label.length > max ? `${label.slice(0, max - 1)}…` : label;

function ChartLegend({ names }: { names: string[] }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 12px',
        fontSize: '12px',
        color: 'var(--text-secondary)',
        marginBottom: '6px',
      }}
    >
      {names.map((name, index) => (
        <span key={index} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: CHART_PALETTE[index % CHART_PALETTE.length],
              flexShrink: 0,
            }}
          />
          {name}
        </span>
      ))}
    </div>
  );
}

/** Bars, one series or grouped: a negative value draws a zero-height bar whose value label still shows. */
function BarsView({ series }: { series: MuUiChartSeries[] }) {
  const groups = Math.max(...series.map((one) => one.data.length));
  const width = Math.max(320, groups * Math.max(60, series.length * 26 + 20));
  const height = 216;
  const padX = 12;
  const padTop = 22;
  const baseline = height - 28;
  const plotW = width - padX * 2;
  const plotH = baseline - padTop;
  const max = Math.max(0, ...series.flatMap((one) => one.data.map((datum) => datum.value)));
  const barW = Math.min(34, (plotW / Math.max(groups, 1) / series.length) * 0.72);
  const inner = series.length * barW + (series.length - 1) * 3;
  const groupCenter = (index: number) => padX + (plotW * (index + 0.5)) / Math.max(groups, 1);
  const labelSeries = series.reduce((a, b) => (b.data.length > a.data.length ? b : a));
  return (
    // width: 100% keeps the wrapper percentage-defined like the rest of the card chain (the svg already is).
    <div style={{ width: '100%' }}>
      {series.length > 1 && <ChartLegend names={series.map((one) => one.name)} />}
      <svg viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', width: '100%', height: 'auto' }}>
        <line x1={padX} x2={width - padX} y1={baseline} y2={baseline} stroke='var(--border-base)' />
        {series.map((one, k) =>
          one.data.map((datum, i) => {
            const x = groupCenter(i) - inner / 2 + k * (barW + 3);
            const h = max > 0 ? (Math.max(0, datum.value) / max) * plotH : 0;
            // Grouped bars keep one color per series (matching the legend); single bars take per-point colors.
            const color =
              series.length === 1
                ? (datum.color ?? CHART_PALETTE[k % CHART_PALETTE.length])
                : CHART_PALETTE[k % CHART_PALETTE.length];
            return (
              <g key={`${k}-${i}`} data-testid='mu-ui-chart-bar'>
                <rect x={x} y={baseline - h} width={barW} height={h} rx={2} fill={color} />
                {series.length === 1 && (
                  <text
                    x={x + barW / 2}
                    y={baseline - h - 5}
                    textAnchor='middle'
                    fontSize={11}
                    fill='var(--text-primary)'
                  >
                    {formatValue(datum.value)}
                  </text>
                )}
              </g>
            );
          })
        )}
        {labelSeries.data.map((datum, index) => (
          <text
            key={index}
            x={groupCenter(index)}
            y={baseline + 16}
            textAnchor='middle'
            fontSize={11}
            fill='var(--text-secondary)'
          >
            {shortenLabel(datum.label, 12)}
          </text>
        ))}
      </svg>
    </div>
  );
}

/** A line through the points; the y range spans the data (negatives included) with a dashed zero line. */
function LineView({ data }: { data: MuUiChartDatum[] }) {
  const width = Math.max(360, data.length * 48);
  const height = 200;
  const padX = 12;
  const padTop = 14;
  const baseline = height - 26;
  const plotW = width - padX * 2;
  const plotH = baseline - padTop;
  const values = data.map((datum) => datum.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const x = (index: number) => padX + plotW * (data.length === 1 ? 0.5 : index / (data.length - 1));
  const y = (value: number) => padTop + plotH * (1 - (value - lo) / (hi - lo));
  const labelStep = Math.ceil(data.length / 12);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', width: '100%', height: 'auto' }}>
      {lo < 0 && 0 < hi && (
        <line x1={padX} x2={width - padX} y1={y(0)} y2={y(0)} stroke='var(--border-base)' strokeDasharray='4 3' />
      )}
      <polyline
        data-testid='mu-ui-chart-line'
        points={data.map((datum, index) => `${x(index)},${y(datum.value)}`).join(' ')}
        fill='none'
        stroke='var(--primary)'
        strokeWidth={2}
        strokeLinejoin='round'
      />
      {data.map((datum, index) => (
        <circle key={index} cx={x(index)} cy={y(datum.value)} r={3.5} fill={datum.color ?? 'var(--primary)'} />
      ))}
      {data.map((datum, index) =>
        index % labelStep === 0 ? (
          <text
            key={index}
            x={x(index)}
            y={baseline + 16}
            textAnchor='middle'
            fontSize={11}
            fill='var(--text-secondary)'
          >
            {shortenLabel(datum.label, 12)}
          </text>
        ) : null
      )}
    </svg>
  );
}

/** A donut of the positive values with a percentage legend; negative values take up no arc. */
function DonutView({ data }: { data: MuUiChartDatum[] }) {
  const size = 150;
  const center = size / 2;
  const radius = 50;
  const strokeWidth = 24;
  const circumference = 2 * Math.PI * radius;
  const total = data.reduce((sum, datum) => sum + Math.max(0, datum.value), 0);
  let swept = 0;
  const segments = data.map((datum, index) => {
    const fraction = total > 0 ? Math.max(0, datum.value) / total : 0;
    const segment = {
      label: datum.label,
      percent: Math.round(fraction * 100),
      color: datum.color ?? CHART_PALETTE[index % CHART_PALETTE.length],
      dash: fraction * circumference,
      offset: -swept * circumference,
    };
    swept += fraction;
    return segment;
  });
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ flexShrink: 0 }}>
        <circle cx={center} cy={center} r={radius} fill='none' stroke='var(--bg-3)' strokeWidth={strokeWidth} />
        {segments.map((segment, index) =>
          segment.dash > 0 ? (
            <circle
              key={index}
              cx={center}
              cy={center}
              r={radius}
              fill='none'
              stroke={segment.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${segment.dash} ${circumference - segment.dash}`}
              strokeDashoffset={segment.offset}
              transform={`rotate(-90 ${center} ${center})`}
            />
          ) : null
        )}
        <text
          x={center}
          y={center}
          textAnchor='middle'
          dominantBaseline='central'
          fontSize={15}
          fontWeight={700}
          fill='var(--text-primary)'
        >
          {formatValue(total)}
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
        {segments.map((segment, index) => (
          <div
            key={index}
            data-testid='mu-ui-donut-legend'
            style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}
          >
            <span style={{ width: 10, height: 10, borderRadius: 2, background: segment.color, flexShrink: 0 }} />
            <span
              style={{
                color: 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {shortenLabel(segment.label, 16)}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--text-primary)' }}>
              {segment.percent}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
