import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { Activity } from '@/common/kyrn/types';
import { JOURNAL_CAP, type JournalEntry, type JournalView } from '@/common/kyrn/journal';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import JournalTab from '@/renderer/pages/conversation/KyrnPanel/Journal';

type Answer = { ok: true; data: JournalView } | { ok: false; error: string };

const read = vi.hoisted(() => vi.fn<() => Promise<Answer>>());
const quizState = vi.hoisted(() => vi.fn<() => Promise<{ ok: true; data: { model?: string } }>>());
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { journal: { invoke: read }, quizState: { invoke: quizState } },
  unwrap: (result: Answer) => {
    if (result.ok === false) throw new Error(result.error);
    return result.data;
  },
}));
// The quiz's modal brings the theme context with it; the tab's rows need none of it.
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light', fontScale: 1 }),
}));

const copy = common.kyrn.journalView;
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: { common } } }, interpolation: { escapeValue: false } });
});

let next = 0;
const entry = (extra: Partial<JournalEntry> = {}): JournalEntry => ({
  id: `entry-${++next}`,
  source: 'lessons',
  kind: 'correction',
  text: `Lesson ${next}.`,
  at: `2026-11-${String(1 + (next % 20)).padStart(2, '0')}T08:00:00.000Z`,
  ...extra,
});

const answer = (entries: JournalEntry[], total = entries.length): Answer => ({ ok: true, data: { entries, total } });

function Tab({ events = [] }: { events?: Activity[] }) {
  return (
    <I18nextProvider i18n={i18n}>
      <JournalTab conversationId='conv-1' events={events} visible />
    </I18nextProvider>
  );
}
/** Let the bridge's answer land. */
const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
const rows = () => screen.queryAllByTestId('mu-journal-entry');
const fold = () => screen.getByTestId('mu-journal-earlier-toggle');

beforeEach(() => {
  read.mockReset();
  quizState.mockReset();
  quizState.mockResolvedValue({ ok: true, data: {} });
});
afterEach(() => cleanup());

describe('the journal tab', () => {
  it('lays the newest few entries flat and folds the rest away until asked for', async () => {
    const entries = Array.from({ length: 6 }, () => entry());
    read.mockResolvedValue(answer(entries));
    render(<Tab />);
    await settle();
    // The newest three lie open at the top.
    expect(rows()).toHaveLength(3);
    expect(rows()[0].textContent).toContain(entries[0].text);
    // The rest wait behind one closed fold.
    expect(fold()).toHaveAttribute('aria-expanded', 'false');
    expect(fold().textContent).toContain('3');
    expect(screen.queryByTestId('mu-journal-earlier')).toBeNull();

    fireEvent.click(fold());
    expect(fold()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('mu-journal-earlier')).toBeTruthy();
    expect(rows()).toHaveLength(6);
    expect(screen.queryByTestId('mu-journal-cap')).toBeNull();
  });

  it('says how much it leaves out when there is more than the journal’s cap', async () => {
    read.mockResolvedValue(
      answer(
        Array.from({ length: JOURNAL_CAP }, () => entry()),
        JOURNAL_CAP + 12
      )
    );
    render(<Tab />);
    await settle();
    expect(screen.getByTestId('mu-journal-cap').textContent).toContain('50');
    expect(screen.getByTestId('mu-journal-cap').textContent).toContain('62');
    // All of the cap's entries are there, three of them flat and the rest behind the fold.
    expect(rows()).toHaveLength(3);
    fireEvent.click(fold());
    expect(rows()).toHaveLength(JOURNAL_CAP);
  });

  it('names where each entry came from and where it holds', async () => {
    read.mockResolvedValue(
      answer([
        entry({ source: 'lessons', kind: 'pitfall', text: 'Run vitest with Node 24.', scope: 'E:/Projects/mu' }),
        entry({ source: 'lessons', text: 'Answer in Chinese.' }),
        entry({ source: 'positions', text: 'Wrap-up line.', at: '2026-11-22', scope: 'mu-dev' }),
      ])
    );
    render(<Tab />);
    await settle();
    const [lesson, everywhere, position] = rows();
    expect(lesson.textContent).toContain(copy.sources.lessons);
    expect(lesson.textContent).toContain('Pitfall'); // the lessons tab's own kind word
    expect(lesson.textContent).toContain('mu'); // the project folder's own name, not its whole path
    expect(lesson.textContent).not.toContain('E:/Projects/mu');
    expect(everywhere.textContent).toContain('All projects');
    expect(position.textContent).toContain('mu-dev');
    expect(position.textContent).toContain('2026-11-22');
  });

  it("reads again when the conversation's lessons file moved on", async () => {
    read.mockResolvedValue(answer([entry()]));
    const { rerender } = render(<Tab events={[{ id: 'event-1', at: 1, kind: 'memory.stored', payload: {} }]} />);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    rerender(
      <Tab
        events={[
          { id: 'event-1', at: 1, kind: 'memory.stored', payload: {} },
          { id: 'event-2', at: 2, kind: 'memory.recalled', payload: {} },
        ]}
      />
    );
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('says so, quietly, when nothing has been learned yet', async () => {
    read.mockResolvedValue(answer([]));
    render(<Tab />);
    await settle();
    expect(screen.getByTestId('mu-journal-empty').textContent).toBe(copy.empty);
    expect(rows()).toHaveLength(0);
  });

  it('names the failure when the journal cannot be read', async () => {
    read.mockResolvedValue({ ok: false, error: 'the file is locked' });
    render(<Tab />);
    await settle();
    expect(screen.getByText(copy.loadFailed)).toBeTruthy();
    expect(screen.getByText(/the file is locked/)).toBeTruthy();
  });
});
