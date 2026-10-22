import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isReadOnlyChain, isReadOnlyCommand } from "../checkpoint/mutating.ts";
import { isShellTool } from "../extension/shell-tools.ts";

/**
 * How much the agent may do without asking.
 *
 * - `full`: nothing is asked. What the user said not to do still stops a call
 *   (the constraint gate is about the user's words, not about permission).
 * - `judge`: the judge approves for the user. Reading and editing inside the
 *   project go ahead, as the task itself; a command, a change outside the
 *   project, an action on the outside world or a sub-agent goes to the judge,
 *   and only what the judge does not approve reaches the user.
 * - `ask`: minimal permissions. Reading goes ahead; everything else asks.
 */
export type PermissionMode = "full" | "judge" | "ask";

export const PERMISSION_MODES: readonly PermissionMode[] = ["full", "judge", "ask"];

export const MODE_TEXT: Readonly<
	Record<PermissionMode, { zh: string; en: string; zhDescription: string; enDescription: string }>
> = {
	full: {
		zh: "完全访问",
		en: "Full access",
		zhDescription: "什么都不问，直接执行。你明确说过不许做的事仍然会被拦下。",
		enDescription: "Runs everything without asking. Anything you've told mu not to do is still blocked.",
	},
	judge: {
		zh: "判定模式",
		en: "Judge mode",
		zhDescription: "项目里的读和改直接做；命令、项目外的改动、对外操作由判定器替你审批，它拿不准的才问你。",
		enDescription:
			"Reads and edits inside the project go ahead. The judge decides on commands, changes outside the project and actions outside this computer, and asks you only when it's unsure.",
	},
	ask: {
		zh: "最小权限",
		en: "Ask first",
		zhDescription: "只读操作直接做；改文件、跑命令、对外操作都先问你。",
		enDescription: "Only reads go ahead. mu asks you before every edit, command and action outside this computer.",
	},
};

const ALIASES: Readonly<Record<string, PermissionMode>> = {
	full: "full",
	"full-access": "full",
	yolo: "full",
	完全访问: "full",
	judge: "judge",
	// The mode's name before 0.1.12: settings, MU_PERMISSIONS and saved conversations may still say it.
	jev: "judge",
	auto: "judge",
	审批: "judge",
	判定模式: "judge",
	ask: "ask",
	minimal: "ask",
	"read-only": "ask",
	readonly: "ask",
	最小权限: "ask",
};

export function parseMode(raw: unknown): PermissionMode | undefined {
	return typeof raw === "string" ? ALIASES[raw.trim().toLowerCase()] : undefined;
}

/** What a call that needs permission is. */
export type PermissionKind = "edit" | "shell" | "run" | "outside" | "delegate" | "other";

export interface PermissionNeed {
	readonly kind: PermissionKind;
	/** One line a person can read: the command, the path, the tool and its main argument. */
	readonly summary: string;
	/** What an "allow for this conversation" covers. Undefined: this call can only be allowed once. */
	readonly grant?: { readonly key: string; readonly label: string };
	/** Never approved by the judge or a grant: the user decides, every time. */
	readonly protected?: string;
	/** In the project folder (edits) — the one thing judge mode lets through without a judgment. */
	readonly inProject?: boolean;
}

/** Tools that only look: never asked in any mode. */
const LOOKING: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"find_skill",
	"find_capability",
	"locate",
	"todo",
	"web_search",
	"web_fetch",
	"bg_output",
	"bg_stop",
	"conflicts_list",
	"conflicts_show",
	"sg_search",
	"review_triage",
	"debug_step",
	"debug_stop",
]);

const EDITING: ReadonlySet<string> = new Set(["edit", "write", "apply_patch_from", "conflicts_resolve", "sg_rewrite"]);

/** Programs whose first argument names the action: "npm test" and "npm publish" are not one permission. */
const TWO_WORD =
	/^(?:git|npm|pnpm|yarn|bun|npx|cargo|go|docker|kubectl|pip|pip3|uv|poetry|make|dotnet|gh|brew|apt|apt-get)$/;
/** Chaining, redirection, substitution: a grant for the first word would cover whatever comes after it. */
const COMPOUND = /[<>;&|`\n\r]|\$\(|\$\{/;
/**
 * Programs that run the command given to them: the first word says nothing about what runs. "Allow `timeout` for
 * this conversation" would allow `timeout 60 <anything>`.
 */
const WRAPPER =
	/^(?:sudo|doas|pkexec|su|runas|env|xargs|eval|exec|command|builtin|nohup|timeout|nice|ionice|time|stdbuf|setsid|chroot|taskset|flock|watch|unbuffer|caffeinate|script|busybox|start|sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd)$/i;
/** What makes `find` run a program on, or delete, every file it finds. */
const FIND_ACTS = /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/;

/** "npm test", "git commit", "python": what "allow for this conversation" allows for a command. */
export function commandPrefix(command: string): string | undefined {
	const text = command.trim();
	if (!text || COMPOUND.test(text)) return undefined;
	const words = text.split(/\s+/);
	// A leading `VAR=value` or `sudo` changes what runs: such a command is allowed once or not at all.
	if (/=/.test(words[0]) || WRAPPER.test(words[0])) return undefined;
	if (/^find$/i.test(words[0]) && words.some((word) => FIND_ACTS.test(word))) return undefined;
	const [first, second] = words;
	return TWO_WORD.test(first) && second && !second.startsWith("-") ? `${first} ${second}` : first;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function pathOf(input: Readonly<Record<string, unknown>>): string {
	return text(input.path) || text(input.file_path) || text(input.file);
}

/** The path with links resolved as far as it exists, a link to a place that does not exist yet included. */
function realPath(path: string, depth = 0): string {
	try {
		return realpathSync.native(path);
	} catch {
		if (depth < 40) {
			try {
				// Writing through such a link creates the file where it points.
				if (lstatSync(path).isSymbolicLink())
					return realPath(resolve(dirname(path), readlinkSync(path)), depth + 1);
			} catch {
				// Nothing there at all.
			}
		}
		const parent = dirname(path);
		return parent === path ? path : join(realPath(parent, depth + 1), basename(path));
	}
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** pi's `normalizeWindowsShellPath`: Git Bash, MSYS, Cygwin and WSL spell `C:\x` as `/c/x`. */
function windowsDrive(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
	const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
	return match ? `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}` : path;
}

/**
 * Where a file tool will really write, or undefined when it cannot write anywhere. pi reads a path its own way
 * (`resolveToCwd`): one leading `@` is dropped, `~` is the home, a `file://` URL is a path, and on Windows `/c/...`
 * is a drive. Read plainly, `~/.zshrc` would be a folder called `~` inside the project. Links are then followed as
 * far as the path exists.
 */
export function toolPath(cwd: string, raw: string, home: string = homedir()): string | undefined {
	let path = raw.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (process.platform === "win32") path = windowsDrive(path);
	if (path === "~") path = home;
	else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\")))
		path = join(home, path.slice(2));
	else if (/^file:\/\//.test(path)) {
		try {
			path = fileURLToPath(path);
		} catch {
			return undefined;
		}
	}
	return realPath(isAbsolute(path) ? resolve(path) : resolve(cwd, path));
}

/** `target` (a `toolPath`) relative to the project, or undefined when it is not inside it. */
function inProject(cwd: string, target: string | undefined): string | undefined {
	if (target === undefined) return undefined;
	const rel = relative(realPath(resolve(cwd)), target);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel;
}

export function insideProject(cwd: string, path: string): boolean {
	return !path || inProject(cwd, toolPath(cwd, path)) !== undefined;
}

/**
 * A file of the project, which judge mode edits without asking: inside the folder, and not git's own. Git runs its
 * hooks and reads its config on the user's next git command, and a checkpoint never holds them.
 */
function projectFile(cwd: string, target: string | undefined): boolean {
	const rel = inProject(cwd, target);
	return rel !== undefined && !rel.split(/[\\/]/).some((part) => part.toLowerCase() === ".git");
}

/**
 * Where mu keeps its own settings, as a command may spell it: a call touching it is the user's to allow. From the home
 * it is `~`, `$HOME`; on Windows also `%USERPROFILE%` or `$env:USERPROFILE`, with either slash, and `/c/...` as Git
 * Bash (the shell mu's commands run in there) spells a drive.
 */
export function protectedSpellings(agentDir: string, home: string, platform: NodeJS.Platform): string[] {
	if (platform !== "win32") {
		return agentDir.startsWith(`${home}/`)
			? [agentDir, `~${agentDir.slice(home.length)}`, `$HOME${agentDir.slice(home.length)}`]
			: [agentDir];
	}
	const forward = (path: string) => path.replace(/\\/g, "/");
	const back = (path: string) => path.replace(/\//g, "\\");
	const dir = back(agentDir);
	const drive = /^([A-Za-z]):\\/.exec(dir);
	const spellings = [dir, forward(dir), ...(drive ? [`/${drive[1].toLowerCase()}${forward(dir.slice(2))}`] : [])];
	const base = back(home);
	if (!dir.toLowerCase().startsWith(`${base.toLowerCase()}\\`)) return spellings;
	const rest = dir.slice(base.length);
	for (const from of ["~", "$HOME", "%USERPROFILE%", "$env:USERPROFILE"])
		spellings.push(`${from}${rest}`, forward(`${from}${rest}`));
	return spellings;
}

const clip = (value: string, length: number) => {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length <= length ? line : `${line.slice(0, length - 1)}…`;
};

/**
 * Whether a call needs permission, and what it is. Wrong in the safe direction
 * only: a tool nobody listed needs permission, and a command counts as only
 * looking when every part of it is on the short read-only list. `chains`: a
 * chain of read-only commands (`pwd && ls -la; git status`) only looks too
 * (`isReadOnlyChain`); without it, only a single command or pipeline does.
 */
export function permissionNeed(
	toolName: string,
	input: Readonly<Record<string, unknown>>,
	cwd: string,
	protectedPaths: readonly string[] = [],
	chains = true,
): PermissionNeed | undefined {
	// Without regard to case: Windows and macOS name a folder in any case, and more protection is the safe direction.
	const touches = (value: string) => {
		const said = value.toLowerCase();
		return protectedPaths.find((path) => said.includes(path.toLowerCase()));
	};
	if (LOOKING.has(toolName)) return undefined;
	if (isShellTool(toolName) || toolName === "bg_start") {
		const command = text(input.command);
		// Read the way PowerShell reads it in the powershell tool, and in a background command on Windows, which runs in
		// PowerShell where that is the one shell tool. pi's bash tool runs bash on Windows too (Git Bash), where a quoted
		// parenthesis, as in `rg 'useState\(' src`, is only text.
		const powershell = toolName === "powershell" || (toolName === "bg_start" && process.platform === "win32");
		if (chains ? isReadOnlyChain(command, powershell) : isReadOnlyCommand(command, powershell)) return undefined;
		const guarded = touches(command);
		const prefix = commandPrefix(command);
		return {
			kind: "shell",
			summary: clip(command, 300),
			...(guarded ? { protected: guarded } : prefix ? { grant: { key: `shell:${prefix}`, label: prefix } } : {}),
		};
	}
	if (toolName === "sg_rewrite" && input.apply !== true) return undefined;
	if (EDITING.has(toolName)) {
		const path = pathOf(input);
		// `sg_rewrite` takes the folders and files it rewrites as a list.
		const listed = Array.isArray(input.paths)
			? input.paths.filter((each): each is string => typeof each === "string")
			: [];
		const paths = [...(path ? [path] : []), ...listed];
		const targets = paths.map((each) => ({ said: each, target: toolPath(cwd, each) }));
		const summary = clip(`${toolName} ${path || listed.join(" ") || text(input.id) || text(input.pattern)}`, 300);
		// As written and as it really is: a spelling of mu's folder, or a link into it.
		const guarded = targets
			.flatMap(({ said, target }) => [resolve(cwd, said), ...(target ? [target] : [])])
			.map(touches)
			.find(Boolean);
		if (guarded) return { kind: "edit", summary, protected: guarded };
		const away = targets.find(({ target }) => !projectFile(cwd, target));
		return away
			? {
					kind: "outside",
					summary,
					grant: { key: `outside:${away.target ?? away.said}`, label: away.said },
				}
			: { kind: "edit", summary, inProject: true, grant: { key: "edit", label: "edit" } };
	}
	if (toolName === "delegate" || toolName === "hive") {
		const tasks = Array.isArray(input.tasks) ? input.tasks.length : 0;
		const title = text(input.goal) || text(input.task);
		return {
			kind: "delegate",
			summary: clip(`${toolName} ${tasks ? `${tasks} task${tasks === 1 ? "" : "s"}` : title}`, 300),
			grant: { key: `tool:${toolName}`, label: toolName },
		};
	}
	// Looking at a stopped program only looks. An expression evaluated in it can call anything there, which is more
	// than running the program the user allowed: `__import__('os').system(...)`.
	if (toolName === "debug_inspect") {
		const expression = text(input.expression).trim();
		if (!expression) return undefined;
		return {
			kind: "run",
			summary: clip(`${toolName} ${expression}`, 300),
			grant: { key: "tool:debug_inspect", label: toolName },
		};
	}
	if (toolName === "debug_start") {
		return {
			kind: "run",
			summary: clip(`${toolName} ${text(input.program) || text(input.command) || JSON.stringify(input)}`, 300),
			grant: { key: "tool:debug_start", label: toolName },
		};
	}
	const main = text(input.url) || text(input.action) || text(input.query) || text(input.task) || JSON.stringify(input);
	return {
		kind: "other",
		summary: clip(`${toolName} ${main}`, 300),
		grant: { key: `tool:${toolName}`, label: toolName },
	};
}

/**
 * The mode new conversations start in, as the user last chose it. In the
 * user's own agent folder, next to the board's switches; never in a project.
 */
export class PermissionDefaults {
	readonly file: string | undefined;
	private memory: PermissionMode | undefined;

	constructor(dir: string | undefined) {
		this.file = dir ? join(dir, "permissions.json") : undefined;
	}

	get(): PermissionMode | undefined {
		if (!this.file) return this.memory;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { version?: unknown; mode?: unknown };
			return parsed.version === 1 ? parseMode(parsed.mode) : undefined;
		} catch {
			return undefined;
		}
	}

	set(mode: PermissionMode): void {
		if (!this.file) {
			this.memory = mode;
			return;
		}
		mkdirSync(join(this.file, ".."), { recursive: true });
		const temp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ version: 1, mode }, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, this.file);
	}
}
