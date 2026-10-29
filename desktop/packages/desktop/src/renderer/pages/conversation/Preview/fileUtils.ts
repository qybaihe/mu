/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PreviewContentType } from '@/common/types/office/preview';

/**
 * 文件扩展名到内容类型的映射配置
 * Mapping configuration from file extensions to content types
 */
export const FILE_EXTENSION_MAP: Record<PreviewContentType, readonly string[]> = {
  markdown: ['md', 'markdown', 'mdown', 'mkd'],
  html: ['html', 'htm'],
  pdf: ['pdf'],
  // Only what officecli actually renders. `.doc/.odt` moved to `unsupported`:
  // routing them here produced a failure that told the user to install officecli,
  // which does not help for a format it cannot open.
  word: ['docx'],
  ppt: ['pptx'],
  excel: ['xlsx'],
  // CSV is plain text, and officecli rejects it outright — so it reads as text
  // rather than failing in a spreadsheet renderer.
  csv: ['csv'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'avif'],
  code: [], // code 作为默认类型，不需要显式映射 / code is the default type, no explicit mapping needed
  diff: ['diff', 'patch'],
  /**
   * Identifiable but genuinely unrenderable here — say so, and offer the escape
   * hatch, instead of failing inside a renderer that never had a chance:
   *
   * - `doc/xls/ppt` legacy Office binaries and `odt/ods/odp` ODF: officecli only
   *   handles the OOXML trio.
   * - `docm/xlsm/pptm` macro-enabled: officecli's factory claims them, but its
   *   watch path accepts only pptx/docx/xlsx, so they fail on startup instead.
   * - `heic`: Chromium has no HEVC decoder (licensing), so mapping it to `image`
   *   yields a broken-image placeholder with no explanation — strictly worse than
   *   saying it is unsupported.
   */
  unsupported: ['doc', 'xls', 'ppt', 'odt', 'ods', 'odp', 'docm', 'xlsm', 'pptm', 'heic'],
  url: [], // url 类型用于网页预览，无扩展名映射 / url type for web preview, no extension mapping
  browser: [], // browser 类型用于应用内浏览器 tab，无扩展名映射 / browser type for in-app browser tabs, no extension mapping
};

/**
 * 从文件路径中提取文件扩展名
 * Extract file extension from file path
 *
 * @param file_path - 文件路径 / File path
 * @returns 文件扩展名（小写），如果没有扩展名则返回空字符串 / File extension in lowercase, or empty string if no extension
 *
 * @example
 * ```ts
 * getFileExtension('document.pdf') // => 'pdf'
 * getFileExtension('archive.tar.gz') // => 'gz'
 * getFileExtension('noextension') // => ''
 * getFileExtension('image.PNG') // => 'png'
 * ```
 */
export const getFileExtension = (file_path: string): string => {
  if (!file_path) return '';

  const lastDotIndex = file_path.lastIndexOf('.');
  // 没有点号，或点号在最后（如 "file."），返回空字符串
  // No dot, or dot at the end (e.g., "file."), return empty string
  if (lastDotIndex === -1 || lastDotIndex === file_path.length - 1) {
    return '';
  }

  return file_path.substring(lastDotIndex + 1).toLowerCase();
};

/**
 * 根据文件扩展名确定预览内容类型
 * Determine preview content type based on file extension
 *
 * @param file_path - 文件路径 / File path
 * @returns 预览内容类型 / Preview content type
 *
 * @example
 * ```ts
 * getContentTypeByExtension('README.md') // => 'markdown'
 * getContentTypeByExtension('index.html') // => 'html'
 * getContentTypeByExtension('report.pdf') // => 'pdf'
 * getContentTypeByExtension('script.ts') // => 'code'
 * getContentTypeByExtension('image.png') // => 'image'
 * ```
 */
export const getContentTypeByExtension = (file_path: string): PreviewContentType => {
  const ext = getFileExtension(file_path);
  if (!ext) return 'code'; // 没有扩展名，默认为 code / No extension, default to code

  // 遍历映射表查找匹配的内容类型 / Iterate through mapping to find matching content type
  for (const [contentType, extensions] of Object.entries(FILE_EXTENSION_MAP)) {
    if (extensions.includes(ext)) {
      return contentType as PreviewContentType;
    }
  }

  // 未找到匹配的扩展名，默认为 code / No matching extension found, default to code
  return 'code';
};

/**
 * 检查文件是否为图片类型
 * Check if file is an image type
 *
 * @param file_path - 文件路径 / File path
 * @returns 是否为图片 / Whether it's an image
 */
export const isImageFile = (file_path: string): boolean => {
  return getContentTypeByExtension(file_path) === 'image';
};

/**
 * 检查文件是否为文本类型（可编辑）
 * Check if file is a text type (editable)
 *
 * @param file_path - 文件路径 / File path
 * @returns 是否为文本类型 / Whether it's a text type
 */
export const isTextFile = (file_path: string): boolean => {
  const contentType = getContentTypeByExtension(file_path);
  return ['markdown', 'html', 'code', 'csv'].includes(contentType);
};

/**
 * 检查文件是否为 Office 文档类型
 * Check if file is an Office document type
 *
 * @param file_path - 文件路径 / File path
 * @returns 是否为 Office 文档 / Whether it's an Office document
 */
export const isOfficeFile = (file_path: string): boolean => {
  const contentType = getContentTypeByExtension(file_path);
  return ['word', 'excel', 'ppt'].includes(contentType);
};

/**
 * Text files the preview reads as code. A name with no mapped type falls to `code`, which would draw a binary file as
 * noise, so a file named in a reply opens in the panel only when its type is known to read as text.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    'ts tsx mts cts js jsx mjs cjs json jsonc json5 jsonl ndjson py pyi rb go rs java',
    'kt kts swift c h cc cpp cxx hpp hh cs m mm php pl pm lua r scala sh bash zsh',
    'fish ps1 bat cmd sql graphql gql proto yaml yml toml ini cfg conf env txt text',
    'log css scss sass less styl vue svelte astro xml xsd xsl plist gradle dart ex',
    'exs erl hrl hs clj cljs elm ml mli fs fsx tf tfvars hcl nix zig vim lock',
    'gitignore gitattributes dockerignore editorconfig npmrc nvmrc rst tex bib adoc',
    'org properties mk cmake sbt jl rkt scm lisp el sol prisma tsv',
  ]
    .join(' ')
    .split(' ')
);

/** Text files that carry no extension. */
const TEXT_NAMES: ReadonlySet<string> = new Set([
  'makefile',
  'dockerfile',
  'containerfile',
  'license',
  'licence',
  'readme',
  'gemfile',
  'procfile',
  'justfile',
  'rakefile',
  'brewfile',
  'vagrantfile',
  'codeowners',
  'notice',
  'authors',
  'changelog',
]);

/**
 * Whether the preview panel draws this file well: a type it renders (Markdown, HTML, PDF, CSV, images, diffs) or text
 * it shows as code. Anything else is left to the system's own app, Office files too: the panel draws them only with
 * officecli installed, and the system's app opens them better anyway.
 */
export const isPanelPreviewable = (file_path: string): boolean => {
  const contentType = getContentTypeByExtension(file_path);
  if (contentType === 'unsupported' || isOfficeFile(file_path)) return false;
  if (contentType !== 'code') return true;
  const ext = getFileExtension(file_path);
  if (ext) return TEXT_EXTENSIONS.has(ext);
  const name = file_path.split(/[\\/]/).pop() ?? '';
  return TEXT_NAMES.has(name.toLowerCase());
};
