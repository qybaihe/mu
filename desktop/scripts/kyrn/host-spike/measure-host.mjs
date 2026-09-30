#!/usr/bin/env node
// Measures the native host (docs/native-host.md) in real Electron utility processes: how long a host takes from
// startNativeHost to pi's first get_state answer, a turn with the E2E fake model, the host's memory, dispose, and
// whether the host process shows up in LaunchServices (the Dock) on macOS.
//
//   node scripts/kyrn/host-spike/measure-host.mjs [--rounds 2] [--built] [--out <folder>]
//
// --built forks out/main/nativeHost.js (run `electron-vite build` first) instead of the entry's TypeScript source.
// The harness is MU_ROOT / KYRN_ROOT, else the KYRN checkout beside this repository; Electron is ELECTRON_EXEC_PATH,
// else the dev binary in kyrn/node_modules (as scripts/kyrn/start uses). The first round starts with an empty
// compile cache (a throwaway TMPDIR), the later ones reuse it. `--out` keeps the lsappinfo lists, the results and
// Electron's output. Exits 0 when every round ran, no host was in LaunchServices' list and each was gone within 2 s
// of its dispose.
//
// Nothing of the person running it gets in: Electron runs with a throwaway HOME (Core Foundation's too), TMPDIR and
// user data, a short environment instead of this one, the fake model and the offline mock judge; the launcher reads
// no `<harness>/.env`. Electron needs the window server: run it outside a sandboxed shell.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findHarnessSource, findNode, mainCheckout } from '../../../tests/e2e/mu-conversation/profile.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
const { values } = parseArgs({
  options: { rounds: { type: 'string', default: '2' }, built: { type: 'boolean' }, out: { type: 'string' } },
});

function electronBinary() {
  if (process.env.ELECTRON_EXEC_PATH) return process.env.ELECTRON_EXEC_PATH;
  const inside =
    process.platform === 'darwin'
      ? ['Electron.app', 'Contents', 'MacOS', 'Electron']
      : [process.platform === 'win32' ? 'electron.exe' : 'electron'];
  for (const root of [REPO, mainCheckout(REPO)]) {
    const candidate = join(root, 'kyrn', 'node_modules', 'electron', 'dist', ...inside);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Electron binary: set ELECTRON_EXEC_PATH, or install kyrn/node_modules');
}

const entry = values.built
  ? join(REPO, 'out', 'main', 'nativeHost.js')
  : join(REPO, 'packages', 'desktop', 'src', 'process', 'services', 'nativeHost', 'entry.ts');
if (!existsSync(entry)) throw new Error(`No host entry at ${entry} (--built needs electron-vite build first)`);
const harness = findHarnessSource(REPO);
const node = findNode();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mu-host-measure-')));
for (const dir of ['home', 'tmp', 'out']) mkdirSync(join(root, dir), { recursive: true });
const lsappinfo = (label) => {
  if (process.platform !== 'darwin') return;
  const text = execFileSync('/usr/bin/lsappinfo', ['list'], { encoding: 'utf8' });
  writeFileSync(join(root, 'out', `lsappinfo-${label}.txt`), text);
};

const env = {
  HOME: join(root, 'home'),
  CFFIXED_USER_HOME: join(root, 'home'),
  PATH: [node.dir, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  TMPDIR: `${join(root, 'tmp')}/`,
  LANG: 'en_US.UTF-8',
  PI_OFFLINE: '1',
  MU_NATIVE_HOST: '1',
  MU_ROOT: harness.root,
  MEASURE_ROOT: root,
  MEASURE_ENTRY: entry,
  MEASURE_ROUNDS: values.rounds,
};
lsappinfo('before');
const electron = spawn(electronBinary(), [join(import.meta.dirname, 'measure-host-main.mjs')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
electron.stdout.on('data', (chunk) => (output += chunk));
electron.stderr.on('data', (chunk) => (output += chunk));
const code = await new Promise((resolveExit) => {
  const timer = setTimeout(() => {
    electron.kill('SIGTERM');
    setTimeout(() => electron.kill('SIGKILL'), 3000).unref();
  }, 180_000);
  electron.on('exit', (exitCode, signal) => {
    clearTimeout(timer);
    resolveExit(exitCode ?? signal);
  });
});
lsappinfo('after-exit');
writeFileSync(join(root, 'out', 'electron.log'), output);
if (values.out) cpSync(join(root, 'out'), resolve(values.out), { recursive: true });
rmSync(root, { recursive: true, force: true });
console.log(
  output
    .split('\n')
    .filter((line) => line.startsWith('[measure]'))
    .join('\n')
);
console.log(`Electron exited with ${code}; harness ${harness.root}; entry ${entry}`);
process.exitCode = code === 0 ? 0 : 1;
