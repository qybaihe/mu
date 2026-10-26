/**
 * Which tool calls can change files. The first one in a user turn is what a checkpoint is taken
 * before, so a turn that only reads costs nothing.
 *
 * Wrong in the safe direction only: an unknown tool or command counts as changing files (one snapshot
 * more than needed), and a command counts as read-only only when every part of it is on a short list.
 * A shell command is read with `isReadOnlyChain`, which also takes chains of them (`git status; git log -5`), as the
 * permission gate and the constraint gate read it.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isShellTool } from "../extension/shell-tools.ts";

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"find_skill",
	"find_capability",
	"locate",
	"todo",
	"browse",
	"web_fetch",
	"web_search",
	"bg_output",
]);

/** Redirection, chaining, substitution, a second line: anything that lets a command do more than it says first. */
const SHELL_TRICKS = /[<>;&`\n\r]|\$\(|\$\{/;
/** PowerShell also runs what stands in a parenthesis, in `@( )` and in a script block, where an argument goes. */
const POWERSHELL_TRICKS = /[(){}]/;
const READ_ONLY_PROGRAM =
	/^(?:ls|pwd|cat|head|tail|wc|which|file|stat|du|df|date|whoami|uname|echo|printf|rg|grep|sort|uniq|cut|nl|tree|git|Get-ChildItem|gci|dir|Get-Content|gc|type|Get-Location|Select-String|sls|Get-Item|gi|Get-Date|Write-Output|Write-Host)(?:\s|$)/i;

/** Options with which a program of the list writes a file or starts another program. */
const WRITES_OR_RUNS: ReadonlyMap<string, RegExp> = new Map([
	// ripgrep runs `--pre` on every file it searches, and `--hostname-bin` for its links.
	["rg", /(?:^|\s)--(?:pre|hostname-bin)(?:[\s=]|$)/],
	// `-o FILE`, also in a cluster (`-uo`); `--compress-program` runs on its temporary files.
	["sort", /(?:^|\s)-[a-zA-Z]*o|--compress-program/],
	// `-o FILE`; `-R` writes an index into every folder.
	["tree", /(?:^|\s)-[a-zA-Z]*[oR]/],
	// `-C` compiles a magic file next to the one it is given.
	["file", /(?:^|\s)-[a-zA-Z]*C/],
]);

/** `uniq IN OUT` writes OUT. */
function uniqWrites(words: readonly string[]): boolean {
	let operands = 0;
	for (let index = 1; index < words.length; index++) {
		if (/^-[fsw]$/.test(words[index])) index++;
		else if (words[index] === "-" || !words[index].startsWith("-")) operands++;
	}
	return operands > 1;
}

/**
 * Whether a word is `option` cut short: a GNU program (and git) takes `--out=x` for `--output=x`, as long as no other
 * of its options starts the same way. `shortest`: how much of the name it takes for that.
 */
function longOption(words: readonly string[], option: string, shortest = 1): boolean {
	return words.some((word) => {
		const name = word.startsWith("--") ? word.slice(2).split("=")[0] : "";
		return name.length >= shortest && option.startsWith(name);
	});
}

/** Git commands that only read, with any options but `--output` (and `-O` for `grep`, see `readOnlyGit`). */
const GIT_READS: ReadonlySet<string> = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"rev-parse",
	"ls-files",
	"describe",
	"shortlog",
	"rev-list",
	"ls-tree",
	"cat-file",
	"merge-base",
	"name-rev",
	"for-each-ref",
	"show-ref",
	"diff-tree",
	"diff-index",
	"diff-files",
	"grep",
	"version",
]);

/**
 * Git commands that list with some options and make or delete with others: `git branch -a` lists the branches, `git
 * branch x` makes one. `long` and `short`: the options that only choose or shape the list. `listing`: the ones after
 * which a name is a pattern or a commit to list by, never a new branch or tag.
 */
const GIT_LISTS: ReadonlyMap<string, { long: ReadonlySet<string>; short: RegExp; listing: RegExp }> = new Map([
	[
		"branch",
		{
			long: new Set([
				"show-current",
				"list",
				"all",
				"remotes",
				"verbose",
				"contains",
				"no-contains",
				"merged",
				"no-merged",
				"points-at",
				"sort",
				"format",
				"color",
				"no-color",
				"column",
				"no-column",
				"abbrev",
				"no-abbrev",
				"ignore-case",
				"omit-empty",
			]),
			short: /^-[ailrv]+$/,
			listing: /^(?:--(?:list|contains|no-contains|merged|no-merged|points-at)(?:=|$)|-[ailrv]*l)/,
		},
	],
	[
		"tag",
		{
			long: new Set([
				"list",
				"contains",
				"no-contains",
				"merged",
				"no-merged",
				"points-at",
				"sort",
				"format",
				"color",
				"no-color",
				"column",
				"no-column",
				"ignore-case",
				"omit-empty",
			]),
			// `-v` is not here: it verifies a tag with the program the config names.
			short: /^-(?:[il]+|n\d*)$/,
			listing: /^(?:--(?:list|contains|no-contains|merged|no-merged|points-at)(?:=|$)|-i*l|-n)/,
		},
	],
]);

/** Options of `git config` that say where to read from and how to show it. */
const CONFIG_SHOWS =
	/^(?:--(?:global|system|local|worktree|file|blob|show-origin|show-scope|name-only|null|includes|no-includes|type|bool|int|bool-or-int|path|expiry-date|default)(?:=|$)|-z$)/;
/** The options that make `git config` read: git takes no second action next to one of them. */
const CONFIG_GETS = /^(?:--(?:get|get-all|get-regexp|get-urlmatch|list)|-l)$/;

/**
 * The arguments of `git` (after the word itself) for a command that only reads. A command is taken as git spells it:
 * git runs its own `status` whatever an alias says, but may find `alias.status` for `git STATUS`. Before the command,
 * only options that keep git from starting a pager or taking locks; `-c` names a config, which can run any program,
 * and `-C` another folder, which can hold another repository.
 */
function readOnlyGit(args: readonly string[]): boolean {
	let at = 0;
	while (/^(?:-P|--no-pager|--no-optional-locks)$/.test(args[at] ?? "")) at++;
	const [command, ...rest] = args.slice(at);
	if (command === "--version") return rest.length === 0;
	if (command === "grep") {
		// `-O` opens what it finds in the program it names.
		return !rest.some((arg) => /^-[a-zA-Z]*O/.test(arg)) && !longOption(rest, "open-files-in-pager");
	}
	if (command !== undefined && GIT_READS.has(command)) return true;
	const list = command === undefined ? undefined : GIT_LISTS.get(command);
	if (list) {
		let named = false;
		for (const arg of rest) {
			if (arg.startsWith("--")) {
				if (!list.long.has(arg.slice(2).split("=")[0])) return false;
			} else if (arg.startsWith("-")) {
				if (!list.short.test(arg)) return false;
			} else named = true;
		}
		return !named || rest.some((arg) => list.listing.test(arg));
	}
	// `git stash` alone stashes; `git remote show` asks the remote.
	if (command === "stash") return rest[0] === "list" || rest[0] === "show";
	if (command === "worktree") return rest[0] === "list";
	if (command === "remote") return rest[0] === "get-url" || rest.every((arg) => arg === "-v" || arg === "--verbose");
	if (command === "config") {
		if (rest[0] === "get" || rest[0] === "list") return true;
		// `git config user.name` reads it, and `git config user.name x` sets it.
		const names = rest.filter((arg) => !arg.startsWith("-")).length;
		return (
			rest.every((arg) => !arg.startsWith("-") || CONFIG_GETS.test(arg) || CONFIG_SHOWS.test(arg)) &&
			(rest.some((arg) => CONFIG_GETS.test(arg)) || names === 1)
		);
	}
	return false;
}

/**
 * One program of the list with its arguments, none of which writes a file or starts another program. `elsewhere`: it
 * runs outside the conversation's folder, where git is not trusted (see `isReadOnlyChain`).
 */
function readOnlyProgram(piece: string, elsewhere = false): boolean {
	if (!READ_ONLY_PROGRAM.test(piece)) return false;
	const words = piece.split(/\s+/);
	// `--output` writes a file (`git diff`, `sort`), and so does `--out`, the same option cut short.
	if (longOption(words, "output")) return false;
	// A case-insensitive file system finds `rg` for `RG` as well.
	const program = words[0].toLowerCase();
	if (program === "git") return !elsewhere && readOnlyGit(words.slice(1));
	if (program === "uniq") return !uniqWrites(words);
	if (program === "sort" && longOption(words, "compress-program", 2)) return false;
	if (program === "file" && longOption(words, "compile", 2)) return false;
	return !WRITES_OR_RUNS.get(program)?.test(piece);
}

/** Whether `dir` is the conversation's folder `cwd`, by any spelling or link. */
function samePlace(dir: string, cwd: string): boolean {
	if (resolve(dir) === resolve(cwd)) return true;
	try {
		return realpathSync.native(dir) === realpathSync.native(cwd);
	} catch {
		return false;
	}
}

/** Whether a command that starts in `start` starts outside the conversation's folder `cwd`. Unknown `cwd`: it does not. */
function startsElsewhere(cwd: string | undefined, start: string | undefined): boolean {
	return cwd !== undefined && start !== undefined && !samePlace(start, cwd);
}

/**
 * True for a pipeline of plain read-only programs, e.g. `git status`, `cat a.txt | grep x | head -5`. `powershell`:
 * the command is PowerShell's (or may be), which evaluates more than a POSIX shell does where an argument goes.
 * `cwd` and `start`: as `isReadOnlyChain` takes them.
 */
export function isReadOnlyCommand(command: string, powershell = false, cwd?: string, start = cwd): boolean {
	const text = command.trim();
	if (!text || SHELL_TRICKS.test(text) || /--output\b/.test(text)) return false;
	if (powershell && POWERSHELL_TRICKS.test(text)) return false;
	const elsewhere = startsElsewhere(cwd, start);
	return text.split("|").every((part) => readOnlyProgram(part.trim(), elsewhere));
}

/** What makes `find` delete what it finds, run a program on it, or write a list of it to a file. */
const FIND_ACTS = /^-(?:delete|exec|ok|fprint|fls)/;

/**
 * Where a redirection at `at` (its `>`) ends, when all it does is throw output away (`>/dev/null`, `2>>/dev/null`,
 * `&>/dev/null`) or send one output where another goes (`2>&1`, `>&2`; not after `&>`). Undefined for any other.
 */
function harmlessRedirect(text: string, at: number, both: boolean): number | undefined {
	let index = at + 1;
	if (text[index] === ">") index++;
	if (text[index] === "&" && !both) {
		const fd = /^\d+/.exec(text.slice(index + 1))?.[0];
		return fd ? index + fd.length : undefined;
	}
	while (text[index] === " " || text[index] === "\t") index++;
	const end = index + "/dev/null".length;
	if (!text.startsWith("/dev/null", index) || !/^(?:[\s;&|]|$)/.test(text.slice(end, end + 1))) return undefined;
	return end - 1;
}

/**
 * Where a redirection at `at` (its `>`) ends when it sends output to a file named in plain characters (`>/tmp/x.log`,
 * `>> out.txt`), whose name it adds to `writes`. Undefined for any other.
 */
function fileRedirect(text: string, at: number, writes: string[]): number | undefined {
	let index = at + 1;
	if (text[index] === ">") index++;
	while (text[index] === " " || text[index] === "\t") index++;
	const name = /^[\w./@%+,:=-]+/.exec(text.slice(index))?.[0];
	if (!name || !/^(?:[\s;&|]|$)/.test(text.slice(index + name.length, index + name.length + 1))) return undefined;
	writes.push(name);
	return index + name.length - 1;
}

/**
 * The simple commands of a POSIX command line, each as its words with the quoting taken off, split where the shell
 * splits them: at `;`, `&&`, `||`, `|` and line breaks outside quotes. A redirection that only throws output away is
 * left out (see `harmlessRedirect`). Undefined for whatever this does not read the way the shell does, or that can
 * do more than its words say: a substitution, `$'…'`, a heredoc or any other redirection, `&` alone, a subshell, a
 * group or brace expansion, a carriage return, a quote left open. With `writes`, a redirection to a file is left out
 * too, and the file it writes is added there (see `fileRedirect`).
 */
function simpleCommands(text: string, writes?: string[]): string[][] | undefined {
	if (text.includes("\r")) return undefined;
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	/** The word has begun: `''` is a word too. */
	let started = false;
	/** Some of it was quoted or escaped: `'2'>` is no file descriptor. */
	let quoted = false;
	const endWord = () => {
		if (started) words.push(word);
		word = "";
		started = false;
		quoted = false;
	};
	const endCommand = () => {
		endWord();
		commands.push(words);
		words = [];
	};
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		const next = text[index + 1] ?? "";
		if (char === " " || char === "\t") endWord();
		else if (char === "\n" || char === ";") endCommand();
		else if (char === "|") {
			// `|&` sends errors down the pipe too; `>|` is caught at the `>`.
			if (next === "&") return undefined;
			if (next === "|") index++;
			endCommand();
		} else if (char === "&") {
			if (next === "&") {
				index++;
				endCommand();
			} else if (next === ">") {
				endWord();
				const end =
					harmlessRedirect(text, index + 1, true) ?? (writes ? fileRedirect(text, index + 1, writes) : undefined);
				if (end === undefined) return undefined;
				index = end;
			} else return undefined;
		} else if (char === ">") {
			// `2>`: the digits before it name the output, and are no word.
			if (started && !quoted && /^\d+$/.test(word)) {
				word = "";
				started = false;
			} else endWord();
			const end = harmlessRedirect(text, index, false) ?? (writes ? fileRedirect(text, index, writes) : undefined);
			if (end === undefined) return undefined;
			index = end;
		} else if (char === "'") {
			const end = text.indexOf("'", index + 1);
			if (end < 0) return undefined;
			word += text.slice(index + 1, end);
			started = quoted = true;
			index = end;
		} else if (char === '"') {
			let end = index + 1;
			for (; end < text.length && text[end] !== '"'; end++) {
				const inner = text[end];
				if (inner === "`" || (inner === "$" && /[({[]/.test(text[end + 1] ?? ""))) return undefined;
				if (inner === "\\" && /[$`"\\\n]/.test(text[end + 1] ?? "")) {
					end++;
					if (text[end] !== "\n") word += text[end];
				} else word += inner;
			}
			if (end >= text.length) return undefined;
			started = quoted = true;
			index = end;
		} else if (char === "\\") {
			if (!next) return undefined;
			index++;
			// A backslash before a line break joins the two lines.
			if (next !== "\n") {
				word += next;
				started = quoted = true;
			}
		} else if (char === "<" || char === "`" || "(){}".includes(char)) return undefined;
		else if (char === "$" && /[({['"]/.test(next)) return undefined;
		else {
			word += char;
			started = true;
		}
	}
	endCommand();
	return commands;
}

/**
 * True for a command line made only of read-only commands, joined by `;`, `&&`, `||`, `|` or line breaks: `pwd &&
 * find src -name '*.ts' | sort | head`, `git status --short; git log --oneline -5`, `ls -la a 2>/dev/null; ls -la b`.
 * Each part is a program of the short list (see `isReadOnlyCommand`), `find` without an action that deletes, runs or
 * writes, `cd`, `true`, `false` or `:`. Quoting is read the way the shell reads it, so `grep -E 'a|b'` is one part
 * and `rg '--pre=./x'` is the option it is. A redirection that writes a file, `sed -i`, `tee` or any program not on
 * the list makes the whole line one that may change something.
 *
 * Git counts only in the conversation's folder, `cwd`: a repository found elsewhere may carry a config that runs
 * programs (`core.fsmonitor`, a diff driver). A command starts in `start` (a background command can name a folder of
 * its own), and a `cd` moves it on. A `cd` back to `cwd`, spelled from the root, keeps git: some models begin every
 * command with one (`cd /work/app && git diff`). Any other `cd` does not, nor does a `start` elsewhere; without a
 * `cwd`, git counts only before the first `cd`. PowerShell gets no chains: its command, and a background command on
 * Windows that may run in it, is read as `isReadOnlyCommand` reads it.
 */
export function isReadOnlyChain(command: string, powershell = false, cwd?: string, start = cwd): boolean {
	if (powershell) return isReadOnlyCommand(command, true, cwd, start);
	const commands = simpleCommands(command.trim());
	if (!commands?.some((words) => words.length > 0)) return false;
	let elsewhere = startsElsewhere(cwd, start);
	return commands.every((words) => {
		if (words[0] !== "cd") return readOnlyPart(words, elsewhere);
		elsewhere = !cdHome(words, cwd);
		return true;
	});
}

/** Whether a `cd`, as its words, goes for certain to the conversation's folder `cwd`. */
function cdHome(words: readonly string[], cwd: string | undefined): boolean {
	// Only a folder from the root says for certain where `cd` goes: CDPATH finds a relative one anywhere, `..` after
	// a link goes up from the link or from where it leads (as the shell is set), and `$`, `~` and wildcards expand.
	const [, to, ...more] = words;
	return (
		cwd !== undefined &&
		to !== undefined &&
		more.length === 0 &&
		isAbsolute(to) &&
		!/[$*?[~]/.test(to) &&
		!to.split(/[\\/]/).includes("..") &&
		samePlace(to, cwd)
	);
}

/** One simple command of a read-only chain other than `cd`, as its words: see `isReadOnlyChain`. */
function readOnlyPart(words: readonly string[], elsewhere: boolean): boolean {
	const [program] = words;
	if (program === undefined || program === "true" || program === "false" || program === ":") return true;
	if (program === "find") return !words.some((word) => FIND_ACTS.test(word));
	return readOnlyProgram(words.join(" "), elsewhere);
}

export function isMutatingCall(toolName: string, input: Readonly<Record<string, unknown>>, cwd?: string): boolean {
	if (READ_ONLY_TOOLS.has(toolName)) return false;
	if (isShellTool(toolName)) return !isReadOnlyChain(String(input.command ?? ""), toolName === "powershell", cwd);
	return true;
}

/** Where a shell tool's call starts: in the conversation's folder, or for `bg_start` in the folder it names. */
export function shellStart(toolName: string, input: Readonly<Record<string, unknown>>, cwd: string): string {
	return toolName === "bg_start" && typeof input.cwd === "string" && input.cwd ? resolve(cwd, input.cwd) : cwd;
}

const CHECK_COMMAND =
	/\b(?:vitest|jest|pytest|mocha|ava|tsc|eslint|biome|ruff|mypy|rspec|phpunit|ctest|tox|nox|gradle|mvn)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint|typecheck)\b|\b(?:cargo|go|dotnet|swift|make|deno)\s+(?:test|build|check|vet|clippy)\b|\bnode\b[^\n]*--test\b|\btest\.sh\b/;

/** A command whose exit code says whether the work holds up: a test run, a build, a type check, a linter. */
export function isCheckCommand(command: string): boolean {
	return CHECK_COMMAND.test(command);
}

/**
 * A check as one simple command, its program first: `npm run check`, `npx vitest --run`, `python3 -m pytest -v`,
 * `cargo test`, `node --test`, `./test.sh`, `bash ci/test.sh`. Not `gradle` or `mvn`, whose goals also publish
 * (`mvn deploy`), nor a script outside the project (`../x/test.sh`, `/opt/test.sh`).
 */
const CHECK_RUN =
	/^(?:(?:(?:npx|bunx)\s+|(?:pnpm|yarn)\s+(?:exec\s+)?|python3?\s+-m\s+)?(?:vitest|jest|pytest|mocha|ava|tsc|eslint|biome|ruff|mypy|rspec|phpunit|ctest|tox|nox)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint|typecheck)|(?:cargo|go|dotnet|swift|make|deno)\s+(?:test|build|check|vet|clippy)|node\s+--test|(?:(?:ba)?sh\s+(?:\.\/)?|\.\/)(?:[\w-][\w.-]*\/)*test\.sh|(?:[\w-][\w.-]*\/)+test\.sh)(?:\s|$)/;

/** Settings a check may be given before it, `PYTHONPATH=src pytest`: none of them says which program runs. */
const CHECK_SETTING = /^(?:PYTHONPATH|CI|NODE_ENV|FORCE_COLOR|NO_COLOR|RUST_BACKTRACE)=[^$]*$/;

/** Where a check may write its output: `/tmp`. */
function tempFile(name: string): boolean {
	return /^\/(?:private\/)?tmp\//.test(name) && !name.split("/").includes("..");
}

/**
 * True for a command line that runs a check in the conversation's folder and otherwise only looks: `npm run check
 * 2>&1 | tail -20`, `cd /work/app && ./test.sh >/tmp/test.log 2>&1; echo "exit=$?"; tail -5 /tmp/test.log`, `cargo
 * test; git diff --stat`. Each part is a check (`CHECK_RUN`, after `env` and the settings of `CHECK_SETTING`), a `cd`
 * or a read-only command as `isReadOnlyChain` reads it, and a file it writes is in the temporary folder. A check after
 * a `cd` elsewhere, or that starts elsewhere (`start`), is not one. The judge needs to be less sure to approve one
 * (see `tool.approval`): it runs the project's own code and changes nothing else. PowerShell gets none.
 */
export function isCheckChain(command: string, powershell = false, cwd?: string, start = cwd): boolean {
	if (powershell) return false;
	const writes: string[] = [];
	const commands = simpleCommands(command.trim(), writes);
	if (!commands || !writes.every(tempFile)) return false;
	let elsewhere = startsElsewhere(cwd, start);
	let checks = 0;
	const parts = commands.every((words) => {
		if (words[0] === "cd") {
			elsewhere = !cdHome(words, cwd);
			return true;
		}
		let at = words[0] === "env" ? 1 : 0;
		while (at < words.length && CHECK_SETTING.test(words[at])) at++;
		if (CHECK_RUN.test(words.slice(at).join(" "))) {
			checks++;
			return !elsewhere;
		}
		return at === 0 && readOnlyPart(words, elsewhere);
	});
	return parts && checks > 0;
}
