/**
 * Attaching files and images to a native conversation's message: the button that opens the system's file picker
 * (a file input, so the files are read here and nothing is uploaded), and the chips of what is attached, above the
 * text, each with a way to take it off again.
 */
import { Button, Tooltip } from '@arco-design/web-react';
import { CloseSmall, FileText, Plus } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { iconColors } from '@/renderer/styles/colors';
import type { NativeAttachment } from '../../hooks/useNativeAttachments';

/** The button that opens the system's file picker: the composer's own file input, which `/open` opens as well. */
export const NativeAttachButton: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  const { t } = useTranslation();
  return (
    <Tooltip content={t('common.fileAttach.addFiles')} position='top'>
      <Button
        type='secondary'
        shape='circle'
        icon={<Plus theme='outline' size='14' strokeWidth={2} fill={iconColors.primary} />}
        onClick={onClick}
        data-testid='native-attach'
        aria-label={t('common.fileAttach.addFiles')}
      />
    </Tooltip>
  );
};

export const NativeAttachmentList: React.FC<{ attachments: NativeAttachment[]; onRemove: (id: string) => void }> = ({
  attachments,
  onRemove,
}) => {
  const { t } = useTranslation();
  if (!attachments.length) return null;
  return (
    <div className='flex flex-wrap items-center gap-8px mb-8px' data-testid='native-attachments'>
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          data-testid='native-attachment'
          data-kind={attachment.kind}
          data-name={attachment.name}
          title={attachment.kind === 'file' ? attachment.path : attachment.name}
          className='max-w-220px h-32px flex items-center gap-6px pl-4px pr-2px rd-8px border border-solid border-[var(--color-border-2)] bg-1 text-12px text-t-primary'
        >
          {attachment.kind === 'image' ? (
            <img
              src={`data:${attachment.mimeType};base64,${attachment.data}`}
              alt=''
              className='size-24px shrink-0 rd-4px object-cover'
            />
          ) : (
            <span className='size-24px shrink-0 flex items-center justify-center rd-4px bg-fill-2'>
              <FileText theme='outline' size='14' fill={iconColors.secondary} />
            </span>
          )}
          <span className='min-w-0 truncate'>{attachment.name}</span>
          <Button
            type='text'
            size='mini'
            icon={<CloseSmall theme='outline' size='14' fill={iconColors.secondary} />}
            onClick={() => onRemove(attachment.id)}
            data-testid='native-attachment-remove'
            aria-label={t('common.remove')}
          />
        </span>
      ))}
    </div>
  );
};
