/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import { ipcBridge } from '@/common';
import type { Activity } from '@/common/kyrn/types';
import { onHiveFocus, type HiveFocusRequest } from '@/renderer/pages/conversation/KyrnPanel/focus';
import { isBrowserMcpActivity } from '@/renderer/pages/conversation/Preview/browser/agentActivity';
import { takeBrowserHandOver, useBrowserHandOver } from '@/renderer/pages/conversation/Preview/browser/browserStore';
import { onPreviewOpened } from '@/renderer/pages/conversation/Preview/context/previewOpeners';
import { WORKSPACE_TOGGLE_EVENT, dispatchWorkspaceStateEvent } from '@/renderer/utils/workspace/workspaceEvents';
import { boardSignature, createEditWatcher, hiveSignature, judgeSignature, lessonsSignature } from './news';
import {
  bumpWorkPanelNews,
  handPreviewToBrowser,
  markWorkPanelUsed,
  noteWorkPanelSignature,
  readWorkPanelMemory,
  rememberWorkPanel,
  setWorkPanelViewing,
  useWorkPanelMemory,
  useWorkPanelUnread,
  useWorkPanelUsed,
  type WorkPanelTab,
} from './workPanelStore';

/**
 * The work panel's wiring for the current conversation. What opens it: the titlebar button and Cmd/Ctrl+J (both
 * the workspace toggle event), a sub-agent line clicked in the transcript (its hive tab), a file the person opens
 * (its preview) and a web page the person opens (its browser). What only marks a tab as new: a new board, a new
 * verdict, a sub-agent starting or ending, a lesson stored, recalled, followed, retired or merged, a file the agent
 * changed, and on the browser a page the agent opened, a run of mu's starting in it, or the agent's browser tool
 * at work. Nothing else the agent does opens the panel; the one exception is mu's browser typing into its page or
 * asking the person to confirm a step on it, which is done where the person can see it (see `previewOpeners.ts`).
 */
export function useWorkPanel(conversationId: string | null, kernel: { events: Activity[]; settled: boolean }) {
  const memory = useWorkPanelMemory(conversationId);
  const unread = useWorkPanelUnread(conversationId);
  const used = useWorkPanelUsed(conversationId);
  const handOver = useBrowserHandOver();
  const [focus, setFocus] = useState<HiveFocusRequest>();

  useEffect(() => {
    setFocus(undefined);
    if (!conversationId) return undefined;
    const toggle = (event: Event) => {
      // Handled: a keyboard caller suppresses the native chord only when a panel answered.
      event.preventDefault();
      rememberWorkPanel(conversationId, { open: !readWorkPanelMemory(conversationId).open });
    };
    window.addEventListener(WORKSPACE_TOGGLE_EVENT, toggle);
    const stopFocus = onHiveFocus((request) => {
      if (request.conversationId !== conversationId) return;
      setFocus(request);
      rememberWorkPanel(conversationId, { open: true, tab: 'hive' });
    });
    const stopOpened = onPreviewOpened((by, where) => {
      if (by === 'agent') bumpWorkPanelNews(conversationId, where);
      else rememberWorkPanel(conversationId, { open: true, tab: where });
    });
    return () => {
      window.removeEventListener(WORKSPACE_TOGGLE_EVENT, toggle);
      stopFocus();
      stopOpened();
    };
  }, [conversationId]);

  // An older build's preview was showing a page when this project was last open: the panel follows it to 浏览器.
  useEffect(() => {
    if (conversationId && handOver && takeBrowserHandOver()) handPreviewToBrowser(conversationId);
  }, [conversationId, handOver]);

  // The titlebar button shows whether the panel is open.
  useEffect(() => {
    if (conversationId) dispatchWorkspaceStateEvent(!memory.open);
  }, [conversationId, memory.open]);

  // What the person looks at is seen as it arrives, and the tab stays in the strip.
  const viewing = memory.open ? memory.tab : null;
  useEffect(() => {
    if (!conversationId) return undefined;
    if (viewing) markWorkPanelUsed(conversationId, viewing);
    setWorkPanelViewing(conversationId, viewing);
    return () => setWorkPanelViewing(conversationId, null);
  }, [conversationId, viewing]);

  // The kernel tabs' news, once the conversation's record has all arrived.
  useEffect(() => {
    if (!conversationId || !kernel.settled) return;
    noteWorkPanelSignature(conversationId, 'board', boardSignature(kernel.events));
    noteWorkPanelSignature(conversationId, 'judge', judgeSignature(kernel.events));
    noteWorkPanelSignature(conversationId, 'hive', hiveSignature(kernel.events));
    noteWorkPanelSignature(conversationId, 'lessons', lessonsSignature(kernel.events));
  }, [conversationId, kernel.events, kernel.settled]);

  // Files the agent changed and the agent's browser tool at work, in any conversation: the dot waits there for the
  // person's return.
  useEffect(() => {
    const stream = ipcBridge.conversation?.responseStream;
    if (!stream?.on) return undefined;
    const edited = createEditWatcher();
    return stream.on((message) => {
      if (!message.conversation_id) return;
      if (edited(message)) bumpWorkPanelNews(message.conversation_id, 'files');
      if (isBrowserMcpActivity(message.type, message.data)) bumpWorkPanelNews(message.conversation_id, 'browser');
    });
  }, []);

  const select = useCallback(
    (tab: WorkPanelTab) => {
      if (conversationId) rememberWorkPanel(conversationId, { open: true, tab });
    },
    [conversationId]
  );
  const close = useCallback(() => {
    if (conversationId) rememberWorkPanel(conversationId, { open: false });
  }, [conversationId]);
  const resize = useCallback(
    (width: number) => {
      if (conversationId) rememberWorkPanel(conversationId, { width });
    },
    [conversationId]
  );

  return { memory, unread, used, focus, select, close, resize };
}
