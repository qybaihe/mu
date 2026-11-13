/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { joinPath } from '@/common/chat/chatLib';

/** The extensions a reply's markdown image syntax carries that render as media in the transcript. */
const MEDIA_PATH_RE = /\.(?:png|jpe?g|webp|gif|bmp|mp4|webm|mov)$/i;

const MARKDOWN_MEDIA_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

const isAbsoluteLocalPath = (path: string): boolean =>
  path.startsWith('/') || path.startsWith('file:') || path.startsWith('\\') || /^[A-Za-z]:/.test(path);

/** The local media paths a reply embeds with the markdown image syntax (images and videos alike). */
export function mediaPathsOf(text: string, workspace?: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(MARKDOWN_MEDIA_RE)) {
    let raw = match[1].trim();
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Keep raw path when percent-encoding is incomplete or literal.
    }
    if (!MEDIA_PATH_RE.test(raw) || /^(?:https?|data):/i.test(raw)) continue;
    paths.push(workspace && !isAbsoluteLocalPath(raw) ? joinPath(workspace, raw) : raw);
  }
  return paths;
}
