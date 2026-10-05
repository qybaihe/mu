import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpServerDefinition } from "../inherit/types.ts";

/**
 * What mu remembers about MCP servers between sessions, in `<agentDir>/mu`:
 *
 * `mcp-cache.json`: each server's tool names and descriptions from the last
 * time it ran. A server is only started when a task needs it, so without this
 * the judge would have nothing but a name to decide by.
 *
 * `mcp-approvals.json`: which project-defined servers the user allowed to
 * start. pi reports a folder as trusted when it simply has nothing pi would
 * have to ask about, so "trusted" alone does not mean anybody agreed to run
 * the commands in a repository's `.mcp.json`. An approval is bound to the
 * exact definition: when the command changes, the question comes back.
 *
 * Neither file ever holds a command line, a variable or a header, only hashes.
 * Without a directory (tests, embedding) everything stays in memory.
 */
export interface CachedTool {
	readonly name: string;
	readonly description: string;
}

export interface CachedServer {
	readonly tools: readonly CachedTool[];
	readonly updatedAt: string;
}

interface CacheFile {
	version: 1;
	servers: Record<string, CachedServer>;
}

interface ApprovalFile {
	version: 1;
	projects: Record<string, Record<string, string>>;
}

const DESCRIPTION_LENGTH = 200;

function sorted(map: Readonly<Record<string, string>>): [string, string][] {
	return Object.entries(map).sort(([left], [right]) => left.localeCompare(right));
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Everything that decides what would run. A change to any of it is a different server. */
export function definitionHash(server: McpServerDefinition): string {
	const transport = server.transport;
	return digest(
		transport.type === "stdio"
			? ["stdio", transport.command, transport.args, sorted(transport.env), transport.cwd ?? ""]
			: ["http", transport.url, sorted(transport.headers)],
	);
}

/** Which server a cache entry is about: its name and what it runs, but not its secrets, so a rotated token keeps the cache. */
function cacheKey(server: McpServerDefinition): string {
	const transport = server.transport;
	const identity = transport.type === "stdio" ? ["stdio", transport.command, transport.args] : ["http", transport.url];
	return `${server.name}#${digest(identity).slice(0, 12)}`;
}

function readJson<T>(path: string | undefined, empty: T): T {
	if (!path) return empty;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null ? ({ ...empty, ...parsed } as T) : empty;
	} catch {
		return empty;
	}
}

function writeJson(path: string | undefined, value: unknown): void {
	if (!path) return;
	try {
		mkdirSync(resolve(path, ".."), { recursive: true });
		// Written whole and moved into place: another session reading at the same moment never sees half a file.
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`);
		renameSync(temporary, path);
	} catch {
		// Remembering is a convenience. A read-only home must not break a session.
	}
}

export class McpStore {
	private readonly cachePath: string | undefined;
	private readonly approvalPath: string | undefined;
	private cache: CacheFile;
	private approvals: ApprovalFile;

	constructor(dir?: string) {
		this.cachePath = dir ? join(dir, "mcp-cache.json") : undefined;
		this.approvalPath = dir ? join(dir, "mcp-approvals.json") : undefined;
		this.cache = readJson<CacheFile>(this.cachePath, { version: 1, servers: {} });
		this.approvals = readJson<ApprovalFile>(this.approvalPath, { version: 1, projects: {} });
	}

	cached(server: McpServerDefinition): CachedServer | undefined {
		const entry = this.cache.servers?.[cacheKey(server)];
		return entry && Array.isArray(entry.tools) ? entry : undefined;
	}

	remember(server: McpServerDefinition, tools: readonly { name: string; description?: string }[]): void {
		// Read again first: another session may have written since this one started.
		this.cache = readJson<CacheFile>(this.cachePath, this.cache);
		this.cache.servers = {
			...this.cache.servers,
			[cacheKey(server)]: {
				tools: tools.map((tool) => ({
					name: tool.name,
					description: (tool.description ?? "").replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_LENGTH),
				})),
				updatedAt: new Date().toISOString(),
			},
		};
		writeJson(this.cachePath, this.cache);
	}

	isApproved(projectDir: string, server: McpServerDefinition): boolean {
		return this.approvals.projects?.[resolve(projectDir)]?.[server.name] === definitionHash(server);
	}

	approve(projectDir: string, server: McpServerDefinition): void {
		this.approvals = readJson<ApprovalFile>(this.approvalPath, this.approvals);
		const project = resolve(projectDir);
		this.approvals.projects = {
			...this.approvals.projects,
			[project]: { ...this.approvals.projects?.[project], [server.name]: definitionHash(server) },
		};
		writeJson(this.approvalPath, this.approvals);
	}
}
