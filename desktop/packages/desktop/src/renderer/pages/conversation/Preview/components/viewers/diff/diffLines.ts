/**
 * The lines of a diff as diff2html draws them (line by line), read back from the page for a comment on one of them:
 * its file, its number on the side it belongs to (a removed line has only the old one), what kind of line it is and
 * its text. Also how a comment is said in the message and named on its chip.
 */
import type { DiffLineComment } from '../../../context/PreviewContext';

export type DiffLineKind = 'added' | 'removed' | 'context';

/** One line of the diff, where a comment can go. */
export type DiffLineAt = Omit<DiffLineComment, 'text'> & { kind: DiffLineKind; text: string };

/** Rows this viewer adds under a line (a comment, the comment being written): never a line of the diff. */
export const NOTE_ROW_CLASS = 'mu-diff-note';

const numberIn = (cell: Element | null, selector: string): number | undefined => {
  const value = Number.parseInt(cell?.querySelector(selector)?.textContent?.trim() ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

/**
 * The file a row belongs to: the name in its file's header; a renamed file by its new name. diff2html writes a rename
 * as `old → new`, or only the part that changed, in braces: `src/{old → new}/name.ts`.
 */
export function fileOfRow(row: Element): string | undefined {
  const name = row.closest('.d2h-file-wrapper')?.querySelector('.d2h-file-name')?.textContent?.trim();
  if (!name) return undefined;
  const renamed = name
    .replace(/\{[^{}]*→\s*([^{}]*)\}/, '$1')
    .replace(/\/{2,}/g, '/')
    .split('→');
  return renamed[renamed.length - 1].trim() || undefined;
}

/** The line a row of the diff shows, or undefined for a hunk's header, an empty file's notice or a note. */
export function lineOfRow(row: Element): DiffLineAt | undefined {
  if (row.tagName !== 'TR' || row.classList.contains(NOTE_ROW_CLASS)) return undefined;
  const numbers = row.querySelector('td.d2h-code-linenumber');
  const code = numbers?.nextElementSibling;
  if (!numbers || !code || code.classList.contains('d2h-info')) return undefined;
  const file = fileOfRow(row);
  if (!file) return undefined;
  const kind: DiffLineKind = code.classList.contains('d2h-ins')
    ? 'added'
    : code.classList.contains('d2h-del')
      ? 'removed'
      : 'context';
  const side = kind === 'removed' ? 'old' : 'new';
  const line = numberIn(numbers, side === 'old' ? '.line-num1' : '.line-num2');
  if (line === undefined) return undefined;
  const text = code.querySelector('.d2h-code-line-ctn')?.textContent ?? '';
  return { file, side, line, kind, text };
}

/** The last row under a line that is a note of this viewer's, or the line's row when it has none. */
export function lastNoteUnder(row: Element): Element {
  const next = row.nextElementSibling;
  return next?.classList.contains(NOTE_ROW_CLASS) ? lastNoteUnder(next) : row;
}

export const sameLine = (a: Omit<DiffLineComment, 'text'>, b: Omit<DiffLineComment, 'text'>): boolean =>
  a.file === b.file && a.side === b.side && a.line === b.line;

/** The row that shows a line, in the diff as drawn now. */
export function rowOfLine(container: Element, at: Omit<DiffLineComment, 'text'>): HTMLTableRowElement | undefined {
  for (const row of container.querySelectorAll<HTMLTableRowElement>('tr')) {
    const line = lineOfRow(row);
    if (line && sameLine(line, at)) return row;
  }
  return undefined;
}

const PREFIX: Record<DiffLineKind, string> = { added: '+', removed: '-', context: ' ' };
const WHERE: Record<DiffLineKind, string> = { added: 'added line', removed: 'removed line', context: 'line' };

/** The last name of a path. */
const baseName = (path: string): string => path.split(/[\\/]/).findLast(Boolean) ?? path;

/**
 * A comment as the send box keeps it: the chip's name (`app.ts:42`), what the message says (where, and the words),
 * and the line itself as a line of a diff.
 */
export function describeDiffComment(at: DiffLineAt, text: string): { label: string; about: string; code: string } {
  const numbering = at.kind === 'removed' ? ' (old numbering)' : '';
  return {
    label: `${baseName(at.file)}:${at.line}`,
    about: `Comment on \`${at.file}\`, ${WHERE[at.kind]} ${at.line}${numbering}:\n${text.trim()}`,
    code: `${PREFIX[at.kind]}${at.text}`,
  };
}
