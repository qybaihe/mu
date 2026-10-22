/**
 * What `mu import` does and prints (cli.ts only starts it):
 *
 *   mu import --list [--json] [--cwd <dir>] [--sub-agents] [--agent-dir <dir>]
 *   mu import <file>... [--json] [--agent-dir <dir>]   (a ZCode conversation: <database>#<id>, as --list names it)
 *
 * mu's agent folder comes from --agent-dir, else MU_CODING_AGENT_DIR (the launcher sets it), else ~/.mu/agent.
 * Sessions go where pi puts them: MU_CODING_AGENT_SESSION_DIR, else `sessionDir` in the agent folder's
 * settings.json, else `<agent folder>/sessions/<project>/`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { count as plural } from "../language.ts";
import {
	type FoundConversation,
	type ImportResult,
	importTranscripts,
	listConversations,
	type SessionStore,
	TOOL_NAMES,
} from "./index.ts";
import { absolute } from "./session.ts";

export const USAGE = [
	"mu import: import Claude Code, Codex and ZCode conversations so you can continue them in mu.",
	"",
	"  mu import --list [--json] [--cwd <dir>]   list conversations on this machine (with --cwd, only <dir>'s)",
	"  mu import <file>... [--json]              import these conversations; each becomes a mu session",
	"",
	"  --agent-dir <dir>   mu's agent folder (default: MU_CODING_AGENT_DIR, else ~/.mu/agent)",
	"  --sub-agents        also list subagent threads",
	"",
	"Looks in ~/.claude/projects (CLAUDE_CONFIG_DIR), ~/.codex/sessions (CODEX_HOME) and ~/.zcode/cli/db/db.sqlite.",
	"A ZCode conversation is named <database>#<id>, as --list shows it.",
	"Importing a conversation again brings over what is new in it; one that didn't change is skipped.",
].join("\n");

export interface ParsedArgs {
	help: boolean;
	list: boolean;
	json: boolean;
	subAgents: boolean;
	cwd?: string;
	agentDir?: string;
	files: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
	const parsed: ParsedArgs = { help: false, list: false, json: false, subAgents: false, files: [] };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = () => {
			const next = argv[index + 1];
			index++;
			return next === undefined || next.startsWith("--") ? undefined : next;
		};
		if (arg === "-h" || arg === "--help" || arg === "help") parsed.help = true;
		else if (arg === "--list" || arg === "-l") parsed.list = true;
		else if (arg === "--json") parsed.json = true;
		else if (arg === "--sub-agents") parsed.subAgents = true;
		else if (arg === "--cwd") {
			const dir = value();
			if (!dir) return { error: "--cwd needs a folder" };
			parsed.cwd = dir;
		} else if (arg === "--agent-dir") {
			const dir = value();
			if (!dir) return { error: "--agent-dir needs a folder" };
			parsed.agentDir = dir;
		} else if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
		else parsed.files.push(arg);
	}
	if (parsed.list && parsed.files.length > 0) return { error: "--list doesn't take files" };
	return parsed;
}

export interface Io {
	out(text: string): void;
	err(text: string): void;
	env: NodeJS.ProcessEnv;
	cwd: string;
	home: string;
}

/** Where mu keeps its sessions, decided the way pi decides it (apart from a project's own settings). */
export function storeFor(agentDirArg: string | undefined, io: Pick<Io, "env" | "home" | "cwd">): SessionStore {
	const agentDir = absolute(
		agentDirArg ?? io.env.MU_CODING_AGENT_DIR ?? io.env.KYRN_CODING_AGENT_DIR ?? join(io.home, ".mu", "agent"),
		io.cwd,
	);
	const fromEnv = io.env.MU_CODING_AGENT_SESSION_DIR;
	if (fromEnv) return { agentDir, sessionDir: absolute(fromEnv, io.cwd) };
	try {
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as unknown;
		const sessionDir =
			settings !== null && typeof settings === "object" && "sessionDir" in settings
				? settings.sessionDir
				: undefined;
		if (typeof sessionDir === "string" && sessionDir.trim())
			return { agentDir, sessionDir: absolute(sessionDir, io.cwd) };
	} catch {}
	return { agentDir };
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Local date and time, minutes: 2026-09-23 10:02. */
export function formatDate(iso: string | undefined): string {
	const date = iso ? new Date(iso) : undefined;
	if (!date || Number.isNaN(date.getTime())) return "????-??-?? ??:??";
	const two = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function tilde(path: string, home: string): string {
	return path === home ? "~" : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

export function formatList(conversations: readonly FoundConversation[], home: string): string {
	if (conversations.length === 0) return "No Claude Code, Codex or ZCode conversations found.";
	// Grouped by project, the project with the latest conversation first (the list comes newest first).
	const groups = new Map<string, FoundConversation[]>();
	for (const conversation of conversations) {
		const key = conversation.cwd ?? "";
		const group = groups.get(key) ?? [];
		group.push(conversation);
		groups.set(key, group);
	}
	const lines: string[] = [];
	const toolWidth = Math.max(...Object.values(TOOL_NAMES).map((name) => name.length));
	for (const [cwd, group] of groups) {
		if (lines.length > 0) lines.push("");
		lines.push(cwd ? tilde(cwd, home) : "(unknown folder)");
		for (const conversation of group) {
			const title = conversation.title || "(no message found)";
			const mark = !conversation.importedAs
				? ""
				: conversation.changed
					? "  (imported, changed since)"
					: "  (imported)";
			lines.push(
				`  ${formatDate(conversation.modified)}  ${TOOL_NAMES[conversation.tool].padEnd(toolWidth)}  ${formatSize(conversation.size).padStart(7)}  ${title}${mark}`,
			);
			lines.push(`${" ".repeat(20)}${tilde(conversation.path, home)}`);
		}
	}
	const count = conversations.length;
	lines.push("", `${count} conversation${count === 1 ? "" : "s"}. Import one with: mu import <file>`);
	return lines.join("\n");
}

export function formatResult(result: ImportResult, home: string): string {
	if (result.status === "failed") return `Couldn't import ${tilde(result.source, home)}: ${result.error}`;
	if (result.status === "already-imported")
		return [
			`Already imported, and nothing new since: ${tilde(result.source, home)}`,
			`  as session ${tilde(result.sessionFile, home)}`,
		].join("\n");
	const { counts } = result;
	const left = Object.entries(counts.dropped)
		.sort((a, b) => b[1] - a[1])
		.map(([reason, count]) => `${reason} ${count}`);
	const kept = [
		...(counts.thinking > 0 ? [plural(counts.thinking, "thinking block")] : []),
		...(counts.images > 0 ? [plural(counts.images, "image")] : []),
		...(counts.compactions > 0 ? [plural(counts.compactions, "compaction")] : []),
	];
	const head =
		result.status === "updated"
			? [
					`Brought up to date from ${TOOL_NAMES[result.tool]}: "${result.name}"`,
					`  ${tilde(result.sessionFile, home)}`,
					`  new since the last import: ${plural(Math.max(0, counts.user - (result.before?.user ?? 0)), "message")} from you, ${plural(Math.max(0, counts.assistant - (result.before?.assistant ?? 0)), "reply", "replies")}`,
				]
			: [
					`Imported from ${TOOL_NAMES[result.tool]}: "${result.name}"`,
					`  ${tilde(result.sessionFile, home)}`,
					...(result.earlier
						? [`  the earlier import went on in mu, so it was left as it was: ${tilde(result.earlier, home)}`]
						: []),
				];
	return [
		...head,
		`  ${plural(counts.user, "message")} from you, ${plural(counts.assistant, "reply", "replies")}, ${plural(counts.toolCalls, "tool call")}${kept.length > 0 ? `, ${kept.join(", ")}` : ""}`,
		...(left.length > 0 ? [`  skipped: ${left.join(", ")}`] : []),
		`  to continue: mu --session ${result.sessionFile}`,
	].join("\n");
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		io.err(`mu import: ${parsed.error}\n\n${USAGE}`);
		return 2;
	}
	if (parsed.help || (!parsed.list && parsed.files.length === 0)) {
		io.out(USAGE);
		return parsed.help ? 0 : 2;
	}
	const store = storeFor(parsed.agentDir, io);
	if (parsed.list) {
		const conversations = listConversations({
			cwd: parsed.cwd === undefined ? undefined : absolute(parsed.cwd, io.cwd),
			store,
			subAgents: parsed.subAgents,
		});
		io.out(parsed.json ? JSON.stringify({ conversations }, null, 2) : formatList(conversations, io.home));
		return 0;
	}
	const results = await importTranscripts(
		parsed.files.map((file) => absolute(file, io.cwd)),
		{ ...store, cwd: io.cwd },
	);
	io.out(
		parsed.json
			? JSON.stringify({ results }, null, 2)
			: results.map((result) => formatResult(result, io.home)).join("\n\n"),
	);
	return results.some((result) => result.status === "failed") ? 1 : 0;
}

export function processIo(): Io {
	return {
		out: (text) => process.stdout.write(`${text}\n`),
		err: (text) => process.stderr.write(`${text}\n`),
		env: process.env,
		cwd: process.cwd(),
		home: homedir(),
	};
}
