import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { SWRConfig } from 'swr';
import common from '@/renderer/services/i18n/locales/zh-CN/common.json';
import mu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import JudgePulse from '@/renderer/components/brand/JudgePulse';
import MuBackdrop from '@/renderer/components/brand/MuBackdrop';
import { MU_GLYPH_PATH } from '@/renderer/components/brand/glyph';
import MuMark from '@/renderer/components/brand/MuMark';

import MuStarters, { MU_STARTERS } from '@/renderer/components/brand/MuStarters';
import StartupGate from '@/renderer/pages/settings/KyrnSettings/StartupGate';

const { catalog } = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { catalog: { invoke: catalog } },
  // As the real one: a failure keeps the code the main process gave it.
  unwrap: (result: { ok: boolean; data?: unknown; error?: string }) => {
    if (!result.ok) throw Object.assign(new Error(result.error), result);
    return result.data;
  },
}));

const copy = common.kyrn;
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'zh',
    resources: { zh: { translation: { common, mu } } },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const view = (node: React.ReactNode) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SWRConfig value={{ provider: () => new Map() }}>{node}</SWRConfig>
    </I18nextProvider>
  );

describe('MuMark', () => {
  it('is decorative unless it is given a name', () => {
    const { container, rerender } = render(<MuMark />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('rect')).toBeInTheDocument();
    rerender(<MuMark title='mu' variant='glyph' size={20} />);
    expect(screen.getByRole('img', { name: 'mu' })).toHaveAttribute('width', '20');
    // The glyph variant has no tile behind it.
    expect(container.querySelector('rect')).not.toBeInTheDocument();
  });

  it('gives every mark its own gradient id, so two marks on a page never share a fill', () => {
    const { container } = render(
      <>
        <MuMark />
        <MuMark />
      </>
    );
    const ids = [...container.querySelectorAll('linearGradient')].map((node) => node.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('MuBackdrop', () => {
  it('draws the icon’s glyph as decoration, each with its own gradients, and fades on the way out', () => {
    const { container, rerender } = render(
      <>
        <MuBackdrop />
        <MuBackdrop />
      </>
    );
    for (const backdrop of screen.getAllByTestId('mu-backdrop')) {
      expect(backdrop).toHaveAttribute('aria-hidden', 'true');
      expect(backdrop).toHaveAttribute('data-state', 'shown');
    }
    // The fill and the rim are the same glyph as the icon.
    const paths = [...container.querySelectorAll('path')].map((node) => node.getAttribute('d'));
    expect(new Set(paths)).toEqual(new Set([MU_GLYPH_PATH]));
    const ids = [...container.querySelectorAll('linearGradient, mask')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    rerender(<MuBackdrop leaving />);
    expect(screen.getByTestId('mu-backdrop')).toHaveAttribute('data-state', 'leaving');
  });
});

describe('JudgePulse', () => {
  it('says exactly the state it is given, idle by default', () => {
    const { rerender } = view(<JudgePulse />);
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'idle');
    expect(screen.getByRole('status')).toHaveAccessibleName(copy.brand.judge.idle);
    rerender(
      <I18nextProvider i18n={i18n}>
        <JudgePulse state='judging' />
      </I18nextProvider>
    );
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'judging');
    expect(screen.getByRole('status')).toHaveAccessibleName(copy.brand.judge.judging);
    rerender(
      <I18nextProvider i18n={i18n}>
        <JudgePulse state='off' />
      </I18nextProvider>
    );
    expect(screen.getByRole('status')).toHaveAccessibleName(copy.brand.judge.off);
  });
});

describe('MuStarters', () => {
  it('offers three starting points in Chinese and only hands the prompt over', () => {
    const onPick = vi.fn();
    view(<MuStarters onPick={onPick} />);
    expect(MU_STARTERS).toHaveLength(3);
    for (const { key } of MU_STARTERS) {
      expect(screen.getByText(copy.brand.starters[key].title)).toBeInTheDocument();
      expect(screen.getByText(copy.brand.starters[key].desc)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId('mu-starter-fix'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(copy.brand.starters.fix.prompt);
  });
});

describe('StartupGate', () => {
  beforeEach(() => catalog.mockReset());

  it('shows the mark while mu starts, then the app', async () => {
    const start = Promise.withResolvers<unknown>();
    catalog.mockReturnValue(start.promise);
    view(
      <StartupGate>
        <div>app</div>
      </StartupGate>
    );
    expect(screen.getByTestId('mu-startup')).toHaveTextContent(copy.starting);
    expect(screen.getByTestId('mu-mark')).toBeInTheDocument();
    expect(screen.queryByText('app')).not.toBeInTheDocument();
    start.resolve({ ok: true, data: { assistants: [] } });
    expect(await screen.findByText('app')).toBeInTheDocument();
    expect(screen.queryByTestId('mu-startup')).not.toBeInTheDocument();
  });

  it('reports a failed start with its cause and retries on request', async () => {
    catalog.mockResolvedValueOnce({ ok: false, error: 'adapter missing' });
    view(
      <StartupGate>
        <div>app</div>
      </StartupGate>
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy.startupError);
    // A failure without a known code: a sentence in the reader's language, the raw message only as the detail.
    expect(alert).toHaveTextContent(mu.errors.unknown);
    expect(screen.getByTestId('mu-error-detail')).toHaveTextContent('adapter missing');
    expect(alert).not.toHaveTextContent('Error:');
    expect(screen.queryByText('app')).not.toBeInTheDocument();

    catalog.mockResolvedValueOnce({ ok: true, data: { assistants: [] } });
    fireEvent.click(screen.getByRole('button', { name: copy.reload }));
    await waitFor(() => expect(screen.getByText('app')).toBeInTheDocument());
  });

  it('says why mu did not start in the reader’s language, with no English left in it', async () => {
    catalog.mockResolvedValueOnce({
      ok: false,
      code: 'runtimeOffline',
      error: 'mu runtime is not online. Check the local launcher and login.',
    });
    view(
      <StartupGate>
        <div>app</div>
      </StartupGate>
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(mu.errors.runtimeOffline);
    expect(alert).not.toHaveTextContent('not online');
    expect(screen.queryByTestId('mu-error-detail')).not.toBeInTheDocument();
  });

  // #4: what is left to the person when Windows gives the launcher no spelling without spaces.
  it('says to install mu into a folder whose path has no spaces when it cannot start from where it is', async () => {
    catalog.mockResolvedValueOnce({
      ok: false,
      code: 'installPath',
      error:
        'mu cannot be started from where it is installed: C:\\Program Files\\mu\\resources\\mu\\acp.cmd has spaces',
    });
    view(
      <StartupGate>
        <div>app</div>
      </StartupGate>
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(mu.errors.installPath);
    expect(alert).toHaveTextContent('C:\\mu');
    expect(screen.queryByTestId('mu-error-detail')).not.toBeInTheDocument();
  });
});
