/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import type { ReactNode } from 'react';

export type WorkspaceGroup = {
  workspace: string;
  display_name: string;
  conversations: TChatConversation[];
};

export type TimelineItem = {
  type: 'workspace' | 'conversation';
  time: number;
  workspaceGroup?: WorkspaceGroup;
  conversation?: TChatConversation;
};

export type TimelineSection = {
  timeline: string;
  items: TimelineItem[];
};

export type GroupedHistoryResult = {
  pinnedConversations: TChatConversation[];
  timelineSections: TimelineSection[];
};

export type ExportZipFile = {
  name: string;
  content?: string;
  sourcePath?: string;
};

export type ExportTask =
  | { mode: 'single'; conversation: TChatConversation }
  | { mode: 'batch'; conversation_ids: string[] }
  | null;

export type ConversationRowProps = {
  conversation: TChatConversation;
  isGenerating: boolean;
  /** The agent is blocked awaiting the user (tool permission or a question).
   *  Takes display precedence over `isGenerating` — a distinct "needs you" icon
   *  replaces the generating spinner. */
  isWaitingConfirmation: boolean;
  hasUnread: boolean;
  /** Whether the user manually marked this conversation as unread (persisted). */
  isManualUnread: boolean;
  collapsed: boolean;
  tooltipEnabled: boolean;
  batchMode: boolean;
  checked: boolean;
  selected: boolean;
  menuVisible: boolean;
  /**
   * The row's place in the Tab order: 0 for the one row of the sidebar's list that Tab reaches, -1 for the others,
   * which the arrow keys reach (`useRovingRows`). A row on its own is a stop.
   */
  tabIndex?: number;
  onToggleChecked: (conversation: TChatConversation) => void;
  onConversationClick: (conversation: TChatConversation) => void;
  onOpenMenu: (conversation: TChatConversation) => void;
  onMenuVisibleChange: (conversation_id: string, visible: boolean) => void;
  onEditStart: (conversation: TChatConversation) => void;
  onCreateCronTask: (conversation: TChatConversation) => void;
  onArchive: (conversation: TChatConversation) => void;
  onExport?: (conversation: TChatConversation) => void;
  onTogglePin: (conversation: TChatConversation) => void;
  onToggleManualUnread: (conversation: TChatConversation) => void;
  getJobStatus: (conversation_id: string) => 'none' | 'active' | 'paused' | 'error' | 'unread';
  /** Resolve a loaded conversation's name by id (fork-lineage badge tooltip). */
  resolveConversationName?: (conversation_id: string) => string | undefined;
  /** When true, the agent icon is dimmed by default and only shows full color on hover. Used inside project folders to reduce visual weight. */
  dimIcon?: boolean;
  /** Hover-reveal drag handle overlaying the leading icon; supplied by the sortable wrapper for reorderable (pinned) rows. */
  dragHandle?: ReactNode;
};

export type WorkspaceGroupedHistoryProps = {
  onSessionClick?: () => void;
  collapsed?: boolean;
  tooltipEnabled?: boolean;
  batchMode?: boolean;
  onBatchModeChange?: (value: boolean) => void;
  afterPinnedContent?: ReactNode;
  /**
   * No placeholder that says there is no conversation history when the list is empty: the content above it lists
   * conversations of its own (the native group), which says so itself when it has none.
   */
  hideEmptyState?: boolean;
};

export type DragItemType = 'conversation' | 'workspace';

export type DragItem = {
  type: DragItemType;
  id: string;
  conversation?: TChatConversation;
  workspaceGroup?: WorkspaceGroup;
  sourceSection: 'pinned' | string;
  sourceWorkspace?: string;
};
