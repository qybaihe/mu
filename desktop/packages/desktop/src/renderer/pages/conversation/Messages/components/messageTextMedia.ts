/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** The extensions a reply's markdown image syntax carries that render as media in the transcript. */
const MEDIA_PATH_RE = /\.(?:png|jpe?g|webp|gif|bmp|mp4|webm|mov)$/i;

const MARKDOWN_MEDIA_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

/** The local media paths a reply embeds with the markdown image syntax (images and videos alike). */
export function mediaPathsOf(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(MARKDOWN_MEDIA_RE)) {
    const raw = decodeURIComponent(match[1].trim());
    if (MEDIA_PATH_RE.test(raw) && !/^(?:https?|data):/i.test(raw)) paths.push(raw);
  }
  return paths;
}
