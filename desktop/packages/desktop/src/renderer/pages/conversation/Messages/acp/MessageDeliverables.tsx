/**
 * The files mu's `present` handed the person at the end of a task (a report, a deck, a build): a card in the
 * conversation, each file a row with its name, its folder and its size, opened in the preview with a click. The call
 * carries them as its result's details (packages/kyrn-judge/src/extension/features/present.ts `PresentDetails`), which
 * the native transcript passes on as the call's raw output.
 */
import { Button, Message, Tooltip } from '@arco-design/web-react';
import { FileSuccess, Link } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TMessage } from '@/common/chat/chatLib';
import { ipcBridge } from '@/common';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import LocalImageView from '@/renderer/components/media/LocalImageView';
import { useOptionalLocalFilePreview } from '@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview';
import { useMessageListRun } from '../hooks';
import { emitter } from '@/renderer/utils/emitter';
import { iconColors } from '@/renderer/styles/colors';

/** HTML rows carry the image/video-style hover actions; other rows stay plain. */
const HTML_FILE_RE = /\.x?html?$/i;

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

/** An image `present` handed over: the row shows it, not only its name. */
const IMAGE_PATH_RE = /\.(?:png|jpe?g|webp|gif|bmp)$/i;
const isImagePath = (path: string): boolean => IMAGE_PATH_RE.test(path);

const MessageDeliverables: React.FC<{ delivered: Deliverables }> = ({ delivered }) => {
  const { t } = useTranslation();
  const conversation = useConversationContextSafe();
  const run = useMessageListRun();
  const open = useOptionalLocalFilePreview(conversation?.workspace ?? run?.workspace);
  const quoteFile = (path: string) => emitter.emit('sendbox.mention.files', [path], conversation?.conversation_id);
  const openInSystem = (path: string) => {
    void ipcBridge.shell.openFile.invoke(path).catch((error) => {
      console.error('[MessageDeliverables] open in system failed:', { path, error });
      try {
        Message.error(t('preview.openInSystemFailed'));
      } catch {
        /* context holder may be unmounted */
      }
    });
  };
  return (
    <div
      className='rd-10px border border-solid border-[var(--color-border-2)] bg-fill-1 p-10px flex flex-col gap-6px max-w-560px'
      data-testid='message-deliverables'
    >
      <div className='flex items-center gap-6px px-4px text-12.5px font-500 text-t-secondary'>
        <FileSuccess theme='outline' size='14' aria-hidden='true' />
        <span>{t('messages.deliverables.title', { count: delivered.files.length })}</span>
      </div>
      {delivered.note ? (
        <div
          className='px-4px text-13px leading-20px text-t-secondary whitespace-pre-wrap [word-break:break-word]'
          dir='auto'
        >
          {delivered.note}
        </div>
      ) : null}
      <div className='flex flex-col gap-2px'>
        {delivered.files.map((file) => (
          <div key={file.path} className='relative group/delivrow'>
            <Button
              type='text'
              className='!h-auto !px-8px !py-5px !rd-6px hover:!bg-fill-2 !text-left !justify-start transition-colors'
              disabled={!open}
              title={file.path}
              aria-label={t('messages.deliverables.open', { name: file.name })}
              data-testid='message-deliverables-file'
              data-path={file.path}
              onClick={() => void open?.(file.path)}
            >
              <span className='flex w-full items-center gap-8px min-w-0'>
                {isImagePath(file.path) ? (
                  <span
                    className='flex-none size-40px rd-6px overflow-hidden flex items-center justify-center bg-fill-2'
                    data-testid='message-deliverables-thumb'
                  >
                    <LocalImageView src={file.path} alt={file.name} className='size-full object-cover' />
                  </span>
                ) : null}
                <span className='flex flex-1 items-baseline gap-8px min-w-0'>
                <span className='text-13px font-500 text-t-primary truncate'>{file.name}</span>
                <span className='text-12px text-t-tertiary truncate flex-1 min-w-0'>{folderOf(file.path)}</span>
                <span className='text-11.5px font-mono text-t-tertiary flex-none'>{fileSize(file.bytes)}</span>
              </span>
            </Button>
            {HTML_FILE_RE.test(file.name) ? (
              <div className='absolute end-6px top-1/2 -translate-y-1/2 z-10 flex gap-4px opacity-0 group-hover/delivrow:opacity-100 transition-opacity'>
                <Tooltip content={t('common.reply')}>
                  <div
                    data-testid='deliverables-quote'
                    className='w-20px h-20px rd-50% bg-bg-2 shadow-md border-1 border-solid b-color-border-2 flex items-center justify-center cursor-pointer hover:bg-bg-3'
                    onClick={(e) => {
                      e.stopPropagation();
                      quoteFile(file.path);
                    }}
                  >
                    <Link theme='outline' size='12' fill={iconColors.secondary} />
                  </div>
                </Tooltip>
                <Tooltip content={t('preview.openInSystemApp')}>
                  <div
                    data-testid='deliverables-open'
                    className='w-20px h-20px rd-50% bg-bg-2 shadow-md border-1 border-solid b-color-border-2 flex items-center justify-center cursor-pointer hover:bg-bg-3 text-t-secondary'
                    onClick={(e) => {
                      e.stopPropagation();
                      openInSystem(file.path);
                    }}
                  >
                    <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'>
                      <path d='M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' />
                      <polyline points='15 3 21 3 21 9' />
                      <line x1='10' y1='14' x2='21' y2='3' />
                    </svg>
                  </div>
                </Tooltip>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};

export default MessageDeliverables;
