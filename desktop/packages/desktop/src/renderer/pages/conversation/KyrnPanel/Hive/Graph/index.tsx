import React, { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { HiveBee, SwarmKind } from '@/common/kyrn/hive';
import { useContainerWidth } from '@/renderer/pages/conversation/hooks/useContainerWidth';
import BeeAvatar from '../BeeAvatar';
import styles from './Graph.module.css';
import { HOME, linkKey, type HiveLink, type HiveLinkKind } from './links';
import { AVATAR_RADIUS, bendOf, HOME_RADIUS, linkPath, NODE_WIDTH, ringLayout } from './layout';

const KEY = 'common.kyrn.hiveView';
/** How long a delivery's dash is watched for after it arrives. */
const PULSE_MS = 1600;
const TEST_IDS: Record<HiveLinkKind, string> = {
  delivery: 'hive-connection',
  correction: 'hive-correction',
  conflict: 'hive-conflict',
  report: 'hive-report',
};

/**
 * The map of one run: its bees on a ring (around mu, for a delegate call's sub-agents; a hive's goal is the line
 * above the map), a line for each pair the judge handed notes between, thicker the more went that way, an arrow at
 * the receiving end. A correction (a later note that replaced an earlier one) carries a bar across its middle; a
 * dispute is dashed. A delivery that arrives while the run is going sends one dash of the accent along its line. A
 * pointer on a line reads what went along it; a bee opens its record.
 */
export default function HiveGraph({
  kind,
  bees,
  links,
  live,
  selected,
  onSelect,
}: {
  kind: SwarmKind;
  bees: readonly HiveBee[];
  links: readonly HiveLink[];
  live: boolean;
  selected?: string;
  onSelect: (name: string) => void;
}) {
  const { t } = useTranslation();
  const ids = useId().replace(/:/g, '');
  const { containerRef, containerWidth } = useContainerWidth();
  const layout = ringLayout(
    bees.map((bee) => bee.name),
    containerWidth,
    kind === 'delegate'
  );
  const drawn = links.filter(
    (link) => layout.nodes.has(link.from) && (layout.nodes.has(link.to) || (kind === 'delegate' && link.to === HOME))
  );
  const pulses = usePulses(drawn, live);
  const point = (name: string) => (name === HOME ? layout.centre : layout.nodes.get(name)!);
  const kinds = new Set(drawn.map((link) => link.kind));
  const legend: HiveLinkKind[] = (
    kind === 'hive' ? (['delivery', 'correction', 'conflict'] as const) : (['report'] as const)
  ).filter((entry) => entry === 'delivery' || entry === 'report' || kinds.has(entry));

  return (
    <section className={styles.map} aria-label={t(`${KEY}.graph`)}>
      <div ref={containerRef} className={styles.stage} style={{ height: layout.height }} data-testid='hive-map'>
        <svg
          className={styles.lines}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden='true'
        >
          <defs>
            {/* Markers keep their size whatever the line's width: a busy line is thicker, not heavier at its end. */}
            <marker
              id={`${ids}-arrow`}
              markerUnits='userSpaceOnUse'
              markerWidth='8'
              markerHeight='8'
              refX='7'
              refY='4'
              orient='auto'
            >
              <path className={styles.arrow} d='M0 0.5 L8 4 L0 7.5 Z' />
            </marker>
            <marker
              id={`${ids}-bar`}
              markerUnits='userSpaceOnUse'
              markerWidth='10'
              markerHeight='10'
              refX='5'
              refY='5'
              orient='auto'
            >
              <path className={styles.bar} d='M5 0.5 L5 9.5' />
            </marker>
          </defs>
          {drawn.map((link) => {
            const key = linkKey(link);
            const from = point(link.from);
            const to = point(link.to);
            const bend = bendOf(link.from, link.to);
            const d = linkPath(from, to, bend, { toHome: link.to === HOME, endGap: link.kind === 'conflict' ? 3 : 7 });
            const muted = Boolean(selected && selected !== link.from && selected !== link.to);
            const pulse = pulses.get(key);
            return (
              <g key={key}>
                <path
                  className={styles.line}
                  data-testid={TEST_IDS[link.kind]}
                  data-kind={link.kind}
                  data-from={link.from}
                  data-to={link.to === HOME ? 'mu' : link.to}
                  data-count={link.count}
                  data-muted={muted}
                  d={d}
                  strokeWidth={1 + Math.min(link.count - 1, 4) * 0.6}
                  markerEnd={link.kind === 'conflict' ? undefined : `url(#${ids}-arrow)`}
                  markerMid={link.kind === 'correction' ? `url(#${ids}-bar)` : undefined}
                />
                {pulse !== undefined && (
                  <path key={pulse} className={styles.pulse} data-testid='hive-pulse' d={d} pathLength={100} />
                )}
                <path className={styles.hit} d={d}>
                  <title>{lineWords(t, link)}</title>
                </path>
              </g>
            );
          })}
        </svg>
        {kind === 'delegate' && (
          <span
            className={styles.home}
            style={{ left: layout.centre.x, top: layout.centre.y, width: 2 * HOME_RADIUS, height: 2 * HOME_RADIUS }}
            aria-hidden='true'
          >
            mu
          </span>
        )}
        {bees.map((bee) => {
          const at = layout.nodes.get(bee.name)!;
          const status = t(bee.status === 'unknown' ? `${KEY}.unknown` : `common.kyrn.beeStatus.${bee.status}`);
          return (
            <Button
              key={bee.name}
              type='text'
              className={styles.node}
              style={{ left: at.x - NODE_WIDTH / 2, top: at.y - AVATAR_RADIUS, width: NODE_WIDTH }}
              aria-label={t(`${KEY}.inspect`, { name: bee.name })}
              aria-pressed={selected === bee.name}
              title={`${bee.name} · ${status}`}
              onClick={() => onSelect(bee.name)}
            >
              <BeeAvatar name={bee.name} status={bee.status} />
              <span className={styles.nodeName} dir='auto'>
                {bee.name}
              </span>
              <span className={styles.nodeStatus}>{status}</span>
              {kind === 'hive' && (
                <span className={styles.nodeCounts}>
                  {t(`${KEY}.nodeSent`, { count: bee.published })} · {t(`${KEY}.nodeReceived`, { count: bee.received })}
                </span>
              )}
            </Button>
          );
        })}
      </div>
      <ul className={styles.legend} aria-label={t(`${KEY}.legend`)}>
        {legend.map((entry) => (
          <li key={entry}>
            <LegendLine kind={entry} ids={ids} />
            {t(`${KEY}.legend${entry[0].toUpperCase()}${entry.slice(1)}`)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What a pointer on a line reads: who to whom, how many, and the words that went along it. */
function lineWords(t: ReturnType<typeof useTranslation>['t'], link: HiveLink): string {
  const names = { from: link.from, to: link.to === HOME ? 'mu' : link.to, count: link.count };
  const head =
    link.kind === 'delivery'
      ? t(`${KEY}.lineDelivery`, names)
      : link.kind === 'correction'
        ? t(`${KEY}.lineCorrection`, names)
        : link.kind === 'conflict'
          ? t(`${KEY}.lineConflict`, names)
          : t(`${KEY}.lineReport`, names);
  return [head, ...link.texts.map((text) => `· ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`)].join('\n');
}

function LegendLine({ kind, ids }: { kind: HiveLinkKind; ids: string }) {
  return (
    <svg className={styles.legendLine} width='30' height='10' viewBox='0 0 30 10' aria-hidden='true'>
      <path
        className={styles.line}
        data-kind={kind}
        d={kind === 'correction' ? 'M1 5 L14 5 L27 5' : 'M1 5 L27 5'}
        strokeWidth={1.4}
        markerEnd={kind === 'conflict' ? undefined : `url(#${ids}-arrow)`}
        markerMid={kind === 'correction' ? `url(#${ids}-bar)` : undefined}
      />
    </svg>
  );
}

/**
 * The lines to send a dash along: those with a receipt that was not there at the previous render, while the run is
 * going. What is already on the map when it is first drawn is history and stays still. A dash is kept for a moment
 * after it arrives; a later arrival on the same line starts it again.
 */
function usePulses(links: readonly HiveLink[], live: boolean): ReadonlyMap<string, number> {
  const seen = useRef<ReadonlySet<string> | undefined>(undefined);
  const [pulses, setPulses] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    const ids = new Set(links.flatMap((link) => link.ids));
    const before = seen.current;
    seen.current = ids;
    if (!before) return;
    const fresh = links.filter((link) => link.kind !== 'conflict' && link.ids.some((id) => !before.has(id)));
    if (!live || !fresh.length) return;
    const now = Date.now();
    setPulses((old) => new Map([...old, ...fresh.map((link) => [linkKey(link), now] as const)]));
  }, [links, live]);
  useEffect(() => {
    if (!pulses.size) return;
    const timer = setTimeout(() => {
      const now = Date.now();
      setPulses((old) => new Map([...old].filter(([, at]) => now - at < PULSE_MS)));
    }, PULSE_MS);
    return () => clearTimeout(timer);
  }, [pulses]);
  return pulses;
}
