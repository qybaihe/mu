import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Switch, Tooltip } from '@arco-design/web-react';
import { Check } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { Activity } from '@/common/kyrn/types';
import { formatNumber } from '@/renderer/services/i18n/format';
import { emitter, type SendBoxCommandState } from '@/renderer/utils/emitter';
import { formatElapsed, useNow } from '../clock';
import Account from './Account';
import Agents from './Agents';
import {
  asksUser,
  boardAccount,
  boardState,
  boardStateKey,
  boardView,
  share,
  type BoardNote,
  type BoardState,
  type BoardUpdate,
} from './board';
import { noteWords } from './noteWords';
import { boardWords, type BoardWords } from './wording';
import styles from './Board.module.css';

/** How long a sent switch waits for the session to say it switched before it can be used again. */
const SWITCH_WAIT_MS = 60_000;

/** A switch on its way: waiting for the agent to finish its turn, or sent and waiting for the session's answer. */
type Pending = { to: boolean; stage: 'waiting' | 'sent' };

/**
 * What the panel has heard of the board since it opened. A line of the account is news when it came after the panel
 * opened and is not from the account the session replays as it opens. That is decided once per line, the first time
 * the panel sees it, so a line the harness sends again (a count that grew) changes where it stands, without fading in
 * or being read out again.
 */
type Heard = {
  /** Every line of the account, and whether it is news. */
  fresh: ReadonlyMap<string, boolean>;
  /** The last board that was news. */
  board: string | undefined;
  /** What the live region reads out: the news that came last, a new board, the model's new lines, or both at once. */
  said: { board: string | undefined; notes: string[] };
};

/** On opening, nothing already there is news. */
const opening = (notes: readonly BoardNote[]): Heard => ({
  fresh: new Map(notes.map((note) => [note.id, false])),
  board: undefined,
  said: { board: undefined, notes: [] },
});

/** What came since `heard`: `heard` itself when nothing did. */
function hear(heard: Heard, notes: readonly BoardNote[], news: BoardUpdate | undefined): Heard {
  const board = news && news.id !== heard.board ? news.id : undefined;
  if (!board && notes.every((note) => heard.fresh.has(note.id))) return heard;
  const fresh = new Map<string, boolean>();
  const told: string[] = [];
  for (const note of notes) {
    const known = heard.fresh.get(note.id);
    fresh.set(note.id, known ?? !note.restored);
    // Read out: the model's own words. The fixed lines come with every step and would be chatter.
    if (known === undefined && !note.restored && note.by === 'model') told.push(note.id);
  }
  const said = board || told.length ? { board, notes: told } : heard.said;
  return { fresh, board: board ?? heard.board, said };
}

/**
 * The plain-language board: where the work stands, in plain words, for the person and never for the model. The
 * harness writes it (the judge picks the facts, a plain-speaking model writes them up) and presents it; this shows the
 * latest one, what needs the person, and under it the running account of what the agent did, one line per thing,
 * as it happens. The switch is the harness's own `/board on|off`, sent into the conversation like a typed command,
 * so the board stays per project and the app never writes its settings. It is offered only where the harness has
 * said it has a board: anywhere else the command would reach a model as a message.
 */
export default function Board({ events, conversationId }: { events: Activity[]; conversationId: string }) {
  const { t, i18n } = useTranslation();
  const view = useMemo(() => boardView(events), [events]);
  const account = useMemo(() => boardAccount(events), [events]);
  // A fixed board or line is rebuilt in the reader's language; what a model wrote is shown as it wrote it.
  const { say, sayNote } = useMemo(() => {
    const has = (key: string) => i18n.exists(key);
    const number = (value: number) => formatNumber(value, i18n.language);
    return {
      say: (update: BoardUpdate) => boardWords(update, t, has, number),
      sayNote: (note: BoardNote) => noteWords(note, t, has),
    };
  }, [i18n, t]);
  const words = useMemo(() => (view.update ? say(view.update) : undefined), [say, view.update]);
  const [pending, setPending] = useState<Pending>();
  const on = view.on ?? false;
  // The board that was there when the panel opened is not news (give the panel `key={conversationId}`), nor is the
  // one the session replays on opening: only a later one fades in and is read out.
  const opened = useRef(view.update?.id);
  const news = view.update && view.update.id !== opened.current && !view.update.restored ? view.update : undefined;
  const [heard, setHeard] = useState(() => opening(account));
  const latest = hear(heard, account, news);
  if (latest !== heard) setHeard(latest);

  useEffect(() => {
    if (!pending) return;
    if (view.on === pending.to) {
      setPending(undefined);
      return;
    }
    if (pending.stage !== 'sent') return;
    const timer = setTimeout(() => setPending(undefined), SWITCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending, view.on]);
  const turn = (to: boolean) => {
    setPending({ to, stage: 'sent' });
    const answered = (state: SendBoxCommandState) =>
      setPending((now) => (now?.to !== to ? now : state === 'dropped' ? undefined : { to, stage: state }));
    emitter.emit('sendbox.command', to ? '/board on' : '/board off', conversationId, answered);
  };
  const switching = pending !== undefined;
  // One paragraph per part, read with a pause between them in any language: the model's lines bring their own
  // punctuation. A new board is read as its headline, or, from a harness that sends none, as its state, what it does
  // now and how far it is; a line, as its words.
  const saidBoard = news && latest.said.board === news.id ? news : undefined;
  const saidState = saidBoard ? boardState(saidBoard) : undefined;
  const said = on
    ? [
        ...(saidBoard && words
          ? words.headline
            ? [words.headline]
            : [saidState ? t(`common.kyrn.boardView.${boardStateKey(saidState)}`) : '', words.now, words.progress]
          : []),
        ...account.filter((note) => latest.said.notes.includes(note.id)).map((note) => note.text),
      ].filter(Boolean)
    : [];

  return (
    <section className={styles.board} data-testid='mu-board' aria-label={t('common.kyrn.boardView.title')}>
      <header className={styles.head}>
        <span className={styles.title}>{t('common.kyrn.boardView.title')}</span>
        {pending ? (
          <span className={styles.faint} data-testid='mu-board-pending'>
            {t(pending.stage === 'waiting' ? 'common.kyrn.boardView.afterTurn' : 'common.kyrn.boardView.switching')}
          </span>
        ) : null}
        <Switch
          size='small'
          checked={pending ? pending.to : on}
          disabled={switching || !view.known}
          aria-label={t('common.kyrn.boardView.switch')}
          data-testid='mu-board-switch'
          onChange={turn}
        />
      </header>
      {!view.known ? (
        <p className={styles.empty} data-testid='mu-board-unknown'>
          {t('common.kyrn.boardView.unknown')}
        </p>
      ) : !on ? (
        <Off />
      ) : view.update && words ? (
        <Current update={view.update} words={words} fresh={news === view.update} />
      ) : account.length ? null : (
        <p className={styles.empty} data-testid='mu-board-empty'>
          {t('common.kyrn.boardView.empty')}
        </p>
      )}
      {on && account.length ? (
        <Account notes={account} isFresh={(note) => latest.fresh.get(note.id) === true} words={sayNote} />
      ) : null}
      {/* In place from the start, so what changes in it is announced; only news goes in. */}
      <div className={styles.announce} aria-live='polite' aria-atomic='true' data-testid='mu-board-announce'>
        {said.map((part, index) => (
          <p key={index}>{part}</p>
        ))}
      </div>
    </section>
  );
}

/** What the switch above does, and what it costs. The switch is the one way to turn the board on. */
function Off() {
  const { t } = useTranslation();
  return (
    <div className={styles.off} data-testid='mu-board-off'>
      <p className={styles.offText}>{t('common.kyrn.boardView.off')}</p>
      <p className={styles.faint}>{t('common.kyrn.boardView.cost')}</p>
    </div>
  );
}

/**
 * A state's mark, never a colour: a dot while the agent works (hollow when it seems stuck or waits on something), a
 * tick when the run is done, a hollow dot when it waits for the person, a dash when it stopped.
 */
function stateMark(state: BoardState): 'dot' | 'hollow' | 'tick' | 'dash' {
  if (state.ended === false) return state.phase === 'stuck' || state.phase === 'blocked' ? 'hollow' : 'dot';
  return state.outcome === 'done' ? 'tick' : state.outcome === 'waiting' ? 'hollow' : 'dash';
}

/** How long ago the board was made, counting up on its own: only this label re-renders as the seconds go by. */
function Updated({ at }: { at: number }) {
  const { t, i18n } = useTranslation();
  const now = useNow(1000);
  const ago = Math.max(0, now - at);
  return (
    <time className={styles.updated} dateTime={new Date(at).toISOString()} data-testid='mu-board-updated'>
      {ago < 5000
        ? t('common.kyrn.boardView.updatedNow')
        : t('common.kyrn.boardView.updated', { ago: formatElapsed(ago, i18n.language) })}
    </time>
  );
}

/**
 * The latest board, top to bottom: its state (and, from a harness that says when it made the board, how long ago),
 * then the spoken headline, what is blocked and what comes next when the board has them, what the agent does now (the
 * main paragraph of a board without a headline), how far it is, what it needs from the person, each item with its
 * action, and who is doing what. A new one (`fresh`) fades in.
 */
function Current({ update, words, fresh }: { update: BoardUpdate; words: BoardWords; fresh: boolean }) {
  const { t, i18n } = useTranslation();
  const part = share(update);
  const state = boardState(update);
  const checks = t('common.kyrn.boardView.checks', {
    done: formatNumber(update.done, i18n.language),
    total: formatNumber(update.total, i18n.language),
    count: update.total,
  });
  const quote = (item: string) =>
    emitter.emit('sendbox.reply', { messageId: `mu-board:${update.id}`, content: item, position: 'left' });
  const mark = state ? stateMark(state) : undefined;
  const marks = [
    // One state only: a working run's stage, or how a run that stopped ended.
    state ? (
      <span
        key='state'
        className={styles.state}
        data-testid='mu-board-state'
        data-state={state.ended ? state.outcome : 'working'}
      >
        <span className={styles.stateMark} data-mark={mark} aria-hidden='true'>
          {mark === 'tick' ? <Check size={11} strokeWidth={4} /> : null}
        </span>
        {t(`common.kyrn.boardView.${boardStateKey(state)}`)}
      </span>
    ) : null,
    update.by === 'rules' ? (
      <Tooltip key='brief' content={t('common.kyrn.boardView.briefHelp')}>
        <span className={styles.brief}>{t('common.kyrn.boardView.brief')}</span>
      </Tooltip>
    ) : null,
    update.updatedAt ? <Updated key='updated' at={update.updatedAt} /> : null,
  ].filter(Boolean);
  // A board with a headline leads with it; "now" becomes a plain paragraph under it, and is left out when it only
  // says the headline again (a fixed board's stage sentence).
  const spoken = Boolean(words.headline);
  const now = spoken && words.now === words.headline ? '' : words.now;
  return (
    <div className={styles.current} data-testid='mu-board-current'>
      {marks.length ? <div className={styles.marks}>{marks}</div> : null}
      <div
        key={update.id}
        className={classNames(spoken && styles.spoken, fresh && styles.fresh)}
        data-fresh={fresh ? 'true' : undefined}
      >
        {spoken ? (
          <p className={styles.headline} data-testid='mu-board-headline'>
            {words.headline}
          </p>
        ) : null}
        {words.blocked ? (
          <div className={classNames(styles.fact, styles.blocked)} data-testid='mu-board-blocked'>
            <span className={styles.factLabel}>
              <span className={styles.stateMark} data-mark='hollow' aria-hidden='true' />
              {t('common.kyrn.boardView.blocked')}
            </span>
            <span className={styles.factText}>{words.blocked}</span>
          </div>
        ) : null}
        {words.next ? (
          <div className={styles.fact} data-testid='mu-board-next'>
            <span className={styles.factLabel}>{t('common.kyrn.boardView.next')}</span>
            <span className={styles.factText}>{words.next}</span>
          </div>
        ) : null}
        {now ? (
          <p className={classNames(styles.now, spoken && styles.nowPlain)} data-testid='mu-board-now'>
            {now}
          </p>
        ) : null}
        {words.progress ? (
          <p className={styles.progress} data-testid='mu-board-progress'>
            {words.progress}
          </p>
        ) : null}
      </div>
      {part !== undefined ? (
        <div className={styles.meter}>
          <div
            className={styles.bar}
            role='progressbar'
            aria-valuemin={0}
            aria-valuemax={update.total}
            aria-valuenow={update.done}
            aria-label={checks}
          >
            <span style={{ width: `${Math.round(part * 100)}%` }} />
          </div>
          <span className={styles.count}>{checks}</span>
        </div>
      ) : null}
      {asksUser(update) ? (
        <section className={styles.ask} data-testid='mu-board-ask' aria-label={t('common.kyrn.boardView.needsYou')}>
          <h4 className={styles.sectionTitle}>{t('common.kyrn.boardView.needsYou')}</h4>
          {words.confirm.length ? (
            <ul className={styles.askList}>
              {words.confirm.map((item, index) => (
                <li key={`${index}:${item}`}>
                  <Button
                    type='text'
                    long
                    className={styles.askItem}
                    data-testid='mu-board-confirm'
                    title={t('common.kyrn.boardView.quote')}
                    onClick={() => quote(item)}
                  >
                    <span className={styles.askText} data-testid='mu-board-confirm-text'>
                      {item}
                    </span>
                    <span className={styles.askAction}>{t('common.reply')}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.askPlain}>{t('common.kyrn.boardView.needsYouText')}</p>
          )}
        </section>
      ) : null}
      {update.agents?.length ? (
        <Agents agents={update.agents} updatedAt={update.updatedAt} live={!update.ended && !update.restored} />
      ) : null}
    </div>
  );
}
