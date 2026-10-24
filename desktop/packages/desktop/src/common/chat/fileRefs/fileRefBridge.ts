/**
 * File references in a reply (`07_card.png`, `src/app.ts`, `[the report](out/report.pdf)`), between the window and the
 * main process. The window finds the candidates (pathLike.ts) and asks the main process which name a regular file;
 * the main process answers with no more than the window needs: the full path, what kind of file it is and its size
 * (process/services/fileRefs/). Opening, showing in the folder and reading an image for the preview go through the
 * main process too, which checks the path again each time and never runs a program: it shows it in its folder.
 */
import { bridge } from '../../platform/bridge';
import type { KyrnResult } from '../../kyrn/errors';

/** How many references one `resolve` call takes. */
export const FILE_REF_BATCH_LIMIT = 200;

/**
 * The largest image the preview reads: 20 MB, as for any image the preview opens. The bridge drops a message over
 * 50 MB once serialized (common/adapter/main.ts), and a data URL is a third larger than the file.
 */
export const FILE_REF_IMAGE_LIMIT = 20 * 1024 * 1024;

/**
 * - `image`: shown in the preview panel.
 * - `file`: opened in the system's default app.
 * - `program`: something that would run when opened (`.app`, `.command`, `.sh`, `.exe`, an executable file), so it
 *   is only shown in its folder.
 */
export type FileRefKind = 'image' | 'file' | 'program';

/**
 * What a reference names: a regular file (by its full path), nothing, or more than one file of that name in the
 * conversation's folder.
 */
export type FileRefAnswer =
  | { state: 'found'; path: string; kind: FileRefKind; size: number }
  | { state: 'missing' }
  | { state: 'ambiguous' };

/** `cwd`: the conversation's folder, which relative references are read against; absolute and `~/` ones need none. */
export type FileRefResolveRequest = { cwd?: string; refs: string[] };

/** What opening did: the file opened in its app, or (a program) was shown in its folder. */
export type FileRefOpened = { action: 'opened' | 'revealed' };

/** An image for the preview, or why it is not shown. */
export type FileRefImage =
  | { state: 'image'; dataUrl: string; size: number }
  | { state: 'tooLarge'; size: number; limit: number };

export const fileRefBridge = {
  /** One answer per reference, in the order asked. */
  resolve: bridge.buildProvider<KyrnResult<FileRefAnswer[]>, FileRefResolveRequest>('fileRefs.resolve'),
  /** Opens a file in its default app; a program is shown in its folder instead. Fails `notFound` if it is gone. */
  open: bridge.buildProvider<KyrnResult<FileRefOpened>, { path: string }>('fileRefs.open'),
  /** Shows a file in Finder, File Explorer or the file manager. Fails `notFound` if it is gone. */
  reveal: bridge.buildProvider<KyrnResult<void>, { path: string }>('fileRefs.reveal'),
  /** An image file as a data URL, up to FILE_REF_IMAGE_LIMIT. Fails `notFound` if it is gone or not an image. */
  readImage: bridge.buildProvider<KyrnResult<FileRefImage>, { path: string }>('fileRefs.readImage'),
};
