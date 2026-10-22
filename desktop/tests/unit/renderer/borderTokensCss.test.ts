/**
 * The theme colour classes, checked where it matters: in the CSS UnoCSS generates.
 *
 * A class whose colour the theme does not have emits no rule at all, and nothing fails. `border-border-2` and its
 * `divide-`, `b-` and `bg-` spellings read like tokens, but until `uno.config.ts` gave the theme `border-1`..`border-4`
 * colours the line stayed transparent, because the preflight gives every border a transparent colour. `bg-bg-2` left
 * toolbars, menus and sticky headers see-through, `hover:bg-bg-3` gave no hover, and `text-t-quaternary` kept the
 * parent's colour. So this suite builds the real generator and asks it, for every class of those families the
 * renderer writes.
 *
 * `border-b-base` is the other trap: it reads like "the base border colour", but `b` is a direction and `base` is
 * the background, so it paints a bottom border in the page colour. The class that means the base border colour on
 * every side is `border-color-b-base`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { createGenerator } from 'unocss';
import { beforeAll, describe, expect, it } from 'vitest';

import unoConfig from '../../../uno.config';

const REPO_ROOT = path.join(__dirname, '../../..');
const RENDERER_DIR = path.join(REPO_ROOT, 'packages/desktop/src/renderer');

type Generator = Awaited<ReturnType<typeof createGenerator>>;
let uno: Generator;

beforeAll(async () => {
  uno = await createGenerator(unoConfig);
});

/** The CSS UnoCSS emits for one class, comments and line breaks removed; empty when it emits nothing. */
const cssFor = async (cls: string): Promise<string> => {
  const { css } = await uno.generate(cls, { preflights: false });
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*\n\s*/g, '')
    .trim();
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
  });

/**
 * CSS the renderer writes as text (a `boxSizing` value, a transition list) that the class pattern below also matches.
 * They are not classes, so emitting nothing is right for them.
 */
const CSS_WORDS = new Set(['border-box', 'border-color']);

/**
 * Every class of the colour families `bg-bg-*`, `text-t-*`, `bg-fill-*`, `border-*` and `divide-*` in the renderer
 * source, with its variants (`hover:`, `group-hover/label:`), important mark and opacity (`/40`). Read from the raw
 * text, so classes inside `${...}` expressions count too. A word followed by `:` is a CSS declaration, not a class.
 */
const colourFamilyClassesInSource = (): string[] => {
  const found = new Set<string>();
  const pattern = /(?<![\w-])((?:[\w/-]+:)*!?(?:bg-bg|text-t|bg-fill|border|divide)(?:-\w+)+(?:\/\d+)?)(?![\w/:-])/g;
  for (const file of sourceFiles(RENDERER_DIR)) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      if (!CSS_WORDS.has(match[1])) found.add(match[1]);
    }
  }
  return [...found].toSorted();
};

/** The classes of `classes` UnoCSS emits no rule for. */
const silentAmong = async (classes: string[]): Promise<string[]> => {
  const rules = await Promise.all(classes.map(cssFor));
  return classes.filter((_cls, index) => rules[index] === '');
};

/** Every `border-border-N`, `b-border-N`, `divide-border-N` and `bg-border-N` the renderer writes, variants included. */
const borderScaleClassesInSource = (): string[] => {
  const found = new Set<string>();
  const pattern = /(?<![\w-])((?:[\w-]+:)*!?(?:border|b|divide|bg)-border-[1-4])(?![\w-])/g;
  for (const file of sourceFiles(RENDERER_DIR)) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) found.add(match[1]);
  }
  return [...found].toSorted();
};

describe('the Arco border scale as UnoCSS colours', () => {
  it.each([1, 2, 3, 4])('border-border-%i paints Arco --color-border-%i', async (step) => {
    expect(await cssFor(`border-border-${step}`)).toBe(
      `.border-border-${step}{border-color:var(--color-border-${step});}`
    );
  });

  it('divide-border-2 paints the lines between the children', async () => {
    expect(await cssFor('divide-border-2')).toBe(
      '.divide-border-2>:not([hidden])~:not([hidden]){border-color:var(--color-border-2);}'
    );
  });

  it('keeps the numeric keys on the background scale', async () => {
    // The new keys are `border-N`, so `border-2` still means the bg-2 colour it meant before.
    expect(await cssFor('border-2')).toBe('.border-2{border-color:var(--bg-2);}');
    expect(await cssFor('bg-2')).toBe('.bg-2{background-color:var(--bg-2);}');
  });

  it('points at variables Arco defines', () => {
    const arco = readFileSync(path.join(REPO_ROOT, 'node_modules/@arco-design/web-react/dist/css/arco.css'), 'utf8');
    for (const step of [1, 2, 3, 4]) {
      expect(arco, `arco.css defines --color-border-${step}`).toMatch(new RegExp(`--color-border-${step}:`));
    }
  });

  it('emits a rule for every border-scale class the renderer uses', async () => {
    const classes = borderScaleClassesInSource();
    expect(classes.length).toBeGreaterThan(0);
    expect(await silentAmong(classes), 'classes UnoCSS emits no rule for').toEqual([]);
  });

  it('border-border-base paints the base border colour', async () => {
    expect(await cssFor('border-border-base')).toBe('.border-border-base{border-color:var(--border-base);}');
  });
});

describe('the background scale as bg-bg-N', () => {
  it('bg-bg-0 is the page colour', async () => {
    expect(await cssFor('bg-bg-0')).toBe('.bg-bg-0{background-color:var(--bg-base);}');
  });

  it.each([1, 2, 3, 4])('bg-bg-%i is the same colour as bg-%i', async (step) => {
    expect(await cssFor(`bg-bg-${step}`)).toBe(`.bg-bg-${step}{background-color:var(--bg-${step});}`);
  });

  it('works under a variant and as a border colour', async () => {
    expect(await cssFor('hover:bg-bg-3')).toBe('.hover\\:bg-bg-3:hover{background-color:var(--bg-3);}');
    expect(await cssFor('border-bg-2')).toBe('.border-bg-2{border-color:var(--bg-2);}');
  });

  it('points at variables both themes define', () => {
    for (const theme of ['default-color-scheme.css', 'mu-color-scheme.css']) {
      const css = readFileSync(path.join(RENDERER_DIR, 'styles/themes', theme), 'utf8');
      for (const name of ['--bg-base', '--bg-1', '--bg-2', '--bg-3', '--bg-4', '--border-base']) {
        expect(css, `${theme} defines ${name}`).toMatch(new RegExp(`${name}:`));
      }
    }
  });
});

describe('the text and fill tokens', () => {
  it('text-t-quaternary is Arco text-3, one step fainter than t-tertiary', async () => {
    expect(await cssFor('text-t-quaternary')).toBe('.text-t-quaternary{color:var(--color-text-3);}');
  });

  it('bg-fill-N takes an opacity through color-mix()', async () => {
    expect(await cssFor('bg-fill-1/40')).toContain(
      '{background-color:color-mix(in srgb, var(--color-fill-1) 40%, transparent);}'
    );
    expect(await cssFor('bg-fill-2')).toBe('.bg-fill-2{background-color:var(--color-fill-2);}');
  });

  it('points at variables Arco defines', () => {
    const arco = readFileSync(path.join(REPO_ROOT, 'node_modules/@arco-design/web-react/dist/css/arco.css'), 'utf8');
    expect(arco).toMatch(/--color-text-3:/);
    for (const step of [1, 2, 3, 4]) expect(arco).toMatch(new RegExp(`--color-fill-${step}:`));
  });
});

describe('every colour-family class the renderer writes', () => {
  it('finds the families it is meant to check', () => {
    const classes = colourFamilyClassesInSource();
    for (const expected of ['bg-bg-2', 'hover:bg-bg-3', 'text-t-primary', 'bg-fill-2', 'border-border-2']) {
      expect(classes, `the scan sees ${expected}`).toContain(expected);
    }
  });

  it('emits a rule for each of them', async () => {
    expect(await silentAmong(colourFamilyClassesInSource()), 'classes UnoCSS emits no rule for').toEqual([]);
  });
});

describe('the base border colour', () => {
  it('border-color-b-base paints every side in --border-base', async () => {
    expect(await cssFor('border-color-b-base')).toBe('.border-color-b-base{border-color:var(--border-base);}');
  });

  it('border-b-base is a bottom border in the background colour, not the base border colour', async () => {
    expect(await cssFor('border-b-base')).toBe('.border-b-base{border-bottom-color:var(--bg-base);}');
  });

  it('is never written as border-b-base in the renderer', () => {
    const offenders = sourceFiles(RENDERER_DIR).filter((file) =>
      /(?<![\w-])border-b-base(?![\w-])/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders.map((file) => path.relative(REPO_ROOT, file))).toEqual([]);
  });
});
