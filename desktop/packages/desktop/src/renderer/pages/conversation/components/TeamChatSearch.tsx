/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The group conversation's search: a header entry that searches the team's
 * conversations through the global message search API (scoped client-side to
 * the team) and jumps to the hit's own place in the flow — the message list
 * scrolls to and highlights the row. Rakazo's form: search lives in the chat
 * it searches, never in a panel elsewhere.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Empty, Input, Popover, Spin, Tag } from '@arco-design/web-react';
import { Search } from '@icon-park/react';
import { ipcBridge } from '@/common';
import {
  SEARCH_PAGE_SIZE,
  filterSearchHitsToTeam,
  searchTermsOf,
  type TeamSearchRow,
} from '@/renderer/pages/team/core/teamDataCore';

const timeLabel = (at: number, language: string): string => {
  try {
    return new Intl.DateTimeFormat(language, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(at));
  } catch {
    return '';
  }
};

const TeamChatSearch: React.FC<{ teamId: string }> = ({ teamId }) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<TeamSearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const terms = useMemo(() => searchTermsOf(query), [query]);

  const runSearch = useCallback(
    async (nextPage: number): Promise<void> => {
      if (terms.length === 0) return;
      setSearching(true);
      try {
        const result = await ipcBridge.database.searchConversationMessages.invoke({
          keyword: terms.join(' '),
          page: nextPage,
          page_size: SEARCH_PAGE_SIZE,
        });
        const items = Array.isArray(result?.items) ? result.items : [];
        const scoped = filterSearchHitsToTeam(items, teamId, terms);
        setRows((current) => (nextPage === 1 ? scoped : [...current, ...scoped]));
        // The API's own page boundary decides "load more" — an honest maybe-more
        // is better than a wrong "that was all".
        setHasMore(items.length >= SEARCH_PAGE_SIZE);
        setPage(nextPage);
        setSearched(true);
      } catch {
        setRows([]);
        setHasMore(false);
        setSearched(true);
      } finally {
        setSearching(false);
      }
    },
    [teamId, terms]
  );

  // Typed pause searches, like the global history search: no submit step
  // between the reader's words and the hits.
  useEffect(() => {
    if (terms.length === 0) {
      setRows([]);
      setSearched(false);
      setHasMore(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      void runSearch(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [runSearch, terms]);

  const jumpTo = useCallback(
    (row: TeamSearchRow): void => {
      // The message list owns the landing: it watches this state, loads the
      // hit's window if needed, then scrolls to and highlights the row.
      setOpen(false);
      void navigate(`/conversation/${row.conversation_id}`, {
        state: { targetMessageId: row.message_id, fromConversationSearch: true },
      });
    },
    [navigate]
  );

  const content = (
    <div data-testid='team-chat-search' className='w-360px max-w-80vw flex flex-col gap-8px'>
      <Input
        data-testid='team-chat-search-input'
        allowClear
        size='small'
        value={query}
        placeholder={t('team.search.placeholder')}
        onChange={setQuery}
        onPressEnter={() => void runSearch(1)}
        prefix={<Search theme='outline' size='13' fill='currentColor' />}
      />
      {searching && rows.length === 0 ? (
        <div className='flex items-center justify-center py-24px'>
          <Spin size={16} />
        </div>
      ) : null}
      {!searching && searched && rows.length === 0 && terms.length > 0 ? (
        <Empty className='py-16px' description={t('team.search.noHits')} />
      ) : null}
      {rows.length > 0 ? (
        <div className='max-h-300px overflow-y-auto flex flex-col gap-4px pe-2px'>
          {rows.map((row) => (
            <div
              key={row.message_id}
              role='button'
              tabIndex={0}
              data-testid='team-chat-search-hit'
              className='w-full text-left flex flex-col gap-2px px-10px py-6px rd-6px cursor-pointer hover:bg-fill-2 active:bg-fill-3 transition-colors text-12px leading-17px min-w-0'
              onClick={() => jumpTo(row)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  jumpTo(row);
                }
              }}
            >
              <span className='flex items-center gap-6px flex-wrap'>
                <span className='font-500 text-t-primary truncate'>{row.conversation_name}</span>
                {row.is_tool_call ? <Tag size='small'>{t('team.search.toolCall')}</Tag> : null}
                <span className='text-t-tertiary'>{timeLabel(row.at, i18n.language)}</span>
              </span>
              <span className='text-t-secondary break-words'>{row.preview}</span>
            </div>
          ))}
          {hasMore ? (
            <Button size='mini' long loading={searching} onClick={() => void runSearch(page + 1)}>
              {t('team.search.loadMore')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {terms.length === 0 ? <span className='text-11px text-t-tertiary px-2px'>{t('team.search.hint')}</span> : null}
    </div>
  );

  return (
    <Popover
      trigger='click'
      position='br'
      popupVisible={open}
      onVisibleChange={(visible: boolean) => setOpen(visible)}
      content={content}
      unmountOnExit
    >
      <Button
        type='text'
        size='small'
        data-testid='team-chat-search-trigger'
        aria-label={t('team.search.trigger')}
        icon={<Search theme='outline' size='15' fill='currentColor' />}
      />
    </Popover>
  );
};

export default TeamChatSearch;
