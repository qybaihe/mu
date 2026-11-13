/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A local video of a reply plays while the pointer is over it and opens on click into an overlay with zoom,
 * rotation and save — the video sibling of what LocalImageView does for images.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LocalVideoView from '@/renderer/components/media/LocalVideoView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async () => 'data:video/mp4;base64,eHg='),
}));
vi.mock('@/common', () => ({ ipcBridge: { fs: { getImageBase64: { invoke } } } }));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: { error: vi.fn() } };
});

// jsdom has no media playback.
const play = vi.fn(() => Promise.resolve());
const pause = vi.fn();
beforeEach(() => {
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', { writable: true, value: play });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', { writable: true, value: pause });
  play.mockClear();
  pause.mockClear();
  invoke.mockClear();
  const url = vi.fn(() => 'blob:x');
  const revoke = vi.fn();
  Object.assign(URL, { createObjectURL: url, revokeObjectURL: revoke });
});

describe('LocalVideoView', () => {
  it('plays on hover and pauses on leave, without opening anything', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const video = await screen.findByTestId('local-video');
    expect(invoke).toHaveBeenCalledWith({ path: 'E:/out/demo.mp4', workspace: undefined });
    fireEvent.mouseEnter(video);
    expect(play).toHaveBeenCalled();
    fireEvent.mouseLeave(video);
    expect(pause).toHaveBeenCalled();
    expect(screen.queryByTestId('local-video-modal')).toBeNull();
  });

  it('opens the overlay on click with zoom, rotation and save', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    await screen.findByTestId('local-video');
    fireEvent.click(screen.getByTestId('local-video-open'));
    const modal = screen.getByTestId('local-video-modal');
    expect(modal).toBeTruthy();
    expect(screen.getByTestId('local-video-zoom-in')).toBeTruthy();
    fireEvent.click(screen.getByTestId('local-video-rotate'));
    fireEvent.click(screen.getByTestId('local-video-save'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ path: 'E:/out/demo.mp4', workspace: undefined }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('local-video-modal')).toBeNull();
  });
});
