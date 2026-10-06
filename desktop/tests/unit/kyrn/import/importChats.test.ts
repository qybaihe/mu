import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KyrnError } from '@/common/kyrn/errors';
import { groupChats, importMarkOf, toolTally, type FoundChat } from '@/common/kyrn/importChats';
import {
  HISTORY_ITEMS,
  importCli,
  importEntryOf,
  importService,
  listImportRecords,
  runCommand,
  readImportedHistory,
  readImportedSession,
  readImportRecord,
  writeImportRecord,
  type CliOutput,
} from '@/process/agent/kyrn/importChats';
import type { BackendRequest } from '@/process/agent/kyrn/product';

const roots: string[] = [];
const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `mu-import-${name}-`));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A code the failure of `work` carries, or undefined when it throws none. */
async function code(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return error instanceof KyrnError ? error.code : `not a KyrnError: ${String(error)}`;
  }
  return undefined;
}

type Line = Record<string, unknown>;
const at = '2026-09-20T10:00:00.000Z';
const message = (role: string, content: unknown, id: string): Line => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: at,
  message: { role, content, timestamp: 0 },
});

/**
 * A session as `mu import` writes it, made up: the header, the marker, the name, the conversation; then, when
 * `later` is given, lines mu appended after the import.
 */
function session(dir: string, cwd: string, body: Line[], later: Line[] = [], tool = 'claude-code'): string {
  const file = join(dir, 'session.jsonl');
  const imported = [
    {
      type: 'custom_message',
      id: 'm1',
      parentId: null,
      timestamp: at,
      customType: 'mu.import',
      content: 'This conversation was imported.',
      display: true,
      details: {
        version: 1,
        tool,
        source: '/home/someone/.claude/projects/-work-app/0001.jsonl',
        sourceId: '0001',
        importedAt: at,
        counts: { entries: body.length + 2, user: 2, assistant: 3, toolCalls: 2 },
      },
    },
    { type: 'session_info', id: 'i1', parentId: 'm1', timestamp: at, name: 'Fix the login form' },
    ...body,
  ];
  const lines = [{ type: 'session', version: 3, id: 's1', timestamp: at, cwd }, ...imported, ...later];
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

const conversationBody: Line[] = [
  message('user', 'Fix the login form', 'u1'),
  message(
    'assistant',
    [
      { type: 'text', text: 'Looking at it.' },
      { type: 'toolCall', id: 'c1', name: 'Bash', arguments: { command: 'ls' } },
    ],
    'a1'
  ),
  message('toolResult', [{ type: 'text', text: 'src' }], 'r1'),
  message('assistant', [{ type: 'toolCall', id: 'c2', name: 'Bash', arguments: { command: 'cat x' } }], 'a2'),
  message('toolResult', [{ type: 'text', text: 'x' }], 'r2'),
  message('assistant', [{ type: 'text', text: 'Fixed: the handler was missing.' }], 'a3'),
  { type: 'compaction', id: 'k1', parentId: null, timestamp: at, summary: 'The form was fixed.', tokensBefore: 9 },
  {
    type: 'custom_message',
    id: 'x1',
    parentId: null,
    timestamp: at,
    customType: 'mu.import.context',
    content: 'hidden',
    display: false,
  },
  message('user', [{ type: 'text', text: 'Now add a test' }], 'u2'),
];

describe('the shared helpers', () => {
  const chat = (tool: FoundChat['tool'], title: string, cwd?: string): FoundChat => ({
    tool,
    path: `/t/${title}.jsonl`,
    title,
    modified: at,
    size: 1,
    ...(cwd ? { cwd } : {}),
  });

  it('groups by tool, Claude Code first, and filters by every word in the title or the folder', () => {
    const chats = [
      chat('codex', 'Deploy script'),
      chat('claude-code', 'Fix login', '/work/app'),
      chat('codex', 'Login page'),
    ];
    expect(groupChats(chats).map((group) => [group.tool, group.chats.map((each) => each.title)])).toEqual([
      ['claude-code', ['Fix login']],
      ['codex', ['Deploy script', 'Login page']],
    ]);
    expect(groupChats(chats, 'LOGIN').flatMap((group) => group.chats.map((each) => each.title))).toEqual([
      'Fix login',
      'Login page',
    ]);
    expect(groupChats(chats, 'login app').flatMap((group) => group.chats.map((each) => each.title))).toEqual([
      'Fix login',
    ]);
    expect(groupChats(chats, 'nothing')).toEqual([]);
  });

  it('reads the import mark from a conversation’s extra, and nothing from any other', () => {
    expect(
      importMarkOf({
        workspace: '/w',
        mu_import: { tool: 'codex', source: '/r.jsonl', user: 3, assistant: 4.7, toolCalls: -1 },
      })
    ).toEqual({ tool: 'codex', source: '/r.jsonl', user: 3, assistant: 4, toolCalls: 0 });
    expect(importMarkOf({ workspace: '/w' })).toBeUndefined();
    expect(importMarkOf({ mu_import: { tool: 'cursor', source: '/r' } })).toBeUndefined();
    expect(importMarkOf(null)).toBeUndefined();
  });

  it('counts the tools of an answer once each', () => {
    expect(toolTally(['Bash', 'Read', 'Bash'])).toEqual([
      { name: 'Bash', times: 2 },
      { name: 'Read', times: 1 },
    ]);
  });
});

describe('running mu import', () => {
  const ran: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run = async (
    command: string,
    args: string[],
    _timeoutMs: number,
    env: NodeJS.ProcessEnv
  ): Promise<CliOutput> => {
    ran.push({ command, args, env });
    return { code: 0, stdout: '{"conversations":[]}', stderr: '' };
  };
  afterEach(() => {
    ran.length = 0;
    vi.unstubAllEnvs();
  });

  it('says so when this mu has no import command, instead of handing `import` to the model', async () => {
    const cli = importCli({ root: '/mu', layout: 'repo' }, { platform: 'darwin', exists: () => false, run });
    expect(await code(() => cli(['--list', '--json'], 1000))).toBe('importMissing');
    expect(ran).toEqual([]);
    expect(importEntryOf({ root: '/mu', layout: 'repo' }, 'darwin')).toBe('/mu/packages/kyrn-judge/src/import/cli.ts');
    expect(importEntryOf({ root: '/mu', layout: 'package' }, 'linux')).toBe('/mu/judge/dist/import.js');
  });

  it('runs the bash forwarder of a checkout as it is: it finds its own Node', async () => {
    const cli = importCli({ root: '/mu', layout: 'repo' }, { platform: 'darwin', exists: () => true, run });
    await cli(['--list', '--json'], 1000);
    expect(ran.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: '/mu/kyrn/bin/kyrn', args: ['import', '--list', '--json'] },
    ]);
  });

  it('runs the Node launcher of a package the way the adapter runs mu: on MU_NODE, else on the app itself', async () => {
    const cli = importCli({ root: '/mu', layout: 'package' }, { platform: 'linux', exists: () => true, run });
    vi.stubEnv('MU_NODE', '/opt/node24/bin/node');
    await cli(['--json', '/t/a.jsonl'], 1000);
    vi.stubEnv('MU_NODE', '');
    await cli(['--list', '--json'], 1000);
    expect(ran.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: '/opt/node24/bin/node', args: ['/mu/kyrn/bin/mu.mjs', 'import', '--json', '/t/a.jsonl'] },
      { command: process.execPath, args: ['/mu/kyrn/bin/mu.mjs', 'import', '--list', '--json'] },
    ]);
    // The rest of the environment is the app's, as the adapter's is.
    expect(ran[1].env.PATH).toBe(process.env.PATH);
  });
});

describe('one run of a command', () => {
  it('answers with what it printed whatever its exit code, and fails when it hangs or cannot start', async () => {
    const node = process.execPath;
    expect(
      await runCommand(node, ['-e', 'process.stdout.write("{}"); process.stderr.write("warn"); process.exit(1)'], 10000)
    ).toEqual({
      code: 1,
      stdout: '{}',
      stderr: 'warn',
    });
    expect(await code(() => runCommand(node, ['-e', 'setTimeout(() => {}, 20000)'], 300))).toBe('importFailed');
    expect(await code(() => runCommand(join(tmpdir(), 'no-such-program'), [], 1000))).toBe('importFailed');
  });
});

describe('the import records the adapter reads', () => {
  it('are written and read back by conversation, and never under an id that is no conversation id', () => {
    const store = temp('store');
    const record = { version: 1 as const, file: '/s/a.jsonl', cwd: '/w', tool: 'codex' as const, source: '/r.jsonl' };
    writeImportRecord(store, 'conv-1', record);
    expect(readImportRecord(store, 'conv-1')).toEqual(record);
    expect(readImportRecord(store, '../conv-1')).toBeUndefined();
    expect(() => writeImportRecord(store, '../escape', record)).toThrow(KyrnError);
    writeFileSync(join(store, 'imports', 'broken.json'), '{');
    expect(listImportRecords(store)).toEqual([{ conversationId: 'conv-1', record }]);
  });
});

describe('reading an imported session back', () => {
  it('names its folder and origin, and shows only what the import wrote, answers joined up to the next message', () => {
    const dir = temp('session');
    const file = session(dir, '/work/app', conversationBody, [message('user', 'Asked later, in mu', 'later')]);
    expect(readImportedSession(file)).toMatchObject({
      cwd: '/work/app',
      name: 'Fix the login form',
      tool: 'claude-code',
      user: 2,
      assistant: 3,
      toolCalls: 2,
      entries: conversationBody.length + 2,
    });
    const history = readImportedHistory(file);
    expect(history.earlier).toBe(0);
    expect(history.items).toEqual([
      { kind: 'user', text: 'Fix the login form' },
      { kind: 'assistant', text: 'Looking at it.\n\nFixed: the handler was missing.', tools: ['Bash', 'Bash'] },
      { kind: 'summary', text: 'The form was fixed.' },
      { kind: 'user', text: 'Now add a test' },
    ]);
    const notImported = join(dir, 'plain.jsonl');
    writeFileSync(notImported, `${JSON.stringify({ type: 'session', cwd: '/w' })}\n`);
    expect(readImportedSession(notImported)).toBeUndefined();
    expect(() => readImportedHistory(notImported)).toThrow(KyrnError);
  });

  it('keeps the last steps of a long one and says how many came before, each text clipped', () => {
    const dir = temp('long');
    const many = Array.from({ length: HISTORY_ITEMS + 5 }, (_, index) =>
      message('user', `message ${index}`, `u${index}`)
    );
    many.push(message('assistant', [{ type: 'text', text: 'x'.repeat(5000) }], 'last'));
    const history = readImportedHistory(session(dir, '/w', many));
    expect(history.earlier).toBe(6);
    expect(history.items).toHaveLength(HISTORY_ITEMS);
    expect(history.items[0]).toEqual({ kind: 'user', text: 'message 6' });
    expect(history.items.at(-1)?.text.length).toBeLessThan(4100);
  });
});

describe('the import service', () => {
  type Call = { method: string; path: string; body?: unknown };
  /** A backend that knows some conversations and makes new ones as `new-1`, `new-2`… */
  function backend(existing: Record<string, string> = {}, failPost = false) {
    const calls: Call[] = [];
    let made = 0;
    const request: BackendRequest = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      if (method === 'GET') {
        const id = path.split('/').pop() ?? '';
        if (id in existing) return { id, name: existing[id] } as T;
        throw Object.assign(new Error('not found'), { name: 'BackendHttpError', status: 404 });
      }
      if (failPost)
        throw Object.assign(new Error('Backend POST failed (500)'), { name: 'BackendHttpError', status: 500 });
      made++;
      const name = (body as { name: string }).name;
      existing[`new-${made}`] = name;
      return { id: `new-${made}`, name } as T;
    };
    return { calls, request };
  }
  const cliAnswering = (stdout: unknown, stderr = '', exit = 0) => {
    const asked: string[][] = [];
    const cli = async (args: string[]): Promise<CliOutput> => {
      asked.push(args);
      return { code: exit, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr };
    };
    return { asked, cli };
  };

  it('lists what mu import found and which of it the app already holds', async () => {
    const store = temp('store');
    writeImportRecord(store, 'held', {
      version: 1,
      file: '/s/one.jsonl',
      cwd: '/w',
      tool: 'claude-code',
      source: '/t/one.jsonl',
    });
    writeImportRecord(store, 'deleted', {
      version: 1,
      file: '/s/two.jsonl',
      cwd: '/w',
      tool: 'codex',
      source: '/t/two.jsonl',
    });
    const { cli, asked } = cliAnswering({
      conversations: [
        {
          tool: 'claude-code',
          path: '/t/one.jsonl',
          cwd: '/w',
          title: 'One',
          modified: at,
          size: 10,
          subAgent: false,
          importedAs: '/s/one.jsonl',
        },
        {
          tool: 'codex',
          path: '/t/two.jsonl',
          title: 'Two',
          modified: at,
          size: 20,
          subAgent: false,
          importedAs: '/s/two.jsonl',
        },
        { tool: 'codex', path: '/t/three.jsonl', title: 'Three', modified: at, size: 30, subAgent: false },
        { tool: 'cursor', path: '/t/other.jsonl' },
      ],
    });
    const { request } = backend({ held: 'One' });
    const service = importService({ cli, request, store, assistant: async () => 'mu-assistant' });
    const { conversations } = await service.list('/w');
    expect(asked).toEqual([['--list', '--json', '--cwd', '/w']]);
    expect(conversations.map((chat) => [chat.title, chat.conversationId])).toEqual([
      ['One', 'held'],
      ['Two', undefined],
      ['Three', undefined],
    ]);
    expect(await code(() => service.list('relative/dir'))).toBe('invalid');
  });

  it('shows what mu import said when it answers with anything but its JSON', async () => {
    const { cli } = cliAnswering('Usage: mu [options]', 'unknown command import', 2);
    const service = importService({
      cli,
      request: backend().request,
      store: temp('store'),
      assistant: async () => 'a',
    });
    let failure: unknown;
    try {
      await service.list();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(KyrnError);
    expect((failure as KyrnError).code).toBe('importFailed');
    expect((failure as KyrnError).message).toContain('unknown command import');
  });

  it('makes each imported session a conversation in its folder, and a record that hands it the session', async () => {
    const store = temp('store');
    const project = temp('project');
    const sessions = temp('sessions');
    const file = session(sessions, project, conversationBody);
    const { cli, asked } = cliAnswering({
      results: [
        {
          status: 'imported',
          source: '/t/one.jsonl',
          tool: 'claude-code',
          sessionFile: file,
          sessionId: 's1',
          name: 'Fix the login form',
          cwd: project,
          counts: {},
        },
        { status: 'failed', source: '/t/gone.jsonl', error: 'no such file' },
        { status: 'failed', source: '/t/dir', error: 'not a file' },
        { status: 'failed', source: '/t/odd.jsonl', error: 'Unexpected end of input' },
      ],
    });
    const { request, calls } = backend();
    const service = importService({ cli, request, store, assistant: async () => 'mu-assistant' });
    const outcomes = await service.run(['/t/one.jsonl', '/t/gone.jsonl', '/t/dir', '/t/odd.jsonl'], 'zh-CN');
    expect(asked).toEqual([['--json', '/t/one.jsonl', '/t/gone.jsonl', '/t/dir', '/t/odd.jsonl']]);
    expect(outcomes).toEqual([
      {
        status: 'imported',
        source: '/t/one.jsonl',
        tool: 'claude-code',
        conversationId: 'new-1',
        name: 'Fix the login form',
      },
      { status: 'failed', source: '/t/gone.jsonl', reason: 'missing', detail: 'no such file' },
      { status: 'failed', source: '/t/dir', reason: 'notFile', detail: 'not a file' },
      { status: 'failed', source: '/t/odd.jsonl', reason: 'other', detail: 'Unexpected end of input' },
    ]);
    const post = calls.find((call) => call.method === 'POST');
    expect(post).toEqual({
      method: 'POST',
      path: '/api/conversations',
      body: {
        name: 'Fix the login form',
        assistant: { id: 'mu-assistant', locale: 'zh-CN' },
        extra: {
          workspace: project,
          custom_workspace: true,
          mu_import: {
            tool: 'claude-code',
            source: '/home/someone/.claude/projects/-work-app/0001.jsonl',
            user: 2,
            assistant: 3,
            toolCalls: 2,
          },
        },
      },
    });
    const record = readImportRecord(store, 'new-1');
    expect(record).toMatchObject({ version: 1, file, tool: 'claude-code' });
    expect(record?.session).toBeUndefined();
    expect(JSON.parse(readFileSync(join(store, 'imports', 'new-1.json'), 'utf8')).file).toBe(file);
  });

  it('finds the conversation that holds a session instead of making a second one, and makes one for a session imported in the terminal', async () => {
    const store = temp('store');
    const project = temp('project');
    const held = session(temp('a'), project, conversationBody);
    const fromTerminal = session(temp('b'), project, conversationBody);
    writeImportRecord(store, 'held', {
      version: 1,
      file: held,
      cwd: project,
      tool: 'claude-code',
      source: '/t/held.jsonl',
    });
    const { cli } = cliAnswering({
      results: [
        { status: 'already-imported', source: '/t/held.jsonl', tool: 'claude-code', sessionFile: held, sessionId: 's' },
        {
          status: 'already-imported',
          source: '/t/terminal.jsonl',
          tool: 'claude-code',
          sessionFile: fromTerminal,
          sessionId: 't',
        },
        {
          status: 'already-imported',
          source: '/t/terminal.jsonl',
          tool: 'claude-code',
          sessionFile: fromTerminal,
          sessionId: 't',
        },
      ],
    });
    const { request, calls } = backend({ held: 'Held one' });
    const service = importService({ cli, request, store, assistant: async () => 'mu-assistant' });
    const outcomes = await service.run(['/t/held.jsonl', '/t/terminal.jsonl', '/t/terminal.jsonl'], 'en-US');
    expect(outcomes).toEqual([
      { status: 'listed', source: '/t/held.jsonl', conversationId: 'held', name: 'Held one' },
      {
        status: 'imported',
        source: '/t/terminal.jsonl',
        tool: 'claude-code',
        conversationId: 'new-1',
        name: 'Fix the login form',
      },
      { status: 'listed', source: '/t/terminal.jsonl', conversationId: 'new-1', name: 'Fix the login form' },
    ]);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    // The conversation made in this call is known without asking the backend for it.
    expect(calls.filter((call) => call.path === '/api/conversations/new-1')).toEqual([]);
  });

  it('leaves out a session whose folder is gone and goes on after a backend failure', async () => {
    const store = temp('store');
    const gone = join(temp('parent'), 'moved-away');
    const project = temp('project');
    const lost = session(temp('a'), gone, conversationBody);
    const fine = session(temp('b'), project, conversationBody);
    const { cli } = cliAnswering({
      results: [
        { status: 'imported', source: '/t/lost.jsonl', tool: 'codex', sessionFile: lost, sessionId: 'l' },
        { status: 'imported', source: '/t/fine.jsonl', tool: 'codex', sessionFile: fine, sessionId: 'f' },
      ],
    });
    const service = importService({ cli, request: backend({}, true).request, store, assistant: async () => 'a' });
    const outcomes = await service.run(['/t/lost.jsonl', '/t/fine.jsonl'], 'en-US');
    expect(outcomes[0]).toEqual({ status: 'failed', source: '/t/lost.jsonl', reason: 'folderMissing', detail: gone });
    expect(outcomes[1]).toMatchObject({ status: 'failed', source: '/t/fine.jsonl', reason: 'other' });
    expect(listImportRecords(store)).toEqual([]);
  });

  it('with the app running mu itself, makes no app conversation: the session is the conversation', async () => {
    const store = temp('store');
    const project = temp('project');
    const gone = join(temp('parent'), 'moved-away');
    const made = session(temp('a'), project, conversationBody);
    const before = session(temp('b'), project, conversationBody);
    const lost = session(temp('c'), gone, conversationBody);
    const { cli } = cliAnswering({
      results: [
        { status: 'imported', source: '/t/new.jsonl', tool: 'claude-code', sessionFile: made, sessionId: 's1' },
        {
          status: 'already-imported',
          source: '/t/old.jsonl',
          tool: 'claude-code',
          sessionFile: before,
          sessionId: 's1',
        },
        { status: 'imported', source: '/t/lost.jsonl', tool: 'claude-code', sessionFile: lost, sessionId: 's1' },
      ],
    });
    const { request, calls } = backend();
    const service = importService({ cli, request, store, assistant: async () => 'mu-assistant' });
    const outcomes = await service.run(['/t/new.jsonl', '/t/old.jsonl', '/t/lost.jsonl'], 'en-US', true);
    expect(outcomes).toEqual([
      {
        status: 'imported',
        source: '/t/new.jsonl',
        tool: 'claude-code',
        conversationId: 's1',
        name: 'Fix the login form',
        native: true,
      },
      { status: 'listed', source: '/t/old.jsonl', conversationId: 's1', name: 'Fix the login form', native: true },
      { status: 'failed', source: '/t/lost.jsonl', reason: 'folderMissing', detail: gone },
    ]);
    expect(calls).toEqual([]);
    expect(listImportRecords(store)).toEqual([]);

    // The list names the session each transcript became, by the id the native host knows it by.
    const listing = cliAnswering({
      conversations: [
        { tool: 'claude-code', path: '/t/old.jsonl', title: 'Old', modified: at, size: 1, importedAs: before },
        { tool: 'codex', path: '/t/fresh.jsonl', title: 'Fresh', modified: at, size: 1 },
        { tool: 'codex', path: '/t/deleted.jsonl', title: 'Deleted', modified: at, size: 1, importedAs: '/s/no.jsonl' },
      ],
    });
    const lister = importService({ cli: listing.cli, request, store, assistant: async () => 'mu-assistant' });
    const { conversations } = await lister.list(undefined, true);
    expect(conversations.map((chat) => [chat.path, chat.conversationId, chat.native])).toEqual([
      ['/t/old.jsonl', 's1', true],
      ['/t/fresh.jsonl', undefined, undefined],
      ['/t/deleted.jsonl', undefined, undefined],
    ]);
    expect(calls).toEqual([]);
  });

  it('refuses paths that are not absolute, and too many at once', async () => {
    const { cli, asked } = cliAnswering({ results: [] });
    const service = importService({
      cli,
      request: backend().request,
      store: temp('store'),
      assistant: async () => 'a',
    });
    expect(await code(() => service.run(['relative.jsonl'], 'en-US'))).toBe('invalid');
    expect(await code(() => service.run([], 'en-US'))).toBe('invalid');
    expect(
      await code(() =>
        service.run(
          Array.from({ length: 501 }, (_, i) => `/t/${i}.jsonl`),
          'en-US'
        )
      )
    ).toBe('invalid');
    expect(asked).toEqual([]);
  });

  it('reads an imported conversation’s history by its record, and refuses any other conversation', async () => {
    const store = temp('store');
    const file = session(temp('s'), '/w', conversationBody);
    writeImportRecord(store, 'conv', { version: 1, file, cwd: '/w', tool: 'claude-code', source: '/t/x.jsonl' });
    mkdirSync(join(store, 'imports'), { recursive: true });
    const service = importService({
      cli: cliAnswering({}).cli,
      request: backend().request,
      store,
      assistant: async () => 'a',
    });
    expect((await service.history('conv')).items).toHaveLength(4);
    expect(await code(() => service.history('other'))).toBe('invalid');
    expect(await code(() => service.history('../conv'))).toBe('invalid');
    rmSync(file);
    expect(await code(() => service.history('conv'))).toBe('importFailed');
  });
});
