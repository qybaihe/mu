// The throwaway world the mu conversation E2E test runs the app in: a home folder, Electron's user data, mu's agent
// folder, a project folder and, for the checkout's build, a view of the harness, all under one temporary folder.
// Nothing the app writes can land in the person's own ~/.mu, app data or harness checkout:
//
// - The home folder is a fresh one, under every name the environment gives it (profileEnv), so `~/.mu`, `~/Library`,
//   `%APPDATA%` and every dotfile an agent or tool touches are the test's own. On Windows, Electron's
//   `app.getPath('home')` still names the account's own folder (Windows answers it, not the environment); the test
//   prints the app's folders at its first start.
// - MU_E2E_USER_DATA_DIR moves Electron's user data and logs (configureChromium.ts).
// - MU_AGENT_DIR is a folder of its own, apart from `<home>/.mu/agent`, so the test also shows that every part of the
//   app and of mu uses the one the person named.
// - The checkout's build runs the harness through a view of the checkout (links) whose own `.env` is the test's: a
//   checkout keeps its keys in `<root>/.env`, and the app writes a provider's key there. The checkout's own `.env` is
//   never opened. A packaged app runs the mu it carries, which keeps its keys in `~/.mu/.env`: the profile's home.
// - The environment is built from a short list, not copied: no key or token of the person running the test reaches the
//   app.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path, { delimiter, dirname, join, resolve } from 'node:path';

/** pi's minimum Node, the same as the harness launcher's. */
const MIN_NODE = [22, 19];

/** mu.json of the test's agent folder: the offline judge, and every decision point on its fallback. */
export const JUDGE_CONFIG = { tiers: ['mock'], modes: { default: 'off' } };

/**
 * What the app keeps of the environment on macOS and Linux: who runs it, the terminal, the temp folder, and the display
 * with its key (XAUTHORITY: an X server such as xvfb-run's lets in only who shows it, and the profile's home has no
 * `.Xauthority` of its own).
 */
const POSIX_INHERITED = [
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TERM',
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
];

/**
 * What the app keeps of the environment on Windows: the system's own folders and settings, without which programs
 * fail in odd ways (no SystemRoot, and Node's sockets and crypto break; no ComSpec or PATHEXT, and cmd.exe finds
 * nothing), who runs it, the processor, and the temp folder.
 */
const WINDOWS_INHERITED = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'NUMBER_OF_PROCESSORS',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ProgramData',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'PSModulePath',
];

const versionOk = (version) => {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
};

/** The main checkout of a git worktree (its common git folder's parent), or the folder itself. */
export function mainCheckout(root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return dirname(common);
  } catch {
    return root;
  }
}

/** The harness checkout (or npm package) to run: MU_ROOT / KYRN_ROOT, else `../KYRN` beside the desktop checkout. */
export function findHarnessSource(desktopRoot) {
  const named = process.env.MU_ROOT || process.env.KYRN_ROOT;
  const candidates = named
    ? [resolve(named)]
    : [join(desktopRoot, '..', 'KYRN'), join(mainCheckout(desktopRoot), '..', 'KYRN')];
  for (const root of candidates) {
    if (existsSync(join(root, 'kyrn', 'bin', 'mu.mjs'))) {
      const layout = existsSync(join(root, 'packages', 'coding-agent', 'package.json')) ? 'repo' : 'package';
      return { root: realpathSync(root), layout };
    }
  }
  throw new Error(
    `No mu harness found (looked in ${candidates.join(', ')}). Set MU_ROOT to a harness checkout or a mu-agent package.`
  );
}

/** The backend binary: MU_BACKEND_BIN, the bundled one in this checkout or the main one, or `aioncore` on PATH. */
export function findBackend(desktopRoot) {
  if (process.env.MU_BACKEND_BIN) return resolve(process.env.MU_BACKEND_BIN);
  const name = process.platform === 'win32' ? 'aioncore.exe' : 'aioncore';
  const key = `${process.platform}-${process.arch}`;
  for (const root of [desktopRoot, mainCheckout(desktopRoot)]) {
    const candidate = join(root, 'resources', 'bundled-backend', key, name);
    if (existsSync(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  throw new Error(
    'No backend binary found. Set MU_BACKEND_BIN, or put it in resources/bundled-backend/<platform>-<arch>/.'
  );
}

/**
 * A Node that can run mu (>= 22.19): MU_E2E_NODE, the one running this, one on PATH, or one from nvm. `dir` is the
 * folder that holds it, the one to put on PATH.
 */
export function findNode() {
  const candidates = [];
  if (process.env.MU_E2E_NODE) candidates.push(process.env.MU_E2E_NODE);
  if (!process.versions.bun && /node(\.exe)?$/i.test(process.execPath)) candidates.push(process.execPath);
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) candidates.push(join(dir, exe));
  const nvm = join(process.env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node');
  if (existsSync(nvm)) {
    const versions = readdirSync(nvm).sort((a, b) => {
      const [x, y] = [a, b].map((v) => v.replace(/^v/, '').split('.').map(Number));
      for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
      return 0;
    });
    for (const version of versions) candidates.push(join(nvm, version, 'bin', exe));
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
      if (versionOk(version)) return { bin: candidate, dir: dirname(candidate), version };
    } catch {
      // Not runnable: try the next one.
    }
  }
  throw new Error(`No Node ${MIN_NODE.join('.')} or newer found. Set MU_E2E_NODE to one.`);
}

/**
 * Links `target` to `source`: a symbolic link, or on Windows, where a symbolic link takes an administrator or the
 * developer mode, a junction for a folder and a copy for a file.
 */
function link(source, target) {
  if (process.platform !== 'win32') return symlinkSync(source, target);
  if (statSync(source).isDirectory()) return symlinkSync(source, target, 'junction');
  return copyFileSync(source, target);
}

/**
 * A view of a harness checkout whose `.env` is its own: every entry of the checkout is linked, except the key files,
 * git's folder and `kyrn/bin`, which is copied (the launcher finds the checkout from where it really is).
 */
function harnessView(source, target) {
  mkdirSync(join(target, 'kyrn', 'bin'), { recursive: true });
  const skipped = (name) => name.startsWith('.env') || ['.git', '.claude', '.codex', 'kyrn'].includes(name);
  for (const name of readdirSync(source)) {
    if (!skipped(name)) link(join(source, name), join(target, name));
  }
  for (const name of readdirSync(join(source, 'kyrn'))) {
    if (name !== 'bin' && !name.startsWith('.env')) link(join(source, 'kyrn', name), join(target, 'kyrn', name));
  }
  for (const name of readdirSync(join(source, 'kyrn', 'bin'))) {
    const from = join(source, 'kyrn', 'bin', name);
    if (!statSync(from).isFile()) continue;
    const to = join(target, 'kyrn', 'bin', name);
    copyFileSync(from, to);
    chmodSync(to, statSync(from).mode & 0o777);
  }
  return target;
}

/**
 * The environment the app is started with (see the top of this file), for `platform`. `paths` are the profile's;
 * `node` the Node to put first on PATH, if any; `checkout` names, for the checkout's build, the backend binary, the
 * desktop checkout and the harness to run. A packaged app gets none of them: it carries mu and the backend, and runs
 * mu on its own binary, so no Node is needed either.
 *
 * The home is the profile's under every name: HOME (and CFFIXED_USER_HOME, which Core Foundation reads on macOS); on
 * Windows USERPROFILE (Node's home, so mu's), HOMEDRIVE and HOMEPATH, and APPDATA and LOCALAPPDATA inside it, where
 * npm and most tools keep their data. PATH is the system's own folders, as a fresh account has them.
 */
export function profileEnv({ platform = process.platform, env = process.env, paths, node, language, checkout }) {
  const windows = platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const result = {};
  for (const name of windows ? WINDOWS_INHERITED : POSIX_INHERITED) if (env[name]) result[name] = env[name];
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  const system = windows
    ? [
        p.join(systemRoot, 'System32'),
        systemRoot,
        p.join(systemRoot, 'System32', 'Wbem'),
        p.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
        p.join(systemRoot, 'System32', 'OpenSSH'),
      ]
    : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const drive = p.parse(paths.home).root.replace(/[\\/]$/, '');
  Object.assign(result, {
    HOME: paths.home,
    ...(windows
      ? {
          USERPROFILE: paths.home,
          HOMEDRIVE: drive,
          HOMEPATH: paths.home.slice(drive.length),
          APPDATA: p.join(paths.home, 'AppData', 'Roaming'),
          LOCALAPPDATA: p.join(paths.home, 'AppData', 'Local'),
        }
      : { CFFIXED_USER_HOME: paths.home }),
    PATH: [...(node ? [node.dir] : []), ...system].join(p.delimiter),
    LANG: language === 'zh-CN' ? 'zh_CN.UTF-8' : 'en_US.UTF-8',
    NODE_ENV: 'production',
    // The app's own E2E switches: its user data in the profile, no mu:// registration, no tray, no update checks, no
    // single-instance lock, no devtools.
    MU_E2E_TEST: '1',
    MU_E2E_USER_DATA_DIR: paths.userData,
    MU_DISABLE_AUTO_UPDATE: '1',
    MU_DISABLE_DEVTOOLS: '1',
    // The backend's Node.js runtime (about 50 MB from nodejs.org) is declined, as a person can decline it. A packaged
    // app carries it, and never asks.
    MU_NODE_RUNTIME: 'later',
    MU_AGENT_DIR: paths.agentDir,
  });
  if (checkout) {
    Object.assign(result, {
      MU_BACKEND_BIN: checkout.backend,
      KYRN_DESKTOP_ROOT: checkout.desktopRoot,
      MU_ROOT: checkout.harness,
      KYRN_ROOT: checkout.harness,
    });
  }
  return result;
}

/**
 * The folders a fresh account's home has that programs count on, for `platform`. Windows looks up the user's folders
 * (its known folders: Documents, Downloads, ...) and the app data folders under USERPROFILE, so in the profile's home,
 * and a missing one is an error there, not an empty folder: Electron's `app.getPath('downloads')` throws. macOS and
 * Linux name the same folders and take a missing one as it is, so none is made there.
 */
export function homeFolders(platform, home) {
  if (platform !== 'win32') return [];
  const user = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos'];
  return [
    path.win32.join(home, 'AppData', 'Roaming'),
    path.win32.join(home, 'AppData', 'Local'),
    ...user.map((name) => path.win32.join(home, name)),
  ];
}

/**
 * A new, empty folder for the profile: `root` when given (it must be empty or missing), else a new one in the system's
 * temporary folder. Its real path, with every link and, on Windows, every short (8.3) name resolved: the app and mu
 * see a project by its real path, and the test compares theirs with its own.
 */
function profileRoot(root) {
  if (root) {
    mkdirSync(root, { recursive: true });
    if (readdirSync(root).length > 0) throw new Error(`The profile folder ${root} is not empty.`);
  }
  return realpathSync.native(root ?? mkdtempSync(join(tmpdir(), 'mu-e2e-')));
}

/**
 * Creates the profile. `root` defaults to a new folder in the system's temporary folder. `app` is a packaged app
 * ({ executable, resources }, see app.mjs) to run instead of the checkout's build: it carries mu and the backend, so
 * no harness checkout, backend binary or Node is looked for. Returns every path and the environment the app is started
 * with.
 */
export function createProfile({ desktopRoot, root, language = 'zh-CN', app } = {}) {
  const base = profileRoot(root);
  const paths = {
    root: base,
    home: join(base, 'home'),
    userData: join(base, 'userData'),
    agentDir: join(base, 'agent'),
    project: join(base, 'project'),
    harness: join(base, 'harness'),
    logs: join(base, 'logs'),
  };
  for (const dir of [paths.home, paths.userData, paths.agentDir, paths.project, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const dir of homeFolders(process.platform, paths.home)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(paths.project, 'README.md'), '# E2E project\n\nA folder for the mu conversation test.\n');
  // mu's judgment configuration: the offline `mock` judge, and every decision point off, so each one takes its fixed
  // fallback. The same run every time, and no judge is called. (MU_JUDGE=off would switch the whole judgment layer off,
  // permission modes and the board with it.)
  writeFileSync(join(paths.agentDir, 'mu.json'), `${JSON.stringify(JUDGE_CONFIG, null, 2)}\n`);

  if (app) {
    const carried = join(app.resources, 'harness', 'mu-agent');
    if (!existsSync(join(carried, 'kyrn', 'bin', 'mu.mjs'))) {
      throw new Error(`The packaged app carries no mu: ${join(carried, 'kyrn', 'bin', 'mu.mjs')} is missing.`);
    }
    const env = profileEnv({ paths, language });
    const harness = { root: carried, layout: 'package', view: carried };
    return { paths, env, node: undefined, backend: undefined, harness, language, app };
  }

  const node = findNode();
  // The app replaces PATH with the login shell's (fix-path), which in this home is the system's, then adds every nvm
  // Node under the home: the chosen Node is linked there, so the adapter and mu find it after that too. Windows has no
  // login shell to ask: there the PATH given is the one they use.
  if (process.platform !== 'win32') {
    const nvmVersion = join(
      paths.home,
      '.nvm',
      'versions',
      'node',
      node.version.startsWith('v') ? node.version : `v${node.version}`
    );
    mkdirSync(dirname(nvmVersion), { recursive: true });
    symlinkSync(dirname(node.dir), nvmVersion);
  }

  const source = findHarnessSource(desktopRoot);
  const harnessRoot = source.layout === 'repo' ? harnessView(source.root, paths.harness) : source.root;
  const backend = findBackend(desktopRoot);
  const env = profileEnv({ paths, node, language, checkout: { backend, desktopRoot, harness: harnessRoot } });
  return { paths, env, node, backend, harness: { ...source, view: harnessRoot }, language, app: undefined };
}
