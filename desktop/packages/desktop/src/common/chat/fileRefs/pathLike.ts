/**
 * Which inline code spans in a reply name a file (renderer/components/media/FileRefs/). The rule is conservative on
 * purpose: ordinary code (`foo.bar`, `a/b`, `npm run build`, `x.length`, `console.log()`) must never read as a path.
 * A span that passes is only a candidate: it becomes a link when the main process finds a regular file by it
 * (process/services/fileRefs/).
 *
 * - `strong`: clearly a path. Found, it is a link; not found, it is greyed out as missing.
 * - `weak`: may be a path or may be code (`index.ts`, `console.log`, `My Report.pdf`). Found, it is a link; not found,
 *   it stays plain code.
 */

export type FileRefStrength = 'strong' | 'weak';

/** The longest reference looked at. */
export const FILE_REF_MAX_LENGTH = 1024;

/** Images the preview panel shows (Chromium decodes them; TIFF and HEIC it cannot, so those open in the system app). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
]);

/** Documents and media: a bare name with one of these is a file reference, never code. */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...IMAGE_EXTENSIONS,
  'tif',
  'tiff',
  'heic',
  'heif',
  'psd',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'epub',
  'csv',
  'tsv',
  'txt',
  'md',
  'markdown',
  'mp3',
  'wav',
  'flac',
  'aac',
  'm4a',
  'ogg',
  'mp4',
  'mov',
  'm4v',
  'avi',
  'mkv',
  'webm',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
]);

/**
 * Code, configuration and other files whose bare name can also be code (`index.ts`, `res.json`, `mutex.lock`). Domain
 * endings (`com`, `io`, `dev`, `ai`) are left out: `example.com` is not a file.
 */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'json',
  'jsonc',
  'json5',
  'jsonl',
  'ndjson',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'vue',
  'svelte',
  'astro',
  'mdx',
  'rst',
  'tex',
  'bib',
  'py',
  'pyi',
  'ipynb',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'scala',
  'dart',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'cs',
  'php',
  'pl',
  'lua',
  'sql',
  'sqlite',
  'graphql',
  'gql',
  'proto',
  'ex',
  'exs',
  'erl',
  'hs',
  'ml',
  'elm',
  'clj',
  'zig',
  'nix',
  'tf',
  'hcl',
  'gradle',
  'properties',
  'plist',
  'lock',
  'log',
  'diff',
  'patch',
  'srt',
  'vtt',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'dockerfile',
  'exe',
  'msi',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'apk',
  'jar',
  'appimage',
  'wasm',
]);

/** Words that start a command line: `open report.pdf` is a command, not a file named so. */
const COMMAND_WORDS: ReadonlySet<string> = new Set([
  'bash',
  'brew',
  'bun',
  'bunx',
  'cargo',
  'cat',
  'cd',
  'chmod',
  'chown',
  'code',
  'cp',
  'curl',
  'deno',
  'docker',
  'echo',
  'git',
  'go',
  'head',
  'java',
  'kubectl',
  'less',
  'ls',
  'make',
  'mkdir',
  'mu',
  'mv',
  'nano',
  'node',
  'npm',
  'npx',
  'open',
  'pip',
  'pip3',
  'pnpm',
  'python',
  'python3',
  'rm',
  'ruby',
  'sh',
  'source',
  'start',
  'sudo',
  'tail',
  'touch',
  'tsc',
  'uv',
  'vim',
  'wget',
  'xdg-open',
  'yarn',
  'zsh',
]);

/** Characters no reference holds: shell operators, quotes, globs, braces and URL pieces. */
const FORBIDDEN = /[|&;<>`$*?{}"'=!#%,]/;

/** Whether a text holds a control character (a line end, a tab, NUL): no path a reply names does. */
export function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
/** A scheme (`https:`, `mailto:`, `vscode:`), which a drive letter is not. */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;
/** A call: a name followed by `(`. A copy's ` (1)` before the extension is not one. */
const CALL = /[\w$\]]\(/;
/** `:12` or `:12:7` after a path: a line and a column. */
const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/;
/** Where a path starts at a fixed place: the root, home, here, the parent, or a drive. */
const ANCHORED = /^(?:\/|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/;

/** A reference with its `:line` or `:line:column` taken off. */
export function withoutLineSuffix(reference: string): string {
  const match = LINE_SUFFIX.exec(reference);
  return match ? reference.slice(0, match.index) : reference;
}

/** The last name of a path, either separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The extension of a path's last name, lowercased; `''` when it has none or the name is a dotfile (`.env`). */
export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The extension of a span that may be a path, as extensionOf, except that a mixed-case one is none: `Command` in
 * `exec.Command` is a type, while `PNG` and `png` are extensions.
 */
function spanExtension(path: string): string {
  const extension = extensionOf(path);
  const written = path.slice(path.length - extension.length);
  return written === extension || written === extension.toUpperCase() ? extension : '';
}

/** Whether a path names an image the preview panel can show. */
export const isImagePath = (path: string): boolean => IMAGE_EXTENSIONS.has(extensionOf(path));

const isKnownExtension = (extension: string): boolean =>
  DOCUMENT_EXTENSIONS.has(extension) || CODE_EXTENSIONS.has(extension);

/** A name's stem holds a letter or a digit in any script (`_` alone, as in `_.zip`, does not). */
const hasRealStem = (name: string): boolean => /[\p{L}\p{N}]/u.test(name.slice(0, name.lastIndexOf('.')));

/**
 * How surely an inline code span names a file, or `null` when it does not. A span may hold spaces only when the whole
 * span is a file name with a known extension (`My Report.pdf`), not a command (`open report.pdf`, `ls -la a.txt`).
 * A `:line` or `:line:column` suffix is allowed.
 */
export function fileRefStrength(span: string): FileRefStrength | null {
  const text = span.trim();
  if (!text || text.length > FILE_REF_MAX_LENGTH) return null;
  if (FORBIDDEN.test(text) || hasControlCharacter(text)) return null;
  // A network share or a protocol-relative address: never looked up.
  if (text.startsWith('//') || text.startsWith('\\\\')) return null;
  const path = withoutLineSuffix(text);
  if (SCHEME.test(path)) return null;
  if (CALL.test(path)) return null;
  // Brackets are names in some frameworks' routes (`app/[id]/page.tsx`); other parentheses are code.
  if (/[()]/.test(path.replace(/ \(\d+\)/g, ''))) return null;
  if (path.includes(':') && !/^[A-Za-z]:[\\/]/.test(path)) return null;

  const extension = spanExtension(path);
  const known = isKnownExtension(extension) && hasRealStem(baseName(path));
  const spaced = /\s/.test(path);
  if (spaced) {
    const words = path.split(/\s+/);
    if (!known || words.some((word) => word.startsWith('-')) || COMMAND_WORDS.has(words[0].toLowerCase())) return null;
  }

  if (ANCHORED.test(path)) {
    if (known) return 'strong';
    // `/api/users`, `/help` and `~/Downloads` may be routes, commands or folders: found as a file, a link; else plain.
    return spaced ? null : 'weak';
  }
  if (!known) return null;
  if (spaced) return 'weak';
  if (/[\\/]/.test(path)) return 'strong';
  return DOCUMENT_EXTENSIONS.has(extension) ? 'strong' : 'weak';
}
