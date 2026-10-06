import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  MCP_SERVER_NAME,
  type McpLock,
  type McpServerInput,
  type McpSource,
  type MuMcpServer,
  type MuMcpServers,
} from '../../../../common/kyrn/capabilities';
import { KyrnError } from '../../../../common/kyrn/errors';
import { maskSecrets } from '../../../services/nativeHost/sessions/summary';
import { atomic, parseObject, readOptional, serialise } from '../config/files';
import { asRecord, type JsonRecord } from '../piRpc';
import { INHERIT_DEFAULTS, featureOptions, readMuConfig, readName, readSmall } from './files';

/*
 * The MCP servers mu uses in every conversation, where each is defined, and the changes the settings page makes. pi
 * connects the servers of its `mcp.json` (what `mu mcp add` writes); mu's MCP feature adds those of mu.json and those
 * it takes over from the other tools, the first definition of a name winning, and any of them yields to a server of
 * the same name in `mcp.json`:
 *
 *   <agentDir>/mcp.json         `mcpServers`, pi's own: `"enabled": false` keeps one without connecting it
 *   <agentDir>/mu.json          `mcp.servers`: definitions, and switches for servers taken over (`{ "enabled": false }`)
 *   ~/.claude.json              `mcpServers`, Claude Code's servers for every project
 *   ~/.cursor/mcp.json          `mcpServers`
 *   ~/.codex/config.toml        `[mcp_servers.<name>]`
 *
 * The rules are pi's (`extensions/mcp/config.ts`) and mu's (`inherit/mcp-config.ts`, `extension/features/mcp.ts`).
 * A project's servers (`.mu/mcp.json`, `.mcp.json`, `.cursor/mcp.json`, Claude Code's per-project ones) are not read:
 * they depend on the project and on mu's trust in it. Nothing here connects to a server or starts one, and no value of
 * a variable or a header leaves this file.
 */

export type McpRoots = {
  agentDir: string;
  /** The person's home: `.claude.json`, `.cursor` and `.codex` are looked for there. */
  home: string;
};

/** Claude Code keeps every project's history in its file, which can grow large; mu reads up to this much of it. */
const CLAUDE_FILE_BYTES = 32 * 1024 * 1024;

/** pi's `mcp.json`, where an added server goes. */
export const mcpFile = (roots: Pick<McpRoots, 'agentDir'>): string => join(roots.agentDir, 'mcp.json');

/** The namespace of a server's tools, `-` and `_` alike: two names with one namespace clash in pi. */
const namespace = (name: string): string => name.replace(/-/g, '_').toLowerCase();

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const words = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** An argument that names a secret: `--api-key`, `--token`, `-password`… its value is the next argument. */
const SECRET_FLAG = /^--?[\w-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|credential)[\w-]*$/i;
/** `--api-key=…`, `GITHUB_TOKEN=…`: the value after the `=`. */
const SECRET_ASSIGNED = /^(-{0,2}[\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|credential)[\w.-]*=).+$/i;
/** The password of an address with one in it: `postgres://user:pass@host`. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s]+@/gi;

/**
 * A command line as the list shows it: a key handed over as an argument is masked as titles mask one (`sk-••••`),
 * so the page can sit in a screenshot. Variables are not shown at all.
 */
function maskedCommand(command: string, args: string[]): string {
  const shown = args.map((arg, index) => {
    if (index > 0 && SECRET_FLAG.test(args[index - 1]) && !arg.startsWith('-')) return '••••';
    return arg.replace(SECRET_ASSIGNED, '$1••••');
  });
  return maskSecrets([command, ...shown].join(' ').replace(URL_PASSWORD, '$1••••@'));
}

/** What a server runs or connects to, as the list shows it: never its variables or headers, nor an address's query. */
function targetOf(raw: JsonRecord, transport: 'stdio' | 'http'): string {
  if (transport === 'stdio') {
    const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : [];
    return maskedCommand(words(raw.command), args);
  }
  const url = words(raw.url);
  if (!URL.canParse(url)) return url.split(/[?#]/)[0];
  const { protocol, host, pathname } = new URL(url);
  return `${protocol}//${host}${pathname}`;
}

type Definition = { transport: 'stdio' | 'http'; lock?: McpLock; off: boolean };

/**
 * A definition in any of the spellings mu reads (`normalizeServer`): a command, or an address that is not the old SSE
 * transport. Undefined when it has neither.
 */
function definitionOf(raw: unknown): Definition | undefined {
  if (!isRecord(raw)) return undefined;
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
  const off = raw.enabled === false || raw.disabled === true;
  if (words(raw.url))
    return type === 'sse' ? { transport: 'http', lock: 'unsupported', off: true } : { transport: 'http', off };
  if (words(raw.command)) return type && type !== 'stdio' ? undefined : { transport: 'stdio', off };
  return undefined;
}

/** pi's servers: its `mcpServers`, each named as pi allows and with a command or an http(s) address. */
function piServers(file: string, unreadable: string[]): MuMcpServer[] {
  const content = readSmall(file);
  if (content === undefined) {
    if (existsSync(file)) unreadable.push(file);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    unreadable.push(file);
    return [];
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    unreadable.push(file);
    return [];
  }
  const servers: MuMcpServer[] = [];
  const taken = new Set<string>();
  for (const [name, raw] of Object.entries(asRecord(parsed.mcpServers))) {
    if (!MCP_SERVER_NAME.test(name) || !isRecord(raw) || taken.has(namespace(name))) continue;
    const url = words(raw.url);
    const transport = url ? 'http' : words(raw.command) ? 'stdio' : undefined;
    if (!transport || raw.type === 'sse' || (url && !/^https?:\/\//i.test(url))) continue;
    taken.add(namespace(name));
    servers.push({
      name,
      source: 'mu',
      file,
      transport,
      target: targetOf(raw, transport),
      on: raw.enabled !== false,
      removable: true,
    });
  }
  return servers;
}

/** The `mcpServers` of a JSON file, or nothing (and the file noted) when it cannot be read. */
function jsonServers(file: string, unreadable: string[], maxBytes?: number): unknown {
  const content = readSmall(file, maxBytes);
  if (content === undefined) {
    if (existsSync(file)) unreadable.push(file);
    return undefined;
  }
  try {
    return asRecord(JSON.parse(content)).mcpServers;
  } catch {
    unreadable.push(file);
    return undefined;
  }
}

/** Codex's `[mcp_servers.<name>]` tables. */
function codexServers(file: string, unreadable: string[]): unknown {
  const content = readSmall(file);
  if (content === undefined) {
    if (existsSync(file)) unreadable.push(file);
    return undefined;
  }
  try {
    return parseToml(content).mcp_servers;
  } catch {
    unreadable.push(file);
    return undefined;
  }
}

export function listMcpServers(roots: McpRoots): MuMcpServers {
  const file = mcpFile(roots);
  const unreadable: string[] = [];
  const own = piServers(file, unreadable);
  const muConfig = readMuConfig(roots.agentDir);
  if (muConfig.broken) unreadable.push(muConfig.file);
  const { config } = muConfig;
  const feature = Boolean(featureOptions(config, 'mcp', { enabled: true }).enabled);
  if (!feature) return { file, servers: own, feature, unreadable };

  const inherit = featureOptions(config, 'inherit', INHERIT_DEFAULTS);
  const takesOver = Boolean(inherit.enabled) && Boolean(inherit.mcp);
  const claudeFile = join(roots.home, '.claude.json');
  const cursorFile = join(roots.home, '.cursor', 'mcp.json');
  const codexFile = join(roots.home, '.codex', 'config.toml');
  const sources: Array<{ source: McpSource; file: string; entries: () => unknown }> = [
    { source: 'mu', file: muConfig.file, entries: () => asRecord(config.mcp).servers },
    ...(takesOver && inherit.claude
      ? [
          {
            source: 'claude' as const,
            file: claudeFile,
            entries: () => jsonServers(claudeFile, unreadable, CLAUDE_FILE_BYTES),
          },
        ]
      : []),
    ...(takesOver && inherit.cursor
      ? [{ source: 'cursor' as const, file: cursorFile, entries: () => jsonServers(cursorFile, unreadable) }]
      : []),
    ...(takesOver && inherit.codex
      ? [{ source: 'codex' as const, file: codexFile, entries: () => codexServers(codexFile, unreadable) }]
      : []),
  ];

  // The first usable definition of a name wins; one switched off in its own file leaves the name to the next, and is
  // listed only when no other takes it.
  const used = new Map<string, MuMcpServer>();
  const off: MuMcpServer[] = [];
  const switches = new Map<string, JsonRecord>();
  for (const { source, file: where, entries } of sources) {
    const found = entries();
    if (!isRecord(found)) continue;
    for (const [name, raw] of Object.entries(found)) {
      // In mu.json, an entry with neither a command nor an address switches a server taken over.
      if (source === 'mu' && isRecord(raw) && typeof raw.command !== 'string' && typeof raw.url !== 'string') {
        switches.set(name, raw);
        continue;
      }
      if (used.has(name)) continue;
      const definition = definitionOf(raw);
      if (!definition || !isRecord(raw)) continue;
      // Switched off in mu.json, mu's own file, a server keeps its switch here; in another tool's file, it is locked.
      const lock = definition.lock ?? (definition.off && source !== 'mu' ? 'offInSource' : undefined);
      const server: MuMcpServer = {
        name,
        source,
        file: where,
        transport: definition.transport,
        target: targetOf(raw, definition.transport),
        on: !definition.off,
        ...(lock ? { lock } : {}),
        removable: source === 'mu',
      };
      if (definition.off) off.push(server);
      else used.set(name, server);
    }
  }

  const piNames = new Set(own.map((server) => namespace(server.name)));
  const listed = new Set<string>();
  const servers = [...own];
  for (const server of [...used.values(), ...off]) {
    if (piNames.has(namespace(server.name)) || listed.has(server.name)) continue;
    listed.add(server.name);
    const switchedOff = server.source !== 'mu' && switches.get(server.name)?.enabled === false;
    servers.push(switchedOff ? { ...server, on: false } : server);
  }
  return { file, servers, feature, unreadable };
}

/** The server of that name as the list has it, or the failure that says there is none. */
function find(roots: McpRoots, name: string): MuMcpServer {
  const server = listMcpServers(roots).servers.find((each) => each.name === name);
  if (!server) throw new KyrnError('notFound', `No MCP server named ${name}`, { name });
  return server;
}

/** Reads a JSON file of mu's own configuration, changes it and writes it back with its indentation. */
function edit(file: string, change: (document: JsonRecord) => void): void {
  const raw = readOptional(file);
  const document = parseObject(raw, file);
  change(document);
  atomic(file, serialise(document, raw));
}

/** The `mcpServers` object of pi's file, made when missing; a file of another shape is not touched. */
function piEntries(document: JsonRecord, file: string): JsonRecord {
  if (document.mcpServers === undefined) document.mcpServers = {};
  if (!isRecord(document.mcpServers))
    throw new KyrnError('invalidJson', `${file}: expected an object with an "mcpServers" object`, { file });
  return document.mcpServers;
}

/** mu.json's `mcp.servers`, made when missing. */
function muEntries(document: JsonRecord): JsonRecord {
  if (!isRecord(document.mcp)) document.mcp = {};
  const mcp = document.mcp as JsonRecord;
  if (!isRecord(mcp.servers)) mcp.servers = {};
  return mcp.servers as JsonRecord;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
const oneLine = (value: unknown, longest = 4096): value is string =>
  typeof value === 'string' && value.length <= longest && !value.includes('\u0000') && !/[\r\n]/.test(value);

/** A map of names to values as the screen sends it, each name matching `pattern`. */
function readPairs(value: unknown, pattern: RegExp, field: string): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > 100)
    throw new KyrnError('mcpInvalid', `Invalid ${field}`, { field });
  const pairs: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!pattern.test(key) || !oneLine(entry)) throw new KyrnError('mcpInvalid', `Invalid ${field}`, { field });
    pairs[key] = entry;
  }
  return pairs;
}

/**
 * The definition `mu mcp add` writes for a server: its command, arguments and variables, or its address and headers,
 * then `"exposure": "deferred"`, the exposure mu gives every server it adds (`mcpAddDefaults` of mu's launcher).
 */
function definitionFor(input: McpServerInput): JsonRecord {
  if ('url' in input) {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!oneLine(url) || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol))
      throw new KyrnError('mcpInvalid', 'The address must be an http or https URL', { field: 'url' });
    const headers = readPairs(input.headers ?? {}, HEADER_NAME, 'headers');
    return { url, ...(Object.keys(headers).length ? { headers } : {}), exposure: 'deferred' };
  }
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command || !oneLine(command)) throw new KyrnError('mcpInvalid', 'A command is needed', { field: 'command' });
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 200 || !args.every((arg) => oneLine(arg)))
    throw new KyrnError('mcpInvalid', 'Invalid arguments', { field: 'args' });
  const env = readPairs(input.env ?? {}, ENV_NAME, 'env');
  return {
    command,
    ...(args.length ? { args } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    exposure: 'deferred',
  };
}

/**
 * Adds a server to pi's `mcp.json`, as `mu mcp add` would. A name that one of mu's own servers already has (or one
 * that differs from it only in `-` and `_`) is refused; one taken over is not: the new server is used instead.
 */
export function addMcpServer(roots: McpRoots, input: McpServerInput): MuMcpServers {
  const name = readName(isRecord(input) ? input.name : undefined);
  if (!MCP_SERVER_NAME.test(name)) throw new KyrnError('mcpName', `"${name}" cannot name an MCP server`, { name });
  const definition = definitionFor(input);
  const clash = listMcpServers(roots).servers.find(
    (server) => server.source === 'mu' && namespace(server.name) === namespace(name)
  );
  if (clash) throw new KyrnError('mcpExists', `mu already has an MCP server named ${clash.name}`, { name: clash.name });
  const file = mcpFile(roots);
  edit(file, (document) => {
    const entries = piEntries(document, file);
    // Kept in the file though not listed (pi refuses its name, or it has neither command nor address): not replaced.
    if (Object.keys(entries).some((each) => namespace(each) === namespace(name)))
      throw new KyrnError('mcpExists', `${file} already names a server ${name}`, { name });
    entries[name] = definition;
  });
  return listMcpServers(roots);
}

/** Removes one of mu's own servers from the file that defines it. A server taken over can only be switched off. */
export function removeMcpServer(roots: McpRoots, name: unknown): MuMcpServers {
  const server = find(roots, readName(name));
  if (server.source !== 'mu')
    throw new KyrnError('notMine', `${server.name} is defined in ${server.file}`, {
      name: server.name,
      source: server.source,
    });
  edit(server.file, (document) => {
    delete (server.file === mcpFile(roots) ? piEntries(document, server.file) : muEntries(document))[server.name];
  });
  return listMcpServers(roots);
}

/**
 * Switches a server on or off in mu's own configuration: pi's servers by their `enabled`, those of mu.json by theirs,
 * and a server taken over by a switch of its name in mu.json; the other tool's file is never written. On is the
 * default, so switching on takes the switch away.
 */
export function switchMcpServer(roots: McpRoots, name: unknown, on: unknown): MuMcpServers {
  if (typeof on !== 'boolean') throw new KyrnError('invalid', 'Invalid switch');
  const server = find(roots, readName(name));
  if (server.lock) throw new KyrnError('invalid', `${server.name} cannot be switched here`);
  const file = server.source === 'mu' ? server.file : readMuConfig(roots.agentDir).file;
  edit(file, (document) => {
    if (server.source === 'mu' && file === mcpFile(roots)) {
      const entry = asRecord(piEntries(document, file)[server.name]);
      if (on) delete entry.enabled;
      else entry.enabled = false;
      return;
    }
    const entries = muEntries(document);
    if (server.source === 'mu') {
      const entry = asRecord(entries[server.name]);
      delete entry.disabled;
      if (on) delete entry.enabled;
      else entry.enabled = false;
      return;
    }
    const current = entries[server.name];
    if (isRecord(current) && (typeof current.command === 'string' || typeof current.url === 'string'))
      throw new KyrnError('invalid', `${file} defines a server named ${server.name}`);
    const entry = isRecord(current) ? current : {};
    if (on) delete entry.enabled;
    else entry.enabled = false;
    if (Object.keys(entry).length) entries[server.name] = entry;
    else delete entries[server.name];
  });
  return listMcpServers(roots);
}
