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
  it('shows the video without pointer autoplay: hovering alone plays nothing', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    await screen.findByTestId('local-video');
    expect(invoke).toHaveBeenCalledWith({ path: 'E:/out/demo.mp4', workspace: undefined });
    const wrap = screen.getByTestId('local-video-wrap');
    fireEvent(wrap, new MouseEvent('mouseenter', { bubbles: false }));
    fireEvent(wrap, new MouseEvent('mouseleave', { bubbles: false }));
    expect(play).not.toHaveBeenCalled(); // only the button plays
    expect(pause).not.toHaveBeenCalled();
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

  it('plays loop and speed from the overlay toolbar, in step with the card', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    await screen.findByTestId('local-video');
    const inline = screen.getByTestId('local-video');
    fireEvent.click(screen.getByTestId('local-video-open'));
    const large = screen.getByTestId('local-video-modal').querySelector('video') as HTMLVideoElement;
    // loop toggles both videos at once
    expect(large.hasAttribute('loop')).toBe(false);
    fireEvent.click(screen.getByTestId('local-video-modal-loop'));
    expect(large.hasAttribute('loop')).toBe(true);
    expect(inline.hasAttribute('loop')).toBe(true);
    fireEvent.click(screen.getByTestId('local-video-modal-loop'));
    expect(large.hasAttribute('loop')).toBe(false);
    // a speed pick from the overlay reaches both videos
    fireEvent.click(screen.getByTestId('local-video-modal-rate'));
    fireEvent.click(screen.getByTestId('local-video-modal-rate-2'));
    expect(large.playbackRate).toBe(2);
    expect(inline.playbackRate).toBe(2);
    expect(screen.getByTestId('local-video-rate').textContent).toBe('2x');
    expect(screen.queryByTestId('local-video-modal-rate-menu')).toBeNull(); // menu closes after the pick
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

  it('recognizes a click on the native progress bar by the playhead jumping, and pauses there', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    await screen.findByTestId('local-video');
    fireEvent.click(screen.getByTestId('local-video-open'));
    pause.mockClear();
    const large = screen.getByTestId('local-video-modal').querySelector('video')! as HTMLVideoElement;
    let time = 1.5;
    Object.defineProperty(large, 'currentTime', { configurable: true, get: () => time, set: (v) => (time = v) });
    fireEvent(large, new Event('timeupdate')); // playback was here a moment ago
    time = 8.2; // a click on the native bar: the playhead jumps far beyond playback's reach
    fireEvent(large, new Event('seeking'));
    fireEvent(large, new Event('seeked'));
    expect(pause).toHaveBeenCalled();
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
    // The pointer over the video does not start or stop anything on its own.
    const wrap = screen.getByTestId('local-video-wrap');
    fireEvent(wrap, new MouseEvent('mouseenter', { bubbles: false }));
    fireEvent(wrap, new MouseEvent('mouseleave', { bubbles: false }));
    expect(elPlay).toHaveBeenCalledTimes(1);
    expect(elPause).not.toHaveBeenCalled();

    // A play runs once by default; the loop button switches the mode on both videos.
    const cardVideo = screen.getByTestId('local-video') as HTMLVideoElement;
    expect(cardVideo.hasAttribute('loop')).toBe(false);
    fireEvent.click(screen.getByTestId('local-video-loop'));
    expect(cardVideo.hasAttribute('loop')).toBe(true);
    expect(screen.getByTestId('local-video-loop').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('local-video-loop'));
    expect(cardVideo.hasAttribute('loop')).toBe(false);

    // The speed button offers rates; picking one changes the video and the button's label.
    fireEvent.click(screen.getByTestId('local-video-rate'));
    expect(screen.getByTestId('local-video-rate-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('local-video-rate-2'));
    expect(cardVideo.playbackRate).toBe(2);
    expect(screen.getByTestId('local-video-rate').textContent).toBe('2x');
    expect(screen.queryByTestId('local-video-rate-menu')).toBeNull(); // picked: the menu closes

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

  it('a pick on the bar stops the video on that frame, playing or not', async () => {
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
      expect(video.currentTime).toBe(9);
      expect(elPause).toHaveBeenCalled(); // it stands on the frame the user picked
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
