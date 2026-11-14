import { ipcBridge } from '@/common';
import { joinPath } from '@/common/chat/chatLib';
import { Copy, Download, Link, LoadingTwo, Pause, PlayOne } from '@icon-park/react';
import { Message } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useConversationContextSafe } from '@renderer/hooks/context/ConversationContext';
import { iconColors } from '@/renderer/styles/colors';
import { downloadFileFromPath } from '@/renderer/utils/file/download';
import { emitter } from '@/renderer/utils/emitter';
import { copyText } from '@/renderer/utils/ui/clipboard';

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

// A quiet button of the toolbar under the video — theme-aware through Arco's CSS variables,
// unlike the overlay's white-on-dark TOOL_BUTTON which floats over a black layer.
const CARD_BUTTON: React.CSSProperties = {
  minWidth: '30px',
  height: '26px',
  padding: '0 7px',
  borderRadius: '6px',
  border: '1px solid var(--color-border-2, rgba(120,120,120,.35))',
  background: 'transparent',
  color: 'var(--color-text-2, inherit)',
  fontSize: '14px',
  lineHeight: 1,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const fmtClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** A local video of a reply: it plays while the pointer is over it, and a click opens it large
 *  (already playing) with zoom, rotation and a save button — the same gestures a local image of
 *  a reply has. The overlay is portaled to the body: a fixed layer inside the transcript is
 *  trapped by its ancestors' transforms. */
const LocalVideoView: React.FC<{ src: string; title: string }> = ({ src, title }) => {
  const { t } = useTranslation();
  const conversation = useConversationContextSafe();
  const root = conversation?.workspace ?? '';
  const conversationId = conversation?.conversation_id;
  const inlineRef = useRef<HTMLVideoElement>(null);
  const modalRef = useRef<HTMLVideoElement>(null);
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [turns, setTurns] = useState(0);
  // Set once the user has touched the overlay video: after that a seek is theirs, and the
  // autoplay the overlay opened with must not keep running through it.
  const modalTouched = useRef(false);
  // Once the user plays/pauses or scrubs with the controls under the card, the hover preview
  // stops overriding their choice: leave no longer pauses what they started.
  const manual = useRef(false);
  const scrubbing = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);

  // The card's actions need the file where it really is; markdown may hand over a path
  // relative to the workspace, the same resolution a local image does.
  const absolutePath = useMemo(() => {
    if (!root || src.startsWith('/') || src.startsWith('\\') || /^[A-Za-z]:/.test(src)) {
      return src;
    }
    return joinPath(root, src);
  }, [src, root]);

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
  const startInline = useCallback(() => {
    const video = inlineRef.current;
    if (!video) return;
    video.muted = true;
    video.defaultMuted = true;
    void video.play().catch(() => {});
  }, []);
  const stopInline = useCallback(() => {
    inlineRef.current?.pause();
  }, []);

  // The badge follows the playback itself, not the pointer: native play/pause events say
  // what the video actually does, whatever started or stopped it.
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const video = inlineRef.current;
    if (!video) return;
    const on = () => setPlaying(true);
    const off = () => setPlaying(false);
    const onMeta = () => setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    const onTime = () => {
      if (!scrubbing.current) setCurrent(video.currentTime);
    };
    video.addEventListener('play', on);
    video.addEventListener('pause', off);
    video.addEventListener('ended', off);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onMeta);
    video.addEventListener('timeupdate', onTime);
    return () => {
      video.removeEventListener('play', on);
      video.removeEventListener('pause', off);
      video.removeEventListener('ended', off);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('durationchange', onMeta);
      video.removeEventListener('timeupdate', onTime);
    };
  }, [url]);

  // The bar reads the element's own duration (the state one is only for the label), so a scrub
  // works the moment the browser has metadata, whatever React has seen.
  const seekFromEvent = useCallback((clientX: number) => {
    const track = trackRef.current;
    const video = inlineRef.current;
    if (!track || !video) return;
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const rect = track.getBoundingClientRect();
    const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    video.currentTime = ratio * dur;
    setCurrent(ratio * dur);
  }, []);

  const togglePlay = useCallback(() => {
    const video = inlineRef.current;
    if (!video) return;
    manual.current = true;
    if (video.paused) {
      video.muted = true;
      video.defaultMuted = true;
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  // Opening the overlay plays the large video at once (it is muted, so autoplay is allowed) and
  // stops the small one; Esc closes.
  useEffect(() => {
    if (!open) return;
    inlineRef.current?.pause();
    modalTouched.current = false;
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
      await downloadFileFromPath(absolutePath, name, root || undefined);
    } catch (error) {
      console.error('[LocalVideoView] Failed to download video:', { path: absolutePath, error });
      Message.error(t('acp.image.download_error'));
    }
  }, [absolutePath, root, src, t]);

  // "\u590d\u5236\u9644\u4ef6" puts the file itself on the OS clipboard (paste it into Explorer or a chat);
  // where the OS offers no file clipboard the path is copied instead — still useful, and honest.
  const copyFile = useCallback(async (): Promise<void> => {
    try {
      await ipcBridge.fs.copyFileToClipboard.invoke({ path: absolutePath });
      Message.success(t('acp.video.copy_file_success', { defaultValue: '已复制附件，可粘贴到任意位置' }));
    } catch (error) {
      console.error('[LocalVideoView] Failed to copy video file to clipboard:', { path: absolutePath, error });
      await copyText(absolutePath);
      Message.warning(t('acp.video.copy_path_fallback', { defaultValue: '系统不支持复制文件，已复制文件路径' }));
    }
  }, [absolutePath, t]);

  // \u5f15\u7528: hand the file to the send box as an attachment chip — the same event the
  // image preview's quote fires.
  const quote = useCallback(() => {
    emitter.emit('sendbox.mention.files', [absolutePath], conversationId);
  }, [absolutePath, conversationId]);

  const name = useMemo(() => src.split(/[/\\]/).pop() || 'video.mp4', [src]);
  const ratio = duration > 0 ? Math.min(1, Math.max(0, current / duration)) : 0;

  // React's synthetic mouseenter never arrives in the transcript (its mouseover/out pairing
  // breaks there), while mousemove does; native listeners on the node are not affected.
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const enter = () => {
      if (!manual.current) startInline();
    };
    const leave = () => {
      if (!manual.current) stopInline();
    };
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
              onPointerDown={() => {
                modalTouched.current = true;
              }}
              onSeeked={(event) => {
                // The user moved the playhead: the autoplay that opened the overlay is over —
                // the video stands on the frame they chose instead of running on.
                if (modalTouched.current) {
                  event.currentTarget.pause();
                  modalTouched.current = false;
                }
              }}
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
              data-testid='local-video-modal-rotate-left'
              onClick={() => setTurns((v) => v - 1)}
            >
              ↺
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
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '6px', maxWidth: '100%', verticalAlign: 'top' }}>
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
          style={{
            maxWidth: '100%',
            maxHeight: '360px',
            borderRadius: '8px',
            display: 'block',
            background: '#000',
            transform: `rotate(${turns * 90}deg)`,
            transition: 'transform .2s ease',
          }}
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
          {playing ? <Pause theme='filled' size='12' fill='#fff' /> : <PlayOne theme='filled' size='12' fill='#fff' />}
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
        {overlay}
      </span>
      <div
        data-testid='local-video-controls'
        style={{ display: 'flex', alignItems: 'center', gap: '8px', maxWidth: '100%' }}
      >
        <button
          type='button'
          style={CARD_BUTTON}
          data-testid='local-video-play'
          aria-label={playing ? t('common.pause', { defaultValue: '暂停' }) : t('common.play', { defaultValue: '播放' })}
          onClick={togglePlay}
        >
          {playing ? <Pause theme='filled' size='14' fill='currentColor' /> : <PlayOne theme='filled' size='14' fill='currentColor' />}
        </button>
        <div
          ref={trackRef}
          data-testid='local-video-seek'
          role='slider'
          aria-label={t('acp.video.progress', { defaultValue: '播放进度' })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          style={{ flex: 1, minWidth: '120px', height: '18px', display: 'flex', alignItems: 'center', cursor: 'pointer', touchAction: 'none' }}
          onPointerDown={(event) => {
            // A scrub is the user's: it ends the hover preview's autoplay the same way a seek in
            // the overlay does — the frame they picked stands still. A play they started
            // themselves keeps running through it.
            const wasManual = manual.current;
            manual.current = true;
            scrubbing.current = true;
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // jsdom and odd engines: dragging then simply follows the pointer within the bar.
            }
            seekFromEvent(event.clientX);
            if (!wasManual) inlineRef.current?.pause();
          }}
          onPointerMove={(event) => {
            if (scrubbing.current) seekFromEvent(event.clientX);
          }}
          onPointerUp={() => {
            scrubbing.current = false;
          }}
          onPointerCancel={() => {
            scrubbing.current = false;
          }}
        >
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: '4px',
              borderRadius: '999px',
              background: 'var(--color-fill-2, rgba(120,120,120,.35))',
            }}
          >
            <div
              data-testid='local-video-fill'
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                height: '100%',
                width: `${ratio * 100}%`,
                borderRadius: '999px',
                background: 'var(--color-primary-6, #165dff)',
              }}
            />
            <span
              style={{
                position: 'absolute',
                top: '50%',
                left: `${ratio * 100}%`,
                transform: 'translate(-50%, -50%)',
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: 'var(--color-primary-6, #165dff)',
              }}
            />
          </div>
        </div>
        {duration > 0 ? (
          <span
            style={{
              fontSize: '12px',
              color: 'var(--color-text-3, inherit)',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            {fmtClock(current)} / {fmtClock(duration)}
          </span>
        ) : null}
      </div>
      <div
        data-testid='local-video-toolbar'
        style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <button
          type='button'
          style={CARD_BUTTON}
          data-testid='local-video-copy'
          title={t('acp.video.copy_file', { defaultValue: '复制附件' })}
          onClick={() => void copyFile()}
        >
          <Copy theme='outline' size='14' fill='currentColor' />
        </button>
        <button
          type='button'
          style={CARD_BUTTON}
          data-testid='local-video-quote'
          title={t('common.reply', { defaultValue: '引用' })}
          onClick={quote}
        >
          <Link theme='outline' size='14' fill='currentColor' />
        </button>
        <button
          type='button'
          style={CARD_BUTTON}
          data-testid='local-video-rotate-left'
          title={t('acp.image.rotate_left', { defaultValue: '向左旋转' })}
          onClick={() => setTurns((v) => v - 1)}
        >
          ↺
        </button>
        <button
          type='button'
          style={CARD_BUTTON}
          data-testid='local-video-rotate-right'
          title={t('acp.image.rotate_right', { defaultValue: '向右旋转' })}
          onClick={() => setTurns((v) => v + 1)}
        >
          ↻
        </button>
        <button
          type='button'
          style={CARD_BUTTON}
          data-testid='local-video-inline-save'
          title={t('acp.image.download', { defaultValue: '保存' })}
          onClick={() => void save()}
        >
          <Download theme='outline' size='14' fill='currentColor' />
        </button>
      </div>
    </span>
  );
};

export default LocalVideoView;
