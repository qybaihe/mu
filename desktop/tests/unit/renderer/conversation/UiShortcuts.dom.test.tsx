import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { NavigateFunction } from 'react-router-dom';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  pathname: '/conversation/conversation-1',
  desktop: true,
  mac: true,
  /** The native host is on: the keys go to the native conversations. */
  native: false,
  visible: [] as string[],
}));

const serviceMocks = vi.hoisted(() => ({
  loadMessages: vi.fn(() => new Promise<never>(() => {})),
  searchMessages: vi.fn().mockResolvedValue({ items: [], has_more: false }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: testState.pathname, search: '', hash: '' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useVisibleConversationIds', () => ({
  useVisibleConversationIds: () => testState.visible,
}));

vi.mock('@/renderer/pages/native/hooks/useNativeConversations', () => ({
  useNativeEnabled: () => testState.native,
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => testState.desktop,
  isMacOS: () => testState.mac,
}));

vi.mock('@/renderer/utils/chat/messagePagination', () => ({
  loadAllConversationMessagesPaged: serviceMocks.loadMessages,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    database: {
      searchConversationMessages: { invoke: serviceMocks.searchMessages },
    },
  },
}));

vi.mock('@/renderer/components/base/MuModal', () => ({
  default: () => null,
}));

vi.mock('@/renderer/components/base', () => ({
  MuSearchInput: () => null,
}));

import { Message } from '@arco-design/web-react';
import { useConversationShortcuts } from '@/renderer/hooks/ui/useConversationShortcuts';
import { forgetNativeUnread, markNativeUnread } from '@/renderer/pages/native/hooks/useNativeAttention';
import {
  nativeConversationAt,
  nativeConversationBeside,
  nextWaitingConversation,
  publishNativeSiderOrder,
  resetNativeSiderOrderForTest,
} from '@/renderer/pages/native/sider/jump';
import { nativeConversationPath } from '@/renderer/pages/native/utils/paths';
import ConversationSearchPopover from '@/renderer/pages/conversation/GroupedHistory/ConversationSearchPopover';
import { useMinimapPanel } from '@/renderer/pages/conversation/components/ConversationTitleMinimap/useMinimapPanel';
import { useWorkspaceCollapse } from '@/renderer/pages/conversation/hooks/useWorkspaceCollapse';
import { emitter } from '@/renderer/utils/emitter';
import {
  COMMAND_PALETTE_SHORTCUT,
  MESSAGE_SEARCH_SHORTCUT,
  formatPrimaryShortcut,
  isShortcutBlockedByTarget,
} from '@/renderer/utils/ui/keyboardShortcuts';
import { dispatchWorkspaceToggleEvent } from '@/renderer/utils/workspace/workspaceEvents';

const dispatchShortcut = (target: EventTarget, init: KeyboardEventInit): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

const renderConversationShortcuts = ({
  navigate = vi.fn(),
  toggleSider = vi.fn(),
}: {
  navigate?: ReturnType<typeof vi.fn>;
  toggleSider?: ReturnType<typeof vi.fn>;
} = {}) => {
  const rendered = renderHook(() =>
    useConversationShortcuts({
      navigate: navigate as unknown as NavigateFunction,
      toggleSider,
    })
  );

  return { ...rendered, navigate, toggleSider };
};

describe('common desktop UI shortcuts', () => {
  beforeEach(() => {
    testState.pathname = '/conversation/conversation-1';
    testState.desktop = true;
    testState.mac = true;
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('uses Cmd+B and leaves Ctrl+B untouched on macOS', () => {
    const { toggleSider } = renderConversationShortcuts();

    const commandEvent = dispatchShortcut(window, { key: 'b', metaKey: true });
    const controlEvent = dispatchShortcut(window, { key: 'b', ctrlKey: true });

    expect(toggleSider).toHaveBeenCalledTimes(1);
    expect(commandEvent.defaultPrevented).toBe(true);
    expect(controlEvent.defaultPrevented).toBe(false);
  });

  it('uses Ctrl+B and leaves Cmd+B untouched on non-macOS platforms', () => {
    testState.mac = false;
    const { toggleSider } = renderConversationShortcuts();

    const controlEvent = dispatchShortcut(window, { key: 'b', ctrlKey: true });
    const commandEvent = dispatchShortcut(window, { key: 'b', metaKey: true });

    expect(toggleSider).toHaveBeenCalledTimes(1);
    expect(controlEvent.defaultPrevented).toBe(true);
    expect(commandEvent.defaultPrevented).toBe(false);
  });

  it('toggles the sidebar while the composer textarea is focused', () => {
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    const { toggleSider } = renderConversationShortcuts();

    const event = dispatchShortcut(composer, { key: 'b', metaKey: true });

    expect(toggleSider).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps the existing new-conversation shortcut isolated from common UI actions', () => {
    const { navigate, toggleSider } = renderConversationShortcuts();

    const event = dispatchShortcut(window, { key: 't', metaKey: true });

    expect(navigate).toHaveBeenCalledWith('/guid');
    expect(toggleSider).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Ctrl+T untouched on macOS', () => {
    const { navigate } = renderConversationShortcuts();

    const event = dispatchShortcut(window, { key: 't', ctrlKey: true });

    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('toggles the command palette with Cmd+K on macOS and leaves Ctrl+K untouched', () => {
    const toggled = vi.fn();
    emitter.on('commandPalette.toggle', toggled);
    renderConversationShortcuts();

    const commandEvent = dispatchShortcut(window, { key: 'k', metaKey: true });
    const controlEvent = dispatchShortcut(window, { key: 'k', ctrlKey: true });
    emitter.off('commandPalette.toggle', toggled);

    expect(toggled).toHaveBeenCalledTimes(1);
    expect(commandEvent.defaultPrevented).toBe(true);
    expect(controlEvent.defaultPrevented).toBe(false);
  });

  it('toggles the command palette with Ctrl+K on other platforms', () => {
    testState.mac = false;
    const toggled = vi.fn();
    emitter.on('commandPalette.toggle', toggled);
    renderConversationShortcuts();

    const controlEvent = dispatchShortcut(window, { key: 'k', ctrlKey: true });
    const commandEvent = dispatchShortcut(window, { key: 'k', metaKey: true });
    emitter.off('commandPalette.toggle', toggled);

    expect(toggled).toHaveBeenCalledTimes(1);
    expect(controlEvent.defaultPrevented).toBe(true);
    expect(commandEvent.defaultPrevented).toBe(false);
  });

  it('leaves Cmd+K to embedded code editors and terminals', () => {
    const toggled = vi.fn();
    emitter.on('commandPalette.toggle', toggled);
    renderConversationShortcuts();
    const targets = [
      Object.assign(document.createElement('div'), { className: 'monaco-editor' }),
      Object.assign(document.createElement('div'), { className: 'xterm' }),
    ];

    const events = targets.map((target) => {
      document.body.appendChild(target);
      return dispatchShortcut(target, { key: 'k', metaKey: true });
    });
    emitter.off('commandPalette.toggle', toggled);

    expect(toggled).not.toHaveBeenCalled();
    expect(events.every((event) => !event.defaultPrevented)).toBe(true);
  });

  it('writes the palette and message-search shortcuts the way the platform does', () => {
    expect(formatPrimaryShortcut(COMMAND_PALETTE_SHORTCUT)).toBe('⌘K');
    expect(formatPrimaryShortcut(MESSAGE_SEARCH_SHORTCUT)).toBe('⇧⌘F');

    testState.mac = false;

    expect(formatPrimaryShortcut(COMMAND_PALETTE_SHORTCUT)).toBe('Ctrl+K');
    expect(formatPrimaryShortcut(MESSAGE_SEARCH_SHORTCUT)).toBe('Ctrl+Shift+F');
  });

  it('keeps Ctrl+Tab as a cross-platform conversation cycling chord', () => {
    const { navigate } = renderConversationShortcuts();

    const event = dispatchShortcut(window, { key: 'Tab', ctrlKey: true });

    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('uses the enabled workspace consumer and preserves its collapse state owner', () => {
    const { result } = renderHook(() => {
      const workspace = useWorkspaceCollapse({
        workspaceEnabled: true,
        isMobile: false,
        conversation_id: 'conversation-1',
      });
      useConversationShortcuts({
        navigate: vi.fn() as unknown as NavigateFunction,
        toggleSider: vi.fn(),
      });
      return workspace;
    });

    const event = dispatchShortcut(window, { key: 'l', metaKey: true });

    expect(result.current.rightSiderCollapsed).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Cmd/Ctrl+L untouched when the conversation has no enabled workspace', () => {
    const { result } = renderHook(() => {
      const workspace = useWorkspaceCollapse({
        workspaceEnabled: false,
        isMobile: false,
        conversation_id: 'conversation-1',
      });
      useConversationShortcuts({
        navigate: vi.fn() as unknown as NavigateFunction,
        toggleSider: vi.fn(),
      });
      return workspace;
    });

    const event = dispatchShortcut(window, { key: 'l', metaKey: true });

    expect(result.current.rightSiderCollapsed).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it('toggles a temporary workspace while its composer textarea is focused', () => {
    testState.pathname = '/guid';
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    const { result } = renderHook(() => {
      const workspace = useWorkspaceCollapse({
        workspaceEnabled: true,
        isMobile: false,
        conversation_id: 'temporary-conversation',
        isTemporaryWorkspace: true,
      });
      useConversationShortcuts({
        navigate: vi.fn() as unknown as NavigateFunction,
        toggleSider: vi.fn(),
      });
      return workspace;
    });

    const event = dispatchShortcut(composer, { key: 'l', metaKey: true });

    expect(result.current.rightSiderCollapsed).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves workspace shortcuts to embedded code editors', () => {
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    document.body.appendChild(editor);
    const { result } = renderHook(() => {
      const workspace = useWorkspaceCollapse({
        workspaceEnabled: true,
        isMobile: false,
        conversation_id: 'conversation-1',
      });
      useConversationShortcuts({
        navigate: vi.fn() as unknown as NavigateFunction,
        toggleSider: vi.fn(),
      });
      return workspace;
    });

    const event = dispatchShortcut(editor, { key: 'l', metaKey: true });

    expect(result.current.rightSiderCollapsed).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores chords with wrong modifiers or unsafe keyboard state', () => {
    const { toggleSider } = renderConversationShortcuts();
    const ineligibleEvents: KeyboardEventInit[] = [
      { key: 'b' },
      { key: 'b', ctrlKey: true, metaKey: true },
      { key: 'b', metaKey: true, altKey: true },
      { key: 'b', metaKey: true, shiftKey: true },
      { key: 'b', metaKey: true, repeat: true },
      { key: 'b', metaKey: true, isComposing: true },
    ];

    for (const init of ineligibleEvents) {
      dispatchShortcut(window, init);
    }
    const preventedEvent = new KeyboardEvent('keydown', {
      key: 'b',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    preventedEvent.preventDefault();
    act(() => window.dispatchEvent(preventedEvent));

    expect(toggleSider).not.toHaveBeenCalled();
  });

  it('leaves sidebar shortcuts to embedded code editors, terminals, and frames', () => {
    const { toggleSider } = renderConversationShortcuts();
    const targets = [
      Object.assign(document.createElement('div'), { className: 'cm-editor' }),
      Object.assign(document.createElement('div'), { className: 'monaco-editor' }),
      Object.assign(document.createElement('div'), { className: 'xterm' }),
      document.createElement('webview'),
      document.createElement('iframe'),
    ];

    const events = targets.map((target) => {
      document.body.appendChild(target);
      return dispatchShortcut(target, { key: 'b', metaKey: true });
    });

    expect(toggleSider).not.toHaveBeenCalled();
    expect(events.every((event) => !event.defaultPrevented)).toBe(true);
  });

  it('handles text and SVG event targets without assuming HTMLElement APIs', () => {
    const { toggleSider } = renderConversationShortcuts();
    const wrapper = document.createElement('div');
    const textTarget = document.createTextNode('label');
    const svgTarget = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    wrapper.append(textTarget, svgTarget);
    document.body.appendChild(wrapper);

    dispatchShortcut(textTarget, { key: 'b', metaKey: true });
    dispatchShortcut(svgTarget, { key: 'b', metaKey: true });

    expect(toggleSider).toHaveBeenCalledTimes(2);
  });

  it('falls back to the event target when composedPath is unavailable', () => {
    const input = document.createElement('input');
    const event = {
      composedPath: undefined,
      target: input,
    } as unknown as KeyboardEvent;

    expect(isShortcutBlockedByTarget(event)).toBe(true);
  });

  it('reports an unhandled workspace toggle when no window global is available', () => {
    vi.stubGlobal('window', undefined);

    try {
      expect(dispatchWorkspaceToggleEvent()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('yields when an embedded surface owns focus after event retargeting', () => {
    const { toggleSider } = renderConversationShortcuts();
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.focus();

    const event = dispatchShortcut(window, { key: 'b', metaKey: true });

    expect(document.activeElement).toBe(frame);
    expect(toggleSider).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('checks focused element ancestors when an editor event is retargeted', () => {
    const { toggleSider } = renderConversationShortcuts();
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    const editorControl = document.createElement('div');
    editorControl.tabIndex = 0;
    editor.appendChild(editorControl);
    document.body.appendChild(editor);
    editorControl.focus();

    const event = dispatchShortcut(window, { key: 'b', metaKey: true });

    expect(document.activeElement).toBe(editorControl);
    expect(toggleSider).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps browser shortcuts intact in WebUI', () => {
    testState.desktop = false;
    const { toggleSider } = renderConversationShortcuts();

    const event = dispatchShortcut(window, { key: 'b', metaKey: true });

    expect(toggleSider).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('removes its listener on unmount', () => {
    const { toggleSider, unmount } = renderConversationShortcuts();
    unmount();

    const event = dispatchShortcut(window, { key: 'b', metaKey: true });

    expect(toggleSider).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('rebinds without retaining a stale listener after dependencies change', () => {
    const firstToggle = vi.fn();
    const secondToggle = vi.fn();
    const navigate = vi.fn() as unknown as NavigateFunction;
    const { rerender } = renderHook(({ toggleSider }) => useConversationShortcuts({ navigate, toggleSider }), {
      initialProps: { toggleSider: firstToggle },
    });

    rerender({ toggleSider: secondToggle });
    dispatchShortcut(window, { key: 'b', metaKey: true });

    expect(firstToggle).not.toHaveBeenCalled();
    expect(secondToggle).toHaveBeenCalledTimes(1);
  });
});

describe('existing conversation search shortcuts', () => {
  beforeEach(() => {
    testState.mac = true;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: globalThis.electronAPI,
    });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('opens current-conversation search with Cmd/Ctrl+F on desktop', () => {
    const { result } = renderHook(() => useMinimapPanel('conversation-1'));

    const event = dispatchShortcut(document.body, { key: 'f', metaKey: true });

    expect(result.current.visible).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Ctrl+F untouched on macOS', () => {
    const { result } = renderHook(() => useMinimapPanel('conversation-1'));
    const input = document.createElement('textarea');
    document.body.appendChild(input);

    const event = dispatchShortcut(input, { key: 'f', ctrlKey: true });

    expect(result.current.visible).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not replace CodeMirror find with current-conversation search', () => {
    const { result } = renderHook(() => useMinimapPanel('conversation-1'));
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    document.body.appendChild(editor);

    const event = dispatchShortcut(editor, { key: 'f', metaKey: true });

    expect(result.current.visible).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps current-conversation search available while the message input is focused', () => {
    const { result } = renderHook(() => useMinimapPanel('conversation-1'));
    const input = document.createElement('textarea');
    document.body.appendChild(input);

    const event = dispatchShortcut(input, { key: 'f', metaKey: true });

    expect(result.current.visible).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not consume current-conversation find when no conversation is active', () => {
    const { result } = renderHook(() => useMinimapPanel(undefined));

    const event = dispatchShortcut(document.body, { key: 'f', metaKey: true });

    expect(result.current.visible).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('opens global search with Cmd/Ctrl+Shift+F on desktop', () => {
    render(
      <ConversationSearchPopover
        renderTrigger={({ isActive }) => <div data-testid='global-search-state'>{String(isActive)}</div>}
      />
    );

    const event = dispatchShortcut(document.body, { key: 'f', metaKey: true, shiftKey: true });

    expect(screen.getByTestId('global-search-state')).toHaveTextContent('true');
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not replace Monaco find with global search', () => {
    render(
      <ConversationSearchPopover
        renderTrigger={({ isActive }) => <div data-testid='global-search-state'>{String(isActive)}</div>}
      />
    );
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    document.body.appendChild(editor);

    const event = dispatchShortcut(editor, { key: 'f', metaKey: true, shiftKey: true });

    expect(screen.getByTestId('global-search-state')).toHaveTextContent('false');
    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps global search available while the message input is focused', () => {
    render(
      <ConversationSearchPopover
        renderTrigger={({ isActive }) => <div data-testid='global-search-state'>{String(isActive)}</div>}
      />
    );
    const input = document.createElement('textarea');
    document.body.appendChild(input);

    const event = dispatchShortcut(input, { key: 'f', metaKey: true, shiftKey: true });

    expect(screen.getByTestId('global-search-state')).toHaveTextContent('true');
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not consume global search when the trigger is disabled', () => {
    render(
      <ConversationSearchPopover
        disabled
        renderTrigger={({ isActive }) => <div data-testid='global-search-state'>{String(isActive)}</div>}
      />
    );

    const event = dispatchShortcut(document.body, { key: 'f', metaKey: true, shiftKey: true });

    expect(screen.getByTestId('global-search-state')).toHaveTextContent('false');
    expect(event.defaultPrevented).toBe(false);
  });

  it('opens global search with the query the command palette hands on', async () => {
    render(
      <ConversationSearchPopover
        renderTrigger={({ isActive }) => <div data-testid='global-search-state'>{String(isActive)}</div>}
      />
    );

    act(() => {
      emitter.emit('conversationSearch.open', ' deploy ');
    });

    expect(screen.getByTestId('global-search-state')).toHaveTextContent('true');
    await waitFor(() =>
      expect(serviceMocks.searchMessages).toHaveBeenCalledWith({ keyword: 'deploy', page: 0, page_size: 20 })
    );
  });

  it('ignores a hand-off from the command palette while disabled', () => {
    render(
      <ConversationSearchPopover
        disabled
        renderTrigger={({ isActive }) => <div data-testid='global-search-state'>{String(isActive)}</div>}
      />
    );

    act(() => {
      emitter.emit('conversationSearch.open', 'deploy');
    });

    expect(screen.getByTestId('global-search-state')).toHaveTextContent('false');
  });

  it('leaves current-conversation find to the browser in WebUI', () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: undefined,
    });
    const { result } = renderHook(() => useMinimapPanel('conversation-1'));

    const event = dispatchShortcut(document.body, { key: 'f', metaKey: true });

    expect(result.current.visible).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves global search to the browser in WebUI', () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: undefined,
    });
    render(
      <ConversationSearchPopover
        renderTrigger={({ isActive }) => <div data-testid='global-search-state'>{String(isActive)}</div>}
      />
    );

    const event = dispatchShortcut(document.body, { key: 'f', metaKey: true, shiftKey: true });

    expect(screen.getByTestId('global-search-state')).toHaveTextContent('false');
    expect(event.defaultPrevented).toBe(false);
  });

  it('removes the current-conversation search listener on unmount', () => {
    const { unmount } = renderHook(() => useMinimapPanel('conversation-1'));
    unmount();

    const event = dispatchShortcut(document.body, { key: 'f', metaKey: true });

    expect(event.defaultPrevented).toBe(false);
  });
});

describe('the keys that go to a conversation', () => {
  beforeEach(() => {
    testState.pathname = '/guid';
    testState.desktop = true;
    testState.mac = true;
    testState.native = true;
    testState.visible = [];
    resetNativeSiderOrderForTest();
    forgetNativeUnread();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('knows the sidebar’s places, the rows beside one, and the next one marked, round to the start', () => {
    expect(nativeConversationAt(1)).toBeUndefined();
    // Before the list said its order, the marks' own.
    expect(nextWaitingConversation(new Set(['x']))).toBe('x');

    publishNativeSiderOrder(['a', 'b', 'c'], ['a', 'b', 'c', 'hidden']);
    expect([nativeConversationAt(1), nativeConversationAt(3), nativeConversationAt(4)]).toEqual(['a', 'c', undefined]);
    expect(nativeConversationBeside('c', 1)).toBe('a');
    expect(nativeConversationBeside('a', -1)).toBe('c');
    expect(nativeConversationBeside(undefined, 1)).toBe('a');
    expect(nativeConversationBeside(undefined, -1)).toBe('c');

    const unread = new Set(['a', 'hidden']);
    expect(nextWaitingConversation(unread, 'b')).toBe('hidden');
    expect(nextWaitingConversation(unread, 'hidden')).toBe('a');
    expect(nextWaitingConversation(unread, 'a')).toBe('hidden');
    expect(nextWaitingConversation(new Set(['a']), 'a')).toBeUndefined();
    // Nothing on screen (the sidebar a rail): the places of all it lists.
    publishNativeSiderOrder([], ['a', 'b']);
    expect(nativeConversationAt(2)).toBe('b');
  });

  it('opens the conversation in a place of the sidebar with Cmd+1 to 9, by the key’s place on the keyboard too', () => {
    publishNativeSiderOrder(['a', 'b', 'c'], ['a', 'b', 'c']);
    const { navigate } = renderConversationShortcuts();

    const second = dispatchShortcut(window, { key: '2', code: 'Digit2', metaKey: true });
    expect(navigate).toHaveBeenLastCalledWith(nativeConversationPath('b'));
    expect(second.defaultPrevented).toBe(true);
    // AZERTY: the digit's key without Shift types "&".
    dispatchShortcut(window, { key: '&', code: 'Digit1', metaKey: true });
    expect(navigate).toHaveBeenLastCalledWith(nativeConversationPath('a'));

    // No conversation in that place, another modifier, or Ctrl on a Mac: nothing, and the key stays the page's.
    const ninth = dispatchShortcut(window, { key: '9', code: 'Digit9', metaKey: true });
    dispatchShortcut(window, { key: '3', code: 'Digit3', metaKey: true, shiftKey: true });
    dispatchShortcut(window, { key: '3', code: 'Digit3', ctrlKey: true });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(ninth.defaultPrevented).toBe(false);
  });

  it('leaves Cmd+digit to an editor or terminal in the page', () => {
    publishNativeSiderOrder(['a'], ['a']);
    const { navigate } = renderConversationShortcuts();
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    document.body.append(editor);
    dispatchShortcut(editor, { key: '1', code: 'Digit1', metaKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('goes to the classic list’s places while the native host is off', () => {
    testState.native = false;
    testState.visible = ['c1', 'c2'];
    const { navigate } = renderConversationShortcuts();
    dispatchShortcut(window, { key: '2', code: 'Digit2', metaKey: true });
    expect(navigate).toHaveBeenLastCalledWith('/conversation/c2');
  });

  it('walks the native rows with Ctrl+Tab and Ctrl+Shift+Tab from the one on screen', () => {
    publishNativeSiderOrder(['a', 'b', 'c'], ['a', 'b', 'c']);
    testState.pathname = nativeConversationPath('b');
    const { navigate } = renderConversationShortcuts();
    dispatchShortcut(window, { key: 'Tab', ctrlKey: true });
    expect(navigate).toHaveBeenLastCalledWith(nativeConversationPath('c'));
    dispatchShortcut(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(navigate).toHaveBeenLastCalledWith(nativeConversationPath('a'));
  });

  it('goes to the next conversation that wants its person with Cmd+Shift+A or the palette, and says when none does', () => {
    publishNativeSiderOrder(['a', 'b', 'c'], ['a', 'b', 'c']);
    testState.pathname = nativeConversationPath('b');
    const info = vi.spyOn(Message, 'info').mockImplementation(() => undefined as never);
    const { navigate } = renderConversationShortcuts();

    dispatchShortcut(window, { key: 'a', metaKey: true, shiftKey: true });
    expect(navigate).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('mu.native.sider.noneWaiting');

    markNativeUnread('a');
    const event = dispatchShortcut(window, { key: 'A', metaKey: true, shiftKey: true });
    expect(navigate).toHaveBeenLastCalledWith(nativeConversationPath('a'));
    expect(event.defaultPrevented).toBe(true);

    markNativeUnread('c');
    act(() => {
      emitter.emit('conversation.nextWaiting');
    });
    expect(navigate).toHaveBeenLastCalledWith(nativeConversationPath('c'));
  });

  it('leaves Cmd+Shift+A alone while the native host is off', () => {
    testState.native = false;
    markNativeUnread('a');
    const { navigate } = renderConversationShortcuts();
    const event = dispatchShortcut(window, { key: 'a', metaKey: true, shiftKey: true });
    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
