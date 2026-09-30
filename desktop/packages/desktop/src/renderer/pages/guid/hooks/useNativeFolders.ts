/**
 * The folders the native conversations work in, newest first, while the native host is on (none otherwise), for the
 * home page's folder list: a folder a native conversation used is one to pick again.
 */
import { useMemo } from 'react';
import { useNativeConversations, useNativeEnabled } from '@/renderer/pages/native/hooks/useNativeConversations';

/** How many of them the list takes in. */
const NATIVE_FOLDERS = 8;

export function useNativeFolders(): string[] {
  const { conversations } = useNativeConversations(useNativeEnabled() === true);
  return useMemo(
    () => [...new Set(conversations.map((conversation) => conversation.cwd).filter(Boolean))].slice(0, NATIVE_FOLDERS),
    [conversations]
  );
}

/** The recent folders, then the native conversations' folders the list does not have yet. */
export const withNativeFolders = (recent: readonly string[], native: readonly string[]): string[] => [
  ...recent,
  ...native.filter((folder) => !recent.includes(folder)),
];
