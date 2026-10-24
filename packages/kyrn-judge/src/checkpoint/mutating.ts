/**
 * Which tool calls can change files. The first one in a user turn is what a checkpoint is taken
 * before, so a turn that only reads costs nothing.
 *
 * Wrong in the safe direction only: an unknown tool or command counts as changing files (one snapshot
 * more than needed), and a command counts as read-only only when every part of it is on a short list.
 * A shell command is read with `isReadOnlyChain`, which also takes chains of them (`git status; git log -5`), as the
 * permission gate and the constraint gate read it.
 */
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
	/^(?:ls|pwd|cat|head|tail|wc|which|file|stat|du|df|date|whoami|uname|echo|printf|rg|grep|sort|uniq|cut|nl|tree|git\s+(?:status|log|diff|show|blame|rev-parse|ls-files|describe)|Get-ChildItem|gci|dir|Get-Content|gc|type|Get-Location|Select-String|sls|Get-Item|gi|Get-Date|Write-Output|Write-Host)(?:\s|$)/i;

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

/** One program of the list with its arguments, none of which writes a file or starts another program. */
function readOnlyProgram(piece: string): boolean {
	if (!READ_ONLY_PROGRAM.test(piece)) return false;
	const words = piece.split(/\s+/);
	// `--output` writes a file (`git diff`, `sort`), and so does `--out`, the same option cut short.
	if (longOption(words, "output")) return false;
	// A case-insensitive file system finds `rg` for `RG` as well.
	const program = words[0].toLowerCase();
	if (program === "uniq") return !uniqWrites(words);
	if (program === "sort" && longOption(words, "compress-program", 2)) return false;
	if (program === "file" && longOption(words, "compile", 2)) return false;
	return !WRITES_OR_RUNS.get(program)?.test(piece);
}

/**
 * True for a pipeline of plain read-only programs, e.g. `git status`, `cat a.txt | grep x | head -5`. `powershell`:
 * the command is PowerShell's (or may be), which evaluates more than a POSIX shell does where an argument goes.
 */
export function isReadOnlyCommand(command: string, powershell = false): boolean {
	const text = command.trim();
	if (!text || SHELL_TRICKS.test(text) || /--output\b/.test(text)) return false;
	if (powershell && POWERSHELL_TRICKS.test(text)) return false;
	return text.split("|").every((part) => readOnlyProgram(part.trim()));
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
 * The simple commands of a POSIX command line, each as its words with the quoting taken off, split where the shell
 * splits them: at `;`, `&&`, `||`, `|` and line breaks outside quotes. A redirection that only throws output away is
 * left out (see `harmlessRedirect`). Undefined for whatever this does not read the way the shell does, or that can
 * do more than its words say: a substitution, `$'…'`, a heredoc or any other redirection, `&` alone, a subshell, a
 * group or brace expansion, a carriage return, a quote left open.
 */
function simpleCommands(text: string): string[][] | undefined {
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
				const end = harmlessRedirect(text, index + 1, true);
				if (end === undefined) return undefined;
				index = end;
			} else return undefined;
		} else if (char === ">") {
			// `2>`: the digits before it name the output, and are no word.
			if (started && !quoted && /^\d+$/.test(word)) {
				word = "";
				started = false;
			} else endWord();
			const end = harmlessRedirect(text, index, false);
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
 * Git is run only where the conversation started: a repository found elsewhere may carry a config that runs programs
 * (`core.fsmonitor`, a diff driver), so `cd` followed by `git` does not count. PowerShell gets no chains: its
 * command, and a background command on Windows that may run in it, is read as `isReadOnlyCommand` reads it.
 */
export function isReadOnlyChain(command: string, powershell = false): boolean {
	if (powershell) return isReadOnlyCommand(command, true);
	const commands = simpleCommands(command.trim());
	if (!commands?.some((words) => words.length > 0)) return false;
	let moved = false;
	return commands.every((words) => {
		const [program] = words;
		if (program === undefined || program === "true" || program === "false" || program === ":") return true;
		if (program === "cd") {
			moved = true;
			return true;
		}
		if (program === "find") return !words.some((word) => FIND_ACTS.test(word));
		if (moved && program.toLowerCase() === "git") return false;
		return readOnlyProgram(words.join(" "));
	});
}

export function isMutatingCall(toolName: string, input: Readonly<Record<string, unknown>>): boolean {
	if (READ_ONLY_TOOLS.has(toolName)) return false;
	if (isShellTool(toolName)) return !isReadOnlyChain(String(input.command ?? ""), toolName === "powershell");
	return true;
}

const CHECK_COMMAND =
	/\b(?:vitest|jest|pytest|mocha|ava|tsc|eslint|biome|ruff|mypy|rspec|phpunit|ctest|tox|nox|gradle|mvn)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint|typecheck)\b|\b(?:cargo|go|dotnet|swift|make|deno)\s+(?:test|build|check|vet|clippy)\b|\bnode\b[^\n]*--test\b|\btest\.sh\b/;

/** A command whose exit code says whether the work holds up: a test run, a build, a type check, a linter. */
export function isCheckCommand(command: string): boolean {
	return CHECK_COMMAND.test(command);
}
