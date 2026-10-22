/**
 * Electron main process of the spike: no window, its own throw-away profile, one utility process.
 * It never touches the running desktop app, the backend, or the real ~/.kyrn.
 */
import { app, utilityProcess } from 'electron';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario } from './scenario.mjs';

const profile = mkdtempSync(join(tmpdir(), 'kyrn-host-spike-electron-'));
app.setPath('userData', profile);
app.dock?.hide();
const progress = (step) => process.env.SPIKE_VERBOSE && console.error(`[spike] ${step}`);
const guard = setTimeout(
  () => {
    console.error('spike timed out');
    app.exit(2);
  },
  Number(process.env.SPIKE_TIMEOUT_MS ?? 60000)
);

async function run() {
  progress('app ready');
  const host = utilityProcess.fork(join(import.meta.dirname, 'host-entry.mjs'), [], {
    serviceName: 'kyrn-runtime-host-spike',
    stdio: 'inherit',
    env: process.env,
  });
  host.on('spawn', () => progress(`host spawned, pid ${host.pid}`));
  host.on('exit', (code) => progress(`host exited with ${code}`));
  const link = { send: (message) => host.postMessage(message), onMessage: (handler) => host.on('message', handler) };
  let code = 2;
  try {
    const report = await runScenario(link, 'electron utilityProcess');
    const out = process.env.SPIKE_REPORT;
    if (out) writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    code = report.passed ? 0 : 1;
  } catch (error) {
    console.error(error);
  } finally {
    clearTimeout(guard);
    host.kill();
    rmSync(profile, { recursive: true, force: true });
    app.exit(code);
  }
}

// No top-level await here: in an ESM entry, `ready` is not delivered while the entry module is still evaluating.
void app.whenReady().then(run);
