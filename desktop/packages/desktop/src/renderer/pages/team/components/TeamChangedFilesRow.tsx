/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One finished run's changed-files note, as a light row in the group chat's
 * flow: "this round touched N files", the list one click open, each file a
 * click into the preview. Deliberately NOT a message bubble — like the ⚡
 * receipts, nothing here went through the model; the app itself wrote the row
 * from the run's write/edit calls. The files are the team workspace's own, so
 * the row opens them relative to it.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@arco-design/web-react';
import { FolderOpen } from '@icon-park/react';
import { useOptionalLocalFilePreview } from '@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview';
import { useTeamRosterSnapshot } from '../core/teamStore';
import type { TeamChangedFilesNote } from '../core/notes/teamChangedFileNotes';

/** The folder a file is in, as the expanded list shows it beside the name. */
const folderOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '') || path;

const TeamChangedFilesRow: React.FC<{ note: TeamChangedFilesNote }> = ({ note }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { teams } = useTeamRosterSnapshot();
  const workspace = teams.find((team) => team.id === note.teamId)?.workspace;
  const preview = useOptionalLocalFilePreview(workspace);

  return (
    <div className='flex flex-col gap-4px py-6px' data-testid='team-changed-files-row'>
      <span
        className='inline-flex w-fit cursor-pointer items-center gap-4px rd-full px-8px py-2px text-12px leading-18px font-500 bg-fill-2 text-t-secondary hover:bg-fill-3 transition-colors'
        data-testid='team-changed-files-toggle'
        role='button'
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') setOpen((value) => !value);
        }}
      >
        <FolderOpen theme='outline' size='12' fill='currentColor' aria-hidden='true' />
        <span data-testid='team-changed-files-count'>{t('team.changedFiles.title', { count: note.files.length })}</span>
      </span>
      {open ? (
        <div className='flex flex-col gap-2px ps-8px' data-testid='team-changed-files-list'>
          {note.files.map((file) => (
            <Button
              key={file.path}
              type='text'
              size='mini'
              className='!h-auto !px-4px !py-2px !text-left !justify-start !w-fit max-w-100%'
              data-testid='team-changed-files-file'
              data-path={file.path}
              title={file.path}
              disabled={!preview}
              onClick={() => void preview?.(file.path)}
            >
              <span className='truncate text-12px leading-18px'>
                <span className='font-500'>{file.name}</span>
                <span className='text-t-quaternary ps-6px'>{folderOf(file.path)}</span>
              </span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default TeamChangedFilesRow;
