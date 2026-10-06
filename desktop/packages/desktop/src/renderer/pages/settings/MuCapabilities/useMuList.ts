import { useCallback, useEffect, useRef, useState } from 'react';
import { unwrap } from '@/common/kyrn/bridge';
import type { KyrnResult } from '@/common/kyrn/errors';
import { toMuError, type MuError } from '../KyrnSettings/fields/muError';

export type MuList<T> = {
  /** The list, once it was read. */
  data?: T;
  /** Why it could not be read. */
  error?: MuError;
  /** What a change answered with: the list after it. */
  set: (data: T) => void;
};

/**
 * A list the main process reads from mu's files: read when the page opens, and again whenever the window comes back to
 * the front, since a file may have changed meanwhile (a skill folder copied in by hand, `mu mcp add` in a terminal).
 */
export function useMuList<T>(read: () => Promise<KyrnResult<T>>): MuList<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<MuError>();
  const reader = useRef(read);
  reader.current = read;
  const load = useCallback(() => {
    void reader
      .current()
      .then(unwrap)
      .then(
        (value) => {
          setData(value);
          setError(undefined);
        },
        (cause: unknown) => setError(toMuError(cause))
      );
  }, []);
  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);
  return { data, error, set: setData };
}
