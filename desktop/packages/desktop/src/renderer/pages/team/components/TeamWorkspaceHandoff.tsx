/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The team's workbench record, from the header's identity strip: the workspace
 * HANDOFF.md every member appends its task records to (the dispatch rules'
 * 收尾落账 target), opened read-only in a modal. The window asks the main
 * process for the content (the bridge validates the workspace before it
 * reads); markdown renders without raw HTML — the file is agent-written, and
 * agent output is never trusted markup. A team without a record yet sees the
 * empty state that says when the record appears.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Spin } from '@arco-design/web-react';
import { Notebook } from '@icon-park/react';
import Markdown from '@renderer/components/Markdown';
import MuModal from '@renderer/components/base/MuModal';
import { teamWorkspaceBridge } from '@/common/chat/team/teamWorkspace/handoffBridge';
import type { TeamHandoffResult } from '@/common/chat/team/teamWorkspace/handoffBridge';
import type { TTeam } from '@/common/types/team/teamTypes';

type Props = {
  team: TTeam;
};

type LoadState = { kind: 'loading' } | { kind: 'ok'; content: string; truncated: boolean } | { kind: 'error' };

const TeamWorkspaceHandoff: React.FC<Props> = ({ team }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const show = (): void => {
    setOpen(true);
    setState({ kind: 'loading' });
    void teamWorkspaceBridge.readHandoff
      .invoke({ workspace: team.workspace })
      .then((answer): void => {
        if (answer.ok === false) throw new Error(answer.error);
        const record: TeamHandoffResult = answer.data;
        if (record.status === 'missing') setState({ kind: 'ok', content: '', truncated: false });
        else setState({ kind: 'ok', content: record.content, truncated: record.truncated });
      })
      .catch((): void => setState({ kind: 'error' }));
  };

  const body =
    state.kind === 'loading' ? (
      <div className='flex items-center justify-center h-120px' data-testid='team-handoff-loading'>
        <Spin size={20} />
      </div>
    ) : state.kind === 'error' ? (
      <div
        className='flex items-center justify-center h-120px text-13px text-t-tertiary'
        data-testid='team-handoff-error'
      >
        {t('team.handoff.error')}
      </div>
    ) : state.content.trim() === '' ? (
      <div
        className='flex flex-col items-center justify-center gap-8px h-120px text-13px text-t-tertiary'
        data-testid='team-handoff-empty'
      >
        <Notebook theme='outline' size='24' />
        <span>{t('team.handoff.missing')}</span>
      </div>
    ) : (
      <>
        {state.truncated ? <div className='text-12px text-t-tertiary pb-8px'>{t('team.handoff.truncated')}</div> : null}
        <div data-testid='team-handoff-content'>
          <Markdown>{state.content}</Markdown>
        </div>
      </>
    );

  return (
    <>
      <Button
        size='mini'
        type='text'
        data-testid='team-handoff-entry'
        aria-label={t('team.handoff.entry')}
        title={t('team.handoff.entry')}
        onClick={show}
      >
        <Notebook theme='outline' size='14' />
      </Button>
      <MuModal
        visible={open}
        onCancel={() => setOpen(false)}
        footer={null}
        size='large'
        header={{ title: t('team.handoff.title'), subtitle: team.name }}
      >
        {body}
      </MuModal>
    </>
  );
};

export default TeamWorkspaceHandoff;
