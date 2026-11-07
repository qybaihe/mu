import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Collapse } from '@arco-design/web-react';
import { Check, Close } from '@icon-park/react';
import classNames from 'classnames';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  isBeeActive,
  parseSwarmSnapshot,
  type HiveBee,
  type HiveBeeStatus,
  type HiveBoardLine,
} from '@/common/kyrn/hive';
import type { Activity } from '@/common/kyrn/types';
import { useModelNames } from '@/renderer/hooks/agent/useModelNames';
import { list, record, str } from '../activity';
import type { HiveFocusRequest } from '../focus';
import { beeCounters, ErrorNotice, quietLabel } from '../text';
import { buildHiveRuns, endedRuns, type HiveRun } from './activity';
import BeeActivityList from './BeeActivity';
import { swarmTitleText } from './codes';
import HiveGraph from './Graph';
import { hiveLinks, isLive, reportLinks, snapshotLinks, type HiveLink } from './Graph/links';
import { beeLine, beeWho, settledBee, swarmSummary } from './HiveToolCard';
import Hive from './index';
import styles from './Hive.module.css';

/**
 * One run of sub-agents as the tab lists it: a hive, or a delegate call's tasks. `latest` is the board's last notes and
 * whom each reached, as the latest snapshot sums them up.
 */
type SwarmRun = {
  id: string;
  at: number;
  kind: 'hive' | 'delegate';
  title: string;
  bees: HiveBee[];
  asked: string[];
  latest: HiveBoardLine[];
};

/**
 * The runs of this conversation, newest first. Each snapshot is read by the parser the transcript's sub-agent card
 * uses; a snapshot from a harness that did not name its kind is a delegate call's. A hive announced by its manifest
 * but not yet reported lists the bees it asked for.
 */
function swarmRuns(t: TFunction, events: readonly Activity[]): SwarmRun[] {
  const runs = new Map<string, SwarmRun>();
  const runOf = (event: Activity & { run: string }): SwarmRun => {
    const known = runs.get(event.run);
    if (known) return known;
    const run: SwarmRun = { id: event.run, at: event.at, kind: 'hive', title: '', bees: [], asked: [], latest: [] };
    runs.set(event.run, run);
    return run;
  };
  for (const event of events) {
    if (!event.run) continue;
    if (event.kind === 'hive.manifest') {
      const run = runOf({ ...event, run: event.run });
      run.title ||= str(event.payload.goal);
      run.asked = list(event.payload.bees)
        .map((bee) => str(bee.name))
        .filter(Boolean);
    } else if (event.kind === 'swarm.snapshot') {
      const payload = record(event.payload);
      const snapshot = parseSwarmSnapshot(payload.kind === undefined ? { ...payload, kind: 'delegate' } : payload);
      if (!snapshot) continue;
      const run = runOf({ ...event, run: event.run });
      run.kind = snapshot.kind;
      run.title = swarmTitleText(t, snapshot) || run.title;
      run.bees = snapshot.bees;
      run.latest = snapshot.latest;
    }
  }
  return [...runs.values()].toSorted((a, b) => b.at - a.at);
}

const rowKey = (runId: string, beeName: string): string => JSON.stringify([runId, beeName]);

/** A bee's state as a mark, never as a colour: a dot while it works, a tick when done, a cross when it failed. */
function StatusMark({ status }: { status: HiveBeeStatus }) {
  const shape = isBeeActive(status)
    ? 'active'
    : status === 'done'
      ? 'done'
      : status === 'failed' || status === 'timed-out'
        ? 'failed'
        : status === 'queued'
          ? 'queued'
          : 'idle';
  return (
    <span className={styles.mark} data-shape={shape} aria-hidden='true'>
      {shape === 'done' ? (
        <Check size={11} strokeWidth={4} />
      ) : shape === 'failed' ? (
        <Close size={11} strokeWidth={4} />
      ) : null}
    </span>
  );
}

/**
 * The lines of a run's map: what the board recorded for a hive, the reports that came back for a delegate call. A
 * conversation on the native host has no records of the board (its activity is the view's, which reads no files:
 * native/utils/toActivity.ts), so its hive draws what the snapshots say: the latest notes and whom each reached.
 */
function linksOf(run: SwarmRun, detail: HiveRun | undefined): HiveLink[] {
  if (run.kind === 'delegate') return reportLinks(run.bees);
  if (detail && (detail.deliveries.length > 0 || detail.notes.length > 0))
    return hiveLinks(detail.deliveries, detail.notes, detail.relations);
  return snapshotLinks('hive', run.bees, run.latest);
}

/**
 * The hive tab, newest run first: each run's map (the bees around the goal and what passed between them) over its
 * rows — one per sub-agent: its task, then what it is doing or said beside its role, model and thinking level — under
 * a line that counts how many run, are done and failed. The newest run's map is open, an older run's opens on its
 * button. A row opens to its counts, its silence, why it stopped and its last steps; a hive run also opens to its
 * records (the notes passed between bees, the gates). A bee picked on the map opens its row. A request from the
 * transcript opens the bee it names.
 */
export default function HiveRows({ events, focus }: { events: Activity[]; focus?: HiveFocusRequest }) {
  const { t, i18n } = useTranslation();
  const names = useModelNames();
  const runs = useMemo(() => swarmRuns(t, events), [t, events]);
  const records = useMemo(() => new Map(buildHiveRuns(events).map((run) => [run.id, run])), [events]);
  const ended = useMemo(() => endedRuns(events), [events]);
  // Runs whose map is the other way round from the default (open for the newest run, closed for the rest).
  const [mapsToggled, setMapsToggled] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<{ run: string; bee: string }>();
  // The bee a request from the transcript names is open from the first frame it is drawn in.
  const focusKey = focus?.beeName ? rowKey(focus.runId, focus.beeName) : undefined;
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(focusKey ? [focusKey] : []));
  const [answered, setAnswered] = useState(focus);
  if (focus !== answered) {
    setAnswered(focus);
    if (focusKey && !opened.has(focusKey)) setOpened(new Set([...opened, focusKey]));
  }
  const anchors = useRef(new Map<string, HTMLElement>());
  const focusedRun = focus ? runs.find((run) => run.id === focus.runId) : undefined;

  useEffect(() => {
    if (!focus || !focusedRun) return;
    const anchor = anchors.current.get(focus.beeName ? rowKey(focus.runId, focus.beeName) : focus.runId);
    anchor?.scrollIntoView?.({ block: 'nearest' });
  }, [focus, focusedRun]);

  const toggle = (key: string) =>
    setOpened((old) => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const anchor = (key: string) => (element: HTMLElement | null) => {
    if (element) anchors.current.set(key, element);
    else anchors.current.delete(key);
  };
  const toggleMap = (runId: string) =>
    setMapsToggled((old) => {
      const next = new Set(old);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });
  // A bee picked on the map: its row opens and comes into view; picking it again lets go of it.
  const pick = (runId: string, bee: string) => {
    const key = rowKey(runId, bee);
    if (picked?.run === runId && picked.bee === bee) {
      setPicked(undefined);
      return;
    }
    setPicked({ run: runId, bee });
    setOpened((old) => (old.has(key) ? old : new Set([...old, key])));
    anchors.current.get(key)?.scrollIntoView?.({ block: 'nearest' });
  };

  return (
    <div className={styles.rowsTab} data-testid='kyrn-hive'>
      {focus && !focusedRun ? <p className={styles.empty}>{t('common.kyrn.hiveView.waitingRun')}</p> : null}
      {!runs.length && !focus ? <p className={styles.empty}>{t('common.kyrn.hiveView.none')}</p> : null}
      {runs.map((listed, index) => {
        // Once its turn is over, no bee of a run is still at work: a run mu's death cut short says so.
        const over = ended.has(listed.id);
        const bees = listed.bees.map((bee) => settledBee(bee, !over));
        const cutShort = bees.some((bee, at) => bee !== listed.bees[at]);
        const run = { ...listed, bees };
        const running = run.bees.filter((bee) => isBeeActive(bee.status)).length;
        const done = run.bees.filter((bee) => bee.status === 'done').length;
        const failed = run.bees.filter((bee) => bee.status === 'failed' || bee.status === 'timed-out').length;
        const mapOpen = (index === 0) !== mapsToggled.has(run.id);
        return (
          <section key={run.id} className={styles.run} data-hive-run={run.id} ref={anchor(run.id)}>
            <header className={styles.runHead}>
              <span className={styles.runTitle} dir='auto' title={run.title}>
                {run.title || t(run.kind === 'delegate' ? 'common.kyrn.hiveView.agents' : 'common.kyrn.hiveView.title')}
              </span>
              <span className={styles.runCounts}>
                {cutShort ? swarmSummary(t, bees, false) : t('common.kyrn.hiveView.counts', { running, done, failed })}
              </span>
              {run.bees.length ? (
                <Button
                  type='text'
                  size='mini'
                  className={styles.mapToggle}
                  aria-pressed={mapOpen}
                  onClick={() => toggleMap(run.id)}
                >
                  {t('common.kyrn.hiveView.map')}
                </Button>
              ) : null}
            </header>
            {mapOpen && run.bees.length ? (
              <HiveGraph
                kind={run.kind}
                bees={run.bees}
                links={linksOf(run, records.get(run.id))}
                live={isLive(run.bees)}
                selected={picked?.run === run.id ? picked.bee : undefined}
                onSelect={(bee) => pick(run.id, bee)}
              />
            ) : null}
            <ul className={styles.rows}>
              {run.bees.map((bee) => {
                const key = rowKey(run.id, bee.name);
                const open = opened.has(key);
                const status = t(
                  bee.status === 'unknown' ? 'common.kyrn.hiveView.unknown' : `common.kyrn.beeStatus.${bee.status}`
                );
                const who = beeWho(t, bee, names);
                return (
                  <li key={bee.name} ref={anchor(key)} data-bee={bee.name}>
                    <Button type='text' long className={styles.row} aria-expanded={open} onClick={() => toggle(key)}>
                      <StatusMark status={bee.status} />
                      <span className={styles.srOnly}>{status}</span>
                      <span className={styles.rowMain}>
                        {/* The task is the one part that is cut to fit: its whole is on hover. */}
                        <span className={styles.rowName} dir='auto' title={bee.name} data-testid='hive-row-task'>
                          {bee.name}
                        </span>
                        <span className={styles.rowStatus}>
                          {/* One line while closed; the whole of it once the row is open. */}
                          <span
                            className={classNames(
                              bee.error ? styles.rowFailed : styles.rowDoing,
                              bee.tool && !bee.error && styles.rowTool,
                              open && styles.rowWhole
                            )}
                            dir='auto'
                          >
                            {beeLine(t, bee, i18n.language)}
                          </span>
                          {/* Never cut: it goes under what the bee is doing when both do not fit. */}
                          {who ? (
                            <span className={styles.rowWho} dir='auto' data-testid='hive-row-who'>
                              {who}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </Button>
                    {open ? <BeeDetail bee={bee} /> : null}
                  </li>
                );
              })}
              {!run.bees.length
                ? run.asked.map((name) => (
                    <li key={name} className={styles.rowAsked}>
                      <StatusMark status='queued' />
                      <span className={styles.rowName} dir='auto'>
                        {name}
                      </span>
                      <span className={styles.rowDoing}>{t('common.kyrn.hiveView.pending')}</span>
                    </li>
                  ))
                : null}
            </ul>
            {run.kind === 'hive' ? <HiveDetails events={events} runId={run.id} /> : null}
          </section>
        );
      })}
    </div>
  );
}

/**
 * What a row opens to, under its line (which then shows in full what it is doing, said or why it stopped): its
 * counts, its silence, that it failed, its last steps.
 */
function BeeDetail({ bee }: { bee: HiveBee }) {
  const { t, i18n } = useTranslation();
  return (
    <div className={styles.rowDetail}>
      <p className={styles.quiet}>{beeCounters(t, bee)}</p>
      {bee.quietMs > 0 ? <p className={styles.quiet}>{quietLabel(t, bee.quietMs, i18n.language)}</p> : null}
      {bee.error ? <ErrorNotice title={t('common.kyrn.beeFailed')} /> : null}
      <BeeActivityList entries={bee.recent} />
    </div>
  );
}

/** The full hive view of one run, on demand: the map, what passed between the bees, the gates, each bee's record. */
function HiveDetails({ events, runId }: { events: Activity[]; runId: string }) {
  const { t } = useTranslation();
  // One request per run, kept: the hive view re-selects its run whenever the request changes.
  const focus = useMemo<HiveFocusRequest>(() => ({ conversationId: '', runId }), [runId]);
  return (
    <Collapse bordered={false} className={styles.collapse}>
      <Collapse.Item name='details' header={t('common.kyrn.hiveView.details')}>
        <Hive events={events} focus={focus} />
      </Collapse.Item>
    </Collapse>
  );
}
