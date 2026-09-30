/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The command palette as a person meets it: Cmd/Ctrl+K opens it anywhere, one input finds conversations, settings
 * pages and the harness's slash commands, the arrow keys choose, Enter runs, Esc closes. Arco's modal, the app's
 * event bus, the shortcut hook and the palette's own hooks are real; the data sources are stubbed.
 */

import { Message } from '@arco-design/web-react';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandItem } from '@/common/chat/slash/types';
import type { TChatConversation } from '@/common/config/storage';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import enSettings from '@/renderer/services/i18n/locales/en-US/settings.json';

const state = vi.hoisted(() => ({
  mac: true,
  pathname: '/conversation/c1',
  conversations: [] as unknown[],
  /** The native host's conversations, and whether it is on (undefined: the main process has not said). */
  native: [] as unknown[],
  nativeOn: undefined as boolean | undefined,
  commands: [] as unknown[],
  slashCommandCalls: [] as Array<{ id: string; options: Record<string, unknown> }>,
}));
const navigate = vi.hoisted(() => vi.fn());

// English copy from the real locale files, so rows read as they do in the app.
const MODULES: Record<string, unknown> = {
  common: enCommon,
  conversation: enConversation,
  mu: enMu,
  settings: enSettings,
};
const lookup = (node: unknown, path: string[]): unknown => {
  if (path.length === 0) return node;
  if (!node || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  // Flat keys that contain dots ("tray.showWindow") sit beside nested ones.
  for (let size = path.length; size > 0; size -= 1) {
    const head = path.slice(0, size).join('.');
    if (head in record) {
      const found = lookup(record[head], path.slice(size));
      if (found !== undefined) return found;
    }
  }
  return undefined;
};
const translate = (key: string, options?: Record<string, unknown>): string => {
  const [module, ...path] = key.split('.');
  const value = lookup(MODULES[module], path);
  const text = typeof value === 'string' ? value : key;
  return text.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''));
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en-US' } }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: state.pathname, search: '', hash: '' }),
}));
vi.mock('@/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/platform')>()),
  isElectronDesktop: () => true,
  isMacOS: () => state.mac,
}));
vi.mock('@/renderer/hooks/context/ConversationHistoryContext', () => ({
  useConversationHistoryContext: () => ({ conversations: state.conversations }),
}));
vi.mock('@/renderer/pages/native/hooks/useNativeConversations', () => ({
  useNativeEnabled: () => state.nativeOn,
  useNativeConversations: (enabled: boolean) => ({ conversations: enabled ? state.native : [], loading: false }),
}));
vi.mock('@/renderer/hooks/chat/useSlashCommands', () => ({
  useSlashCommands: (id: string, options: Record<string, unknown>) => {
    state.slashCommandCalls.push({ id, options });
    return id ? state.commands : [];
  },
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useVisibleConversationIds', () => ({
  useVisibleConversationIds: (): string[] => [],
}));
// The message search has its own tests; here it only has to be there.
vi.mock('@/renderer/pages/conversation/GroupedHistory/ConversationSearchPopover', () => ({
  default: (): null => null,
}));

import CommandPalette from '@/renderer/components/layout/Sider/CommandPalette';
import { useConversationShortcuts } from '@/renderer/hooks/ui/useConversationShortcuts';
import {
  resetCurrentConversationForTest,
  setCurrentConversation,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { emitter } from '@/renderer/utils/emitter';

const MINUTE = 60_000;
const NOW = Date.now();

const conversation = (id: string, name: string, minutesAgo: number, type = 'acp'): TChatConversation =>
  ({
    id,
    name,
    type,
    created_at: NOW - minutesAgo * MINUTE,
    modified_at: NOW - minutesAgo * MINUTE,
    extra: {},
  }) as unknown as TChatConversation;

const command = (name: string, description: string): SlashCommandItem => ({
  name,
  description,
  kind: 'template',
  source: 'acp',
  selectionBehavior: 'insert',
});

const onNavigate = vi.fn();

/** The palette with the app's shortcut hook, as the sidebar and the layout mount them. */
const Harness: React.FC = () => {
  useConversationShortcuts({ navigate: navigate as unknown as NavigateFunction, toggleSider: () => {} });
  return <CommandPalette onNavigate={onNavigate} />;
};

const input = () => screen.getByRole('combobox');
const queryInput = () => screen.queryByRole('combobox');
const press = (target: EventTarget, init: KeyboardEventInit) => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
};
const openPalette = () => {
  press(window, state.mac ? { key: 'k', metaKey: true } : { key: 'k', ctrlKey: true });
  return input();
};
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const key = (name: string) => fireEvent.keyDown(input(), { key: name });
const groupsShown = () =>
  Array.from(document.querySelectorAll('[data-palette-group]')).map((node) => node.getAttribute('data-palette-group'));
/** The labels of a group's rows, without the time or description beside them. */
const labelsOf = (group: string) =>
  Array.from(document.querySelectorAll(`[data-palette-group="${group}"] [role="option"]`)).map(
    (row) => row.firstElementChild?.textContent
  );
const chosen = () =>
  screen.getAllByRole('option').find((row) => row.getAttribute('aria-selected') === 'true')?.firstElementChild
    ?.textContent;

describe('command palette', () => {
  beforeEach(() => {
    state.mac = true;
    state.pathname = '/conversation/c1';
    state.slashCommandCalls = [];
    state.nativeOn = undefined;
    state.native = [
      { id: 'n1', cwd: '/work/kyrn-desktop', title: 'Native board fixes', createdAt: 1, updatedAt: NOW, live: false },
    ];
    state.conversations = [
      conversation('c1', 'Refactor the auth flow', 1),
      conversation('c2', 'Board copy review', 30),
      conversation('c3', 'Kernel tuning notes', 90),
      conversation('c4', 'Release checklist', 60 * 5),
      conversation('c5', 'Windows installer', 60 * 26),
      conversation('c6', 'Older idea', 60 * 24 * 3),
      conversation('c7', 'Oldest idea', 60 * 24 * 9),
      conversation('c9', 'A local model chat', 60 * 24 * 20, 'aionrs'),
    ];
    state.commands = [
      command('board', 'Show the plain-language board'),
      command('compact', 'Summarize the conversation so far'),
      command('kernel', 'Show what the kernel is doing'),
      command('model', 'Pick the model for this conversation'),
    ];
    setCurrentConversation('c1');
    navigate.mockClear();
    onNavigate.mockClear();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    resetCurrentConversationForTest();
    emitter.removeAllListeners('sendbox.command');
    emitter.removeAllListeners('conversationSearch.open');
  });

  describe('opening and closing', () => {
    it('opens with Cmd+K on macOS, and the same keys close it', async () => {
      render(<Harness />);
      expect(queryInput()).not.toBeInTheDocument();

      const field = openPalette();
      expect(field).toHaveFocus();

      press(field, { key: 'k', metaKey: true });
      await waitFor(() => expect(queryInput()).not.toBeInTheDocument());
    });

    it('opens with Ctrl+K on Windows and Linux, and leaves Cmd+K alone there', () => {
      state.mac = false;
      render(<Harness />);

      press(window, { key: 'k', metaKey: true });
      expect(queryInput()).not.toBeInTheDocument();

      press(window, { key: 'k', ctrlKey: true });
      expect(input()).toBeInTheDocument();
    });

    it('opens inside the settings too', () => {
      state.pathname = '/settings/system';
      setCurrentConversation(null);
      render(<Harness />);

      openPalette();
      type('judge');
      expect(labelsOf('settings')).toContain('Judges');
    });

    it('opens while the message input has the focus', () => {
      const composer = document.createElement('textarea');
      document.body.appendChild(composer);
      composer.focus();
      render(<Harness />);

      press(composer, { key: 'k', metaKey: true });
      expect(input()).toBeInTheDocument();
    });

    it('leaves Cmd+K to an embedded code editor', () => {
      const editor = document.createElement('div');
      editor.className = 'monaco-editor';
      document.body.appendChild(editor);
      render(<Harness />);

      press(editor, { key: 'k', metaKey: true });
      expect(queryInput()).not.toBeInTheDocument();
    });

    it('closes on Esc and hands the focus back to where it was', async () => {
      const composer = document.createElement('textarea');
      document.body.appendChild(composer);
      composer.focus();
      render(<Harness />);
      press(composer, { key: 'k', metaKey: true });

      key('Escape');

      await waitFor(() => expect(queryInput()).not.toBeInTheDocument());
      expect(composer).toHaveFocus();
    });

    it('starts from an empty query each time it opens', async () => {
      render(<Harness />);
      openPalette();
      type('auth');
      key('Escape');
      await waitFor(() => expect(queryInput()).not.toBeInTheDocument());

      expect(openPalette()).toHaveValue('');
    });
  });

  describe('what it lists', () => {
    it('lists the groups in order: conversations, settings, commands, then the message search', () => {
      render(<Harness />);
      openPalette();
      type('model');

      expect(groupsShown()).toEqual(['conversations', 'settings', 'commands', 'messages']);
      expect(labelsOf('conversations')).toEqual(['A local model chat']);
      // The page named by the query first, then the one the rail puts under "Models".
      expect(labelsOf('settings')).toEqual(['Default model', 'Providers']);
      expect(labelsOf('commands')).toEqual(['/model']);
    });

    it('labels each group', () => {
      render(<Harness />);
      openPalette();
      type('model');

      const labels = screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'));
      expect(labels.slice(0, 3)).toEqual(['Conversations', 'Settings', 'Commands']);
    });

    it('shows the five most recent conversations, the way into the settings and the first commands for an empty query', () => {
      render(<Harness />);
      openPalette();

      expect(groupsShown()).toEqual(['conversations', 'settings', 'commands']);
      expect(labelsOf('settings')).toEqual(['Open settings']);
      expect(labelsOf('conversations')).toEqual([
        'Refactor the auth flow',
        'Board copy review',
        'Kernel tuning notes',
        'Release checklist',
        'Windows installer',
      ]);
      expect(labelsOf('commands')).toEqual(['/board', '/compact', '/kernel', '/model']);
    });

    it('lists the settings pages once the person types, not before', () => {
      render(<Harness />);
      openPalette();
      expect(labelsOf('settings')).toEqual(['Open settings']);

      type('model');
      expect(labelsOf('settings')).toEqual(['Default model', 'Providers']);
    });

    it('with no conversation yet, shows the way into the settings and what the app can do, and says why', () => {
      state.conversations = [];
      setCurrentConversation(null);
      render(<Harness />);
      openPalette();

      expect(groupsShown()).toEqual(['settings', 'commands']);
      expect(labelsOf('commands')).toEqual(['Start a new chat', 'Open scheduled tasks']);
      expect(screen.getByTestId('command-palette-hint')).toHaveTextContent(
        'No conversations yet. Type to find settings and commands.'
      );
      // Nothing was typed, so nothing failed to match.
      expect(screen.queryByText('No matches')).not.toBeInTheDocument();

      type('set');
      expect(screen.queryByTestId('command-palette-hint')).not.toBeInTheDocument();
    });

    it('finds the settings pages by the word for the settings, the way into them first, eight rows at most', () => {
      render(<Harness />);
      openPalette();
      type('sett');

      const found = labelsOf('settings');
      expect(found[0]).toBe('Open settings');
      expect(found).toHaveLength(8);
      expect(found).toEqual(expect.arrayContaining(['Appearance', 'Default model']));
      key('Enter');
      expect(navigate).toHaveBeenCalledWith('/settings/providers');
    });

    it('puts how long ago beside a conversation', () => {
      render(<Harness />);
      openPalette();

      const first = screen.getAllByRole('option')[0];
      expect(first).toHaveTextContent('1 minute ago');
    });

    it('underlines the characters the query matched, whatever their case', () => {
      render(<Harness />);
      openPalette();
      type('AUTH');

      const row = screen.getAllByRole('option')[0];
      expect(Array.from(row.querySelectorAll('[data-hit]')).map((hit) => hit.textContent)).toEqual(['auth']);
    });

    it('lists commands only for a query that starts with a slash', () => {
      render(<Harness />);
      openPalette();
      type('/oar');

      expect(groupsShown()).toEqual(['commands']);
      expect(labelsOf('commands')).toEqual(['/board']);
      expect(document.querySelector('[data-palette-group="commands"] [data-hit]')).toHaveTextContent('oar');
    });

    it('offers no commands when no conversation is open', () => {
      setCurrentConversation(null);
      render(<Harness />);
      openPalette();
      type('board');

      expect(groupsShown()).not.toContain('commands');
    });

    it('offers no commands in a conversation whose send box does not take them', () => {
      setCurrentConversation('c9');
      render(<Harness />);
      openPalette();
      type('board');

      expect(groupsShown()).not.toContain('commands');
    });

    it('asks for the commands without starting the runtime of the conversation', async () => {
      render(<Harness />);
      openPalette();

      const call = state.slashCommandCalls.find((entry) => entry.id === 'c1');
      expect(call?.options.agentStatus).toBeTruthy();
      const prepareRuntime = call?.options.prepareRuntime;
      expect(prepareRuntime).toBeTypeOf('function');
      await expect((prepareRuntime as () => Promise<void>)()).resolves.toBeUndefined();
    });

    it('says so when nothing matches', () => {
      setCurrentConversation(null);
      render(<Harness />);
      openPalette();
      type('/nothing');

      expect(screen.queryAllByRole('option')).toHaveLength(0);
      expect(screen.getByText('No matches')).toBeInTheDocument();
    });
  });

  describe('choosing and running', () => {
    it('chooses the first row, moves with the arrow keys and wraps around', () => {
      render(<Harness />);
      openPalette();
      expect(chosen()).toBe('Refactor the auth flow');

      key('ArrowDown');
      expect(chosen()).toBe('Board copy review');

      key('ArrowUp');
      key('ArrowUp');
      expect(chosen()).toBe('/model');

      key('ArrowDown');
      expect(chosen()).toBe('Refactor the auth flow');
    });

    it('goes back to the first row when the query changes', () => {
      render(<Harness />);
      openPalette();
      key('ArrowDown');
      key('ArrowDown');

      type('e');
      expect(chosen()).toBe(labelsOf('conversations')[0]);
    });

    it('opens the chosen conversation on Enter and closes', async () => {
      render(<Harness />);
      openPalette();
      type('board');

      key('Enter');

      expect(navigate).toHaveBeenCalledWith('/conversation/c2');
      expect(onNavigate).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(queryInput()).not.toBeInTheDocument());
    });

    it('finds a native conversation by its title or its folder while the native host is on, and opens its page', async () => {
      render(<Harness />);
      openPalette();
      type('native board');
      // Off, or not said yet: the list is the classic one.
      expect(labelsOf('conversations')).toEqual([]);
      cleanup();
      state.nativeOn = true;
      render(<Harness />);
      openPalette();
      type('native board');
      expect(labelsOf('conversations')).toEqual(['Native board fixes']);
      expect(document.querySelector('[data-palette-group="conversations"] [role="option"]')).toHaveTextContent(
        'kyrn-desktop'
      );
      type('kyrn-desk');
      expect(labelsOf('conversations')).toEqual(['Native board fixes']);
      key('Enter');
      expect(navigate).toHaveBeenCalledWith('/conversation/native/n1');
      await waitFor(() => expect(queryInput()).not.toBeInTheDocument());
    });

    it('goes to the chosen settings page on Enter', () => {
      render(<Harness />);
      openPalette();
      type('appear');

      key('Enter');

      expect(navigate).toHaveBeenCalledWith('/settings/appearance');
    });

    it('sends the chosen command into the open conversation on Enter, as if typed there', async () => {
      const sent = vi.fn();
      emitter.on('sendbox.command', sent);
      render(<Harness />);
      openPalette();
      type('comp');

      // The conversations and the settings have nothing for "comp": the command is the first row.
      key('Enter');

      // The third argument hears what became of the command (see the next test).
      expect(sent).toHaveBeenCalledWith('/compact', 'c1', expect.any(Function));
      expect(navigate).not.toHaveBeenCalled();
      await waitFor(() => expect(queryInput()).not.toBeInTheDocument());
    });

    it('hands the query on to the message search when no title matches', () => {
      const opened = vi.fn();
      emitter.on('conversationSearch.open', opened);
      render(<Harness />);
      openPalette();
      type('deploy');

      expect(chosen()).toBe('Search messages for “deploy”');
      key('Enter');

      expect(opened).toHaveBeenCalledWith('deploy');
    });

    it('starts a conversation or opens the scheduled tasks, as the sidebar’s rows do', () => {
      render(<Harness />);
      openPalette();
      type('scheduled');
      key('Enter');
      expect(navigate).toHaveBeenCalledWith('/scheduled');
      expect(onNavigate).toHaveBeenCalledTimes(1);

      openPalette();
      type('new chat');
      key('Enter');
      expect(navigate).toHaveBeenLastCalledWith('/guid', { state: { resetAssistant: true } });
    });

    it('does not run a row on the Enter that ends an IME composition', () => {
      render(<Harness />);
      openPalette();
      type('board');

      fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });

      expect(navigate).not.toHaveBeenCalled();
    });

    it('runs a row on a click', () => {
      render(<Harness />);
      openPalette();
      type('judges');

      fireEvent.click(screen.getByText('Judges'));

      expect(navigate).toHaveBeenCalledWith('/settings/judges');
    });

    it('says a command waits while the agent works, and nothing when it went out at once', () => {
      const info = vi.spyOn(Message, 'info').mockImplementation(() => () => {});
      let outcome: 'waiting' | 'sent' = 'waiting';
      // Stands in for the send box, which hears the command and says what became of it.
      emitter.on('sendbox.command', (_command, _target, heard) => heard?.(outcome));
      render(<Harness />);

      openPalette();
      type('comp');
      key('Enter');
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith('Runs once this reply is done');

      outcome = 'sent';
      openPalette();
      type('comp');
      key('Enter');
      expect(info).toHaveBeenCalledTimes(1);
      info.mockRestore();
    });
  });
});
