import { describe, expect, it } from 'vitest';
import { sessionSettings } from '../../../../../../packages/desktop/src/common/utils/nativeHost/settings.ts';

/** What a session file says its session runs with, the way pi and mu read it when they resume it. */

const entry = (id: string, parentId: string | null, fields: Record<string, unknown>) => ({
  id,
  parentId,
  timestamp: '2026-09-29T12:00:00.000Z',
  ...fields,
});
const reply = (id: string, parentId: string | null, provider: string, model: string) =>
  entry(id, parentId, { type: 'message', message: { role: 'assistant', content: [], provider, model } });

describe('sessionSettings', () => {
  it('takes the latest model, thinking level and permission mode on the branch', () => {
    expect(
      sessionSettings([
        { type: 'session', id: 's1', cwd: '/p' },
        entry('t1', null, { type: 'thinking_level_change', thinkingLevel: 'off' }),
        entry('m1', 't1', { type: 'model_change', provider: 'e2e', modelId: 'one' }),
        reply('a1', 'm1', 'e2e', 'one'),
        entry('p1', 'a1', { type: 'custom', customType: 'mu.permissions', data: { mode: 'ask' } }),
        // Set after the last reply: the next message meets these.
        entry('m2', 'p1', { type: 'model_change', provider: 'openrouter', modelId: 'anthropic/claude' }),
        entry('t2', 'm2', { type: 'thinking_level_change', thinkingLevel: 'high' }),
      ])
    ).toEqual({ model: 'openrouter/anthropic/claude', thinkingLevel: 'high', permissions: 'ask' });
  });

  it('follows the branch pi opens, and leaves out what it does not name or cannot be one', () => {
    const entries = [
      entry('a1', null, { type: 'model_change', provider: 'e2e', modelId: 'one' }),
      entry('b1', 'a1', { type: 'custom', customType: 'mu.permissions', data: { mode: 'full' } }),
      // Another branch from a1, the file's last entry: b1 is not on it.
      entry('c1', 'a1', { type: 'custom', customType: 'mu.permissions', data: { mode: 'Not A Mode' } }),
      reply('c2', 'c1', 'unknown', 'unknown'),
    ];
    expect(sessionSettings(entries)).toEqual({ model: 'e2e/one' });
    expect(sessionSettings(entries, 'b1')).toEqual({ model: 'e2e/one', permissions: 'full' });
    expect(sessionSettings(entries, null)).toEqual({});
    expect(sessionSettings([])).toEqual({});
  });
});
