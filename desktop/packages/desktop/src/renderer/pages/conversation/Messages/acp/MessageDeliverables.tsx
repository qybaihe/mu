/**
 * The files mu's `present` handed the person at the end of a task (a report, a deck, a build): a card in the
 * conversation, each file a row with its name, its folder and its size, opened in the preview with a click. The call
 * carries them as its result's details (packages/kyrn-judge/src/extension/features/present.ts `PresentDetails`), which
 * the native transcript passes on as the call's raw output.
 */
import { Button } from '@arco-design/web-react';
import { FileSuccess } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TMessage } from '@/common/chat/chatLib';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { useOptionalLocalFilePreview } from '@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview';
import { useMessageListRun } from '../hooks';

export type DeliveredFile = { path: string; name: string; bytes: number };
export type Deliverables = { files: DeliveredFile[]; note?: string };

/** As many files as present hands over at most. */
const MAX_FILES = 8;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The files of a finished `present` call, or undefined for any other row, or for one whose files do not read. */
export function deliverables(message: TMessage): Deliverables | undefined {
  if (message.type !== 'acp_tool_call') return undefined;
  const update = record(message.content?.update);
  if (update.title !== 'present' || update.status !== 'completed') return undefined;
  // The relay snake-cases the keys it passes on.
  const output = record(update.raw_output ?? update.rawOutput);
  const files = (Array.isArray(output.files) ? output.files : [])
    .slice(0, MAX_FILES)
    .map(record)
    .flatMap((file): DeliveredFile[] =>
      typeof file.path === 'string' && file.path && typeof file.name === 'string'
        ? [{ path: file.path, name: file.name || file.path, bytes: typeof file.bytes === 'number' ? file.bytes : 0 }]
        : []
    );
  if (files.length === 0) return undefined;
  const note = typeof output.note === 'string' && output.note.trim() ? output.note.trim() : undefined;
  return { files, ...(note ? { note } : {}) };
}

/** 1.2 KB, 3.4 MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** The folder a file is in, as the row shows it beside the name. */
const folderOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '') || path;

const MessageDeliverables: React.FC<{ delivered: Deliverables }> = ({ delivered }) => {
  const { t } = useTranslation();
  const conversation = useConversationContextSafe();
  const run = useMessageListRun();
  const open = useOptionalLocalFilePreview(conversation?.workspace ?? run?.workspace);
  return (
    <div
      className='rd-12px border border-solid border-[var(--color-border-2)] bg-1 p-12px flex flex-col gap-8px max-w-560px'
      data-testid='message-deliverables'
    >
      <div className='flex items-center gap-6px text-13px font-500 text-t-primary'>
        <FileSuccess theme='outline' size='16' aria-hidden='true' />
        <span>{t('messages.deliverables.title', { count: delivered.files.length })}</span>
      </div>
      {delivered.note ? (
        <div className='text-13px leading-20px text-t-secondary whitespace-pre-wrap [word-break:break-word]' dir='auto'>
          {delivered.note}
        </div>
      ) : null}
      <div className='flex flex-col gap-2px'>
        {delivered.files.map((file) => (
          <Button
            key={file.path}
            type='text'
            className='!h-auto !px-8px !py-6px !text-left !justify-start'
            disabled={!open}
            title={file.path}
            aria-label={t('messages.deliverables.open', { name: file.name })}
            data-testid='message-deliverables-file'
            data-path={file.path}
            onClick={() => void open?.(file.path)}
          >
            <span className='flex w-full items-baseline gap-8px min-w-0'>
              <span className='text-13px text-t-primary truncate'>{file.name}</span>
              <span className='text-12px text-t-tertiary truncate flex-1 min-w-0'>{folderOf(file.path)}</span>
              <span className='text-12px text-t-tertiary flex-none'>{fileSize(file.bytes)}</span>
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
};

export default MessageDeliverables;
