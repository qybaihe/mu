/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { joinPath } from '@/common/chat/chatLib';
import { isVideoPath } from '@/common/chat/fileRefs/pathLike';
import { localFileRef } from '@/common/types/chatFile';
import { Button, Dropdown, Menu, Message, Slider } from '@arco-design/web-react';
import {
  Copy,
  Cycle,
  Download,
  Link,
  Mute,
  Pause,
  PlayOne,
  Refresh,
  VideoTwo,
  VolumeDown,
  ZoomIn,
  ZoomOut,
} from '@icon-park/react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useConversationContextSafe } from '@renderer/hooks/context/ConversationContext';
import { downloadFileFromRef } from '@/renderer/utils/file/download';
import { buildFileStreamUrl } from '@/renderer/utils/file/fileUrls';
import { emitter } from '@/renderer/utils/emitter';
import { copyText } from '@/renderer/utils/ui/clipboard';
import styles from './LocalVideoView.module.css';

const RATES = [0.5, 1, 1.5, 2, 3];
/** The zoom ladder: settled steps, so every step is a literal UnoCSS class. */
const ZOOM_STEPS: Array<{ factor: number; className: string }> = [
  { factor: 0.5, className: 'scale-50' },
  { factor: 0.75, className: 'scale-75' },
  { factor: 1, className: 'scale-100' },
  { factor: 1.25, className: 'scale-125' },
  { factor: 1.5, className: 'scale-150' },
  { factor: 2, className: 'scale-200' },
  { factor: 2.5, className: 'scale-250' },
  { factor: 3, className: 'scale-300' },
];

const fmtClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** The nearest ancestor that actually scrolls (taller than its own box), if any. */
const scrollerOf = (start: HTMLElement | null): { el: HTMLElement; top: number } | null => {
  let el: HTMLElement | null = start?.parentElement ?? null;
  while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
  return el ? { el, top: el.scrollTop } : null;
};

/** Fail an invoke that no provider answers (WebUI with no desktop process) instead of hanging forever. */
const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('BRIDGE_TIMEOUT')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/**
 * A local video of a reply: it plays from the button, and a click opens it large with zoom,
 * rotation and save — the video sibling of what LocalImageView does for images. The file is
 * streamed from the backend (`/api/fs/stream`, the PDF preview's byte-range route) — never
 * carried whole into renderer memory — and there is exactly one <video> element: while the
 * overlay is open it is lent there, and its playhead comes back when it closes.
 */
const LocalVideoView: React.FC<{ src: string; title: string }> = ({ src, title }) => {
  const { t } = useTranslation();
  const conversation = useConversationContextSafe();
  const root = conversation?.workspace ?? '';
  const conversationId = conversation?.conversation_id;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  // A retry drops the failed state and remounts the video (key), with a cache-busting suffix.
  const [attempt, setAttempt] = useState(0);
  const [zoomIndex, setZoomIndex] = useState(ZOOM_STEPS.findIndex((step) => step.factor === 1));
  const [turn, setTurn] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  // A play from the button runs once by default; the loop button switches the mode.
  const [looping, setLooping] = useState(false);
  const [muted, setMuted] = useState(false);
  const [intrinsic, setIntrinsic] = useState<{ w: number; h: number } | null>(null);
  const [lentSize, setLentSize] = useState<{ w: number; height: number } | null>(null);
  // The transcript scroller and where it stood, to put back if a swap frame moves it.
  const scrollHomeRef = useRef<{ el: HTMLElement; top: number } | null>(null);
  // One speed for the video wherever it is watched: the card's menu and the overlay's share it.
  const [rate, setRate] = useState(1);
  // Where the element's playback stands when it is lent to the overlay or borrowed back.
  const resumeAt = useRef<number | null>(null);
  const resumePlaying = useRef(false);

  // The card's actions need the file where it really is; markdown may hand over a path
  // relative to the workspace, the same resolution a local image does.
  const absolutePath = useMemo(() => {
    if (!root || src.startsWith('/') || src.startsWith('\\') || src.startsWith('file:') || /^[A-Za-z]:/.test(src)) {
      return src;
    }
    return joinPath(root, src);
  }, [src, root]);

  // Streamed, not base64: the backend serves the bytes with Range support, so the browser
  // buffers the video the way it streams any URL. A retry appends a suffix to bypass a
  // cached failed response.
  const streamUrl = useMemo(() => {
    const base = buildFileStreamUrl(localFileRef(absolutePath));
    return attempt > 0 ? `${base}&_r=${attempt}` : base;
  }, [absolutePath, attempt]);

  // The stage the video may fill in the overlay: the same visual budget the unturned video
  // keeps, so a quarter turn changes the video's orientation but not its size. Runs before
  // the failed-load early return so the hook count stays stable.
  const fitted = useMemo(() => {
    if (!intrinsic) return null;
    const availW = window.innerWidth * 0.9;
    const availH = window.innerHeight * 0.74;
    const scale = Math.min(availW / intrinsic.w, availH / intrinsic.h);
    return { w: intrinsic.w * scale, h: intrinsic.h * scale };
  }, [intrinsic]);

  const zoomStep = ZOOM_STEPS[zoomIndex] ?? ZOOM_STEPS[2];

  const pickRate = useCallback((value: number) => {
    setRate(value);
    if (videoRef.current) videoRef.current.playbackRate = value;
  }, []);

  // React's muted attribute is not applied as a property on mount (a long-standing quirk),
  // so the property itself is set here on every (re)mount and on every toggle, with the sound on by default.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    video.playbackRate = rate;
  });

  // Arco draws the slider's handle (role=slider) with no name of its own: give it the row's
  // word, so a screen reader says "Playback position, slider, 0:12".
  useEffect(() => {
    document
      .querySelector('[data-testid="local-video-controls"] [role="slider"]')
      ?.setAttribute('aria-label', t('acp.video.progress'));
  });

  const handleMetadata = useCallback(
    (video: HTMLVideoElement) => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      if (video.videoWidth > 0 && video.videoHeight > 0) setIntrinsic({ w: video.videoWidth, h: video.videoHeight });
      video.playbackRate = rate;
      // The element was lent or borrowed: stand where it stood, and run on if it was running.
      if (resumeAt.current !== null && video.currentTime !== resumeAt.current) {
        video.currentTime = resumeAt.current;
      }
      resumeAt.current = null;
      if (resumePlaying.current) {
        video.play().catch(() => {});
      }
      resumePlaying.current = false;
    },
    [rate]
  );

  const capturePosition = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    resumeAt.current = video.currentTime;
    resumePlaying.current = !video.paused && !video.ended;
  }, []);

  const openOverlay = useCallback(() => {
    capturePosition();
    // Hold the card's exact box while the element is lent out, so the transcript's
    // height (and so its scroll position) does not jump when the overlay opens.
    const v = videoRef.current;
    setLentSize(v && v.offsetHeight > 0 ? { w: v.offsetWidth, height: v.offsetHeight } : null);
    scrollHomeRef.current = scrollerOf(v);
    setOpen(true);
  }, [capturePosition]);

  const closeOverlay = useCallback(() => {
    capturePosition();
    scrollHomeRef.current = scrollerOf(videoRef.current);
    setOpen(false);
  }, [capturePosition]);

  // Opening or closing swaps the card's video for a placeholder inside the markdown shadow:
  // for one frame the box can dip and the transcript's scroller clamps its scrollTop, and
  // the height comes back but the scroll position does not. Whatever moved it, the reader's
  // place is put back before the frame is painted.
  useLayoutEffect(() => {
    const home = scrollHomeRef.current;
    if (!home || Math.abs(home.el.scrollTop - home.top) <= 0.5) return;
    home.el.scrollTop = home.top;
  });

  // Esc closes the overlay wherever the focus stands, handing the element back where it stood.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeOverlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeOverlay]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  // A pick on the bar is the user's frame, whatever is playing: the video stops right on it.
  const seekTo = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(value)) return;
    video.pause();
    video.currentTime = value;
    setCurrent(value);
  }, []);

  const save = useCallback(async (): Promise<void> => {
    const name = src.split(/[/\\]/).pop() || 'video.mp4';
    try {
      await downloadFileFromRef(localFileRef(absolutePath), name);
    } catch (error) {
      console.error('[LocalVideoView] Failed to download video:', { path: absolutePath, error });
      Message.error(t('acp.image.download_error'));
    }
  }, [absolutePath, src, t]);

  // "复制附件" puts the file itself on the OS clipboard (paste it into Explorer or a chat);
  // where no provider answers within the timeout (a WebUI with no desktop process) or the OS
  // offers no file clipboard, the path is copied instead — still useful, and honest.
  const copyFile = useCallback(async (): Promise<void> => {
    try {
      await withTimeout(ipcBridge.fs.copyFileToClipboard.invoke({ path: absolutePath }), 4000);
      Message.success(t('acp.video.copy_file_success'));
    } catch (error) {
      console.error('[LocalVideoView] Failed to copy video file to clipboard:', { path: absolutePath, error });
      await copyText(absolutePath);
      Message.warning(t('acp.video.copy_path_fallback'));
    }
  }, [absolutePath, t]);

  // 引用: hand the file to the send box as an attachment chip — the same event the
  // image preview's quote fires.
  const quote = useCallback(() => {
    emitter.emit('sendbox.mention.files', [absolutePath], conversationId);
  }, [absolutePath, conversationId]);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((value) => value + 1);
  }, []);

  if (failed)
    return (
      <span className='inline-flex items-center gap-6px max-w-full align-top' data-testid='local-video-error'>
        <VideoTwo theme='outline' size='14' className='flex-none text-t-tertiary' aria-hidden='true' />
        <span className='text-12px text-t-tertiary truncate' title={title} dir='auto'>
          {title}
        </span>
        <span className='text-12px text-t-tertiary whitespace-nowrap'>{t('acp.video.load_failed')}</span>
        <Button
          size='mini'
          type='text'
          data-testid='local-video-retry'
          onClick={retry}
          icon={<Refresh theme='outline' size='12' aria-hidden='true' />}
        >
          {t('acp.video.retry')}
        </Button>
      </span>
    );

  // Exactly one video element exists at any moment; while the overlay is open it lives there
  // and the card keeps its place with a quiet placeholder.
  const quarter = ((turn % 4) + 4) % 4;
  const oddTurn = quarter % 2 === 1;
  const video = (variant: 'card' | 'overlay'): React.JSX.Element => (
    <video
      key={attempt}
      ref={videoRef}
      src={streamUrl}
      title={title}
      loop={looping}
      playsInline
      preload='metadata'
      data-testid='local-video'
      // A quarter turn rotates only the pixels, not the layout box: a turned video still
      // reserved its upright height and pushed the toolbar off screen. The stage below
      // carries the turned box; this element centers in it and turns itself. On the card,
      // the box measured before the loan keeps the layout stable while the remounted
      // element loads, so the transcript does not scroll when the video comes back.
      style={
        variant === 'overlay' && fitted
          ? {
              position: 'absolute',
              inset: 0,
              margin: 'auto',
              width: fitted.w,
              height: fitted.h,
              transform: `rotate(${quarter * 90}deg)`,
            }
          : variant === 'card' && lentSize
            ? { width: lentSize.w, height: lentSize.height }
            : undefined
      }
      className={variant === 'overlay' ? styles.overlayVideo : styles.cardVideo}
      onLoadedMetadata={(event) => handleMetadata(event.currentTarget)}
      onTimeUpdate={(event) => {
        if (!scrubbing) setCurrent(event.currentTarget.currentTime);
      }}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={() => setPlaying(false)}
      onError={() => setFailed(true)}
    />
  );

  const rateMenu = (testId: string, buttonClassName?: string, popupContainer?: () => Element): React.JSX.Element => (
    <Dropdown
      trigger='click'
      position='top'
      triggerProps={{
        popupStyle: { zIndex: 1150 },
        ...(popupContainer ? { getPopupContainer: popupContainer } : {}),
      }}
      droplist={
        <Menu onClickMenuItem={(key) => pickRate(Number(key))} selectedKeys={[String(rate)]}>
          {RATES.map((value) => (
            <Menu.Item key={String(value)} data-testid={`${testId}-${value}`}>
              {value}x
            </Menu.Item>
          ))}
        </Menu>
      }
    >
      <Button type='text' size='mini' data-testid={testId} title={t('acp.video.speed')} className={buttonClassName}>
        {rate}x
      </Button>
    </Dropdown>
  );

  const overlay = open
    ? createPortal(
        <div
          role='dialog'
          aria-modal='true'
          data-testid='local-video-modal'
          className={styles.overlayRoot}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeOverlay();
          }}
        >
          <div className={styles.overlayCenter}>
            <div className={`${zoomStep.className} transition-transform duration-200`}>
              <div
                className={styles.turnWrap}
                style={
                  fitted
                    ? {
                        width: oddTurn ? fitted.h : fitted.w,
                        height: oddTurn ? fitted.w : fitted.h,
                        position: 'relative',
                      }
                    : undefined
                }
              >
                {video('overlay')}
              </div>
            </div>
            <div className={styles.overlayToolbar} onClick={(event) => event.stopPropagation()}>
              <Button
                type='text'
                data-testid='local-video-modal-play'
                title={playing ? t('acp.video.pause') : t('acp.video.play')}
                className={styles.overlayButton}
                onClick={togglePlay}
                icon={
                  playing ? (
                    <Pause theme='outline' size='14' aria-hidden='true' />
                  ) : (
                    <PlayOne theme='outline' size='14' aria-hidden='true' />
                  )
                }
              />
              <Button
                type='text'
                data-testid='local-video-zoom-in'
                title={t('acp.video.zoom_in')}
                className={styles.overlayButton}
                onClick={() => setZoomIndex((index) => Math.min(index + 1, ZOOM_STEPS.length - 1))}
                icon={<ZoomIn theme='outline' size='14' aria-hidden='true' />}
              />
              <Button
                type='text'
                data-testid='local-video-zoom-out'
                title={t('acp.video.zoom_out')}
                className={styles.overlayButton}
                onClick={() => setZoomIndex((index) => Math.max(index - 1, 0))}
                icon={<ZoomOut theme='outline' size='14' aria-hidden='true' />}
              />
              <Button
                type='text'
                data-testid='local-video-zoom-reset'
                title={t('acp.video.zoom_reset')}
                className={styles.overlayButton}
                onClick={() => setZoomIndex(ZOOM_STEPS.findIndex((step) => step.factor === 1))}
              >
                {Math.round(zoomStep.factor * 100)}%
              </Button>
              <Button
                type='text'
                data-testid='local-video-modal-rotate-left'
                title={t('acp.video.rotate_left')}
                className={styles.overlayButton}
                onClick={() => setTurn((value) => value - 1)}
              >
                ↺
              </Button>
              <Button
                type='text'
                data-testid='local-video-rotate'
                title={t('acp.video.rotate_right')}
                className={styles.overlayButton}
                onClick={() => setTurn((value) => value + 1)}
              >
                ↻
              </Button>
              <Button
                type='text'
                data-testid='local-video-modal-loop'
                aria-pressed={looping}
                title={looping ? t('acp.video.loop_on') : t('acp.video.loop_off')}
                className={looping ? `${styles.overlayButton} ${styles.overlayButtonActive}` : styles.overlayButton}
                onClick={() => setLooping((value) => !value)}
                icon={<Cycle theme='outline' size='14' aria-hidden='true' />}
              />
              {rateMenu(
                'local-video-modal-rate',
                styles.overlayButton,
                () => document.querySelector('[data-testid="local-video-modal"]') ?? document.body
              )}
              <Button
                type='text'
                data-testid='local-video-modal-mute'
                aria-pressed={muted}
                title={muted ? t('acp.video.unmute') : t('acp.video.mute')}
                className={muted ? `${styles.overlayButton} ${styles.overlayButtonActive}` : styles.overlayButton}
                onClick={() => setMuted((value) => !value)}
                icon={
                  muted ? (
                    <Mute theme='outline' size='14' aria-hidden='true' />
                  ) : (
                    <VolumeDown theme='outline' size='14' aria-hidden='true' />
                  )
                }
              />
              <Button
                type='text'
                data-testid='local-video-save'
                title={t('acp.image.download')}
                className={styles.overlayButton}
                onClick={() => void save()}
                icon={<Download theme='outline' size='14' aria-hidden='true' />}
              />
              <Button
                type='text'
                data-testid='local-video-close'
                title={t('acp.video.close')}
                className={styles.overlayButton}
                onClick={closeOverlay}
              >
                ✕
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <span className='inline-flex flex-col gap-6px max-w-full align-top'>
      <span className='relative inline-block max-w-full' data-testid='local-video-wrap'>
        {open ? (
          <span
            className={`${styles.cardVideo} ${styles.placeholderCard}`}
            style={lentSize ? { width: lentSize.w, height: lentSize.height } : undefined}
          />
        ) : (
          video('card')
        )}
        {open ? null : (
          <Button
            type='text'
            className='!absolute inset-0 !h-full !w-full !p-0 cursor-zoom-in'
            data-testid='local-video-open'
            aria-label={t('acp.video.open')}
            title={t('acp.video.open')}
            onClick={openOverlay}
          />
        )}
        {overlay}
      </span>
      <div className='flex items-center gap-8px max-w-full' data-testid='local-video-controls'>
        <Slider
          className='flex-1 min-w-120px'
          value={current}
          min={0}
          max={duration > 0 && Number.isFinite(duration) ? duration : 1}
          disabled={!(duration > 0 && Number.isFinite(duration))}
          formatTooltip={(value: number) => fmtClock(value)}
          onChange={(value) => {
            const next = Array.isArray(value) ? value[0] : value;
            if (!Number.isFinite(next)) return;
            setScrubbing(true);
            seekTo(next);
          }}
          onAfterChange={() => setScrubbing(false)}
        />
        {duration > 0 ? (
          <span className='text-12px text-t-tertiary whitespace-nowrap tabular-nums'>
            {fmtClock(current)} / {fmtClock(duration)}
          </span>
        ) : null}
      </div>
      <div className='flex items-center gap-4px flex-wrap max-w-full' data-testid='local-video-toolbar'>
        <Button
          type='text'
          size='mini'
          data-testid='local-video-play'
          aria-label={playing ? t('acp.video.pause') : t('acp.video.play')}
          title={playing ? t('acp.video.pause') : t('acp.video.play')}
          onClick={togglePlay}
          icon={
            playing ? (
              <Pause theme='filled' size='14' aria-hidden='true' />
            ) : (
              <PlayOne theme='filled' size='14' aria-hidden='true' />
            )
          }
        />
        <Button
          type='text'
          size='mini'
          data-testid='local-video-loop'
          aria-pressed={looping}
          title={looping ? t('acp.video.loop_on') : t('acp.video.loop_off')}
          className={looping ? '!text-primary' : undefined}
          onClick={() => setLooping((value) => !value)}
          icon={<Cycle theme='outline' size='14' aria-hidden='true' />}
        />
        <Button
          type='text'
          size='mini'
          data-testid='local-video-mute'
          aria-pressed={muted}
          title={muted ? t('acp.video.unmute') : t('acp.video.mute')}
          className={muted ? '!text-primary' : undefined}
          onClick={() => setMuted((value) => !value)}
          icon={
            muted ? (
              <Mute theme='outline' size='14' aria-hidden='true' />
            ) : (
              <VolumeDown theme='outline' size='14' aria-hidden='true' />
            )
          }
        />
        {rateMenu('local-video-rate')}
        <Button
          type='text'
          size='mini'
          data-testid='local-video-copy'
          title={t('acp.video.copy_file')}
          onClick={() => void copyFile()}
          icon={<Copy theme='outline' size='14' aria-hidden='true' />}
        />
        <Button
          type='text'
          size='mini'
          data-testid='local-video-quote'
          title={t('common.reply')}
          onClick={quote}
          icon={<Link theme='outline' size='14' aria-hidden='true' />}
        />
        <Button
          type='text'
          size='mini'
          data-testid='local-video-inline-save'
          title={t('acp.image.download')}
          onClick={() => void save()}
          icon={<Download theme='outline' size='14' aria-hidden='true' />}
        />
      </div>
    </span>
  );
};

export default LocalVideoView;
