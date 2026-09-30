import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
// @ts-expect-error -- a plain .mjs script with no type declarations
import { bundleHarness, extractPackage, installArgs, pinnedVersion } from '../../../scripts/kyrn/bundle-harness.mjs';

const { verifyBundledHarness } = require('../../../packages/shared-scripts/src/verify-bundled-harness');

/** What mu-agent's package.json says it depends on. */
const DEPENDENCIES = { '@earendil-works/chord': '0.86.0', jiti: '2.7.0' };
const PACKAGE_FILES = [
  'kyrn/bin/mu.mjs',
  'dist/bundle/cli.js',
  'judge/dist/kyrn-judge.js',
  'judge/dist/auth.js',
  'judge/dist/import.js',
  'judge/manifest.json',
];

/** The launcher as the native host needs it: it exports the two functions that start pi in a process of its own. */
const LAUNCHER = 'export function planHost() {}\nexport async function prepareLaunch() {}\n';

function writeFile(filePath: string, content = '') {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/** resources/harness as scripts/kyrn/bundle-harness.mjs leaves it. */
function seedHarness(resourcesDir: string, { platform = 'darwin', arch = 'arm64', version = '0.1.1' } = {}) {
  const pkg = join(resourcesDir, 'harness', 'mu-agent');
  writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'mu-agent', version, dependencies: DEPENDENCIES }));
  for (const file of PACKAGE_FILES)
    writeFile(join(pkg, ...file.split('/')), file === 'kyrn/bin/mu.mjs' ? LAUNCHER : '');
  for (const name of Object.keys(DEPENDENCIES))
    writeFile(join(pkg, 'node_modules', ...name.split('/'), 'package.json'));
  writeFile(
    join(resourcesDir, 'harness', 'bundle.json'),
    JSON.stringify({ name: 'mu-agent', version, platform, arch })
  );
  return pkg;
}

/** One ustar header block, as npm pack writes them. */
function header(name: string, size: number, type: string, mode = 0o644): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  block.write('00000000000\0', 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

/** npm when the version asked for is not on the registry. */
function unpublished(): string {
  throw new Error('npm pack failed (exit code 1)');
}

const padded = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

/** A gzipped tarball of `files`; a path longer than a header holds gets a pax record, as npm writes it. */
function tarball(file: string, files: Record<string, string>, modes: Record<string, number> = {}) {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    if (name.length > 100) {
      const record = ` path=${name}\n`;
      let line = `${record.length}${record}`;
      line = `${line.length}${record}`;
      const pax = Buffer.from(line);
      blocks.push(header('PaxHeader/long', pax.length, 'x'), padded(pax));
    }
    blocks.push(header(name, data.length, '0', modes[name]), padded(data));
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(file, gzipSync(Buffer.concat(blocks)));
}

describe('verifyBundledHarness', () => {
  let tmp: string;
  let resourcesDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mu-bundled-harness-'));
    resourcesDir = join(tmp, 'resources');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('passes when mu and its dependencies are there, for this system and processor', () => {
    seedHarness(resourcesDir);
    const result = verifyBundledHarness({ resourcesDir, electronPlatformName: 'darwin', targetArch: 'arm64' });
    expect(result.missing).toEqual([]);
    expect(result.version).toBe('0.1.1');
    expect(result.checked).toContain('harness/mu-agent/judge/dist/auth.js');
    expect(result.checked).toContain('harness/mu-agent/node_modules/@earendil-works/chord/package.json');
  });

  it('names every file the app would miss', () => {
    const pkg = seedHarness(resourcesDir);
    rmSync(join(pkg, 'judge', 'dist', 'auth.js'));
    rmSync(join(pkg, 'node_modules', 'jiti'), { recursive: true });
    const result = verifyBundledHarness({ resourcesDir, electronPlatformName: 'darwin', targetArch: 'arm64' });
    expect(result.missing).toEqual([
      'harness/mu-agent/judge/dist/auth.js',
      'harness/mu-agent/node_modules/jiti/package.json',
    ]);
  });

  it('names a launcher the native host cannot run pi with', () => {
    const pkg = seedHarness(resourcesDir);
    // A mu from before the native host: a launcher without planHost, or with a prepareLaunch that is only a word.
    writeFile(
      join(pkg, 'kyrn', 'bin', 'mu.mjs'),
      'export function planLaunch() {}\n// prepareLaunch is not exported\n'
    );
    const result = verifyBundledHarness({ resourcesDir, electronPlatformName: 'darwin', targetArch: 'arm64' });
    expect(result.missing).toEqual([
      'harness/mu-agent/kyrn/bin/mu.mjs<export:planHost>',
      'harness/mu-agent/kyrn/bin/mu.mjs<export:prepareLaunch>',
    ]);
  });

  it('fails without mu at all', () => {
    const result = verifyBundledHarness({ resourcesDir, electronPlatformName: 'win32', targetArch: 'x64' });
    expect(result.missing).toContain('harness/mu-agent/package.json');
    expect(result.missing).toContain('harness/mu-agent/kyrn/bin/mu.mjs');
    expect(result.missing).toContain('harness/bundle.json');
  });

  it('reports dependencies installed for another system, processor or version', () => {
    seedHarness(resourcesDir, { platform: 'darwin', arch: 'arm64' });
    writeFile(
      join(resourcesDir, 'harness', 'bundle.json'),
      JSON.stringify({ name: 'mu-agent', version: '0.1.0', platform: 'darwin', arch: 'arm64' })
    );
    const result = verifyBundledHarness({ resourcesDir, electronPlatformName: 'win32', targetArch: 'x64' });
    expect(result.missing).toEqual([
      'harness/bundle.json<platform:win32>',
      'harness/bundle.json<arch:x64>',
      'harness/bundle.json<version:0.1.1>',
    ]);
  });
});

describe('bundle-harness', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mu-bundle-harness-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pins the mu-agent version in one place, the root package.json', () => {
    expect(pinnedVersion()).toMatch(/^\d+\.\d+\.\d+/);
    writeFile(join(tmp, 'package.json'), '{"name":"x"}');
    expect(() => pinnedVersion(tmp)).toThrow('muAgentVersion');
  });

  it('installs the dependencies for the target, without scripts or anything of npm’s own', () => {
    expect(installArgs('win32', 'arm64')).toEqual([
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--no-bin-links',
      '--prefer-offline',
      '--os=win32',
      '--cpu=arm64',
    ]);
  });

  it('unpacks an npm tarball, long paths and modes included, and refuses anything outside the package', () => {
    const long = `package/${'deep/'.repeat(20)}file.js`;
    tarball(
      join(tmp, 'ok.tgz'),
      { 'package/package.json': '{"name":"mu-agent"}', 'package/kyrn/bin/mu.mjs': 'run', [long]: 'deep' },
      { 'package/kyrn/bin/mu.mjs': 0o755 }
    );
    extractPackage(join(tmp, 'ok.tgz'), join(tmp, 'out'));
    expect(readFileSync(join(tmp, 'out', 'package.json'), 'utf8')).toBe('{"name":"mu-agent"}');
    expect(readFileSync(join(tmp, 'out', ...long.split('/').slice(1)), 'utf8')).toBe('deep');
    if (process.platform !== 'win32')
      expect(statSync(join(tmp, 'out', 'kyrn', 'bin', 'mu.mjs')).mode & 0o777).toBe(0o755);

    tarball(join(tmp, 'bad.tgz'), { 'package/../../escape.js': 'no' });
    expect(() => extractPackage(join(tmp, 'bad.tgz'), join(tmp, 'bad'))).toThrow('not an npm package');
    expect(existsSync(join(tmp, 'escape.js'))).toBe(false);
  });

  it('puts the given tarball in resources/harness, installs for the target, and checks the result', () => {
    const files: Record<string, string> = {
      'package/package.json': JSON.stringify({ name: 'mu-agent', version: '0.1.1', dependencies: DEPENDENCIES }),
    };
    for (const file of PACKAGE_FILES) files[`package/${file}`] = file === 'kyrn/bin/mu.mjs' ? LAUNCHER : '';
    tarball(join(tmp, 'mu-agent-0.1.1.tgz'), files);
    const calls: { args: string[]; cwd: string }[] = [];
    const npm = (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      for (const name of Object.keys(DEPENDENCIES))
        writeFile(join(cwd, 'node_modules', ...name.split('/'), 'package.json'));
      return '';
    };
    // What a build before left is replaced.
    writeFile(join(tmp, 'resources', 'harness', 'mu-agent', 'stale.js'));
    const result = bundleHarness({
      root: tmp,
      platform: 'linux',
      arch: 'x64',
      tarball: join(tmp, 'mu-agent-0.1.1.tgz'),
      npm,
      log: () => {},
    });
    expect(result.version).toBe('0.1.1');
    expect(calls).toEqual([{ args: installArgs('linux', 'x64'), cwd: join(tmp, 'resources', 'harness', 'mu-agent') }]);
    expect(JSON.parse(readFileSync(join(tmp, 'resources', 'harness', 'bundle.json'), 'utf8'))).toEqual({
      name: 'mu-agent',
      version: '0.1.1',
      platform: 'linux',
      arch: 'x64',
    });
    expect(existsSync(join(tmp, 'resources', 'harness', 'mu-agent', 'stale.js'))).toBe(false);
  });

  it('says what to do when the pinned version cannot be fetched', () => {
    writeFile(join(tmp, 'package.json'), JSON.stringify({ muAgentVersion: '9.9.9' }));
    expect(() =>
      bundleHarness({ root: tmp, platform: 'linux', arch: 'x64', tarball: '', npm: unpublished, log: () => {} })
    ).toThrow('MU_HARNESS_TARBALL');
  });
});
