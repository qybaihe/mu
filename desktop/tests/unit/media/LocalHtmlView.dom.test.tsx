/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A local HTML page of a reply renders as a live sandbox — the interaction itself, not a
 * recording: scripts run, the frame is opaque-origin (no app access), and the bar offers
 * reload and save.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LocalHtmlView from '@/renderer/components/media/LocalHtmlView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async () => 'data:application/octet-stream;base64,PGI+aGk8L2I+'),
}));
vi.mock('@/common', () => ({ ipcBridge: { fs: { getImageBase64: { invoke } } } }));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: { error: vi.fn() } };
});

describe('LocalHtmlView', () => {
  it('renders a sandboxed frame served as text/html from the fs bridge', async () => {
    render(<LocalHtmlView src='E:/out/demo.html' title='demo' />);
    const frame = await screen.findByTestId('local-html-frame');
    expect(invoke).toHaveBeenCalledWith({ path: 'E:/out/demo.html', workspace: undefined });
    // whatever mime the bridge produced, the page is served as text/html so its scripts run
    expect(frame.getAttribute('src')).toMatch(/^data:text\/html;base64,/);
    // scripts run, but the frame gets no origin and cannot reach the app
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(screen.getByTestId('local-html-reload')).toBeTruthy();
    expect(screen.getByTestId('local-html-save')).toBeTruthy();
  });

  it('falls back to a plain mention when the bridge hands nothing back', async () => {
    invoke.mockResolvedValueOnce(null);
    render(<LocalHtmlView src='E:/out/missing.html' title='gone' />);
    await waitFor(() => expect(screen.queryByTestId('local-html-frame')).toBeNull());
    expect(screen.getByText(/missing.html/)).toBeTruthy();
  });
});
