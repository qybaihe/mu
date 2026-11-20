/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The team's deliverables, from the header's identity strip: every file the
 * team's `present` calls handed over, across the group chat and every member
 * thread, as one browsable list — name, size, when, and which member
 * delivered it. A file that still exists opens in the preview; one that is
 * gone reads greyed with the tag that says so; a deliverable from the
 * conversation being viewed also offers the jump to its source message. The
 * list is read from the conversations' stored rows each time the modal opens,
 * so it is never staler than the last `present`.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Spin, Tag } from '@arco-design/web-react';
import { FileSuccess } from '@icon-park/react';
import type { TMessage } from '@/common/chat/chatLib';
import { fileRefBridge, FILE_REF_BATCH_LIMIT, type FileRefAnswer } from '@/common/chat/fileRefs/fileRefBridge';
import { formatDateTime } from '@/renderer/services/i18n/format';
import MuModal from '@renderer/components/base/MuModal';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { useOptionalLocalFilePreview } from '@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview';
import { fileSize } from '@/renderer/pages/conversation/Messages/acp/MessageDeliverables';
import { dispatchChatMessageJump } from '@renderer/utils/chat/chatMinimapEvents';
import { loadConversationMessagePage } from '@renderer/utils/chat/messagePagination';
import type { TTeam } from '@/common/types/team/teamTypes';

/** One delivered file as the list shows it. */
export type TeamDeliverable = {
  path: string;
  name: string;
  bytes: number;
  /** The model's one line for the person, when the call carried one. */
  note?: string;
  createdAt: number;
  /** The conversation whose rows carry the `present` call. */
  conversationId: string;
  messageId: string;
};

/** As many files as one `present` call hands over at most (the tool's own cap). */
const MAX_PRESENTED = 8;
/** How many rows of one conversation the scan reads (newest first). */
const SCAN_PAGES = 3;
const SCAN_PAGE_LIMIT = 200;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const isTMessage = (row: unknown): row is TMessage => {
  const candidate = record(row);
  return candidate.type === 'acp_tool_call' && typeof candidate.id === 'string';
};

const deliveredFile = (file: unknown): { path: string; name: string; bytes: number } | undefined => {
  const entry = record(file);
  const path = entry.path;
  const name = entry.name;
  if (typeof path !== 'string' || !path || typeof name !== 'string') return undefined;
  return { path, name: name || path, bytes: typeof entry.bytes === 'number' ? entry.bytes : 0 };
};

/**
 * The delivered files in a conversation's stored rows: every finished
 * `present` call's files, both wire shapes — the native transcript passes the
 * call's details as its raw output, the ACP relay nests them under `details`.
 * Pure: the same rows give the same list, newest call last.
 */
export const deliverablesFromRows = (rows: readonly unknown[], conversationId: string): TeamDeliverable[] => {
  const delivered: TeamDeliverable[] = [];
  for (const row of rows) {
    if (!isTMessage(row)) continue;
    const update = record(record(row.content).update);
    if (update.title !== 'present' || update.status !== 'completed') continue;
    const output = record(update.raw_output ?? update.rawOutput);
    const nested = record(output.details);
    const listed: readonly unknown[] = Array.isArray(output.files)
      ? output.files
      : Array.isArray(nested.files)
        ? nested.files
        : [];
    const noteSource = typeof output.note === 'string' && output.note.trim() ? output.note : nested.note;
    for (const file of listed.slice(0, MAX_PRESENTED)) {
      const valid = deliveredFile(file);
      if (!valid) continue;
      delivered.push({
        ...valid,
        ...(typeof noteSource === 'string' && noteSource.trim() ? { note: noteSource.trim() } : {}),
        createdAt: row.created_at,
        conversationId,
        messageId: row.id,
      });
    }
  }
  return delivered;
};

/** The conversation's rows, capped: the newest pages are where a deliverable lives. */
const scanRowsOf = async (conversationId: string): Promise<readonly TMessage[]> => {
  const latest = await loadConversationMessagePage(conversationId, { limit: SCAN_PAGE_LIMIT, contentMode: 'compact' });
  const pages = [latest.items];
  let before = latest.oldest_cursor;
  let hasMore = latest.has_more_before;
  while (hasMore && before && pages.length < SCAN_PAGES) {
    const page = await loadConversationMessagePage(conversationId, {
      limit: SCAN_PAGE_LIMIT,
      before,
      contentMode: 'compact',
    });
    pages.unshift(page.items);
    before = page.oldest_cursor;
    hasMore = page.has_more_before;
  }
  return pages.flat();
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ok'; deliverables: TeamDeliverable[]; missing: Set<string> };

/** Which of the paths still exist, as a set of the ones that do not. */
const missingPathsOf = async (paths: readonly string[]): Promise<Set<string>> => {
  if (paths.length === 0) return new Set();
  const missing = new Set<string>();
  try {
    for (let start = 0; start < paths.length; start += FILE_REF_BATCH_LIMIT) {
      const batch = paths.slice(start, start + FILE_REF_BATCH_LIMIT);
      // One batch at a time: the main process answers each in order.
      const answer = await fileRefBridge.resolve.invoke({ refs: [...batch] });
      if (answer.ok === false) return new Set();
      batch.forEach((path, i) => {
        const state: FileRefAnswer | undefined = answer.data[i];
        if (state && state.state !== 'found') missing.add(path);
      });
    }
    return missing;
  } catch {
    // Existence is a nicety: when it cannot be checked, every row stays clickable.
    return new Set();
  }
};

const TeamDeliverables: React.FC<{ team: TTeam }> = ({ team }) => {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const conversation = useConversationContextSafe();
  const preview = useOptionalLocalFilePreview(team.workspace);

  const show = (): void => {
    setOpen(true);
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const conversations = team.assistants.map((assistant) => assistant.conversation_id).filter(Boolean);
        const rowsOf = await Promise.all(conversations.map((id) => scanRowsOf(id).catch(() => [] as const)));
        const deliverables = conversations
          .flatMap((id, index) => deliverablesFromRows(rowsOf[index], id))
          .sort((a, b) => b.createdAt - a.createdAt);
        const missing = await missingPathsOf(deliverables.map((entry) => entry.path));
        setState({ kind: 'ok', deliverables, missing });
      } catch {
        setState({ kind: 'error' });
      }
    })();
  };

  const memberNameOf = (conversationId: string): string => {
    const member = team.assistants.find((assistant) => assistant.conversation_id === conversationId);
    return member?.assistant_name ?? t('team.deliverables.sourceUnknown');
  };

  const body =
    state.kind === 'loading' ? (
      <div className='flex items-center justify-center h-120px' data-testid='team-deliverables-loading'>
        <Spin size={20} />
      </div>
    ) : state.kind === 'error' ? (
      <div
        className='flex items-center justify-center h-120px text-13px text-t-tertiary'
        data-testid='team-deliverables-error'
      >
        {t('team.deliverables.error')}
      </div>
    ) : state.deliverables.length === 0 ? (
      <div
        className='flex flex-col items-center justify-center gap-8px h-120px text-13px text-t-tertiary'
        data-testid='team-deliverables-empty'
      >
        <FileSuccess theme='outline' size='24' />
        <span>{t('team.deliverables.empty')}</span>
      </div>
    ) : (
      <div className='flex flex-col gap-2px max-h-60vh overflow-y-auto' data-testid='team-deliverables-list'>
        {state.deliverables.map((entry) => {
          const gone = state.missing.has(entry.path);
          const here = entry.conversationId === conversation?.conversation_id;
          return (
            <div
              key={`${entry.messageId}:${entry.path}`}
              className='flex items-center gap-8px px-8px py-6px rd-6px hover:bg-fill-2 transition-colors'
              data-testid='team-deliverables-file'
              data-missing={gone ? 'true' : undefined}
            >
              <Button
                type='text'
                size='small'
                className='!h-auto !px-4px !py-3px !text-left !justify-start flex-1 min-w-0'
                disabled={gone || !preview}
                title={gone ? t('team.deliverables.missing') : entry.path}
                aria-label={t('team.deliverables.open', { name: entry.name })}
                data-testid='team-deliverables-open'
                data-path={entry.path}
                onClick={() => void preview?.(entry.path)}
              >
                <span className={`flex w-full items-baseline gap-8px min-w-0 ${gone ? 'opacity-50' : ''}`}>
                  <span className='text-13px font-500 text-t-primary truncate'>{entry.name}</span>
                  <span className='text-12px text-t-tertiary flex-none'>{fileSize(entry.bytes)}</span>
                  <span className='text-12px text-t-quaternary truncate flex-1 min-w-0' dir='auto'>
                    {entry.note ?? entry.path}
                  </span>
                </span>
              </Button>
              {gone ? (
                <Tag size='small' color='gray' className='flex-none' data-testid='team-deliverables-missing-tag'>
                  {t('team.deliverables.missing')}
                </Tag>
              ) : null}
              <span className='flex-none text-11.5px text-t-quaternary whitespace-nowrap'>
                {memberNameOf(entry.conversationId)} · {formatDateTime(entry.createdAt, i18n.language)}
              </span>
              {here ? (
                <Button
                  type='text'
                  size='mini'
                  className='!px-4px flex-none'
                  data-testid='team-deliverables-jump'
                  onClick={() =>
                    dispatchChatMessageJump({
                      conversation_id: entry.conversationId,
                      messageId: entry.messageId,
                    })
                  }
                >
                  {t('team.deliverables.jump')}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    );

  return (
    <>
      <Button
        size='mini'
        type='text'
        data-testid='team-deliverables-entry'
        aria-label={t('team.deliverables.entry')}
        title={t('team.deliverables.entry')}
        onClick={show}
      >
        <FileSuccess theme='outline' size='14' />
      </Button>
      <MuModal
        visible={open}
        onCancel={() => setOpen(false)}
        footer={null}
        size='large'
        header={{ title: t('team.deliverables.title'), subtitle: team.name }}
      >
        {body}
      </MuModal>
    </>
  );
};

export default TeamDeliverables;
