import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ImageGallery from '@/renderer/pages/conversation/Preview/components/ImageGallery/ImageGallery';
import {
  galleryOf,
  galleryTabMetadata,
  openGalleryImage,
} from '@/renderer/pages/conversation/Preview/components/ImageGallery/galleryTab';
import {
  reloadViaViewer,
  resetTabReloadersForTest,
} from '@/renderer/pages/conversation/Preview/context/tabReloaderRegistry';

/**
 * The preview panel's viewer for the images a reply names (Preview/components/ImageGallery/): fitted, zoomed with the
 * buttons, the keys and Ctrl or ⌘ with the wheel; the arrows step through the reply's images; the file opens in its
 * app or shows in its folder; the image is read through the main process, which may say it is gone or too large.
 */

const mocks = vi.hoisted(() => ({
  readImage: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
  openPreview: vi.fn(),
}));

vi.mock('@/common/chat/fileRefs/fileRefBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/chat/fileRefs/fileRefBridge')>()),
  fileRefBridge: {
    resolve: { invoke: vi.fn() },
    open: { invoke: mocks.open },
    reveal: { invoke: mocks.reveal },
    readImage: { invoke: mocks.readImage },
  },
}));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openPreview: mocks.openPreview }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${Object.values(options).join(',')})` : key,
    i18n: { language: 'en-US' },
  }),
}));

const GALLERY = ['/work/out/a.png', '/work/out/b.png', '/work/out/c.png'];

const show = (path = GALLERY[1], gallery: readonly string[] = GALLERY) =>
  render(<ImageGallery tabId='tab-1' path={path} gallery={gallery} />);

beforeEach(() => {
  resetTabReloadersForTest();
  mocks.readImage.mockReset().mockImplementation(async ({ path }: { path: string }) => ({
    ok: true,
    data: { state: 'image', dataUrl: `data:image/png;base64,${btoa(path)}`, size: 3 },
  }));
  mocks.open.mockReset().mockResolvedValue({ ok: true, data: { action: 'opened' } });
  mocks.reveal.mockReset().mockResolvedValue({ ok: true, data: undefined });
  mocks.openPreview.mockReset();
});

describe('the image', () => {
  it('is read through the main process and shown with its name and place in the reply', async () => {
    show();
    expect(screen.getByRole('status')).toHaveTextContent('preview.loading');
    const image = await screen.findByRole('img', { name: 'b.png' });
    expect(image).toHaveAttribute('src', `data:image/png;base64,${btoa(GALLERY[1])}`);
    expect(mocks.readImage).toHaveBeenCalledWith({ path: GALLERY[1] });
    expect(screen.getByRole('group', { name: 'preview.gallery.label(b.png)' })).toBeInTheDocument();
    expect(screen.getByText('preview.gallery.position(2,3)')).toBeInTheDocument();
    expect(screen.getByTitle(GALLERY[1])).toHaveTextContent('b.png');
  });

  it('says when the file is gone or too large', async () => {
    mocks.readImage.mockResolvedValueOnce({ ok: false, error: 'gone', code: 'notFound' });
    const { unmount } = show();
    expect(await screen.findByText('preview.gallery.gone')).toBeInTheDocument();
    unmount();
    mocks.readImage.mockResolvedValueOnce({ ok: true, data: { state: 'tooLarge', size: 30 * 1024 * 1024, limit: 1 } });
    show();
    expect(await screen.findByText(/^preview\.gallery\.tooLarge\(30/)).toBeInTheDocument();
  });

  it('is read again when the toolbar refreshes its tab', async () => {
    show();
    await screen.findByRole('img');
    act(() => {
      expect(reloadViaViewer('tab-1')).toBe(true);
    });
    await waitFor(() => expect(mocks.readImage).toHaveBeenCalledTimes(2));
  });
});

describe('stepping through the reply’s images', () => {
  it('opens the next and the previous image in the same tab, by button and by arrow key', async () => {
    show();
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'preview.gallery.next' }));
    expect(mocks.openPreview).toHaveBeenLastCalledWith('', 'image', galleryTabMetadata(GALLERY[2], GALLERY), {
      replace: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'preview.gallery.previous' }));
    expect(mocks.openPreview).toHaveBeenLastCalledWith('', 'image', galleryTabMetadata(GALLERY[0], GALLERY), {
      replace: true,
    });
    const viewer = screen.getByTestId('image-gallery');
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    expect(mocks.openPreview).toHaveBeenLastCalledWith(
      '',
      'image',
      expect.objectContaining({ file_path: GALLERY[2] }),
      {
        replace: true,
      }
    );
    fireEvent.keyDown(viewer, { key: 'ArrowLeft' });
    expect(mocks.openPreview).toHaveBeenLastCalledWith(
      '',
      'image',
      expect.objectContaining({ file_path: GALLERY[0] }),
      {
        replace: true,
      }
    );
    expect(mocks.openPreview).toHaveBeenCalledTimes(4);
  });

  it('stops at the ends, and has no arrows for a single image', async () => {
    const { unmount } = show(GALLERY[0]);
    await screen.findByRole('img');
    expect(screen.getByRole('button', { name: 'preview.gallery.previous' })).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId('image-gallery'), { key: 'ArrowLeft' });
    expect(mocks.openPreview).not.toHaveBeenCalled();
    unmount();
    show(GALLERY[0], [GALLERY[0]]);
    await screen.findByRole('img');
    expect(screen.queryByRole('button', { name: 'preview.gallery.next' })).toBeNull();
    expect(screen.queryByText(/preview\.gallery\.position/)).toBeNull();
  });

  it('takes the focus when opened from a reply, so the arrows work at once', async () => {
    openGalleryImage(mocks.openPreview, GALLERY[1], GALLERY);
    show();
    await waitFor(() => expect(screen.getByTestId('image-gallery')).toHaveFocus());
  });
});

describe('zoom', () => {
  it('zooms in, out and back to fit with the buttons and the keys', async () => {
    show();
    await screen.findByRole('img');
    const level = screen.getByTestId('image-gallery-zoom');
    expect(level).toHaveTextContent('100%');
    fireEvent.click(screen.getByRole('button', { name: 'preview.zoomIn' }));
    expect(level).toHaveTextContent('125%');
    fireEvent.click(screen.getByRole('button', { name: 'preview.zoomOut' }));
    fireEvent.click(screen.getByRole('button', { name: 'preview.zoomOut' }));
    expect(level).toHaveTextContent('80%');
    fireEvent.click(level);
    expect(level).toHaveTextContent('100%');
    const viewer = screen.getByTestId('image-gallery');
    fireEvent.keyDown(viewer, { key: '+' });
    expect(level).toHaveTextContent('125%');
    fireEvent.keyDown(viewer, { key: '0' });
    expect(level).toHaveTextContent('100%');
  });

  it('zooms with Ctrl or ⌘ and the wheel, and leaves a plain wheel alone', async () => {
    show();
    const image = await screen.findByRole('img');
    const frame = image.parentElement as HTMLElement;
    const level = screen.getByTestId('image-gallery-zoom');
    fireEvent.wheel(frame, { deltaY: 100 });
    expect(level).toHaveTextContent('100%');
    fireEvent.wheel(frame, { deltaY: -300, ctrlKey: true });
    expect(level).toHaveTextContent('272%');
    fireEvent.wheel(frame, { deltaY: 300, metaKey: true });
    expect(level).toHaveTextContent('100%');
  });
});

describe('the file itself', () => {
  it('opens in its default app and shows in its folder', async () => {
    show();
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'preview.openInSystemApp' }));
    expect(mocks.open).toHaveBeenCalledWith({ path: GALLERY[1] });
    fireEvent.click(screen.getByRole('button', { name: /^preview\.reveal\./ }));
    expect(mocks.reveal).toHaveBeenCalledWith({ path: GALLERY[1] });
  });
});

describe('a tab’s gallery', () => {
  it('is a list of paths that holds the tab’s own file', () => {
    expect(galleryOf(galleryTabMetadata(GALLERY[1], GALLERY))).toEqual(GALLERY);
    expect(galleryOf({ file_path: '/x.png', gallery: GALLERY })).toBeUndefined();
    expect(galleryOf({ file_path: '/x.png', gallery: [42] as unknown as string[] })).toBeUndefined();
    expect(galleryOf({ file_path: '/x.png' })).toBeUndefined();
    expect(galleryTabMetadata('/y.png', GALLERY).gallery).toEqual(['/y.png']);
  });
});
