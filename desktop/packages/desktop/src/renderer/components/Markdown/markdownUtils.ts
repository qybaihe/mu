/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';

import { diffColors } from '@/renderer/styles/colors';

/**
 * Format raw code string, attempting JSON pretty-print.
 * Falls back to stripped trailing newline if parsing fails.
 */
export const formatCode = (code: string): string => {
  const content = String(code).replace(/\n$/, '');
  try {
    return JSON.stringify(
      JSON.parse(content),
      (_key, value) => {
        return value;
      },
      2
    );
  } catch (_error) {
    return content;
  }
};

/**
 * Conditional render helper — returns trueComponent when condition is true,
 * falseComponent otherwise.
 */
export const logicRender = <T, F>(condition: boolean, trueComponent: T, falseComponent?: F): T | F => {
  return condition ? trueComponent : (falseComponent as F);
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export type LocalFileLinkReference = {
  filePath: string;
  rawReference: string;
  line?: number;
  column?: number;
  endLine?: number;
};

type LocalFileLocation = {
  line?: number;
  column?: number;
  endLine?: number;
  source?: 'hash' | 'colon';
};

type LocalFilePathCandidate = {
  filePath: string;
  hashLocation?: LocalFileLocation;
  hasInvalidHash?: boolean;
};

const parseHashLocation = (hash: string): LocalFileLocation | null => {
  const match = /^#L(\d+)(?:-L(\d+))?$/.exec(hash);
  if (!match) return null;

  const [, lineText, endLineText] = match;
  return {
    line: Number(lineText),
    endLine: endLineText == null ? undefined : Number(endLineText),
    source: 'hash',
  };
};

const splitHashLocation = (href: string): LocalFilePathCandidate => {
  const hashIndex = href.indexOf('#');
  if (hashIndex < 0) return { filePath: href };

  const hashLocation = parseHashLocation(href.slice(hashIndex));
  if (!hashLocation) {
    return {
      filePath: href.slice(0, hashIndex),
      hasInvalidHash: true,
    };
  }

  return {
    filePath: href.slice(0, hashIndex),
    hashLocation,
  };
};

const normalizeFilePath = (path: string): string => {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
};

const normalizeLocalFileHrefToPath = (href: string): LocalFilePathCandidate | null => {
  if (/^https?:\/\//i.test(href)) return null;

  if (/^file:/i.test(href)) {
    try {
      const url = new URL(href);
      const path = normalizeFilePath(safeDecodeURIComponent(url.pathname));
      const rawHash = safeDecodeURIComponent(url.hash);
      if (!rawHash) return { filePath: path };

      const hashLocation = parseHashLocation(rawHash);
      return hashLocation ? { filePath: path, hashLocation } : { filePath: path, hasInvalidHash: true };
    } catch {
      const stripped = href.replace(/^file:(?:\/\/)?/i, '');
      const candidate = splitHashLocation(stripped);
      return {
        ...candidate,
        filePath: normalizeFilePath(candidate.filePath),
      };
    }
  }

  const candidate = splitHashLocation(href);
  const path = candidate.filePath;

  if (/^[A-Za-z]:[\\/]/.test(path)) {
    return {
      ...candidate,
      filePath: path,
    };
  }

  if (/^\/[A-Za-z]:[\\/]/.test(path)) {
    return {
      ...candidate,
      filePath: path.slice(1),
    };
  }

  if (/^\/(Users|home|tmp|private|var|mnt|Volumes)\//.test(path)) return candidate;
  if (/^\/[^/?#]+\/.+\.[^/?#/.]+$/.test(path)) return candidate;

  return null;
};

const splitLocationSuffix = (filePath: string): Omit<LocalFileLinkReference, 'rawReference'> & LocalFileLocation => {
  const lineColumnMatch = /^(.*):(\d+):(\d+)$/.exec(filePath);
  if (lineColumnMatch) {
    const [, pathWithoutLocation, lineText, columnText] = lineColumnMatch;
    if (normalizeLocalFileHrefToPath(pathWithoutLocation)) {
      return {
        filePath: pathWithoutLocation,
        line: Number(lineText),
        column: Number(columnText),
        source: 'colon',
      };
    }
  }

  const lineMatch = /^(.*):(\d+)$/.exec(filePath);
  if (!lineMatch) return { filePath };

  const [, pathWithoutLocation, lineText] = lineMatch;
  if (!normalizeLocalFileHrefToPath(pathWithoutLocation)) return { filePath };

  return {
    filePath: pathWithoutLocation,
    line: Number(lineText),
    source: 'colon',
  };
};

const formatRawReference = (
  reference: Omit<LocalFileLinkReference, 'rawReference'>,
  source?: 'hash' | 'colon'
): string => {
  if (reference.line == null) return reference.filePath;

  if (source === 'hash') {
    return `${reference.filePath}#L${reference.line}${reference.endLine == null ? '' : `-L${reference.endLine}`}`;
  }

  return `${reference.filePath}:${reference.line}${reference.column == null ? '' : `:${reference.column}`}`;
};

export const resolveLocalFileLinkReference = (
  rawHref: string,
  resolvedHref?: string
): LocalFileLinkReference | null => {
  const href = safeDecodeURIComponent((rawHref || resolvedHref || '').trim());
  if (!href) return null;

  const candidate = normalizeLocalFileHrefToPath(href);
  if (!candidate || candidate.hasInvalidHash) return null;

  const colonReference = splitLocationSuffix(candidate.filePath);
  const reference =
    candidate.hashLocation?.line == null
      ? colonReference
      : {
          ...candidate.hashLocation,
          filePath: colonReference.filePath,
        };

  if (!normalizeLocalFileHrefToPath(reference.filePath)) return null;

  const source = candidate.hashLocation?.line == null ? colonReference.source : 'hash';
  const { source: _source, ...publicReference } = reference;
  return {
    ...publicReference,
    rawReference: formatRawReference(publicReference, source),
  };
};

export const resolveLocalFileLinkPath = (rawHref: string, resolvedHref?: string): string | null => {
  return resolveLocalFileLinkReference(rawHref, resolvedHref)?.filePath ?? null;
};

/** A link that is an address of its own kind: a scheme (`https:`, `mailto:`, `vscode:`) or a protocol-relative host. */
const URL_LIKE_HREF_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** `path:12` and `path:12:7`, for a path that is not checked for being absolute. */
const splitRelativeLocationSuffix = (
  filePath: string
): Omit<LocalFileLinkReference, 'rawReference'> & LocalFileLocation => {
  const lineColumnMatch = /^(.+):(\d+):(\d+)$/.exec(filePath);
  if (lineColumnMatch) {
    const [, pathWithoutLocation, lineText, columnText] = lineColumnMatch;
    return { filePath: pathWithoutLocation, line: Number(lineText), column: Number(columnText), source: 'colon' };
  }
  const lineMatch = /^(.+):(\d+)$/.exec(filePath);
  if (!lineMatch) return { filePath };
  const [, pathWithoutLocation, lineText] = lineMatch;
  return { filePath: pathWithoutLocation, line: Number(lineText), source: 'colon' };
};

/**
 * 写成相对路径的链接：`index.html`、`./src/a.ts:12`、`docs/x.md#L3`。模型在工作区里干活，写出来的相对路径指的就是
 * 工作区里的那个文件；`filePath` 保持相对，由打开它的人（知道工作区或文档在哪）去补全。
 * 不算在内的：以 `/` 开头的（`/settings` 可能是应用路由，`/Users/…` 走上面的绝对路径分支）、当前页的片段或
 * 查询（`#top`、`?q`）、带 scheme 的地址、目录。
 *
 * A link written as a path relative to where its writer stands: `index.html`, `./src/a.ts:12`, `docs/x.md#L3`.
 * The model works inside the workspace, so such a path names a file there; `filePath` stays relative and whoever
 * opens it (knowing the workspace, or the document) completes it. Not included: root-relative paths (`/settings`
 * may be an app route, `/Users/…` is the absolute case above), fragments and queries of the current page
 * (`#top`, `?q`), addresses with a scheme, and directories.
 */
export const resolveRelativeFileLinkReference = (rawHref: string): LocalFileLinkReference | null => {
  const href = safeDecodeURIComponent((rawHref || '').trim());
  if (!href || /^[/#?]/.test(href) || URL_LIKE_HREF_RE.test(href)) return null;

  const candidate = splitHashLocation(href);
  if (candidate.hasInvalidHash) return null;
  const colonReference = splitRelativeLocationSuffix(candidate.filePath);
  if (!colonReference.filePath || colonReference.filePath.endsWith('/')) return null;

  const reference =
    candidate.hashLocation?.line == null
      ? colonReference
      : { ...candidate.hashLocation, filePath: colonReference.filePath };
  const source = candidate.hashLocation?.line == null ? colonReference.source : 'hash';
  const { source: _source, ...publicReference } = reference;
  return { ...publicReference, rawReference: formatRawReference(publicReference, source) };
};

/**
 * 一个不是文件的链接该去哪，按作者写下的地址算，而不是按 `<a>` 解析出来的：拿应用自己的页面当基准一解析，
 * `index.html` 或 `#top` 就成了应用本身。协议相对的主机补上 https；片段、查询和空链接哪儿也不去。
 *
 * Where a link that is not a file goes, from the address the writer gave and not from the anchor's resolved one:
 * resolved against the app's own page, `index.html` or `#top` becomes the app itself. A protocol-relative host gets
 * https; fragments, queries and empty links go nowhere.
 */
export const resolveWebLinkHref = (rawHref: string): string | null => {
  const href = (rawHref || '').trim();
  if (!href || /^[#?]/.test(href)) return null;
  if (href.startsWith('//')) return `https:${href}`;
  return URL_LIKE_HREF_RE.test(href) ? href : null;
};

export const toLocalFileHref = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const withScheme = /^[A-Za-z]:\//.test(normalized) ? `file:///${normalized}` : `file://${normalized}`;
  return encodeURI(withScheme);
};

/**
 * Get line background style for diff rendering.
 * Highlights additions (green), deletions (red), and hunk headers (blue).
 */
export const getDiffLineStyle = (line: string, isDark: boolean): React.CSSProperties => {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return { backgroundColor: isDark ? diffColors.additionBgDark : diffColors.additionBgLight };
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return { backgroundColor: isDark ? diffColors.deletionBgDark : diffColors.deletionBgLight };
  }
  if (line.startsWith('@@')) {
    return { backgroundColor: isDark ? diffColors.hunkBgDark : diffColors.hunkBgLight };
  }
  return {};
};

export type DiagramSize = { width: number; height: number };

/**
 * Cap an inline SVG diagram at min(container, natural width): narrow diagrams
 * (e.g. top-down layouts) render 1:1 at their natural size instead of being
 * stretched across the message column; wide diagrams still fit the column.
 * Shared by MermaidBlock and WavedromBlock.
 */
export const withResponsiveSvg = (svg: string): string => {
  const intrinsicWidth = getSvgIntrinsicSize(svg)?.width;
  const maxWidth = intrinsicWidth ? `min(100%, ${intrinsicWidth}px)` : '100%';
  return svg.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    if (/style\s*=/.test(attrs)) {
      return `<svg${attrs.replace(
        /style\s*=\s*(["'])(.*?)\1/i,
        (_styleMatch, quote: string, styleValue: string) =>
          ` style=${quote}${styleValue};max-width: ${maxWidth}; height: auto; display: block;${quote}`
      )}>`;
    }
    return `<svg${attrs} style="max-width: ${maxWidth}; height: auto; display: block;">`;
  });
};

/**
 * Extract a diagram SVG's natural size from its markup so callers can size it by
 * its own aspect ratio instead of by the container. Mermaid always emits a
 * viewBox; numeric width/height attributes are a fallback for hand-written SVGs.
 */
export const getSvgIntrinsicSize = (svg: string): DiagramSize | null => {
  const svgTag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!svgTag) return null;

  const viewBox = /viewBox\s*=\s*["']\s*[\d.eE+-]+\s+[\d.eE+-]+\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s*["']/i.exec(svgTag);
  if (viewBox) {
    const width = parseFloat(viewBox[1]);
    const height = parseFloat(viewBox[2]);
    if (width > 0 && height > 0) return { width, height };
  }

  const widthAttr = /width\s*=\s*["']([\d.]+)\s*(?:px)?["']/i.exec(svgTag);
  const heightAttr = /height\s*=\s*["']([\d.]+)\s*(?:px)?["']/i.exec(svgTag);
  if (widthAttr && heightAttr) {
    const width = parseFloat(widthAttr[1]);
    const height = parseFloat(heightAttr[1]);
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
};

/**
 * A reply is drawn again each time it grows, and parsing its Markdown costs as much as the reply is long: drawing a
 * long reply as it streams in was quadratic, and the last paragraphs of a long answer stuttered. Cut into its top-level
 * blocks, only the block still being written is parsed again; the blocks before it are the same text, and are kept.
 *
 * A cut is made only where it cannot change what the Markdown means: at a blank line, outside a code fence or a `$$`
 * block, before a line that starts a block of its own (not an indented continuation, not the next item of a list,
 * which a blank line makes loose). Text with link or footnote definitions, which reach across the whole text, is not
 * cut at all.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MATH_FENCE = /^ {0,3}\$\$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

/** The text cut into blocks that each parse as they would in the whole; the whole as one block where none can be cut. */
export function splitMarkdownBlocks(text: string): string[] {
  if (!text.includes('\n\n') || DEFINITION.test(text) || text.includes('<!--')) return [text];
  const lines = text.split('\n');
  const blocks: string[] = [];
  let start = 0;
  let fence: string | undefined;
  let math = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const opener = FENCE.exec(line);
    if (opener) {
      const marker = opener[1];
      if (fence === undefined) fence = marker[0].repeat(marker.length);
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (MATH_FENCE.test(line)) {
      // A one-line `$$ x $$` opens and closes at once.
      if (!/\$\$.*\$\$/.test(line.trim())) math = !math;
      continue;
    }
    if (math || line.trim() !== '') continue;
    // A blank line: cut before the next line that is not blank, if it starts a block of its own.
    let next = index + 1;
    while (next < lines.length && lines[next].trim() === '') next++;
    if (next >= lines.length) break;
    const following = lines[next];
    if (/^\s/.test(following) || LIST_ITEM.test(following)) continue;
    blocks.push(lines.slice(start, next).join('\n'));
    start = next;
    index = next - 1;
  }
  blocks.push(lines.slice(start).join('\n'));
  return blocks;
}
