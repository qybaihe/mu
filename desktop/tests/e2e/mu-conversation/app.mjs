// Starts the mu desktop app for the conversation E2E test and keeps what it says: the main process's output, the
// renderer's console and page errors, and the app's log folders. `problems()` lists the errors nothing handled, which
// fail the test; `leftoverProcesses()` lists what still runs from the profile after a quit.
//
// The app is the checkout's build in out/, run on an Electron executable, or a packaged app electron-builder made
// (`packagedApp()`), which carries mu and the backend itself.
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { mainCheckout } from './profile.mjs';

const execFileAsync = promisify(execFile);

/** Lines of the main process's output and logs that mean an error nothing handled. */
const MAIN_PROBLEMS = [
  /\[AionUi\] (uncaughtException|unhandledRejection)/,
  /render-process-gone/,
  /\[AionUi\] App initialization failed/,
  /Failed to initialize process/,
];
/** Lines of the logs that mean the adapter or mu met an error nothing handled. */
const ADAPTER_PROBLEMS = [
  /\[mu\] a promise failed and nothing handled it/,
  /\[mu\] the adapter stops on an error nothing handled/,
  /\[mu\] handling a .* event failed/,
  /\[mu\] the harness stopped by itself/,
  /\[mu\] the harness stopped reading its input/,
  /\bEPIPE\b/,
];
/**
 * Renderer console errors that mean a page broke: a route's error screen (the page caught the error, so it is no
 * page error), or an error React reports from a render.
 */
const RENDERER_PROBLEMS = [
  /\[Route\] Page failed to load or render/,
  /The above error occurred in/,
  /^error: (Uncaught )?(TypeError|ReferenceError|RangeError|SyntaxError)\b/,
];

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Every file under a folder, recursively. */
export function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** Where an Electron package keeps its executable, under its `dist` folder. */
const ELECTRON_EXECUTABLE = {
  darwin: ['Electron.app', 'Contents', 'MacOS', 'Electron'],
  win32: ['electron.exe'],
}[process.platform] ?? ['electron'];

/**
 * The Electron executable to start: MU_E2E_ELECTRON, else ELECTRON_EXEC_PATH (what electron-vite and
 * `scripts/kyrn/start` start), else the one of this checkout's `electron` package, else the one `scripts/kyrn/start`
 * falls back to (`kyrn/node_modules/electron`, here or in the main checkout of a worktree).
 *
 * The package's own `dist` is read, never `require('electron')` of a package that has none: a checkout installed
 * without its install scripts has no Electron in the package, and a newer package's `require` downloads it then.
 */
export function electronBinary(desktopRoot) {
  const named = process.env.MU_E2E_ELECTRON || process.env.ELECTRON_EXEC_PATH;
  if (named) return named;
  const roots = [...new Set([desktopRoot, mainCheckout(desktopRoot)])];
  const packages = [
    ...roots.map((root) => {
      try {
        return dirname(createRequire(join(root, 'package.json')).resolve('electron/package.json'));
      } catch {
        return undefined;
      }
    }),
    ...roots.map((root) => join(root, 'kyrn', 'node_modules', 'electron')),
  ].filter(Boolean);
  for (const folder of packages) {
    const executable = join(folder, 'dist', ...ELECTRON_EXECUTABLE);
    if (existsSync(executable)) return executable;
  }
  throw new Error(
    `No Electron executable found (looked in ${packages.map((folder) => join(folder, 'dist')).join(', ')}). ` +
      'Set MU_E2E_ELECTRON (or ELECTRON_EXEC_PATH) to one.'
  );
}

/** The folder electron-builder leaves an unpacked app in, per system and processor: mac-arm64, win-unpacked, ... */
export function unpackedFolderName(platform, arch) {
  const system = { darwin: 'mac', win32: 'win' }[platform] ?? 'linux';
  // x64 is the builder's default and has no suffix; a Mac app's folder holds the .app, so it is not "unpacked".
  return `${system}${arch === 'x64' ? '' : `-${arch}`}${platform === 'darwin' ? '' : '-unpacked'}`;
}

/**
 * The packaged app in an unpacked app folder, as { executable, resources }: on macOS the `.app` in it (or the folder
 * itself when it is one) and the one binary in Contents/MacOS; elsewhere the program beside `resources/` (on Windows
 * the .exe that is no uninstaller, on Linux the executable file electron-builder names in electron-builder.yml).
 */
function appIn(dir, platform) {
  if (platform === 'darwin') {
    const bundle = dir.endsWith('.app')
      ? dir
      : readdirSync(dir)
          .filter((name) => name.endsWith('.app'))
          .map((name) => join(dir, name))[0];
    if (!bundle) return undefined;
    const binaries = join(bundle, 'Contents', 'MacOS');
    const names = isDir(binaries) ? readdirSync(binaries) : [];
    if (names.length !== 1) return undefined;
    return { executable: join(binaries, names[0]), resources: join(bundle, 'Contents', 'Resources') };
  }
  const resources = join(dir, 'resources');
  if (!isDir(resources)) return undefined;
  const helpers = new Set(['chrome-sandbox', 'chrome_crashpad_handler']);
  const program = readdirSync(dir)
    .toSorted()
    .find((name) => {
      const path = join(dir, name);
      if (!isFile(path)) return false;
      if (platform === 'win32') return /\.exe$/i.test(name) && !/^uninstall/i.test(name);
      return !name.includes('.') && !helpers.has(name) && (statSync(path).mode & 0o111) !== 0;
    });
  return program ? { executable: join(dir, program), resources } : undefined;
}

/**
 * A packaged app electron-builder made, as { executable, resources }. `target` is the app's executable, the app (a
 * `.app` on macOS, the unpacked folder elsewhere), or the builder's output folder (out/), which holds one unpacked app
 * per system and processor: the one for this system and `arch` is taken. Undefined when there is none.
 */
export function packagedApp(target, arch = process.arch, platform = process.platform) {
  if (isFile(target)) {
    const folder = dirname(target);
    return {
      executable: target,
      resources: platform === 'darwin' ? join(folder, '..', 'Resources') : join(folder, 'resources'),
    };
  }
  if (!isDir(target)) return undefined;
  const direct = appIn(target, platform);
  if (direct) return direct;
  const folder = join(target, unpackedFolderName(platform, arch));
  return isDir(folder) ? appIn(folder, platform) : undefined;
}

/**
 * Starts the app. `run` names this start in the log files (the test starts the app twice). `electron` is Playwright's
 * Electron launcher (the test passes the one of @playwright/test, so its `expect` knows the pages); by default the
 * checkout's `playwright`. A profile made for a packaged app (`profile.app`) starts that app, from the profile's home:
 * it runs from no checkout, so it must not lean on one by accident. Otherwise the build in `<desktopRoot>/out`.
 * `window` (`{ width, height }`) sizes the window once it is up; by default it keeps the size the app gives it, which
 * follows the screen.
 */
export async function launchApp({ desktopRoot, profile, run, electron, window }) {
  const launcher = electron ?? createRequire(join(desktopRoot, 'package.json'))('playwright')._electron;
  const logs = profile.paths.logs;
  const mainLog = join(logs, `main-${run}.log`);
  const rendererLog = join(logs, `renderer-${run}.log`);
  const packaged = profile.app;
  const args = [`--lang=${profile.language}`];
  if (!packaged) args.push(desktopRoot);
  if (process.platform === 'linux') args.push('--no-sandbox');
  const app = await launcher.launch({
    executablePath: packaged ? packaged.executable : electronBinary(desktopRoot),
    args,
    cwd: packaged ? profile.paths.home : desktopRoot,
    env: profile.env,
    timeout: 120_000,
  });
  const state = { app, page: undefined, mainLog, rendererLog, pageErrors: [], consoleErrors: [], exited: false };
  const child = app.process();
  const keep = (chunk) => appendFileSync(mainLog, chunk);
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.on('exit', (code, signal) => {
    state.exited = true;
    appendFileSync(mainLog, `\n[e2e] the app exited (code ${code}, signal ${signal})\n`);
  });
  const isMain = (page) => !page.url().startsWith('devtools://');
  let page = app.windows().find(isMain);
  while (!page) {
    const next = await app.waitForEvent('window', { timeout: 90_000 });
    if (isMain(next)) page = next;
  }
  page.on('console', (message) => {
    const line = `${message.type()}: ${message.text()}`;
    appendFileSync(rendererLog, `${line}\n`);
    if (message.type() === 'error') state.consoleErrors.push(line);
  });
  page.on('pageerror', (error) => {
    const line = `pageerror: ${error.stack || error.message}`;
    appendFileSync(rendererLog, `${line}\n`);
    state.pageErrors.push(line);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => Boolean(document.querySelector('#root')?.children.length), undefined, {
    timeout: 90_000,
  });
  if (window) {
    const frame = await app.browserWindow(page);
    await frame.evaluate((win, size) => win.setSize(size.width, size.height), window);
    await page.waitForFunction((size) => Math.abs(globalThis.innerWidth - size.width) < 40, window);
  }
  state.page = page;
  return state;
}

/** Quits the app the way a person does (the app's own quit), and waits for it to be gone. */
export async function quitApp(state) {
  if (!state || state.exited) return;
  await state.app.evaluate(({ app }) => app.quit()).catch(() => {});
  const deadline = Date.now() + 30_000;
  while (!state.exited && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  if (!state.exited) await state.app.close().catch(() => {});
}

/** The lines of a file that match any of the patterns. */
function matching(file, patterns) {
  if (!existsSync(file) || !statSync(file).isFile()) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => patterns.some((pattern) => pattern.test(line)));
}

/**
 * The profile's log folders: Electron's logs folder, which the E2E mode moves into the user data (the backend's log,
 * with the adapter's error output in it, and on Windows and Linux the main process's log), and on macOS the main
 * process's own, which electron-log keeps in ~/Library/Logs/<app>. A packaged app writes its main process's output
 * only there, not to its standard output.
 */
export function logFolders(profile) {
  return [join(profile.paths.userData, 'logs'), join(profile.paths.home, 'Library', 'Logs')];
}

/**
 * Errors nothing handled, in this start of the app: page errors, renderer console errors that mean a broken page, the
 * main process's own reports (on its output and in its log), and the adapter's and mu's reports in the logs (the
 * backend logs the adapter's error output).
 */
export function problems(state, profile, { ignore = [] } = {}) {
  const found = [
    ...state.pageErrors,
    ...state.consoleErrors.filter((line) => RENDERER_PROBLEMS.some((pattern) => pattern.test(line))),
    ...matching(state.mainLog, MAIN_PROBLEMS),
    ...matching(state.mainLog, ADAPTER_PROBLEMS),
    ...logFolders(profile)
      .flatMap(filesUnder)
      .flatMap((file) => matching(file, [...MAIN_PROBLEMS, ...ADAPTER_PROBLEMS]).map((line) => `${file}: ${line}`)),
  ];
  return [...new Set(found)].filter((line) => !ignore.some((pattern) => pattern.test(line)));
}

/**
 * PowerShell's list of every process as JSON: pid, parent pid, creation time in milliseconds (the 100 ns ticks would
 * not fit a JavaScript number; 0 when unknown) and command line. Always an array.
 */
export const WINDOWS_PROCESS_LIST = [
  '$list = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ' +
    'pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; ' +
    'start = $(if ($_.CreationDate) { [long]($_.CreationDate.ToFileTimeUtc() / 10000) } else { 0 }); ' +
    'command = [string]$_.CommandLine } })',
  'ConvertTo-Json -InputObject $list -Compress',
].join('; ');

/** What the shell below prints after each answer, and before an error's text. */
const ANSWER_END = '<<mu-e2e: end of answer>>';
const ANSWER_FAILED = '<<mu-e2e: failed>>';

/**
 * A command for the shell below: `command`, then the end mark, whatever the command did. An error that stops the command
 * comes back as its text, after the failure mark.
 */
export const shellQuestion = (command) =>
  `try { ${command} } catch { Write-Output ('${ANSWER_FAILED}' + $_) }; Write-Output '${ANSWER_END}'`;

/**
 * Takes the answers out of what the shell printed so far: `{ answers, rest }`, `rest` being the start of an answer
 * still to come. An answer is `{ text }`, or `{ error }` for a command that failed.
 */
export function shellAnswers(printed) {
  const parts = printed.split(ANSWER_END);
  const rest = parts.pop() ?? '';
  const answers = parts.map((part) => {
    const text = part.replace(/^\r?\n/, '');
    const failed = text.indexOf(ANSWER_FAILED);
    return failed >= 0 ? { error: text.slice(failed + ANSWER_FAILED.length).trim() } : { text };
  });
  return { answers, rest };
}

/**
 * One PowerShell for the whole run, asked one command at a time. A new PowerShell is slow to look: on a fresh
 * windows-2022 runner the first one took 24 s to start and 17 s for its first look at WMI, and on windows-11-arm every
 * new one took 22 s to load what a look needs (Get-Process as much as Get-CimInstance). A running one answers in a
 * twentieth of a second. Started by the first look, or early by `warmUpProcessLook()`, and ended by `endProcessLook()`.
 */
let shell;

function windowsShell() {
  if (shell) return shell;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true });
  child.stdout.setEncoding('utf8');
  const waiting = [];
  let printed = '';
  let complaints = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    complaints = (complaints + chunk).slice(-2000);
  });
  const failAll = (error) => {
    for (const question of waiting.splice(0)) question.reject(error);
    if (shell?.child === child) shell = undefined;
  };
  child.stdout.on('data', (chunk) => {
    const { answers, rest } = shellAnswers(printed + chunk);
    printed = rest;
    for (const answer of answers) {
      const question = waiting.shift();
      if (answer.error !== undefined) question?.reject(new Error(`PowerShell: ${answer.error}`));
      else question?.resolve(answer.text);
    }
  });
  child.on('error', failAll);
  child.on('exit', (code) =>
    failAll(new Error(`PowerShell ended (exit ${code}) before it answered: ${complaints.trim() || 'no message'}`))
  );
  // Every error stops its command, so it comes back as an answer instead of a list with holes.
  child.stdin.write("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'\n");
  const ask = (command) =>
    new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      child.stdin.write(`${shellQuestion(command)}\n`);
    });
  shell = { child, ask };
  return shell;
}

/** Starts the look at the processes now, so the first real one does not wait for PowerShell to start (Windows). */
export function warmUpProcessLook() {
  if (process.platform === 'win32')
    windowsShell()
      .ask(WINDOWS_PROCESS_LIST)
      .catch(() => {});
}

/** Ends the PowerShell that looks at the processes, if one runs. */
export function endProcessLook() {
  shell?.child.stdin.end();
  shell = undefined;
}

/**
 * Every process as { pid, ppid, start, command }, from `ps -axww -o pid=,ppid=,command=` or, on Windows, the JSON of
 * WINDOWS_PROCESS_LIST. `start` tells a process from a later one given the same pid: on Windows, which gives a pid to
 * the next process within seconds, the creation time; elsewhere 0, where the command line tells them apart.
 */
export function parseProcesses(platform, text) {
  if (platform === 'win32') {
    const list = JSON.parse(text.trim() || '[]');
    return (Array.isArray(list) ? list : [list]).map((entry) => ({
      pid: Number(entry.pid),
      ppid: Number(entry.ppid),
      start: Number(entry.start) || 0,
      command: typeof entry.command === 'string' ? entry.command : '',
    }));
  }
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), start: 0, command }));
}

/**
 * Every process of this machine (see parseProcesses). A look that fails fails the test: no look would pass the check
 * for leftovers without having made it.
 */
async function processes() {
  if (process.platform === 'win32') return parseProcesses('win32', await windowsShell().ask(WINDOWS_PROCESS_LIST));
  const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseProcesses(process.platform, stdout);
}

/**
 * The processes started under `pid` in a process table, each as { pid, start, command }. Windows keeps a parent pid
 * after the parent has exited and soon gives that pid to another process, so a "child" that started before its parent
 * is an older, unrelated process, and not counted.
 */
export function descendants(table, pid) {
  const startOf = new Map(table.map((entry) => [entry.pid, entry.start]));
  const found = [];
  const parents = new Set([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of table) {
      if (!parents.has(entry.ppid) || parents.has(entry.pid)) continue;
      if (entry.start < (startOf.get(entry.ppid) ?? 0)) continue;
      parents.add(entry.pid);
      found.push({ pid: entry.pid, start: entry.start, command: entry.command });
      grew = true;
    }
  }
  return found;
}

/** The processes started under `pid` (the app's main process: the backend, the adapter, mu and their children). */
export async function processTree(pid) {
  return descendants(await processes(), pid);
}

/** The test's own look at the process table (`ps` lists itself), which is no leftover of the app. */
const PROBE = /^ps -axww/;

/** What tells one process from every other, now and later: its pid, its start and its command line. */
const identity = (entry) => `${entry.pid}\n${entry.start}\n${entry.command}`;

/**
 * What still runs after a quit, in a process table: any of `seen` (processes the app started, gathered while it ran)
 * that is alive, and any process whose command line names the profile's folder `root` (the backend's data folder,
 * Electron's user data, mu from the profile's view of the harness). A process counts as seen only with its pid, start
 * and command line all the same: a pid the system has given to another process since is no leftover. On Windows the
 * folder is looked for in any case and with either slash, as programs write it both ways.
 */
export function leftovers({ running, seen = [], root, platform = process.platform, self = process.pid }) {
  const known = new Set(seen.map(identity));
  const fold = (text) => (platform === 'win32' ? text.replaceAll('\\', '/').toLowerCase() : text);
  const folder = fold(root);
  return running
    .filter((entry) => entry.pid !== self && !PROBE.test(entry.command))
    .filter((entry) => known.has(identity(entry)) || fold(entry.command).includes(folder))
    .map(({ pid, command }) => ({ pid, command }));
}

/** What still runs after a quit (see leftovers): of `seen`, and anything naming the profile's folder. */
export async function leftoverProcesses(profile, seen = []) {
  return leftovers({ running: await processes(), seen, root: profile.paths.root });
}
