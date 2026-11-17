import { describe, expect, it } from 'vitest';
import {
  findFileRefs,
  inlineCodeSpans,
  localLinkPaths,
  withoutFencedCode,
} from '@/renderer/components/media/FileRefs/findFileRefs';

/** What a reply's markdown is read for (renderer/components/media/FileRefs/findFileRefs.ts). */

describe('inline code spans', () => {
  it('reads spans as CommonMark does', () => {
    expect(inlineCodeSpans('a `x.png` b ``y `z` w`` c')).toEqual(['x.png', 'y `z` w']);
    // One space on each side is dropped when both are there.
    expect(inlineCodeSpans('`` `tick` ``')).toEqual(['`tick`']);
    // A line end inside a span is a space.
    expect(inlineCodeSpans('`a\nb`')).toEqual(['a b']);
  });

  it('skips escaped and unclosed backticks, and never crosses a paragraph', () => {
    expect(inlineCodeSpans('\\`not.png\\` and `yes.png`')).toEqual(['yes.png']);
    expect(inlineCodeSpans('`open.png')).toEqual([]);
    expect(inlineCodeSpans('`a.png\n\nb.png`')).toEqual([]);
  });

  it('leaves fenced code out, backtick and tilde fences alike', () => {
    const markdown = [
      'Before `one.png`.',
      '```ts',
      'const a = `two.png`;',
      '```',
      '~~~',
      '`three.png`',
      '~~~',
      '- item',
      '  ```',
      '  `four.png`',
      '  ```',
      'After `five.png`.',
    ].join('\n');
    expect(inlineCodeSpans(markdown)).toEqual(['one.png', 'five.png']);
    expect(withoutFencedCode('```a``` and `x`')).toBe('```a``` and `x`');
  });
});

describe('local links', () => {
  it('finds links to local paths as the markdown view resolves them', () => {
    const markdown = [
      '[the card](out/card.png)',
      '[abs](/Users/me/a.pdf#L3)',
      '[spaced](<My Report.pdf> "title")',
      '[encoded](07_%E8%A7%92.png)',
      '![an image](shown.png)',
      '[web](https://example.com/x.png)',
      '[mail](mailto:a@b.c)',
      '[anchor](#top)',
    ].join('\n');
    expect(localLinkPaths(markdown)).toEqual(['out/card.png', '/Users/me/a.pdf', 'My Report.pdf', '07_角.png']);
  });
});

describe('a reply’s references', () => {
  it('keeps the path-like ones, once each, in order', () => {
    const markdown = [
      '1. `07_角色与场景关系卡_铁匠老秦_雨夜钢铁厂.png`',
      '2. `08_角色与场景关系卡_百变陆离_黄昏大剧院.png`',
      'Run `npm run build`, read `x.length`, call `foo.bar` or edit `index.ts`.',
      'Again `07_角色与场景关系卡_铁匠老秦_雨夜钢铁厂.png`, see [the report](out/report.pdf) and [docs](docs).',
      '```',
      '`hidden.png`',
      '```',
    ].join('\n');
    expect(findFileRefs(markdown)).toEqual([
      { ref: '07_角色与场景关系卡_铁匠老秦_雨夜钢铁厂.png', strength: 'strong' },
      { ref: '08_角色与场景关系卡_百变陆离_黄昏大剧院.png', strength: 'strong' },
      { ref: 'index.ts', strength: 'weak' },
      { ref: 'out/report.pdf', strength: 'strong' },
      // A link is a reference whatever it looks like; one that is not path-like keeps the app's own link if missing.
      { ref: 'docs', strength: 'weak' },
    ]);
  });

  it('keeps the reply’s order across code and links', () => {
    expect(
      findFileRefs('[first](a.png), then `b.png`, then [third](c.png) and `d.png`.').map((item) => item.ref)
    ).toEqual(['a.png', 'b.png', 'c.png', 'd.png']);
  });

  it('reads `file://` paths as the markdown view does, without the scheme', () => {
    expect(findFileRefs('`file:///Users/me/a.png`')).toEqual([{ ref: '/Users/me/a.png', strength: 'strong' }]);
  });

  it('finds nothing in plain prose', () => {
    expect(findFileRefs('The file a.png is in out/ and report.pdf is next to it.')).toEqual([]);
  });
});
