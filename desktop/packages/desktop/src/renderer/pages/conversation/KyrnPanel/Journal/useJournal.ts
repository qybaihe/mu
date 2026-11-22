import { useEffect, useRef, useState } from 'react';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import type { JournalView } from '@/common/kyrn/journal';

export type JournalRead = {
  view?: JournalView;
  /** The bridge's own message when the last read failed. */
  error?: string;
  /** Nothing read yet. */
  loading: boolean;
};

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The journal, read whenever it may have moved on: on mount, when the conversation's lessons file was written (a new
 * `signature` — a stored, recalled or retired lesson is a new journal line), and whenever the tab comes back into
 * view (the ledger is appended out of band, by `teams.cjs`, which no event announces). An answer a newer one has
 * overtaken is dropped. Give the tab `key={conversationId}`.
 */
export function useJournal(signature: string, visible: boolean) {
  const [read, setRead] = useState<JournalRead>({ loading: true });
  const latest = useRef(0);

  useEffect(() => {
    const mine = ++latest.current;
    void (async () => {
      try {
        const view = unwrap(await kyrnBridge.journal.invoke());
        if (mine === latest.current) setRead({ view, loading: false });
      } catch (error) {
        if (mine === latest.current) setRead((old) => ({ ...old, loading: false, error: messageOf(error) }));
      }
    })();
  }, [signature, visible]);

  return read;
}
