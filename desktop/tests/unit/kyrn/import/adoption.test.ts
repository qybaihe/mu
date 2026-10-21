import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKEND_CONVERSATION_ID_ENV } from '@/common/platform/backendNames';
import { KyrnAgent, MU_TURN_ERRORS } from '@/process/agent/kyrn/KyrnAgent';
import { readImportRecord, writeImportRecord } from '@/process/agent/kyrn/importChats';
import type { JsonRecord } from '@/process/agent/kyrn/piRpc';

const roots: string[] = [];
const temp = (name: string): string => {
  // The long name of every folder, as the adapter resolves it (Windows gives the temp folder by its short name).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `mu-adopt-${name}-`)));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An adapter whose harness processes are fakes: each reports the file it was started with, or a new one. */
function adapter() {
  const store = temp('store');
  const home = temp('home');
  const started: (string | undefined)[] = [];
  const agent = new KyrnAgent(
    { sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
    'fixture',
    store,
    (_cwd, file) => {
      started.push(file);
      const sessionFile = file ?? join(store, `fresh-${started.length}.jsonl`);
      return {
        send: async (command: JsonRecord) => {
          if (command.type === 'get_state')
            return { sessionFile, model: { provider: 'fixture', id: 'model' }, thinkingLevel: 'medium' };
          if (command.type === 'get_available_models') return { models: [] };
          if (command.type === 'get_available_thinking_levels') return { levels: [] };
          return {};
        },
        respond: () => {},
        close: () => {},
      };
    },
    home
  );
  return { agent, store, started };
}

/** A conversation the app made from an imported session: its record, and the session file. */
function imported(store: string, conversationId: string, cwd: string): string {
  const file = join(temp('sessions'), 'imported.jsonl');
  writeFileSync(file, '{"type":"session"}\n');
  writeImportRecord(store, conversationId, { version: 1, file, cwd, tool: 'codex', source: '/t/rollout.jsonl' });
  return file;
}

describe('an imported conversation’s first session', () => {
  it('opens the imported session, marks it taken, and a later new session of the conversation starts afresh', async () => {
    const { agent, store, started } = adapter();
    const project = temp('project');
    const file = imported(store, 'conv-1', project);
    vi.stubEnv(BACKEND_CONVERSATION_ID_ENV, 'conv-1');
    const first = await agent.newSession({ cwd: project, mcpServers: [] });
    expect(started).toEqual([file]);
    expect(readImportRecord(store, 'conv-1')?.session).toBe(first.sessionId);
    // The adapter's own record of the session names the imported file: a reopen loads it.
    expect(JSON.parse(readFileSync(join(store, `${first.sessionId}.json`), 'utf8'))).toMatchObject({
      cwd: project,
      file,
    });

    // Reset, or the backend's rebuild: the conversation's next new session is a new one.
    await agent.newSession({ cwd: project, mcpServers: [] });
    expect(started[1]).toBeUndefined();
    agent.close();
  });

  it('leaves every other conversation alone', async () => {
    const { agent, store, started } = adapter();
    const project = temp('project');
    imported(store, 'conv-1', project);
    vi.stubEnv(BACKEND_CONVERSATION_ID_ENV, 'conv-2');
    await agent.newSession({ cwd: project, mcpServers: [] });
    vi.stubEnv(BACKEND_CONVERSATION_ID_ENV, '');
    await agent.newSession({ cwd: project, mcpServers: [] });
    expect(started).toEqual([undefined, undefined]);
    expect(readImportRecord(store, 'conv-1')?.session).toBeUndefined();
    agent.close();
  });

  it('refuses a folder other than the one the transcript ran in, and starts afresh when the session file is gone', async () => {
    const { agent, store, started } = adapter();
    const project = temp('project');
    const elsewhere = temp('elsewhere');
    imported(store, 'conv-1', project);
    vi.stubEnv(BACKEND_CONVERSATION_ID_ENV, 'conv-1');
    await expect(agent.newSession({ cwd: elsewhere, mcpServers: [] })).rejects.toThrow(MU_TURN_ERRORS.wrongProject);
    expect(started).toEqual([]);

    const file = imported(store, 'conv-3', project);
    rmSync(file);
    vi.stubEnv(BACKEND_CONVERSATION_ID_ENV, 'conv-3');
    await agent.newSession({ cwd: project, mcpServers: [] });
    expect(started).toEqual([undefined]);
    agent.close();
  });
});
