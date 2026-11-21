/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The wizard's describe flavour, pure (common/chat/team/positions/
 * positionDescribeCore.ts): the marker tables that read a pasted
 * description's missing information dimensions, and the review draft the
 * text yields. No models anywhere — the tables are the product.
 */
import { describe, expect, it } from 'vitest';
import { describeDraft, describeGapQuestions } from '@/common/chat/team/positions/positionDescribeCore';

describe('describeGapQuestions', () => {
  it('flags all three dimensions for an empty or too-thin description', () => {
    expect(describeGapQuestions('')).toEqual(['project-root', 'duty-boundary', 'acceptance']);
    expect(describeGapQuestions('   ')).toEqual(['project-root', 'duty-boundary', 'acceptance']);
    expect(describeGapQuestions('帮我弄一下那个')).toEqual(['project-root', 'duty-boundary', 'acceptance']);
  });

  it('drops a dimension as soon as its markers show up: a path names the root, duty words name the boundary, acceptance words name the bar', () => {
    expect(describeGapQuestions('帮我管 E:/Projects/freight-lab')).toEqual(['duty-boundary', 'acceptance']);
    expect(describeGapQuestions('岗位的职责是处理报价表')).toEqual(['project-root', 'acceptance']);
    expect(describeGapQuestions('做完要过验收才算数')).toEqual(['project-root', 'duty-boundary']);
  });

  it('recognizes the explicit 项目根 wording as the root, no path needed, and English markers too', () => {
    expect(describeGapQuestions('项目目录是仓库根，负责维护，验收看测试')).toEqual([]);
    expect(describeGapQuestions('owns ~/proj, responsible for parsing, quality bar: tests pass')).toEqual([]);
  });

  it('never returns a dimension twice, whatever the markers repeat', () => {
    const gaps = describeGapQuestions('负责处理 C:/a 与 D:/b 两个目录的解析');
    expect(gaps).toEqual(['acceptance']);
  });
});

describe('describeDraft', () => {
  it('takes the first sentence as the description, capped when it runs long', () => {
    expect(describeDraft('盯报价表。其余不管。').description).toBe('盯报价表');
    const long = '盯'.repeat(200) + '。';
    expect(describeDraft(long).description.length).toBe(120);
    expect(describeDraft(long).description.endsWith('…')).toBe(true);
  });

  it('keeps the whole text as the body and lifts a path token into the 项目根 line the library parser reads back', () => {
    const draft = describeDraft('盯 E:/Projects/freight-lab 的报价表。验收：行行对上。');
    expect(draft.projectRoot).toBe('E:/Projects/freight-lab');
    expect(draft.body).toContain('## 项目事实（开工必读）');
    expect(draft.body).toContain('- 项目根：`E:/Projects/freight-lab`');
    expect(draft.body).toContain('盯 E:/Projects/freight-lab 的报价表。');
  });

  it('does not add a 项目根 line when the text names none, and never duplicates one the text already writes', () => {
    expect(describeDraft('整理每周简报，验收是周五前发出').projectRoot).toBe('');
    expect(describeDraft('整理简报')).not.toContain('项目事实');
    const written = describeDraft('项目根：`C:/tmp/x`，负责维护索引，验收看检查');
    expect(written.body).not.toContain('## 项目事实');
  });

  it('trims trailing punctuation off the lifted root so a sentence-ending path stays a path', () => {
    expect(describeDraft('盯 E:/Projects/freight-lab。验收对上。').projectRoot).toBe('E:/Projects/freight-lab');
  });
});
