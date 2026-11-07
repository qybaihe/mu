/**
 * WCAG contrast of the mu theme, read from the stylesheet itself.
 *
 *   node scripts/kyrn/theme/contrast.mts          # print the table, exit 1 if a pair is under its floor
 *
 * The page is neutral and primary actions are monochrome (ink on paper, paper on ink); ultraviolet and pink
 * are for tints, borders and marks. What carries text is checked here: text on the primary action fill,
 * white on the violet fill, accent text on the surfaces, body text, and the judge's pink. tests/unit/kyrn/themeContrast.test.ts runs the same table, so a palette edit that drops a
 * pair below its floor fails the tests rather than shipping.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Mode = 'light' | 'dark';
export type Pair = { name: string; fg: string; bg: string; floor: number };
export type Row = Pair & { mode: Mode; fgValue: string; bgValue: string; ratio: number; pass: boolean };

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEME_FILE = resolve(here, '../../../packages/desktop/src/renderer/styles/themes/mu-color-scheme.css');

/** 4.5 is WCAG AA for body text, 3 is AA for large text and for graphical objects. */
export const PAIRS: Pair[] = [
  { name: 'text on the accent fill (primary buttons)', fg: '--mu-accent-on', bg: '--mu-accent-fill', floor: 4.5 },
  { name: 'text on the accent fill, hover', fg: '--mu-accent-on', bg: '--mu-accent-fill-hover', floor: 4.5 },
  { name: 'text on the accent fill, active', fg: '--mu-accent-on', bg: '--mu-accent-fill-active', floor: 4.5 },
  { name: 'white text on the primary fill', fg: '--text-white', bg: '--mu-primary-fill', floor: 4.5 },
  { name: 'white text on the primary fill, hover', fg: '--text-white', bg: '--mu-primary-fill-hover', floor: 4.5 },
  { name: 'white text on the primary fill, active', fg: '--text-white', bg: '--mu-primary-fill-active', floor: 4.5 },
  { name: 'primary text on the base surface', fg: '--primary', bg: '--bg-base', floor: 4.5 },
  { name: 'primary text on the content surface', fg: '--primary', bg: '--bg-1', floor: 4.5 },
  { name: 'primary text on the sidebar surface', fg: '--primary', bg: '--bg-2', floor: 4.5 },
  { name: 'primary text on the user bubble', fg: '--primary', bg: '--aou-2', floor: 4.5 },
  { name: 'body text on the base surface', fg: '--text-primary', bg: '--bg-base', floor: 7 },
  { name: 'body text on the sidebar surface', fg: '--text-primary', bg: '--bg-2', floor: 7 },
  { name: 'body text on the user bubble', fg: '--text-primary', bg: '--aou-2', floor: 7 },
  { name: 'secondary text on the content surface', fg: '--text-secondary', bg: '--bg-1', floor: 4.5 },
  { name: 'secondary text on the sidebar surface', fg: '--text-secondary', bg: '--bg-2', floor: 4.5 },
  { name: 'tertiary text on the content surface', fg: '--bg-6', bg: '--bg-1', floor: 4.5 },
  { name: 'tertiary text on the sidebar surface', fg: '--bg-6', bg: '--bg-2', floor: 4.5 },
  { name: 'judge pink text on the content surface', fg: '--mu-judge', bg: '--bg-1', floor: 4.5 },
  { name: 'judge pink text on its own tint', fg: '--mu-judge', bg: '--mu-judge-bg-flat', floor: 4.5 },
  { name: 'success text on the content surface', fg: '--success', bg: '--bg-1', floor: 4.5 },
  { name: 'danger text on the content surface', fg: '--danger', bg: '--bg-1', floor: 4.5 },
  { name: 'warning mark on the content surface', fg: '--warning', bg: '--bg-1', floor: 3 },
  { name: 'info text on the content surface', fg: '--info', bg: '--bg-1', floor: 4.5 },
  { name: 'code text on the code block', fg: '--mu-code-text', bg: '--mu-code-bg-flat', floor: 7 },
  { name: 'code comment on the code block', fg: '--mu-code-comment', bg: '--mu-code-bg-flat', floor: 4.5 },
  { name: 'code keyword on the code block', fg: '--mu-code-keyword', bg: '--mu-code-bg-flat', floor: 4.5 },
  { name: 'code string on the code block', fg: '--mu-code-string', bg: '--mu-code-bg-flat', floor: 4.5 },
  { name: 'code number on the code block', fg: '--mu-code-number', bg: '--mu-code-bg-flat', floor: 4.5 },
  { name: 'code type on the code block', fg: '--mu-code-type', bg: '--mu-code-bg-flat', floor: 4.5 },
  { name: 'code attribute on the code block', fg: '--mu-code-attr', bg: '--mu-code-bg-flat', floor: 4.5 },
  { name: 'code meta on the code block', fg: '--mu-code-meta', bg: '--mu-code-bg-flat', floor: 4.5 },
  { name: 'code addition on the code block', fg: '--mu-code-add', bg: '--mu-code-bg-flat', floor: 4.5 },
  { name: 'code deletion on the code block', fg: '--mu-code-del', bg: '--mu-code-bg-flat', floor: 4.5 },
];

/** Custom properties of the first rule whose selector is exactly `selector`. */
function block(css: string, selector: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = rule.exec(css); match; match = rule.exec(css)) {
    const selectors = match[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    const body = match[2].replace(/\/\*[\s\S]*?\*\//g, '');
    for (const declaration of body.split(';')) {
      const at = declaration.indexOf(':');
      if (at < 0) continue;
      const name = declaration.slice(0, at).trim();
      if (name.startsWith('--')) vars[name] = declaration.slice(at + 1).trim();
    }
  }
  return vars;
}

export function tokens(css: string, mode: Mode): Record<string, string> {
  const light = block(css, "[data-color-scheme='mu']");
  return mode === 'light' ? light : { ...light, ...block(css, "[data-color-scheme='mu'][data-theme='dark']") };
}

function resolveValue(value: string, vars: Record<string, string>, depth = 0): string {
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  if (!reference || depth > 8) return value;
  const next = vars[reference[1]];
  if (next === undefined) throw new Error(`${reference[1]} is not defined`);
  return resolveValue(next, vars, depth + 1);
}

export function rgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (!hex) throw new Error(`not a six-digit hex colour: ${value}`);
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(value: string): number {
  const [r, g, b] = rgb(value).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function table(css: string = readFileSync(SCHEME_FILE, 'utf8')): Row[] {
  return (['light', 'dark'] as const).flatMap((mode) => {
    const vars = tokens(css, mode);
    return PAIRS.map((pair) => {
      const fgValue = resolveValue(`var(${pair.fg})`, vars);
      const bgValue = resolveValue(`var(${pair.bg})`, vars);
      const ratio = contrast(fgValue, bgValue);
      return { ...pair, mode, fgValue, bgValue, ratio, pass: ratio >= pair.floor };
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = table();
  for (const row of rows) {
    const verdict = row.pass ? 'ok  ' : 'FAIL';
    console.log(
      `${verdict} ${row.mode.padEnd(5)} ${row.ratio.toFixed(2).padStart(5)}:1 (floor ${row.floor})  ${row.name}  ${row.fgValue} on ${row.bgValue}`
    );
  }
  if (rows.some((row) => !row.pass)) process.exit(1);
}
