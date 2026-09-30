/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { SlashCommandItem } from '@/common/chat/slash/types';
import type { TChatConversation } from '@/common/config/storage';
import type { NativeConversation } from '@/common/kyrn/nativeBridge';
import {
  MATCHED_CONVERSATIONS,
  MATCHED_SETTINGS,
  RECENT_CONVERSATIONS,
  TOP_COMMANDS,
  buildPaletteGroups,
  splitByHits,
  type PaletteGroup,
  type PaletteSources,
} from '@/renderer/components/layout/Sider/CommandPalette/paletteGroups';
import { SETTINGS_HOME, SETTINGS_PAGES } from '@/renderer/pages/settings/settingsNav';
import { MU_COMMAND_WORDS } from '@/renderer/utils/chat/muCommands';

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const MINUTE = 60_000;

const conversation = (id: string, name: string, minutesAgo: number): TChatConversation =>
  ({
    id,
    name,
    type: 'acp',
    created_at: NOW - minutesAgo * MINUTE,
    modified_at: NOW - minutesAgo * MINUTE,
    extra: {},
  }) as unknown as TChatConversation;

const native = (id: string, title: string, cwd: string, minutesAgo: number): NativeConversation => ({
  id,
  cwd,
  title,
  createdAt: NOW - minutesAgo * MINUTE,
  updatedAt: NOW - minutesAgo * MINUTE,
  live: false,
});

const command = (name: string): SlashCommandItem => ({
  name,
  description: `${name} help`,
  kind: 'template',
  source: 'acp',
});

// Keys stand in for the copy; interpolated values are appended so they stay visible.
const t = (key: string, options?: Record<string, unknown>) =>
  options?.query ? `${key}(${String(options.query)})` : key;

const sources = (overrides: Partial<PaletteSources> = {}): PaletteSources => ({
  query: '',
  conversations: [],
  commandTarget: 'c1',
  commands: [],
  t,
  language: 'en-US',
  now: NOW,
  ...overrides,
});

const group = (groups: PaletteGroup[], id: PaletteGroup['id']) => groups.find((entry) => entry.id === id);
const labels = (groups: PaletteGroup[], id: PaletteGroup['id']) => group(groups, id)?.items.map((item) => item.label);

describe('buildPaletteGroups', () => {
  it('lists the native host’s conversations among the others by time, found by title or folder, with their page', () => {
    const groups = buildPaletteGroups(
      sources({
        query: 'notes',
        conversations: [conversation('c1', 'notes classic', 5)],
        nativeConversations: [
          native('n1', 'notes native', '/work/alpha', 1),
          native('n2', 'other', '/work/notes-app', 10),
          native('n3', 'unrelated', '/work/beta', 2),
        ],
      })
    );
    const rows = group(groups, 'conversations')?.items ?? [];
    expect(rows.map((row) => row.label)).toEqual(['notes native', 'notes classic', 'other']);
    expect(rows[0]).toMatchObject({ key: 'native:n1', path: '/conversation/native/n1', detail: 'alpha' });
    // Found by its folder: nothing of its title is underlined.
    expect(rows[2]).toMatchObject({ key: 'native:n2', hits: [], detail: 'notes-app' });
    // A classic row is as it was: no page of its own, no folder.
    expect(rows[1]).toEqual(expect.objectContaining({ key: 'conversation:c1' }));
    expect(rows[1]).not.toHaveProperty('path');
    expect(rows[1]).not.toHaveProperty('detail');
  });

  it('lists what it listed before when there are no native conversations', () => {
    const conversations = [conversation('c1', 'alpha', 3), conversation('c2', 'beta', 1)];
    for (const query of ['', 'a', '/'])
      expect(buildPaletteGroups(sources({ query, conversations, nativeConversations: [] }))).toEqual(
        buildPaletteGroups(sources({ query, conversations }))
      );
  });

  it('lists at most eight matching conversations, the most recent first', () => {
    // Twelve matches, listed oldest first: the palette must sort, not trust the order it is given.
    const conversations = Array.from({ length: 12 }, (_item, index) =>
      conversation(`n${index}`, `notes ${index}`, 100 - index)
    );

    const groups = buildPaletteGroups(sources({ query: 'notes', conversations }));

    expect(MATCHED_CONVERSATIONS).toBe(8);
    expect(labels(groups, 'conversations')).toEqual([
      'notes 11',
      'notes 10',
      'notes 9',
      'notes 8',
      'notes 7',
      'notes 6',
      'notes 5',
      'notes 4',
    ]);
  });

  it('lists the five most recent conversations, the way into the settings and the first five commands for an empty query', () => {
    const conversations = Array.from({ length: 7 }, (_item, index) =>
      conversation(`c${index}`, `chat ${index}`, index)
    );
    const commands = ['goal', 'board', 'compact', 'kernel', 'model', 'swarm', 'permissions'].map(command);

    const groups = buildPaletteGroups(sources({ query: '   ', conversations, commands }));

    expect(RECENT_CONVERSATIONS).toBe(5);
    expect(TOP_COMMANDS).toBe(5);
    expect(groups.map((entry) => entry.id)).toEqual(['conversations', 'settings', 'commands']);
    expect(labels(groups, 'conversations')).toEqual(['chat 0', 'chat 1', 'chat 2', 'chat 3', 'chat 4']);
    // The settings rail has too many pages to list before the person types: only the row that opens the settings.
    expect(group(groups, 'settings')?.items).toEqual([
      {
        kind: 'settings',
        key: 'settings:home',
        label: 'common.commandPalette.openSettings',
        hits: [],
        path: SETTINGS_HOME,
      },
    ]);
    expect(labels(groups, 'commands')).toEqual(['/goal', '/board', '/compact', '/kernel', '/model']);
  });

  it('lists the settings pages once the person types', () => {
    const groups = buildPaletteGroups(sources({ query: 'about' }));

    expect(group(groups, 'settings')?.items.map((item) => (item.kind === 'settings' ? item.path : ''))).toContain(
      '/settings/about'
    );
  });

  it('lists what the app itself can do for an empty query without a conversation to send commands to', () => {
    const groups = buildPaletteGroups(sources({ commandTarget: null, commands: [command('board')] }));

    // Never an empty list, which would read as "nothing matched" before anything was typed.
    expect(groups.map((entry) => entry.id)).toEqual(['settings', 'commands']);
    expect(group(groups, 'commands')?.items).toMatchObject([
      { kind: 'action', action: 'newConversation', label: 'common.commandPalette.actions.newConversation' },
      { kind: 'action', action: 'scheduledTasks', label: 'common.commandPalette.actions.scheduledTasks' },
    ]);
  });

  it('finds the settings by the word for them and by their group, leading with the row that opens them', () => {
    const words: Record<string, string> = {
      'common.settings': '设置',
      'common.commandPalette.openSettings': '打开设置',
      'common.commandPalette.actions.newConversation': '开始新会话',
      'settings.groups.models': '模型',
      'mu.sections.providers': '提供商',
      'mu.sections.defaultModel': '默认模型',
    };
    const chinese = (key: string, options?: Record<string, unknown>) => words[key] ?? t(key, options);

    // 设 is the start of 设置: every page answers, the row that opens the settings comes first, and the list stops
    // at eight rows rather than running through all the pages.
    const all = group(buildPaletteGroups(sources({ query: '设', t: chinese })), 'settings');
    expect(all?.items[0]).toMatchObject({ label: '打开设置', hits: [2], path: SETTINGS_HOME });
    expect(MATCHED_SETTINGS).toBe(8);
    expect(SETTINGS_PAGES.length + 1).toBeGreaterThan(MATCHED_SETTINGS);
    expect(all?.items).toHaveLength(MATCHED_SETTINGS);
    // A page found only by the word for the settings has nothing of its own underlined.
    expect(all?.items[1].hits).toEqual([]);
    // Pages found by their name keep their place before the rest when the list is cut.
    const named = group(buildPaletteGroups(sources({ query: 'about' })), 'settings');
    expect(named?.items.length).toBeLessThanOrEqual(MATCHED_SETTINGS);

    // A page found by its name comes before one found by its group.
    expect(labels(buildPaletteGroups(sources({ query: '模型', t: chinese })), 'settings')).toEqual([
      '默认模型',
      '提供商',
    ]);

    // What the app itself can do answers to its words too.
    expect(labels(buildPaletteGroups(sources({ query: '新会话', t: chinese })), 'commands')).toEqual(['开始新会话']);
  });

  it('ends a query with the hand-off to the message search, carrying the trimmed query', () => {
    const groups = buildPaletteGroups(sources({ query: '  deploy  ' }));

    expect(groups.map((entry) => entry.id)).toEqual(['messages']);
    expect(groups[0].items[0]).toMatchObject({
      kind: 'messages',
      query: 'deploy',
      label: 'common.commandPalette.searchMessages(deploy)',
    });
  });

  it('matches without regard to case and marks where', () => {
    const groups = buildPaletteGroups(
      sources({ query: 'AUTH', conversations: [conversation('c1', 'Refactor the auth flow', 1)] })
    );

    expect(group(groups, 'conversations')?.items[0].hits).toEqual([13, 14, 15, 16]);
  });

  it('lists only commands for a query that starts with a slash, and marks past the slash', () => {
    const groups = buildPaletteGroups(
      sources({
        query: '/oar',
        conversations: [conversation('c1', 'board/oar notes', 1)],
        commands: [command('board'), command('compact')],
      })
    );

    expect(groups.map((entry) => entry.id)).toEqual(['commands']);
    expect(group(groups, 'commands')?.items[0]).toMatchObject({ label: '/board', hits: [2, 3, 4], name: 'board' });
  });

  it('lists every command for a lone slash', () => {
    const groups = buildPaletteGroups(sources({ query: '/', commands: [command('board'), command('compact')] }));

    expect(labels(groups, 'commands')).toEqual(['/board', '/compact']);
  });

  it('lists no commands without a conversation to send them to', () => {
    const groups = buildPaletteGroups(sources({ query: 'board', commandTarget: null, commands: [command('board')] }));

    expect(group(groups, 'commands')).toBeUndefined();
  });

  it('addresses a command to the open conversation', () => {
    const groups = buildPaletteGroups(sources({ query: 'board', commandTarget: 'c7', commands: [command('board')] }));

    expect(group(groups, 'commands')?.items[0]).toMatchObject({ conversationId: 'c7', detail: 'board help' });
  });

  it("describes one of mu's own commands in the reader's language", () => {
    const board = { ...command('board'), description: MU_COMMAND_WORDS.get('board')![0] };
    const groups = buildPaletteGroups(sources({ query: 'board', commands: [board] }));

    expect(group(groups, 'commands')?.items[0]).toMatchObject({ detail: 'mu.commands.board' });
  });

  it('names a conversation that has no title the way the sidebar does', () => {
    const groups = buildPaletteGroups(sources({ conversations: [conversation('c1', '  ', 1)] }));

    expect(labels(groups, 'conversations')).toEqual(['conversation.welcome.newConversation']);
  });
});

describe('splitByHits', () => {
  it('cuts a label into matched and unmatched runs', () => {
    expect(splitByHits('Refactor auth', [9, 10, 11, 12])).toEqual([
      { text: 'Refactor ', hit: false },
      { text: 'auth', hit: true },
    ]);
  });

  it('keeps a label whole when nothing matched', () => {
    expect(splitByHits('Kernel', [])).toEqual([{ text: 'Kernel', hit: false }]);
  });

  it('handles a match at the very start', () => {
    expect(splitByHits('Kernel', [0, 1])).toEqual([
      { text: 'Ke', hit: true },
      { text: 'rnel', hit: false },
    ]);
  });
});
