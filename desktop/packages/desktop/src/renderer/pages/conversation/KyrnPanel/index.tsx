import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import type { Activity } from '@/common/kyrn/types';
import { mergeActivity } from './activity';
import Board from './Board';
import GaugeRow from './Board/GaugeRow';
import HiveRows from './Hive/HiveRows';
import JudgeLog from './Judge';
import LessonsTab from './Lessons';
import type { HiveFocusRequest } from './focus';
import { ErrorNotice } from './text';

export { onHiveFocus, requestHiveFocus, type HiveFocusRequest } from './focus';

/** The kernel's record of one conversation, as the work panel's board, judge, hive and lessons tabs read it. */
export type KyrnActivity = {
  events: Activity[];
  /** No answer yet. */
  loading: boolean;
  /** The bridge's own message when the last read failed. */
  error?: string;
  /** The session's record so far has all arrived: what the tabs show is where the conversation stands. */
  settled: boolean;
};

type Read = KyrnActivity & { conversationId: string | null };

const NOTHING: Activity[] = [];
const IDLE: KyrnActivity = { events: NOTHING, loading: false, settled: false };
const STARTING: KyrnActivity = { events: NOTHING, loading: true, settled: false };

/**
 * Read one conversation's kernel record, once a second and at once while more is waiting. The work panel reads it
 * while it is closed too, so its tabs can say they have news. A poll that brings nothing keeps the same state, so
 * nothing downstream re-renders for it. What was read for another conversation is never returned for this one.
 */
export function useKyrnActivity(conversationId: string | null): KyrnActivity {
  const [read, setRead] = useState<Read>({ conversationId: null, ...IDLE });
  useEffect(() => {
    if (!conversationId) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    let sessionId = '';
    setRead({ conversationId, ...STARTING });
    const poll = async () => {
      let delay = 1000;
      try {
        const result = unwrap(await kyrnBridge.activity.invoke({ conversationId, cursor, sessionId }));
        if (disposed) return;
        const changed = result.sessionId !== sessionId;
        sessionId = result.sessionId;
        cursor = result.cursor;
        setRead((old) => {
          const settled = (changed ? false : old.settled) || !result.more;
          if (!changed && !result.events.length && !old.loading && old.error === undefined && old.settled === settled)
            return old;
          return {
            conversationId,
            events:
              changed || result.events.length ? mergeActivity(changed ? [] : old.events, result.events) : old.events,
            loading: false,
            settled,
          };
        });
        if (result.more) delay = 0;
      } catch (e) {
        if (disposed) return;
        const error = e instanceof Error ? e.message : String(e);
        setRead((old) =>
          old.error === error && !old.loading ? old : { ...old, conversationId, loading: false, error }
        );
      }
      if (!disposed) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [conversationId]);
  if (!conversationId) return IDLE;
  return read.conversationId === conversationId ? read : STARTING;
}

export type KernelTab = 'board' | 'judge' | 'hive' | 'lessons';

/**
 * One kernel tab of the work panel. It waits, quietly, for the conversation's record to arrive, so what was already
 * there is not taken for news; a failed read is said above whatever did arrive. The board tab keeps its gauges (context
 * and cache) above all of that. `visible`: the tab is the one the open panel shows (the lessons tab reads its file
 * only then). `lessons`: whether the main process can read the conversation's lessons file (a native conversation's
 * it can once its folder is known, `cwd`, by which they are read; until then the tab says so and the judge tab names
 * lessons by id). Give it `key={conversationId}`.
 */
export function KernelBody({
  tab,
  conversationId,
  activity,
  focus,
  visible = true,
  lessons = true,
  cwd,
}: {
  tab: KernelTab;
  conversationId: string;
  activity: KyrnActivity;
  focus?: HiveFocusRequest;
  visible?: boolean;
  lessons?: boolean;
  cwd?: string;
}) {
  const { t } = useTranslation();
  const ready = activity.settled || activity.error !== undefined;
  const error =
    activity.error !== undefined ? (
      <ErrorNotice title={t('common.kyrn.activityLoadFailed')} detail={activity.error} className='mx-12px mt-10px' />
    ) : null;
  const loading = <p className='m-0 px-12px py-10px text-13px leading-20px text-t-secondary'>{t('common.loading')}</p>;
  // The board tab opens on its gauges, context and cache: they stay at the top however far the board scrolls.
  if (tab === 'board')
    return (
      <div className='h-full min-h-0 flex flex-col'>
        <GaugeRow events={activity.events} />
        <div className='flex-1 min-h-0 overflow-y-auto'>
          {ready ? (
            <>
              {error}
              <div className='px-12px pt-10px pb-16px'>
                <Board events={activity.events} conversationId={conversationId} />
              </div>
            </>
          ) : (
            loading
          )}
        </div>
      </div>
    );
  if (!ready) return loading;
  if (tab === 'judge' || tab === 'lessons')
    return (
      <div className='h-full min-h-0 flex flex-col'>
        {error}
        <div className='flex-1 min-h-0'>
          {tab === 'judge' ? (
            <JudgeLog
              events={activity.events}
              conversationId={lessons ? conversationId : undefined}
              visible={visible}
              cwd={cwd}
            />
          ) : lessons ? (
            <LessonsTab conversationId={conversationId} events={activity.events} visible={visible} cwd={cwd} />
          ) : (
            <p className='m-0 px-12px py-10px text-13px leading-20px text-t-secondary' data-testid='kernel-no-lessons'>
              {t('mu.native.panel.noLessons')}
            </p>
          )}
        </div>
      </div>
    );
  return (
    <div className='h-full min-h-0 overflow-y-auto'>
      {error}
      <div className='px-12px pt-10px pb-16px'>
        <HiveRows events={activity.events} focus={focus} />
      </div>
    </div>
  );
}
