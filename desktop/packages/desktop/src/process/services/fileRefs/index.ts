import { homedir } from 'node:os';
import { shell } from 'electron';
import { fileRefBridge } from '../../../common/chat/fileRefs/fileRefBridge';
import { kyrnFailure, type KyrnResult } from '../../../common/kyrn/errors';
import { createFileRefService, type FileRefService } from './fileRefService';

export { createFileRefService, type FileRefService, type FileRefShell } from './fileRefService';

// Always answer, failures included: the generic bridge only logs a provider's exception, and the window would wait.
async function result<T>(work: () => Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

const electronService = (): FileRefService =>
  createFileRefService({
    shell: { openPath: (path) => shell.openPath(path), showItemInFolder: (path) => shell.showItemInFolder(path) },
    home: homedir(),
    platform: process.platform,
  });

/** Answers `fileRefs.*` (common/chat/fileRefs/fileRefBridge.ts). */
export function initFileRefsBridge(service: FileRefService = electronService()): void {
  fileRefBridge.resolve.provider((request) => result(() => service.resolve(request)));
  fileRefBridge.open.provider((request) => result(() => service.open(request)));
  fileRefBridge.reveal.provider((request) => result(() => service.reveal(request)));
  fileRefBridge.readImage.provider((request) => result(() => service.readImage(request)));
}
