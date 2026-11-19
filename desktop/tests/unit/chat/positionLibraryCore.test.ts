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
} from '@/common/chat/positions/positionLibraryCore';

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
});

describe('findPositionConversationId', () => {
  const conversations = [
    { id: 'other', modified_at: 5, extra: { [POSITION_EXTRA_KEY]: 'video-lab' } },
    { id: 'old-session', modified_at: 1, extra: { [POSITION_EXTRA_KEY]: 'forwarder' } },
    { id: 'the-session', modified_at: 9, extra: { [POSITION_EXTRA_KEY]: 'forwarder' } },
    { id: 'unmarked', modified_at: 9, extra: { workspace: 'E:/x' } },
  ];

  it('finds the position’s conversation by its extra marker, the newest on duplicates', () => {
    expect(findPositionConversationId(conversations, 'forwarder')).toBe('the-session');
    expect(findPositionConversationId(conversations, 'video-lab')).toBe('other');
  });

  it('stays undefined for a position without a conversation and for unmarked ones', () => {
    expect(findPositionConversationId(conversations, 'mu-dev')).toBeUndefined();
  });
});
