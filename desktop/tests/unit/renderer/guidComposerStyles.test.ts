/**
 * The new-conversation card and the send box are one look: the page's own surface and a hairline in both themes,
 * focus as a darker hairline and a lifted shadow rather than the accent, a dashed outline for a file held over them.
 * The project strip under the card's input is the card's own surface below a hairline, not a tinted tray.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const renderer = resolve(__dirname, '../../../packages/desktop/src/renderer');
const read = (path: string): string => readFileSync(resolve(renderer, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const guid = read('pages/guid/index.module.css');
const sendbox = read('components/chat/SendBox/sendbox.css');
const scheme = read('styles/themes/mu-color-scheme.css');

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

describe('the two message inputs', () => {
  it('share one surface, the page’s own in both themes, and a hairline marks them as fields', () => {
    const light = body(scheme, "[data-color-scheme='mu']");
    const dark = body(scheme, "[data-color-scheme='mu'][data-theme='dark']");
    expect(light).toContain('--mu-composer-bg: #ffffff');
    expect(light).toContain('--bg-1: #ffffff');
    expect(dark).toContain('--mu-composer-bg: var(--bg-1)');
    expect(dark).toMatch(/--mu-input-border: #[0-9a-f]{6};/);
    expect(body(sendbox, '.sendbox-panel')).toContain('background-color: var(--mu-composer-bg');
    expect(body(sendbox, '.sendbox-panel')).toContain('border: 1px solid var(--mu-input-border');
    expect(body(guid, '.guidInputCardWrap')).toContain('background: var(--mu-composer-bg');
  });

  it('draw the same hairline, focus and drag outline, and tint nothing', () => {
    const card = body(guid, '.guidInputCardWrap');
    const focused = body(guid, ".guidInputCardWrap[data-active='true']");
    const dragged = body(guid, ".guidInputCardWrap[data-dragging='true']");
    expect(card).toContain('border: 1px solid var(--mu-input-border, var(--color-border-2))');
    expect(card).toContain('box-shadow: var(--mu-shadow-1, none)');
    expect(focused).toContain('border-color: var(--color-border-3)');
    expect(focused).toContain('box-shadow: var(--mu-shadow-2, none)');
    expect(dragged).toContain('border-style: dashed');
    expect(body(sendbox, '.sendbox-panel--active')).toContain('border-color: var(--color-border-3)');
    for (const rule of [card, focused, dragged]) expect(rule).not.toMatch(/primary|accent|violet|pink|bg-2/);
  });

  it('keeps the project strip on the card’s own surface, below a hairline', () => {
    const input = body(guid, '.guidInputInner');
    expect(input).toContain('border-bottom: 1px solid var(--border-base)');
    expect(input).not.toContain('background');
    expect(body(guid, '.workspaceFootnote')).toContain('background: transparent');
  });
});
