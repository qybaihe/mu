#!/usr/bin/env node
// Checks, on this machine, the chain the desktop app uses to start mu, as the app and the backend run it:
//
//   1. the harness is found (MU_ROOT / KYRN_ROOT, a checkout beside the desktop, or mu-agent from npm; the copy a
//      packaged app carries is found only inside one, by Electron's resources folder);
//   2. PiRpc starts it as the adapter does (on Windows `node kyrn/bin/mu.mjs --mode rpc`, no shell), it answers
//      get_commands, and closing it ends its whole process tree;
//   3. the registration's command (scripts/kyrn/acp; on Windows acp.cmd through `cmd /d /c`, as the backend wraps it)
//      answers the ACP handshake and opens a session, which starts mu under the adapter, and ending the command's
//      tree as the backend does leaves nothing behind;
//   4. with --packaged, step 3 for the packaged app: the adapter bundled by scripts/build-mcp-servers.js and
//      resources/mu/acp(.cmd), laid out as in an installed app's resources folder. There is no app binary in that
//      folder, so MU_NODE runs them on this Node instead of the app's own.
//   5. with --permission, mu's permission round trip through the same command: a stub model (a local HTTP server
//      speaking the OpenAI chat API) asks for a file write, mu in minimal permissions asks, and the check answers as
//      the app does: allow once, don't allow, and an answer that is none of the choices (mu must hear "no" and the
//      conversation must get the answer-lost line). A plain message after that must still work, on the same adapter.
//
// Everything runs in a throwaway home (HOME and USERPROFILE): ~/.mu is never touched, no model is called, no key is
// needed. Exits 1 when a step fails.
//
//   node scripts/kyrn/start-check/check.mjs [--packaged] [--permission]
//
// Needs Node 22.19 or newer (it loads the adapter's TypeScript with Node's type stripping), the harness's
// dependencies (npm ci in its checkout) and the desktop's (bun install).
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const windows = process.platform === 'win32';
const packaged = process.argv.includes('--packaged');
const permission = process.argv.includes('--permission');
const home = mkdtempSync(join(tmpdir(), 'mu-start-check-'));
// Before the adapter's modules load: they read the home when called.
process.env.HOME = home;
process.env.USERPROFILE = home;

const adapterModule = (file) =>
  import(pathToFileURL(join(desktop, 'packages', 'desktop', 'src', 'process', 'agent', 'kyrn', file)).href);
const { findHarness, launcherOf } = await adapterModule('harness.ts');
const { PiRpc } = await adapterModule('piRpc.ts');

let failed = 0;
function report(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every process of this machine as [pid, parent pid, start]. On Windows the start (creation time, in milliseconds:
 * the 100 ns ticks would not fit a JavaScript number) tells a process from a later one given the same pid;
 * elsewhere it is 0.
 */
function processTable() {
  const text = windows
    ? execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { [long]($_.CreationDate.ToFileTimeUtc() / 10000) } else { 0 })" }',
        ],
        { encoding: 'utf8', windowsHide: true }
      )
    : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parent]) => pid > 0 && parent >= 0)
    .map(([pid, parent, start = 0]) => [pid, parent, start]);
}

/**
 * A process and all its descendants, as they are now, each with its start. Windows keeps a parent pid after the
 * parent has exited and soon gives that pid to another process, so a "child" that started before its parent is an
 * unrelated older process: it is not ours to end, and counting it made the check fail at random.
 */
function tree(root) {
  const table = processTable();
  const startOf = new Map(table.map(([pid, , start]) => [pid, start]));
  const children = new Map();
  for (const [pid, parent, start] of table) {
    if (start < (startOf.get(parent) ?? 0)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const found = [root];
  for (let i = 0; i < found.length; i++) found.push(...(children.get(found[i]) ?? []));
  return found.map((pid) => ({ pid, start: startOf.get(pid) ?? 0 }));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Whether one of these processes still runs. On Windows a pid only counts with its own start: pids are reused fast. */
function anyAlive(procs) {
  if (!windows) return procs.some(({ pid }) => alive(pid));
  const now = new Map(processTable().map(([pid, , start]) => [pid, start]));
  return procs.some(({ pid, start }) => now.get(pid) === start);
}

async function gone(procs, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!anyAlive(procs)) return true;
    // Reading the process table on Windows takes a PowerShell start, about a second.
    await sleep(windows ? 1000 : 250);
  }
  return !anyAlive(procs);
}

/** Ends a command's tree as the backend does: taskkill /F /T on Windows, the process group elsewhere. */
function endAsTheBackendDoes(child) {
  if (windows)
    execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
  else process.kill(-child.pid, 'SIGTERM');
}

/** Starts an ACP command, shakes hands, opens a session, then ends it. */
async function acp(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: home,
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !windows,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    waiting.get(message.id)?.(message);
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const call = (id, method, params, ms) =>
    within(
      Promise.race([
        new Promise((resolve) => {
          waiting.set(id, resolve);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        }),
        exited.then((code) => {
          throw new Error(`exited with ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
        }),
      ]),
      ms,
      method
    );
  try {
    const hello = await call(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} }, 60000);
    report(`${name}: ACP handshake`, hello.result?.agentInfo?.title === 'mu', JSON.stringify(hello.result?.agentInfo));
    const started = Date.now();
    const session = await call(2, 'session/new', { cwd: home, mcpServers: [] }, 180000);
    report(
      `${name}: a session starts mu`,
      typeof session.result?.sessionId === 'string',
      session.error ? session.error.message : `${Date.now() - started} ms`
    );
  } catch (error) {
    report(`${name}`, false, error.message);
  }
  const procs = tree(child.pid);
  endAsTheBackendDoes(child);
  report(`${name}: ending it leaves nothing behind`, await gone(procs), `${procs.length} processes`);
}

/**
 * A model for mu that needs no key: an OpenAI-style chat endpoint on this machine. A user message with
 * `PERMISSION_CHECK <file>` gets a call of mu's write tool for that file; after the tool's result, and for anything
 * else, a line of text.
 */
async function stubModel() {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      let messages = [];
      try {
        messages = JSON.parse(body).messages ?? [];
      } catch {}
      const last = messages.at(-1) ?? {};
      const said = JSON.stringify([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');
      const file = /PERMISSION_CHECK (\S+?\.txt)/.exec(said)?.[1];
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: 0, model: 'stub', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (file && last.role !== 'tool') {
        const call = { name: 'write', arguments: JSON.stringify({ path: file, content: 'written by mu\n' }) };
        response.write(
          chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: call }] })
        );
        response.write(chunk({}, 'tool_calls'));
      } else {
        response.write(chunk({ role: 'assistant', content: last.role === 'tool' ? 'Done after the tool.' : 'Hello.' }));
        response.write(chunk({}, 'stop'));
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const agentDir = join(home, '.mu', 'agent');
  mkdirSync(agentDir, { recursive: true });
  const model = { id: 'stub', name: 'Stub', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 };
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        stub: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          api: 'openai-completions',
          apiKey: 'stub',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [model],
        },
      },
    })
  );
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'stub', defaultModel: 'stub' }));
  return server;
}

/**
 * mu's permission round trip through an ACP command, answered as the app answers it (see step 5 above). The adapter
 * must stay the same process throughout: a failed answer never ends it.
 */
async function permissionRoundTrip(name, command, args, extraEnv = {}) {
  const server = await stubModel();
  const project = join(home, 'permission-project');
  mkdirSync(project, { recursive: true });
  const child = spawn(command, args, {
    cwd: project,
    env: {
      ...process.env,
      // Minimal permissions: every write asks. The mock judge needs no key; the answers come in Chinese.
      MU_PERMISSIONS: 'ask',
      MU_JUDGE: 'mock',
      MU_LANG: 'zh-CN',
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !windows,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });
  const waiting = new Map();
  const asked = [];
  const updates = [];
  /** What the next question of mu gets: an option id, or `undefined` for one that is none of the choices. */
  let reply = 'mu:once';
  const write = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === 'session/request_permission') {
      asked.push(message.params);
      write({ id: message.id, result: { outcome: { outcome: 'selected', optionId: reply ?? 'no-such-answer' } } });
      return;
    }
    if (message.method === 'session/update') {
      updates.push(message.params.update);
      return;
    }
    waiting.get(message.id)?.(message);
  });
  let exitCode;
  const exited = new Promise((resolve) =>
    child.on('exit', (code) => {
      exitCode = code;
      resolve(code);
    })
  );
  let next = 1;
  const call = (method, params, ms) => {
    const id = next++;
    return within(
      Promise.race([
        new Promise((resolve) => {
          waiting.set(id, resolve);
          write({ id, method, params });
        }),
        exited.then((code) => {
          throw new Error(`the adapter exited with ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
        }),
      ]),
      ms,
      method
    );
  };
  const noticed = () =>
    updates
      .filter((update) => String(update.toolCallId ?? '').startsWith('mu:notice:'))
      .map((update) => update.rawInput);
  try {
    await call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 60000);
    const session = await call('session/new', { cwd: project, mcpServers: [] }, 180000);
    if (session.error) throw new Error(`session/new: ${session.error.message}`);
    const sessionId = session.result.sessionId;
    const turn = async (text) => {
      const answered = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 180000);
      if (answered.error) throw new Error(`${text}: ${answered.error.message}`);
      return answered.result?.stopReason;
    };

    reply = 'mu:once';
    let stop = await turn('PERMISSION_CHECK allowed.txt');
    const card = asked.at(-1);
    report(
      `${name}: mu asks, with its answers by id`,
      card?.toolCall?.toolCallId?.startsWith('permission:') &&
        card.options.map((option) => option.optionId).join(',') === 'mu:once,mu:session,mu:deny' &&
        card.options[0].name === '允许这一次',
      JSON.stringify(card?.options?.map((option) => `${option.optionId}=${option.name}`))
    );
    report(
      `${name}: "allow once" runs the call`,
      stop === 'end_turn' && existsSync(join(project, 'allowed.txt')),
      stop
    );

    reply = 'mu:deny';
    stop = await turn('PERMISSION_CHECK denied.txt');
    report(
      `${name}: "don't allow" stops the call`,
      stop === 'end_turn' && asked.length === 2 && !existsSync(join(project, 'denied.txt')),
      stop
    );

    reply = undefined;
    stop = await turn('PERMISSION_CHECK lost.txt');
    report(
      `${name}: an answer that is none of the choices is a "no", said in the conversation`,
      stop === 'end_turn' &&
        !existsSync(join(project, 'lost.txt')) &&
        noticed().some((input) => input?.notice === 'answer_lost'),
      `${stop}, notices ${JSON.stringify(noticed())}`
    );

    stop = await turn('hello');
    report(`${name}: the conversation goes on`, stop === 'end_turn' && exitCode === undefined, stop);
  } catch (error) {
    report(`${name}: permission round trip`, false, error.message);
  }
  const procs = tree(child.pid);
  endAsTheBackendDoes(child);
  server.close();
  report(`${name}: ending it leaves nothing behind`, await gone(procs), `${procs.length} processes`);
}

try {
  // 1. The harness.
  const harness = findHarness(desktop);
  report('harness found', Boolean(harness), harness ? `${harness.source}, ${harness.layout}: ${harness.root}` : '');
  if (!harness) process.exit(1);

  // 2. mu over RPC, started as the adapter starts it.
  const launcher = launcherOf(harness, process.platform);
  const rpc = new PiRpc(launcher, home, undefined, () => {});
  const started = Date.now();
  try {
    const data = await within(rpc.send({ type: 'get_commands' }), 180000, 'get_commands');
    const names = (data.commands ?? []).map((command) => command.name);
    report('mu answers over RPC', names.includes('goal'), `${names.length} commands in ${Date.now() - started} ms`);
  } catch (error) {
    report('mu answers over RPC', false, error.message);
  }
  // The child is private to TypeScript, not at run time.
  const procs = rpc.child?.pid ? tree(rpc.child.pid) : [];
  rpc.close();
  report('closing mu ends its whole tree', await gone(procs), `${procs.length} processes`);

  // 3. The registration's command, as the backend runs it.
  const scripts = join(desktop, 'scripts', 'kyrn');
  if (windows) await acp('scripts/kyrn/acp.cmd', 'cmd.exe', ['/d', '/c', join(scripts, 'acp.cmd')]);
  else await acp('scripts/kyrn/acp', join(scripts, 'acp'), []);

  // 4. The packaged app's launcher and bundled adapter.
  if (packaged) {
    execFileSync(process.execPath, [join(desktop, 'scripts', 'build-mcp-servers.js')], { stdio: 'inherit' });
    const resources = join(home, 'Resources');
    mkdirSync(join(resources, 'mu'), { recursive: true });
    mkdirSync(join(resources, 'app.asar.unpacked', 'out', 'main'), { recursive: true });
    copyFileSync(
      join(desktop, 'out', 'main', 'mu-acp.js'),
      join(resources, 'app.asar.unpacked', 'out', 'main', 'mu-acp.js')
    );
    for (const name of ['acp', 'acp.cmd'])
      copyFileSync(join(desktop, 'resources', 'mu', name), join(resources, 'mu', name));
    chmodSync(join(resources, 'mu', 'acp'), 0o755);
    // An installed app has no checkout beside it: the harness comes from MU_ROOT here, from its own copy for a user.
    const launch = join(resources, 'mu', windows ? 'acp.cmd' : 'acp');
    const env = { MU_ROOT: harness.root, MU_NODE: process.execPath };
    if (windows) await acp('packaged resources/mu/acp.cmd', 'cmd.exe', ['/d', '/c', launch], env);
    else await acp('packaged resources/mu/acp', launch, [], env);
  }

  // 5. The permission round trip, through the registration's command.
  if (permission) {
    if (windows) await permissionRoundTrip('permission via acp.cmd', 'cmd.exe', ['/d', '/c', join(scripts, 'acp.cmd')]);
    else await permissionRoundTrip('permission via acp', join(scripts, 'acp'), []);
  }
} finally {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
