import type { Assistant } from '../../../common/types/agent/assistantTypes';
import { KyrnError } from '../../../common/kyrn/errors';
import type { KyrnCatalog } from '../../../common/kyrn/types';

/**
 * The fields of a backend agent record this module reads. An update has to send all of them back.
 * The agent list never carries `env`; only a whole record (see `wholeRecord`) does.
 */
type AgentRow = {
  id: string;
  name: string;
  command?: string;
  enabled: boolean;
  status?: string;
  icon?: string;
  description?: string;
  args?: string[];
  env?: unknown[];
  native_skills_dirs?: string[];
  behavior_policy?: unknown;
  yolo_id?: string;
  /** Only on a whole record, and always there: the agent list has `installed` instead. */
  available?: boolean;
};
export type BackendRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export const AGENT_NAME = 'mu';
/** What the registration was called before the rename. Found under these names too, and then renamed. */
const FORMER_NAMES = ['KYRN'];
export const AGENT_DESCRIPTION = 'mu harness · local Codex login · Jev judgment';
/**
 * The descriptions mu has written, compared case-insensitively: a record written before the judge's name took
 * its present capitalization is still ours to update.
 */
const OWN_DESCRIPTIONS = new Set(
  ['KYRN', 'KYRN harness · local Codex login · Jev judgment', AGENT_DESCRIPTION].map((text) => text.toLowerCase())
);
/**
 * The permission mode of a run nobody watches: a scheduled task, a team's agents. AionCore gives them its "full auto",
 * which it reads from the registration's `yolo_id`; nobody could answer a question there, so mu runs with full access.
 */
export const FULL_AUTO_MODE = 'full';
/** AionUi's own words for full auto. mu has no such mode: a registration saying one of them is set to mu's. */
const LEGACY_FULL_AUTO = new Set(['yolo', 'yoloNoSandbox']);
const needsFullAuto = (row: AgentRow): boolean => !row.yolo_id?.trim() || LEGACY_FULL_AUTO.has(row.yolo_id.trim());

/**
 * mu's command as the backend may hold it: `command`, the one this start registers, and `sameFile`, whether a command
 * a registration holds runs the same launcher by another spelling. On Windows a launcher has several (any case, its 8.3
 * short path, the forwarder written for it: windows/launcherCommand.ts); a plain string is only itself.
 */
export type OwnCommand = { command: string; sameFile: (registered: string) => boolean };

const ownCommand = (own: string | OwnCommand): OwnCommand =>
  typeof own === 'string' ? { command: own, sameFile: (registered) => registered === own } : own;

/**
 * The registration is the row that runs our adapter command. Its display name is a label that has changed
 * once already: looking it up by name would register a second agent after a rename and leave every old
 * conversation on the first one. `scripts/kyrn/register.mjs` follows the same rules.
 *
 * A row under our name that runs our launcher by another spelling is ours too: an earlier start may have registered
 * another one (the path with a space, which AionCore cannot start; the short path; a forwarder), and `initializeKyrn`
 * gives it this start's. A row under our name that runs another file stays another mu's: it is never taken over.
 */
export function findRegistration(agents: AgentRow[], own: string | OwnCommand): AgentRow | undefined {
  const { command, sameFile } = ownCommand(own);
  const ours = agents.find((row) => row.command === command);
  if (ours) return ours;
  const namesakes = agents.filter((row) => [AGENT_NAME, ...FORMER_NAMES].includes(row.name));
  const respelled = namesakes.find((row) => row.command !== undefined && sameFile(row.command));
  if (respelled) return respelled;
  if (namesakes.length > 0) throw new KyrnError('otherRegistration', 'A different mu command is already registered');
  return undefined;
}

/**
 * The agent list does not return `env`, and no route reads a single record. Setting `enabled` to the value it
 * already has changes nothing and answers with the whole record, so that is how one is read.
 *
 * An empty list is left out of the JSON, so in a whole record a missing `env` means there are none, while in
 * the agent list it means nothing at all. `available` tells the two apart. Checked against the bundled
 * AionCore v0.2.2; a backend that answers with anything else gives `undefined` here.
 */
async function wholeRecord(request: BackendRequest, row: AgentRow): Promise<AgentRow | undefined> {
  const path = `/api/agents/${encodeURIComponent(row.id)}/enabled`;
  const record = await request<AgentRow | undefined>('PATCH', path, { enabled: row.enabled });
  return record && record.id === row.id && typeof record.available === 'boolean' ? record : undefined;
}

/**
 * The backend's update replaces the whole record: anything left out is cleared. So the record goes back as
 * it is, with the name ours, the description too when it is still one of ours, and full auto set to mu's full
 * access unless someone chose one of mu's modes for it.
 */
export function updated(row: AgentRow, command: string): Record<string, unknown> {
  const description =
    row.description === undefined ||
    (typeof row.description === 'string' && OWN_DESCRIPTIONS.has(row.description.toLowerCase()));
  return {
    name: AGENT_NAME,
    command,
    icon: row.icon,
    args: row.args ?? [],
    env: row.env ?? [],
    advanced: {
      yolo_id: needsFullAuto(row) ? FULL_AUTO_MODE : row.yolo_id,
      native_skills_dirs: row.native_skills_dirs,
      behavior_policy: row.behavior_policy,
      description: description ? AGENT_DESCRIPTION : row.description,
    },
  };
}

async function update(request: BackendRequest, before: AgentRow, command: string): Promise<AgentRow> {
  const record = await wholeRecord(request, before);
  // Without the variables in hand the update would clear them. Keeping an old label costs less than that.
  if (!record) return before;
  const path = `/api/agents/custom/${encodeURIComponent(before.id)}`;
  const saved = await request<AgentRow>('PUT', path, updated(record, command));
  return { ...before, ...saved, id: before.id };
}

/** Make mu the only enabled runtime, in the backend catalog as well as the picker. */
export async function initializeKyrn(request: BackendRequest, own: string | OwnCommand): Promise<KyrnCatalog> {
  const { command } = ownCommand(own);
  const agents = await request<AgentRow[]>('GET', '/api/agents/management');
  let agent = findRegistration(agents, own);
  if (agent && (agent.command !== command || agent.name !== AGENT_NAME || needsFullAuto(agent))) {
    const before = agent;
    // A label or the mode of scheduled runs must not keep the app from starting: the registration works without
    // them, and the next start tries again. The backend probes the agent before it saves, so a refusal is possible.
    // An older spelling of the command is kept the same way: the health check below then says whether it runs.
    agent = await update(request, before, command).catch(() => before);
  }
  agent ??= await request<AgentRow>('POST', '/api/agents/custom', {
    name: AGENT_NAME,
    command,
    args: [],
    env: [],
    advanced: { description: AGENT_DESCRIPTION, yolo_id: FULL_AUTO_MODE },
  });
  // This is a backend state change, not CSS hiding of other runtimes.
  await Promise.all(
    agents
      .filter((row) => row.id !== agent.id && row.enabled)
      .map((row) => request('PATCH', `/api/agents/${encodeURIComponent(row.id)}/enabled`, { enabled: false }))
  );
  if (!agent.enabled) await request('PATCH', `/api/agents/${encodeURIComponent(agent.id)}/enabled`, { enabled: true });
  const assistants = await request<Assistant[]>('GET', '/api/assistants');
  await Promise.all(
    assistants
      .filter((row) => row.agent_id !== agent.id && row.enabled)
      .map((row) => request('PATCH', `/api/assistants/${encodeURIComponent(row.id)}/state`, { enabled: false }))
  );
  await Promise.all(
    assistants
      .filter((a) => a.agent_id === agent.id && !a.enabled)
      .map((row) => request('PATCH', `/api/assistants/${encodeURIComponent(row.id)}/state`, { enabled: true }))
  );
  const checked = await request<AgentRow>('POST', `/api/agents/${encodeURIComponent(agent.id)}/health-check`, {});
  if (checked.status !== 'online')
    throw new KyrnError('runtimeOffline', 'mu runtime is not online. Check the local launcher and login.');
  const ready = await request<Assistant[]>('GET', '/api/assistants');
  return { agentId: agent.id, assistants: ready.filter((row) => row.agent_id === agent.id && row.enabled) };
}

/**
 * Has the backend check mu again. The check starts mu and keeps what it offers (its models, modes and commands) in
 * the registration's record, where the model pickers and the / menu read it. The start checks once, so a model set up
 * since then was missing there until the app started again. Without a registration there is nothing to check.
 */
export async function recheckKyrn(request: BackendRequest, own: string | OwnCommand): Promise<void> {
  const agent = findRegistration(await request<AgentRow[]>('GET', '/api/agents/management'), own);
  if (agent) await request('POST', `/api/agents/${encodeURIComponent(agent.id)}/health-check`, {});
}
