import { describe, expect, it } from 'vitest';
import { closeOpenFence } from '@/renderer/pages/conversation/Messages/components/streamMarkdown';
import { hasSkillSuggest, stripSkillSuggest } from '@/renderer/utils/chat/skillSuggestParser';
import { hasThinkTags, stripThinkTags } from '@/renderer/utils/chat/thinkTagFilter';
import { convertLatexDelimiters } from '@/renderer/utils/chat/latexDelimiters';
import { splitMarkdownBlocks } from '@/renderer/components/Markdown/markdownUtils';
import { parseMuUiSpec } from '@/renderer/components/Markdown/MuUiBlock';

/** The assistant text exactly as the session jsonl stores it (native/01a1ea35, entry 14): valid JSON, LF fences. */
const FIXTURE =
  '```mu-ui\n{"title":"0.3.13 基线冒烟","items":[{"type":"row","items":[{"type":"stat","label":"基线","value":"v0.3.13"},{"type":"stat","label":"backend","value":"0.3.13"}]},{"type":"chart","kind":"bars","data":[{"label":"渲染","value":10},{"label":"复制","value":10},{"type":"chart","kind":"donut","data":[{"label":"通过","value":100}]}]},{"type":"callout","tone":"success","title":"冒烟","content":"**卡片+图表在 0.3.13 全正常**"}]}\n```';

describe('the mu-ui fence passes each reply-text pre-parser byte-exact', () => {
  it('fixture itself parses as a mu-ui spec (nested chart hoisted)', () => {
    const json = FIXTURE.split('\n').slice(1, -1).join('\n');
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = parseMuUiSpec(json);
    expect(parsed.ok).toBe(true);
  });

  it('think-tag filter leaves it unchanged', () => {
    expect(hasThinkTags(FIXTURE)).toBe(false);
    expect(stripThinkTags(FIXTURE)).toBe(FIXTURE);
  });

  it('skill-suggest filter leaves it unchanged', () => {
    expect(hasSkillSuggest(FIXTURE)).toBe(false);
    expect(stripSkillSuggest(FIXTURE)).toBe(FIXTURE);
  });

  it('open-fence closer leaves it unchanged', () => {
    expect(closeOpenFence(FIXTURE)).toBe(FIXTURE);
  });

  it('latex delimiter converter leaves it unchanged', () => {
    expect(convertLatexDelimiters(FIXTURE)).toBe(FIXTURE);
  });

  it('markdown block splitter leaves it as one block, unchanged', () => {
    expect(splitMarkdownBlocks(FIXTURE)).toEqual([FIXTURE]);
  });
});
