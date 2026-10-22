import { toolRisk } from "../../decisions/tool-risk.ts";
import { say } from "../../language.ts";
import { subAgentUserGoal } from "../../swarm/brief.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";
import { SHELL_TOOLS } from "../shell-tools.ts";

const RULES: readonly (readonly [RegExp, string])[] = [
	[/\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf]/, "recursive or forced delete"],
	// find deletes what it finds with -delete, or with rm run on each.
	[/\bfind\b[^|;&\n]*\s-(?:delete\b|(?:exec|execdir|ok|okdir)\s+(?:\S*\/)?rm\b)/, "recursive or forced delete"],
	[
		/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|branch\s+-D|stash\s+(drop|clear))/,
		"discards git work",
	],
	// The same deeds spelled otherwise: clean forced by a later option, a checkout of everything or by force, a
	// restore of the working tree, a branch deleted by force.
	[
		/\bgit\s+(?:clean\b[^|;&\n]*\s(?:-[a-zA-Z]*f|--force)\b|checkout\s+(?:\.(?:\s|$)|-f\b|--force\b)|restore\b(?:(?![^|;&\n]*--staged)|(?=[^|;&\n]*(?:--worktree|\s-W\b)))|branch\b[^|;&\n]*(?:--delete\s+--force|--force\s+--delete|\s-(?:D|df|fd)\b))/,
		"discards git work",
	],
	[/\bgit\s+push\b.*(--force|\s-f\b)/, "force push"],
	// A `+` refspec forces as well; --mirror, --delete and `:branch` remove what is on the remote.
	[/\bgit\s+push\b[^|;&\n]*\s(?:\+\S|--mirror\b|--delete\b|-d\b|:\S)/, "force push"],
	[/\b(drop|truncate)\s+(table|database|schema)\b/i, "drops database objects"],
	[/\bmkfs\b|\bdd\b.*\bof=\/dev\//, "overwrites a device"],
	[/\bchmod\s+-R\s+0?777\b/, "loosens permissions recursively"],
	// The same deeds in PowerShell and cmd.
	[
		/\b(Remove-Item|rm|ri|del|erase|rd|rmdir)\b[^|;\n]*(-Recurse|-Force|-r\b|-rf\b|\/s\b|\/q\b)/i,
		"recursive or forced delete",
	],
	[
		/\b(Invoke-Expression|iex)\b[^|;\n]*\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget|DownloadString)\b|\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\b[^|;\n]*\|\s*(Invoke-Expression|iex)\b/i,
		"runs a downloaded script",
	],
	[/\bStart-Process\b[^|;\n]*-Verb\s+RunAs\b|\brunas\b/i, "runs as administrator"],
	[/\bformat\s+[a-z]:|\bFormat-Volume\b|\bClear-Disk\b/i, "overwrites a device"],
	[/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(?:(?:ba|z|da|k)?sh|python\d*|perl|ruby|node)\b/, "runs a downloaded script"],
	// Without a pipe: a download read as a file (`bash <(curl …)`) or as the text of `sh -c "$(curl …)"`.
	[/<\(\s*(?:curl|wget)\b|\b(?:ba|z|da|k)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/, "runs a downloaded script"],
	[/\b(?:sudo|doas|pkexec)\b/, "runs as root"],
];

/**
 * The command as the shell reads its words: `r\m` is `rm`, and so are `"rm"` and `r''m`. Only for matching the rules,
 * which also see the command as it was written.
 */
function unquoted(command: string): string {
	return command.replace(/\\(?=[A-Za-z])/g, "").replace(/(["'])([^"'\s]*)\1/g, "$2");
}

/** What each flag says to a person reading Chinese. The judge and the model read the English. */
export const FLAG_ZH: Readonly<Record<string, string>> = {
	"recursive or forced delete": "递归或强制删除",
	"discards git work": "丢弃 git 里的改动",
	"force push": "强制推送",
	"drops database objects": "删除数据库对象",
	"overwrites a device": "覆盖整个设备",
	"loosens permissions recursively": "递归放开权限",
	"runs a downloaded script": "运行下载来的脚本",
	"runs as administrator": "以管理员身份运行",
	"runs as root": "以 root 身份运行",
};

/** Each flag as a stable code, for a client that translates it into a language mu has no wording for. */
export const FLAG_CODES: Readonly<Record<string, string>> = {
	"recursive or forced delete": "recursive_or_forced_delete",
	"discards git work": "discards_git_work",
	"force push": "force_push",
	"drops database objects": "drops_database_objects",
	"overwrites a device": "overwrites_device",
	"loosens permissions recursively": "opens_permissions_recursively",
	"runs a downloaded script": "runs_downloaded_script",
	"runs as administrator": "runs_as_administrator",
	"runs as root": "runs_as_root",
};

/** Tools whose `command` is a shell command line. A command is no safer for running in the background. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set([...SHELL_TOOLS, "bg_start"]);

/** Why a shell command deserves a second look, or undefined when no rule matches. */
export function riskFlag(command: string): string | undefined {
	const plain = unquoted(command);
	return RULES.find(([pattern]) => pattern.test(command) || pattern.test(plain))?.[1];
}

/**
 * B3: rules pick the commands, the judge says whether the user asked for it,
 * and only an unvouched-for command reaches the user as a confirmation. The
 * judge can add a gate, never open one: no verdict means the user is asked.
 */
export function registerGuard(runtime: KyrnRuntime): void {
	const options = runtime.options("guard", { enabled: true });
	if (!options.enabled) return;

	runtime.pi.on(
		"tool_call",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			// With permission modes on, the flags are theirs to weigh: full access asks nothing, the others ask once.
			if (runtime.permissionMode) return undefined;
			if (!COMMAND_TOOLS.has(event.toolName)) return undefined;
			const command = String((event.input as { command?: unknown }).command ?? "");
			const flag = riskFlag(command);
			if (!flag) return undefined;

			// In a sub-agent the message is what the parent's model wrote: only the user's goal says what was asked for.
			const asked = subAgentUserGoal() ?? runtime.turn.userMessage;
			const decision = await runtime.engine.decide(
				toolRisk,
				{ command: clip(command, 400), userMessage: clip(asked, 400), flag },
				{ signal: ctx.signal },
			);
			// Off and shadow leave pi's own behavior alone; only an active gate may stop a command.
			if (decision.mode !== "active" || decision.outcome === "allow") return undefined;
			if (!ctx.hasUI)
				return { block: true, reason: `mu: "${flag}" needs confirmation, which this mode cannot ask for.` };
			const approved = await ctx.ui.confirm(
				`mu: ${say({ zh: FLAG_ZH[flag] ?? flag, en: flag })}`,
				`${say({ zh: "要运行这条命令吗？", en: "Run this command?" })}\n\n${clip(command, 600)}`,
			);
			return approved ? undefined : { block: true, reason: `The user declined this command (${flag}).` };
		}),
	);
}
