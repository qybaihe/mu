/**
 * The skills and MCP servers mu itself uses, as the settings pages show them while mu runs inside the app. They are
 * read from mu's own files and from the tools mu takes them over from, by the rules of the harness (pi's skill and
 * `mcp.json` loading, mu's inheritance from Claude Code, Cursor and Codex: `packages/coding-agent/src/core/skills.ts`,
 * `packages/coding-agent/src/extensions/mcp/config.ts` and `packages/kyrn-judge/src/inherit/` in the KYRN
 * repository), copied rather than imported: the two repositories are separate. The main process reads and writes them
 * (process/agent/kyrn/capabilities/); nothing here starts a server.
 *
 * Only what applies everywhere is listed: a project's own skills and servers are loaded in that project's
 * conversations, once mu trusts the project, which is decided when a session starts.
 */

/**
 * Where a skill comes from. `mu`: mu's skills folder (`<agentDir>/skills`), the one the app adds to. `agents`: the
 * folder several agents share (`~/.agents/skills`). `builtin`: a skill that comes with mu. `claude`, `codex`: taken
 * over from that tool's skills folder.
 */
export const SKILL_SOURCES = ['mu', 'agents', 'builtin', 'claude', 'codex'] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export type MuSkill = {
  name: string;
  description: string;
  /** The skill's file: its SKILL.md, or a single Markdown file. */
  file: string;
  source: SkillSource;
  /** A skill of its own in mu's skills folder: the app may remove it (to the trash). */
  removable: boolean;
};

export type MuSkills = {
  /** mu's skills folder: where an added skill goes. */
  folder: string;
  /** In the order mu loads them; of two with one name, only the first is loaded and listed. */
  skills: MuSkill[];
};

/**
 * Where an MCP server is defined. `mu`: mu's own configuration, `<agentDir>/mcp.json` (what `mu mcp add` writes) or
 * the `mcp.servers` of mu.json. `claude`, `cursor`, `codex`: taken over from that tool's settings.
 */
export const MCP_SOURCES = ['mu', 'claude', 'cursor', 'codex'] as const;
export type McpSource = (typeof MCP_SOURCES)[number];

/**
 * Why a server cannot be switched on here: `offInSource`, it is switched off in the other tool's own file, which mu
 * never writes; `unsupported`, it speaks the old HTTP+SSE transport, which mu does not.
 */
export type McpLock = 'offInSource' | 'unsupported';

export type MuMcpServer = {
  name: string;
  source: McpSource;
  /** The file that defines it. */
  file: string;
  transport: 'stdio' | 'http';
  /**
   * What it runs or connects to: the command line, or the address without its query. The values of its variables and
   * headers are never read out: they may be secrets.
   */
  target: string;
  /** Whether mu uses it. */
  on: boolean;
  lock?: McpLock;
  /** Defined in mu's own configuration: the app may remove it. A server taken over can only be switched off. */
  removable: boolean;
};

export type MuMcpServers = {
  /** mu's `mcp.json`: where an added server goes. */
  file: string;
  servers: MuMcpServer[];
  /**
   * Whether mu takes servers over and uses those of mu.json (its MCP feature): when it is off in mu.json, only the
   * servers of `mcp.json` connect, and only those are listed.
   */
  feature: boolean;
  /** Files that exist but could not be read: their servers are missing from the list. */
  unreadable: string[];
};

/** A server to add: a command mu starts, or the address of one that runs elsewhere. */
export type McpServerInput =
  | { name: string; command: string; args: string[]; env: Record<string, string> }
  | { name: string; url: string; headers: Record<string, string> };

/** A server's name, as pi takes it: letters, digits, `_` and `-`. */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A skill's name as the Agent Skills rules have it, which is what may become a folder name: lowercase letters, digits
 * and single hyphens, at most 64 characters, no hyphen at either end.
 */
export const isSkillName = (name: string): boolean => name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
