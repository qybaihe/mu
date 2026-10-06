/**
 * What the form for a new MCP server reads from what a person types: one command line, as a terminal takes it, and
 * lines of `NAME=value` or `Name: value`. The main process checks the result again before it writes anything.
 */

/**
 * The words of a command line: split at spaces, except inside single or double quotes; a backslash takes the next
 * character as it is, except inside single quotes. Undefined when a quote is left open.
 */
export function splitCommandLine(line: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === '\\' && quote === '"' && index + 1 < line.length) word += line[++index];
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (character === '\\' && index + 1 < line.length) {
      word += line[++index];
      started = true;
    } else if (/\s/.test(character)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

/**
 * Lines of `name<separator>value`, blank lines skipped; the value keeps everything after the first separator, its
 * outer spaces trimmed. The number of the first line that is not of that shape (from 1) when there is one.
 */
export function readPairLines(
  text: string,
  separator: '=' | ':'
): { pairs: Record<string, string> } | { badLine: number } {
  const pairs: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    const name = at > 0 ? line.slice(0, at).trim() : '';
    if (!name || /\s/.test(name)) return { badLine: index + 1 };
    pairs[name] = line.slice(at + 1).trim();
  }
  return { pairs };
}
