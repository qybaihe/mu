/**
 * An image a reply names, as a preview tab (see ImageGallery.tsx): the file by its full path, and every image of the
 * reply in order, which the viewer steps through. The tab carries a local file ref, so the same file opened again
 * finds its tab, and the tab comes back after a restart.
 */
import { baseName } from '@/common/chat/fileRefs/pathLike';
import { localFileRef } from '@/common/types/chatFile';
import type { PreviewContextValue, PreviewMetadata } from '../../context/PreviewContext';

/** The gallery a tab's metadata holds, if it is a list of paths that includes the tab's own file. */
export function galleryOf(metadata: PreviewMetadata | undefined): string[] | undefined {
  const gallery = metadata?.gallery;
  const path = metadata?.file_path;
  if (!path || !Array.isArray(gallery) || !gallery.every((item) => typeof item === 'string')) return undefined;
  return gallery.includes(path) ? gallery : undefined;
}

export function galleryTabMetadata(path: string, gallery: readonly string[]): PreviewMetadata {
  const name = baseName(path);
  return {
    title: name,
    file_name: name,
    file_path: path,
    fileRef: localFileRef(path),
    editable: false,
    gallery: gallery.includes(path) ? [...gallery] : [path],
  };
}

/** When the person last asked for an image from a reply: the viewer takes the focus, so the arrow keys step at once. */
let focusAskedAt = 0;
const FOCUS_WINDOW_MS = 2000;

/** Whether the viewer should take the focus now; asked once per request. */
export function takeGalleryFocus(now: number = Date.now()): boolean {
  const asked = now - focusAskedAt < FOCUS_WINDOW_MS;
  focusAskedAt = 0;
  return asked;
}

/**
 * Shows one of a reply's images in the preview panel. Called from a click, so the viewer takes the focus; a step in
 * the viewer passes `focus: false`, as the focus is already there.
 */
export function openGalleryImage(
  openPreview: PreviewContextValue['openPreview'],
  path: string,
  gallery: readonly string[],
  { focus = true }: { focus?: boolean } = {}
): void {
  if (focus) focusAskedAt = Date.now();
  openPreview('', 'image', galleryTabMetadata(path, gallery), { replace: true });
}
