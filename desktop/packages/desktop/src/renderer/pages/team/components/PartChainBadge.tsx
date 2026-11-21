/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The part-chain badge a position/supervisor conversation's header carries
 * (SPEC-P6 M2): when the conversation provably belongs to a part chain — its
 * own title says `(part N)`, or a ⚡ continuation note says where it continued
 * from — a light badge names its part, and its dropdown lists every part of
 * the chain for one-click jumps (partChainCore does the proving).
 */
import { Dropdown, Menu } from '@arco-design/web-react';
import { ConnectionPoint } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { partChainOf } from '@/common/chat/team/contextSteward/partChainCore';
import { useConversationHistoryContext } from '@renderer/hooks/context/ConversationHistoryContext';
import { contextStewardChainLinks } from '@renderer/pages/team/core/notes/contextStewardNotes';

const PartChainBadge: React.FC<{ conversationId: string }> = ({ conversationId }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { conversations } = useConversationHistoryContext();
  const chain = partChainOf({ conversations, conversationId, links: contextStewardChainLinks() });
  if (!chain) return null;
  const dropdown = (
    <Menu>
      {chain.entries.map((entry) => (
        <Menu.Item
          key={entry.conversationId}
          disabled={entry.isCurrent}
          data-testid='part-chain-entry'
          onClick={() => navigate(`/conversation/${entry.conversationId}`)}
        >
          <span className='flex items-center gap-8px'>
            <span className='font-500'>{t('contextSteward.partBadge.part', { part: entry.part })}</span>
            <span className='text-t-tertiary'>{entry.title}</span>
            {entry.isCurrent && <span className='text-t-quaternary'>{t('contextSteward.partBadge.current')}</span>}
          </span>
        </Menu.Item>
      ))}
    </Menu>
  );
  return (
    <Dropdown trigger='click' position='bottom' droplist={dropdown}>
      <span
        className='inline-flex items-center gap-4px rd-full px-8px py-2px text-12px leading-18px font-500 cursor-pointer bg-[rgba(var(--primary-6),0.10)] text-[rgb(var(--primary-6))] shrink-0'
        data-testid='part-chain-badge'
        data-part={chain.ownPart}
      >
        <ConnectionPoint theme='outline' size='12' fill='currentColor' />
        {t('contextSteward.partBadge.part', { part: chain.ownPart })}
      </span>
    </Dropdown>
  );
};

export default PartChainBadge;
