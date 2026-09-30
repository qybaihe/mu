import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PiCommand } from '../../../../../../packages/desktop/src/common/utils/nativeHost/records.ts';
import { followsBranch } from '../../../../../../packages/desktop/src/process/services/nativeHost/conversations/branch.ts';
import { hostEnv } from '../../../../../../packages/desktop/src/process/services/nativeHost/conversations/hostEnv.ts';
import {
  findModel,
  readDefaultModel,
} from '../../../../../../packages/desktop/src/process/services/nativeHost/conversations/modelSearch.ts';

/** The small parts of a native conversation: where pi's branch went, the model search, mu's environment. */

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mu-conversation-parts-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const entry = (id: string, parentId: string | null) => ({ type: 'message', id, parentId });

describe('followsBranch', () => {
  it('holds for a session that went on in a straight line from the known leaf', () => {
    expect(followsBranch([], 'a', 'a')).toBe(true);
    expect(followsBranch([entry('b', 'a'), entry('c', 'b')], 'a', 'c')).toBe(true);
    expect(followsBranch([entry('a', null), entry('b', 'a')], null, 'b')).toBe(true);
  });

  it('fails for a leaf that moved, a branch beside the known one, or entries off the way', () => {
    // A rewind: nothing new, the leaf went back.
    expect(followsBranch([], 'c', 'a')).toBe(false);
    // New entries on another branch.
    expect(followsBranch([entry('d', 'a')], 'c', 'd')).toBe(false);
    // An entry the way to the leaf does not pass.
    expect(followsBranch([entry('x', 'a'), entry('b', 'a')], 'a', 'b')).toBe(false);
    // Entries while the leaf stayed.
    expect(followsBranch([entry('b', 'a')], 'a', 'a')).toBe(false);
    // Another session: nothing leads back to the known leaf.
    expect(followsBranch([entry('n1', null), entry('n2', 'n1')], 'c', 'n2')).toBe(false);
    // An empty session after one with entries.
    expect(followsBranch([], 'c', null)).toBe(false);
  });
});

describe('findModel', () => {
  const models = [
    { provider: 'vercel-ai-gateway', id: 'hidden' },
    { provider: 'e2e', id: 'first' },
    { provider: 'e2e', id: 'wanted' },
  ];

  function host(state: { model?: unknown }, listed = models) {
    const sent: PiCommand[] = [];
    return {
      sent,
      request: vi.fn(async (command: PiCommand) => {
        sent.push(command);
        if (command.type === 'get_available_models') return { models: listed };
        if (command.type === 'get_state') return state;
        return undefined;
      }) as never,
    };
  }

  it('sets the model new sessions start on, else the first one offered', async () => {
    const wanted = host({});
    await expect(
      findModel(wanted, { wanted: { provider: 'e2e', id: 'wanted' }, waits: [0], still: () => true })
    ).resolves.toBe(true);
    expect(wanted.sent.at(-1)).toEqual({ type: 'set_model', provider: 'e2e', modelId: 'wanted' });
    const first = host({});
    await expect(findModel(first, { waits: [0], still: () => true })).resolves.toBe(true);
    expect(first.sent.at(-1)).toEqual({ type: 'set_model', provider: 'e2e', modelId: 'first' });
  });

  it('chooses nothing when a model was set meanwhile, the host went, or none is offered', async () => {
    const chosen = host({ model: { provider: 'e2e', id: 'picked' } });
    await expect(findModel(chosen, { waits: [0], still: () => true })).resolves.toBe(false);
    expect(chosen.sent.some((command) => command.type === 'set_model')).toBe(false);
    const gone = host({});
    await expect(findModel(gone, { waits: [0], still: () => false })).resolves.toBe(false);
    expect(gone.sent).toEqual([]);
    const none = host({}, [{ provider: 'vercel-ai-gateway', id: 'hidden' }]);
    await expect(findModel(none, { waits: [0, 0], still: () => true })).resolves.toBe(false);
    expect(none.sent.filter((command) => command.type === 'get_available_models')).toHaveLength(2);
  });

  it('reads the model new sessions start on from pi’s settings', () => {
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });
    expect(readDefaultModel(agentDir)).toBeUndefined();
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'e2e', defaultModel: 'm' }));
    expect(readDefaultModel(agentDir)).toEqual({ provider: 'e2e', id: 'm' });
  });
});

describe('hostEnv', () => {
  it('names the conversation, and passes on the app’s language and the permission mode when there are ones', () => {
    const home = join(root, 'home');
    mkdirSync(join(home, '.mu'), { recursive: true });
    expect(hostEnv({ desktopSession: 'n-1', home })).toEqual({ MU_DESKTOP_SESSION: 'n-1' });
    writeFileSync(join(home, '.mu', 'app-language'), 'zh-CN\n');
    expect(hostEnv({ desktopSession: 'n-1', permissions: 'ask', home })).toEqual({
      MU_DESKTOP_SESSION: 'n-1',
      MU_LANG: 'zh-CN',
      MU_PERMISSIONS: 'ask',
    });
  });
});
