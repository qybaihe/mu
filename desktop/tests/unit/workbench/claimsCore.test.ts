/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  announcesWork,
  claimsFor,
  fileCheckCandidates,
  fileRefsOf,
  inProgressClaimOf,
  resolveClaimPath,
} from '@/renderer/pages/workbench/team/claimsCore';

describe('fileRefsOf', () => {
  it('collects deliberate markdown file links in order, deduplicated', () => {
    const text = 'See [report](E:/work/report.md) and [again](E:/work/report.md), then [log](src/run.log).';
    expect(fileRefsOf(text)).toEqual(['E:/work/report.md', 'src/run.log']);
  });

  it('skips folders, globs, http, bare ~, and links inside code', () => {
    const text = [
      '[dir](E:/work/)',
      '[wild](E:/work/*.md)',
      '[web](https://a.b/c)',
      '[home](~)',
      '```ts',
      '[in code](E:/x.md)',
      '```',
      '[ok](E:/real.md)',
    ].join('\n');
    expect(fileRefsOf(text)).toEqual(['E:/real.md']);
  });

  it('keeps links with line and hash fragments, decoded like the chat opens them', () => {
    expect(fileRefsOf('[f](E:/a%20b.md:12)')).toEqual(['E:/a b.md:12']);
    expect(fileRefsOf('[f](src/x.md#L12-L20)')).toEqual(['src/x.md']);
    expect(fileRefsOf('[f](src/x.md#section)')).toEqual([]);
  });

  it('tolerates empty and non-string input', () => {
    expect(fileRefsOf('')).toEqual([]);
    expect(fileRefsOf(undefined as unknown as string)).toEqual([]);
  });
});

describe('resolveClaimPath / fileCheckCandidates', () => {
  it('resolves relative paths against the workspace and keeps absolute ones', () => {
    expect(resolveClaimPath('src/a.md', 'E:/w/spaces dir')).toBe('E:/w/spaces dir/src/a.md');
    expect(resolveClaimPath('E:/abs/a.md', 'E:/w')).toBe('E:/abs/a.md');
  });

  it('offers the :line:col-stripped retry alongside the raw path', () => {
    const candidates = fileCheckCandidates('see [f](src/a.md:10:3)', 'E:/w', undefined);
    expect(candidates).toEqual([
      { raw: 'src/a.md:10:3', path: 'E:/w/src/a.md:10:3' },
      { raw: 'src/a.md:10:3', path: 'E:/w/src/a.md' },
    ]);
  });

  it('expands ~ against the injected home and never reports a drive-only strip', () => {
    const candidates = fileCheckCandidates('see [f](~/notes.md) and [d](E:/x.md:1)', 'E:/w', 'C:/Users/u');
    expect(candidates.map((candidate) => candidate.path)).toEqual(['C:/Users/u/notes.md', 'E:/x.md:1', 'E:/x.md']);
    // A drive-letter line suffix would strip to `E:` — not a file, no retry candidate.
    const driveOnly = fileCheckCandidates('[d](E:/x.md)', 'E:/w', undefined);
    expect(driveOnly).toEqual([{ raw: 'E:/x.md', path: 'E:/x.md' }]);
  });
});

describe('announcesWork', () => {
  it('matches English and Chinese in-progress phrases', () => {
    expect(announcesWork('I am still working on the export.')).toBe(true);
    expect(announcesWork('正在整理数据')).toBe(true);
    expect(announcesWork('稍后汇报')).toBe(true);
    expect(announcesWork('处理中')).toBe(true);
  });

  it('ignores completed prefixes and code blocks', () => {
    expect(announcesWork('Part 1 was checking earlier, now completed.')).toBe(false);
    expect(announcesWork('已完成导出，正在……')).toBe(false);
    expect(announcesWork('```\ni am working on it\n```')).toBe(false);
    expect(announcesWork('Here is the report. I was researching earlier but finished.')).toBe(false);
  });

  it('still flags mixed sentences where the tail announces work', () => {
    expect(announcesWork('Part 1 completed, still exporting part 2.')).toBe(true);
  });
});

describe('claimsFor / inProgressClaimOf', () => {
  it('marks missing files regardless of tool use', () => {
    const claims = claimsFor({ text: 'see [f](E:/gone.md)', missingFiles: ['E:/gone.md'], worked: true });
    expect(claims).toEqual({ missingFiles: ['E:/gone.md'] });
  });

  it('marks announced work only when the turn did nothing', () => {
    expect(claimsFor({ text: 'I am working on it', missingFiles: [], worked: false })).toEqual({
      missingFiles: [],
      inProgress: true,
    });
    expect(claimsFor({ text: 'I am working on it', missingFiles: [], worked: true })).toBeUndefined();
    expect(inProgressClaimOf('I am working on it', false)).toBe(true);
    expect(inProgressClaimOf('I am working on it', true)).toBe(false);
  });

  it('answers undefined when the reply is clean', () => {
    expect(claimsFor({ text: 'done, see you', missingFiles: [], worked: true })).toBeUndefined();
  });
});
