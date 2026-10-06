import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import mu from '@/renderer/services/i18n/locales/en-US/mu.json';
import Hive from '@/renderer/pages/conversation/KyrnPanel/Hive';
import { onHiveFocus, requestHiveFocus } from '@/renderer/pages/conversation/KyrnPanel/focus';
import MessageToolGroupSummary from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';
import { activity, hiveEvents, hiveMessage, hiveSnapshot } from './hiveFixtures';

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

describe('Native Hive interaction', () => {
  it('shows named bees outside raw steps and sends a scoped click-through request', () => {
    const listener = vi.fn();
    const unsubscribe = onHiveFocus(listener);
    try {
      render(view(<MessageToolGroupSummary messages={[hiveMessage()]} />));
      fireEvent.click(screen.getByRole('button', { name: 'Inspect prefix-mutations' }));
      expect(listener).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        runId: 'run-1',
        beeName: 'prefix-mutations',
      });
      expect(screen.queryByText('View Steps · 1')).not.toBeInTheDocument();
      expect(screen.getByText('provider-cache')).toBeInTheDocument();
    } finally {
      unsubscribe();
    }
  });

  it('says who each sub-agent is and what it is doing, or what it said back', () => {
    const message = hiveMessage();
    message.content.update.rawOutput = {
      details: {
        snapshot: {
          ...hiveSnapshot,
          bees: [
            hiveSnapshot.bees[0],
            { ...hiveSnapshot.bees[1], said: 'Confirmed stable prefix.' },
            {
              name: 'late-one',
              status: 'failed',
              role: 'investigator',
              errorCode: 'stopped_by_user',
              error: 'stopped by the user',
            },
          ],
        },
      },
    };
    render(view(<MessageToolGroupSummary messages={[message]} />));

    const card = screen.getByTestId('swarm-tool-card');
    expect(within(card).getByText('1 active · 1 done / 3')).toBeInTheDocument();
    // Running: the tool it is on. Back: the first of what it reported. Stopped: why, in the app language.
    expect(within(card).getByText('read src/cache.ts')).toBeInTheDocument();
    expect(within(card).getByText('Confirmed stable prefix.')).toBeInTheDocument();
    expect(within(card).getByText('stopped by the user')).toBeInTheDocument();
    expect(within(card).getAllByText('investigator')).toHaveLength(3);
    // No raw payload anywhere on the card.
    expect(within(card).queryByText(/"status":/)).not.toBeInTheDocument();
  });

  it('keeps the original raw input/output available on demand', () => {
    render(view(<MessageToolGroupSummary messages={[hiveMessage()]} />));
    expect(screen.queryByText(/Original terminal evidence/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raw evidence' }));
    expect(screen.getByText(/Original terminal evidence/)).toHaveTextContent('Original terminal evidence');
    expect(screen.getByText(/Inspect changing request prefixes/)).toBeInTheDocument();
  });

  it('opens the selected bee context with the real current tool and completed output', () => {
    render(view(<Hive events={hiveEvents} />));
    // The records view has no map of its own (the tab draws it above): a bee is picked from a delivery's route.
    fireEvent.click(screen.getByRole('button', { name: 'prefix-mutations' }));
    const inspector = screen.getByRole('region', { name: 'Execution context' });
    expect(within(inspector).getByText('read src/cache.ts')).toBeInTheDocument();
    // Counts are plural-aware and the thinking level is a word, not pi's raw id.
    expect(within(inspector).getByText('3 turns · 6 tool calls · 1 shared · 0 received')).toBeInTheDocument();
    expect(within(inspector).getByText('test-model · High')).toBeInTheDocument();
    fireEvent.click(within(inspector).getByText('Assignment'));
    expect(within(inspector).getByText('Inspect changing request prefixes')).toBeInTheDocument();
    fireEvent.click(within(inspector).getByText('read'));
    expect(within(inspector).getByText('export const stablePrefix = true;')).toBeInTheDocument();
  });

  it('shows the run in miniature on its card: a dot per bee and the lines its latest notes went along', () => {
    const message = hiveMessage();
    message.content.update.rawOutput = {
      details: {
        snapshot: {
          ...hiveSnapshot,
          board: { latest: [{ bee: 'prefix-mutations', to: ['provider-cache'], text: 'Prefix is stable.' }] },
        },
      },
    };
    render(view(<MessageToolGroupSummary messages={[message]} />));
    const miniature = within(screen.getByTestId('swarm-tool-card')).getByTestId('hive-miniature');
    expect(miniature).toHaveAttribute('data-links', '1');
    expect(miniature.querySelectorAll('circle')).toHaveLength(2);
    expect(miniature.querySelectorAll('line')).toHaveLength(1);
    expect(miniature.textContent).toBe('');
  });

  it('waits for the requested run rather than opening a different run, then applies late data', () => {
    const focus = { conversationId: 'conversation-1', runId: 'run-2', beeName: 'provider-cache' };
    const { rerender } = render(view(<Hive events={hiveEvents} focus={focus} />));
    expect(screen.getByText('Waiting for this Hive’s recorded events.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Inspect prefix-mutations' })).not.toBeInTheDocument();
    rerender(
      view(<Hive events={[...hiveEvents, activity('other', 'swarm.snapshot', hiveSnapshot, 'run-2')]} focus={focus} />)
    );
    expect(screen.getByRole('region', { name: 'Execution context' })).toHaveTextContent('provider-cache');
  });

  it('keeps inspecting the selected run when a newer run arrives', () => {
    const { rerender } = render(view(<Hive events={hiveEvents} />));
    fireEvent.click(screen.getByRole('button', { name: 'prefix-mutations' }));
    const newer = activity(
      'newer',
      'swarm.snapshot',
      { ...hiveSnapshot, bees: [{ ...hiveSnapshot.bees[0], tool: { name: 'bash', summary: 'bash other-run' } }] },
      'run-2'
    );
    newer.at = 20000;
    rerender(view(<Hive events={[...hiveEvents, newer]} />));
    expect(screen.getByRole('region', { name: 'Execution context' })).toHaveTextContent('read src/cache.ts');
    expect(screen.queryByText('bash other-run')).not.toBeInTheDocument();
  });

  it('does not invent output when a tool has only started', () => {
    render(
      view(
        <Hive
          events={hiveEvents.filter((event) => event.id !== 'tool-end')}
          focus={{ conversationId: 'conversation-1', runId: 'run-1', beeName: 'prefix-mutations' }}
        />
      )
    );
    fireEvent.click(within(screen.getByRole('region', { name: 'Execution context' })).getByText('read'));
    expect(screen.getByText('Waiting for completed tool output.')).toBeInTheDocument();
    expect(screen.queryByText('export const stablePrefix = true;')).not.toBeInTheDocument();
  });

  it('ignores malformed focus events and unsubscribes without retaining a listener', () => {
    const listener = vi.fn();
    const unsubscribe = onHiveFocus(listener);
    window.dispatchEvent(new CustomEvent('kyrn:hive-focus', { detail: { conversationId: 12, runId: 'run-1' } }));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    requestHiveFocus({ conversationId: 'conversation-1', runId: 'run-1' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('leads a failed bee with a translated headline and keeps the raw error as a detail', () => {
    const failed = {
      ...hiveSnapshot,
      bees: [
        { ...hiveSnapshot.bees[0], status: 'failed', thinking: 'minimal', quietMs: 45_000, error: 'spawn ENOENT' },
      ],
    };
    render(
      view(
        <Hive
          events={[activity('snapshot', 'swarm.snapshot', failed)]}
          focus={{ conversationId: 'conversation-1', runId: 'run-1', beeName: 'prefix-mutations' }}
        />
      )
    );
    const inspector = screen.getByRole('region', { name: 'Execution context' });
    expect(within(inspector).getByText(common.kyrn.beeFailed)).toBeInTheDocument();
    expect(within(inspector).getByText('spawn ENOENT')).toBeInTheDocument();
    expect(within(inspector).getByText('No activity for 45 sec')).toBeInTheDocument();
    expect(within(inspector).getByText('test-model · Minimal')).toBeInTheDocument();
  });
});

const cardRow = (card: HTMLElement, name: string) => within(card).getByRole('button', { name: `Inspect ${name}` });
const avatarStatus = (element: HTMLElement) => element.querySelector('[data-status]')?.getAttribute('data-status');

describe('a sub-agent card whose call is over', () => {
  // A hive whose mu closed mid-run keeps its last snapshot, with two bees caught at work in it: the card said
  // "2 active" for good.
  const caughtMidRun = (status: 'in_progress' | 'failed') => {
    const message = hiveMessage();
    message.content.update.status = status;
    message.content.update.rawOutput = {
      details: {
        snapshot: {
          ...hiveSnapshot,
          bees: [
            hiveSnapshot.bees[0],
            hiveSnapshot.bees[1],
            { ...hiveSnapshot.bees[0], name: 'cache-keys', status: 'thinking', tool: undefined },
            { ...hiveSnapshot.bees[1], name: 'provider-docs' },
          ],
        },
      },
    };
    return message;
  };
  it('reads the bees caught at work as stopped, and counts what got done and what did not', () => {
    render(view(<MessageToolGroupSummary messages={[caughtMidRun('failed')]} />));
    const card = screen.getByTestId('swarm-tool-card');
    expect(within(card).getByText('2 done / 4 · 2 not finished')).toBeInTheDocument();
    expect(within(card).queryByText(/active/)).not.toBeInTheDocument();
    // Their lines say they stopped, not the tool they were on, and their avatars do not look busy.
    expect(within(card).queryByText('read src/cache.ts')).not.toBeInTheDocument();
    for (const name of ['prefix-mutations', 'cache-keys']) {
      expect(cardRow(card, name)).toHaveTextContent('Stopped');
      expect(avatarStatus(cardRow(card, name))).toBe('stopped');
    }
    expect(cardRow(card, 'provider-cache')).toHaveTextContent('Done');
    expect(avatarStatus(cardRow(card, 'provider-cache'))).toBe('done');
    // On the map in miniature a stopped bee's dot is hollow; a working one's is filled.
    const dots = [...within(card).getByTestId('hive-miniature').querySelectorAll('circle')];
    expect(dots.map((dot) => dot.getAttribute('data-filled'))).toEqual(['false', 'true', 'false', 'true']);
  });

  it('says a call cut off before any snapshot did not finish, and waits for nothing', () => {
    const message = hiveMessage();
    message.content.update.status = 'failed';
    message.content.update.rawOutput = undefined;
    message.content.update.content = [];
    render(view(<MessageToolGroupSummary messages={[message]} />));
    const card = screen.getByTestId('swarm-tool-card');
    expect(within(card).getByText(common.kyrn.hiveView.cutShort)).toBeInTheDocument();
    expect(cardRow(card, 'prefix-mutations')).toHaveTextContent(common.kyrn.hiveView.noRecord);
    expect(within(card).queryByText(common.kyrn.hiveView.pending)).not.toBeInTheDocument();
  });

  it('keeps what the bees are doing while the call runs', () => {
    render(view(<MessageToolGroupSummary messages={[caughtMidRun('in_progress')]} />));
    const card = screen.getByTestId('swarm-tool-card');
    expect(within(card).getByText('2 active · 2 done / 4')).toBeInTheDocument();
    expect(within(card).getByText('read src/cache.ts')).toBeInTheDocument();
    expect(avatarStatus(cardRow(card, 'prefix-mutations'))).toBe('tool');
    expect(avatarStatus(cardRow(card, 'cache-keys'))).toBe('thinking');
  });

  it('counts a call that finished with every bee done as done, with nothing left over', () => {
    const message = hiveMessage();
    message.content.update.status = 'completed';
    message.content.update.rawOutput = {
      details: {
        snapshot: { ...hiveSnapshot, bees: [{ ...hiveSnapshot.bees[0], status: 'done' }, hiveSnapshot.bees[1]] },
      },
    };
    render(view(<MessageToolGroupSummary messages={[message]} />));
    expect(within(screen.getByTestId('swarm-tool-card')).getByText('2 done / 2')).toBeInTheDocument();
  });
});
