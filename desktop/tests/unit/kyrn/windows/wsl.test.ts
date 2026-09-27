import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WSL_START,
  withWslenv,
  wslLaunch,
  wslLocation,
} from '../../../../packages/desktop/src/process/agent/kyrn/windows/wsl.ts';

describe('a project inside WSL runs mu inside WSL', () => {
  it('knows a folder Windows shows from inside a WSL distribution', () => {
    expect(wslLocation('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\proj')).toEqual({
      distro: 'Ubuntu-24.04',
      path: '/home/me/proj',
    });
    expect(wslLocation('\\\\wsl$\\Debian\\srv')).toEqual({ distro: 'Debian', path: '/srv' });
    expect(wslLocation('//wsl.localhost/Ubuntu/home/me')).toEqual({ distro: 'Ubuntu', path: '/home/me' });
    expect(wslLocation('\\\\wsl.localhost\\Ubuntu')).toEqual({ distro: 'Ubuntu', path: '/' });
    expect(wslLocation('C:\\Users\\me\\proj')).toBeUndefined();
    expect(wslLocation('\\\\server\\share\\proj')).toBeUndefined();
    expect(wslLocation('/home/me/proj')).toBeUndefined();
  });

  it('starts wsl.exe in the distribution and folder, and carries the app’s variables and paths across', () => {
    const plan = wslLaunch({
      location: { distro: 'Ubuntu', path: '/home/me/proj' },
      session: 'C:\\Users\\me\\.mu\\acp-sessions\\a.jsonl',
      env: { MU_DESKTOP_SESSION: 's1', MU_LANG: 'zh-CN' },
      agentDir: 'C:\\Users\\me\\.mu\\agent',
      inherited: 'GOPATH/p:MU_AGENT_DIR',
      home: 'C:\\Users\\me',
    });
    expect(plan.command).toBe('wsl.exe');
    expect(plan.args.slice(0, 7)).toEqual([
      '--distribution',
      'Ubuntu',
      '--cd',
      '/home/me/proj',
      '--exec',
      'bash',
      '-lc',
    ]);
    expect(plan.cwd).toBe('C:\\Users\\me');
    expect(plan.env).toMatchObject({
      MU_DESKTOP_SESSION: 's1',
      MU_LANG: 'zh-CN',
      MU_AGENT_DIR: 'C:\\Users\\me\\.mu\\agent',
      MU_ACP_SESSION: 'C:\\Users\\me\\.mu\\acp-sessions\\a.jsonl',
    });
    // The user's own entries stay; ours win for a name in both, since a path needs /p.
    expect(plan.env.WSLENV).toBe('GOPATH/p:MU_DESKTOP_SESSION:MU_LANG:MU_AGENT_DIR/p:MU_ACP_SESSION/p');
    const fresh = wslLaunch({
      location: { distro: 'D', path: '/' },
      session: undefined,
      env: {},
      agentDir: 'C:\\a',
      inherited: undefined,
      home: 'C:\\h',
    });
    expect(fresh.env.WSLENV).toBe('MU_AGENT_DIR/p');
    expect(fresh.env).not.toHaveProperty('MU_ACP_SESSION');
  });

  it('merges WSLENV entries by name', () => {
    expect(withWslenv(undefined, ['A/p'])).toBe('A/p');
    expect(withWslenv('A:B/u', ['A/p'])).toBe('B/u:A/p');
    expect(withWslenv('::B::', ['C'])).toBe('B:C');
  });
});

describe('the start script inside the distribution', () => {
  // The script runs in the Linux distribution, which a POSIX machine stands in for. On Windows itself there is no such
  // bash with a home and nvm to try it in; the syntax check at the end runs there too.
  const posix = process.platform !== 'win32';
  let home = '';
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = '';
  });

  /** Runs WSL_START the way wsl.exe does (bash -lc), with only a bare PATH and this home. */
  function start(env: Record<string, string> = {}) {
    return spawnSync('bash', ['-lc', WSL_START], {
      env: { PATH: '/usr/bin:/bin', HOME: home, ...env },
      encoding: 'utf8',
    });
  }

  it.runIf(posix)('finds mu where nvm installed it, and starts it for RPC with the session when there is one', () => {
    home = mkdtempSync(join(tmpdir(), 'mu-wsl-'));
    const bin = join(home, '.nvm', 'versions', 'node', 'v24.16.0', 'bin');
    mkdirSync(bin, { recursive: true });
    // A stand-in mu that says how it was called and which node folder leads PATH.
    writeFileSync(join(bin, 'mu'), '#!/bin/sh\necho "args:$*"\necho "path:${PATH%%:*}"\n');
    chmodSync(join(bin, 'mu'), 0o755);
    const withSession = start({ MU_ACP_SESSION: '/mnt/c/Users/me/.mu/acp-sessions/a b.jsonl' });
    expect(withSession.status).toBe(0);
    expect(withSession.stdout).toContain('args:--mode rpc --session /mnt/c/Users/me/.mu/acp-sessions/a b.jsonl');
    expect(withSession.stdout).toContain(`path:${bin}`);
    expect(start().stdout).toContain('args:--mode rpc\n');
  });

  it.runIf(posix)('says what to install when mu is not in the distribution', () => {
    home = mkdtempSync(join(tmpdir(), 'mu-wsl-'));
    const missing = start();
    expect(missing.status).toBe(127);
    expect(missing.stderr).toContain('npm i -g mu-agent');
  });

  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n', '-c', WSL_START])).not.toThrow();
  });
});
