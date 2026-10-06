import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { SWRConfig } from 'swr';
import enAgentMode from '@/renderer/services/i18n/locales/en-US/agentMode.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import NativePermissionPill from '@/renderer/pages/native/components/composer/NativePermissionPill';
import { PERMISSION_MODES } from '@/renderer/pages/native/components/composer/composerModel';

const bridge = vi.hoisted(() => ({ settings: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { settings: { invoke: bridge.settings } },
  unwrap: <T,>(result: { ok: boolean; data: T }) => {
    if (!result.ok) throw new Error('failed');
    return result.data;
  },
}));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { agentMode: enAgentMode, mu: enMu } } },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const shown = () => screen.getByTestId('native-permission-pill');
const modes = PERMISSION_MODES.map((id) => ({ id, label: id, description: '' }));
const pill = (mode?: string) =>
  render(
    <I18nextProvider i18n={i18n}>
      {/* A fresh cache per test: the default is read once and shared by every send box. */}
      <SWRConfig value={{ provider: () => new Map() }}>
        <NativePermissionPill state={{ ...(mode ? { mode } : {}), modes }} held={false} request={vi.fn()} />
      </SWRConfig>
    </I18nextProvider>
  );

describe('the permission pill of a native conversation', () => {
  it('names mu’s default mode while the conversation has none of its own', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: { permissions: { mode: 'full', from: 'picked' } } });
    pill();
    await waitFor(() => expect(shown()).toHaveTextContent(`Permission · ${enAgentMode.full}`));
    // The conversation itself has not said a mode.
    expect(shown()).toHaveAttribute('data-mode', '');
  });

  it('names the conversation’s own mode over the default', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: { permissions: { mode: 'full', from: 'picked' } } });
    pill('ask');
    await waitFor(() => expect(bridge.settings).toHaveBeenCalled());
    expect(shown()).toHaveTextContent(`Permission · ${enAgentMode.ask}`);
  });

  it('says mu’s default when the default cannot be read', async () => {
    bridge.settings.mockResolvedValue({ ok: false, error: 'no' });
    pill();
    await waitFor(() => expect(bridge.settings).toHaveBeenCalled());
    expect(shown()).toHaveTextContent(`Permission · ${enMu.native.new.defaultPermissions}`);
  });
});
