import { describe, expect, it } from 'vitest';
import { createInitStyle } from '@renderer/components/Markdown/ShadowView';

/**
 * How a reply's file references look (the styles of the reply's shadow root, components/Markdown/ShadowView.tsx).
 *
 * - The folder icon after a link to a file showed only on hover, and kept its width the rest of the time: a blank gap
 *   before the next words ("out/report.pdf    , and"). Now it is out of the flow, where it would have been, and takes
 *   no room and no clicks until the link is hovered or has the keyboard's focus.
 * - A name that points at no file was drawn in the disabled grey, 1.5:1 on inline code's background: hard to read. Now
 *   it is the tertiary text colour, above 4.5:1 in both themes.
 *
 * jsdom does not lay the page out, so these pin the rules the look depends on.
 */
const rules = (): CSSStyleRule[] => {
  const style = createInitStyle('light');
  document.head.appendChild(style);
  const found = [...(style.sheet?.cssRules ?? [])].filter((rule): rule is CSSStyleRule => 'selectorText' in rule);
  style.remove();
  return found;
};

/** A rule's selectors, with the quotes the tests write. */
const parts = (text: string) => text.split(',').map((part) => part.trim().replaceAll('"', "'"));

/** The rule with exactly these selectors. */
const ruleFor = (...selectors: string[]): CSSStyleRule => {
  const rule = rules().find((each) => parts(each.selectorText).join(',') === selectors.join(','));
  if (!rule) throw new Error(`no rule for ${selectors.join(', ')}`);
  return rule;
};

describe('the look of a reply’s file references', () => {
  it('keeps the folder icon out of the line until the link is hovered or has the keyboard’s focus', () => {
    const icon = ruleFor('.markdown-shadow-body .markdown-file-ref-reveal');
    expect(icon.style.getPropertyValue('position')).toBe('absolute');
    // No offsets: it sits where it would have been in the line, right at the link's end.
    for (const side of ['top', 'right', 'bottom', 'left', 'inset']) expect(icon.style.getPropertyValue(side)).toBe('');
    expect(icon.style.getPropertyValue('margin-inline-start')).toBe('');
    expect(icon.style.getPropertyValue('opacity')).toBe('0');
    expect(icon.style.getPropertyValue('pointer-events')).toBe('none');
    // It covers the words after the link while it shows: on the page's background, not see-through.
    expect(icon.style.getPropertyValue('background')).toBe('var(--bg-1)');
    // The reference holds it, so it scrolls with the reply.
    expect(ruleFor('.markdown-shadow-body .markdown-file-ref').style.getPropertyValue('position')).toBe('relative');

    // Not any focus (`:focus-within`): a click leaves the link focused, and the icon would stay over the words after it.
    const shown = ruleFor(
      '.markdown-shadow-body .markdown-file-ref:hover .markdown-file-ref-reveal',
      '.markdown-shadow-body .markdown-file-ref:has(:focus-visible) .markdown-file-ref-reveal'
    );
    expect(shown.style.getPropertyValue('opacity')).toBe('1');
    expect(shown.style.getPropertyValue('pointer-events')).toBe('auto');
  });

  it('draws a name that points at no file in the tertiary text colour, not the disabled grey', () => {
    const missing = ruleFor(
      ".markdown-shadow-body .markdown-file-ref[aria-disabled='true'] code",
      ".markdown-shadow-body .markdown-file-ref[aria-disabled='true'] .markdown-file-ref-label"
    );
    expect(missing.style.getPropertyValue('color')).toBe('var(--bg-6)');
    expect(missing.style.getPropertyValue('cursor')).toBe('help');
  });
});
