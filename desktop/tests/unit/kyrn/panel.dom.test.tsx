import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import type { Activity, ActivityPage, Result } from '@/common/kyrn/types';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import mu from '@/renderer/services/i18n/locales/en-US/mu.json';
import {
  KernelBody,
  onHiveFocus,
  requestHiveFocus,
  useKyrnActivity,
  type KernelTab,
} from '@/renderer/pages/conversation/KyrnPanel';
import type { HiveFocusRequest } from '@/renderer/pages/conversation/KyrnPanel/focus';

const { activity, availableModels } = vi.hoisted(() => ({ activity: vi.fn(), availableModels: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { activity: { invoke: activity }, availableModels: { invoke: availableModels } },
  unwrap: (result: Result<ActivityPage>) => {
    if (!result.ok) throw new Error(result.error);
    return result.data;
  },
}));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { common, mu } } },
    interpolation: { escapeValue: false },
  });
});
beforeEach(() => {
  activity.mockResolvedValue({ ok: true, data: { sessionId: 'session', cursor: 0, more: false, events: [] } });
  // The models mu last reported, as the send box's picker names them.
  availableModels.mockResolvedValue({
    ok: true,
    data: {
      providers: [{ id: 'openai-codex', models: [{ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' }] }],
      thinkingLevels: [],
    },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>{children}</MemoryRouter>
    </I18nextProvider>
  );
}

/** One kernel tab of the work panel, reading its conversation's record as the panel does. */
function Kernel({
  tab,
  conversationId = 'conv',
  focus,
}: {
  tab: KernelTab;
  conversationId?: string;
  focus?: HiveFocusRequest;
}) {
  const read = useKyrnActivity(conversationId);
  return <KernelBody key={conversationId} tab={tab} conversationId={conversationId} activity={read} focus={focus} />;
}
const page = (events: Activity[]) => ({
  ok: true,
  data: { sessionId: 'session', cursor: events.length, more: false, events },
});

const snapshots: Activity[] = ['run-1', 'run-2'].map((run) => ({
  id: run,
  at: 1,
  kind: 'swarm.snapshot',
  run,
  payload: { title: run, bees: [{ name: 'reviewer', status: 'thinking', said: `${run} findings` }] },
}));

/** A sub-agent as a snapshot reports it: a reviewer on gpt-5, thinking high. */
const bee = (name: string, status: string, extra: Record<string, unknown> = {}) => ({
  name,
  status,
  role: 'reviewer',
  model: 'gpt-5',
  thinking: 'high',
  ...extra,
});

describe('the kernel tabs: entry and hive navigation', () => {
  it('exports the navigation API used by the work panel and removes listeners on unmount', () => {
    // Import the real panel entry: a mocked panel hid the missing-export startup crash.
    const listener = vi.fn();
    const stop = onHiveFocus(listener);
    try {
      requestHiveFocus({ conversationId: 'conv', runId: 'run-2', beeName: 'reviewer' });
      expect(listener).toHaveBeenCalledWith({ conversationId: 'conv', runId: 'run-2', beeName: 'reviewer' });
    } finally {
      stop();
    }
    requestHiveFocus({ conversationId: 'conv', runId: 'run-1' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed navigation events', () => {
    const listener = vi.fn();
    const stop = onHiveFocus(listener);
    try {
      for (const detail of [null, {}, { conversationId: 'conv', runId: 3 }]) {
        window.dispatchEvent(new CustomEvent('kyrn:hive-focus', { detail }));
      }
      expect(listener).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('waits quietly for the record, and never shows one conversation’s record in another', async () => {
    let resolve!: (value: Result<ActivityPage>) => void;
    activity.mockReturnValueOnce(
      new Promise<Result<ActivityPage>>((done) => {
        resolve = done;
      })
    );
    const { rerender } = render(<Kernel tab='hive' />, { wrapper: Wrapper });
    expect(screen.getByText(common.loading)).toBeInTheDocument();
    resolve(page(snapshots) as Result<ActivityPage>);
    expect(await screen.findByText('run-2 findings')).toBeVisible();

    // Another conversation: its own read starts, and the first one's sub-agents are gone at once.
    activity.mockReturnValueOnce(new Promise<Result<ActivityPage>>(() => undefined));
    rerender(<Kernel tab='hive' conversationId='other' />);
    expect(screen.queryByText('run-2 findings')).not.toBeInTheDocument();
    expect(screen.getByText(common.loading)).toBeInTheDocument();
    expect(activity).toHaveBeenLastCalledWith({ conversationId: 'other', cursor: 0, sessionId: '' });
  });

  it('opens only the requested run and bee after activity arrives', async () => {
    let resolve!: (value: Result<ActivityPage>) => void;
    activity.mockReturnValueOnce(
      new Promise<Result<ActivityPage>>((done) => {
        resolve = done;
      })
    );
    const { container } = render(
      <Kernel tab='hive' focus={{ conversationId: 'conv', runId: 'run-2', beeName: 'reviewer' }} />,
      { wrapper: Wrapper }
    );
    resolve(page(snapshots) as Result<ActivityPage>);

    // Its words once, on its row, which is open from the first frame.
    expect(await screen.findByText('run-2 findings')).toBeVisible();
    const row = (run: string) =>
      within(container.querySelector(`[data-hive-run="${run}"]`) as HTMLElement).getByRole('button', {
        expanded: run === 'run-2',
      });
    expect(row('run-2')).toHaveAttribute('aria-expanded', 'true');
    expect(row('run-1')).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the board tab on its gauges: above the board, and outside what scrolls', async () => {
    activity.mockResolvedValue(
      page([
        { id: 'c', at: 1, kind: 'context.usage', payload: { usage: { tokens: 50_000, contextWindow: 200_000 } } },
        { id: 'u', at: 2, kind: 'turn.usage', payload: { input: 100, output: 5, cacheRead: 300, cacheWrite: 0 } },
      ])
    );
    render(<Kernel tab='board' />, { wrapper: Wrapper });
    const board = await screen.findByTestId('mu-board');
    const gauges = screen.getByTestId('mu-gauges');
    expect(gauges.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(board.closest('.overflow-y-auto')?.contains(gauges)).toBe(false);
    expect(screen.getByTestId('mu-gauge-context-value')).toHaveTextContent('25%');
    expect(screen.getByTestId('mu-gauge-cache-value')).toHaveTextContent('75%');
  });

  it('keeps the gauges in place while the record is still on its way', () => {
    activity.mockReturnValueOnce(new Promise<Result<ActivityPage>>(() => undefined));
    render(<Kernel tab='board' />, { wrapper: Wrapper });
    expect(screen.getByTestId('mu-gauges')).toBeInTheDocument();
    expect(screen.getByText(common.loading)).toBeInTheDocument();
  });

  it('keeps the tab usable when activity loading fails', async () => {
    activity.mockRejectedValueOnce(new Error('fixture offline'));
    render(<Kernel tab='judge' />, { wrapper: Wrapper });
    // A translated headline leads; the bridge's own message follows as a detail, without the "Error:" prefix.
    expect(await screen.findByText(common.kyrn.activityLoadFailed)).toBeVisible();
    expect(screen.getByText('fixture offline')).toBeVisible();
    expect(screen.queryByText('Error: fixture offline')).not.toBeInTheDocument();
    expect(screen.getByTestId('judge-context-toggle')).toBeInTheDocument();
  });

  it('lists every sub-agent on one row: name, role, model and thinking level, what it does, and the run’s counts', async () => {
    activity.mockResolvedValue(
      page([
        {
          id: 'run-1',
          at: 1,
          kind: 'swarm.snapshot',
          run: 'run-1',
          payload: {
            kind: 'hive',
            title: 'Why do the tests flake?',
            bees: [
              bee('scout', 'tool', { tool: { name: 'bash', summary: 'bash npm test' } }),
              bee('worker', 'thinking', { said: 'The retry hides the race.' }),
              bee('critic', 'done', { said: 'The fix holds.' }),
              bee('fixer', 'failed', { error: 'ENOENT: no such file' }),
            ],
          },
        },
      ])
    );
    const { container } = render(<Kernel tab='hive' />, { wrapper: Wrapper });

    expect(await screen.findByText('Why do the tests flake?')).toBeVisible();
    expect(screen.getByText('2 running · 1 done · 1 failed')).toBeVisible();
    const rows = [...container.querySelectorAll('[data-bee]')].map((row) => row.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('scout');
    expect(rows[0]).toContain('reviewer');
    expect(rows[0]).toContain('gpt-5 · High');
    expect(rows[0]).toContain('bash npm test');
    // A thinking level is said beside the model, never as what the sub-agent is doing.
    expect(rows[1]).toContain('The retry hides the race.');
    expect(rows[1].match(/High/g)).toHaveLength(1);
    expect(rows[2]).toContain('The fix holds.');
    expect(rows[3]).toContain('ENOENT: no such file');
  });

  it('gives a row’s task its own line, and its role in full and its model by name after what it does', async () => {
    activity.mockResolvedValue(
      page([
        {
          id: 'run-1',
          at: 1,
          kind: 'swarm.snapshot',
          run: 'run-1',
          payload: {
            kind: 'delegate',
            title: '2 tasks',
            bees: [
              bee('Audit how the swarm isolates bees and recovers from failure', 'done', {
                role: 'investigator',
                model: 'openai-codex/gpt-5.6-terra',
              }),
              bee('Study when many agents beat one', 'tool', {
                role: 'investigator',
                model: 'relay/custom-7b',
                thinking: '',
                tool: { name: 'bash', summary: 'bash rg -n swarm packages' },
              }),
            ],
          },
        },
      ])
    );
    const { container } = render(<Kernel tab='hive' />, { wrapper: Wrapper });
    await waitFor(() => expect(container.querySelectorAll('[data-bee]')).toHaveLength(2));
    const [audit, study] = [...container.querySelectorAll<HTMLElement>('[data-bee]')];

    // The model by the name the send box gives it, once the names are read; never its raw provider/id.
    expect(await within(audit).findByText('investigator · GPT-5.6 Terra · High')).toBeVisible();
    expect(audit.textContent).not.toContain('openai-codex/');
    // A model mu did not report goes by its id, without the provider.
    expect(within(study).getByTestId('hive-row-who')).toHaveTextContent(/^investigator · custom-7b$/);

    // The task alone on its line, whole on hover; who it is sits on the line of what it does.
    const task = within(audit).getByTestId('hive-row-task');
    expect(task).toHaveTextContent(/^Audit how the swarm isolates bees and recovers from failure$/);
    expect(task).toHaveAttribute('title', 'Audit how the swarm isolates bees and recovers from failure');
    const who = within(audit).getByTestId('hive-row-who');
    expect(task.contains(who)).toBe(false);
    expect(who.previousElementSibling).toHaveTextContent(new RegExp(`^${common.kyrn.beeStatus.done}$`));
  });

  it('cuts only the task to fit: who the sub-agent is wraps instead', () => {
    const css = readFileSync(
      join(__dirname, '../../../packages/desktop/src/renderer/pages/conversation/KyrnPanel/Hive/Hive.module.css'),
      'utf8'
    );
    const rule = (selector: string) => {
      const start = css.indexOf(`\n${selector} {`);
      return start < 0 ? '' : css.slice(start, css.indexOf('\n}', start));
    };
    expect(rule('.rowName')).toContain('text-overflow: ellipsis');
    // The row is a button, whose text does not wrap unless told to.
    expect(rule('.rowWho')).toContain('white-space: normal');
    expect(rule('.rowWho')).not.toContain('text-overflow');
    expect(rule('.rowStatus')).toContain('flex-wrap: wrap');
  });

  it('words a bee in the app language: plural counts, thinking level, silence and error', async () => {
    const reviewer = {
      name: 'reviewer',
      status: 'failed',
      model: 'gpt-5',
      thinking: 'xhigh',
      turns: 1,
      toolCalls: 2,
      published: 0,
      received: 1,
      quietMs: 312_000,
      error: 'ENOENT: no such file',
    };
    activity.mockResolvedValue(
      page([
        { id: 'run-1', at: 1, kind: 'swarm.snapshot', run: 'run-1', payload: { title: 'run-1', bees: [reviewer] } },
      ])
    );
    render(<Kernel tab='hive' focus={{ conversationId: 'conv', runId: 'run-1', beeName: 'reviewer' }} />, {
      wrapper: Wrapper,
    });

    expect(await screen.findByText('1 turn · 2 tool calls · 0 shared · 1 received')).toBeVisible();
    expect(screen.getByText('gpt-5 · Very high')).toBeVisible();
    expect(screen.getByText('No activity for 5 min, 12 sec')).toBeVisible();
    expect(screen.getByText(common.kyrn.beeFailed)).toBeVisible();
    // Why it failed is said once, on its row; the row it opened to only says that it failed.
    expect(screen.getByText('ENOENT: no such file')).toBeVisible();
  });

  it('says there are no sub-agents yet, rather than showing an empty list', async () => {
    render(<Kernel tab='hive' />, { wrapper: Wrapper });
    expect(await screen.findByText(common.kyrn.hiveView.none)).toBeVisible();
  });

  it('names each judgment by its question and each runtime event in words, beside its code', async () => {
    activity.mockResolvedValue(
      page([
        { id: 'recall', at: 1, kind: 'decision', payload: { specId: 'memory.recall', outcome: { apply: [] } } },
        { id: 'odd', at: 2, kind: 'decision', payload: { specId: 'memory.future', outcome: 'x' } },
        {
          id: 'board',
          at: 3,
          kind: 'board.switched',
          payload: { on: false, cwd: '/p', model: null, modelChosen: false },
        },
        { id: 'later', at: 4, kind: 'future.event', payload: { score: 0.5 } },
      ])
    );
    render(<Kernel tab='judge' />, { wrapper: Wrapper });

    await screen.findAllByTestId('judge-line');
    const lines = screen.getAllByTestId('judge-line');
    expect(lines.map((line) => line.getAttribute('data-code'))).toEqual([
      'memory.recall',
      'memory.future',
      'board.switched',
      'future.event',
    ]);
    expect(lines[0]).toHaveTextContent(common.kyrn.judgeView.questions.recall);
    expect(lines[1]).toHaveTextContent(common.kyrn.judgeView.questions.other);
    // The board says how it stands: the harness reports it each time it starts.
    expect(lines[2]).toHaveTextContent(common.kyrn.eventLine.board.off);
    // An event this build does not know goes by its code, with its score.
    expect(lines[3]).toHaveTextContent('future.event · 0.50');
  });

  it('sums up coded runtime events in the app language above their raw payload', async () => {
    activity.mockResolvedValue(
      page([
        {
          id: 'mcp',
          at: 1,
          kind: 'mcp.failed',
          payload: { name: 'github', code: 'timeout', reason: 'no answer within 30000 ms' },
        },
        {
          id: 'goal',
          at: 2,
          kind: 'goal.state',
          payload: {
            status: 'paused',
            text: 'ship the release',
            reason: 'english reason',
            reasonCode: 'idle',
            reasonParams: { runs: 2 },
          },
        },
        { id: 'rule', at: 3, kind: 'ttsr.interrupted', payload: { text: 'a rule as written' } },
      ])
    );
    render(<Kernel tab='judge' />, { wrapper: Wrapper });

    await screen.findAllByTestId('judge-line');
    const [mcp, goal, rule] = screen.getAllByTestId('judge-line');
    expect(mcp).toHaveTextContent("github: it didn't respond in time");
    fireEvent.click(within(mcp).getByRole('button'));
    expect(within(mcp).getByText('Details: no answer within 30000 ms')).toBeVisible();
    // The raw payload stays under the summary, as it came.
    expect(within(mcp).getByText(/"code": "timeout"/)).toBeInTheDocument();

    fireEvent.click(within(goal).getByRole('button'));
    expect(within(goal).getByText('ship the release')).toBeVisible();
    expect(within(goal).getByText('Paused: the agent ended 2 runs in a row without doing anything')).toBeVisible();

    // A kind without codes keeps the generic summary.
    expect(rule).toHaveTextContent(`${common.kyrn.event.ttsr.interrupted} · a rule as written`);
    await waitFor(() => expect(activity).toHaveBeenCalled());
  });
});
