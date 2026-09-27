import { fileURLToPath } from 'node:url';

// Use the same public API as AionUi's Add Custom Agent form; never edit its database.
// The lookup and update rules are the ones in packages/desktop/src/process/agent/kyrn/product.ts.
if (!process.env.AIONUI_BACKEND_URL) throw new Error('Set AIONUI_BACKEND_URL to the running local backend URL');
const base = new URL(process.env.AIONUI_BACKEND_URL);
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
  throw new Error('Registration requires the local AionUi backend URL');
}
const NAME = 'mu';
const FORMER_NAMES = ['KYRN'];
const DESCRIPTION = 'mu harness · local Codex login · Jev judgment';
// Compared case-insensitively: a record written before the judge's name took its present capitalization is ours.
const OWN_DESCRIPTIONS = ['KYRN', 'KYRN harness · local Codex login · Jev judgment', DESCRIPTION].map((text) =>
  text.toLowerCase()
);
// Scheduled tasks and team agents run in AionCore's "full auto", read from `yolo_id`: mu's full access.
const FULL_AUTO_MODE = 'full';
const LEGACY_FULL_AUTO = ['yolo', 'yoloNoSandbox'];
const needsFullAuto = (row) => !row.yolo_id?.trim() || LEGACY_FULL_AUTO.includes(row.yolo_id.trim());
// The launcher the registration runs: the bash `acp`, on Windows acp.cmd. On Windows a path with a space is registered
// by another spelling, as the app does it (packages/desktop/src/process/agent/kyrn/windows/launcherCommand.ts, loaded
// through Node's own type stripping: Node 22.18 or newer, which a Windows checkout needs anyway).
const launcher = fileURLToPath(new URL(process.platform === 'win32' ? './acp.cmd' : './acp', import.meta.url));
const { command, sameFile } =
  process.platform === 'win32'
    ? await (
        await import('../../packages/desktop/src/process/agent/kyrn/windows/launcherCommand.ts')
      ).ownLauncher(launcher)
    : { command: launcher, sameFile: (registered) => registered === launcher };
async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`AionUi ${path}: HTTP ${response.status}`);
  const result = await response.json();
  if (result.success === false) throw new Error('AionUi rejected registration');
  return result.data ?? result;
}
// The agent list does not return `env`, and no route reads a single record. Setting `enabled` to the value it
// already has changes nothing and answers with the whole record. There an empty list is left out of the JSON,
// so a missing `env` means none; `available` is what only a whole record has.
async function wholeRecord(row) {
  const record = await request(`/api/agents/${encodeURIComponent(row.id)}/enabled`, { enabled: row.enabled }, 'PATCH');
  return record && record.id === row.id && typeof record.available === 'boolean' ? record : undefined;
}
async function update(before) {
  const record = await wholeRecord(before);
  // Without the variables in hand the update would clear them. Keeping an old label costs less than that.
  if (!record) throw new Error('the backend did not hand over the whole record');
  // The update replaces the whole record, so everything already there goes back with it.
  const ours =
    record.description === undefined ||
    (typeof record.description === 'string' && OWN_DESCRIPTIONS.includes(record.description.toLowerCase()));
  const updated = await request(
    `/api/agents/custom/${encodeURIComponent(before.id)}`,
    {
      name: NAME,
      command,
      icon: record.icon,
      args: record.args ?? [],
      env: record.env ?? [],
      advanced: {
        yolo_id: needsFullAuto(record) ? FULL_AUTO_MODE : record.yolo_id,
        native_skills_dirs: record.native_skills_dirs,
        behavior_policy: record.behavior_policy,
        description: ours ? DESCRIPTION : record.description,
      },
    },
    'PUT'
  );
  return { ...before, ...updated, id: before.id };
}
const agents = await request('/api/agents/management');
// The adapter command identifies the registration. Its display name is a label that has changed once already. A row
// under our name that runs our launcher by another spelling is ours too, and gets this command.
const namesake = (item) => [NAME, ...FORMER_NAMES].includes(item.name);
let agent =
  agents.find((item) => item.command === command) ??
  agents.find((item) => namesake(item) && typeof item.command === 'string' && sameFile(item.command));
if (!agent && agents.some(namesake))
  throw new Error('A different mu registration already exists; inspect it in Settings');
if (agent && (agent.command !== command || agent.name !== NAME || needsFullAuto(agent))) {
  const before = agent;
  agent = await update(before).catch((error) => {
    console.error(`Kept the registration as it was ("${before.name}"): ${error.message}`);
    return before;
  });
}
agent ??= await request('/api/agents/custom', {
  name: NAME,
  command,
  args: [],
  env: [],
  advanced: { description: DESCRIPTION, yolo_id: FULL_AUTO_MODE },
});
const checked = await request(`/api/agents/${encodeURIComponent(agent.id)}/health-check`, {});
console.log(
  JSON.stringify({ id: agent.id, name: agent.name, status: checked.status, errorCode: checked.last_check_error_code })
);
