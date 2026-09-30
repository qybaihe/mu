import React, { useMemo, useState } from 'react';
import { Input, Radio } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { StoredLesson } from '@/common/kyrn/lessons';
import type { Activity } from '@/common/kyrn/types';
import { useClock } from '../clock';
import { ErrorNotice } from '../text';
import LessonRow, { LessonText } from './LessonRow';
import { lessonMatches, memoryEvents, SEARCH_AFTER, shownLessons, shownText, type LessonFilter } from './model';
import { lessonNotes } from './notes';
import { useLessons } from './useLessons';
import styles from './Lessons.module.css';

const KEY = 'common.kyrn.lessonsView';
const NONE: StoredLesson[] = [];

/**
 * The lessons tab: what mu has learned for this project, read from its lessons file and folded by id. The lessons in
 * use, the most followed first; "all" adds the retired and replaced ones, greyed. Above the list, a few quiet lines say
 * what the lessons did in this session. A lesson in use can be reworded or retired, each one line appended to the file
 * the harness writes too. The file is read when the tab comes into view and after every lesson event of the session.
 * `cwd`: a native conversation's folder, by which its lessons are read (it has no app conversation). Give it
 * `key={conversationId}`.
 */
export default function LessonsTab({
  conversationId,
  events,
  visible,
  cwd,
}: {
  conversationId: string;
  events: Activity[];
  visible: boolean;
  cwd?: string;
}) {
  const { t } = useTranslation();
  const clock = useClock();
  const happened = useMemo(() => memoryEvents(events), [events]);
  const signature = happened.map((event) => event.id).join('\n');
  const { view, error, loading, change } = useLessons(conversationId, signature, visible, cwd);
  const [filter, setFilter] = useState<LessonFilter>('active');
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const lessons = view?.lessons ?? NONE;
  const rows = useMemo(() => shownLessons(lessons, filter), [lessons, filter]);
  const notes = useMemo(() => lessonNotes(t, happened, lessons), [t, happened, lessons]);
  // A search only where the list is long; a list that got short again is shown whole.
  const searching = rows.length > SEARCH_AFTER && query.trim() !== '';
  const shown = searching
    ? rows.filter((lesson) => lessonMatches(lesson, query, t(`${KEY}.kinds.${lesson.kind}`)))
    : rows;
  const empty = !lessons.length
    ? t(`${KEY}.empty`)
    : !rows.length
      ? t(`${KEY}.noneActive`)
      : !shown.length
        ? t(`${KEY}.noMatch`)
        : '';
  const toggle = (id: string) =>
    setOpened((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section className={styles.tab} data-testid='mu-lessons' aria-label={t('common.workPanel.tabs.lessons')}>
      <div className={styles.toolbar}>
        <Radio.Group
          type='button'
          size='mini'
          aria-label={t(`${KEY}.filterLabel`)}
          value={filter}
          onChange={(value: LessonFilter) => setFilter(value)}
        >
          <Radio value='active'>{t(`${KEY}.active`)}</Radio>
          <Radio value='all'>{t(`${KEY}.all`)}</Radio>
        </Radio.Group>
        {view ? (
          <span className={styles.count} data-testid='mu-lessons-count'>
            {t(`${KEY}.count`, { count: shown.length })}
          </span>
        ) : null}
      </div>
      {rows.length > SEARCH_AFTER ? (
        <div className={styles.search}>
          <Input.Search
            allowClear
            size='small'
            aria-label={t(`${KEY}.search`)}
            placeholder={t(`${KEY}.search`)}
            value={query}
            onChange={setQuery}
          />
        </div>
      ) : null}
      {notes.length ? (
        <ul className={styles.notes} aria-label={t(`${KEY}.notes.label`)} data-testid='mu-lessons-notes'>
          {notes.map((note) => (
            <li key={note.id} className={styles.note}>
              <span className={styles.noteTime}>{clock(note.at)}</span>
              {/* A note names a lesson by its words, code spans and all. */}
              <span className={styles.noteText} dir='auto' title={shownText(note.text)}>
                <LessonText text={note.text} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.scroller}>
        {error !== undefined ? (
          <ErrorNotice title={t(`${KEY}.loadFailed`)} detail={error} className='mx-12px mt-10px' />
        ) : null}
        {!view ? (
          loading ? (
            <p className={styles.quiet}>{t('common.loading')}</p>
          ) : null
        ) : (
          <>
            {!view.project ? <p className={styles.quiet}>{t(`${KEY}.noProject`)}</p> : null}
            {empty ? (
              <p className={styles.quiet} data-testid='mu-lessons-empty'>
                {empty}
              </p>
            ) : null}
            <ol className={styles.rows}>
              {shown.map((lesson) => (
                <LessonRow
                  key={lesson.id}
                  lesson={lesson}
                  open={opened.has(lesson.id)}
                  onToggle={() => toggle(lesson.id)}
                  onChange={change}
                />
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}
