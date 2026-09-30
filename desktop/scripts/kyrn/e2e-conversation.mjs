#!/usr/bin/env node
// Runs the mu conversation E2E test (tests/e2e/mu-conversation): builds the app into out/, then runs the test's own
// Playwright configuration. The exit code is the test's: 0 passed, anything else failed.
//
//   bun run e2e:conversation [--native] [--skip-build] [--app <app> [--arch arm64|x64]] [-- <playwright options>]
//
// --native runs the native host's test (tests/e2e/mu-conversation/native.spec.mjs: pi inside the app, the default)
// instead of the conversation on AionCore (which the classic run reaches with MU_NATIVE_HOST=0).
//
// --app runs a packaged app instead of the checkout's build, and builds nothing. <app> is the app's executable, the app
// (a `.app` on macOS, the unpacked folder elsewhere), or electron-builder's output folder (out/), where the app for this
// system and --arch (by default this Node's) is taken. A packaged app carries mu and the backend: no harness checkout,
// AionCore binary or Node is needed for it.
//
// MU_E2E_KEEP=1 keeps the throwaway profile (logs, sessions, the project) after a pass too; after a failure it is
// always kept, and its path is printed. MU_E2E_ROOT names the profile's folder (empty or missing), which is always
// kept. tests/e2e/README.md has the rest.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagedApp } from '../../tests/e2e/mu-conversation/app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const separator = args.indexOf('--');
const own = separator >= 0 ? args.slice(0, separator) : args;
const extra = separator >= 0 ? args.slice(separator + 1) : [];
const option = (name) => {
  const index = own.indexOf(`--${name}`);
  return index >= 0 ? own[index + 1] : undefined;
};
const skipBuild = own.includes('--skip-build') || process.env.MU_E2E_SKIP_BUILD === '1';
const native = own.includes('--native');
// MU_E2E_APP names a packaged app the same way, for the test alone as well.
const appTarget = option('app') ?? process.env.MU_E2E_APP;
const arch = option('arch') ?? process.arch;

/**
 * A file of an installed package, from the nearest `node_modules` at or above the checkout: a worktree under
 * `.claude/worktrees/` has none of its own and uses the main checkout's. Its command-line script is run with this Node,
 * never through the package manager's shims (`.cmd` files on Windows, which only a shell starts).
 */
function packageFile(name, file) {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, file);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) {
      console.error(`[mu e2e] ${name} is not installed (looked for node_modules/${name}/${file}): run bun install.`);
      process.exit(1);
    }
  }
}

function step(title, script, scriptArgs, env = process.env) {
  console.log(`\n[mu e2e] ${title}`);
  const result = spawnSync(process.execPath, [script, ...scriptArgs], { cwd: root, stdio: 'inherit', env });
  if (result.error) {
    console.error(`[mu e2e] ${title} could not start: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

const env = { ...process.env };
if (native) env.MU_E2E_SPEC = 'native';
if (appTarget) {
  const app = packagedApp(resolve(appTarget), arch);
  if (!app) {
    console.error(`[mu e2e] No packaged app for ${process.platform}-${arch} in ${resolve(appTarget)}.`);
    process.exit(1);
  }
  console.log(`[mu e2e] the packaged app ${app.executable}`);
  env.MU_E2E_APP = app.executable;
} else if (!skipBuild) {
  // Only errors: a working build's chunk report would bury the test's own output.
  const built = step(
    'building the app (electron-vite)',
    packageFile('electron-vite', join('bin', 'electron-vite.js')),
    ['build', '--config', 'packages/desktop/electron.vite.config.ts', '--logLevel', 'error']
  );
  if (built !== 0) process.exit(built);
} else if (!existsSync(join(root, 'out', 'main'))) {
  console.error('[mu e2e] --skip-build, but there is no build in out/. Run without --skip-build once.');
  process.exit(1);
}

const status = step(
  'running the conversation test',
  packageFile('@playwright/test', 'cli.js'),
  ['test', '--config', 'tests/e2e/mu-conversation/playwright.config.mjs', ...extra],
  env
);
console.log(status === 0 ? '\n[mu e2e] PASSED' : `\n[mu e2e] FAILED (exit ${status})`);
process.exit(status);
