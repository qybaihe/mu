import { useCallback, useEffect, useRef, useState } from 'react';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { kyrnFolderBridge } from '@/common/kyrn/folderBridge';
import type { LessonChange, LessonEdit, LessonsView } from '@/common/kyrn/lessons';

/** A change the tab asks for; the conversation (or the folder) is added here. */
export type { LessonEdit };

export type LessonsRead = {
  view?: LessonsView;
  /** The bridge's own message when the last read failed. */
  error?: string;
  /** Nothing read yet. */
  loading: boolean;
};

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One conversation's lessons, read from mu's file while the tab is in view: when it comes into view, and again after
 * every lesson event of the session (a new `signature`), since the harness wrote the file then. A change answers with
 * the file as it is after it. An answer that a newer one has overtaken is dropped: a read that left before a change
 * carries the file as it was. Give the tab `key={conversationId}`.
 *
 * `cwd`: the folder of a native conversation, which has no app conversation to read the lessons by; they are read by
 * the folder instead (common/kyrn/folderBridge.ts). Without it, by the conversation.
 */
export function useLessons(conversationId: string, signature: string, visible: boolean, cwd?: string) {
  const [read, setRead] = useState<LessonsRead>({ loading: true });
  const latest = useRef(0);

  useEffect(() => {
    if (!visible) return;
    const mine = ++latest.current;
    void (async () => {
      try {
        const view = unwrap(
          await (cwd === undefined
            ? kyrnBridge.lessons.invoke({ conversationId })
            : kyrnFolderBridge.lessons.invoke({ cwd }))
        );
        if (mine === latest.current) setRead({ view, loading: false });
      } catch (error) {
        if (mine === latest.current) setRead((old) => ({ ...old, loading: false, error: messageOf(error) }));
      }
    })();
  }, [conversationId, cwd, signature, visible]);

  /** Appends the change to the file; a failure is thrown to the row that asked for it, and nothing else changes. */
  const change = useCallback(
    async (edit: LessonEdit): Promise<void> => {
      const request: LessonChange = { ...edit, conversationId };
      const view = unwrap(
        await (cwd === undefined
          ? kyrnBridge.lessonsChange.invoke(request)
          : kyrnFolderBridge.lessonsChange.invoke({ ...edit, cwd }))
      );
      latest.current++;
      setRead({ view, loading: false });
    },
    [conversationId, cwd]
  );

  return { ...read, change };
}
