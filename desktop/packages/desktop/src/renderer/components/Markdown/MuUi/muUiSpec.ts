/**
 * Parses the JSON of a `mu-ui` fenced block into a bounded, typed component tree.
 *
 * The source is model output, so this module is a trust boundary: every field is checked or coerced here, and the
 * renderer downstream works on the validated types alone. Anything structurally wrong — JSON that does not parse, an
 * unknown `type`, a non-object node — makes the whole spec invalid, and the block falls back to a plain code block.
 */

export const MU_UI_MAX_NODES = 200;
export const MU_UI_MAX_DEPTH = 8;

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
  | { type: 'timeline'; items: MuUiTimelineItem[] };

export type MuUiSpec = { title?: string; gap?: number; items: MuUiNode[] };

export type MuUiParseResult = { ok: true; spec: MuUiSpec; truncated: boolean } | { ok: false };

/** Raised while walking a tree whose shape the renderer cannot draw; the whole block then falls back to raw code. */
class InvalidSpec extends Error {}

type Budget = { count: number; truncated: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Display text: strings pass through, finite numbers become their string form, anything else is empty. */
const asString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

const asOptString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** A spacing value the renderer is willing to apply; keeps a model's `gap: 5000` from blowing up the layout. */
const asGap = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), 48) : undefined;

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

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
      return { type, content: asString(raw.content), size: isOneOf(raw.size, TEXT_SIZES), center: raw.center === true };
    }
    case 'row':
    case 'col': {
      return { type, items: walkItems(raw.items, depth + 1, budget), gap: asGap(raw.gap), wrap: raw.wrap === true };
    }
    case 'card': {
      return {
        type,
        title: asOptString(raw.title),
        items: walkItems(raw.items, depth + 1, budget),
        accent: isOneOf(raw.accent, ACCENTS) ?? 'info',
      };
    }
    case 'divider':
      return { type };
    case 'spacer':
      return { type };
    case 'stat': {
      return { type, label: asString(raw.label), value: asString(raw.value), delta: asOptString(raw.delta) };
    }
    case 'badge': {
      return {
        type,
        label: asString(raw.label),
        tone: isOneOf(raw.tone, BADGE_TONES) ?? 'accent',
        icon: asOptString(raw.icon),
      };
    }
    case 'progress': {
      const value = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : 0;
      return {
        type,
        label: asOptString(raw.label),
        value: Math.min(Math.max(value, 0), 100),
        valueLabel: asOptString(raw.valueLabel),
      };
    }
    case 'list': {
      return { type, items: walkListItems(raw.items, depth, budget) };
    }
    case 'table': {
      return { type, columns: walkColumns(raw.columns), rows: walkRows(raw.rows, depth, budget) };
    }
    case 'keyvalue': {
      const rawPairs = Array.isArray(raw.pairs) ? raw.pairs : [];
      return {
        type,
        pairs: rawPairs.map((pair) =>
          isRecord(pair) ? { key: asString(pair.key), value: asString(pair.value) } : { key: '', value: '' }
        ),
      };
    }
    case 'callout': {
      return {
        type,
        tone: isOneOf(raw.tone, ACCENTS) ?? 'info',
        title: asOptString(raw.title),
        content: asString(raw.content),
      };
    }
    case 'steps': {
      const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
      const steps = rawSteps.map(
        (step): MuUiStep =>
          isRecord(step) ? { title: asString(step.title), desc: asOptString(step.desc) } : asString(step)
      );
      const current = typeof raw.current === 'number' && Number.isFinite(raw.current) ? raw.current : undefined;
      return { type, steps, current };
    }
    case 'timeline': {
      const rawItems = Array.isArray(raw.items) ? raw.items : [];
      const items = rawItems.map(
        (item): MuUiTimelineItem =>
          isRecord(item)
            ? { title: asString(item.title), desc: asOptString(item.desc), time: asOptString(item.time) }
            : { title: asString(item) }
      );
      return { type, items };
    }
    default:
      throw new InvalidSpec();
  }
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
      items.push({ title: asString(entry.title), desc: asOptString(entry.desc) });
    } else {
      items.push(asString(entry));
    }
  }
  return items;
};

const walkColumns = (rawColumns: unknown): string[] =>
  Array.isArray(rawColumns) ? rawColumns.map((column) => asString(column)) : [];

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
      return asString(cell);
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
      spec: { title: asOptString(parsed.title), gap: asGap(parsed.gap), items },
      truncated: budget.truncated,
    };
  } catch {
    return { ok: false };
  }
};
