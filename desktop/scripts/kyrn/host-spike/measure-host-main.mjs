// Electron main process of measure-host.mjs: starts native hosts through the app's own code path (startNativeHost in
// packages/desktop/src/process/services/nativeHost/index.ts, imported from its sources) in real utility processes,
// times each start and a turn, reads the host's memory, and looks for it in LaunchServices' list (the Dock) while it
// runs.
//
// Everything comes from measure-host.mjs through the environment: MEASURE_ROOT (the throwaway folder, whose `out`
// receives results.json), MEASURE_ENTRY (the host entry to fork), MEASURE_ROUNDS, and MU_ROOT (the harness).
import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '../../..');
const ROOT = process.env.MEASURE_ROOT;
const OUT = join(ROOT, 'out');
const ROUNDS = Number(process.env.MEASURE_ROUNDS || 2);

app.setName('mu-native-host-measure');
app.setPath('userData', join(ROOT, 'userData'));
app.setPath('crashDumps', join(ROOT, 'crashDumps'));

const log = (line) => process.stdout.write(`[measure] ${line}\n`);
const importRepo = (path) => import(pathToFileURL(join(REPO, path)).href);

/** LaunchServices' application list (what the Dock shows is its Foreground part), or '' off macOS. */
function lsappinfo(label) {
  if (process.platform !== 'darwin') return '';
  const text = execFileSync('/usr/bin/lsappinfo', ['list'], { encoding: 'utf8' });
  writeFileSync(join(OUT, `lsappinfo-${label}.txt`), text);
  return text;
}

/** Whether `pid` has an entry in an lsappinfo list. */
const listed = (text, pid) => text.split('\n').some((line) => line.includes(`pid = ${pid} `));

/** A process's resident memory in MB, as ps reports it (macOS and Linux). */
function residentMb(pid) {
  if (process.platform === 'win32') return undefined;
  const kilobytes = Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  return Number.isFinite(kilobytes) ? Math.round(kilobytes / 1024) : undefined;
}

/** ps's state letters for a process (`Z`: exited, waiting to be reaped), or '' once there is none. */
function processState(pid) {
  try {
    return execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    // ps exits with 1 when there is no such process.
    return '';
  }
}

/** Milliseconds from `since` until the process is gone or a zombie, looking every 5 ms for up to 2 s. */
async function goneAfter(pid, since) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const state = processState(pid);
    if (state === '' || state.startsWith('Z')) return Math.round(performance.now() - since);
    // oxlint-disable-next-line no-await-in-loop -- one process, looked at until it is gone
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

const watchdog = setTimeout(() => {
  log('gave up after 150 s');
  app.exit(2);
}, 150_000);

app
  .whenReady()
  .then(measure)
  .catch((error) => {
    log(`failed: ${error?.stack ?? error}`);
    app.exit(1);
  });

async function measure() {
  mkdirSync(OUT, { recursive: true });
  const { FAKE_API_KEY, FAKE_MODEL_ID, startFakeModel } = await importRepo('tests/e2e/mu-conversation/fakeModel.mjs');
  const { launcherFs } = await importRepo('tests/integration/nativeHost/hostWorld.mjs');
  const { startNativeHost } = await importRepo('packages/desktop/src/process/services/nativeHost/index.ts');
  const model = await startFakeModel();
  const agentDir = join(process.env.HOME, '.mu', 'agent');
  const project = join(ROOT, 'project');
  for (const dir of [agentDir, project]) mkdirSync(dir, { recursive: true });
  const provider = {
    baseUrl: model.baseUrl,
    api: 'openai-completions',
    apiKey: FAKE_API_KEY,
    models: [{ id: FAKE_MODEL_ID }],
  };
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { e2e: provider } }));
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'e2e', defaultModel: FAKE_MODEL_ID })
  );
  writeFileSync(join(agentDir, 'mu.json'), JSON.stringify({ tiers: ['mock'], modes: { default: 'off' } }));
  log(`electron ${process.versions.electron}, node ${process.versions.node}, main pid ${process.pid}`);
  // The control: Electron's main process is an app LaunchServices lists, so a host that is not listed is not missed.
  const mainListed = listed(lsappinfo('main-only'), process.pid);
  log(`main process in LaunchServices: ${mainListed}`);

  const results = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const t0 = performance.now();
    const host = await startNativeHost({
      cwd: project,
      entry: process.env.MEASURE_ENTRY,
      env: process.env,
      fs: launcherFs(process.env.MU_ROOT),
    });
    await host.request({ type: 'get_state' });
    const pid = host.pid;
    const hostListed = listed(lsappinfo(`round-${round}`), pid);
    const settled = new Promise((resolveSettled) => {
      const stop = host.subscribe((record) => {
        if (record.type !== 'agent_settled') return;
        stop();
        resolveSettled();
      });
    });
    const turnStart = performance.now();
    await host.request({ type: 'prompt', message: 'E2E:PLAIN' });
    await settled;
    const turnMs = performance.now() - turnStart;
    const rssMb = residentMb(pid);
    const disposeStart = performance.now();
    await host.dispose();
    const since = (value) => (value === undefined ? undefined : Math.round(value - t0));
    const result = {
      round,
      state: host.state.phase,
      forked: since(host.timings.forked),
      imported: since(host.timings.imported),
      firstRecord: since(host.timings.firstRecord),
      firstState: since(host.timings.firstState),
      plainTurnMs: Math.round(turnMs),
      hostRssMbAfterTurn: rssMb,
      disposeMs: Math.round(performance.now() - disposeStart),
      // Of which: until the process exited; the rest waits for its output streams to end.
      exitAfterDisposeMs:
        host.timings.exited === undefined ? undefined : Math.round(host.timings.exited - disposeStart),
      hostInLaunchServices: hostListed,
      hostStateAfterDispose: processState(pid),
      hostGoneAfterDisposeMs: await goneAfter(pid, disposeStart),
    };
    log(JSON.stringify(result));
    results.push(result);
  }
  lsappinfo('after-hosts');
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  await model.close();
  clearTimeout(watchdog);
  const wrong = results.filter(
    (result) => result.state !== 'stopped' || result.hostInLaunchServices || result.hostGoneAfterDisposeMs === undefined
  );
  if (wrong.length > 0) log(`rounds that went wrong: ${wrong.map((result) => result.round).join(', ')}`);
  app.exit(wrong.length > 0 ? 3 : 0);
}
