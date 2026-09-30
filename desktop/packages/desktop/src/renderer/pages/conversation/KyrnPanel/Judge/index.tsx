import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@arco-design/web-react';
import { Down, SettingTwo } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Activity } from '@/common/kyrn/types';
import { formatNumber } from '@/renderer/services/i18n/format';
import { str } from '../activity';
import { useLogClock } from '../clock';
import { memoryEvents } from '../Lessons/model';
import { useLessons } from '../Lessons/useLessons';
import ContextPanel from './ContextPanel';
import { contextView } from './context';
import JudgeCardView from './JudgeCardView';
import {
  eventDetail,
  foldRepeats,
  itemCode,
  itemSentence,
  logItems,
  namesLessons,
  pinnedVerdict,
  turnRunning,
  type LogItem,
} from './log';
import { hintChips } from './wording';
import styles from './Judge.module.css';

export { runtimeEvents } from './activity';

/** Lines rendered at first; older ones come in pages above them. */
const PAGE = 200;
/** How close to the bottom still counts as reading the newest line. */
const FOLLOW_SLACK_PX = 24;
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;

/** A lesson by its words, as the lessons tab reads them; one that is not in the file by the start of its id. */
type LessonText = (id: string) => string;

/**
 * The judge tab: a quiet log of what the judge decided and what the runtime did around it, one line each (its time
 * and a sentence), newest at the bottom. It follows new lines while the person reads the bottom and stops the moment
 * they scroll up; the verdict on the message being worked on stays pinned above the log while its turn runs. A line
 * opens to the whole record: its code, then a judgment as question, verdict and effect, an event as its words and raw
 * payload. Lessons are named by their words: the lessons file is read while the tab is in view and the log names one,
 * by the conversation, or by `cwd` for a native conversation's folder.
 */
export default function JudgeLog({
  events,
  conversationId,
  visible = true,
  cwd,
}: {
  events: Activity[];
  conversationId?: string;
  visible?: boolean;
  cwd?: string;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const items = useMemo(() => logItems(events), [events]);
  // The same line many times in a row reads once, with a count.
  const rows = useMemo(
    () => foldRepeats(items, (item) => itemSentence(t, item, i18n.language)),
    [items, t, i18n.language]
  );
  const lessonEvents = useMemo(() => memoryEvents(events), [events]);
  const needsLessons = Boolean(conversationId) && visible && items.some(namesLessons);
  const { view: lessonsView } = useLessons(
    conversationId ?? '',
    lessonEvents.map((event) => event.id).join('\n'),
    needsLessons,
    cwd
  );
  const lessonText = useMemo<LessonText>(() => {
    const byId = new Map((lessonsView?.lessons ?? []).map((lesson) => [lesson.id, lesson.lesson]));
    return (id) => byId.get(id) ?? id.slice(0, 8);
  }, [lessonsView]);
  const running = useMemo(() => turnRunning(events), [events]);
  const pinned = pinnedVerdict(items, running);
  const [limit, setLimit] = useState(PAGE);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [contextOpen, setContextOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  const shown = rows.slice(-limit);
  const newest = items.at(-1)?.id;

  // New lines keep the log at its bottom, unless the person has scrolled up to read.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && followingRef.current) element.scrollTop = element.scrollHeight;
  }, [newest, items.length]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
    followingRef.current = atBottom;
    setFollowing(atBottom);
  };
  const jumpToLatest = () => {
    const element = scroller.current;
    followingRef.current = true;
    setFollowing(true);
    if (element) element.scrollTop = element.scrollHeight;
  };
  const toggle = (id: string) =>
    setOpened((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section className={styles.log} data-testid='kyrn-judge' aria-label={t('common.workPanel.tabs.judge')}>
      <div className={styles.toolbar}>
        <ContextSummary events={events} open={contextOpen} onToggle={() => setContextOpen((open) => !open)} />
        <Button
          type='text'
          size='mini'
          className={styles.toolButton}
          icon={<SettingTwo size={14} />}
          aria-label={t('common.kyrn.settings')}
          title={t('common.kyrn.settings')}
          onClick={() => void navigate('/settings/judges')}
        />
      </div>
      {contextOpen ? (
        <div className={styles.context}>
          <ContextPanel events={events} />
        </div>
      ) : null}
      {pinned ? (
        <div className={styles.pinned} data-testid='judge-pinned'>
          <span className={styles.pinnedLabel}>{t('common.kyrn.judgeView.log.thisTurn')}</span>
          <LineText item={{ type: 'judgment', id: `pinned:${pinned.id}`, at: pinned.at, card: pinned }} />
        </div>
      ) : null}
      <div className={styles.scroller} ref={scroller} onScroll={onScroll} data-testid='judge-log'>
        {!items.length ? <p className={styles.empty}>{t('common.kyrn.judgeView.empty')}</p> : null}
        {rows.length > shown.length ? (
          <Button type='text' size='mini' className={styles.earlier} onClick={() => setLimit((old) => old + PAGE)}>
            {t('common.kyrn.judgeView.log.earlier')}
          </Button>
        ) : null}
        <ol className={styles.lines}>
          {shown.map((row) => (
            <Line
              key={row.key}
              item={row.item}
              count={row.count}
              open={opened.has(row.key)}
              onToggle={() => toggle(row.key)}
              lessonText={lessonText}
            />
          ))}
        </ol>
      </div>
      {!following && items.length ? (
        <Button size='mini' className={styles.latest} icon={<Down size={12} />} onClick={jumpToLatest}>
          {t('common.kyrn.judgeView.log.latest')}
        </Button>
      ) : null}
    </section>
  );
}

/** The context in one quiet line ("Context usage · 12%"); it opens the full context view. */
function ContextSummary({ events, open, onToggle }: { events: Activity[]; open: boolean; onToggle: () => void }) {
  const { t, i18n } = useTranslation();
  const view = useMemo(() => contextView(events), [events]);
  const share =
    view.percent === undefined
      ? t('common.kyrn.contextWaiting')
      : formatNumber(view.percent / 100, i18n.language, { style: 'percent', maximumFractionDigits: 1 });
  return (
    <Button
      type='text'
      size='mini'
      className={styles.contextButton}
      aria-expanded={open}
      data-testid='judge-context-toggle'
      onClick={onToggle}
    >
      {`${t('common.kyrn.contextUsage')} · ${share}`}
    </Button>
  );
}

/**
 * Time and sentence, then the hint chips of a verdict, and how many times the line came in a row. The code waits in
 * the opened line.
 */
function LineText({ item, count = 1 }: { item: LogItem; count?: number }) {
  const { t, i18n } = useTranslation();
  const clock = useLogClock();
  const chips = item.type === 'judgment' ? hintChips(t, item.card.hintIds) : [];
  return (
    <>
      <span className={styles.time}>{clock(item.at)}</span>
      <span className={styles.body}>
        <span dir='auto'>{itemSentence(t, item, i18n.language)}</span>
        {chips.map((chip) => (
          <span key={chip.id} className={styles.chip} data-testid='judge-hint-chip' data-hint={chip.id}>
            {chip.label}
          </span>
        ))}
        {count > 1 ? (
          <span className={styles.chip} data-testid='judge-line-count'>
            {t('common.kyrn.judgeView.log.times', { times: formatNumber(count, i18n.language) })}
          </span>
        ) : null}
      </span>
    </>
  );
}

function Line({
  item,
  count,
  open,
  onToggle,
  lessonText,
}: {
  item: LogItem;
  count: number;
  open: boolean;
  onToggle: () => void;
  lessonText: LessonText;
}) {
  const code = itemCode(item);
  return (
    <li className={styles.line} data-testid='judge-line' data-code={code}>
      <Button type='text' long className={styles.lineButton} aria-expanded={open} onClick={onToggle}>
        <LineText item={item} count={count} />
      </Button>
      {open ? (
        <div className={styles.detail}>
          {/* The decision point or event kind, for whoever reads the harness's docs or its raw record. */}
          <p className={styles.detailCode} dir='ltr' data-testid='judge-line-code'>
            {code}
          </p>
          {item.type === 'judgment' ? (
            <JudgeCardView card={item.card} plain lessonText={lessonText} />
          ) : (
            <EventDetail event={item.event} about={item.about} lessonText={lessonText} />
          )}
        </div>
      ) : null}
    </li>
  );
}

function EventDetail({ event, about, lessonText }: { event: Activity; about?: string; lessonText: LessonText }) {
  const { t, i18n } = useTranslation();
  const payload = event.payload;
  // An answer's words name the call its question named; the raw record below stays as it came.
  const worded = about ? { ...event, payload: { ...payload, summary: about } } : event;
  if (event.kind === 'artifact.image' && IMAGE_TYPES.test(str(payload.mimeType))) {
    return (
      <img
        alt={t('common.kyrn.image')}
        src={`data:${str(payload.mimeType)};base64,${str(payload.data)}`}
        className={styles.image}
      />
    );
  }
  return (
    <>
      {eventDetail(t, worded, i18n.language, lessonText).map((line, index) => (
        // A line may be data (a command, a server's words) in any script.
        <p key={index} className={styles.detailLine} dir='auto'>
          {line}
        </p>
      ))}
      {/* JSON reads left to right in every app language, including fa-IR. */}
      <pre className={styles.recordText} dir='ltr'>
        {JSON.stringify(payload, null, 2)}
      </pre>
    </>
  );
}
