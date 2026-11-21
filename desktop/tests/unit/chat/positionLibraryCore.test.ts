/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildPositionOverrideContent,
  findPositionConversationId,
  parsePositionDocument,
  positionLabel,
  POSITION_EXTRA_KEY,
} from '@/common/chat/team/positions/positionLibraryCore';

/** A library file as the user writes them: frontmatter, then the position's own instructions. */
const libraryFile = (name: string, description: string, body: string, displayName?: string): string =>
  `---\nname: ${name}${displayName ? `\ndisplay_name: ${displayName}` : ''}\ndescription: ${description}\n---\n\n${body}`;

const forwarder = libraryFile(
  'forwarder',
  '货代业务常设岗位——询价、运价、客户查重',
  '你是 forwarder 岗位的常设负责 Bot。\n\n## 项目事实（开工必读）\n- 项目根：`E:/Projects/forwarder`（货代统一工作区）\n'
);

describe('parsePositionDocument', () => {
  it('parses a position file: name and description from the frontmatter, body below it', () => {
    const position = parsePositionDocument('forwarder.md', forwarder);
    expect(position).toMatchObject({
      name: 'forwarder',
      description: '货代业务常设岗位——询价、运价、客户查重',
      projectRoot: 'E:/Projects/forwarder',
    });
    expect(position?.body).toContain('常设负责 Bot');
    expect(position?.body).not.toContain('---');
  });

  it('keeps a position without a 项目根 line: the root is optional', () => {
    const position = parsePositionDocument(
      'worker.md',
      libraryFile('worker', 'General-purpose subagent', 'Just a body.')
    );
    expect(position).toMatchObject({ name: 'worker', description: 'General-purpose subagent', projectRoot: undefined });
  });

  it('takes display_name as the display alias, falling back to the id when absent or blank', () => {
    const aliased = parsePositionDocument('forwarder.md', libraryFile('forwarder', '货代岗', '正文', '货代'));
    expect(aliased).toMatchObject({ name: 'forwarder', displayName: '货代' });
    expect(positionLabel(aliased!)).toBe('货代(forwarder)');

    const plain = parsePositionDocument('worker.md', libraryFile('worker', '通用岗', '正文'));
    expect(plain).toMatchObject({ name: 'worker', displayName: 'worker' });
    expect(positionLabel(plain!)).toBe('worker');

    const blank = parsePositionDocument('scout.md', libraryFile('scout', '侦察岗', '正文', '  '));
    expect(blank).toMatchObject({ name: 'scout', displayName: 'scout' });
  });

  it('rejects what is not a position: README, frontmatter without description, no frontmatter', () => {
    expect(parsePositionDocument('README.md', forwarder)).toBeUndefined();
    expect(parsePositionDocument('half.md', '---\nname: half\n---\n\nNo description.')).toBeUndefined();
    expect(parsePositionDocument('note.md', '# A plain note\n\nwithout frontmatter')).toBeUndefined();
  });

  it('parses anti_job as one inline line or a - item list; absent stays empty', () => {
    const inline = parsePositionDocument('a.md', '---\nname: a\ndescription: d\nanti_job: 严禁私自发帖\n---\n\n正文');
    expect(inline?.antiJob).toEqual(['严禁私自发帖']);

    const list = parsePositionDocument(
      'b.md',
      [
        '---',
        'name: b',
        'description: d',
        'anti_job:',
        '  - 严禁私自发帖',
        '  - 严禁删改用户文件',
        '---',
        '',
        '正文',
      ].join('\n')
    );
    expect(list?.antiJob).toEqual(['严禁私自发帖', '严禁删改用户文件']);

    const none = parsePositionDocument('c.md', '---\nname: c\ndescription: d\n---\n\n正文');
    expect(none?.antiJob).toEqual([]);
  });

  it('caps the anti_job list at 8 items, truncates long items, drops blanks, and stops at the next field', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `  - 禁忌 ${i + 1}`);
    const many = parsePositionDocument(
      'a.md',
      ['---', 'name: a', 'description: d', 'anti_job:', ...ten, '---', '', '正文'].join('\n')
    );
    expect(many?.antiJob).toHaveLength(8);
    expect(many?.antiJob?.[0]).toBe('禁忌 1');
    expect(many?.antiJob?.[7]).toBe('禁忌 8');

    const interrupted = parsePositionDocument(
      'b.md',
      [
        '---',
        'name: b',
        'description: d',
        'anti_job:',
        '  - 第一条',
        '  -   ',
        'other: x',
        '  - 不该收录',
        '---',
        '',
        '正文',
      ].join('\n')
    );
    expect(interrupted?.antiJob).toEqual(['第一条']);

    const long = '长'.repeat(250);
    const truncated = parsePositionDocument('c.md', `---\nname: c\ndescription: d\nanti_job: ${long}\n---\n\n正文`);
    expect(truncated?.antiJob?.[0]).toHaveLength(200);
    expect(truncated?.antiJob?.[0]?.endsWith('…')).toBe(true);
  });
});

describe('buildPositionOverrideContent', () => {
  const roster = [
    { name: 'forwarder', displayName: '货代', description: '货代业务常设岗位', body: '正文甲' },
    { name: 'video-lab', displayName: '视频实验室', description: '视频域常设岗位', body: '正文乙' },
  ];

  it('states the position identity, the ownership gate, the instructions and the whole roster', () => {
    const content = buildPositionOverrideContent(roster[0], roster);
    expect(content).toContain('# 岗位：货代');
    expect(content).toContain('你是「货代」岗位的一对一负责 Bot');
    expect(content).toContain('任务归属判定');
    expect(content).toContain('立即停止');
    expect(content).toContain('正文甲');
    expect(content).toContain('- 货代(forwarder) — 货代业务常设岗位');
    expect(content).toContain('- 视频实验室(video-lab) — 视频域常设岗位');
  });

  it('teaches the wrap-up ledger and the new-project dedup gate, both before the roster', () => {
    const content = buildPositionOverrideContent(roster[0], roster);
    expect(content).toContain('任务收尾回落（硬规则）');
    expect(content).toContain('项目根」→ 把一条记录**追加**写入该项目根的 `HANDOFF.md`');
    expect(content).toContain('只追加，禁止删改该文件既有内容');
    expect(content).toContain('LESSON: ');
    expect(content).toContain('新项目与新岗位去重');
    expect(content).toContain('与既有岗职责重合 → **不新建**');
    expect(content).toContain('`AGENTS.md`');
    expect(content).toContain('不得创建或改写任何岗位库文件');
    expect(content.indexOf('任务收尾回落')).toBeLessThan(content.indexOf('## 全岗名册'));
  });

  it('teaches the lesson double write: the wrap-up ledger also lands in the shared LESSONS.md by the locked script', () => {
    const content = buildPositionOverrideContent(roster[0], roster);
    expect(content).toContain('node teams.cjs lesson --position forwarder');
    expect(content).toContain('LESSONS.md');
    expect(content).toContain('写锁');
    // The script failure must not swallow the wrap-up: the ERROR rides along.
    expect(content).toContain('不阻塞回报');
  });

  it('carries the user portrait as the closing section, after the roster — and nothing when there is none', () => {
    const withPortrait = buildPositionOverrideContent(roster[0], roster, '# 用户画像\n\n- 称呼：老林\n');
    expect(withPortrait).toContain('## 用户画像');
    expect(withPortrait).toContain('- 称呼：老林');
    expect(withPortrait.indexOf('## 全岗名册')).toBeLessThan(withPortrait.indexOf('## 用户画像'));
    const bare = buildPositionOverrideContent(roster[0], roster);
    expect(bare).not.toContain('## 用户画像');
  });

  it('names this position in the gate, so a refusal can point elsewhere precisely', () => {
    const content = buildPositionOverrideContent(roster[1], roster);
    expect(content).toContain('不属于本岗（视频实验室');
    expect(content).toContain('不得自行创建新岗位');
  });

  it('teaches on-demand team forming: default solo, team only for real collaboration, same script as the supervisor', () => {
    const content = buildPositionOverrideContent(roster[0], roster);
    expect(content).toContain('按需组队前置判定');
    expect(content).toContain('无条件第一个动作');
    expect(content).toContain('先过下方「按需组队前置判定」');
    expect(content).toContain('node teams.cjs match --positions');
    expect(content).toContain('node teams.cjs add --name');
    expect(content).toContain('node teams.cjs send --team');
    expect(content).toContain('不得用 subagent/delegate 工具直接派给其他岗位');
    expect(content).toContain('优先于本岗说明书中任何跨岗分工/派发条款');
    expect(content).toContain('能单岗干完且未点名其他岗位的任务建队＝违规');
    // The pre-check reads before the position's own instructions, so the
    // delegation habits there cannot win the first move.
    expect(content.indexOf('按需组队前置判定')).toBeLessThan(content.indexOf('## 本岗说明书'));
    expect(content.indexOf('按需组队前置判定')).toBeLessThan(content.indexOf('## 全岗名册'));
  });

  it('answers an empty instructions body instead of an empty section', () => {
    const content = buildPositionOverrideContent({ name: 'x', displayName: 'x', description: 'd', body: '' }, roster);
    expect(content).toContain('（本岗未提供说明书正文）');
  });

  it('injects the reverse taboos as the highest-priority section: position items plus the universal fallback, before the ownership gate', () => {
    const content = buildPositionOverrideContent(
      { ...roster[0], antiJob: ['严禁私自发帖', '严禁删改用户文件'] },
      roster
    );
    expect(content).toContain('## 反向禁忌（硬规则，优先级最高，先于下方一切判定）');
    expect(content).toContain('本岗绝不：严禁私自发帖');
    expect(content).toContain('本岗绝不：严禁删改用户文件');
    expect(content).toContain('无任务分派时保持安静，严禁主动客套刷屏或无任务找活（通用底线）');
    expect(content).toContain('即使任务表面上属于本岗职责，禁忌优先');
    // The taboo section outranks the ownership gate: it reads first.
    expect(content.indexOf('## 反向禁忌')).toBeLessThan(content.indexOf('## 任务归属判定'));
  });

  it('carries the universal fallback even for a position with no anti_job of its own', () => {
    const content = buildPositionOverrideContent(roster[0], roster);
    expect(content).toContain('## 反向禁忌');
    expect(content).toContain('无任务分派时保持安静，严禁主动客套刷屏或无任务找活（通用底线）');
    expect(content).not.toContain('本岗绝不：');
  });

  it('injects the first-exchange tacit-knowledge protocol: three self-checks, one-at-a-time mining capped at 3, append-only ledger', () => {
    const content = buildPositionOverrideContent(roster[0], roster);
    expect(content).toContain('## 首次对话开场（暗默知识挖掘，只在信息真的缺时触发）');
    expect(content).toContain('冲突信息以哪为准');
    expect(content).toContain('如何验收');
    expect(content).toContain('何时必须停下求助');
    expect(content).toContain('一次只问一个问题');
    expect(content).toContain('最多 3 问');
    expect(content).toContain('回复必须以那个问题结尾');
    expect(content).toContain('严禁自查后自己拟定答案或「默认做法」顶上');
    expect(content).toContain('当时为什么选这条路、没选另一条');
    // The ledger: the position's own project AGENTS.md, appended, never rewritten.
    expect(content).toContain('岗位暗默知识');
    expect(content).toContain('只追加，禁止删改既有内容');
    // Anti-disturbance is the bar, not a default: a manual that answers means no questions at all.
    expect(content).toContain('不问任何开场问题');
    // Order: the taboos still outrank everything; the protocol precedes the ownership gate.
    expect(content.indexOf('## 反向禁忌')).toBeLessThan(content.indexOf('## 首次对话开场'));
    expect(content.indexOf('## 首次对话开场')).toBeLessThan(content.indexOf('## 任务归属判定'));
  });
});

describe('findPositionConversationId', () => {
  const conversations = [
    { id: 'other', modified_at: 5, extra: { [POSITION_EXTRA_KEY]: 'video-lab' } },
    { id: 'old-session', modified_at: 1, extra: { [POSITION_EXTRA_KEY]: 'forwarder' } },
    { id: 'the-session', modified_at: 9, extra: { [POSITION_EXTRA_KEY]: 'forwarder' } },
    { id: 'unmarked', modified_at: 9, extra: { workspace: 'E:/x' } },
    { id: 'supervisor-session', modified_at: 7, extra: { [POSITION_EXTRA_KEY]: 'supervisor' } },
  ];

  it('finds the position’s conversation by its extra marker, the newest on duplicates', () => {
    expect(findPositionConversationId(conversations, 'forwarder')).toBe('the-session');
    expect(findPositionConversationId(conversations, 'video-lab')).toBe('other');
    // The receipt loop targets the supervisor’s session through the same seam.
    expect(findPositionConversationId(conversations, 'supervisor')).toBe('supervisor-session');
  });

  it('stays undefined for a position without a conversation and for unmarked ones', () => {
    expect(findPositionConversationId(conversations, 'mu-dev')).toBeUndefined();
  });
});
