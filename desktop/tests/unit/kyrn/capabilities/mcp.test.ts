/**
 * The MCP page reads the servers mu uses from mu's own configuration and the tools it takes them over from, by the
 * harness's rules, and writes only mu's own files. Nothing is connected. Every home here is a temporary folder: never
 * the real ~/.mu, ~/.claude.json, ~/.cursor or ~/.codex.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KyrnError } from '@/common/kyrn/errors';
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  switchMcpServer,
  type McpRoots,
} from '@/process/agent/kyrn/capabilities/mcp';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Home = McpRoots & {
  write: (path: string, value: unknown) => void;
  read: (path: string) => unknown;
  piFile: string;
  muFile: string;
};

function home(): Home {
  const dir = mkdtempSync(join(tmpdir(), 'mu-mcp-'));
  dirs.push(dir);
  const agentDir = join(dir, '.mu', 'agent');
  mkdirSync(agentDir, { recursive: true });
  const write = (path: string, value: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  return {
    home: dir,
    agentDir,
    write,
    read: (path) => JSON.parse(readFileSync(path, 'utf8')),
    piFile: join(agentDir, 'mcp.json'),
    muFile: join(agentDir, 'mu.json'),
  };
}

/** Every place a server can be defined, with one of each kind of entry. */
function everywhere(): Home {
  const h = home();
  h.write(h.piFile, {
    mcpServers: {
      docs: { url: 'https://docs.example.com/mcp?token=SECRET', headers: { Authorization: 'Bearer SECRET' } },
      files: { command: 'npx', args: ['-y', 'server-files', '.'], env: { API_KEY: 'SECRET' }, enabled: false },
      'bad name': { command: 'x' },
      legacy: { url: 'https://old.example.com/sse', type: 'sse' },
    },
  });
  h.write(h.muFile, {
    features: { inherit: { cursor: true } },
    mcp: {
      servers: {
        notes: { command: 'notes-server', description: 'Notes' },
        paused: { command: 'paused-server', enabled: false },
        github: { enabled: false },
      },
    },
  });
  h.write(join(h.home, '.claude.json'), {
    projects: { '/work/app': { mcpServers: { project: { command: 'project-only' } } } },
    mcpServers: {
      github: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'SECRET' } },
      docs: { command: 'shadowed-by-mcp-json' },
      quiet: { command: 'quiet-server', disabled: true },
    },
  });
  h.write(join(h.home, '.cursor', 'mcp.json'), {
    mcpServers: { stream: { url: 'https://stream.example.com/sse', type: 'sse' }, github: { command: 'later' } },
  });
  h.write(
    join(h.home, '.codex', 'config.toml'),
    [
      'model = "gpt"',
      '',
      '[mcp_servers.search]',
      'command = "search-mcp"',
      'args = ["--port", "0"]',
      '',
      '[mcp_servers.search.env]',
      'SEARCH_KEY = "SECRET"',
      '',
      '[mcp_servers.off]',
      'command = "off-server"',
      'enabled = false',
      '',
    ].join('\n')
  );
  return h;
}

async function failure(work: () => unknown): Promise<{ code: string; params: unknown }> {
  try {
    await work();
  } catch (error) {
    if (error instanceof KyrnError) return { code: error.code, params: error.params };
    throw error;
  }
  throw new Error('it did not fail');
}

const summary = (h: McpRoots) =>
  listMcpServers(h).servers.map(
    (server) =>
      `${server.source}:${server.name}:${server.on ? 'on' : 'off'}${server.lock ? `:${server.lock}` : ''}${server.removable ? ':removable' : ''}`
  );

describe('the MCP servers mu uses', () => {
  it('lists mu’s own, then those taken over, the first of a name winning and mcp.json over all', () => {
    const h = everywhere();
    expect(summary(h)).toEqual([
      'mu:docs:on:removable',
      'mu:files:off:removable',
      'mu:notes:on:removable',
      // Switched off in mu.json, which is mu's own: it keeps its switch.
      'claude:github:off',
      'codex:search:on',
      'mu:paused:off:removable',
      'claude:quiet:off:offInSource',
      'cursor:stream:off:unsupported',
      'codex:off:off:offInSource',
    ]);
    const list = listMcpServers(h);
    expect(list.feature).toBe(true);
    expect(list.unreadable).toEqual([]);
    expect(list.file).toBe(h.piFile);
    const by = Object.fromEntries(list.servers.map((server) => [server.name, server]));
    expect(by.docs).toMatchObject({ transport: 'http', target: 'https://docs.example.com/mcp', file: h.piFile });
    expect(by.files).toMatchObject({ transport: 'stdio', target: 'npx -y server-files .' });
    expect(by.github).toMatchObject({ target: 'gh-mcp', file: join(h.home, '.claude.json') });
    expect(by.search).toMatchObject({ target: 'search-mcp --port 0', file: join(h.home, '.codex', 'config.toml') });
    // No value of a variable or a header, nor the address's query, is ever read out.
    expect(JSON.stringify(list)).not.toContain('SECRET');
  });

  it('follows mu.json: no MCP feature leaves pi’s servers alone, no inheritance leaves mu’s own', () => {
    const h = everywhere();
    h.write(h.muFile, { features: { mcp: false }, mcp: { servers: { notes: { command: 'notes-server' } } } });
    expect(listMcpServers(h)).toMatchObject({ feature: false });
    expect(summary(h)).toEqual(['mu:docs:on:removable', 'mu:files:off:removable']);
    h.write(h.muFile, {
      features: { inherit: { mcp: false } },
      mcp: { servers: { notes: { command: 'notes-server' } } },
    });
    expect(summary(h)).toEqual(['mu:docs:on:removable', 'mu:files:off:removable', 'mu:notes:on:removable']);
    h.write(h.muFile, { features: { inherit: { claude: false, codex: false } } });
    expect(summary(h)).toEqual([
      'mu:docs:on:removable',
      'mu:files:off:removable',
      'cursor:github:on',
      'cursor:stream:off:unsupported',
    ]);
  });

  it('masks keys handed over as arguments, so the page can sit in a screenshot', () => {
    const h = home();
    h.write(h.piFile, {
      mcpServers: {
        flag: { command: 'srv', args: ['--api-key', 'abc123def456', '--port', '8080'] },
        assigned: { command: 'srv', args: ['--token=abc123def456', 'GITHUB_TOKEN=ghx', 'MODE=fast'] },
        shaped: { command: 'srv', args: ['sk-ant-api03-abcdefghij1234567890XYZ'] },
        database: { command: 'pg-mcp', args: ['postgres://admin:hunter2@db.local:5432/app'] },
      },
    });
    const target = (name: string) => listMcpServers(h).servers.find((server) => server.name === name)?.target;
    expect(target('flag')).toBe('srv --api-key •••• --port 8080');
    expect(target('assigned')).toBe('srv --token=•••• GITHUB_TOKEN=•••• MODE=fast');
    expect(target('shaped')).toBe('srv sk-ant-••••');
    expect(target('database')).toBe('pg-mcp postgres://admin:••••@db.local:5432/app');
    expect(JSON.stringify(listMcpServers(h))).not.toMatch(/abc123def456|hunter2|abcdefghij1234567890/);
  });

  it('names the files it could not read, and reads on as the harness does', () => {
    const h = everywhere();
    h.write(h.muFile, '{ broken');
    h.write(join(h.home, '.cursor', 'mcp.json'), 'not json');
    const list = listMcpServers(h);
    expect(list.unreadable).toEqual([h.muFile, join(h.home, '.cursor', 'mcp.json')]);
    expect(list.servers.map((server) => server.name)).toEqual(['docs', 'files', 'github', 'search', 'quiet', 'off']);
  });
});

describe('adding a server', () => {
  it('writes it to mcp.json as `mu mcp add` does, keeping the rest of the file and its indentation', () => {
    const h = home();
    h.write(
      h.piFile,
      '{\n\t"autoEnableCodemode": false,\n\t"mcpServers": {\n\t\t"docs": { "url": "https://d.example.com" }\n\t}\n}\n'
    );
    addMcpServer(h, { name: 'files', command: 'npx', args: ['-y', 'server-files', '~/Documents'], env: { KEY: '1' } });
    const after = addMcpServer(h, { name: 'remote', url: 'https://r.example.com/mcp', headers: { 'X-Team': 'a' } });
    expect(after.servers.map((server) => server.name)).toEqual(['docs', 'files', 'remote']);
    expect(h.read(h.piFile)).toEqual({
      autoEnableCodemode: false,
      mcpServers: {
        docs: { url: 'https://d.example.com' },
        files: { command: 'npx', args: ['-y', 'server-files', '~/Documents'], env: { KEY: '1' }, exposure: 'deferred' },
        remote: { url: 'https://r.example.com/mcp', headers: { 'X-Team': 'a' }, exposure: 'deferred' },
      },
    });
    expect(readFileSync(h.piFile, 'utf8')).toMatch(/^\{\n\t"autoEnableCodemode"/);
    expect(readFileSync(h.piFile, 'utf8').endsWith('}\n')).toBe(true);
  });

  it('makes the file when there is none, with no empty parts', () => {
    const h = home();
    addMcpServer(h, { name: 'plain', command: 'plain-server', args: [], env: {} });
    expect(h.read(h.piFile)).toEqual({ mcpServers: { plain: { command: 'plain-server', exposure: 'deferred' } } });
    expect(readFileSync(h.piFile, 'utf8')).toBe(
      '{\n  "mcpServers": {\n    "plain": {\n      "command": "plain-server",\n      "exposure": "deferred"\n    }\n  }\n}\n'
    );
  });

  it('refuses a name mu has (also with - for _), a name pi cannot take, and a server that cannot work', async () => {
    const h = everywhere();
    expect(await failure(() => addMcpServer(h, { name: 'docs', command: 'x', args: [], env: {} }))).toEqual({
      code: 'mcpExists',
      params: { name: 'docs' },
    });
    h.write(h.piFile, { mcpServers: { 'my-tools': { command: 'x' } } });
    expect(await failure(() => addMcpServer(h, { name: 'my_tools', command: 'y', args: [], env: {} }))).toEqual({
      code: 'mcpExists',
      params: { name: 'my-tools' },
    });
    expect(await failure(() => addMcpServer(h, { name: 'notes', command: 'y', args: [], env: {} }))).toMatchObject({
      code: 'mcpExists',
    });
    expect(await failure(() => addMcpServer(h, { name: 'two words', command: 'x', args: [], env: {} }))).toEqual({
      code: 'mcpName',
      params: { name: 'two words' },
    });
    expect(await failure(() => addMcpServer(h, { name: 'web', url: 'ftp://x', headers: {} }))).toEqual({
      code: 'mcpInvalid',
      params: { field: 'url' },
    });
    expect(await failure(() => addMcpServer(h, { name: 'cmd', command: '  ', args: [], env: {} }))).toMatchObject({
      params: { field: 'command' },
    });
    expect(
      await failure(() => addMcpServer(h, { name: 'cmd', command: 'x', args: [], env: { 'BAD-NAME': 'v' } }))
    ).toMatchObject({ code: 'mcpInvalid', params: { field: 'env' } });
    expect(
      await failure(() => addMcpServer(h, { name: 'web', url: 'https://x.example.com', headers: { 'X\nY': 'v' } }))
    ).toMatchObject({ params: { field: 'headers' } });
    // A server taken over may get a definition of mu's own: that one is used instead.
    const after = addMcpServer(h, { name: 'search', command: 'my-search', args: [], env: {} });
    expect(after.servers.filter((server) => server.name === 'search').map((server) => server.source)).toEqual(['mu']);
  });

  it('never writes over an mcp.json it cannot read', async () => {
    const h = home();
    h.write(h.piFile, '{ "mcpServers": ');
    expect(await failure(() => addMcpServer(h, { name: 'a', command: 'x', args: [], env: {} }))).toMatchObject({
      code: 'invalidJson',
    });
    expect(readFileSync(h.piFile, 'utf8')).toBe('{ "mcpServers": ');
    expect(listMcpServers(h).unreadable).toEqual([h.piFile]);
  });
});

describe('removing and switching', () => {
  it('removes mu’s own servers from the file that defines them, and refuses one taken over', async () => {
    const h = everywhere();
    removeMcpServer(h, 'files');
    removeMcpServer(h, 'notes');
    expect(Object.keys((h.read(h.piFile) as { mcpServers: object }).mcpServers)).toEqual([
      'docs',
      'bad name',
      'legacy',
    ]);
    expect((h.read(h.muFile) as { mcp: { servers: object } }).mcp.servers).toEqual({
      paused: { command: 'paused-server', enabled: false },
      github: { enabled: false },
    });
    expect(await failure(() => removeMcpServer(h, 'search'))).toEqual({
      code: 'notMine',
      params: { name: 'search', source: 'codex' },
    });
    expect(await failure(() => removeMcpServer(h, 'nowhere'))).toEqual({
      code: 'notFound',
      params: { name: 'nowhere' },
    });
  });

  it('switches pi’s servers and mu.json’s by their own `enabled`, those taken over by a switch in mu.json', async () => {
    const h = everywhere();
    switchMcpServer(h, 'docs', false);
    switchMcpServer(h, 'files', true);
    const pi = (h.read(h.piFile) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;
    expect(pi.docs.enabled).toBe(false);
    expect('enabled' in pi.files).toBe(false);

    switchMcpServer(h, 'paused', true);
    switchMcpServer(h, 'github', true);
    switchMcpServer(h, 'search', false);
    const servers = (h.read(h.muFile) as { mcp: { servers: Record<string, unknown> } }).mcp.servers;
    expect(servers).toEqual({
      notes: { command: 'notes-server', description: 'Notes' },
      paused: { command: 'paused-server' },
      search: { enabled: false },
    });
    expect(summary(h).filter((line) => /:(docs|files|paused|github|search):/.test(line))).toEqual([
      'mu:docs:off:removable',
      'mu:files:on:removable',
      // Switched on, it takes its place among the servers in use.
      'mu:paused:on:removable',
      'claude:github:on',
      'codex:search:off',
    ]);
    // The other tools' files are never written.
    expect(readFileSync(join(h.home, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.search]');
    expect(await failure(() => switchMcpServer(h, 'quiet', true))).toMatchObject({ code: 'invalid' });
    expect(await failure(() => switchMcpServer(h, 'stream', true))).toMatchObject({ code: 'invalid' });
    expect(await failure(() => switchMcpServer(h, 'docs', 'yes'))).toMatchObject({ code: 'invalid' });
  });
});
