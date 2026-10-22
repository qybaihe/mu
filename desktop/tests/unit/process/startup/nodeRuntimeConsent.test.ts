import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MANAGED_NODE_VERSION,
  hasManagedNodeRuntime,
  managedNodeRuntime,
  megabytes,
  planNodeRuntime,
  type ManagedNodeRuntime,
  type NodeRuntimeChoice,
} from '@/process/startup/nodeRuntimeConsent';

const runtime = managedNodeRuntime('/data', 'darwin', 'arm64') as ManagedNodeRuntime;

function plan(overrides: Partial<Parameters<typeof planNodeRuntime>[0]> = {}) {
  const ask = vi.fn(async (): Promise<NodeRuntimeChoice> => 'download');
  const result = planNodeRuntime({
    isPackaged: false,
    isE2E: false,
    preset: undefined,
    runtime,
    installed: false,
    ask,
    ...overrides,
  });
  return { ask, result };
}

describe('the Node.js runtime the backend would download', () => {
  it('is the archive the backend fetches, unpacked where it looks for it', () => {
    expect(runtime).toEqual({
      version: '24.11.0',
      dir: path.join('/data', 'runtime', 'node', 'node-v24.11.0-darwin-arm64'),
      bytes: 51_168_984,
      url: 'https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.gz',
    });
    expect(managedNodeRuntime('/data', 'win32', 'x64')?.url).toBe(
      'https://nodejs.org/dist/v24.11.0/node-v24.11.0-win-x64.zip'
    );
    expect(managedNodeRuntime('/data', 'linux', 'x64')?.dir).toBe(
      path.join('/data', 'runtime', 'node', 'node-v24.11.0-linux-x64')
    );
    expect(managedNodeRuntime('/data', 'freebsd', 'x64')).toBeUndefined();
  });

  it('matches the backend the app is built with', () => {
    // MANAGED_NODE_VERSION is the one the backend (v0.2.2) has: a new backend may bring a new Node.js, so look again when this fails.
    const root = path.resolve(__dirname, '../../../..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { backendVersion?: string };
    expect(pkg.backendVersion).toBe('v0.2.2');
    expect(MANAGED_NODE_VERSION).toBe('24.11.0');
  });

  it('counts as installed once its node binary is in place', () => {
    const seen: string[] = [];
    const exists = (file: string) => {
      seen.push(file);
      return true;
    };
    expect(hasManagedNodeRuntime(runtime, 'darwin', exists)).toBe(true);
    expect(seen).toEqual([path.join(runtime.dir, 'bin', 'node')]);

    const windows = managedNodeRuntime('/data', 'win32', 'x64') as ManagedNodeRuntime;
    expect(hasManagedNodeRuntime(windows, 'win32', (file) => file === path.join(windows.dir, 'node.exe'))).toBe(true);
    expect(hasManagedNodeRuntime(runtime, 'darwin', () => false)).toBe(false);
  });

  it('is told in whole megabytes', () => {
    expect(megabytes(51_168_984)).toBe(51);
    expect(megabytes(36_356_854)).toBe(36);
    expect(megabytes(10)).toBe(1);
  });
});

describe('planNodeRuntime', () => {
  it('asks before the first start of an unpackaged build downloads it', async () => {
    const { ask, result } = plan();
    await expect(result).resolves.toBe('download');
    expect(ask).toHaveBeenCalledWith(runtime);
  });

  it('passes the answer on', async () => {
    const { result } = plan({ ask: async () => 'later' });
    await expect(result).resolves.toBe('later');
  });

  it.each([
    ['a packaged app', { isPackaged: true }],
    ['a runtime already in place', { installed: true }],
    ['a platform the backend does not manage', { runtime: undefined }],
  ])('asks nothing for %s', async (_case, overrides) => {
    const { ask, result } = plan(overrides);
    await expect(result).resolves.toBe('ready');
    expect(ask).not.toHaveBeenCalled();
  });

  it.each(['download', 'later'] as const)('takes MU_NODE_RUNTIME=%s without a dialog', async (preset) => {
    const { ask, result } = plan({ preset, isE2E: true });
    await expect(result).resolves.toBe(preset);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks when MU_NODE_RUNTIME holds anything else', async () => {
    const { ask, result } = plan({ preset: 'yes' });
    await expect(result).resolves.toBe('download');
    expect(ask).toHaveBeenCalled();
  });

  it('never downloads unasked in an automated run', async () => {
    const { ask, result } = plan({ isE2E: true });
    await expect(result).resolves.toBe('later');
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks in an automated run too with MU_NODE_RUNTIME=ask', async () => {
    const ask = vi.fn(async (): Promise<NodeRuntimeChoice> => 'later');
    await expect(plan({ isE2E: true, preset: 'ask', ask }).result).resolves.toBe('later');
    expect(ask).toHaveBeenCalledWith(runtime);
  });
});
