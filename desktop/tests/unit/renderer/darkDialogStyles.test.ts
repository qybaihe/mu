/**
 * Dark dialogs sit on the card surface (--dialog-fill-0, a shade above the page's --bg-1) inside a hairline. The hairline goes
 * round the whole dialog: the body of a plain Arco modal is only the part between its title and its buttons, so a
 * line round the body would box the text in. An MuModal's body is the whole dialog, and it draws its own.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const renderer = resolve(__dirname, '../../../packages/desktop/src/renderer');
const read = (path: string): string => readFileSync(resolve(renderer, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const scheme = read('styles/themes/mu-color-scheme.css');
const arco = read('styles/arco-override.css');
const fileList = readFileSync(resolve(renderer, 'components/media/HorizontalFileList.tsx'), 'utf8');

/** The body of the first rule whose selector list names exactly `selector`. */
function body(css: string, selector: string): string {
  const rules = css.match(/[^{}]+\{[^}]+\}/g) ?? [];
  const rule = rules.find((candidate) =>
    candidate
      .slice(0, candidate.indexOf('{'))
      .split(',')
      .some((part) => part.trim() === selector)
  );
  return rule?.slice(rule.indexOf('{') + 1, -1) ?? '';
}

describe('dark dialogs', () => {
  it('fill with the card surface, a shade above the page', () => {
    const dark = body(scheme, "[data-color-scheme='mu'][data-theme='dark']");
    /** The sum of a token's three channels: a lighter colour has the larger sum. */
    const hex = (name: string): number => {
      const value = new RegExp(`${name}: #([0-9a-f]{6});`).exec(dark)?.[1] ?? '';
      expect(value, name).not.toBe('');
      return [0, 2, 4].reduce((sum, at) => sum + parseInt(value.slice(at, at + 2), 16), 0);
    };
    expect(hex('--dialog-fill-0')).toBeGreaterThan(hex('--bg-1'));
    expect(hex('--border-base')).toBeGreaterThan(hex('--dialog-fill-0'));
    expect(body(arco, "body[arco-theme='dark'] .arco-modal")).toContain('background-color: var(--dialog-fill-0)');
    expect(body(arco, "body[arco-theme='dark'] .arco-modal-content")).toContain(
      'background-color: var(--dialog-fill-0)'
    );
  });

  it('draw the hairline round the whole dialog, never round a plain modal body', () => {
    expect(body(arco, "body[arco-theme='dark'] .arco-modal:not(.mu-modal)")).toContain(
      'border: 1px solid var(--border-base)'
    );
    expect(body(arco, "body[arco-theme='dark'] .arco-modal-content")).not.toContain('border');
    expect(body(arco, '.mu-modal .arco-modal-content')).toContain('border: 1px solid var(--border-base)');
  });

  it('keep the accent off their surfaces', () => {
    for (const selector of [
      "body[arco-theme='dark'] .arco-modal",
      "body[arco-theme='dark'] .arco-modal-content",
      "body[arco-theme='dark'] .arco-modal:not(.mu-modal)",
      '.mu-modal .arco-modal-content',
    ]) {
      expect(body(arco, selector)).not.toMatch(/primary|accent|violet|pink/);
    }
  });
});

describe('the file strip in a message input', () => {
  it('fades its scroll edges into the composer surface', () => {
    expect(fileList.match(/var\(--mu-composer-bg, var\(--dialog-fill-0\)\)/g)).toHaveLength(2);
  });
});
