/**
 * The work panel beside a native conversation: the conversation is the current one (the panel follows it), and the
 * panel's Jev tabs read what the view holds instead of the mu bridge's telemetry, which a native conversation does not
 * have. They read it at most twice a second while a reply streams: a text delta changes nothing they show, and the
 * bridge's record was read once a second. A native conversation has no AionCore project, so the explorer shows none
 * (not the project of the conversation shown before); the panel reads the conversation's folder instead (`cwd`).
 *
 * `epoch` is the conversation state's (hooks/useNativeConversation.ts): which view this is, new each time the whole view
 * is replaced (the snapshot came, another session, a fork).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NativeFailure } from '@/common/kyrn/nativeBridge';
import type { NativeView } from '@/common/utils/nativeHost';
import { bumpWorkPanelNews } from '@/renderer/components/layout/WorkPanel/workPanelStore';
import {
  getCurrentConversation,
  setCurrentConversation,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { setCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { previewScopeKey } from '@/renderer/pages/conversation/Preview/context/previewScope';
import { finishedEdits } from '../utils/editNews';
import { publishNativeActivity, withdrawNativeActivity } from '../utils/nativeActivityStore';
import { toActivity } from '../utils/toActivity';

const EVERY_MS = 500;

/** The latest value, at most once every `ms`. */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    latest.current = value;
    if (timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setShown(latest.current);
    }, ms);
  }, [value, ms]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    },
    []
  );
  return shown;
}

/** `cwd`: the folder the conversation works in, once its snapshot says (the panel reads its lessons and files by it). */
export function useNativePanel(
  id: string,
  view: NativeView,
  epoch: number,
  loading: boolean,
  failure?: NativeFailure,
  cwd?: string
): void {
  // Before paint: the layout keeps the last project on every /conversation/ route.
  useLayoutEffect(() => setCurrentProject(null), [id]);
  useEffect(() => {
    setCurrentConversation(id);
    return () => {
      if (getCurrentConversation() === id) setCurrentConversation(null);
    };
  }, [id]);

  // The preview belongs to a folder, as a conversation without an AionCore project has it: another folder's closes.
  const closePreviewIfScopeChanged = useOptionalPreviewContext()?.closePreviewIfScopeChanged;
  useEffect(() => {
    if (cwd) closePreviewIfScopeChanged?.(previewScopeKey(null, cwd));
  }, [closePreviewIfScopeChanged, cwd]);

  // The view goes through the throttle with the epoch it is of, so what was read late is known to be of the view before.
  const looked = useThrottled(
    useMemo(() => ({ epoch, view }), [epoch, view]),
    EVERY_MS
  );
  const shown = looked.view;
  const events = useMemo(() => toActivity(shown), [shown]);
  const error = failure?.message;
  const activity = useMemo(
    () => ({ events, loading, settled: !loading, ...(error !== undefined ? { error } : {}) }),
    [error, events, loading]
  );
  useEffect(() => {
    publishNativeActivity({ conversationId: id, activity, ...(cwd ? { cwd } : {}) });
  }, [activity, cwd, id]);
  useEffect(() => () => withdrawNativeActivity(id), [id]);

  // A file the model finished writing or editing is news for the files tab, which gets its dot unless the person is
  // looking at it. What a view held when it came (opened, replaced by a fork) is where it stands, not news, so the count
  // is taken from the first read of that view, and a view that shrinks lowers what news is measured from.
  const edits = useMemo(() => finishedEdits(shown), [shown]);
  const seen = useRef<{ epoch: number; edits: number }>(undefined);
  useEffect(() => {
    if (looked.epoch !== epoch) return;
    if (seen.current?.epoch === epoch && edits > seen.current.edits) bumpWorkPanelNews(id, 'files');
    seen.current = { epoch, edits };
  }, [edits, epoch, id, looked.epoch]);
}
