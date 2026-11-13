import { ipcBridge } from '@/common';
import { Download, LoadingTwo, PlayOne } from '@icon-park/react';
import { Message } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useConversationContextSafe } from '@renderer/hooks/context/ConversationContext';
import { iconColors } from '@/renderer/styles/colors';
import { downloadFileFromPath } from '@/renderer/utils/file/download';

const TOOL_BUTTON: React.CSSProperties = {
  minWidth: '34px',
  height: '30px',
  padding: '0 10px',
  borderRadius: '6px',
  border: '1px solid rgba(255,255,255,.28)',
  background: 'rgba(20,20,20,.75)',
  color: '#fff',
  fontSize: '14px',
  lineHeight: 1,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '4px',
};

/** A local video of a reply: it plays while the pointer is over it, and a click opens it large
 *  (already playing) with zoom, rotation and a save button — the same gestures a local image of
 *  a reply has. The overlay is portaled to the body: a fixed layer inside the transcript is
 *  trapped by its ancestors' transforms. */
const LocalVideoView: React.FC<{ src: string; title: string }> = ({ src, title }) => {
  const { t } = useTranslation();
  const root = useConversationContextSafe()?.workspace ?? '';
  const inlineRef = useRef<HTMLVideoElement>(null);
  const modalRef = useRef<HTMLVideoElement>(null);
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [turns, setTurns] = useState(0);

  // The file is loaded through the same fs bridge an image uses (data: URL), because the
  // renderer may not load arbitrary local paths directly.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ipcBridge.fs.getImageBase64
      .invoke({ path: src, workspace: root || undefined })
      .then((base64) => {
        if (alive) setUrl(base64 || null);
      })
      .catch((error) => {
        console.error('[LocalVideoView] Failed to load video:', { path: src, error });
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [src, root]);

  // React's muted prop reaches the element inconsistently, and Chromium then treats the video
  // as unmuted: play() without a user gesture — hover is none — is rejected, and the catch
  // below swallows it. Setting muted imperatively right before play makes hover-play reliable.
  const [diag, setDiag] = useState('');
  const instance = useMemo(() => {
    const w = window as Window & typeof globalThis & { __vvCount?: number };
    const count = (w.__vvCount = (w.__vvCount ?? 0) + 1);
    return count;
  }, []);
  const startInline = useCallback(() => {
    const video = inlineRef.current;
    if (!video) return;
    video.muted = true;
    video.defaultMuted = true;
    setDiag(`#${instance} enter m=${video.muted} r=${video.readyState}`);
    video
      .play()
      .then(() => setDiag(`#${instance} ▶`))
      .catch((error: DOMException) => setDiag(`#${instance} ${error.name}`));
  }, [instance]);
  const stopInline = useCallback(() => {
    inlineRef.current?.pause();
  }, []);

  // Opening the overlay plays the large video at once (it is muted, so autoplay is allowed) and
  // stops the small one; Esc closes.
  useEffect(() => {
    if (!open) return;
    inlineRef.current?.pause();
    const large = modalRef.current;
    if (large) {
      large.muted = true;
      large.defaultMuted = true;
      void large.play().catch(() => {});
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const save = useCallback(async (): Promise<void> => {
    const name = src.split(/[/\\]/).pop() || 'video.mp4';
    try {
      await downloadFileFromPath(src, name, root || undefined);
    } catch (error) {
      console.error('[LocalVideoView] Failed to download video:', { path: src, error });
      Message.error(t('acp.image.download_error'));
    }
  }, [src, root, t]);

  const name = useMemo(() => src.split(/[/\\]/).pop() || 'video.mp4', [src]);

  // React's synthetic mouseenter never arrives in the transcript (its mouseover/out pairing
  // breaks there), while mousemove does; native listeners on the node are not affected.
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const enter = () => startInline();
    const leave = () => stopInline();
    node.addEventListener('mouseenter', enter);
    node.addEventListener('mouseleave', leave);
    return () => {
      node.removeEventListener('mouseenter', enter);
      node.removeEventListener('mouseleave', leave);
    };
    // `url` re-runs this once the loading placeholder (which carries no wrapper node) gave
    // way to the real one, so the listeners are attached to the node that is actually shown.
  }, [startInline, stopInline, url]);

  if (url === null)
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <LoadingTwo theme='outline' size='14' fill={iconColors.primary} strokeWidth={2} />
        <span>{title}</span>
      </span>
    );

  const overlay = open
    ? createPortal(
        <div
          role='dialog'
          aria-modal='true'
          data-testid='local-video-modal'
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,.8)',
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            style={{
              zIndex: 1,
              transform: `scale(${scale}) rotate(${turns * 90}deg)`,
              transition: 'transform .2s ease',
            }}
          >
            <video
              ref={modalRef}
              src={url}
              title={title}
              muted
              loop
              playsInline
              controls
              autoPlay
              preload='metadata'
              // A quarter turn swaps the video's axes: keep it inside the view, so a turned
              // wide video cannot reach the toolbar the way it otherwise would.
              style={
                turns % 2 === 1
                  ? { maxWidth: '72vh', maxHeight: '62vw', borderRadius: '8px', display: 'block', background: '#000' }
                  : { maxWidth: '90vw', maxHeight: '74vh', borderRadius: '8px', display: 'block', background: '#000' }
              }
            />
          </div>
          <div
            style={{
              position: 'absolute',
              bottom: '28px',
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 2,
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              padding: '6px',
              borderRadius: '10px',
              background: 'rgba(20,20,20,.82)',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type='button'
              style={TOOL_BUTTON}
              data-testid='local-video-zoom-in'
              onClick={() => setScale((v) => Math.min(v + 0.25, 3))}
            >
              +
            </button>
            <button
              type='button'
              style={TOOL_BUTTON}
              data-testid='local-video-zoom-out'
              onClick={() => setScale((v) => Math.max(v - 0.25, 0.5))}
            >
              −
            </button>
            <button type='button' style={TOOL_BUTTON} onClick={() => setScale(1)}>
              {Math.round(scale * 100)}%
            </button>
            <button
              type='button'
              style={TOOL_BUTTON}
              data-testid='local-video-rotate'
              onClick={() => setTurns((v) => v + 1)}
            >
              ↻
            </button>
            <button type='button' style={TOOL_BUTTON} data-testid='local-video-save' onClick={() => void save()}>
              <Download theme='outline' size='14' fill='#fff' />
            </button>
            <button type='button' style={TOOL_BUTTON} data-testid='local-video-close' onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <span
      ref={wrapRef}
      data-testid='local-video-wrap'
      style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}
    >
      <video
        ref={inlineRef}
        src={url}
        title={title}
        muted
        loop
        playsInline
        preload='metadata'
        data-testid='local-video'
        style={{ maxWidth: '100%', maxHeight: '360px', borderRadius: '8px', display: 'block', background: '#000' }}
      />
      <span
        aria-hidden='true'
        style={{
          position: 'absolute',
          inset: 'auto auto 8px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '2px 8px',
          borderRadius: '999px',
          background: 'rgba(0,0,0,.55)',
          color: '#fff',
          fontSize: '12px',
          pointerEvents: 'none',
        }}
      >
        <PlayOne theme='filled' size='12' fill='#fff' />
        {diag || name}
      </span>
      <button
        type='button'
        aria-label={t('common.open', { defaultValue: 'Open' })}
        onClick={() => setOpen(true)}
        data-testid='local-video-open'
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          cursor: 'zoom-in',
          background: 'transparent',
          border: 'none',
        }}
      />
      {overlay}
    </span>
  );
};

export default LocalVideoView;
