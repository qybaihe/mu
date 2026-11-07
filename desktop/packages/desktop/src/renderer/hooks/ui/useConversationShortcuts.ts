import { Message } from '@arco-design/web-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { NavigateFunction } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import { SHORTCUT_SHEET_SHORTCUT } from '@/renderer/components/layout/Sider/CommandPalette/ShortcutSheet';
import { useVisibleConversationIds } from '@/renderer/pages/conversation/GroupedHistory/hooks/useVisibleConversationIds';
import { nativeUnreadNow } from '@/renderer/pages/native/hooks/useNativeAttention';
import { useNativeEnabled } from '@/renderer/pages/native/hooks/useNativeConversations';
import {
  nativeConversationAt,
  nativeConversationBeside,
  nextWaitingConversation,
} from '@/renderer/pages/native/sider/jump';
import { nativeConversationPath } from '@/renderer/pages/native/utils/paths';
import { emitter } from '@/renderer/utils/emitter';
import { isElectronDesktop } from '@/renderer/utils/platform';
import {
  COMMAND_PALETTE_SHORTCUT,
  NEXT_WAITING_SHORTCUT,
  QUICK_OPEN_SHORTCUT,
  isPlatformPrimaryModifier,
  isPrimaryApplicationShortcut,
  primaryDigit,
} from '@/renderer/utils/ui/keyboardShortcuts';
import { dispatchWorkspaceToggleEvent } from '@/renderer/utils/workspace/workspaceEvents';

type UseConversationShortcutsParams = {
  navigate: NavigateFunction;
  toggleSider: () => void;
};

const getCycledConversationId = (
  visibleConversationIds: string[],
  activeConversationId: string | null,
  direction: 1 | -1
): string | null => {
  if (visibleConversationIds.length < 2 || !activeConversationId) {
    return null;
  }

  const activeIndex = visibleConversationIds.findIndex((conversation_id) => conversation_id === activeConversationId);
  if (activeIndex === -1) {
    return null;
  }

  const nextIndex = (activeIndex + direction + visibleConversationIds.length) % visibleConversationIds.length;
  return visibleConversationIds[nextIndex] ?? null;
};

const isConversationTabShortcut = (event: KeyboardEvent): boolean => {
  return event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab';
};

const isNewConversationShortcut = (event: KeyboardEvent): boolean => {
  return isPlatformPrimaryModifier(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 't';
};

/** The native conversation on screen, from the page's address. */
const nativeConversationOn = (pathname: string): string | undefined => {
  const encoded = /^\/conversation\/native\/([^/]+)/.exec(pathname)?.[1];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
};

/**
 * The app's keys for conversations and panels. Ctrl+Tab and Ctrl+Shift+Tab go to the conversation under or above the
 * one on screen, and Cmd/Ctrl+1 to 9 to the one in that place of the sidebar's list; with the native host on, the
 * native conversations as the sidebar shows them (jump.ts), and Cmd/Ctrl+Shift+A goes to the next one that wants its
 * person, or says that none does. Cmd/Ctrl+/ shows them all (ShortcutSheet.tsx).
 */
export const useConversationShortcuts = ({ navigate, toggleSider }: UseConversationShortcutsParams): void => {
  const { t } = useTranslation();
  const location = useLocation();
  const visibleConversationIds = useVisibleConversationIds();
  const native = useNativeEnabled() === true;

  // The command palette's row for the next conversation that wants its person comes here too.
  useEffect(() => {
    if (!native) return undefined;
    const goToNextWaiting = () => {
      const next = nextWaitingConversation(nativeUnreadNow(), nativeConversationOn(location.pathname));
      if (next) void navigate(nativeConversationPath(next));
      else Message.info(t('mu.native.sider.noneWaiting'));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isElectronDesktop() || !isPrimaryApplicationShortcut(event, NEXT_WAITING_SHORTCUT)) return;
      event.preventDefault();
      goToNextWaiting();
    };
    emitter.on('conversation.nextWaiting', goToNextWaiting);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      emitter.off('conversation.nextWaiting', goToNextWaiting);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [location.pathname, native, navigate, t]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }

      if (!isElectronDesktop()) {
        return;
      }

      if (isConversationTabShortcut(event)) {
        event.preventDefault();
        if (native) {
          const target = nativeConversationBeside(nativeConversationOn(location.pathname), event.shiftKey ? -1 : 1);
          if (target) void navigate(nativeConversationPath(target));
          return;
        }
        const currentConversationId = location.pathname.match(/^\/conversation\/([^/]+)/)?.[1] ?? null;
        const targetConversationId = getCycledConversationId(
          visibleConversationIds,
          currentConversationId,
          event.shiftKey ? -1 : 1
        );

        if (targetConversationId) {
          void navigate(`/conversation/${targetConversationId}`);
        }
        return;
      }

      const place = primaryDigit(event);
      if (place !== null) {
        const target = native ? nativeConversationAt(place) : visibleConversationIds[place - 1];
        if (!target) return;
        event.preventDefault();
        void navigate(native ? nativeConversationPath(target) : `/conversation/${target}`);
        return;
      }

      if (isNewConversationShortcut(event)) {
        event.preventDefault();
        void navigate('/guid');
        return;
      }

      if (isPrimaryApplicationShortcut(event, { key: 'b', targetGuard: 'embedded-editor' })) {
        event.preventDefault();
        toggleSider();
        return;
      }

      // The palette is mounted with the sidebar on every page, the settings included.
      if (isPrimaryApplicationShortcut(event, COMMAND_PALETTE_SHORTCUT)) {
        event.preventDefault();
        emitter.emit('commandPalette.toggle');
        return;
      }

      // The keyboard shortcuts are mounted beside the palette too.
      if (isPrimaryApplicationShortcut(event, SHORTCUT_SHEET_SHORTCUT)) {
        event.preventDefault();
        emitter.emit('shortcuts.toggle');
        return;
      }

      // Quick open is mounted beside the palette; it finds the files of the open conversation's folder.
      if (isPrimaryApplicationShortcut(event, QUICK_OPEN_SHORTCUT)) {
        event.preventDefault();
        emitter.emit('quickOpen.toggle');
        return;
      }

      // Cmd/Ctrl+J opens and closes the work panel; Cmd/Ctrl+L, the older chord, does the same.
      if (
        isPrimaryApplicationShortcut(event, { key: 'j', targetGuard: 'embedded-editor' }) ||
        isPrimaryApplicationShortcut(event, { key: 'l', targetGuard: 'embedded-editor' })
      ) {
        const handled = dispatchWorkspaceToggleEvent();
        if (handled) {
          event.preventDefault();
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [location.pathname, native, navigate, toggleSider, visibleConversationIds]);
};
