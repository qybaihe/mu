import { asObject, asText, type JsonObject } from './records.ts';

/**
 * What a session file says its session runs with, read the way pi and mu read it when they resume it: for a
 * conversation whose host is not running, so the screen can say which model, thinking level and permission mode the
 * next message will meet without starting a host.
 *
 * - model: the latest `model_change` or assistant message on the branch (pi's `getSessionContextSettings`);
 * - thinking level: the latest `thinking_level_change` on the branch (pi writes one when a session starts);
 * - permission mode: the latest `mu.permissions` entry on the branch (mu's permissions feature, `session_start`).
 *
 * A field the branch does not name is left out: pi then takes its settings' default, mu its start mode. Pure.
 */
export type SessionSettings = {
  /** `provider/id`. */
  model?: string;
  thinkingLevel?: string;
  /** `full`, `jev` or `ask`. */
  permissions?: string;
};

/** The custom entry mu keeps a conversation's permission mode in (PERMISSIONS_ENTRY in the harness). */
export const PERMISSIONS_ENTRY = 'mu.permissions';

/** Permission modes are words (`full`, `jev`, `ask`). */
const MODE_ID = /^[a-z][a-z0-9-]{0,31}$/;

const modelOf = (provider: unknown, id: unknown): string | undefined => {
  const p = asText(provider);
  const m = asText(id);
  return p && m && !(p === 'unknown' && m === 'unknown') ? `${p}/${m}` : undefined;
};

/** The settings of the branch that ends at `leafId` (the last entry when left out, as pi opens a file). */
export function sessionSettings(entries: readonly unknown[], leafId?: string | null): SessionSettings {
  const list = entries.map(asObject).filter((entry) => entry.type !== 'session' && typeof entry.id === 'string');
  const byId = new Map(list.map((entry) => [entry.id as string, entry]));
  const branch: JsonObject[] = [];
  const seen = new Set<string>();
  let current = leafId === null ? undefined : leafId ? byId.get(leafId) : list.at(-1);
  while (current && !seen.has(current.id as string)) {
    seen.add(current.id as string);
    branch.push(current);
    current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined;
  }
  const settings: SessionSettings = {};
  for (const entry of branch.toReversed()) {
    if (entry.type === 'model_change') {
      settings.model = modelOf(entry.provider, entry.modelId) ?? settings.model;
    } else if (entry.type === 'message') {
      const message = asObject(entry.message);
      if (message.role === 'assistant') settings.model = modelOf(message.provider, message.model) ?? settings.model;
    } else if (entry.type === 'thinking_level_change') {
      const level = asText(entry.thinkingLevel);
      if (level) settings.thinkingLevel = level;
    } else if (entry.type === 'custom' && entry.customType === PERMISSIONS_ENTRY) {
      const mode = asText(asObject(entry.data).mode);
      if (MODE_ID.test(mode)) settings.permissions = mode;
    }
  }
  return settings;
}
