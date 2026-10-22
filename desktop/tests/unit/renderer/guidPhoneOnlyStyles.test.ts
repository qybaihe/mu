/**
 * The home page's phone rules hold in the phone layout alone (html[data-phone-layout], which Layout sets). A desktop
 * window narrower than the phone breakpoint keeps the desktop page, centred and with no room at the bottom for a
 * phone's quick buttons, and scrolls it when it is taller than the window.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const guid = readFileSync(
  resolve(__dirname, '../../../packages/desktop/src/renderer/pages/guid/index.module.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

const PHONE = ':global(html[data-phone-layout])';

/** The inside of every `@media <query>` block. */
function mediaBlocks(css: string, query: string): string[] {
  const blocks: string[] = [];
  let from = css.indexOf(`@media ${query}`);
  while (from >= 0) {
    const open = css.indexOf('{', from);
    let depth = 1;
    let at = open + 1;
    while (depth > 0 && at < css.length) {
      if (css[at] === '{') depth += 1;
      else if (css[at] === '}') depth -= 1;
      at += 1;
    }
    blocks.push(css.slice(open + 1, at - 1));
    from = css.indexOf(`@media ${query}`, at);
  }
  return blocks;
}

/** The rules of the narrow-window blocks, each selector of a list on its own. */
const narrowRules = mediaBlocks(guid, '(max-width: 768px)').flatMap((block) =>
  (block.match(/[^{}]+\{[^}]*\}/g) ?? []).flatMap((rule) =>
    rule
      .slice(0, rule.indexOf('{'))
      .split(',')
      .map((selector) => ({ selector: selector.trim(), body: rule.slice(rule.indexOf('{') + 1, -1) }))
  )
);

const bodyOf = (selector: string): string | undefined => narrowRules.find((rule) => rule.selector === selector)?.body;

describe('the home page in a narrow window', () => {
  it('keeps room for bottom quick buttons on a phone only', () => {
    const bottomRoom = narrowRules.filter((rule) => /padding-bottom:\s*100px/.test(rule.body));

    expect(bottomRoom.map((rule) => rule.selector)).toEqual([`${PHONE} .guidLayout`]);
  });

  it('starts the page at the top on a phone only', () => {
    const topAligned = narrowRules.filter((rule) => /justify-content:\s*flex-start/.test(rule.body));

    expect(topAligned.map((rule) => rule.selector)).toEqual([`${PHONE} .guidContainer`]);
  });

  it('scrolls a page taller than the window, centred while it fits and from its top when it does not', () => {
    expect(bodyOf('.guidContainer')).toMatch(/justify-content:\s*safe center/);
    expect(bodyOf('.guidContainer')).toMatch(/overflow-y:\s*auto/);
    // Lifted above the middle, an overflowing page would have its top out of reach.
    expect(bodyOf('.guidContainer .guidLayout')).toMatch(/margin-top:\s*0/);
  });
});
