import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import type { JournalEntry } from '@/common/kyrn/journal';
import type { Activity } from '@/common/kyrn/types';
import { noteWorkPanelSignature } from '@/renderer/components/layout/WorkPanel/workPanelStore';
import { memoryEvents } from '../Lessons/model';
import { ErrorNotice } from '../text';
import EntryQuiz from './Quiz';
import { useJournal } from './useJournal';
import styles from './Journal.module.css';

const KEY = 'common.kyrn.journalView';
const NONE: JournalEntry[] = [];

/** How many of the newest entries lie flat at the top, always open; the rest fold away until asked for. */
const RECENT = 3;

/** A project folder's own name, as a person reads it: the last segment of its path, any way it is written. */
const folderOf = (path: string): string => {
  for (const part of path.split(/[\\/]/).toReversed()) if (part) return part;
  return path;
};

/** A lesson's project folder, or a ledger line's position: the small name beside the words. */
const scopeOf = (entry: JournalEntry): string =>
  entry.source === 'positions' ? (entry.scope ?? '') : entry.scope === undefined ? '' : folderOf(entry.scope);

/**
 * The journal tab: the person's own record of what was learned, across every project — mu's lessons (of every
 * project, not only this one's) beside the positions' shared ledger, one newest-first view neither written here. The
 * newest few entries lie open at the top; the rest fold away until asked for, and only so many of them are ever
 * listed. The tab is mounted for every conversation (like the kernel's other tabs), and its reading of the two files
 * is what lights its news dot: a first read says where things stand, a later, different one that something new was
 * learned. Give it `key={conversationId}`.
 */
export default function JournalTab({
  conversationId,
  events,
  visible,
}: {
  conversationId: string;
  events: Activity[];
  visible: boolean;
}) {
  const { t } = useTranslation();
  // A lesson stored, recalled or retired means the lessons file moved: the journal reads again.
  const signature = useMemo(
    () =>
      memoryEvents(events)
        .map((event) => event.id)
        .join('\n'),
    [events]
  );
  const { view, error, loading } = useJournal(signature, visible);
  const [open, setOpen] = useState(false);
  // The quiz's model, asked once per mount: the buttons disable on it (no model = no quiz, said up front, not on click).
  const [quizModel, setQuizModel] = useState<string | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const state = unwrap(await kyrnBridge.quizState.invoke());
        if (!disposed && typeof state.model === 'string') setQuizModel(state.model);
      } catch {
        // An unreadable state reads as no model: the buttons stay disabled, the guidance stays true.
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);
  const entries = view?.entries ?? NONE;
  const recent = entries.slice(0, RECENT);
  const earlier = entries.slice(RECENT);
  // What the tab shows now, as its news signature: the entries' ids and when each was written.
  const shown = useMemo(() => entries.map((entry) => `${entry.id}@${entry.at}`).join('\n'), [entries]);
  useEffect(() => {
    noteWorkPanelSignature(conversationId, 'journal', shown);
  }, [conversationId, shown]);

  return (
    <section className={styles.tab} data-testid='mu-journal' aria-label={t('common.workPanel.tabs.journal')}>
      {error !== undefined ? (
        <ErrorNotice title={t(`${KEY}.loadFailed`)} detail={error} className={styles.error} />
      ) : null}
      {!view ? (
        loading ? (
          <p className={styles.quiet}>{t('common.loading')}</p>
        ) : null
      ) : !entries.length ? (
        <p className={styles.quiet} data-testid='mu-journal-empty'>
          {t(`${KEY}.empty`)}
        </p>
      ) : (
        <>
          <h3 className={styles.heading} data-testid='mu-journal-recent'>
            {t(`${KEY}.recent`)}
          </h3>
          <ol className={styles.rows}>
            {recent.map((entry) => (
              <Entry key={entry.id} entry={entry} quizModel={quizModel} />
            ))}
          </ol>
          {earlier.length ? (
            <>
              <Button
                className={styles.fold}
                size='mini'
                type='text'
                aria-expanded={open}
                data-testid='mu-journal-earlier-toggle'
                onClick={() => setOpen(!open)}
              >
                {open ? t(`${KEY}.collapse`) : t(`${KEY}.expand`, { n: earlier.length })}
              </Button>
              {open ? (
                <ol className={styles.rows} data-testid='mu-journal-earlier'>
                  {earlier.map((entry) => (
                    <Entry key={entry.id} entry={entry} quizModel={quizModel} />
                  ))}
                </ol>
              ) : null}
            </>
          ) : null}
          {view.total > view.entries.length ? (
            <p className={styles.quiet} data-testid='mu-journal-cap'>
              {t(`${KEY}.cap`, { shown: view.entries.length, total: view.total })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** One entry, one line: where it came from, where it holds, the words, when — and the quiz that asks if they stuck. */
function Entry({ entry, quizModel }: { entry: JournalEntry; quizModel?: string }) {
  const { t } = useTranslation();
  const scope = scopeOf(entry);
  return (
    <li className={styles.row} data-testid='mu-journal-entry' data-source={entry.source}>
      <span className={styles.mark}>{t(`${KEY}.sources.${entry.source}`)}</span>
      {entry.source === 'lessons' ? (
        <span className={styles.kind}>{t(`common.kyrn.lessonsView.kinds.${entry.kind}`)}</span>
      ) : null}
      <span className={styles.mark}>
        {scope || (entry.source === 'lessons' ? t('common.kyrn.lessonsView.everywhere') : '')}
      </span>
      <span className={styles.text} dir='auto' title={entry.text}>
        {entry.text}
      </span>
      <EntryQuiz entry={entry} model={quizModel} />
      <span className={styles.when}>{entry.at.slice(0, 10)}</span>
    </li>
  );
}
