import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  FILE_REF_BATCH_LIMIT,
  FILE_REF_IMAGE_LIMIT,
  type FileRefAnswer,
  type FileRefImage,
  type FileRefOpened,
} from '../../../common/chat/fileRefs/fileRefBridge';
import { extensionOf, hasControlCharacter, isImagePath } from '../../../common/chat/fileRefs/pathLike';
import { KyrnError } from '../../../common/kyrn/errors';
import { readFolder } from '../../agent/kyrn/folderFiles';
import { fileRefKind, regularFile, resolveFileRefs, type ResolveOptions } from './resolveFileRefs';

/*
 * The main process's side of a reply's file references (common/chat/fileRefs/fileRefBridge.ts). Every action takes a
 * full path the window got from `resolve`, and checks it again: it must still be a regular file. Nothing is ever run:
 * a program is shown in its folder instead of opened.
 */

/** What the service needs of Electron's `shell`, so a test can stand in for it. */
export type FileRefShell = {
  /** Opens a file in its default app; answers an error message, or '' when it opened. */
  openPath: (path: string) => Promise<string>;
  showItemInFolder: (path: string) => void;
};

export type FileRefServiceOptions = Omit<ResolveOptions, 'platform'> & {
  shell: FileRefShell;
  platform: NodeJS.Platform;
  /** The largest image read for the preview, in bytes. */
  imageLimit?: number;
};

const LONGEST_PATH = 4096;

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

const field = (request: unknown, name: string): unknown =>
  request !== null && typeof request === 'object' ? (request as Record<string, unknown>)[name] : undefined;

/** A full path as the window sends it: one line, not too long. */
function readPath(request: unknown): string {
  const path = field(request, 'path');
  if (typeof path !== 'string' || !path || path.length > LONGEST_PATH || hasControlCharacter(path) || !isAbsolute(path))
    throw new KyrnError('invalid', 'Invalid path');
  return path;
}

/** The file at `path`, which must still be a regular file. */
async function existingFile(path: string) {
  const info = await regularFile(path);
  if (!info) throw new KyrnError('notFound', 'The file is not there anymore', { file: path });
  return info;
}

export type FileRefService = {
  resolve: (request: unknown) => Promise<FileRefAnswer[]>;
  open: (request: unknown) => Promise<FileRefOpened>;
  reveal: (request: unknown) => Promise<void>;
  readImage: (request: unknown) => Promise<FileRefImage>;
};

export function createFileRefService(options: FileRefServiceOptions): FileRefService {
  const { shell, platform } = options;
  const imageLimit = options.imageLimit ?? FILE_REF_IMAGE_LIMIT;
  return {
    async resolve(request) {
      const cwd = field(request, 'cwd');
      const refs = field(request, 'refs');
      if (!Array.isArray(refs) || refs.length > FILE_REF_BATCH_LIMIT)
        throw new KyrnError('invalid', 'Invalid references');
      return resolveFileRefs(cwd === undefined || cwd === '' ? undefined : readFolder(cwd), refs, options);
    },

    async open(request) {
      const path = readPath(request);
      const info = await existingFile(path);
      if (fileRefKind(path, info, platform) === 'program') {
        shell.showItemInFolder(path);
        return { action: 'revealed' };
      }
      const problem = await shell.openPath(path);
      if (problem) throw new KyrnError('unreadable', problem, { file: path });
      return { action: 'opened' };
    },

    async reveal(request) {
      const path = readPath(request);
      await existingFile(path);
      shell.showItemInFolder(path);
    },

    async readImage(request) {
      const path = readPath(request);
      if (!isImagePath(path)) throw new KyrnError('invalid', 'Not an image the preview shows');
      const info = await existingFile(path);
      if (info.size > imageLimit) return { state: 'tooLarge', size: info.size, limit: imageLimit };
      const bytes = await readFile(path);
      // It may have grown since it was looked at.
      if (bytes.length > imageLimit) return { state: 'tooLarge', size: bytes.length, limit: imageLimit };
      const type = IMAGE_TYPES[extensionOf(path)] ?? 'application/octet-stream';
      return { state: 'image', dataUrl: `data:${type};base64,${bytes.toString('base64')}`, size: bytes.length };
    },
  };
}
