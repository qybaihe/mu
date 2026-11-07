/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** The fallback's download: only from GitHub, hop by hop, into the Downloads folder, never leaving half a file. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { downloadInstaller } from '@/process/services/update/installerDownload';

const ASSET_URL = 'https://github.com/qybaihe/mu/releases/download/v0.1.3/mu-0.1.3-linux-amd64.deb';
const STORAGE_URL = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mu-installer-download-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

describe('downloadInstaller', () => {
  it('follows GitHub to its storage and saves the installer, reporting progress', async () => {
    const body = 'x'.repeat(1000);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === ASSET_URL) return redirect(STORAGE_URL);
      if (url === STORAGE_URL) return new Response(body, { status: 200, headers: { 'content-length': '1000' } });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onProgress = vi.fn();

    const saved = await downloadInstaller({ name: 'mu-0.1.3-linux-amd64.deb', url: ASSET_URL }, { dir, onProgress });

    expect(saved).toBe(path.join(dir, 'mu-0.1.3-linux-amd64.deb'));
    expect(readFileSync(saved, 'utf8')).toBe(body);
    expect(onProgress).toHaveBeenLastCalledWith(100);
    // Every hop is asked by hand, so its host is checked first.
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).redirect)).toEqual(['manual', 'manual']);
  });

  it('keeps an earlier download and saves beside it', async () => {
    writeFileSync(path.join(dir, 'mu-0.1.3-linux-amd64.deb'), 'old');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('new', { status: 200 }))
    );
    const saved = await downloadInstaller({ name: 'mu-0.1.3-linux-amd64.deb', url: ASSET_URL }, { dir });
    expect(path.basename(saved)).toBe('mu-0.1.3-linux-amd64 (1).deb');
    expect(readFileSync(path.join(dir, 'mu-0.1.3-linux-amd64.deb'), 'utf8')).toBe('old');
  });

  it('refuses any host but GitHub, redirects included, before asking it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === ASSET_URL ? redirect('https://static.example.com/fake.deb') : new Response('evil')
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      downloadInstaller({ name: 'mu-0.1.3-linux-amd64.deb', url: ASSET_URL }, { dir })
    ).rejects.toMatchObject({ info: { code: 'downloadFailed' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      downloadInstaller({ name: 'x.deb', url: 'http://github.com/qybaihe/mu/x.deb' }, { dir })
    ).rejects.toMatchObject({ info: { code: 'downloadFailed' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(dir, 'x.deb'))).toBe(false);
  });

  it('removes the partial file when the download breaks off', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('half'));
        controller.error(new Error('socket hang up'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(broken, { status: 200 }))
    );
    await expect(downloadInstaller({ name: 'mu-0.1.3-linux-amd64.deb', url: ASSET_URL }, { dir })).rejects.toThrow(
      'socket hang up'
    );
    expect(existsSync(path.join(dir, 'mu-0.1.3-linux-amd64.deb'))).toBe(false);
  });

  it('says what the server answered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gone', { status: 410 }))
    );
    await expect(
      downloadInstaller({ name: 'mu-0.1.3-linux-amd64.deb', url: ASSET_URL }, { dir })
    ).rejects.toMatchObject({ info: { code: 'serverError', status: 410 } });
  });
});
