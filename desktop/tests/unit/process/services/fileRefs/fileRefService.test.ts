import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bridge, type BridgeEventEmitter } from '@/common/platform/bridge';
import { fileRefBridge } from '@/common/chat/fileRefs/fileRefBridge';
import { KyrnError } from '@/common/kyrn/errors';
import { createFileRefService, type FileRefShell } from '@/process/services/fileRefs/fileRefService';

vi.mock('electron', () => ({ shell: {} }));

/**
 * The main process's side of a reply's file references (process/services/fileRefs/): every action checks the path
 * again, a program is shown in its folder and never opened, and an image is read for the preview within its limit.
 */

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-file-ref-service-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const write = (path: string, content: string | Buffer = 'x'): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
};

const failure = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return error instanceof KyrnError ? error.code : 'other';
  }
  return undefined;
};

let shell: { openPath: ReturnType<typeof vi.fn>; showItemInFolder: ReturnType<typeof vi.fn> };
const service = (imageLimit?: number) =>
  createFileRefService({
    shell: shell as unknown as FileRefShell,
    home: temp(),
    platform: 'darwin',
    ...(imageLimit === undefined ? {} : { imageLimit }),
  });

beforeEach(() => {
  shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
});

describe('opening a file', () => {
  it('opens a file in its default app', async () => {
    const file = write(join(temp(), 'report.pdf'));
    expect(await service().open({ path: file })).toEqual({ action: 'opened' });
    expect(shell.openPath).toHaveBeenCalledWith(file);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('checks the path again: a file gone since, or a folder, is not opened', async () => {
    const folder = temp();
    const file = write(join(folder, 'report.pdf'));
    const files = service();
    expect(await files.resolve({ cwd: folder, refs: ['report.pdf'] })).toEqual([
      { state: 'found', path: file, kind: 'file', size: 1 },
    ]);
    rmSync(file);
    expect(await failure(files.open({ path: file }))).toBe('notFound');
    expect(await failure(files.open({ path: folder }))).toBe('notFound');
    expect(await failure(files.reveal({ path: file }))).toBe('notFound');
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('never runs a program: it is shown in its folder instead', async () => {
    const folder = temp();
    const script = write(join(folder, 'build.sh'), '#!/bin/sh\n');
    const command = write(join(folder, 'Run.command'));
    const files = service();
    expect(await files.open({ path: script })).toEqual({ action: 'revealed' });
    expect(await files.open({ path: command })).toEqual({ action: 'revealed' });
    expect(shell.showItemInFolder.mock.calls).toEqual([[script], [command]]);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('takes an executable file without an extension as a program', async () => {
    const tool = write(join(temp(), 'tool'), '#!/bin/sh\n');
    chmodSync(tool, 0o755);
    expect(await service().open({ path: tool })).toEqual({ action: 'revealed' });
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('says when the system could not open it', async () => {
    shell.openPath.mockResolvedValue('No application knows how to open this file');
    expect(await failure(service().open({ path: write(join(temp(), 'a.xyz')) }))).toBe('unreadable');
  });

  it('takes only a full path on one line', async () => {
    const files = service();
    const requests = [{ path: 'report.pdf' }, { path: '/a\nb.pdf' }, { path: 42 }, {}, null, 'path'];
    expect(await Promise.all(requests.map((request) => failure(files.open(request))))).toEqual(
      requests.map(() => 'invalid')
    );
    expect(shell.openPath).not.toHaveBeenCalled();
  });
});

describe('showing a file in its folder', () => {
  it('shows a file that is there', async () => {
    const file = write(join(temp(), 'card.png'));
    await service().reveal({ path: file });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(file);
  });
});

describe('reading an image for the preview', () => {
  it('answers a data URL of the image', async () => {
    const folder = temp();
    const png = write(join(folder, 'card.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const svg = write(join(folder, 'logo.SVG'), '<svg/>');
    expect(await service().readImage({ path: png })).toEqual({
      state: 'image',
      dataUrl: 'data:image/png;base64,iVBORw==',
      size: 4,
    });
    expect(await service().readImage({ path: svg })).toMatchObject({
      dataUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
    });
  });

  it('reads no more than its limit', async () => {
    const png = write(join(temp(), 'big.png'), Buffer.alloc(64));
    expect(await service(32).readImage({ path: png })).toEqual({ state: 'tooLarge', size: 64, limit: 32 });
  });

  it('reads only an image that is there', async () => {
    const folder = temp();
    const text = write(join(folder, 'notes.txt'));
    expect(await failure(service().readImage({ path: text }))).toBe('invalid');
    expect(await failure(service().readImage({ path: join(folder, 'gone.png') }))).toBe('notFound');
  });
});

describe('resolving a reply’s references', () => {
  it('takes at most a batch, and a folder only as a full path', async () => {
    const files = service();
    expect(await failure(files.resolve({ refs: Array.from({ length: 201 }, (_, index) => `${index}.png`) }))).toBe(
      'invalid'
    );
    expect(await failure(files.resolve({ refs: 'a.png' }))).toBe('invalid');
    expect(await failure(files.resolve({ cwd: 'relative/folder', refs: ['a.png'] }))).toBe('invalid');
    expect(await files.resolve({ cwd: '', refs: ['a.png'] })).toEqual([{ state: 'missing' }]);
  });
});

describe('the bridge', () => {
  it('answers each channel with a result, and opening checks the path again', async () => {
    // The window and the main process in one: what one side emits, the other hears.
    let heard: BridgeEventEmitter | undefined;
    bridge.adapter({ emit: (name, data) => heard?.emit(name, data), on: (emitter) => void (heard = emitter) });
    const { initFileRefsBridge } = await import('@/process/services/fileRefs');
    const folder = temp();
    const file = write(join(folder, 'report.pdf'));
    initFileRefsBridge(service());

    expect(await fileRefBridge.resolve.invoke({ cwd: folder, refs: ['report.pdf', 'gone.pdf'] })).toEqual({
      ok: true,
      data: [{ state: 'found', path: file, kind: 'file', size: 1 }, { state: 'missing' }],
    });
    expect(await fileRefBridge.open.invoke({ path: file })).toEqual({ ok: true, data: { action: 'opened' } });
    rmSync(file);
    expect(await fileRefBridge.open.invoke({ path: file })).toMatchObject({ ok: false, code: 'notFound' });
    expect(await fileRefBridge.readImage.invoke({ path: 'relative.png' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(shell.openPath).toHaveBeenCalledTimes(1);
  });
});
