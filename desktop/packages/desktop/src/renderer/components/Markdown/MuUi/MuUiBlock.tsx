/**
 * Renders a validated `mu-ui` spec (see `./muUiSpec`) as an inline structured card — stats, tables, callouts,
 * steps… — inside a chat reply. Mounted from `CodeBlock` when a fence's language is `mu-ui`/`muui`.
 *
 * Styling is inline styles over the app's CSS variables: markdown renders inside a Shadow DOM that does not see the
 * document's style sheets, while custom properties (and `color-mix` on them) inherit through the shadow boundary —
 * so the block follows the light/dark theme for free, like the rest of the Markdown blocks.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  MuUiAccent,
  MuUiBadgeTone,
  MuUiCell,
  MuUiListItem,
  MuUiNode,
  MuUiSpec,
  MuUiTextSize,
} from './muUiSpec';

type MuUiBlockProps = { spec: MuUiSpec; truncated: boolean; style?: React.CSSProperties };

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
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
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
  }
}

/**
 * Memoised on its validated spec: while a reply streams, the fence's JSON is re-parsed on every chunk, and a block
 * that parses keeps its object identity until the source actually changes enough to parse differently.
 */
const MuUiBlock = React.memo(function MuUiBlock({ spec, truncated, style }: MuUiBlockProps) {
  const { t } = useTranslation();
  return (
    <div
      // The spec is JSON and its content is data; keep it left-to-right under an RTL document.
      dir='ltr'
      style={{ width: '100%', minWidth: 0, ...style }}
    >
      <div
        style={{
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
      </div>
    </div>
  );
});

export default MuUiBlock;
