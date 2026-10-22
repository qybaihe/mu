import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readFromHost, type ToHost } from '../../../../../packages/desktop/src/process/services/nativeHost/protocol.ts';

const entry = fileURLToPath(
  new URL('../../../../../packages/desktop/src/process/services/nativeHost/entry.ts', import.meta.url)
);

/** A pi that answers with the command line it sees, as its first record, and then ends. */
const PI = `
export function setupCli() {}
export async function main(args, { rpcTransport }) {
  rpcTransport.write(JSON.stringify({ argv: process.argv.slice(1), execArgv: process.execArgv, args }));
  await rpcTransport.flush();
}
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Starts the host as the Node fork does (no options of its own) and returns pi's first record. */
async function commandLineOf(init: Omit<Extract<ToHost, { type: 'init' }>, 'type' | 'module'>) {
  const dir = mkdtempSync(join(tmpdir(), 'mu-host-entry-'));
  dirs.push(dir);
  const module = join(dir, 'pi.mjs');
  writeFileSync(module, PI);
  const child = fork(entry, [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
  const record = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.on('message', (raw) => {
      const message = readFromHost(raw);
      if (message?.type === 'out') resolve(JSON.parse(message.json) as Record<string, unknown>);
      if (message?.type === 'failed') reject(new Error(message.message));
    });
    child.on('exit', (code) => reject(new Error(`the host exited with ${code} first: ${stderr}`)));
  });
  child.send({ type: 'init', module, ...init } satisfies ToHost);
  try {
    return await record;
  } finally {
    child.kill();
  }
}

describe('the native host entry', () => {
  it('gives pi the command line it would have had, so its sub-agents start as on the command line', async () => {
    const seen = await commandLineOf({
      cli: '/mu/packages/coding-agent/src/cli.ts',
      args: ['-e', '/mu/packages/kyrn-judge/src/extension/kyrn-judge.ts', '--mode', 'rpc'],
      execArgv: ['--disable-warning=ExperimentalWarning'],
    });
    expect(seen).toEqual({
      argv: [
        '/mu/packages/coding-agent/src/cli.ts',
        '-e',
        '/mu/packages/kyrn-judge/src/extension/kyrn-judge.ts',
        '--mode',
        'rpc',
      ],
      execArgv: ['--disable-warning=ExperimentalWarning'],
      args: ['-e', '/mu/packages/kyrn-judge/src/extension/kyrn-judge.ts', '--mode', 'rpc'],
    });
  });

  it('leaves the command line as it is when the launcher names no script', async () => {
    const seen = await commandLineOf({ args: ['--mode', 'rpc'], execArgv: [] });
    expect(seen.argv).toEqual([entry]);
    expect(seen.args).toEqual(['--mode', 'rpc']);
  });
});
