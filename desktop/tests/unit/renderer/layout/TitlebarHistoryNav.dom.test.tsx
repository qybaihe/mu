/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const history = vi.hoisted(() => ({
  value: null as null | { canBack: boolean; canForward: boolean; back: () => void; forward: () => void },
  mobile: false,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/conversation/test', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: { conversation: { get: { invoke: vi.fn(() => Promise.resolve(null)) } } },
}));
vi.mock('@renderer/pages/conversation/GroupedHistory/ConversationSearchPopover', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/MobileConversationBrand', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/WindowControls', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: history.mobile }),
}));
vi.mock('@/renderer/hooks/context/NavigationHistoryContext', () => ({
  useNavigationHistory: () => history.value,
}));
vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
  isMacOS: () => true,
}));

import Titlebar from '@/renderer/components/layout/Titlebar';

const back = () => screen.queryByRole('button', { name: 'common.historyBack' });
const forward = () => screen.queryByRole('button', { name: 'common.forward' });

// The back and forward arrows read as a browser's toolbar when they sit there with nowhere to go.
describe('Titlebar history arrows', () => {
  beforeEach(() => {
    history.value = null;
    history.mobile = false;
  });

  it('are hidden while there is no history in either direction', () => {
    history.value = { canBack: false, canForward: false, back: vi.fn(), forward: vi.fn() };
    render(<Titlebar workspaceAvailable />);
    expect(back()).not.toBeInTheDocument();
    expect(forward()).not.toBeInTheDocument();
  });

  it('show both once there is somewhere to go, the other one disabled, and go there', () => {
    history.value = { canBack: true, canForward: false, back: vi.fn(), forward: vi.fn() };
    render(<Titlebar workspaceAvailable />);
    expect(back()).toBeEnabled();
    expect(forward()).toBeDisabled();
    fireEvent.click(back()!);
    expect(history.value.back).toHaveBeenCalledTimes(1);
    // Smaller than the sidebar toggle's 18px icon.
    expect(back()!.querySelector('svg')).toHaveAttribute('width', '14');
  });

  it('never show on a phone', () => {
    history.mobile = true;
    history.value = { canBack: true, canForward: true, back: vi.fn(), forward: vi.fn() };
    render(<Titlebar workspaceAvailable />);
    expect(back()).not.toBeInTheDocument();
  });
});
