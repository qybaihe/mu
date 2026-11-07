import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { ClmServerState } from '@/common/kyrn/clm';
import type { Result } from '@/common/kyrn/types';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import ClmServerCheck from '@/renderer/pages/settings/KyrnSettings/sections/ClmServerCheck';

const bridge = vi.hoisted(() => ({ clmCheck: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { clmCheck: { invoke: bridge.clmCheck } },
  unwrap: <T,>(result: Result<T>) => {
    if (!result.ok) throw Object.assign(new Error(result.error), result);
    return result.data;
  },
}));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { common: enCommon, mu: enMu } } },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const running = (patch: Partial<Extract<ClmServerState, { status: 'ready' }>> = {}) => ({
  ok: true,
  data: {
    status: 'ready',
    models: ['clm-latest', 'clm-raw'],
    mock: false,
    keyRequired: false,
    latencyMs: 21,
    ...patch,
  } satisfies ClmServerState,
});

function check(props: Partial<React.ComponentProps<typeof ClmServerCheck>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ClmServerCheck baseUrl='' model='clm-latest' keySet={false} {...props} />
    </I18nextProvider>
  );
}

const status = () => screen.getByTestId('mu-clm-status').textContent;

describe('word from the CLM server on the judges page', () => {
  it('asks the server at the address and says it answers, with its models and how fast', async () => {
    bridge.clmCheck.mockResolvedValue(running());
    check({ baseUrl: 'http://192.168.1.20:8700' });
    await waitFor(() => expect(status()).toBe('Online · clm-latest and clm-raw · 21 ms'));
    expect(bridge.clmCheck).toHaveBeenCalledWith({ baseUrl: 'http://192.168.1.20:8700' });
  });

  it('names what stands in the way: nothing listening, the encoder, the model, the key', async () => {
    bridge.clmCheck.mockResolvedValueOnce({ ok: true, data: { status: 'down' } });
    const view = check();
    await waitFor(() => expect(status()).toContain('Nothing is responding at http://127.0.0.1:8700'));

    bridge.clmCheck.mockResolvedValueOnce(running({ status: 'encoderDown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check server' }));
    await waitFor(() => expect(status()).toContain("its encoder doesn't"));
    view.unmount();

    bridge.clmCheck.mockResolvedValue(running({ models: ['clm-raw'] }));
    const other = check();
    await waitFor(() => expect(status()).toBe("The server doesn't serve clm-latest. It serves clm-raw."));
    other.unmount();

    bridge.clmCheck.mockResolvedValue(running({ keyRequired: true }));
    const keyless = check();
    await waitFor(() => expect(status()).toContain('The server requires a key'));
    keyless.unmount();
    check({ keySet: true });
    await waitFor(() => expect(status()).toContain('Online'));
    expect(screen.getByText('The server requires a key, and one is saved.')).toBeTruthy();
  });

  it("warns that a mock encoder's answers are noise", async () => {
    bridge.clmCheck.mockResolvedValue(running({ mock: true }));
    check();
    await waitFor(() => expect(screen.getByText(/mock encoder/)).toBeTruthy());
  });

  it('does not ask about an address the questions may not go to', async () => {
    check({ baseUrl: 'http://169.254.169.254:8700' });
    await new Promise((done) => setTimeout(done, 700));
    expect(bridge.clmCheck).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mu-clm-server')).toBeNull();
  });
});
