import { isMacOS } from '@/renderer/utils/platform';

const EMBEDDED_EDITOR_SELECTOR = ['.cm-editor', '.cm-content', '.monaco-editor', '.xterm', 'webview', 'iframe'].join(
  ','
);

const EDITABLE_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
].join(',');

export type PrimaryShortcutOptions = {
  key: string;
  shiftKey?: boolean;
  targetGuard?: 'all-editable' | 'embedded-editor';
};

/**
 * Cmd+K on macOS, Ctrl+K elsewhere: the command palette. It works from the message input too, but not from inside
 * an embedded editor or terminal, which keep their own Cmd/Ctrl+K chords.
 */
export const COMMAND_PALETTE_SHORTCUT: PrimaryShortcutOptions = { key: 'k', targetGuard: 'embedded-editor' };

/** Cmd/Ctrl+P: quick open, a file of the open conversation's folder by its name. Not from an embedded editor. */
export const QUICK_OPEN_SHORTCUT: PrimaryShortcutOptions = { key: 'p', targetGuard: 'embedded-editor' };

/** Cmd/Ctrl+Shift+F: the search through what was said in every conversation. */
export const MESSAGE_SEARCH_SHORTCUT: PrimaryShortcutOptions = {
  key: 'f',
  shiftKey: true,
  targetGuard: 'embedded-editor',
};

/** Match the platform-native primary modifier without accepting mixed chords. */
export const isPlatformPrimaryModifier = (event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>): boolean => {
  return isMacOS() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
};

const isBlockingElement = (
  target: EventTarget | null,
  targetGuard: NonNullable<PrimaryShortcutOptions['targetGuard']>
): boolean => {
  if (!(target instanceof Element)) {
    return false;
  }

  if (target.closest(EMBEDDED_EDITOR_SELECTOR)) {
    return true;
  }

  return targetGuard === 'all-editable' && Boolean(target.closest(EDITABLE_SELECTOR));
};

/**
 * Returns whether an application shortcut should yield to an editable or
 * embedded surface. The composed path covers editor content inside shadow DOM;
 * activeElement covers retargeted events from embedded surfaces.
 */
export const isShortcutBlockedByTarget = (
  event: KeyboardEvent,
  targetGuard: NonNullable<PrimaryShortcutOptions['targetGuard']> = 'all-editable'
): boolean => {
  const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  if (eventPath.some((target) => isBlockingElement(target, targetGuard))) {
    return true;
  }

  return typeof document !== 'undefined' && isBlockingElement(document.activeElement, targetGuard);
};

/** Match an exact platform-native Cmd/Ctrl shortcut without consuming editor input. */
export const isPrimaryApplicationShortcut = (
  event: KeyboardEvent,
  { key, shiftKey = false, targetGuard = 'all-editable' }: PrimaryShortcutOptions
): boolean => {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey) {
    return false;
  }

  if (!isPlatformPrimaryModifier(event) || event.shiftKey !== shiftKey) {
    return false;
  }

  return event.key.toLowerCase() === key.toLowerCase() && !isShortcutBlockedByTarget(event, targetGuard);
};

/** A primary-modifier shortcut as the platform writes it: ⌘K on macOS, Ctrl+K elsewhere. */
export const formatPrimaryShortcut = ({ key, shiftKey = false }: PrimaryShortcutOptions): string => {
  const letter = key.toUpperCase();
  if (isMacOS()) {
    return `${shiftKey ? '⇧' : ''}⌘${letter}`;
  }
  return `Ctrl+${shiftKey ? 'Shift+' : ''}${letter}`;
};

/**
 * The primary modifier with Enter, as this computer's own shortcut: "⌘ + Enter" on macOS, "Ctrl + Enter" elsewhere.
 * `enterLabel` is the app language's name for the Enter key.
 */
export const formatPrimaryEnterShortcut = (enterLabel: string): string => `${isMacOS() ? '⌘' : 'Ctrl'} + ${enterLabel}`;
