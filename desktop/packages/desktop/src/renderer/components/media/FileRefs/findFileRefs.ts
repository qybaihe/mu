/**
 * The file references a reply's markdown holds: its inline code spans that look like a path
 * (common/chat/fileRefs/pathLike.ts) and its links to a local path. Fenced code blocks are left out, and so is plain
 * prose. Each reference is keyed as the markdown view will meet it: an inline code span by its text, trimmed; a link
 * by its file path, decoded, without a `#L12` or `:12` location.
 */
import { fileRefStrength, type FileRefStrength } from '@/common/chat/fileRefs/pathLike';
import {
  resolveLocalFileLinkReference,
  resolveRelativeFileLinkReference,
} from '@/renderer/components/Markdown/markdownUtils';

export type ReplyFileRef = { ref: string; strength: FileRefStrength };

const FENCE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)$/;

/** The markdown with every fenced code block's lines blanked, so nothing inside one is read as a span or a link. */
export function withoutFencedCode(markdown: string): string {
  let open: { mark: string; length: number } | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const fence = FENCE.exec(line);
      if (open) {
        if (fence && fence[1][0] === open.mark && fence[1].length >= open.length && !fence[2].trim()) open = undefined;
        return '';
      }
      // A backtick fence's info string has no backtick (```` ```ts ````); with one, the line is inline code.
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        open = { mark: fence[1][0], length: fence[1].length };
        return '';
      }
      return line;
    })
    .join('\n');
}

const runAt = (text: string, index: number): number => {
  let length = 0;
  while (text[index + length] === '`') length += 1;
  return length;
};

type Found = { at: number; text: string };

/** Where a paragraph ends after `from`: the next blank line, or the end of the text. */
const paragraphEnd = (text: string, from: number): number => {
  const blank = /\n[ \t]*\n/g;
  blank.lastIndex = from;
  return blank.exec(text)?.index ?? text.length;
};

/** The inline code spans of a text with fenced code blanked out, each with where it starts. */
function codeSpansIn(text: string): Found[] {
  const spans: Found[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '`') {
      index += 1;
      continue;
    }
    const length = runAt(text, index);
    let backslashes = 0;
    while (text[index - 1 - backslashes] === '\\') backslashes += 1;
    if (backslashes % 2 === 1) {
      index += 1;
      continue;
    }
    const end = paragraphEnd(text, index);
    let close = -1;
    for (let at = index + length; at < end; ) {
      if (text[at] !== '`') {
        at += 1;
        continue;
      }
      const run = runAt(text, at);
      if (run === length) {
        close = at;
        break;
      }
      at += run;
    }
    if (close < 0) {
      index += length;
      continue;
    }
    let content = text.slice(index + length, close).replace(/\r?\n/g, ' ');
    if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim())
      content = content.slice(1, -1);
    spans.push({ at: index, text: content });
    index = close + length;
  }
  return spans;
}

/** `[text](target)` and `[text](<target with spaces> "title")`; not an image (`![alt](src)`). */
const INLINE_LINK = /\[(?:[^\]\\\n]|\\.)*\]\(\s*(<[^>\n]*>|[^\s()<>]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/** The local file paths a text with fenced code blanked out links to, each with where its link starts. */
function linkPathsIn(text: string): Found[] {
  const paths: Found[] = [];
  for (const match of text.matchAll(INLINE_LINK)) {
    if (match.index > 0 && text[match.index - 1] === '!') continue;
    const target = match[1].startsWith('<') ? match[1].slice(1, -1) : match[1];
    const reference = resolveLocalFileLinkReference(target) ?? resolveRelativeFileLinkReference(target);
    if (reference?.filePath) paths.push({ at: match.index, text: reference.filePath });
  }
  return paths;
}

/**
 * The inline code spans of a markdown text outside fenced code, as CommonMark reads them: a run of backticks opens a
 * span that a run of the same length closes, within one paragraph; line ends become spaces, and one space on each
 * side is dropped when both are there.
 */
export const inlineCodeSpans = (markdown: string): string[] =>
  codeSpansIn(withoutFencedCode(markdown)).map((span) => span.text);

/** The local file paths a markdown text links to, outside fenced code, as the markdown view's links resolve them. */
export const localLinkPaths = (markdown: string): string[] =>
  linkPathsIn(withoutFencedCode(markdown)).map((link) => link.text);

/**
 * Every file reference of a reply, once each, in the order the reply has them: path-like inline code by its own
 * rule, and local links. A link is written as a link, so it is a reference whatever it looks like; one that does not
 * look like a path (`[docs](docs)`) is weak, so a folder or a missing file keeps the link the app always drew.
 */
export function findFileRefs(markdown: string): ReplyFileRef[] {
  // The markdown view drops `file://` before it reads the text; so does this.
  const text = withoutFencedCode(markdown.replace(/file:\/\//g, ''));
  const found: Array<{ at: number; ref: string; strength: FileRefStrength | null }> = [
    ...codeSpansIn(text).map(({ at, text: span }) => ({ at, ref: span.trim(), strength: fileRefStrength(span) })),
    ...linkPathsIn(text).map(({ at, text: path }) => ({
      at,
      ref: path,
      strength: fileRefStrength(path) === 'strong' ? ('strong' as const) : ('weak' as const),
    })),
  ];
  const refs = new Map<string, FileRefStrength>();
  for (const { ref, strength } of found.toSorted((a, b) => a.at - b.at))
    if (strength && !refs.has(ref)) refs.set(ref, strength);
  return [...refs].map(([ref, strength]) => ({ ref, strength }));
}
