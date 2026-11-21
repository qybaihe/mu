/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchUserPortrait } from '@process/services/team/supervisor/userPortraitWatch';
import { USER_PORTRAIT_FILE_NAME } from '@/common/chat/team/positions/userPortraitCore';

/**
 * The shared-folder watch that turns a USER.md change (the settings editor's
 * save or a hand edit — both arrive as the same directory event) into a gate
 * rebuild: one callback per settled burst, portrait events only, close stops
 * everything. Real fs.watch on a real temp tree with a short settle, like
 * the gate watch it feeds.
 */
const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-portrait-watch-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Polls until the condition holds, so the test never races the watch's own delivery. */
const waitFor = async (condition: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('watchUserPortrait', () => {
  it('fires once for a settled USER.md burst, and not for other files', async () => {
    const shared = temp();
    const fired: string[] = [];
    const watch = watchUserPortrait(shared, () => fired.push('x'), 20);
    try {
      writeFileSync(join(shared, USER_PORTRAIT_FILE_NAME), '# v1\n', 'utf8');
      writeFileSync(join(shared, USER_PORTRAIT_FILE_NAME), '# v1 more\n', 'utf8');
      writeFileSync(join(shared, 'TEAMS.md'), 'unrelated\n', 'utf8');
      await waitFor(() => fired.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 80)); // a later event of the same burst would fold in
      expect(fired).toEqual(['x']); // one burst, one callback; TEAMS.md does not count
    } finally {
      watch.close();
    }
  });

  it('notices a delete-and-recreate too: the watch is of the folder, not the file', async () => {
    const shared = temp();
    const file = join(shared, USER_PORTRAIT_FILE_NAME);
    writeFileSync(file, '# v1\n', 'utf8');
    let fired = 0;
    const watch = watchUserPortrait(
      shared,
      () => {
        fired += 1;
      },
      20
    );
    try {
      rmSync(file);
      writeFileSync(file, '# v2\n', 'utf8');
      await waitFor(() => fired === 1);
    } finally {
      watch.close();
    }
  });

  it('stops at close: later changes fire nothing', async () => {
    const shared = temp();
    const fired: string[] = [];
    const watch = watchUserPortrait(shared, () => fired.push('x'), 20);
    watch.close();
    writeFileSync(join(shared, USER_PORTRAIT_FILE_NAME), '# later\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fired).toEqual([]);
  });

  it('survives an unwatchable folder: no watch, no throw, no callbacks', () => {
    const missing = join(temp(), 'no-such-folder');
    const watch = watchUserPortrait(missing, () => {
      throw new Error('must not fire');
    });
    watch.close();
    expect(true).toBe(true);
  });

  it('keeps a failing callback to itself: one bad refresh does not break the watch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shared = temp();
    mkdirSync(shared, { recursive: true });
    const fired: number[] = [];
    const watch = watchUserPortrait(
      shared,
      () => {
        fired.push(1);
        throw new Error('refresh blew up');
      },
      20
    );
    try {
      writeFileSync(join(shared, USER_PORTRAIT_FILE_NAME), '# v1\n', 'utf8');
      await waitFor(() => fired.length === 1);
      writeFileSync(join(shared, USER_PORTRAIT_FILE_NAME), '# v2\n', 'utf8');
      await waitFor(() => fired.length === 2);
      expect(warn).toHaveBeenCalled(); // the failure was logged, not thrown
    } finally {
      watch.close();
    }
  });
});
