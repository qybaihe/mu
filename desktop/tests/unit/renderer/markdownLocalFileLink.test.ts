/**
 * @license
 * Copyright 2025 mu (mu.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  resolveLocalFileLinkPath,
  resolveLocalFileLinkReference,
  resolveRelativeFileLinkReference,
  resolveWebLinkHref,
  toLocalFileHref,
} from '@/renderer/components/Markdown/markdownUtils';

describe('resolveLocalFileLinkPath', () => {
  it('recognizes Windows absolute paths emitted as root-relative markdown links', () => {
    expect(resolveLocalFileLinkPath('/C:/Users/Administrator/AppData/Roaming/mu/report.xlsx')).toBe(
      'C:/Users/Administrator/AppData/Roaming/mu/report.xlsx'
    );
  });

  it('recognizes encoded file URLs', () => {
    expect(resolveLocalFileLinkPath('file:///C:/Users/Administrator/%E7%9C%8B%E6%9D%BF.xlsx')).toBe(
      'C:/Users/Administrator/看板.xlsx'
    );
  });

  it('recognizes common POSIX absolute paths', () => {
    expect(resolveLocalFileLinkPath('/Users/demo/outputs/report.xlsx')).toBe('/Users/demo/outputs/report.xlsx');
  });

  it('recognizes file-like POSIX absolute paths outside common home and temp roots', () => {
    expect(resolveLocalFileLinkPath('/opt/mu/outputs/report.xlsx')).toBe('/opt/mu/outputs/report.xlsx');
  });

  it('recognizes line suffixes without confusing Windows drive letters', () => {
    const reference = resolveLocalFileLinkReference('C:/Users/Administrator/AppData/Roaming/mu/logs/app.log:1421');

    expect(reference).toEqual({
      filePath: 'C:/Users/Administrator/AppData/Roaming/mu/logs/app.log',
      rawReference: 'C:/Users/Administrator/AppData/Roaming/mu/logs/app.log:1421',
      line: 1421,
    });
    expect(resolveLocalFileLinkPath('C:/Users/Administrator/AppData/Roaming/mu/logs/app.log:1421')).toBe(
      'C:/Users/Administrator/AppData/Roaming/mu/logs/app.log'
    );
  });

  it('recognizes line and column suffixes without including the line in the file path', () => {
    const reference = resolveLocalFileLinkReference('C:/Users/Administrator/AppData/Roaming/mu/logs/app.log:1421:7');

    expect(reference).toEqual({
      filePath: 'C:/Users/Administrator/AppData/Roaming/mu/logs/app.log',
      rawReference: 'C:/Users/Administrator/AppData/Roaming/mu/logs/app.log:1421:7',
      line: 1421,
      column: 7,
    });
    expect(resolveLocalFileLinkPath('C:/Users/Administrator/AppData/Roaming/mu/logs/app.log:1421:7')).toBe(
      'C:/Users/Administrator/AppData/Roaming/mu/logs/app.log'
    );
  });

  it('recognizes POSIX hash line references', () => {
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#L10')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#L10-L20')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10-L20',
      line: 10,
      endLine: 20,
    });
  });

  it('recognizes file URL hash line references and normalizes raw references', () => {
    expect(resolveLocalFileLinkReference('file:///Users/demo/file.ts#L10')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('file:///Users/demo/file.ts#L10-L20')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10-L20',
      line: 10,
      endLine: 20,
    });

    expect(resolveLocalFileLinkReference('file:///Users/demo/My%20File.ts#L10')).toEqual({
      filePath: '/Users/demo/My File.ts',
      rawReference: '/Users/demo/My File.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('file:///Users/demo/%E6%96%87%E4%BB%B6.ts#L10')).toEqual({
      filePath: '/Users/demo/文件.ts',
      rawReference: '/Users/demo/文件.ts#L10',
      line: 10,
    });
  });

  it('recognizes Windows file URL hash lines and ranges', () => {
    expect(resolveLocalFileLinkReference('file:///C:/Users/demo/file.ts#L10')).toEqual({
      filePath: 'C:/Users/demo/file.ts',
      rawReference: 'C:/Users/demo/file.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('file:///C:/Users/demo/file.ts#L10-L20')).toEqual({
      filePath: 'C:/Users/demo/file.ts',
      rawReference: 'C:/Users/demo/file.ts#L10-L20',
      line: 10,
      endLine: 20,
    });
  });

  it('prioritizes hash line references over colon suffixes', () => {
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts:10#L20')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L20',
      line: 20,
    });
  });

  it('rejects unsupported hash line formats and remote hash links', () => {
    expect(resolveLocalFileLinkReference('user.ts')).toBeNull();
    expect(resolveLocalFileLinkReference('./user.ts')).toBeNull();
    expect(resolveLocalFileLinkReference('../user.ts')).toBeNull();
    expect(resolveLocalFileLinkReference('/settings')).toBeNull();
    expect(resolveLocalFileLinkReference('https://mu.com/docs#L10')).toBeNull();
    expect(resolveLocalFileLinkReference('https://github.com/org/repo/blob/main/file.ts#L10')).toBeNull();
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#l10')).toBeNull();
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#L10-l20')).toBeNull();
  });

  it('does not treat normal web links or app routes as local files', () => {
    expect(resolveLocalFileLinkPath('https://mu.com/docs')).toBeNull();
    expect(resolveLocalFileLinkPath('/settings')).toBeNull();
  });

  it('formats local file paths as file URLs for browser link copying', () => {
    expect(toLocalFileHref('C:/Users/Administrator/AppData/Roaming/mu/report.xlsx')).toBe(
      'file:///C:/Users/Administrator/AppData/Roaming/mu/report.xlsx'
    );
    expect(toLocalFileHref('/var/folders/demo/report.xlsx')).toBe('file:///var/folders/demo/report.xlsx');
  });
});

describe('resolveRelativeFileLinkReference', () => {
  it('reads a path written relative to the workspace as a file, keeping it relative', () => {
    expect(resolveRelativeFileLinkReference('index.html')).toEqual({
      filePath: 'index.html',
      rawReference: 'index.html',
    });
    expect(resolveRelativeFileLinkReference('./src/a.ts')).toEqual({
      filePath: './src/a.ts',
      rawReference: './src/a.ts',
    });
    expect(resolveRelativeFileLinkReference('../shared/x.md')).toEqual({
      filePath: '../shared/x.md',
      rawReference: '../shared/x.md',
    });
    expect(resolveRelativeFileLinkReference('Makefile')).toEqual({ filePath: 'Makefile', rawReference: 'Makefile' });
  });

  it('reads line references the same way as absolute links', () => {
    expect(resolveRelativeFileLinkReference('src/a.ts:12')).toEqual({
      filePath: 'src/a.ts',
      line: 12,
      rawReference: 'src/a.ts:12',
    });
    expect(resolveRelativeFileLinkReference('src/a.ts:12:7')).toEqual({
      filePath: 'src/a.ts',
      line: 12,
      column: 7,
      rawReference: 'src/a.ts:12:7',
    });
    expect(resolveRelativeFileLinkReference('docs/x.md#L3-L9')).toEqual({
      filePath: 'docs/x.md',
      line: 3,
      endLine: 9,
      rawReference: 'docs/x.md#L3-L9',
    });
    expect(resolveRelativeFileLinkReference('docs/x.md#intro')).toBeNull();
  });

  it('leaves addresses, fragments, app routes and directories alone', () => {
    expect(resolveRelativeFileLinkReference('https://mu.com/docs')).toBeNull();
    expect(resolveRelativeFileLinkReference('mailto:hi@example.com')).toBeNull();
    expect(resolveRelativeFileLinkReference('//cdn.example.com/a.js')).toBeNull();
    expect(resolveRelativeFileLinkReference('#top')).toBeNull();
    expect(resolveRelativeFileLinkReference('?q=1')).toBeNull();
    expect(resolveRelativeFileLinkReference('/settings')).toBeNull();
    expect(resolveRelativeFileLinkReference('docs/')).toBeNull();
    expect(resolveRelativeFileLinkReference('')).toBeNull();
  });
});

describe('resolveWebLinkHref', () => {
  it('opens addresses as written', () => {
    expect(resolveWebLinkHref('https://mu.com/docs#L10')).toBe('https://mu.com/docs#L10');
    expect(resolveWebLinkHref('mailto:hi@example.com')).toBe('mailto:hi@example.com');
    expect(resolveWebLinkHref('//cdn.example.com/a.js')).toBe('https://cdn.example.com/a.js');
  });

  it('sends nothing to the app itself: fragments, queries and unresolved paths go nowhere', () => {
    expect(resolveWebLinkHref('#top')).toBeNull();
    expect(resolveWebLinkHref('?q=1')).toBeNull();
    expect(resolveWebLinkHref('index.html')).toBeNull();
    expect(resolveWebLinkHref('/settings')).toBeNull();
    expect(resolveWebLinkHref('')).toBeNull();
  });
});
