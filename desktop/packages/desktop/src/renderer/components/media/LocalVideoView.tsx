import { ipcBridge } from '@/common';
import { Download, LoadingTwo, PlayOne } from '@icon-park/react';
import { Message } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversationContextSafe } from '@renderer/hooks/context/ConversationContext';
import { iconColors } from '@/renderer/styles/colors';
import { downloadFileFromPath } from '@/renderer/utils/file/download';

/** A local video of a reply: it plays while the pointer is over it, and a click opens it large
 *  with zoom, rotation and a save button — the same gestures a local image of a reply has. */
const LocalVideoView: React.FC<{ src: string; title: string }> = ({ src, title }) => {
  const { t } = useTranslation();
  const root = useConversationContextSafe()?.workspace ?? '';
  const videoRef = useRef<HTMLVideoElement>(null);
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

  const play = useCallback(() => {
    void videoRef.current?.play().catch(() => {});
  }, []);
  const pause = useCallback(() => videoRef.current?.pause(), []);

  const save = useCallback(async (): Promise<void> => {
    const name = src.split(/[/\\]/).pop() || 'video.mp4';
    try {
      await downloadFileFromPath(src, name, root || undefined);
    } catch (error) {
      console.error('[LocalVideoView] Failed to download video:', { path: src, error });
      Message.error(t('acp.image.download_error'));
    }
  }, [src, root, t]);

  // Esc closes the overlay.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const name = useMemo(() => src.split(/[/\\]/).pop() || 'video.mp4', [src]);

  if (url === null)
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <LoadingTwo theme='outline' size='14' fill={iconColors.primary} strokeWidth={2} />
        <span>{title}</span>
      </span>
    );

  const video = (controls: boolean, large: boolean): React.ReactElement => (
    <video
      ref={videoRef}
      src={url}
      title={title}
      muted
      loop
      playsInline
      controls={controls}
      preload='metadata'
      data-testid='local-video'
      style={{
        maxWidth: '100%',
        maxHeight: large ? '80vh' : '360px',
        borderRadius: '8px',
        display: 'block',
        background: '#000',
      }}
      onMouseEnter={() => !open && play()}
      onMouseLeave={() => !open && pause()}
    />
  );

  return (
    <span style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
      {video(false, false)}
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
        {name}
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
      {open ? (
        <span
          role='dialog'
          aria-modal='true'
          data-testid='local-video-modal'
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1100,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            background: 'rgba(0,0,0,.72)',
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <span
            style={{
              display: 'block',
              transform: `scale(${scale}) rotate(${turns * 90}deg)`,
              transition: 'transform .2s ease',
            }}
          >
            {video(true, true)}
          </span>
          <span
            style={{ display: 'flex', gap: '8px', alignItems: 'center' }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type='button'
              data-testid='local-video-zoom-in'
              onClick={() => setScale((v) => Math.min(v + 0.25, 3))}
            >
              +
            </button>
            <button
              type='button'
              data-testid='local-video-zoom-out'
              onClick={() => setScale((v) => Math.max(v - 0.25, 0.5))}
            >
              −
            </button>
            <button type='button' onClick={() => setScale(1)}>
              {Math.round(scale * 100)}%
            </button>
            <button type='button' data-testid='local-video-rotate' onClick={() => setTurns((v) => v + 1)}>
              ↻
            </button>
            <button type='button' data-testid='local-video-save' onClick={() => void save()}>
              <Download theme='outline' size='14' />
            </button>
            <button type='button' data-testid='local-video-close' onClick={() => setOpen(false)}>
              ✕
            </button>
          </span>
        </span>
      ) : null}
    </span>
  );
};

export default LocalVideoView;
