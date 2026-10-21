import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import mu from '@/renderer/services/i18n/locales/en-US/mu.json';
import HiveRows from '@/renderer/pages/conversation/KyrnPanel/Hive/HiveRows';
import { endedRuns } from '@/renderer/pages/conversation/KyrnPanel/Hive/activity';
import type { Activity } from '@/common/kyrn/types';
import { activity, hiveEvents, hiveSnapshot } from './hiveFixtures';

vi.mock('@/renderer/components/media/LocalImageView', () => ({ default: () => null }));
vi.mock('@/renderer/utils/file/download', () => ({ downloadFileFromPath: vi.fn() }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { common, mu } } },
    interpolation: { escapeValue: false },
  });
});
afterEach(cleanup);
const view = (children: React.ReactNode) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;

const run = (id: string) =>
  screen.getByText((_, node) => node?.getAttribute('data-hive-run') === id, { selector: 'section' });

describe('the map of a run', () => {
  it('draws a line per pair with its count, a correction with its bar, and words each on hover', () => {
    const { container } = render(
      view(
        <HiveRows
          events={[
            ...hiveEvents,
            activity('note-3', 'hive.note', { id: 'note-3', bee: 'prefix-mutations', kind: 'finding', text: 'Again.' }),
            activity('delivery-2', 'hive.delivery', { note: 'note-3', to: 'provider-cache' }),
          ]}
        />
      )
    );
    const delivery = screen.getByTestId('hive-connection');
    expect(delivery).toHaveAttribute('data-from', 'prefix-mutations');
    expect(delivery).toHaveAttribute('data-to', 'provider-cache');
    expect(delivery).toHaveAttribute('data-count', '2');
    expect(delivery).toHaveAttribute('stroke-width', '1.6');
    expect(delivery.getAttribute('marker-end')).toMatch(/-arrow\)$/);
    const correction = screen.getByTestId('hive-correction');
    expect(correction).toHaveAttribute('data-from', 'provider-cache');
    expect(correction).toHaveAttribute('data-to', 'prefix-mutations');
    expect(correction.getAttribute('marker-mid')).toMatch(/-bar\)$/);
    expect(screen.queryByTestId('hive-conflict')).not.toBeInTheDocument();
    const titles = [...container.querySelectorAll('title')].map((title) => title.textContent);
    expect(titles).toContain(
      'prefix-mutations → provider-cache: 2 deliveries\n· Prefix remains stable after the first request.\n· Again.'
    );
    expect(titles).toContain(
      'provider-cache corrected a finding from prefix-mutations\n· The prefix changes once the provider swaps its cache key.'
    );
    // Its legend names only what is on the map, in plain words.
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['delivery', 'correction']);
    // Each bee says how much it gave and got.
    expect(screen.getByText('1 out · 0 in')).toBeInTheDocument();
    expect(screen.getByText('0 out · 1 in')).toBeInTheDocument();
  });

  it('never draws a passed gate, and dashes a dispute without an arrow', () => {
    render(
      view(<HiveRows events={hiveEvents.filter((event) => !['hive.delivery', 'hive.relation'].includes(event.kind))} />)
    );
    expect(screen.queryByTestId('hive-connection')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hive-correction')).not.toBeInTheDocument();
    cleanup();
    render(
      view(
        <HiveRows
          events={[
            ...hiveEvents.filter((event) => event.kind !== 'hive.relation'),
            activity('dispute', 'hive.relation', { later: 'note-2', earlier: 'note-1', relation: 'contradicts' }),
          ]}
        />
      )
    );
    const conflict = screen.getByTestId('hive-conflict');
    expect(conflict).not.toHaveAttribute('marker-end');
    expect(conflict).toHaveAttribute('data-kind', 'conflict');
    expect(screen.getByRole('list', { name: 'Legend' })).toHaveTextContent('dispute');
  });

  it('draws a native conversation’s hive from its snapshots, which come without the board’s records', () => {
    render(
      view(
        <HiveRows
          events={[
            hiveEvents[0],
            activity('snapshot', 'swarm.snapshot', {
              ...hiveSnapshot,
              board: {
                latest: [
                  { bee: 'prefix-mutations', to: ['provider-cache'], text: 'Prefix remains stable.' },
                  { bee: 'prefix-mutations', to: ['provider-cache'], text: 'Again.' },
                ],
              },
            }),
          ]}
        />
      )
    );
    const delivery = screen.getByTestId('hive-connection');
    expect(delivery).toHaveAttribute('data-from', 'prefix-mutations');
    expect(delivery).toHaveAttribute('data-to', 'provider-cache');
    expect(delivery).toHaveAttribute('data-count', '2');
  });

  it('puts mu in the middle of a delegate run, with a line from each sub-agent that reported back', () => {
    render(
      view(
        <HiveRows
          events={[
            activity('delegate', 'swarm.snapshot', {
              kind: 'delegate',
              title: '3 tasks',
              bees: [
                { name: 'reviewer', status: 'done', said: 'Looks right.' },
                { name: 'tester', status: 'tool', tool: { name: 'bash', summary: 'bash npm test' } },
                { name: 'writer', status: 'failed', error: 'spawn ENOENT' },
              ],
            }),
          ]}
        />
      )
    );
    const map = screen.getByTestId('hive-map');
    expect(within(map).getByText('mu')).toBeInTheDocument();
    const reports = screen.getAllByTestId('hive-report');
    expect(reports.map((line) => [line.getAttribute('data-from'), line.getAttribute('data-to')])).toEqual([
      ['reviewer', 'mu'],
    ]);
    expect(screen.getByRole('list', { name: 'Legend' })).toHaveTextContent('report');
    expect(screen.queryByText(/ out · /)).not.toBeInTheDocument();
  });

  it('opens the newest run on its map and an older one on its button; a picked bee opens its row', () => {
    const older = hiveEvents;
    const newer = activity('newer', 'swarm.snapshot', { ...hiveSnapshot, title: 'Newer run' }, 'run-2');
    newer.at = 20000;
    const { container } = render(view(<HiveRows events={[...older, newer]} />));
    const sections = [...container.querySelectorAll('[data-hive-run]')].map((node) =>
      node.getAttribute('data-hive-run')
    );
    expect(sections).toEqual(['run-2', 'run-1']);
    expect(within(run('run-2')).getByTestId('hive-map')).toBeInTheDocument();
    expect(within(run('run-1')).queryByTestId('hive-map')).not.toBeInTheDocument();
    fireEvent.click(within(run('run-1')).getByRole('button', { name: 'Map', pressed: false }));
    expect(within(run('run-1')).getByTestId('hive-map')).toBeInTheDocument();
    fireEvent.click(within(run('run-2')).getByRole('button', { name: 'Map', pressed: true }));
    expect(within(run('run-2')).queryByTestId('hive-map')).not.toBeInTheDocument();

    const node = within(run('run-1')).getByRole('button', { name: 'Inspect provider-cache' });
    fireEvent.click(node);
    expect(node).toHaveAttribute('aria-pressed', 'true');
    const row = run('run-1').querySelector('[data-bee="provider-cache"] button') as HTMLElement;
    expect(row).toHaveAttribute('aria-expanded', 'true');
    // The line to another bee fades while one is picked; picking it again lets go.
    expect(within(run('run-1')).getByTestId('hive-connection')).toHaveAttribute('data-muted', 'false');
    fireEvent.click(node);
    expect(node).toHaveAttribute('aria-pressed', 'false');
  });

  it('sends a dash along a line only for a delivery that arrives while the run is going', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(view(<HiveRows events={hiveEvents} />));
      expect(screen.queryByTestId('hive-pulse')).not.toBeInTheDocument();
      const more = [
        ...hiveEvents,
        activity('note-3', 'hive.note', { id: 'note-3', bee: 'provider-cache', kind: 'finding', text: 'Late one.' }),
        activity('delivery-2', 'hive.delivery', { note: 'note-3', to: 'prefix-mutations' }),
      ];
      rerender(view(<HiveRows events={more} />));
      const pulse = screen.getByTestId('hive-pulse');
      expect(pulse).toHaveAttribute('d', screen.getAllByTestId('hive-connection')[1].getAttribute('d'));
      act(() => {
        vi.advanceTimersByTime(1700);
      });
      expect(screen.queryByTestId('hive-pulse')).not.toBeInTheDocument();
      // Once every bee is done, a late receipt is history and stays still.
      const ended = {
        ...hiveSnapshot,
        endedAt: 9000,
        bees: hiveSnapshot.bees.map((bee) => Object.assign({}, bee, { status: 'done' })),
      };
      const final = activity('final', 'swarm.snapshot', ended);
      final.at = 30000;
      rerender(view(<HiveRows events={[...more, final]} />));
      rerender(
        view(
          <HiveRows
            events={[
              ...more,
              final,
              activity('note-4', 'hive.note', { id: 'note-4', bee: 'provider-cache', kind: 'finding', text: 'Last.' }),
              activity('delivery-3', 'hive.delivery', { note: 'note-4', to: 'prefix-mutations' }),
            ]}
          />
        )
      );
      expect(screen.queryByTestId('hive-pulse')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a run whose turn is over', () => {
  const closed = (at: number): Activity => ({ id: `closed-${at}`, at, kind: 'kyrn_rpc_closed', payload: {} });

  it('reads a bee that mu’s death caught at work as stopped, and says what did not get done', () => {
    render(view(<HiveRows events={[...hiveEvents, closed(20000)]} />));
    const row = run('run-1').querySelector('[data-bee="prefix-mutations"]') as HTMLElement;
    expect(within(row).getAllByText('Stopped')).not.toHaveLength(0);
    // Its mark is no longer the dot of a bee at work.
    expect(row.querySelector('[data-shape]')).toHaveAttribute('data-shape', 'idle');
    expect(within(run('run-1')).getByText('1 done / 2 · 1 not finished')).toBeInTheDocument();
  });

  it('keeps a running run as it is, and the counts of a run that ended with every bee done', () => {
    const { rerender } = render(view(<HiveRows events={hiveEvents} />));
    expect(within(run('run-1')).getByText('1 running · 1 done · 0 failed')).toBeInTheDocument();
    // A turn that ended before this run began says nothing about it.
    rerender(view(<HiveRows events={[closed(5000), ...hiveEvents]} />));
    expect(within(run('run-1')).getByText('1 running · 1 done · 0 failed')).toBeInTheDocument();
    const done = activity('final', 'swarm.snapshot', {
      ...hiveSnapshot,
      bees: hiveSnapshot.bees.map((bee) => Object.assign({}, bee, { status: 'done' })),
    });
    rerender(view(<HiveRows events={[...hiveEvents, done, closed(20000)]} />));
    expect(within(run('run-1')).getByText('0 running · 2 done · 0 failed')).toBeInTheDocument();
  });
});

describe('endedRuns', () => {
  it('ends a run once a turn settles or mu closes after its last word, and only then', () => {
    const at = (event: Activity, time: number): Activity => ({ ...event, at: time });
    const settled: Activity = { id: 'settled', at: 0, kind: 'agent_settled', payload: {} };
    const word = activity('snapshot-2', 'swarm.snapshot', hiveSnapshot, 'run-2');
    expect(endedRuns([at(word, 100)])).toEqual(new Set());
    expect(endedRuns([at(word, 100), at(settled, 200)])).toEqual(new Set(['run-2']));
    // The order the events arrive in does not matter, their time does.
    expect(endedRuns([at(settled, 200), at(word, 100)])).toEqual(new Set(['run-2']));
    expect(endedRuns([at(settled, 50), at(word, 100)])).toEqual(new Set());
  });
});
