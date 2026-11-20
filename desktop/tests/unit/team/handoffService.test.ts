/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTeamHandoffIn } from '@process/services/team/teamWorkspace';

/**
 * The team workspace record read (process/services/team/teamWorkspace/):
 * the workspace bar (an app-owned team folder under the data dir), the
 * missing-file answer, and the runaway-file cap.
 */

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-handoff-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const workspace = (dataDir: string, name = '队一'): string => {
  const dir = join(dataDir, 'teams', name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('readTeamHandoffIn', () => {
  it('reads the workspace HANDOFF.md', async () => {
    const dataDir = temp();
    const dir = workspace(dataDir);
    writeFileSync(join(dir, 'HANDOFF.md'), '# 交接\n\n## 当前目标\n查重客户', 'utf8');
    const answer = await readTeamHandoffIn(dir, { dataDir });
    expect(answer).toEqual({ status: 'ok', content: '# 交接\n\n## 当前目标\n查重客户', truncated: false });
  });

  it('answers missing when the team has no record yet', async () => {
    const dataDir = temp();
    const answer = await readTeamHandoffIn(workspace(dataDir), { dataDir });
    expect(answer).toEqual({ status: 'missing' });
  });

  it('caps a runaway file and says it truncated', async () => {
    const dataDir = temp();
    const dir = workspace(dataDir);
    // 1 MiB + 2 bytes: one past the cap decides truncation, one proves it cut.
    writeFileSync(join(dir, 'HANDOFF.md'), 'x'.repeat(1024 * 1024 + 2), 'utf8');
    const answer = await readTeamHandoffIn(dir, { dataDir });
    expect(answer.status).toBe('ok');
    if (answer.status !== 'ok') throw new Error('unreachable');
    expect(answer.truncated).toBe(true);
    expect(answer.content.length).toBe(1024 * 1024);
  });

  it('refuses a workspace outside the app data dir', async () => {
    const dataDir = temp();
    const elsewhere = temp();
    await expect(readTeamHandoffIn(workspace(elsewhere), { dataDir })).rejects.toThrow('not a team workspace');
  });
});
