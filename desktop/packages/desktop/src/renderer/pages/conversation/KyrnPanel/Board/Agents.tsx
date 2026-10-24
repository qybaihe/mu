import React from 'react';
import { Tooltip } from '@arco-design/web-react';
import { Check, Close } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { formatElapsed, useNow } from '../clock';
import type { AgentState, BoardAgent } from './board';
import styles from './Board.module.css';

/** The states that go on: their time in that state counts up. */
const LIVE: ReadonlySet<AgentState> = new Set(['working', 'waiting', 'stuck']);
/** The states worth reading at a glance, said in words beside the mark; the others are told by the mark alone. */
const NOTABLE: ReadonlySet<AgentState> = new Set(['waiting', 'stuck', 'failed']);

/** A state's words: the hive tab's for done and failed, the board's own for the rest. */
const stateKey = (state: AgentState): string =>
  state === 'done' || state === 'failed'
    ? `common.kyrn.beeStatus.${state}`
    : `common.kyrn.boardView.agentStates.${state}`;

/**
 * A state as a mark, never a colour, as the hive tab draws its sub-agents: a dot while one works, a hollow dot while it
 * waits or seems stuck, a tick when done, a cross when it failed, a dash for a state this build does not know.
 */
function Mark({ state }: { state?: AgentState }) {
  const mark =
    state === 'working'
      ? 'dot'
      : state === 'waiting' || state === 'stuck'
        ? 'hollow'
        : state === 'done'
          ? 'tick'
          : state === 'failed'
            ? 'cross'
            : 'dash';
  return (
    <span className={styles.stateMark} data-mark={mark} aria-hidden='true'>
      {mark === 'tick' ? (
        <Check size={11} strokeWidth={4} />
      ) : mark === 'cross' ? (
        <Close size={11} strokeWidth={4} />
      ) : null}
    </span>
  );
}

/** How long a helper has been in its state, counting up while the board is live. */
function Elapsed({ since, from, live }: { since: number; from?: number; live: boolean }) {
  const { i18n } = useTranslation();
  const now = useNow(5000, live && from !== undefined);
  const span = since + (live && from !== undefined ? Math.max(0, now - from) : 0);
  return (
    <span className={styles.agentTime} data-testid='mu-board-agent-time'>
      {formatElapsed(span, i18n.language)}
    </span>
  );
}

/**
 * A helper's name in its row: what the board calls it (its label, board v2.1), else its exact name. With a label, the
 * exact name (and role) is in its tooltip; without one, in its title, as before.
 */
function Who({ agent }: { agent: BoardAgent }) {
  const full = agent.role ? `${agent.who} (${agent.role})` : agent.who;
  const shown = agent.label ?? agent.who;
  if (shown === agent.who) {
    return (
      <span className={styles.agentWho} title={full} data-testid='mu-board-agent-who'>
        {agent.who}
      </span>
    );
  }
  return (
    <Tooltip content={full}>
      <span className={styles.agentWho} data-testid='mu-board-agent-who' data-who={agent.who} dir='auto'>
        {shown}
      </span>
    </Tooltip>
  );
}

/**
 * Who is doing what: one row per helper the main agent sent out, as the harness's rules saw them when the board was
 * made (so no name is ever made up): its state, its name (its label when the board has one), what it is doing, and for
 * one still at it, how long. `live`: the board is the current one of a running session, so the times count up from
 * `updatedAt`.
 */
export default function Agents({
  agents,
  updatedAt,
  live,
}: {
  agents: readonly BoardAgent[];
  updatedAt?: number;
  live: boolean;
}) {
  const { t } = useTranslation();
  const title = t('common.kyrn.boardView.agents');
  return (
    <section className={styles.agents} data-testid='mu-board-agents' aria-label={title}>
      <h4 className={styles.sectionTitle}>{title}</h4>
      <ul className={styles.agentList}>
        {agents.map((agent, index) => {
          const state = agent.state;
          const going = state !== undefined && LIVE.has(state);
          return (
            <li
              key={`${index}:${agent.who}`}
              className={styles.agent}
              data-testid='mu-board-agent'
              data-state={state ?? 'unknown'}
            >
              <Mark state={state} />
              <Who agent={agent} />
              <span className={styles.agentDoing} dir='auto'>
                {state ? (
                  <span
                    className={NOTABLE.has(state) ? styles.agentState : 'sr-only'}
                    data-testid='mu-board-agent-state'
                  >
                    {t(stateKey(state))}
                  </span>
                ) : null}{' '}
                {agent.doing}
              </span>
              {going && agent.sinceMs !== undefined ? (
                <Elapsed since={agent.sinceMs} from={updatedAt} live={live} />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
