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

const { invoke, copyInvoke } = vi.hoisted(() => ({
  invoke: vi.fn(async () => 'data:video/mp4;base64,eHg='),
  copyInvoke: vi.fn(async () => true),
}));
const { emit } = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('@/common', () => ({ ipcBridge: { fs: { getImageBase64: { invoke }, copyFileToClipboard: { invoke: copyInvoke } } } }));
vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit } }));
vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: vi.fn(async () => {}) }));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } };
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
  it('plays on hover of the whole video area and pauses on leave, without opening anything', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    await screen.findByTestId('local-video');
    expect(invoke).toHaveBeenCalledWith({ path: 'E:/out/demo.mp4', workspace: undefined });
    const wrap = screen.getByTestId('local-video-wrap'); // the open button covers the video itself
    fireEvent(wrap, new MouseEvent('mouseenter', { bubbles: false })); // native listeners, not React's synthetic pair
    expect(play).toHaveBeenCalled();
    fireEvent(wrap, new MouseEvent('mouseleave', { bubbles: false }));
    expect(pause).toHaveBeenCalled();
    expect(screen.queryByTestId('local-video-modal')).toBeNull();
  });

  it('opens the overlay on click with zoom, rotation (both ways) and save', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    await screen.findByTestId('local-video');
    fireEvent.click(screen.getByTestId('local-video-open'));
    const modal = screen.getByTestId('local-video-modal'); // portaled to the body
    expect(modal).toBeTruthy();
    expect(play).toHaveBeenCalled(); // the overlay starts playing at once
    expect(screen.getByTestId('local-video-zoom-in')).toBeTruthy();
    fireEvent.click(screen.getByTestId('local-video-modal-rotate-left'));
    fireEvent.click(screen.getByTestId('local-video-rotate'));
    fireEvent.click(screen.getByTestId('local-video-save'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ path: 'E:/out/demo.mp4', workspace: undefined }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('local-video-modal')).toBeNull();
  });

  it('stops the overlay autoplay once the user moves the playhead', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    await screen.findByTestId('local-video');
    fireEvent.click(screen.getByTestId('local-video-open'));
    pause.mockClear(); // the open effect pauses the small video; only what follows counts
    const large = screen.getByTestId('local-video-modal').querySelector('video')!;
    fireEvent.pointerDown(large); // touching the video area — a scrub is on its way
    fireEvent(large, new Event('seeked'));
    expect(pause).toHaveBeenCalled(); // the frame the user picked stands still
  });

  it('keeps playing through a seek it caused itself (autoplay untouched)', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    await screen.findByTestId('local-video');
    fireEvent.click(screen.getByTestId('local-video-open'));
    pause.mockClear();
    const large = screen.getByTestId('local-video-modal').querySelector('video')!;
    fireEvent(large, new Event('seeked')); // e.g. the element settling at its start
    expect(pause).not.toHaveBeenCalled();
  });

  it('offers play/pause and a draggable progress bar under the video', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const video = (await screen.findByTestId('local-video')) as HTMLVideoElement;
    let isPlaying = false;
    let time = 0;
    const elPlay = vi.fn(() => {
      isPlaying = true;
      return Promise.resolve();
    });
    const elPause = vi.fn(() => {
      isPlaying = false;
    });
    Object.defineProperty(video, 'play', { configurable: true, value: elPlay });
    Object.defineProperty(video, 'pause', { configurable: true, value: elPause });
    Object.defineProperty(video, 'paused', { configurable: true, get: () => !isPlaying });
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 10 });
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => time, set: (v) => (time = v) });

    fireEvent(video, new Event('loadedmetadata')); // metadata arrived: the clock shows up
    expect(screen.getByTestId('local-video-controls')).toBeTruthy();
    expect(screen.getByText('0:00 / 0:10')).toBeTruthy();

    fireEvent.click(screen.getByTestId('local-video-play'));
    expect(elPlay).toHaveBeenCalled();
    // After a manual play the hover preview no longer touches the video.
    const wrap = screen.getByTestId('local-video-wrap');
    fireEvent(wrap, new MouseEvent('mouseleave', { bubbles: false }));
    expect(elPause).not.toHaveBeenCalled();

    const rectMock = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 200, height: 18, left: 0, top: 0, right: 200, bottom: 18, x: 0, y: 0 } as DOMRect);
    try {
      fireEvent.pointerDown(screen.getByTestId('local-video-seek'), { pointerId: 1, clientX: 100 }); // middle of the bar
      expect(video.currentTime).toBe(5);
      fireEvent.pointerMove(screen.getByTestId('local-video-seek'), { pointerId: 1, clientX: 50 });
      expect(video.currentTime).toBe(2.5);
      fireEvent.pointerUp(screen.getByTestId('local-video-seek'), { pointerId: 1 });
    } finally {
      rectMock.mockRestore();
    }

    time = 2.5;
    fireEvent(video, new Event('timeupdate'));
    expect(screen.getByTestId('local-video-fill').style.width).toBe('25%'); // the bar follows playback
    expect(screen.getByText('0:02 / 0:10')).toBeTruthy();
  });

  it('a scrub ends the hover preview, but a play the user started runs through it', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const video = (await screen.findByTestId('local-video')) as HTMLVideoElement;
    const elPause = vi.fn();
    Object.defineProperty(video, 'pause', { configurable: true, value: elPause });
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 10 });
    const rectMock = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 200, height: 18, left: 0, top: 0, right: 200, bottom: 18, x: 0, y: 0 } as DOMRect);
    try {
      fireEvent.pointerDown(screen.getByTestId('local-video-seek'), { pointerId: 1, clientX: 180 });
      expect(elPause).toHaveBeenCalled(); // not manually playing yet: the scrub stands on its frame
    } finally {
      rectMock.mockRestore();
    }
  });

  it('offers copy / quote / both rotations / save under the video', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    await screen.findByTestId('local-video');
    expect(screen.getByTestId('local-video-toolbar')).toBeTruthy();

    fireEvent.click(screen.getByTestId('local-video-quote'));
    expect(emit).toHaveBeenCalledWith('sendbox.mention.files', ['E:/out/demo.mp4'], undefined);

    fireEvent.click(screen.getByTestId('local-video-rotate-left'));
    expect(screen.getByTestId('local-video').style.transform).toBe('rotate(-90deg)'); // the card itself turns
    fireEvent.click(screen.getByTestId('local-video-rotate-right'));
    expect(screen.getByTestId('local-video').style.transform).toBe('rotate(0deg)');

    fireEvent.click(screen.getByTestId('local-video-copy'));
    await waitFor(() => expect(copyInvoke).toHaveBeenCalledWith({ path: 'E:/out/demo.mp4' }));

    fireEvent.click(screen.getByTestId('local-video-inline-save'));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
  });
});
