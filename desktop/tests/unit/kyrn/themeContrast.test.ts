import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAIRS, SCHEME_FILE, contrast, luminance, rgb, table, tokens } from '../../../scripts/kyrn/theme/contrast.mts';

const THEMES = resolve(__dirname, '../../../packages/desktop/src/renderer/styles/themes');
const scheme = readFileSync(SCHEME_FILE, 'utf8');
const arco = readFileSync(resolve(THEMES, 'mu-arco.css'), 'utf8');
const upstream = readFileSync(resolve(THEMES, 'default-color-scheme.css'), 'utf8');

/** Custom property names declared in the first rule that lists `selector`. */
function declared(css: string, selector: string): string[] {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return [...body.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]);
}

function triplets(css: string, selector: string, prefix: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries(
    [...body.matchAll(new RegExp(`(--${prefix}-\\d+)\\s*:\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)`, 'g'))].map((m) => [
      m[1],
      `${m[2]},${m[3]},${m[4]}`,
    ])
  );
}

describe('contrast maths', () => {
  it('matches the WCAG reference values', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(luminance('#ffffff')).toBeCloseTo(1, 5);
    expect(rgb('#6a4fd3')).toEqual([106, 79, 211]);
    expect(() => rgb('rgb(1,2,3)')).toThrow();
  });
});

describe('mu colour scheme', () => {
  it('keeps every text pair at or above its WCAG floor, in light and dark', () => {
    const rows = table(scheme);
    expect(rows).toHaveLength(PAIRS.length * 2);
    const failing = rows.filter((row) => !row.pass).map((row) => `${row.mode}: ${row.name} ${row.ratio.toFixed(2)}`);
    expect(failing).toEqual([]);
  });

  it('keeps primary actions monochrome and the pastel steps for tints only', () => {
    // Primary buttons are ink on paper and paper on ink. The lavender and pink tints never carry white text: about 2:1.
    const cast = (hex: string) => {
      const [r, g, b] = rgb(hex);
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    for (const mode of ['light', 'dark'] as const) {
      const vars = tokens(scheme, mode);
      expect(cast(vars['--mu-accent-fill']), `${mode} accent fill`).toBeLessThanOrEqual(12);
    }
    const light = tokens(scheme, 'light');
    expect(contrast('#ffffff', light['--mu-violet-4'])).toBeLessThan(3);
    expect(contrast('#ffffff', light['--mu-pink-4'])).toBeLessThan(3);
    expect(light['--mu-primary-fill']).toBe('var(--mu-violet-6)');
  });

  it('keeps the page itself neutral: no lavender or pink cast on the surfaces and the text', () => {
    // A surface or text grey whose channels differ by more than this has a colour cast.
    const cast = (hex: string) => {
      const [r, g, b] = rgb(hex);
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    for (const mode of ['light', 'dark'] as const) {
      const vars = tokens(scheme, mode);
      for (const name of ['--bg-base', '--bg-1', '--bg-2', '--bg-3', '--bg-hover', '--bg-active', '--border-base']) {
        expect(cast(vars[name]), `${mode} ${name} ${vars[name]}`).toBeLessThanOrEqual(12);
      }
      for (const name of ['--text-primary', '--text-secondary', '--bg-6', '--aou-2']) {
        expect(cast(vars[name]), `${mode} ${name} ${vars[name]}`).toBeLessThanOrEqual(26);
      }
    }
  });

  it('defines every variable of the upstream scheme in both appearances', () => {
    // The upstream dark block is scoped to data-color-scheme='default': anything missing here would
    // fall back to a light value in dark mode.
    const lightNames = new Set(declared(scheme, "[data-color-scheme='mu']"));
    const darkNames = new Set(declared(scheme, "[data-color-scheme='mu'][data-theme='dark']"));
    const upstreamLight = declared(upstream, "[data-color-scheme='default']");
    const upstreamDark = declared(upstream, "[data-color-scheme='default'][data-theme='dark']");
    expect(upstreamLight.filter((name) => !lightNames.has(name))).toEqual([]);
    expect(upstreamDark.filter((name) => !darkNames.has(name))).toEqual([]);
  });

  it('keeps the upstream specificity so theme tokens and custom CSS themes still win', () => {
    expect(scheme).not.toMatch(/:root\[data-color-scheme/);
    expect(scheme).not.toMatch(/html\[data-color-scheme/);
  });

  it("repeats the violet scale exactly in Arco's triplets", () => {
    for (const [mode, selector] of [
      ['light', "[data-color-scheme='mu'] body"],
      ['dark', "[data-color-scheme='mu'] body[arco-theme='dark']"],
    ] as const) {
      const vars = tokens(scheme, mode);
      const scale = triplets(arco, selector, 'arcoblue');
      expect(Object.keys(scale)).toHaveLength(10);
      for (let step = 1; step <= 10; step++) {
        expect(scale[`--arcoblue-${step}`], `${mode} step ${step}`).toBe(rgb(vars[`--mu-violet-${step}`]).join(','));
      }
    }
  });
});
