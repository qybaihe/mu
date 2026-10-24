import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import type { Activity, ActivityPage, Result } from '@/common/kyrn/types';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import { KernelBody, useKyrnActivity } from '@/renderer/pages/conversation/KyrnPanel';
import Board from '@/renderer/pages/conversation/KyrnPanel/Board';
import {
  ACCOUNT_LIMIT,
  boardAccount,
  boardState,
  boardStateKey,
  boardView,
  toBoardNote,
  toBoardUpdate,
  type BoardUpdate,
} from '@/renderer/pages/conversation/KyrnPanel/Board/board';
import { emitter, type SendBoxCommandState } from '@/renderer/utils/emitter';

const { activity } = vi.hoisted(() => ({ activity: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { activity: { invoke: activity } },
  unwrap: (result: Result<ActivityPage>) => {
    if (!result.ok) throw new Error(result.error);
    return result.data;
  },
}));

const i18n = createInstance();
beforeAll(async () => {
  // German with the English texts: what changes is only how numbers are written.
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { common } }, 'de-DE': { translation: { common } } },
    interpolation: { escapeValue: false },
  });
});
const page = (events: Activity[]) => ({
  ok: true,
  data: { sessionId: 'session', cursor: events.length, more: false, events },
});
beforeEach(() => activity.mockResolvedValue(page([])));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  emitter.removeAllListeners();
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>{children}</MemoryRouter>
    </I18nextProvider>
  );
}

let next = 0;
const event = (kind: string, payload: Record<string, unknown>): Activity => ({
  id: `e${++next}`,
  at: next,
  kind,
  payload,
});
const switched = (on: boolean) => event('board.switched', { on, cwd: '/work/app' });
const update = (payload: Record<string, unknown> = {}) =>
  event('board.update', {
    progress: 'The login page works; the tests for it are half written.',
    now: 'Writing the tests for the login page',
    confirm: [],
    phase: 'checking',
    needsUser: false,
    done: 3,
    total: 5,
    by: 'model',
    ended: false,
    ...payload,
  });

const showBoard = (events: Activity[]) => render(<Board events={events} conversationId='conv' />, { wrapper: Wrapper });

describe('reading the board from the session’s events', () => {
  it('follows the last switch and the last board, in the order they came', () => {
    expect(boardView([])).toEqual({ known: false, on: undefined });
    const first = update();
    const last = update({ now: 'Wrapping up', restored: true });
    const view = boardView([switched(true), first, switched(false), switched(true), last]);
    expect(view.on).toBe(true);
    expect(view.update).toMatchObject({ id: last.id, now: 'Wrapping up', restored: true });
    expect(boardView([switched(true), first, switched(false)]).on).toBe(false);
    // A board from a harness whose switch was not seen means the board is on.
    expect(boardView([first]).on).toBe(true);
  });

  it('keeps only what it can show: known stages, text lines, counts that add up', () => {
    expect(
      toBoardUpdate(
        update({ phase: 'celebrating', confirm: ['  Keep the old API?  ', 7, ''], done: 9, total: 4, by: 'x' })
      )
    ).toMatchObject({ confirm: ['Keep the old API?'], done: 4, total: 4, by: 'model', needsUser: false });
    expect(toBoardUpdate(update({ phase: 'celebrating' }))?.phase).toBeUndefined();
    expect(toBoardUpdate(update({ now: '', progress: '' }))).toBeUndefined();
    expect(toBoardUpdate(update({ now: 'x'.repeat(2000) }))?.now).toHaveLength(601);
  });
});

describe('the one state the board’s header shows', () => {
  const state = (payload: Record<string, unknown>) => boardState(toBoardUpdate(update(payload)) as BoardUpdate);

  it('shows a working run’s stage, and nothing when it names none', () => {
    expect(state({ phase: 'changing' })).toEqual({ ended: false, phase: 'changing' });
    expect(state({ phase: 'wrapping_up', done: 3, total: 3 })).toEqual({ ended: false, phase: 'wrapping_up' });
    expect(state({ phase: undefined })).toBeUndefined();
  });

  it('reads a run that stopped while wrapping up, or with every check done, as done', () => {
    // The QA case: "wrapping up" and "stopped" side by side over a run whose three checks were all done.
    expect(state({ ended: true, phase: 'wrapping_up', done: 3, total: 3 })).toEqual({ ended: true, outcome: 'done' });
    expect(state({ ended: true, phase: 'wrapping_up', done: 0, total: 0 })).toEqual({ ended: true, outcome: 'done' });
    expect(state({ ended: true, phase: 'checking', done: 5, total: 5 })).toEqual({ ended: true, outcome: 'done' });
    // Done wins over a question asked at the end.
    expect(state({ ended: true, phase: 'waiting', needsUser: true, done: 2, total: 2 })).toEqual({
      ended: true,
      outcome: 'done',
    });
  });

  it('reads a run that stopped to ask the person as waiting, and any other as stopped', () => {
    expect(state({ ended: true, phase: 'waiting', done: 1, total: 3 })).toEqual({ ended: true, outcome: 'waiting' });
    expect(state({ ended: true, phase: 'fixing', needsUser: true })).toEqual({ ended: true, outcome: 'waiting' });
    expect(state({ ended: true, phase: 'checking', done: 3, total: 5 })).toEqual({ ended: true, outcome: 'stopped' });
    expect(state({ ended: true, phase: 'stuck', done: 0, total: 0 })).toEqual({ ended: true, outcome: 'stopped' });
    expect(state({ ended: true, phase: undefined, done: 0, total: 0 })).toEqual({ ended: true, outcome: 'stopped' });
  });

  it('words each state with the board’s own texts', () => {
    expect(boardStateKey({ ended: false, phase: 'stuck' })).toBe('phases.stuck');
    expect(boardStateKey({ ended: true, outcome: 'done' })).toBe('done');
    expect(boardStateKey({ ended: true, outcome: 'waiting' })).toBe('phases.waiting');
    expect(boardStateKey({ ended: true, outcome: 'stopped' })).toBe('ended');
  });
});

describe('the board panel', () => {
  it('when off, says what it does and what it costs, and turns on with the harness’s own command', () => {
    const sent = vi.fn();
    emitter.on('sendbox.command', sent);
    showBoard([switched(false)]);
    const off = screen.getByTestId('mu-board-off');
    expect(off).toHaveTextContent('Each update costs one model call');
    // The switch is the one control: no second button for the same thing.
    expect(within(off).queryByRole('button')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-board-switch'));
    expect(sent).toHaveBeenCalledWith('/board on', 'conv', expect.any(Function));
    expect(screen.getByTestId('mu-board-switch')).toBeDisabled();
    expect(screen.getByText('Switching…')).toBeInTheDocument();
  });

  it('offers nothing where the harness never said it has a board: another agent, or the feature off', () => {
    const sent = vi.fn();
    emitter.on('sendbox.command', sent);
    showBoard([]);
    expect(screen.getByTestId('mu-board-unknown')).toHaveTextContent('Core features');
    expect(screen.queryByTestId('mu-board-off')).not.toBeInTheDocument();
    expect(screen.getByTestId('mu-board-switch')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mu-board-switch'));
    expect(sent).not.toHaveBeenCalled();
  });

  it('while the agent works, says the switch waits for the step to end, and frees it when dropped', () => {
    let heard: ((state: SendBoxCommandState) => void) | undefined;
    emitter.on('sendbox.command', (_command: string, _target: string, reply?: (state: SendBoxCommandState) => void) => {
      heard = reply;
    });
    showBoard([switched(true), update()]);
    fireEvent.click(screen.getByTestId('mu-board-switch'));
    act(() => heard?.('waiting'));
    expect(screen.getByTestId('mu-board-pending')).toHaveTextContent('Switches when the agent finishes this step');
    expect(screen.getByTestId('mu-board-switch')).toBeDisabled();
    act(() => heard?.('dropped'));
    expect(screen.queryByTestId('mu-board-pending')).not.toBeInTheDocument();
    expect(screen.getByTestId('mu-board-switch')).not.toBeDisabled();
  });

  it('when on with nothing yet, says so plainly, with no spinner', () => {
    showBoard([switched(true)]);
    expect(screen.getByTestId('mu-board-empty')).toHaveTextContent('Give the agent a moment');
    expect(document.querySelector('.arco-spin')).toBeNull();
  });

  it('shows the stage, what is done now, how far it is, and what needs the person', () => {
    const quoted = vi.fn();
    emitter.on('sendbox.reply', quoted);
    showBoard([
      switched(true),
      update({ needsUser: true, confirm: ['Keep the old login URL working?', 'Drop Internet Explorer support?'] }),
    ]);
    expect(screen.getByTestId('mu-board-state')).toHaveTextContent('Checking the work');
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('Writing the tests for the login page');
    expect(screen.getByTestId('mu-board-progress')).toHaveTextContent('half written');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
    expect(screen.getByText('3 of 5 checks done')).toBeInTheDocument();

    const ask = screen.getByTestId('mu-board-ask');
    expect(ask).toHaveTextContent('Needs you');
    fireEvent.click(within(ask).getByText('Drop Internet Explorer support?'));
    // Quoted into the reply, never sent.
    expect(quoted).toHaveBeenCalledWith(expect.objectContaining({ content: 'Drop Internet Explorer support?' }));
  });

  it('counts a single acceptance item in the singular', () => {
    showBoard([switched(true), update({ done: 0, total: 1 })]);
    expect(screen.getByText('0 of 1 check done')).toBeInTheDocument();
  });

  it('writes the counts in the app language', async () => {
    await i18n.changeLanguage('de-DE');
    try {
      showBoard([switched(true), update({ done: 1000, total: 1234 })]);
      expect(screen.getByText('1.000 of 1.234 checks done')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', '1.000 of 1.234 checks done');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('marks a board written by rules, and a stuck agent with a hollow dot', () => {
    showBoard([switched(true), update({ by: 'rules', phase: 'stuck', total: 0, done: 0 })]);
    expect(screen.getByText('Brief')).toBeInTheDocument();
    const state = screen.getByTestId('mu-board-state');
    expect(state).toHaveTextContent('Seems stuck');
    expect(state).toHaveAttribute('data-state', 'working');
    expect(state.querySelector('[data-mark]')).toHaveAttribute('data-mark', 'hollow');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mu-board-ask')).not.toBeInTheDocument();
  });

  it('shows a finished run as done, with no stage and no second state beside it', () => {
    showBoard([
      switched(true),
      update({ ended: true, phase: 'wrapping_up', done: 3, total: 3, now: 'The task is over; the summary is out.' }),
    ]);
    const state = screen.getByTestId('mu-board-state');
    expect(state).toHaveTextContent(/^Done$/);
    expect(state).toHaveAttribute('data-state', 'done');
    expect(state.querySelector('[data-mark]')).toHaveAttribute('data-mark', 'tick');
    expect(screen.queryByText('Wrapping up')).not.toBeInTheDocument();
    expect(screen.queryByText('Stopped')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('mu-board-state')).toHaveLength(1);
  });

  it('shows a run that stopped to ask as waiting, and one that stopped part way as stopped', () => {
    const { unmount } = showBoard([switched(true), update({ ended: true, phase: 'checking', needsUser: true })]);
    expect(screen.getByTestId('mu-board-state')).toHaveTextContent(/^Waiting for you$/);
    expect(screen.queryByText('Checking the work')).not.toBeInTheDocument();
    unmount();

    showBoard([switched(true), update({ ended: true, phase: 'stuck', done: 2, total: 5 })]);
    const state = screen.getByTestId('mu-board-state');
    expect(state).toHaveTextContent(/^Stopped$/);
    expect(state.querySelector('[data-mark]')).toHaveAttribute('data-mark', 'dash');
    expect(screen.queryByText('Seems stuck')).not.toBeInTheDocument();
  });

  it('reads out a run that finished as done, not as its last stage', () => {
    const events = [switched(true)];
    const { rerender } = showBoard(events);
    rerender(
      <Board
        events={[...events, update({ ended: true, phase: 'wrapping_up', done: 5, total: 5, progress: 'All done.' })]}
        conversationId='conv'
      />
    );
    const parts = [...screen.getByTestId('mu-board-announce').querySelectorAll('p')].map((part) => part.textContent);
    expect(parts).toEqual(['Done', 'Writing the tests for the login page', 'All done.']);
  });

  it('reads out and fades in a board that comes while it is open, through a live region that stays in place', () => {
    const events = [switched(true)];
    const { rerender } = showBoard(events);
    const live = screen.getByTestId('mu-board-announce');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toBeEmptyDOMElement();

    const first = update();
    rerender(<Board events={[...events, first]} conversationId='conv' />);
    expect(screen.getByTestId('mu-board-announce')).toBe(live);
    // One paragraph per part, no English full stop glued between them: the model's lines bring their own.
    const parts = () => [...live.querySelectorAll('p')].map((part) => part.textContent);
    expect(parts()).toEqual([
      'Checking the work',
      'Writing the tests for the login page',
      'The login page works; the tests for it are half written.',
    ]);
    expect(document.querySelector('[data-fresh="true"]')).not.toBeNull();

    rerender(
      <Board events={[...events, first, update({ now: 'Wrapping up', phase: 'wrapping_up' })]} conversationId='conv' />
    );
    expect(screen.getByTestId('mu-board-announce')).toBe(live);
    expect(parts()).toEqual(['Wrapping up', 'Wrapping up', 'The login page works; the tests for it are half written.']);
  });

  it('neither reads out nor fades in the board already there, or the one replayed as the session opens', () => {
    const { unmount } = showBoard([switched(true), update()]);
    expect(screen.getByTestId('mu-board-announce')).toBeEmptyDOMElement();
    expect(document.querySelector('[data-fresh="true"]')).toBeNull();
    unmount();

    const events = [switched(true)];
    const { rerender } = showBoard(events);
    rerender(<Board events={[...events, update({ restored: true })]} conversationId='conv' />);
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('Writing the tests');
    expect(screen.getByTestId('mu-board-announce')).toBeEmptyDOMElement();
    expect(document.querySelector('[data-fresh="true"]')).toBeNull();
  });

  it('turns off from its switch, with the harness’s own command', () => {
    const sent = vi.fn();
    emitter.on('sendbox.command', sent);
    showBoard([switched(true), update()]);
    fireEvent.click(screen.getByTestId('mu-board-switch'));
    expect(sent).toHaveBeenCalledWith('/board off', 'conv', expect.any(Function));
  });
});

/** A time of day, which the account's clock writes 24-hour and to the second. */
const time = (hours: number, minutes: number, seconds: number) =>
  new Date(2026, 8, 23, hours, minutes, seconds).getTime();
const START = time(14, 0, 0);

let counter = 0;
/** One line of the account as the harness sends it: a fixed line, a second after the one before, unless told. */
const noteOf = (fields: Record<string, unknown> = {}): Record<string, unknown> => {
  counter += 1;
  return { sequence: counter, at: START + counter * 1000, kind: 'step', text: 'Ran npm test', by: 'rules', ...fields };
};
const note = (fields: Record<string, unknown> = {}) => event('board.note', noteOf(fields));
const lines = () => screen.getAllByTestId('mu-board-note');
/** What each line says, newest first, without its time. */
const texts = () => lines().map((row) => row.lastElementChild?.textContent);
const readOut = () =>
  [...screen.getByTestId('mu-board-announce').querySelectorAll('p')].map((part) => part.textContent);

describe('the account before the first board', () => {
  it('shows the lines alone, without asking for a moment more', () => {
    showBoard([switched(true), note({ text: 'Changed src/a.ts', code: 'changed_file', params: { file: 'src/a.ts' } })]);
    expect(screen.queryByTestId('mu-board-empty')).not.toBeInTheDocument();
    expect(texts()).toEqual(['Changed src/a.ts']);
  });
});

describe('reading the account from the session’s events', () => {
  it('takes a note as the harness sent it, and drops one without its text or its time', () => {
    expect(
      toBoardNote(
        note({
          sequence: 4,
          at: 1_000,
          kind: 'check',
          text: '  A check failed: npm test  ',
          code: 'check_failed',
          params: { command: 'npm test' },
          failed: true,
        })
      )
    ).toEqual({
      id: '1000:4',
      sequence: 4,
      at: 1_000,
      kind: 'check',
      text: 'A check failed: npm test',
      by: 'rules',
      code: 'check_failed',
      params: { command: 'npm test' },
      failed: true,
      restored: false,
    });
    expect(toBoardNote(note({ text: '  ' }))).toBeUndefined();
    expect(toBoardNote(note({ at: undefined }))).toBeUndefined();
    expect(toBoardNote(note({ at: 'this morning' }))).toBeUndefined();
    expect(toBoardNote(note({ text: 'x'.repeat(2000) }))?.text).toHaveLength(601);
  });

  it('keeps only what it can use: known kinds, a code on a fixed line, params that are words or numbers', () => {
    const odd = toBoardNote(
      note({
        sequence: -1,
        kind: 'celebrated',
        by: 'someone',
        code: 'changed_file',
        params: { file: 'a.ts', 'two words': 'x', nested: { a: 1 }, count: Number.NaN, round: 2 },
        failed: 'yes',
      })
    );
    expect(odd).toMatchObject({ sequence: 0, by: 'model', failed: false, params: { file: 'a.ts', round: 2 } });
    expect(odd?.kind).toBeUndefined();
    // A code names one of the harness's fixed sentences: the model's own words have none.
    expect(odd?.code).toBeUndefined();
  });

  it('merges the notes and the last board’s log by identity, the later one winning, oldest first', () => {
    const changed = noteOf({ sequence: 1, at: 5_000, text: 'Changed a.ts' });
    const looked = noteOf({ sequence: 2, at: 5_000, code: 'looked', params: { count: 2 }, text: 'Looked at 2' });
    const ran = noteOf({ sequence: 3, at: 4_000, text: 'Ran npm test' });
    const account = boardAccount([
      update({ log: [noteOf({ sequence: 9, at: 1_000, text: 'Only in an older log' })] }),
      event('board.note', changed),
      update({ log: [changed, looked] }),
      event('board.note', { ...looked, params: { count: 6 }, text: 'Looked at 6' }),
      event('board.note', ran),
      update({ now: 'A board without a log' }),
    ]);
    expect(account.map((line) => line.text)).toEqual(['Ran npm test', 'Changed a.ts', 'Looked at 6']);
  });

  it('keeps the newest lines when there are more than it holds', () => {
    const account = boardAccount(
      Array.from({ length: ACCOUNT_LIMIT + 5 }, (_, index) =>
        event('board.note', noteOf({ sequence: index + 1, at: 10_000 + index, text: `Step ${index + 1}` }))
      )
    );
    expect(account).toHaveLength(ACCOUNT_LIMIT);
    expect(account[0].text).toBe('Step 6');
  });

  it('reads the log a board carries, and takes a note alone as a board that is on', () => {
    const log = [noteOf({ text: 'Changed a.ts' }), { text: 'no time' }, 'not a note'];
    expect(toBoardUpdate(update({ restored: true, log }))?.log).toEqual([
      expect.objectContaining({ text: 'Changed a.ts', restored: true }),
    ]);
    expect(toBoardUpdate(update())?.log).toBeUndefined();
    expect(boardView([note()])).toEqual({ known: true, on: true });
  });
});

describe('the account under the board', () => {
  it('lists what the agent did under the board, newest first, each line at its time', () => {
    showBoard([
      switched(true),
      update(),
      note({ at: time(14, 3, 22), text: 'Changed src/login.ts' }),
      note({ at: time(14, 7, 45), by: 'model', kind: 'said', text: 'The session cookie expires too soon.' }),
      note({ at: time(14, 5, 1), text: 'Ran npm test' }),
    ]);
    const account = screen.getByTestId('mu-board-account');
    expect(account).toHaveTextContent('What it did');
    expect(screen.getByTestId('mu-board-current').compareDocumentPosition(account)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    // The board model's own words stand apart from the harness's fixed lines.
    expect(lines().map((row) => [row.querySelector('time')?.textContent, row.getAttribute('data-by')])).toEqual([
      ['14:07:45', 'model'],
      ['14:05:01', 'rules'],
      ['14:03:22', 'rules'],
    ]);
  });

  it('marks a line where something went wrong with a hollow dot, not a colour', () => {
    showBoard([switched(true), note({ text: 'A check failed: npm test', failed: true }), note()]);
    const [ran, failed] = lines();
    expect(failed).toHaveAttribute('data-failed', 'true');
    expect(failed.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(ran.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('shows no account while the board is off', () => {
    showBoard([switched(true), note(), switched(false)]);
    expect(screen.queryByTestId('mu-board-account')).not.toBeInTheDocument();
  });

  it('words a fixed line in the app’s language from its code and params, whatever language the harness wrote', () => {
    showBoard([
      switched(true),
      note({ code: 'changed_file', params: { file: 'src/login.ts' }, text: '改了 src/login.ts' }),
      note({ code: 'looked', params: { count: 1 }, text: '看了 1 个文件或地方' }),
      note({ code: 'helpers_sent', params: { count: 2, titles: 'tests, docs' }, text: '派出 2 个助手：tests, docs' }),
      note({ code: 'goal_round', params: { round: 2, reason: ': the login test fails' }, text: '目标还没达成' }),
      note({ code: 'ended', text: '停下来了。' }),
    ]);
    expect(texts()).toEqual([
      'Stopped.',
      "The goal isn't met yet; mu sent the agent back to work (round 2): the login test fails",
      'Started 2 subagents: tests, docs',
      'Looked at 1 file or place',
      'Changed src/login.ts',
    ]);
  });

  it('keeps the harness’s sentence for a code it does not know or params that do not fit, and the model’s words', () => {
    showBoard([
      switched(true),
      note({ code: 'tidied_up', params: { what: 'imports' }, text: 'Tidied up the imports' }),
      note({ code: 'changed_file', params: {}, text: '改了 a.ts' }),
      note({ code: 'looked', params: { count: 'three' }, text: '看了三个文件' }),
      note({ by: 'model', code: 'changed_file', params: { file: 'b.ts' }, text: 'It moved the check into b.ts.' }),
    ]);
    expect(texts()).toEqual(['It moved the check into b.ts.', '看了三个文件', '改了 a.ts', 'Tidied up the imports']);
  });

  it('writes a fixed line’s counts in the app language', async () => {
    await i18n.changeLanguage('de-DE');
    try {
      showBoard([switched(true), note({ code: 'looked', params: { count: 1234 }, text: 'Looked at 1234' })]);
      expect(texts()).toEqual(['Looked at 1.234 files or places']);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('changes a line the harness sends again where it stands, without fading it in; a new line fades in', () => {
    const looked = noteOf({ code: 'looked', params: { count: 3 }, text: 'Looked at 3 files or places' });
    const events = [switched(true), update(), event('board.note', looked)];
    const { rerender } = showBoard(events);
    const row = lines()[0];
    rerender(
      <Board
        events={[
          ...events,
          note(),
          event('board.note', { ...looked, params: { count: 7 }, text: 'Looked at 7 files or places' }),
        ]}
        conversationId='conv'
      />
    );
    expect(texts()).toEqual(['Ran npm test', 'Looked at 7 files or places']);
    // The same element: the line did not move, and nothing about it came in again.
    expect(lines()[1]).toBe(row);
    expect(row).not.toHaveAttribute('data-fresh');
    expect(lines()[0]).toHaveAttribute('data-fresh', 'true');
  });

  it('opens a reopened conversation on the log the session replays, which a live note of the same line does not double', () => {
    const changed = noteOf({ at: time(9, 0, 0), text: 'Changed src/login.ts' });
    const looked = noteOf({ at: time(9, 1, 0), code: 'looked', params: { count: 2 }, text: 'Looked at 2' });
    const events = [switched(true), update({ restored: true, log: [changed, looked] })];
    const { rerender } = showBoard(events);
    expect(texts()).toEqual(['Looked at 2 files or places', 'Changed src/login.ts']);
    rerender(
      <Board events={[...events, event('board.note', { ...looked, params: { count: 5 } })]} conversationId='conv' />
    );
    expect(texts()).toEqual(['Looked at 5 files or places', 'Changed src/login.ts']);
  });

  it('shows the newest 30 lines, and the older ones when asked', () => {
    showBoard([
      switched(true),
      update(),
      ...Array.from({ length: 35 }, (_, index) => note({ text: `Step ${index + 1}` })),
    ]);
    expect(texts()).toHaveLength(30);
    expect(texts()[0]).toBe('Step 35');
    const more = screen.getByTestId('mu-board-more');
    expect(more).toHaveTextContent('5 earlier');
    fireEvent.click(more);
    expect(texts()).toHaveLength(35);
    expect(texts()[34]).toBe('Step 1');
    expect(screen.queryByTestId('mu-board-more')).not.toBeInTheDocument();
  });

  it('reads out the model’s new lines, but neither the fixed lines nor what was there when it opened', () => {
    const events = [switched(true), update(), note({ by: 'model', text: 'It was there before.' })];
    const { rerender } = showBoard(events);
    const ran = note();
    rerender(<Board events={[...events, ran]} conversationId='conv' />);
    expect(screen.getByTestId('mu-board-announce')).toBeEmptyDOMElement();
    const found = note({ by: 'model', kind: 'said', text: 'The session cookie expires too soon.' });
    rerender(<Board events={[...events, ran, found]} conversationId='conv' />);
    expect(readOut()).toEqual(['The session cookie expires too soon.']);
  });

  it('neither reads out nor fades in the log the session replays as it opens', () => {
    const events = [switched(true)];
    const { rerender } = showBoard(events);
    const summary = noteOf({ by: 'model', kind: 'ended', text: 'The login works; the tests pass.' });
    rerender(<Board events={[...events, update({ restored: true, log: [summary] })]} conversationId='conv' />);
    expect(texts()).toEqual(['The login works; the tests pass.']);
    expect(screen.getByTestId('mu-board-announce')).toBeEmptyDOMElement();
    expect(lines()[0]).not.toHaveAttribute('data-fresh');
  });

  it('reads out only the news that came last: a line after a new board, then both when they come together', () => {
    const events = [switched(true)];
    const { rerender } = showBoard(events);
    const board = update();
    rerender(<Board events={[...events, board]} conversationId='conv' />);
    expect(readOut()).toHaveLength(3);
    const passed = note({ by: 'model', text: 'The tests pass now.' });
    rerender(<Board events={[...events, board, passed]} conversationId='conv' />);
    expect(readOut()).toEqual(['The tests pass now.']);
    const last = update({ now: 'Wrapping up', phase: 'wrapping_up', progress: 'All done.' });
    const summary = note({ by: 'model', text: 'It fixed the login.' });
    rerender(<Board events={[...events, board, passed, last, summary]} conversationId='conv' />);
    expect(readOut()).toEqual(['Wrapping up', 'Wrapping up', 'All done.', 'It fixed the login.']);
  });
});

/** A v2 board: a headline, what is blocked, what comes next, and three helpers. */
const T0 = new Date(2026, 9, 24, 10, 0, 0).getTime();
const spoken = (payload: Record<string, unknown> = {}) =>
  update({
    phase: 'blocked',
    headline: 'fixer has run one test for 6 min with no output',
    blocked: 'fixer: npx vitest test/retry.test.ts has run 6 min with no output.',
    next: 'It said it will stop fixer’s run, then rerun the test 20 times.',
    now: 'scout is back: the retry delay reads the clock twice.',
    progress: 'Cause found; the fix is not verified yet.',
    agents: [
      { who: 'scout', role: 'scout', state: 'done', doing: 'found the double clock read', sinceMs: 240_000 },
      { who: 'fixer', role: 'worker', state: 'stuck', doing: 'retry test run, no output', sinceMs: 360_000 },
      { who: 'docs', state: 'working', doing: 'updating the README', sinceMs: 70_000 },
    ],
    updatedAt: T0 - 12_000,
    ...payload,
  });

describe('reading a v2 board', () => {
  it('reads the headline, blocked, next, who is doing what and when it was made', () => {
    const read = toBoardUpdate(
      spoken({
        headlineCode: 'still_running',
        headlineParams: { what: 'npm test', minutes: 3, nested: { no: 1 } },
        blockedCode: 'Not A Code',
        agents: [
          { who: '  scout  ', state: 'done', doing: 'found it', sinceMs: 1000 },
          { who: '', state: 'working', doing: 'nameless' },
          { who: 'fixer', state: 'dancing', doing: 'x'.repeat(2000), sinceMs: -5 },
          'not a row',
        ],
      })
    );
    expect(read).toMatchObject({
      phase: 'blocked',
      headline: 'fixer has run one test for 6 min with no output',
      headlineCode: { code: 'still_running', params: { what: 'npm test', minutes: 3 } },
      blocked: 'fixer: npx vitest test/retry.test.ts has run 6 min with no output.',
      next: 'It said it will stop fixer’s run, then rerun the test 20 times.',
      updatedAt: T0 - 12_000,
    });
    // A code that is not one is dropped: the line is shown as the harness wrote it.
    expect(read?.blockedCode).toBeUndefined();
    expect(read?.agents).toEqual([
      { who: 'scout', state: 'done', doing: 'found it', sinceMs: 1000 },
      // An unknown state keeps the row, without a state; a negative time is no time.
      { who: 'fixer', doing: `${'x'.repeat(600)}…` },
    ]);
    // A board with a headline alone is a board.
    expect(toBoardUpdate(update({ now: '', progress: '', headline: 'Done: the login works' }))?.headline).toBe(
      'Done: the login works'
    );
    expect(toBoardUpdate(spoken({ updatedAt: 'now', agents: [] }))).not.toHaveProperty('updatedAt');
  });

  it('reads an old board exactly as before: none of the new parts', () => {
    const read = toBoardUpdate(update());
    for (const key of ['headline', 'headlineCode', 'blocked', 'blockedCode', 'next', 'agents', 'updatedAt'])
      expect(read).not.toHaveProperty(key);
    expect(toBoardNote(note())).not.toHaveProperty('who');
    expect(toBoardNote(note({ who: '  fixer ' }))?.who).toBe('fixer');
  });
});

describe('a v2 board in the panel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leads with the headline, then blocked, next, now and how far, then who is doing what', () => {
    showBoard([switched(true), spoken()]);
    const order = [
      'mu-board-state',
      'mu-board-headline',
      'mu-board-blocked',
      'mu-board-next',
      'mu-board-now',
      'mu-board-progress',
      'mu-board-agents',
    ].map((id) => screen.getByTestId(id));
    for (let index = 1; index < order.length; index += 1)
      expect(order[index - 1].compareDocumentPosition(order[index])).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByTestId('mu-board-headline').tagName).toBe('P');
    expect(screen.getByTestId('mu-board-headline')).toHaveTextContent('fixer has run one test for 6 min');
    expect(screen.getByTestId('mu-board-state')).toHaveTextContent('Waiting on something else');
    expect(screen.getByTestId('mu-board-state').querySelector('[data-mark]')).toHaveAttribute('data-mark', 'hollow');
    const blocked = screen.getByTestId('mu-board-blocked');
    expect(blocked).toHaveTextContent('Blocked');
    expect(blocked).toHaveTextContent('has run 6 min with no output.');
    expect(blocked.querySelector('[data-mark="hollow"]')).not.toBeNull();
    expect(screen.getByTestId('mu-board-next')).toHaveTextContent('NextIt said it will stop fixer’s run');
  });

  it('says how long ago the board was made, counting up on its own', () => {
    showBoard([switched(true), spoken()]);
    expect(screen.getByTestId('mu-board-updated')).toHaveTextContent('Updated 10 sec ago');
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByTestId('mu-board-updated')).toHaveTextContent('Updated 1 min ago');
    cleanup();
    showBoard([switched(true), spoken({ updatedAt: Date.now() - 2_000 })]);
    expect(screen.getByTestId('mu-board-updated')).toHaveTextContent('Updated just now');
  });

  it('lists who is doing what: a mark, the name, the state when it matters, what it does, and for how long', () => {
    showBoard([switched(true), spoken()]);
    const rows = screen.getAllByTestId('mu-board-agent');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['done', 'stuck', 'working']);
    expect(rows.map((row) => row.querySelector('[data-mark]')?.getAttribute('data-mark'))).toEqual([
      'tick',
      'hollow',
      'dot',
    ]);
    expect(rows[0]).toHaveTextContent('scoutDone found the double clock read');
    expect(rows[1]).toHaveTextContent('fixerStuck retry test run, no output');
    // A stuck helper's state is a tag to read; a working one's is told by its mark (and to a screen reader).
    expect(within(rows[1]).getByTestId('mu-board-agent-state')).not.toHaveClass('sr-only');
    expect(within(rows[2]).getByTestId('mu-board-agent-state')).toHaveClass('sr-only');
    // Only the ones still at it have a time, which goes on from when the board was made.
    expect(within(rows[0]).queryByTestId('mu-board-agent-time')).toBeNull();
    expect(within(rows[1]).getByTestId('mu-board-agent-time')).toHaveTextContent('6 min');
    expect(within(rows[2]).getByTestId('mu-board-agent-time')).toHaveTextContent('1 min');
    act(() => vi.advanceTimersByTime(60_000));
    expect(within(rows[1]).getByTestId('mu-board-agent-time')).toHaveTextContent('7 min');
  });

  it('stops the helpers’ clocks for a board that ended', () => {
    showBoard([switched(true), spoken({ ended: true })]);
    const since = within(screen.getAllByTestId('mu-board-agent')[1]).getByTestId('mu-board-agent-time');
    expect(since).toHaveTextContent('6 min');
    act(() => vi.advanceTimersByTime(120_000));
    expect(since).toHaveTextContent('6 min');
  });

  it('leaves out "now" when it only says the headline again, and shows a board without the new parts as before', () => {
    showBoard([
      switched(true),
      spoken({ now: 'fixer has run one test for 6 min with no output', blocked: '', next: '' }),
    ]);
    expect(screen.queryByTestId('mu-board-now')).toBeNull();
    expect(screen.queryByTestId('mu-board-blocked')).toBeNull();
    expect(screen.queryByTestId('mu-board-next')).toBeNull();
    cleanup();
    showBoard([switched(true), update()]);
    for (const id of ['mu-board-headline', 'mu-board-blocked', 'mu-board-next', 'mu-board-agents', 'mu-board-updated'])
      expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getByTestId('mu-board-now')).toHaveTextContent('Writing the tests for the login page');
  });

  it('reads out a new board’s headline alone', () => {
    const events = [switched(true)];
    const { rerender } = showBoard(events);
    rerender(<Board events={[...events, spoken()]} conversationId='conv' />);
    expect(readOut()).toEqual(['fixer has run one test for 6 min with no output']);
  });

  it('puts the helper’s name on its lines of the account, unless the sentence already starts from it', () => {
    showBoard([
      switched(true),
      spoken(),
      note({ who: 'docs', by: 'model', text: 'The README still says retries wait 1 s.' }),
      note({
        who: 'scout',
        code: 'helper_done',
        params: { name: 'scout', summary: 'found it' },
        text: 'scout is back',
      }),
      note({ text: 'Looked at 4 files or places' }),
    ]);
    const rows = lines();
    expect(rows.map((row) => row.querySelector('[data-testid="mu-board-note-who"]')?.textContent ?? null)).toEqual([
      null,
      null,
      'docs',
    ]);
    expect(texts()).toEqual([
      'Looked at 4 files or places',
      'scout is back: found it',
      'docsThe README still says retries wait 1 s.',
    ]);
  });
});

/** The work panel's board tab for one conversation. */
function BoardTab() {
  const read = useKyrnActivity('conv');
  return <KernelBody tab='board' conversationId='conv' activity={read} />;
}

describe('the board in the work panel', () => {
  it('waits for the conversation’s record, then shows its board', async () => {
    activity.mockResolvedValue(page([switched(true), update()]));
    render(<BoardTab />, { wrapper: Wrapper });
    expect(screen.getByText(common.loading)).toBeInTheDocument();
    expect(await screen.findByTestId('mu-board-now')).toHaveTextContent('Writing the tests');
    expect(activity).toHaveBeenCalledWith({ conversationId: 'conv', cursor: 0, sessionId: '' });
    // The board already there when the tab opened is not news: nothing is read out.
    expect(screen.getByTestId('mu-board-announce')).toBeEmptyDOMElement();
  });

  it('offers to turn the board on when it is off for the project', async () => {
    activity.mockResolvedValue(page([switched(false)]));
    render(<BoardTab />, { wrapper: Wrapper });
    expect(await screen.findByTestId('mu-board-off')).toBeVisible();
    expect(screen.getByTestId('mu-board-switch')).not.toBeDisabled();
    await act(async () => undefined);
  });
});
