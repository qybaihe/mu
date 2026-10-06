import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import FirstHint from '@/renderer/components/base/FirstHint';
import { resetFirstHintsForTest } from '@/renderer/components/base/FirstHint/firstHints';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { common: enCommon } } },
    interpolation: { escapeValue: false },
  });
});
beforeEach(() => {
  localStorage.clear();
  resetFirstHintsForTest();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Verdict lines, each wanting the hint, by their numbers. */
function Lines({ lines, wants = true }: { lines: number[]; wants?: boolean }) {
  return (
    <I18nextProvider i18n={i18n}>
      {lines.map((line) => (
        <div key={line} data-testid={`line-${line}`}>
          <FirstHint id='jevLine' wants={wants} text={`hint at ${line}`} />
        </div>
      ))}
    </I18nextProvider>
  );
}

describe('a first-time hint', () => {
  it('shows under one of the places that want it, and is gone for good once closed', () => {
    const view = render(<Lines lines={[1, 2, 3]} />);
    expect(screen.getAllByTestId('mu-first-hint-jevLine')).toHaveLength(1);
    expect(screen.getByTestId('line-1')).toHaveTextContent('hint at 1');
    fireEvent.click(screen.getByText('Got it'));
    expect(screen.queryByTestId('mu-first-hint-jevLine')).toBeNull();
    expect(JSON.parse(localStorage.getItem('mu.firstHints') ?? '[]')).toEqual(['jevLine']);
    // After a restart it stays closed.
    view.unmount();
    resetFirstHintsForTest();
    render(<Lines lines={[4]} />);
    expect(screen.queryByTestId('mu-first-hint-jevLine')).toBeNull();
  });

  it('moves to the next place that wants it when its place goes away', () => {
    const view = render(<Lines lines={[1, 2]} />);
    expect(screen.getByTestId('line-1')).toHaveTextContent('hint at 1');
    act(() => view.rerender(<Lines lines={[2]} />));
    expect(screen.getByTestId('line-2')).toHaveTextContent('hint at 2');
  });

  it('shows nowhere that does not want it', () => {
    render(<Lines lines={[1]} wants={false} />);
    expect(screen.queryByTestId('mu-first-hint-jevLine')).toBeNull();
  });

  it('never shows when it could not be closed for good', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('no storage');
    });
    render(<Lines lines={[1]} />);
    expect(screen.queryByTestId('mu-first-hint-jevLine')).toBeNull();
  });
});
