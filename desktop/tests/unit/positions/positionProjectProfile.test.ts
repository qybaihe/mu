/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The creation wizard's pure core against the project shapes the user's
 * machines actually carry: a full project (AGENTS + HANDOFF + package.json,
 * Chinese), a bare package.json, a docs-only project and an empty directory;
 * then the draft, the overlap check, the document round-trip and the AI deep
 * analysis reply parsing.
 */
import { describe, expect, it } from 'vitest';
import { parsePositionDocument, type PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';
import {
  analyzeProjectProfile,
  buildDeepAnalysisPrompt,
  buildPositionDocument,
  buildPositionDraft,
  deepAnalysisAsDraft,
  findPositionOverlaps,
  normalizeProjectRoot,
  parseDeepAnalysisReply,
  slugifyPositionId,
} from '@/common/chat/team/positions/positionProjectProfile';

const fullAgents = [
  '# forwarder — 货代业务统一工作区',
  '',
  '> 定位：货代相关所有工作的上下文根。',
  '',
  '## 红线',
  '- **禁止**未经确认对外报价：一律先过八项口径',
  '- **铁律**：库内没有的价格一律不报',
].join('\n');

const fullHandoff = [
  '# HANDOFF — forwarder',
  '',
  '## 2026-11-19 · OpenAccess 询盘报价会话增量',
  '- 两询盘草稿在邮箱草稿箱',
  '',
  '## 当前目标',
  '货代统一工作区运营：邮件询盘链与运价采集链',
  '',
  '## 成功指标',
  '- 邮件链每 10 分钟轮询',
].join('\n');

const fullPkg = JSON.stringify({
  name: '@cns/forwarder',
  dependencies: { react: '^18', 'react-dom': '^18' },
  devDependencies: { typescript: '^5' },
});

const position = (over: Partial<PositionInfo>): PositionInfo => ({
  name: 'x',
  displayName: 'x',
  description: '',
  body: '',
  ...over,
});

describe('analyzeProjectProfile', () => {
  it('reads a full Chinese project: package name, HANDOFF goal, constraints, stack', () => {
    const profile = analyzeProjectProfile({
      directory: 'E:/Projects/forwarder',
      files: { 'AGENTS.md': fullAgents, 'HANDOFF.md': fullHandoff, 'package.json': fullPkg },
      entries: ['AGENTS.md', 'HANDOFF.md', 'package.json', 'pyproject.toml'],
    });
    expect(profile.projectName).toBe('forwarder'); // scope stripped
    expect(profile.goal).toBe('货代统一工作区运营：邮件询盘链与运价采集链'); // the goal section beats the dated entry
    expect(profile.constraints).toEqual(['禁止未经确认对外报价：一律先过八项口径', '铁律：库内没有的价格一律不报']);
    expect(profile.techStack).toEqual(['react', 'react-dom', 'typescript', 'Python']); // markers append
    expect(profile.empty).toBe(false);
    expect(profile.sources).toContain('AGENTS.md');
  });

  it('falls back to the dated HANDOFF entry when there is no goal section', () => {
    const handoff = '# HANDOFF\n\n## 2026-11-18 · 修复登录闪退\n- 细节\n';
    const profile = analyzeProjectProfile({ directory: 'E:/Projects/p', files: { 'HANDOFF.md': handoff } });
    expect(profile.goal).toBe('修复登录闪退');
  });

  it('names a docs-only project by its heading, before the em dash', () => {
    const profile = analyzeProjectProfile({
      directory: 'E:/Projects/forwarder',
      files: { 'AGENTS.md': fullAgents },
    });
    expect(profile.projectName).toBe('forwarder');
    expect(profile.goal).toBe('货代相关所有工作的上下文根。'); // the positioning line, prefix stripped
  });

  it('answers an empty directory with empty: true — the AI analysis cue', () => {
    const profile = analyzeProjectProfile({ directory: 'E:/tmp/scratch', files: {}, entries: ['notes.txt'] });
    expect(profile.empty).toBe(true);
    expect(profile.projectName).toBe('scratch'); // still named, by its folder
    expect(profile.sources).toEqual([]);
  });

  it('treats an unparseable package.json as carrying nothing: the AI cue stays on', () => {
    const profile = analyzeProjectProfile({ directory: 'E:/p', files: { 'package.json': '{oops' } });
    expect(profile.projectName).toBe('p');
    expect(profile.techStack).toEqual([]);
    expect(profile.empty).toBe(true); // present but useless
  });
});

describe('slugifyPositionId', () => {
  it('slugs latin names and refuses everything else', () => {
    expect(slugifyPositionId('My App!')).toBe('my-app');
    expect(slugifyPositionId('@scope/video-lab')).toBe('video-lab');
    expect(slugifyPositionId('货代')).toBe('position');
  });
});

describe('buildPositionDraft and the document round-trip', () => {
  it('drafts candidates, a one-line description and a body the parser reads back', () => {
    const profile = analyzeProjectProfile({
      directory: 'E:\\Projects\\forwarder',
      files: { 'AGENTS.md': fullAgents, 'HANDOFF.md': fullHandoff, 'package.json': fullPkg },
    });
    const draft = buildPositionDraft(profile);
    expect(draft.id).toBe('forwarder');
    expect(draft.displayNameCandidates[0]).toBe('货代统一工作区运营'); // CJK run of the goal, capped at 10
    expect(draft.displayNameCandidates).toContain('forwarder'); // the folder name is always offered
    expect(draft.description).toContain('forwarder 项目常设岗位');
    expect(draft.body).toContain('项目根：`E:/Projects/forwarder`'); // the line the library parser reads

    const doc = buildPositionDocument({ ...draft, displayName: draft.displayNameCandidates[0] });
    const parsed = parsePositionDocument('forwarder.md', doc);
    expect(parsed).toBeDefined();
    expect(parsed?.name).toBe(draft.id);
    expect(parsed?.displayName).toBe(draft.displayNameCandidates[0]);
    expect(parsed?.description).toBe(draft.description.replace(/\s+/g, ' ').trim());
    expect(parsed?.projectRoot).toBe('E:/Projects/forwarder');
  });

  it('offers the folder name alone when the files carry no Chinese', () => {
    const profile = analyzeProjectProfile({
      directory: 'E:/Projects/pure-api',
      files: { 'package.json': JSON.stringify({ name: 'pure-api', dependencies: { fastify: '5' } }) },
    });
    const draft = buildPositionDraft(profile);
    expect(draft.displayNameCandidates).toEqual(['pure-api']);
    expect(draft.id).toBe('pure-api');
  });

  it('writes anti_job inline for one taboo and as a - item list for several, both parsing back', () => {
    const draft = buildPositionDraft(analyzeProjectProfile({ directory: 'E:/x/y', files: {} }));

    const single = buildPositionDocument({ ...draft, displayName: '单', antiJob: ['严禁私自发帖'] });
    expect(single).toContain('\nanti_job: 严禁私自发帖\n');
    expect(parsePositionDocument('a.md', single)?.antiJob).toEqual(['严禁私自发帖']);

    const list = buildPositionDocument({ ...draft, displayName: '双', antiJob: ['严禁私自发帖', '严禁删改用户文件'] });
    expect(list).toContain('\nanti_job:\n  - 严禁私自发帖\n  - 严禁删改用户文件\n');
    expect(parsePositionDocument('b.md', list)?.antiJob).toEqual(['严禁私自发帖', '严禁删改用户文件']);

    const none = buildPositionDocument({ ...draft, displayName: '无' });
    expect(none).not.toContain('anti_job');
    expect(parsePositionDocument('c.md', none)?.antiJob).toEqual([]);
  });
});

describe('findPositionOverlaps', () => {
  const roster = [
    position({
      name: 'forwarder',
      displayName: '货代',
      description: '货代岗：海运报价',
      projectRoot: 'E:/Projects/forwarder',
    }),
    position({ name: 'video-lab', displayName: 'video-lab', description: '视频实验室' }),
  ];

  it('flags the same id, name and project root, with root separators and case folded', () => {
    const overlaps = findPositionOverlaps(
      {
        id: 'Forwarder',
        displayName: '货代',
        description: '完全不同的描述文字',
        projectRoot: 'e:\\projects\\FORWARDER\\',
      },
      roster
    );
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].position.name).toBe('forwarder');
    expect(overlaps[0].reasons).toEqual(['id', 'name', 'project-root']);
  });

  it('flags near-identical descriptions, and lets a genuinely new position through', () => {
    const sameJob = findPositionOverlaps(
      {
        id: 'ocean-freight',
        displayName: '海运',
        description: '货代岗：海运报价海运报价海运报价',
        projectRoot: 'E:/other',
      },
      roster
    );
    expect(sameJob.map((overlap) => overlap.reasons)).toContainEqual(['description']);

    const fresh = findPositionOverlaps(
      { id: 'ocr-lab', displayName: 'OCR', description: '本地 OCR 管线与判卷', projectRoot: 'E:/Projects/ocr-lab' },
      roster
    );
    expect(fresh).toEqual([]);
  });

  it('compares roots normalized: trailing slashes and backslashes are the same root', () => {
    expect(normalizeProjectRoot('E:\\A\\B\\')).toBe(normalizeProjectRoot('e:/a/b'));
  });
});

describe('the AI deep analysis reply', () => {
  it('builds a prompt that demands one JSON object', () => {
    const prompt = buildDeepAnalysisPrompt();
    expect(prompt).toContain('只输出一个 JSON 对象');
    expect(prompt).toContain('displayNameCandidates');
  });

  it('parses a fenced reply and caps its arrays', () => {
    const reply = [
      '分析完成：',
      '```json',
      JSON.stringify({
        projectName: 'tuneshape',
        goal: '动效复刻入库',
        techStack: Array.from({ length: 12 }, (_, i) => `t${i}`),
        constraints: ['禁止 push', '二', '三', '四'],
        displayNameCandidates: ['动效岗', '复刻岗', '素材岗', '第四个'],
        description: '动效复刻相关任务时交给它',
      }),
      '```',
    ].join('\n');
    const parsed = parseDeepAnalysisReply(reply);
    expect(parsed?.projectName).toBe('tuneshape');
    expect(parsed?.techStack).toHaveLength(8);
    expect(parsed?.constraints).toHaveLength(3);
    expect(parsed?.displayNameCandidates).toHaveLength(3);
    const draft = deepAnalysisAsDraft(parsed!, 'E:/Projects/tuneshape');
    expect(draft.displayNameCandidates[0]).toBe('动效岗');
    expect(draft.body).toContain('AI 深度分析初始化'); // marked as AI-derived
  });

  it('parses a bare JSON object, and refuses text without one', () => {
    expect(parseDeepAnalysisReply('{"projectName":"a","goal":"b"}')?.projectName).toBe('a');
    expect(parseDeepAnalysisReply('这里没有结构化内容')).toBeUndefined();
    expect(parseDeepAnalysisReply('{"goal":"缺少项目名"}')).toBeUndefined();
  });
});
