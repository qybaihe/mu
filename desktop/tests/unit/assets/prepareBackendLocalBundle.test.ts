import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { prepareBackend } = require('../../../packages/shared-scripts/src/prepare-backend');

describe('prepare-backend local bundle input', () => {
  it('hard fails local bundle input that lacks managed-resources manifest', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mu-local-bundle-'));
    const projectRoot = join(tmp, 'project');
    const localBundle = join(tmp, 'bundle');
    mkdirSync(join(localBundle, 'managed-resources'), { recursive: true });
    writeFileSync(join(localBundle, 'aioncore.exe'), '');

    const previous = process.env.MU_BACKEND_LOCAL_BUNDLE_DIR;
    process.env.MU_BACKEND_LOCAL_BUNDLE_DIR = localBundle;
    try {
      expect(() =>
        prepareBackend({
          projectRoot,
          platform: 'win32',
          arch: 'x64',
          version: 'v0.1.46',
        })
      ).toThrow(/managed-resources\/manifest\.json/);
    } finally {
      if (previous === undefined) delete process.env.MU_BACKEND_LOCAL_BUNDLE_DIR;
      else process.env.MU_BACKEND_LOCAL_BUNDLE_DIR = previous;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('keeps the bundled Node relative links relative', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mu-local-bundle-'));
    const projectRoot = join(tmp, 'project');
    const localBundle = join(tmp, 'bundle');
    const nodeRoot = 'node/node-v24.11.0-darwin-arm64';
    const node = join(localBundle, 'managed-resources', nodeRoot);
    mkdirSync(join(node, 'bin'), { recursive: true });
    mkdirSync(join(node, 'lib/node_modules/npm/bin'), { recursive: true });
    writeFileSync(join(localBundle, 'aioncore'), '');
    writeFileSync(join(node, 'bin/node'), '');
    writeFileSync(join(node, 'lib/node_modules/npm/bin/npm-cli.js'), '');
    symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(node, 'bin/npm'));
    writeFileSync(
      join(localBundle, 'managed-resources/manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        runtimeKey: 'darwin-arm64',
        node: { version: '24.11.0', root: nodeRoot, executable: 'bin/node' },
        clis: [],
      })
    );

    const previous = process.env.MU_BACKEND_LOCAL_BUNDLE_DIR;
    process.env.MU_BACKEND_LOCAL_BUNDLE_DIR = localBundle;
    try {
      prepareBackend({ projectRoot, platform: 'darwin', arch: 'arm64', version: 'v0.2.2' });
      const copied = join(projectRoot, 'resources/bundled-backend/darwin-arm64/managed-resources', nodeRoot);
      expect(readlinkSync(join(copied, 'bin/npm'))).toBe('../lib/node_modules/npm/bin/npm-cli.js');
    } finally {
      if (previous === undefined) delete process.env.MU_BACKEND_LOCAL_BUNDLE_DIR;
      else process.env.MU_BACKEND_LOCAL_BUNDLE_DIR = previous;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
