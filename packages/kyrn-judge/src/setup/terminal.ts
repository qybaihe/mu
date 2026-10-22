import { createInterface } from "node:readline";
import type { Prompter } from "./wizard.ts";

/**
 * The wizard's questions in a terminal. A key is read with the terminal in raw mode and nothing written back: not the
 * key, not a mark per character. What comes next ("This is a DeepSeek key.") shows that it arrived.
 */

/** Escape sequences (arrow keys, bracketed paste marks): taken out of what is typed, never part of a key. */
const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]/g;

/** One line, echoed and editable as usual. Undefined when the input ended (ctrl+d) or ctrl+c was pressed. */
function askLine(input: NodeJS.ReadStream, output: NodeJS.WriteStream, question: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const lines = createInterface({ input, output, terminal: input.isTTY === true });
		let settled = false;
		const finish = (answer: string | undefined) => {
			if (settled) return;
			settled = true;
			lines.close();
			resolve(answer);
		};
		lines.on("SIGINT", () => {
			output.write("\n");
			finish(undefined);
		});
		lines.on("close", () => finish(undefined));
		lines.question(question, (answer) => finish(answer));
	});
}

/** One line that is not shown. Backspace and ctrl+u edit it, enter ends it, ctrl+c and ctrl+d on an empty line cancel. */
function askSecret(
	input: NodeJS.ReadStream,
	output: NodeJS.WriteStream,
	question: string,
): Promise<string | undefined> {
	// Not a terminal: nothing is echoed anyway.
	if (!input.isTTY) return askLine(input, output, question);
	return new Promise((resolve) => {
		output.write(question);
		const wasRaw = input.isRaw;
		input.setRawMode(true);
		let value = "";
		const finish = (answer: string | undefined) => {
			input.removeListener("data", onData);
			input.setRawMode(wasRaw);
			input.pause();
			output.write("\n");
			resolve(answer);
		};
		const onData = (chunk: Buffer | string) => {
			const text = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).replace(ESCAPES, "");
			for (const char of text) {
				if (char === "\r" || char === "\n") return finish(value);
				if (char === "\u0003") return finish(undefined);
				if (char === "\u0004") {
					if (value === "") return finish(undefined);
				} else if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
				else if (char === "\u0015") value = "";
				else if (char >= " ") value += char;
			}
		};
		input.on("data", onData);
		input.resume();
	});
}

/** Columns a character takes in a terminal: two for the wide CJK ones, one for the rest. */
const columnsOf = (char: string): number =>
	/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
const widthOf = (text: string): number => Array.from(text).reduce((sum, char) => sum + columnsOf(char), 0);

/**
 * Text as lines no wider than `width`, broken between words, so a sentence never splits mid-word at the screen's
 * edge. A line's continuation is indented as far as its text starts: under the words of `  2) Choose…`, not under
 * its number. A word wider than the screen, or text without spaces (Chinese), is left to the terminal.
 */
export function wrapToWidth(text: string, width: number | undefined): string {
	if (!width || width < 20) return text;
	return text
		.split("\n")
		.map((line) => {
			if (widthOf(line) <= width) return line;
			const indent = " ".repeat(/^\s*(?:\d+\)\s+)?/.exec(line)?.[0].length ?? 0);
			const out: string[] = [];
			let current = "";
			for (const word of line.trimEnd().split(/(?<=\S) (?=\S)/)) {
				const next = current ? `${current} ${word}` : word;
				if (current && widthOf(next) > width) {
					out.push(current);
					current = `${indent}${word.trimStart()}`;
				} else current = next;
			}
			out.push(current);
			return out.join("\n");
		})
		.join("\n");
}

export function terminalPrompter(
	input: NodeJS.ReadStream = process.stdin,
	output: NodeJS.WriteStream = process.stdout,
	errors: NodeJS.WriteStream = process.stderr,
): Prompter {
	return {
		say: (text) => output.write(`${wrapToWidth(text, output.isTTY ? output.columns : undefined)}\n`),
		warn: (text) => errors.write(`${wrapToWidth(text, errors.isTTY ? errors.columns : undefined)}\n`),
		ask: (question) => askLine(input, output, question),
		secret: (question) => askSecret(input, output, question),
	};
}

/** All of stdin, for `--key-stdin`. */
export async function readAll(input: NodeJS.ReadStream = process.stdin): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of input) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	return Buffer.concat(chunks).toString("utf8");
}
