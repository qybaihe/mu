/**
 * An image a reply named, in the preview panel (opened by components/media/FileRefs/). It is fitted to the panel and
 * can be zoomed (the buttons, Ctrl or ⌘ with the wheel, a pinch; `+`, `-` and `0`) and moved once larger than the
 * panel. The arrows, buttons and keys alike, step through every image the same reply names, in its tab. The image is
 * read through the main process, which checks the file again and reads at most FILE_REF_IMAGE_LIMIT; it opens in the
 * system's default app or shows in its folder from here too. The toolbar's refresh reads it again.
 */
import { Button, Message, Tooltip } from '@arco-design/web-react';
import { FolderOpen, Left, LinkOut, Right, ZoomIn, ZoomOut } from '@icon-park/react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fileRefBridge } from '@/common/chat/fileRefs/fileRefBridge';
import { baseName } from '@/common/chat/fileRefs/pathLike';
import type { KyrnResult } from '@/common/kyrn/errors';
import { openFileRef, revealFileRef, revealPlatform } from '@/renderer/components/media/FileRefs/fileRefStore';
import { formatFileSize } from '@/renderer/services/FileService';
import { isRtlLanguage } from '@/renderer/services/i18n/direction';
import { useOptionalPreviewContext } from '../../context/PreviewContext';
import { registerTabReloader } from '../../context/tabReloaderRegistry';
import { openGalleryImage, takeGalleryFocus } from './galleryTab';
import { MAX_ZOOM, MIN_ZOOM, useImageZoom } from './useImageZoom';

type Shown =
  | { state: 'loading' }
  | { state: 'ready'; src: string }
  | { state: 'gone' }
  | { state: 'tooLarge'; size: number; limit: number }
  | { state: 'failed' };

const ICON = { theme: 'outline', size: 16, fill: 'currentColor' } as const;

/** One of the bar's icon buttons, named by its tooltip. */
const control = (label: string, icon: React.ReactNode, onClick: () => void, disabled = false): React.ReactElement => (
  <Tooltip content={label} mini>
    <Button
      type='text'
      size='small'
      className='!text-t-secondary hover:!text-t-primary flex-shrink-0'
      aria-label={label}
      icon={icon}
      disabled={disabled}
      onClick={onClick}
    />
  </Tooltip>
);

const REVEAL_KEYS = {
  mac: 'preview.reveal.mac',
  windows: 'preview.reveal.windows',
  linux: 'preview.reveal.linux',
} as const;

/** The image at `path`, read again when `reload` changes. */
function useGalleryImage(path: string, reload: number): Shown {
  const [shown, setShown] = useState<{ path: string; reload: number; image: Shown }>();
  useEffect(() => {
    let live = true;
    const settle = (image: Shown) => {
      if (live) setShown({ path, reload, image });
    };
    fileRefBridge.readImage.invoke({ path }).then(
      (result) => {
        if (result.ok === false) settle({ state: result.code === 'notFound' ? 'gone' : 'failed' });
        else if (result.data.state === 'tooLarge')
          settle({ state: 'tooLarge', size: result.data.size, limit: result.data.limit });
        else settle({ state: 'ready', src: result.data.dataUrl });
      },
      () => settle({ state: 'failed' })
    );
    return () => {
      live = false;
    };
  }, [path, reload]);
  return shown?.path === path && shown.reload === reload ? shown.image : { state: 'loading' };
}

const ImageGallery: React.FC<{ tabId: string; path: string; gallery: readonly string[] }> = ({
  tabId,
  path,
  gallery,
}) => {
  const { t, i18n } = useTranslation();
  const preview = useOptionalPreviewContext();
  const rootRef = useRef<HTMLDivElement>(null);
  const [reload, setReload] = useState(0);
  const image = useGalleryImage(path, reload);
  const zoom = useImageZoom(path);
  const name = baseName(path);
  const rtl = isRtlLanguage(i18n?.language);

  useEffect(() => registerTabReloader(tabId, () => setReload((count) => count + 1)), [tabId]);

  // Opened by a click in a reply: the viewer takes the focus, so the arrow keys step through the images at once.
  useEffect(() => {
    if (takeGalleryFocus()) rootRef.current?.focus({ preventScroll: true });
  }, [path]);

  const index = gallery.indexOf(path);
  const count = gallery.length;
  const step = (by: number) => {
    const next = gallery[index + by];
    if (index >= 0 && next && preview) openGalleryImage(preview.openPreview, next, gallery, { focus: false });
  };

  const notice = (result: KyrnResult<unknown>) => {
    if (result.ok !== false) return;
    if (result.code === 'notFound') Message.warning(t('preview.gallery.gone'));
    else Message.error(t('preview.openInSystemFailed'));
  };
  const revealLabel = t(REVEAL_KEYS[revealPlatform()]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    if (event.key === back) step(-1);
    else if (event.key === forward) step(1);
    else if (event.key === '+' || event.key === '=') zoom.zoomIn();
    else if (event.key === '-') zoom.zoomOut();
    else if (event.key === '0') zoom.reset();
    else return;
    event.preventDefault();
  };

  let body: React.ReactNode;
  if (image.state === 'ready') {
    const { shown, offset } = zoom;
    body = (
      <img
        src={image.src}
        alt={name}
        draggable={false}
        onLoad={zoom.onImageLoad}
        className='block flex-none select-none'
        data-testid='image-gallery-image'
        style={
          shown
            ? {
                width: shown.width,
                height: shown.height,
                maxWidth: 'none',
                transform: `translate(${offset.x}px, ${offset.y}px)`,
              }
            : { maxWidth: '100%', maxHeight: '100%', transform: `scale(${zoom.zoom})` }
        }
      />
    );
  } else {
    const words =
      image.state === 'loading'
        ? t('preview.loading')
        : image.state === 'gone'
          ? t('preview.gallery.gone')
          : image.state === 'tooLarge'
            ? t('preview.gallery.tooLarge', { size: formatFileSize(image.size, 1, i18n?.language) })
            : t('messages.imageLoadFailed');
    body = (
      <div className='max-w-360px px-24px text-center text-13px leading-20px text-t-secondary' role='status'>
        {words}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role='group'
      aria-label={t('preview.gallery.label', { name })}
      className='flex-1 min-h-0 flex flex-col bg-1 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--primary)]'
      onKeyDown={onKeyDown}
      data-testid='image-gallery'
      data-path={path}
    >
      <div className='flex items-center gap-2px h-36px px-6px bg-bg-2 border-b border-border-1 flex-shrink-0 overflow-x-auto'>
        {count > 1 && (
          <>
            {control(
              t('preview.gallery.previous'),
              rtl ? <Right {...ICON} /> : <Left {...ICON} />,
              () => step(-1),
              index <= 0
            )}
            <span className='text-12px text-t-secondary whitespace-nowrap tabular-nums' aria-live='polite'>
              {t('preview.gallery.position', { index: index + 1, count })}
            </span>
            {control(
              t('preview.gallery.next'),
              rtl ? <Left {...ICON} /> : <Right {...ICON} />,
              () => step(1),
              index < 0 || index >= count - 1
            )}
          </>
        )}
        <span className='flex-1 min-w-40px px-4px truncate text-12px text-t-primary' title={path} dir='ltr'>
          {name}
        </span>
        {control(t('preview.zoomOut'), <ZoomOut {...ICON} />, zoom.zoomOut, zoom.zoom <= MIN_ZOOM)}
        <Tooltip content={t('preview.zoomReset')} mini>
          <Button
            type='text'
            size='small'
            className='!px-4px !text-t-secondary hover:!text-t-primary tabular-nums flex-shrink-0'
            aria-label={`${t('preview.zoomReset')} (${zoom.percent}%)`}
            onClick={zoom.reset}
            data-testid='image-gallery-zoom'
          >
            {`${zoom.percent}%`}
          </Button>
        </Tooltip>
        {control(t('preview.zoomIn'), <ZoomIn {...ICON} />, zoom.zoomIn, zoom.zoom >= MAX_ZOOM)}
        {control(t('preview.openInSystemApp'), <LinkOut {...ICON} />, () => {
          void openFileRef(path).then(notice);
        })}
        {control(revealLabel, <FolderOpen {...ICON} />, () => {
          void revealFileRef(path).then(notice);
        })}
      </div>
      <div
        ref={zoom.frameRef}
        className='relative flex-1 min-h-0 overflow-hidden flex items-center justify-center'
        style={{ cursor: zoom.panning ? 'grabbing' : zoom.movable ? 'grab' : undefined, touchAction: 'none' }}
        {...zoom.panHandlers}
      >
        {body}
      </div>
    </div>
  );
};

export default ImageGallery;
