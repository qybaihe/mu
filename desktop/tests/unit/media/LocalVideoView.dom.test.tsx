/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A local video of a reply: streamed from the backend (never base64), one <video> element at a
 * time, a failed load showing an error state instead of spinning, loop restarts not mistaken
 * for user picks, and an overlay that takes the element over and gives it back on Esc.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LocalVideoView from '@/renderer/components/media/local/LocalVideoView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { copyInvoke, downloadFromRef } = vi.hoisted(() => ({
  copyInvoke: vi.fn(async () => true),
  downloadFromRef: vi.fn(async () => {}),
}));
const { emit } = vi.hoisted(() => ({ emit: vi.fn() }));
const { copyText } = vi.hoisted(() => ({ copyText: vi.fn(async () => {}) }));
vi.mock('@/common', () => ({ ipcBridge: { fs: { copyFileToClipboard: { invoke: copyInvoke } } } }));
vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit } }));
vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText }));
vi.mock('@/renderer/utils/file/download', () => ({ downloadFileFromRef: downloadFromRef }));
vi.mock('@/renderer/utils/file/fileUrls', () => ({
  buildFileStreamUrl: (ref: { kind: string; path: string }) => `/api/fs/stream?kind=${ref.kind}&path=${ref.path}`,
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return {
    ...actual,
    Message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  };
});

// jsdom has no media playback.
const play = vi.fn(() => Promise.resolve());
const pause = vi.fn();
beforeEach(() => {
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', { writable: true, value: play });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', { writable: true, value: pause });
  play.mockClear();
  pause.mockClear();
  copyInvoke.mockClear();
  copyInvoke.mockResolvedValue(true);
  downloadFromRef.mockClear();
  emit.mockClear();
  copyText.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Give the video a finite duration and announce metadata, the way a real load does. */
const loadVideo = (video: HTMLVideoElement, duration: number, w = 160, h = 90): void => {
  Object.defineProperty(video, 'duration', { configurable: true, value: duration });
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: w });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: h });
  fireEvent(video, new Event('loadedmetadata'));
};

/** jsdom has no playback: the paused flag is what the element tells the controls, set by hand. */
const setPaused = (video: HTMLVideoElement, paused: boolean): void => {
  Object.defineProperty(video, 'paused', { configurable: true, value: paused });
};

describe('LocalVideoView', () => {
  it('streams the video from the backend range route — one element, no base64 in memory', () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const video = screen.getByTestId('local-video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/api/fs/stream?kind=local&path=E:/out/demo.mp4');
    expect(video.getAttribute('src')).not.toContain('data:');
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(video.getAttribute('preload')).toBe('metadata');
  });

  it('plays and pauses from the button, whatever the element itself reports', () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const video = screen.getByTestId('local-video') as HTMLVideoElement;
    setPaused(video, true);
    const button = screen.getByTestId('local-video-play');
    expect(button.getAttribute('aria-label')).toBe('acp.video.play');
    fireEvent.click(button);
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent(video, new Event('play'));
    expect(screen.getByTestId('local-video-play').getAttribute('aria-label')).toBe('acp.video.pause');
    setPaused(video, false);
    fireEvent.click(screen.getByTestId('local-video-play'));
    expect(pause).toHaveBeenCalledTimes(1);
    fireEvent(video, new Event('pause'));
    expect(screen.getByTestId('local-video-play').getAttribute('aria-label')).toBe('acp.video.play');
  });

  it('a pick on the bar pauses on the chosen frame', () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const video = screen.getByTestId('local-video') as HTMLVideoElement;
    loadVideo(video, 120);
    const handle = document.querySelector('[data-testid="local-video-controls"] [role="slider"]');
    expect(handle).toBeTruthy();
    pause.mockClear();
    (handle as HTMLElement).focus();
    fireEvent.keyDown(handle as Element, { key: 'ArrowRight', keyCode: 39 });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBeGreaterThan(0);
  });

  it('keeps looping: the restart back to the start is playback, not a pick, and never pauses', () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const video = screen.getByTestId('local-video') as HTMLVideoElement;
    loadVideo(video, 120);
    fireEvent.click(screen.getByTestId('local-video-loop'));
    expect(video.hasAttribute('loop')).toBe(true);
    fireEvent.click(screen.getByTestId('local-video-play'));
    fireEvent(video, new Event('play'));
    video.currentTime = 119.6;
    fireEvent(video, new Event('timeupdate'));
    // The loop restarts — a seek the playback itself caused; at 3x the ticks jump too.
    pause.mockClear();
    video.currentTime = 0;
    fireEvent(video, new Event('seeking'));
    fireEvent(video, new Event('seeked'));
    fireEvent(video, new Event('timeupdate'));
    expect(pause).not.toHaveBeenCalled();
    // The badge follows the playback: it never said the video stopped.
    expect(screen.getByTestId('local-video-play').getAttribute('aria-label')).toBe('acp.video.pause');
    // Toggling loop off drops the attribute again.
    fireEvent.click(screen.getByTestId('local-video-loop'));
    expect(video.hasAttribute('loop')).toBe(false);
  });

  it('a speed pick reaches the element and the label', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const video = screen.getByTestId('local-video') as HTMLVideoElement;
    fireEvent.click(screen.getByTestId('local-video-rate'));
    fireEvent.click(await screen.findByTestId('local-video-rate-2'));
    await waitFor(() => expect(video.playbackRate).toBe(2));
    expect(screen.getByTestId('local-video-rate').textContent).toContain('2x');
  });

  it('opens the overlay with the one element lent over — zoom, rotation both ways, save — and Esc gives it back', () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    let video = screen.getByTestId('local-video') as HTMLVideoElement;
    loadVideo(video, 120);
    video.currentTime = 10;
    fireEvent(video, new Event('timeupdate'));
    fireEvent.click(screen.getByTestId('local-video-open'));
    const modal = screen.getByTestId('local-video-modal'); // portaled to the body
    expect(modal).toBeTruthy();
    // Still exactly one video element: the overlay borrowed it, the card holds its place.
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(modal.contains(document.querySelector('video'))).toBe(true);
    // It stands where it stood when the overlay took it over.
    const lent = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(lent, 'duration', { configurable: true, value: 120 });
    fireEvent(lent, new Event('loadedmetadata'));
    expect(lent.currentTime).toBe(10);
    // The overlay's own controls work.
    fireEvent.click(screen.getByTestId('local-video-zoom-in'));
    fireEvent.click(screen.getByTestId('local-video-modal-rotate-left'));
    fireEvent.click(screen.getByTestId('local-video-rotate'));
    fireEvent.click(screen.getByTestId('local-video-save'));
    expect(downloadFromRef).toHaveBeenCalledWith({ kind: 'local', path: 'E:/out/demo.mp4' }, 'demo.mp4');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('local-video-modal')).toBeNull();
    // The element came back to the card — still exactly one.
    expect(document.querySelectorAll('video')).toHaveLength(1);
    video = screen.getByTestId('local-video') as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
    fireEvent(video, new Event('loadedmetadata'));
    expect(video.currentTime).toBe(10);
  });

  it('starts with the sound on, mute buttons control it on card and overlay, and rotation lives only in the overlay', () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const video = screen.getByTestId('local-video') as HTMLVideoElement;
    loadVideo(video, 120);
    expect(video.muted).toBe(false);
    fireEvent.click(screen.getByTestId('local-video-mute'));
    expect(video.muted).toBe(true);
    // The inline toolbar has no rotate buttons; the overlay keeps both rotations and its own mute of the same sound.
    expect(screen.queryByTestId('local-video-rotate-right')).toBeNull();
    fireEvent.click(screen.getByTestId('local-video-open'));
    fireEvent.click(screen.getByTestId('local-video-modal-mute'));
    expect((document.querySelector('video') as HTMLVideoElement).muted).toBe(false);
    expect(screen.getByTestId('local-video-modal-rotate-left')).toBeTruthy();
  });

  it('a turned overlay video swaps its layout box so the toolbar stays on screen', () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const video = screen.getByTestId('local-video') as HTMLVideoElement;
    loadVideo(video, 120);
    fireEvent.click(screen.getByTestId('local-video-open'));
    const lent = document.querySelector('video') as HTMLVideoElement;
    expect(lent.style.transform).toBe('rotate(0deg)');
    fireEvent.click(screen.getByTestId('local-video-rotate'));
    expect(lent.style.transform).toBe('rotate(90deg)');
    // The stage carries the turned box: its width is the video's height, and vice versa.
    const stage = lent.parentElement as HTMLElement;
    expect(parseFloat(stage.style.width)).toBeCloseTo(parseFloat(lent.style.height));
    expect(parseFloat(stage.style.height)).toBeCloseTo(parseFloat(lent.style.width));
    fireEvent.click(screen.getByTestId('local-video-rotate'));
    expect(lent.style.transform).toBe('rotate(180deg)');
  });

  it('the overlay toolbar follows the image preview order: zoom, rotation, then the rest', () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const video = screen.getByTestId('local-video') as HTMLVideoElement;
    loadVideo(video, 120);
    fireEvent.click(screen.getByTestId('local-video-open'));
    const toolbar = (screen.getByTestId('local-video-modal-play') as HTMLElement).parentElement as HTMLElement;
    const ids = Array.from(toolbar.querySelectorAll('[data-testid]'))
      .map((el) => el.getAttribute('data-testid'))
      .filter((id): id is string => id !== null);
    const order = [
      'local-video-modal-play',
      'local-video-zoom-in',
      'local-video-zoom-out',
      'local-video-zoom-reset',
      'local-video-modal-rotate-left',
      'local-video-rotate',
      'local-video-modal-loop',
      'local-video-modal-rate',
      'local-video-modal-mute',
      'local-video-save',
    ];
    expect(ids.filter((id) => order.includes(id))).toEqual(order);
  });

  it('the overlay toolbar carries its own play/pause that drives the lent element', () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    const card = screen.getByTestId('local-video') as HTMLVideoElement;
    loadVideo(card, 120);
    setPaused(card, true);
    fireEvent.click(screen.getByTestId('local-video-open'));
    const lent = document.querySelector('video') as HTMLVideoElement;
    fireEvent.click(screen.getByTestId('local-video-modal-play'));
    expect(play).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('local-video-modal-play'));
    expect(lent.paused).toBe(true);
  });

  it('plays, loops and re-rates from the overlay toolbar in step with the card', () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    fireEvent.click(screen.getByTestId('local-video-open'));
    const video = document.querySelector('video') as HTMLVideoElement;
    fireEvent.click(screen.getByTestId('local-video-modal-loop'));
    expect(video.hasAttribute('loop')).toBe(true);
    fireEvent.click(screen.getByTestId('local-video-modal-loop'));
    expect(video.hasAttribute('loop')).toBe(false);
    setPaused(video, true);
    fireEvent.click(screen.getByTestId('local-video-play'));
    expect(play).toHaveBeenCalled();
  });

  it('a failed load shows an error state with a retry, and never spins', () => {
    render(<LocalVideoView src='E:/out/gone.mp4' title='gone' />);
    const video = screen.getByTestId('local-video') as HTMLVideoElement;
    fireEvent(video, new Event('error'));
    expect(screen.getByTestId('local-video-error')).toBeTruthy();
    expect(screen.getByTestId('local-video-error').textContent).toContain('acp.video.load_failed');
    expect(document.querySelector('video')).toBeNull();
    // A retry drops the error state and asks the stream again with a fresh element.
    fireEvent.click(screen.getByTestId('local-video-retry'));
    const retried = screen.getByTestId('local-video') as HTMLVideoElement;
    expect(retried).not.toBe(video);
    expect(retried.getAttribute('src')).toContain('_r=1');
  });

  it('copy puts the file on the OS clipboard; a refusal falls back to the path', async () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    fireEvent.click(screen.getByTestId('local-video-copy'));
    await waitFor(() => expect(copyInvoke).toHaveBeenCalledWith({ path: 'E:/out/demo.mp4' }));
    copyInvoke.mockRejectedValueOnce(new Error('UNSUPPORTED_PLATFORM:linux'));
    fireEvent.click(screen.getByTestId('local-video-copy'));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('E:/out/demo.mp4'));
  });

  it('fails fast when no provider answers (WebUI): the invoke times out and the path is copied', async () => {
    copyInvoke.mockImplementation(() => new Promise<boolean>(() => {}));
    vi.useFakeTimers();
    try {
      render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
      fireEvent.click(screen.getByTestId('local-video-copy'));
      await vi.advanceTimersByTimeAsync(4500);
      expect(copyText).toHaveBeenCalledWith('E:/out/demo.mp4');
    } finally {
      vi.useRealTimers();
    }
  });

  it('quote hands the file to the send box as an attachment chip', () => {
    render(<LocalVideoView src='E:/out/demo.mp4' title='demo' />);
    fireEvent.click(screen.getByTestId('local-video-quote'));
    expect(emit).toHaveBeenCalledWith('sendbox.mention.files', ['E:/out/demo.mp4'], undefined);
  });
});
