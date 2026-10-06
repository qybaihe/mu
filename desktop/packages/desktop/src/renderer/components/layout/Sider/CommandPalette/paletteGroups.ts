/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommandItem } from '@/common/chat/slash/types';
import type { TChatConversation } from '@/common/config/storage';
import type { NativeConversation } from '@/common/kyrn/nativeBridge';
import { getFuzzyMatchIndices } from '@/renderer/hooks/chat/useSlashCommandController';
import {
  SETTINGS_GROUPS,
  SETTINGS_HOME,
  SETTINGS_PAGES,
  isSettingsPageListed,
} from '@/renderer/pages/settings/settingsNav';
import { formatRelativeTime } from '@/renderer/utils/chat/relativeTime';
import { commandDescription } from '@/renderer/utils/chat/muCommands';
import { getActivityTime } from '@/renderer/utils/chat/timeline';
import { folderName, nativeConversationPath } from '@/renderer/pages/native/utils/paths';

/** Conversations an empty query lists: the most recent ones. */
export const RECENT_CONVERSATIONS = 5;
/** Conversations a query lists at most. */
export const MATCHED_CONVERSATIONS = 8;
/** Settings rows a query lists at most, the one that opens the settings among them: 设 alone would list every page. */
export const MATCHED_SETTINGS = 8;
/** Commands an empty query lists: the first ones the harness offers. A slash or a query lists them all. */
export const TOP_COMMANDS = 5;

/** What the app itself can do from the palette, wherever it is open: start a conversation, open the scheduled tasks. */
export type PaletteAction = 'newConversation' | 'scheduledTasks';
const ACTIONS: readonly PaletteAction[] = ['newConversation', 'scheduledTasks'];

/**
 * One row. `hits` are the indices of `label` that the query matched; they are underlined. A conversation on the native
 * host has the route of its page (`path`) and its folder's name (`detail`); a classic one has neither.
 */
export type PaletteItem =
  | {
      kind: 'conversation';
      key: string;
      label: string;
      hits: number[];
      conversationId: string;
      time: string;
      path?: string;
      detail?: string;
    }
  | { kind: 'messages'; key: string; label: string; hits: number[]; query: string }
  | { kind: 'settings'; key: string; label: string; hits: number[]; path: string }
  | { kind: 'action'; key: string; label: string; hits: number[]; action: PaletteAction }
  | {
      kind: 'command';
      key: string;
      label: string;
      hits: number[];
      name: string;
      detail: string;
      conversationId: string;
    };

/** The three groups of results, then `messages`: the hand-off to the message search, which has no label. */
export type PaletteGroupId = 'conversations' | 'settings' | 'commands' | 'messages';

export type PaletteGroup = { id: PaletteGroupId; label: string; items: PaletteItem[] };

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type PaletteSources = {
  query: string;
  conversations: readonly TChatConversation[];
  /** The open conversation, whose send box takes the commands; null when none is open. */
  commandTarget: string | null;
  /** The harness's slash commands in the open conversation. */
  commands: readonly SlashCommandItem[];
  /** The conversations on the native host, while it is on: found by their title and by their folder's name. */
  nativeConversations?: readonly NativeConversation[];
  t: Translate;
  language: string;
  now: number;
};

/** A conversation the palette can list: an AionCore one, or one on the native host (with its folder and page). */
type Listed = { id: string; label: string; time: number; folder?: string; path?: string };

const conversationRows = (
  { conversations, nativeConversations = [], t, language, now }: PaletteSources,
  keyword: string,
  limit: number
): PaletteItem[] => {
  const listed: Listed[] = [
    ...conversations.map((conversation) => ({
      id: conversation.id,
      label: conversation.name?.trim() || t('conversation.welcome.newConversation'),
      time: getActivityTime(conversation),
    })),
    ...nativeConversations.map((conversation) => ({
      id: conversation.id,
      label: conversation.title || t('mu.native.untitled'),
      time: conversation.updatedAt,
      folder: folderName(conversation.cwd),
      path: nativeConversationPath(conversation.id),
    })),
  ];
  const rows: PaletteItem[] = [];
  // A stable sort: conversations of one time keep their order.
  for (const conversation of listed.toSorted((a, b) => b.time - a.time)) {
    // A native conversation is found by its folder too; then no character of its title is underlined.
    const hits =
      getFuzzyMatchIndices(conversation.label, keyword) ??
      (conversation.folder && getFuzzyMatchIndices(conversation.folder, keyword) ? [] : null);
    if (!hits) continue;
    rows.push({
      kind: 'conversation',
      key: conversation.path ? `native:${conversation.id}` : `conversation:${conversation.id}`,
      label: conversation.label,
      hits,
      conversationId: conversation.id,
      time: formatRelativeTime(conversation.time, language, now),
      ...(conversation.path ? { path: conversation.path, detail: conversation.folder } : {}),
    });
    if (rows.length === limit) break;
  }
  return rows;
};

/** The row that opens the settings where the sidebar opens them. */
const settingsHome = (t: Translate, keyword: string): PaletteItem[] => {
  const label = t('common.commandPalette.openSettings');
  const hits = getFuzzyMatchIndices(label, keyword);
  return hits ? [{ kind: 'settings', key: 'settings:home', label, hits, path: SETTINGS_HOME }] : [];
};

const GROUP_LABELS: ReadonlyMap<string, string> = new Map(SETTINGS_GROUPS.map((group) => [group.id, group.labelKey]));

/**
 * The settings pages a query finds, the best eight. A page answers to its name, then to the words the rail puts it
 * under (its short name and its group's), then to the word for the settings itself, so 设 or "settings" finds them
 * all; the ones it found by name come first, and only those have characters underlined. The row that opens the
 * settings leads.
 */
const settingsRows = ({ t }: PaletteSources, keyword: string): PaletteItem[] => {
  const settingsWord = t('common.settings');
  const found = SETTINGS_PAGES.filter(isSettingsPageListed).flatMap((page) => {
    const label = t(page.labelKey);
    const hits = getFuzzyMatchIndices(label, keyword);
    const railKey: string | undefined = 'railLabelKey' in page ? page.railLabelKey : undefined;
    const groupKey = GROUP_LABELS.get(page.group);
    const rail = [railKey ? t(railKey) : '', groupKey ? t(groupKey) : ''].filter(Boolean);
    const rank = hits
      ? 0
      : rail.some((word) => getFuzzyMatchIndices(word, keyword))
        ? 1
        : getFuzzyMatchIndices(settingsWord, keyword)
          ? 2
          : undefined;
    if (rank === undefined) return [];
    const row: PaletteItem = {
      kind: 'settings',
      key: `settings:${page.id}`,
      label,
      hits: hits ?? [],
      path: `/settings/${page.path}`,
    };
    return [{ row, rank }];
  });
  // A stable sort: pages of one rank keep the rail's order.
  return [...settingsHome(t, keyword), ...found.toSorted((a, b) => a.rank - b.rank).map(({ row }) => row)].slice(
    0,
    MATCHED_SETTINGS
  );
};

const actionRows = ({ t }: PaletteSources, keyword: string): PaletteItem[] =>
  ACTIONS.flatMap((action) => {
    const label = t(`common.commandPalette.actions.${action}`);
    const hits = getFuzzyMatchIndices(label, keyword);
    return hits ? [{ kind: 'action' as const, key: `action:${action}`, label, hits, action }] : [];
  });

/** `keyword` is the query without its leading slash; the label carries one, so every hit moves one place. */
const commandRows = ({ commands, commandTarget, t }: PaletteSources, keyword: string): PaletteItem[] => {
  if (!commandTarget) return [];
  return commands.flatMap((command) => {
    const hits = getFuzzyMatchIndices(command.name, keyword);
    if (!hits) return [];
    return [
      {
        kind: 'command' as const,
        key: `command:${command.name}`,
        label: `/${command.name}`,
        hits: hits.map((index) => index + 1),
        name: command.name,
        detail: commandDescription(command, t),
        conversationId: commandTarget,
      },
    ];
  });
};

/**
 * The palette's rows, in three groups and in this order: conversations, settings, commands. An empty query lists
 * the most recent conversations, the row that opens the settings (the rail has too many pages to list before the
 * person says which one, so the pages appear once they type), and the first few of the harness's commands, or where
 * no conversation takes them, what the app itself can do. It is never empty, so it never says nothing matched before
 * anything was typed. A query lists what matches it and then offers to search the messages for it; that row comes
 * last, so Enter takes a real match first and the hand-off only when nothing else matched. A query that starts with a
 * slash asks for a command, as it does in the send box, so it lists the harness's commands only. A group with no rows
 * is left out.
 */
export const buildPaletteGroups = (sources: PaletteSources): PaletteGroup[] => {
  const { query, t } = sources;
  const keyword = query.trim();
  const groups: PaletteGroup[] = [];
  const add = (id: Exclude<PaletteGroupId, 'messages'>, items: PaletteItem[]) => {
    if (items.length > 0) groups.push({ id, label: t(`common.commandPalette.groups.${id}`), items });
  };

  if (keyword.startsWith('/')) {
    add('commands', commandRows(sources, keyword.slice(1)));
    return groups;
  }

  if (!keyword) {
    const commands = commandRows(sources, '').slice(0, TOP_COMMANDS);
    add('conversations', conversationRows(sources, '', RECENT_CONVERSATIONS));
    add('settings', settingsHome(t, ''));
    add('commands', commands.length > 0 ? commands : actionRows(sources, ''));
    return groups;
  }

  add('conversations', conversationRows(sources, keyword, MATCHED_CONVERSATIONS));
  add('settings', settingsRows(sources, keyword));
  add('commands', [...commandRows(sources, keyword), ...actionRows(sources, keyword)]);
  groups.push({
    id: 'messages',
    label: '',
    items: [
      {
        kind: 'messages',
        key: 'messages',
        label: t('common.commandPalette.searchMessages', { query: keyword }),
        hits: [],
        query: keyword,
      },
    ],
  });
  return groups;
};

export type LabelSegment = { text: string; hit: boolean };

/** Cut a label into runs of matched and unmatched characters, so the matched ones can be underlined. */
export const splitByHits = (label: string, hits: readonly number[]): LabelSegment[] => {
  const marked = new Set(hits);
  const segments: LabelSegment[] = [];
  for (let index = 0; index < label.length; index += 1) {
    const hit = marked.has(index);
    const last = segments[segments.length - 1];
    if (last && last.hit === hit) {
      last.text += label[index];
    } else {
      segments.push({ text: label[index], hit });
    }
  }
  return segments;
};
