/**
 * End-to-end check of the browser bridge: the harness's REAL browse loop against a REAL Electron `<webview>`.
 *
 *   export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
 *   node scripts/kyrn/browser-bridge-check/run.mjs
 *
 * What runs: an Electron main with ONLY the bridge and one window of `<webview>` tabs (`app-main.ts`, bundled on
 * the fly with esbuild), and the harness's own client, session and loop (`driver.mts`, run by Node itself with the
 * harness's source resolver) with a scripted judge. No AionCore, no conversations, no model, no judge service.
 * `HOME` is a throw-away directory for both, so the advert is written to and found in a throw-away mu home, and the
 * real `~/.mu` is never touched. Electron needs the window server: it cannot start inside a sandboxed shell.
 *
 * Environment: ELECTRON_EXEC_PATH (default: the Electron the dev app uses, `<desktop repo>/kyrn/node_modules/…`),
 * MU_HARNESS_ROOT (default: `<desktop repo>/../KYRN`), MU_CHECK_VERBOSE=1, MU_CHECK_SHOW=0 (keep the window
 * hidden), MU_CHECK_REPORT=<file>. Exit code 0 means every check passed.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const worktree = resolve(here, '../../..');
// A git worktree has no node_modules of its own: tools are found by walking up to the main checkout.
const require = createRequire(join(worktree, 'package.json'));
const mainCheckout = require.resolve('esbuild/package.json').split(/[\\/]node_modules[\\/]/)[0];
const harness = resolve(process.env.MU_HARNESS_ROOT ?? join(mainCheckout, '../KYRN'));
const electron =
  process.env.ELECTRON_EXEC_PATH ??
  join(mainCheckout, 'kyrn/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
// Node strips the driver's types itself; pi's source resolver points the harness's package imports at its sources.
const resolver = join(harness, 'packages/coding-agent/src/experimental/source-resolver.ts');

for (const [what, path] of [
  ['Electron binary (ELECTRON_EXEC_PATH)', electron],
  ['harness checkout (MU_HARNESS_ROOT)', join(harness, 'packages/kyrn-judge/src/browser/embedded.ts')],
  ["pi's source resolver in the harness", resolver],
]) {
  if (!existsSync(path)) {
    console.error(`Missing ${what}: ${path}`);
    process.exit(2);
  }
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mu-bridge-check-')));
const home = join(scratch, 'home');
const controlFile = join(scratch, 'control.json');
const bundle = join(scratch, 'app-main.cjs');
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  MU_CHECK_HOME: home,
  MU_CHECK_CONTROL_FILE: controlFile,
  MU_CHECK_HOST_PAGE: join(here, 'host.html'),
  MU_HARNESS_ROOT: harness,
};
// Neither side may be pointed anywhere else, and Electron must start as Electron.
for (const name of ['MU_BROWSER_ENDPOINT', 'KYRN_BROWSER_ENDPOINT', 'ELECTRON_RUN_AS_NODE', 'KYRN_SWARM_DEPTH'])
  delete env[name];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let app;
let code = 2;
try {
  const { build } = require('esbuild');
  mkdirSync(home, { recursive: true });
  await build({
    entryPoints: [join(here, 'app-main.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    tsconfig: join(worktree, 'tsconfig.json'),
    external: ['electron', 'bufferutil', 'utf-8-validate'],
    logLevel: 'warning',
  });

  app = spawn(electron, [bundle], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  const gone = new Promise((done) => app.once('exit', (status) => done(status)));
  const started = await Promise.race([
    (async () => {
      while (!existsSync(controlFile)) await sleep(100);
      return true;
    })(),
    gone.then(() => false),
    sleep(30_000).then(() => false),
  ]);
  if (!started) throw new Error('Electron did not start the bridge (no window server in a sandboxed shell?)');
  const { advert } = JSON.parse(readFileSync(controlFile, 'utf8'));

  const driver = spawn(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '--import',
      pathToFileURL(resolver).href,
      process.env.MU_CHECK_DRIVER ?? join(here, 'driver.mts'),
    ],
    {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  );
  let output = '';
  driver.stdout.on('data', (chunk) => (output += chunk));
  const driverCode = await new Promise((done) => driver.once('exit', done));
  const report = JSON.parse(output);

  // Quit the way a person does, then look: the advert must be gone.
  const { port } = JSON.parse(readFileSync(controlFile, 'utf8'));
  await fetch(`http://127.0.0.1:${port}/quit`, { method: 'POST' }).catch(() => undefined);
  await Promise.race([gone, sleep(10_000)]);
  report.checks.push({ name: 'the advert is removed when the app quits', ok: !existsSync(advert) });
  report.passed = driverCode === 0 && report.checks.every((entry) => entry.ok);

  if (process.env.MU_CHECK_REPORT) writeFileSync(process.env.MU_CHECK_REPORT, JSON.stringify(report, null, 2));
  for (const entry of report.checks) {
    console.log(
      `${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.detail === undefined ? '' : `\n     ${JSON.stringify(entry.detail)}`}`
    );
  }
  const failed = report.checks.filter((entry) => !entry.ok).length;
  console.log(
    `\nElectron ${report.electron}: ${report.checks.length - failed} of ${report.checks.length} checks passed`
  );
  code = report.passed ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (app && app.exitCode === null) app.kill();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(code);
}
