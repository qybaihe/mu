// Checks the registration rules (product.ts and register.mjs) against a real backend, not a mock.
//
// Why it exists: the rules lean on what the backend actually answers. Its agent list leaves a record's
// variables out, its update replaces the whole record, and setting `enabled` answers with the whole record.
// None of that is a documented contract, so run this again after every backend upgrade:
//
//   node scripts/kyrn/registration-check/check.mjs        (Node 24)
//
// Everything it touches is its own: a throw-away HOME, data, work and log directory, and its own port.
// It never talks to a running app and never reads or writes the real home.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '../../..');
const harness = process.env.KYRN_ROOT || join(dirname(desktop), 'KYRN');
const backendBin =
  process.env.MU_BACKEND_BIN || join(desktop, `resources/bundled-backend/${process.platform}-${process.arch}/aioncore`);
const command = join(desktop, 'scripts/kyrn/acp');
const nodeDir = dirname(process.execPath);
const port = Number(process.env.CHECK_PORT || 25931);
const scratch = mkdtempSync(join(tmpdir(), 'mu-registration-check-'));
const realHomeBefore = existsSync(join(homedir(), '.mu'));
const base = `http://127.0.0.1:${port}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

async function api(method, path, body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const textBody = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(textBody);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${textBody.slice(0, 300)}`);
  if (parsed && parsed.success === false) throw new Error(`${method} ${path}: rejected ${textBody.slice(0, 300)}`);
  return parsed?.data ?? parsed;
}

function startBackend(name) {
  const root = join(scratch, name);
  for (const dir of ['home', 'data', 'work', 'logs']) mkdirSync(join(root, dir), { recursive: true });
  const child = spawn(
    backendBin,
    [
      '--port',
      String(port),
      '--data-dir',
      join(root, 'data'),
      '--work-dir',
      join(root, 'work'),
      '--log-dir',
      join(root, 'logs'),
      '--log-level',
      'info',
      '--parent-pid',
      String(process.pid),
      '--local',
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
      // No real home, no developer variables, no other agent CLIs on the path.
      env: {
        HOME: join(root, 'home'),
        PATH: `${nodeDir}:/usr/bin:/bin`,
        KYRN_ROOT: harness,
        AIONUI_WORK_DIR: join(root, 'work'),
        AIONUI_LOG_DIR: join(root, 'logs'),
        AIONUI_CACHE_DIR: join(root, 'cache'),
      },
    }
  );
  return { child, root };
}

async function ready() {
  for (let i = 0; i < 120; i++) {
    try {
      await api('GET', '/api/agents/management');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      r();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(t);
      r();
    });
  });
}

const ours = (agents) => agents.filter((row) => row.command === command);
const named = (agents) => agents.filter((row) => ['mu', 'KYRN'].includes(row.name));

function runRegister() {
  const out = spawnSync(process.execPath, [join(desktop, 'scripts/kyrn/register.mjs')], {
    encoding: 'utf8',
    env: { PATH: `${nodeDir}:/usr/bin:/bin`, HOME: join(scratch, 'unused-home'), MU_BACKEND_URL: base },
    timeout: 180000,
  });
  return { code: out.status, stdout: out.stdout.trim(), stderr: out.stderr.trim() };
}

function runInitialize() {
  // The app's own startup code, run as it is through tsx, against this backend.
  const out = spawnSync(
    process.execPath,
    [join(desktop, 'node_modules/tsx/dist/cli.mjs'), join(here, 'initialize.mts')],
    {
      encoding: 'utf8',
      env: {
        PATH: `${nodeDir}:/usr/bin:/bin`,
        HOME: join(scratch, 'unused-home'),
        CHECK_BASE: base,
        CHECK_COMMAND: command,
      },
      timeout: 180000,
    }
  );
  return { code: out.status, stdout: out.stdout.trim(), stderr: out.stderr.trim() };
}

let backend;
try {
  backend = startBackend('run-1');
  check('isolated backend answers on its own port', await ready());

  const before = await api('GET', '/api/agents/management');
  check(
    'a fresh backend has no registration of ours',
    ours(before).length === 0 && named(before).length === 0,
    `${before.length} built-in rows`
  );
  const enabledBefore = before.filter((row) => row.enabled).length;

  // 1. Fresh machine: the app's startup registers exactly once, as mu.
  let init = runInitialize();
  let catalog = init.code === 0 ? JSON.parse(init.stdout.split('\n').pop()) : undefined;
  check(
    'fresh start: initializeKyrn succeeds and the runtime is online',
    init.code === 0,
    init.code === 0 ? '' : init.stderr.slice(-400)
  );
  let agents = await api('GET', '/api/agents/management');
  check(
    'fresh start: exactly one registration, named mu',
    ours(agents).length === 1 && ours(agents)[0].name === 'mu' && named(agents).length === 1
  );
  const id = ours(agents)[0]?.id;
  check(
    'fresh start: the catalog points at that registration',
    id !== undefined && catalog?.agentId === id,
    `assistants: ${catalog?.assistants?.length}`
  );
  check(
    'fresh start: it is the only enabled runtime',
    agents.filter((row) => row.enabled).length === 1 && ours(agents)[0].enabled === true,
    `enabled before: ${enabledBefore}`
  );

  // The agent list leaves `env` out. Setting `enabled` to what it already is answers with the whole record.
  const whole = async (agentId) => {
    const listed = (await api('GET', '/api/agents/management')).find((r) => r.id === agentId);
    return api('PATCH', `/api/agents/${agentId}/enabled`, { enabled: listed.enabled });
  };
  const userSet = {
    icon: '🧭',
    args: [],
    env: [{ name: 'LIVE_MARKER', value: 'kept', description: 'why it is here' }],
  };
  const userAdvanced = {
    yolo_id: 'yolo',
    native_skills_dirs: ['/tmp/skills-x'],
    behavior_policy: { supports_side_question: true },
  };
  const kept = (record) =>
    record.icon === '🧭' &&
    JSON.stringify(record.env) === JSON.stringify(userSet.env) &&
    record.yolo_id === 'yolo' &&
    JSON.stringify(record.native_skills_dirs) === JSON.stringify(['/tmp/skills-x']) &&
    record.behavior_policy?.supports_side_question === true;
  const show = (record) =>
    JSON.stringify({
      name: record.name,
      icon: record.icon,
      env: record.env,
      yolo_id: record.yolo_id,
      dirs: record.native_skills_dirs,
      side: record.behavior_policy?.supports_side_question,
      enabled: record.enabled,
      description: record.description,
    });

  // 2. Put the registration back the way the old app left it, with things a user may have set.
  await api('PUT', `/api/agents/custom/${id}`, {
    name: 'KYRN',
    command,
    ...userSet,
    advanced: { ...userAdvanced, description: 'KYRN' },
  });
  agents = await api('GET', '/api/agents/management');
  const old = ours(agents)[0];
  check(
    'setup: the registration looks like the pre-rename one, and the list hides its variables',
    old.name === 'KYRN' && old.id === id && old.env === undefined && kept(await whole(id)),
    show(await whole(id))
  );
  const assistantsOld = (await api('GET', '/api/assistants')).filter((row) => row.agent_id === id);

  // 3. scripts/kyrn/register.mjs renames it in place.
  let reg = runRegister();
  let regOut = reg.code === 0 ? JSON.parse(reg.stdout.split('\n').pop()) : undefined;
  check(
    'register.mjs: exits cleanly and reports mu online under the same id',
    reg.code === 0 && regOut?.id === id && regOut?.name === 'mu' && regOut?.status === 'online',
    reg.code === 0 ? reg.stdout : reg.stderr.slice(-400)
  );
  agents = await api('GET', '/api/agents/management');
  check(
    'register.mjs: still one registration, no second agent',
    ours(agents).length === 1 && named(agents).length === 1
  );
  let record = await whole(id);
  check(
    'register.mjs: icon, variables, skills folders, policy and yolo id all came back with it',
    record.name === 'mu' && kept(record) && record.enabled === true,
    show(record)
  );
  check(
    'register.mjs: our own old description is replaced',
    record.description === 'mu harness · local Codex login · Jev judgment',
    String(record.description)
  );
  const assistantsNew = (await api('GET', '/api/assistants')).filter((r) => r.agent_id === id);
  check(
    'register.mjs: the generated assistant keeps its id and follows the name',
    assistantsOld.length === assistantsNew.length &&
      assistantsOld.every((a) => assistantsNew.some((b) => b.id === a.id)),
    `${assistantsOld.map((a) => a.name).join(',')} -> ${assistantsNew.map((a) => a.name).join(',')}`
  );

  // 4. Running it again changes nothing.
  reg = runRegister();
  agents = await api('GET', '/api/agents/management');
  check(
    'register.mjs again: no change',
    reg.code === 0 &&
      ours(agents).length === 1 &&
      ours(agents)[0].name === 'mu' &&
      ours(agents)[0].id === id &&
      kept(await whole(id))
  );

  // 4b. Reading the record must not switch a disabled registration on.
  await api('PUT', `/api/agents/custom/${id}`, {
    name: 'KYRN',
    command,
    ...userSet,
    advanced: { ...userAdvanced, description: 'KYRN' },
  });
  await api('PATCH', `/api/agents/${id}/enabled`, { enabled: false });
  reg = runRegister();
  record = await whole(id);
  check(
    'register.mjs: a disabled registration is renamed and stays disabled',
    reg.code === 0 && record.name === 'mu' && record.enabled === false && kept(record),
    show(record)
  );

  // 5. The app's startup path, with a description the user wrote.
  await api('PUT', `/api/agents/custom/${id}`, {
    name: 'KYRN',
    command,
    ...userSet,
    advanced: { ...userAdvanced, description: 'my own words' },
  });
  init = runInitialize();
  catalog = init.code === 0 ? JSON.parse(init.stdout.split('\n').pop()) : undefined;
  agents = await api('GET', '/api/agents/management');
  record = await whole(id);
  check(
    'initializeKyrn: renames in place, switches it on and starts',
    init.code === 0 &&
      catalog?.agentId === id &&
      record.name === 'mu' &&
      record.enabled === true &&
      ours(agents).length === 1 &&
      named(agents).length === 1,
    init.code === 0 ? '' : init.stderr.slice(-400)
  );
  check(
    "initializeKyrn: keeps the user's description and everything else on the record",
    record.description === 'my own words' && kept(record),
    show(record)
  );
  check(
    'initializeKyrn: the catalog has an enabled assistant to talk to',
    (catalog?.assistants?.length ?? 0) >= 1,
    (catalog?.assistants ?? []).map((a) => a.name).join(',')
  );

  // 6. A registration under either name that runs a different command is refused, and nothing is added.
  const wrapper = join(scratch, 'other-acp');
  writeFileSync(wrapper, `#!/bin/bash\nexec "${command}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const countBefore = agents.length;
  const refused = spawnSync(
    process.execPath,
    [join(desktop, 'node_modules/tsx/dist/cli.mjs'), join(here, 'initialize.mts')],
    {
      encoding: 'utf8',
      env: {
        PATH: `${nodeDir}:/usr/bin:/bin`,
        HOME: join(scratch, 'unused-home'),
        CHECK_BASE: base,
        CHECK_COMMAND: wrapper,
      },
      timeout: 180000,
    }
  );
  agents = await api('GET', '/api/agents/management');
  check(
    'a namesake that runs another command is refused, and nothing is registered',
    refused.status !== 0 &&
      /A different mu command is already registered/.test(refused.stderr) &&
      agents.length === countBefore,
    refused.stderr.split('\n').find((l) => l.includes('different')) ?? refused.stderr.slice(-200)
  );

  // Nothing of this run may have landed in the real home.
  check('no ~/.mu was created in the real home', realHomeBefore || !existsSync(join(homedir(), '.mu')));
} catch (error) {
  check('run completed without an unexpected error', false, error instanceof Error ? error.message : String(error));
} finally {
  if (backend) await stop(backend.child);
  rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
