// The throwaway world a native host runs in for tests and for recording fixtures: a home whose mu agent folder is set
// up for the E2E fake model (tests/e2e/mu-conversation/fakeModel.mjs) and the offline `mock` judge, a project folder
// and a temp folder, all under one temporary folder, and what the launcher plans from.
//
// Nothing of the person running it gets in. The environment is a short list, not this process's (no key or token
// reaches pi), and the file system the launcher reads through has no `<harness>/.env`, where a checkout keeps its
// keys. macOS and Linux.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_API_KEY, FAKE_MODEL_ID } from '../../e2e/mu-conversation/fakeModel.mjs';
import { findHarnessSource, findNode } from '../../e2e/mu-conversation/profile.mjs';

const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * A new world. `baseUrl` is the fake model's; without it mu has no model at all. `judgeMode` is mu's default decision
 * mode for the mock judge (`off` or `shadow`: nothing it says changes what pi does). `nodeDir` goes first on PATH,
 * for the commands the agent runs.
 */
export function createHostWorld({ baseUrl, judgeMode = 'off', nodeDir }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mu-native-host-')));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const tmp = join(root, 'tmp');
  const agentDir = join(home, '.mu', 'agent');
  for (const dir of [agentDir, project, tmp]) mkdirSync(dir, { recursive: true });
  if (baseUrl) {
    const provider = { baseUrl, api: 'openai-completions', apiKey: FAKE_API_KEY, models: [{ id: FAKE_MODEL_ID }] };
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { e2e: provider } }));
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'e2e', defaultModel: FAKE_MODEL_ID })
    );
  }
  writeFileSync(join(agentDir, 'mu.json'), JSON.stringify({ tiers: ['mock'], modes: { default: judgeMode } }));
  const env = {
    HOME: home,
    PATH: [...(nodeDir ? [nodeDir] : []), ...SYSTEM_PATH].join(':'),
    TMPDIR: tmp,
    LANG: 'en_US.UTF-8',
    PI_OFFLINE: '1',
  };
  return { root, home, project, agentDir, env, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** The file system the launcher plans through (launch.ts `LauncherFs`): the real one, without `<harness>/.env`. */
export function launcherFs(harnessRoot) {
  const keys = join(harnessRoot, '.env');
  return {
    exists: (file) => file !== keys && existsSync(file),
    isDir: (file) => {
      try {
        return statSync(file).isDirectory();
      } catch {
        return false;
      }
    },
    readFile: (file) => {
      if (file === keys) throw Object.assign(new Error(`${file} is not read here`), { code: 'ENOENT' });
      return readFileSync(file, 'utf8');
    },
  };
}

/** Whether the harness's launcher can plan a host: a mu from before the native host cannot. */
export function launcherPlansHosts(harnessRoot) {
  try {
    return /export function planHost\b/.test(readFileSync(join(harnessRoot, 'kyrn', 'bin', 'mu.mjs'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The harness and the Node to run a host with, or why a test cannot run here: a harness whose launcher plans hosts
 * (MU_ROOT, or the KYRN checkout beside this repository) and Node 22.19 or newer, on macOS or Linux.
 */
export function hostEnvironment(desktopRoot) {
  if (process.platform === 'win32') return { skip: 'the host world is set up for macOS and Linux' };
  let harness;
  try {
    harness = findHarnessSource(desktopRoot);
  } catch {
    return { skip: 'no mu harness (MU_ROOT, or ../KYRN beside this checkout)' };
  }
  if (!launcherPlansHosts(harness.root)) return { skip: `${harness.root} is a mu from before the native host` };
  try {
    return { harness, node: findNode().bin };
  } catch {
    return { skip: 'no Node 22.19 or newer, which pi and the host need' };
  }
}
