#!/usr/bin/env node
// Records the conversation the native host's reducer tests read (reducer.test.ts): a real host (entry.ts, started
// with Node's child_process.fork, through the NativeHost manager) running a mu checkout against the E2E fake model,
// with the offline `mock` judge in shadow mode, so Jev's decisions and verdict lines are recorded but change nothing.
//
//   node tests/unit/process/services/nativeHost/fixtures/record.mjs [harness root] [--out <folder>]
//
// The harness is the argument, else MU_ROOT / KYRN_ROOT, else the KYRN checkout beside this repository
// (tests/e2e/mu-conversation/profile.mjs). It needs a Node that strips TypeScript types (22.18 or newer) and a
// harness whose launcher has planHost. macOS and Linux. `--out` writes the files elsewhere, to compare a new
// recording with the committed one.
//
// One session, one prompt after another, each waiting for the run to settle:
//
//   E2E:PLAIN                           a streamed reply
//   E2E:WRITE notes/hello.txt           the write tool, then a reply
//   E2E:BASH echo native-host-bash-ok   the bash tool, then a reply
//   E2E:BASH sleep 0.2; echo asked-ok   mu asks first (Jev approves, the mock judge abstains); answered Allow once
//   E2E:BASH sleep 0.2; echo asked-ok   mu asks again (the answer allowed that call only); stopped with abort instead
//   E2E:SLOW                            stopped with abort once its third line streamed
//
// It writes conversation.records.jsonl, every record pi wrote to the app in order (with the dialog answer the manager
// handed on to its subscribers), and conversation.session.jsonl, the session file pi wrote. Before they are written,
// the reducer must give the same view from both, what only a live host says aside (view.ts `durable`).
//
// Nothing of the person running it gets in (tests/integration/nativeHost/hostWorld.mjs): a throwaway home, a short
// environment instead of this process's, and a file system for the launcher on which the checkout's `.env` (its keys)
// does not exist. The throwaway folder, the harness, the home folder and the fake model's port are replaced with
// fixed ones in what is written.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { fromEntries, reduceAll } from '../../../../../../packages/desktop/src/common/utils/nativeHost/reducer.ts';
import { durable } from '../../../../../../packages/desktop/src/common/utils/nativeHost/view.ts';
import { prepareHost } from '../../../../../../packages/desktop/src/process/services/nativeHost/launch.ts';
import { NativeHost } from '../../../../../../packages/desktop/src/process/services/nativeHost/NativeHost.ts';
import { forkWithNode } from '../../../../../../packages/desktop/src/process/services/nativeHost/nodeFork.ts';
import { startFakeModel } from '../../../../../e2e/mu-conversation/fakeModel.mjs';
import { findHarnessSource } from '../../../../../e2e/mu-conversation/profile.mjs';
import { createHostWorld, launcherFs } from '../../../../../integration/nativeHost/hostWorld.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../../../..');
const entry = join(repo, 'packages/desktop/src/process/services/nativeHost/entry.ts');

/** The fixed names written in place of this machine's. */
const WORLD = '/tmp/mu-fixture';
const HARNESS = '/opt/mu';
const HOME = '/Users/someone';
const MODEL_PORT = 4000;

/** How long one step may take before the recording gives up. */
const STEP_MS = 90_000;

/** The first record from now on that `test` accepts. */
function next(host, test, label) {
  return new Promise((resolveRecord, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`No ${label} within ${STEP_MS} ms`));
    }, STEP_MS);
    const stop = host.subscribe((record) => {
      if (!test(record)) return;
      clearTimeout(timer);
      stop();
      resolveRecord(record);
    });
  });
}

const settles = (record) => record.type === 'agent_settled';

/** Sends a prompt and waits for its run to settle; `during` runs while it goes. */
async function turn(host, message, during) {
  const settled = next(host, settles, `end of the run of ${message}`);
  const waiting = during?.();
  const accepted = host.request({ type: 'prompt', message });
  await Promise.all([accepted, waiting, settled]);
}

/** Every string in `value` with each `[from, to]` replaced, longest `from` first. */
function normalizer(pairs) {
  const sorted = pairs.filter(([from]) => from).toSorted((a, b) => b[0].length - a[0].length);
  const text = (value) => sorted.reduce((out, [from, to]) => out.split(from).join(to), value);
  const walk = (value) => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [text(key), walk(inner)]));
    return value;
  };
  return walk;
}

/** pi names a session's folder after its project: the path, its separators turned into dashes. */
const folder = (path) => path.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');

const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

async function recordConversation(harness, out) {
  const model = await startFakeModel();
  const world = createHostWorld({ baseUrl: model.baseUrl, judgeMode: 'shadow', nodeDir: dirname(process.execPath) });
  try {
    const { records, sessionFile } = await converse(harness, world);
    write({ world: world.root, harness, port: model.port, records, sessionFile, out });
  } finally {
    await model.close();
    world.remove();
  }
}

/** The conversation itself: every record pi wrote, and the file it kept the session in. */
async function converse(harness, world) {
  const { project, env } = world;
  const records = [];
  let sessionFile = '';
  let host;
  try {
    const launch = await prepareHost({
      harness,
      cwd: project,
      env,
      home: world.home,
      platform: process.platform,
      stripsTypes: true,
      fs: launcherFs(harness.root),
      note: (line) => console.error(`launcher: ${line}`),
    });
    host = new NativeHost({ launch, fork: forkWithNode(entry), log: (line) => console.error(`mu: ${line}`) });
    host.subscribe((each) => records.push(each));
    host.start();
    const state = await host.request({ type: 'get_state' });
    sessionFile = state.sessionFile ?? '';
    await turn(host, 'E2E:PLAIN');
    await turn(host, 'E2E:WRITE notes/hello.txt');
    if (!existsSync(join(project, 'notes', 'hello.txt'))) throw new Error('E2E:WRITE wrote no notes/hello.txt');
    await turn(host, 'E2E:BASH echo native-host-bash-ok');
    await turn(host, 'E2E:BASH sleep 0.2; echo asked-ok', async () => {
      const dialog = await next(
        host,
        (each) => each.type === 'extension_ui_request' && each.method === 'select',
        'permission question'
      );
      host.respondToDialog(dialog.id, { value: dialog.options[0] });
    });
    await turn(host, 'E2E:BASH sleep 0.2; echo asked-ok', async () => {
      await next(
        host,
        (each) => each.type === 'extension_ui_request' && each.method === 'select',
        'second permission question'
      );
      await host.request({ type: 'abort' });
    });
    await turn(host, 'E2E:SLOW', async () => {
      await next(
        host,
        (each) => each.type === 'message_update' && each.assistantMessageEvent?.delta?.includes('SLOW-003'),
        'third line of E2E:SLOW'
      );
      await host.request({ type: 'abort' });
    });
  } finally {
    await host?.dispose();
  }
  if (host.state.phase !== 'stopped') throw new Error(`The host ended ${host.state.phase}, not stopped`);
  if (!sessionFile) throw new Error('pi named no session file');
  return { records, sessionFile };
}

/** Writes the recording, with this machine's names replaced, once the reducer gives the same view from both files. */
function write({ world, harness, port, records, sessionFile, out }) {
  const session = readFileSync(sessionFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const normalize = normalizer([
    [world, WORLD],
    [world.replace(/^\/private\//, '/'), WORLD],
    [folder(world), folder(WORLD)],
    [harness.root, HARNESS],
    [homedir(), HOME],
    [`127.0.0.1:${port}`, `127.0.0.1:${MODEL_PORT}`],
  ]);
  const normalized = { records: normalize(records), session: normalize(session) };
  const text = { records: jsonl(normalized.records), session: jsonl(normalized.session) };
  // Whatever still names this machine was not replaced above: nothing is written then.
  const tmp = tmpdir();
  for (const name of [basename(world), userInfo().username, hostname(), ...(tmp === '/tmp' ? [] : [tmp])]) {
    for (const [file, content] of Object.entries(text))
      if (name.length > 2 && content.includes(name)) throw new Error(`The ${file} still name this machine (${name})`);
  }
  const live = durable(reduceAll(normalized.records));
  const reload = durable(fromEntries(normalized.session));
  if (!isDeepStrictEqual(live, reload)) {
    const differs = Object.keys(live).filter((key) => !isDeepStrictEqual(live[key], reload[key]));
    throw new Error(`The live view and the reloaded one differ in ${differs.join(', ')}`);
  }
  writeFileSync(join(out, 'conversation.records.jsonl'), text.records);
  writeFileSync(join(out, 'conversation.session.jsonl'), text.session);
  console.log(
    `records ${normalized.records.length}, session entries ${normalized.session.length}, ` +
      `messages ${live.messages.length}, ` +
      `judgments ${live.judgments.length}, status ${live.status}; harness ${harness.root}`
  );
}

if (!process.features.typescript) throw new Error('This Node does not strip TypeScript types: use 22.18 or newer');
const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
const harness = positionals[0] ? { root: realpathSync(positionals[0]) } : findHarnessSource(repo);
await recordConversation(harness, values.out ? resolve(values.out) : here);
