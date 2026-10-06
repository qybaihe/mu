import React from 'react';
import { Button } from '@arco-design/web-react';
import { Right } from '@icon-park/react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { isBeeActive, type HiveBee, type HiveToolData } from '@/common/kyrn/hive';
import type { NormalizedToolStatus } from '@/common/chat/normalizeToolCall';
import { modelDisplayName, type ModelNames } from '@/renderer/utils/model/providerName';
import { thinkingLevelLabel } from '@/renderer/utils/model/thinkingLevel';
import { requestHiveFocus } from '../focus';
import BeeAvatar from './BeeAvatar';
import { beeActivityText, beeErrorText, swarmTitleText } from './codes';
import HiveMiniature from './Graph/Miniature';
import styles from './Hive.module.css';

/**
 * A sub-agent run in the transcript: one line per sub-agent, never the tool's payload. Each line says who it is (its
 * name and the role it was given) and what it is doing right now — the tool it is running, what it is thinking about,
 * or, once it is back, the first of what it reported. The header carries the run's map in miniature, and opens the
 * run in the panel's hive tab; a line opens that sub-agent there. Once the call is over, a sub-agent its last
 * snapshot caught at work reads as stopped, and the header counts what got done and what did not.
 */

/**
 * What a sub-agent's line says on its right: its own words, in the app language where the harness gave a code. The
 * work panel's hive tab says the same on its rows. `thinking` is its thinking level, shown beside its model, never as
 * what it is doing.
 *
 * A read or a search takes milliseconds and a model reply seconds, so a working sub-agent is nearly always caught
 * waiting on its model, with no tool running and nothing said yet. Its status alone would then read "thinking" for
 * the whole run; its last step beside it changes as it works.
 */
export function beeLine(t: ReturnType<typeof useTranslation>['t'], bee: HiveBee, language?: string | null): string {
  if (bee.error) return beeErrorText(t, bee, language);
  if (bee.tool) return bee.tool.summary || bee.tool.name;
  if (bee.said) return bee.said;
  const status = t(bee.status === 'unknown' ? 'common.kyrn.hiveView.unknown' : `common.kyrn.beeStatus.${bee.status}`);
  const last = isBeeActive(bee.status) ? bee.recent.at(-1) : undefined;
  return last ? t('common.kyrn.hiveView.lastStep', { status, step: beeActivityText(t, last, language) }) : status;
}

/**
 * A sub-agent's model by the name the send box's picker gives it, never its raw `provider/model-id`, with its thinking
 * level as a word: "GPT-5.6 Terra · High". Empty when the snapshot names neither.
 */
export function beeModel(t: TFunction, bee: HiveBee, names?: ModelNames): string {
  return [bee.model && modelDisplayName(bee.model, names), bee.thinking && thinkingLevelLabel(t, bee.thinking)]
    .filter(Boolean)
    .join(' · ');
}

/** The roles that ship with mu (the harness's `packages/kyrn-judge/agents`): said in the reader's language. */
const BUILT_IN_ROLES: ReadonlySet<string> = new Set([
  'browser',
  'investigator',
  'planner',
  'reviewer',
  'scout',
  'worker',
]);

/** A sub-agent's role as the reader says it: a built-in one in their language, one of the person's own as named. */
export function beeRole(t: TFunction, role: string): string {
  return BUILT_IN_ROLES.has(role) ? t(`common.kyrn.roles.${role}`) : role;
}

/** Who a sub-agent is: its role, in full, then its model and thinking level. Empty when the snapshot names none. */
export function beeWho(t: TFunction, bee: HiveBee, names?: ModelNames): string {
  return [bee.role && beeRole(t, bee.role), beeModel(t, bee, names)].filter(Boolean).join(' · ');
}

/**
 * A sub-agent as the call left it. While the call runs its snapshot says what it is doing. Once the call is over, no
 * sub-agent is still at work: when mu's process closed mid-run, the last snapshot still has some working or waiting to
 * start. Those stopped where they were, with nothing still running.
 */
export function settledBee(bee: HiveBee, callRunning: boolean): HiveBee {
  if (callRunning || !(isBeeActive(bee.status) || bee.status === 'queued')) return bee;
  return { ...bee, status: 'stopped', tool: undefined, said: '' };
}

/** The card's count: how many work and are done while the call runs; once it is over, how many are done and not. */
export function swarmSummary(t: TFunction, bees: readonly HiveBee[], callRunning: boolean): string {
  const done = bees.filter((bee) => bee.status === 'done').length;
  if (callRunning) {
    const active = bees.filter((bee) => isBeeActive(bee.status)).length;
    return t('common.kyrn.hiveView.summary', { active, done, total: bees.length });
  }
  const unfinished = bees.length - done;
  return unfinished
    ? t('common.kyrn.hiveView.summaryUnfinished', { done, total: bees.length, unfinished })
    : t('common.kyrn.hiveView.summaryEnded', { done, total: bees.length });
}

export default function HiveToolCard({
  data,
  conversationId,
  runId,
  status,
}: {
  data: HiveToolData;
  conversationId?: string;
  runId: string;
  status: NormalizedToolStatus;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const running = status === 'running' || status === 'pending';
  const bees = data.snapshot?.bees.map((bee) => settledBee(bee, running));
  const open = (beeName?: string) => {
    if (conversationId) requestHiveFocus({ conversationId, runId, beeName });
  };
  const title = t(data.kind === 'delegate' ? 'common.kyrn.hiveView.agents' : 'common.kyrn.hiveView.title');
  const runTitle = data.snapshot ? swarmTitleText(t, data.snapshot) : data.goal;
  // A call with no snapshot that is over did not get as far as one: mu stopped mid-call, or the call failed at once.
  const cutShort = !running && status === 'error';
  const summary = bees
    ? swarmSummary(t, bees, running)
    : t(
        running
          ? 'common.kyrn.hiveView.pending'
          : cutShort
            ? 'common.kyrn.hiveView.cutShort'
            : 'common.kyrn.hiveView.unknown'
      );

  return (
    <section className={styles.agents} aria-label={title} data-testid='swarm-tool-card'>
      <Button
        className={styles.agentsHeader}
        type='text'
        size='mini'
        disabled={!conversationId}
        onClick={() => open()}
        aria-label={t('common.kyrn.hiveView.open')}
      >
        <span className={styles.agentsTitle}>{title}</span>
        {data.snapshot && bees && <HiveMiniature kind={data.snapshot.kind} bees={bees} latest={data.snapshot.latest} />}
        <span className={styles.agentsSummary}>{summary}</span>
        <Right size={12} />
      </Button>
      {runTitle && (
        <div className={styles.agentsGoal} title={runTitle}>
          {runTitle}
        </div>
      )}
      <div className={styles.agentsList}>
        {data.names.map((name, index) => {
          const bee = bees?.[index];
          return (
            <Button
              key={`${index}:${name}`}
              type='text'
              size='mini'
              className={styles.agentRow}
              disabled={!conversationId}
              onClick={() => open(name)}
              aria-label={t('common.kyrn.hiveView.inspect', { name })}
            >
              <BeeAvatar name={name} status={bee?.status} small />
              <span className={styles.agentName}>{name}</span>
              {bee?.role && <span className={styles.agentRole}>{beeRole(t, bee.role)}</span>}
              <span className={bee?.error ? styles.agentFailed : styles.agentDoing}>
                {bee
                  ? beeLine(t, bee, language)
                  : t(running ? 'common.kyrn.hiveView.pending' : 'common.kyrn.hiveView.noRecord')}
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}
