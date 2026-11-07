#!/usr/bin/env node
// Starts mu's ACP adapter (packages/desktop/src/process/agent/kyrn/index.ts) with Node alone: no bash.
//
// The backend runs it as the command of mu's registration. On Windows that command is acp.cmd beside this file (a
// registration command has to be something Windows can start: the backend wraps a .cmd in `cmd /d /c`). macOS and
// Linux keep the bash `acp`, whose path is the registration's key there: changing it would register mu a second time.
//
// The adapter finds the harness itself (process/agent/kyrn/harness.ts): KYRN_ROOT or MU_ROOT, a checkout beside the
// desktop's, or mu-agent installed with npm.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** pi's minimum, the same as the harness launcher's. */
const MIN_NODE = [22, 19];

export function nodeVersionOk(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!nodeVersionOk(process.versions.node)) {
    process.stderr.write(
      `mu needs Node.js ${MIN_NODE.join('.')} or newer, found ${process.versions.node}. ` +
        'Install a newer one from https://nodejs.org (Windows: winget install OpenJS.NodeJS.LTS).\n'
    );
    process.exit(1);
  }
  // Found wherever the package manager put node_modules: a worktree has none of its own.
  const tsx = createRequire(join(root, 'package.json')).resolve('tsx/cli');
  const adapter = join(root, 'packages', 'desktop', 'src', 'process', 'agent', 'kyrn', 'index.ts');
  const child = spawn(process.execPath, [tsx, adapter, ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (error) => {
    process.stderr.write(`mu's adapter did not start: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}
