/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  getCdpStatus: vi.fn(),
  isDevToolsOpened: vi.fn(() => Promise.resolve(false)),
  openDevTools: vi.fn(() => Promise.resolve(true)),
  devToolsStateChanged: vi.fn(() => () => {}),
  openExternal: vi.fn(() => Promise.resolve()),
  navigate: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      getCdpStatus: { invoke: bridge.getCdpStatus },
      isDevToolsOpened: { invoke: bridge.isDevToolsOpened },
      openDevTools: { invoke: bridge.openDevTools },
      devToolsStateChanged: { on: bridge.devToolsStateChanged },
    },
    shell: { openExternal: { invoke: bridge.openExternal } },
  },
}));

vi.mock('@/renderer/utils/navigation', () => ({ globalNavigate: bridge.navigate }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import DevSettings from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/DevSettings';

const renderDevSettings = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DevSettings />
    </SWRConfig>
  );

describe('the developer page', () => {
  beforeEach(() => {
    bridge.getCdpStatus.mockReset();
    bridge.navigate.mockReset();
  });

  it('says in an installed app that its tools are for a build run from its sources, and shows none of them', async () => {
    bridge.getCdpStatus.mockResolvedValue({ success: true, data: { isDevMode: false, enabled: true, port: 9230 } });

    renderDevSettings();

    expect(await screen.findByText('settings.developer.devOnly')).toBeInTheDocument();
    expect(screen.queryByTestId('dev-settings')).not.toBeInTheDocument();
    expect(screen.queryByText('http://127.0.0.1:9230')).not.toBeInTheDocument();
  });

  it('shows nothing while the status is not known', async () => {
    bridge.getCdpStatus.mockResolvedValue({ success: false, msg: 'no' });

    const { container } = renderDevSettings();

    await waitFor(() => expect(bridge.getCdpStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('says what the browser connection is, has no switch of its own, and leads to the one switch', async () => {
    bridge.getCdpStatus.mockResolvedValue({ success: true, data: { isDevMode: true, enabled: true, port: 9230 } });

    renderDevSettings();
    const toBrowserSettings = await screen.findByRole('button', { name: 'settings.cdp.openBrowserSettings' });

    expect(screen.getByText('settings.cdp.about')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:9230')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();

    fireEvent.click(toBrowserSettings);

    expect(bridge.navigate).toHaveBeenCalledWith('/settings/browser');
  });

  it('says the connection is not running when it has no port', async () => {
    bridge.getCdpStatus.mockResolvedValue({ success: true, data: { isDevMode: true, enabled: false } });

    renderDevSettings();

    expect(await screen.findByText('settings.cdp.disabledHint')).toBeInTheDocument();
  });
});
