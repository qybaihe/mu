/**
 * The files and images the person attaches to a native conversation's next message: picked, dropped or pasted. An
 * image travels to pi as itself (`prompt.images`: base64 and its type), read here, so nothing is uploaded anywhere;
 * any other file travels as its full path in the message (`withFiles`), as mu reads files in its other conversations.
 * A file without a path on this computer (text pasted as a file) cannot be attached, and says so.
 */
import { Message } from '@arco-design/web-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PiImage } from '@/common/utils/nativeHost';

export type NativeAttachment =
  | { id: string; kind: 'image'; name: string; mimeType: string; data: string }
  | { id: string; kind: 'file'; name: string; path: string };

/** The largest image sent as itself; a larger one goes as its path. Providers take a few MB per image. */
export const IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;

/** Image types the models read; an SVG is text to them, so it goes as a file. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

let counter = 0;
const nextId = (): string => {
  counter += 1;
  return `attachment-${counter}`;
};

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(typeof reader.result === 'string' ? reader.result : ''));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('The file could not be read')));
    reader.readAsDataURL(file);
  });

/** Where a file is on this computer: Electron gives a dropped or picked file's path, a pasted image has none. */
const pathOf = (file: File): string =>
  window.electronAPI?.getPathForFile?.(file) || (file as File & { path?: string }).path || '';

/** One file as an attachment, or undefined when it cannot be one. */
export async function readAttachment(file: File): Promise<NativeAttachment | undefined> {
  if (IMAGE_TYPES.has(file.type) && file.size <= IMAGE_LIMIT_BYTES) {
    const url = await readAsDataUrl(file).catch((): string => '');
    const comma = url.indexOf(',');
    if (url.startsWith('data:') && comma > 0)
      return { id: nextId(), kind: 'image', name: file.name, mimeType: file.type, data: url.slice(comma + 1) };
  }
  const path = pathOf(file);
  return path ? { id: nextId(), kind: 'file', name: file.name || path, path } : undefined;
}

export type NativeAttachments = {
  attachments: NativeAttachment[];
  add: (files: readonly File[]) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  /** The images as pi's prompt takes them, and the files' paths. */
  images: () => PiImage[];
  paths: () => string[];
};

export function useNativeAttachments(): NativeAttachments {
  const { t } = useTranslation();
  const [attachments, setAttachments] = useState<NativeAttachment[]>([]);

  const add = useCallback(
    async (files: readonly File[]) => {
      const read = await Promise.all(files.map(async (file) => ({ file, attachment: await readAttachment(file) })));
      const taken = read.flatMap(({ attachment }) => (attachment ? [attachment] : []));
      for (const { file, attachment } of read)
        if (!attachment) Message.warning(t('mu.native.attach.failed', { name: file.name || '?' }));
      if (!taken.length) return;
      setAttachments((old) => {
        const paths = new Set(old.flatMap((each) => (each.kind === 'file' ? [each.path] : [])));
        return [...old, ...taken.filter((each) => each.kind === 'image' || !paths.has(each.path))];
      });
    },
    [t]
  );

  const remove = useCallback((id: string) => setAttachments((old) => old.filter((each) => each.id !== id)), []);
  const clear = useCallback(() => setAttachments([]), []);
  const images = useCallback(
    (): PiImage[] =>
      attachments.flatMap((each) =>
        each.kind === 'image' ? [{ type: 'image' as const, data: each.data, mimeType: each.mimeType }] : []
      ),
    [attachments]
  );
  const paths = useCallback(
    () => attachments.flatMap((each) => (each.kind === 'file' ? [each.path] : [])),
    [attachments]
  );

  return { attachments, add, remove, clear, images, paths };
}
