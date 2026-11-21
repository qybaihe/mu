/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensurePositionWorkspaceIn,
  ensureUserPortraitIn,
  readUserPortraitIn,
  safeFolderName,
  scanPositionLibrary,
  userPortraitFileOf,
} from '@process/services/team/positions';

/**
 * The main process's position service (process/services/team/positions/): the
 * library scan (parse rules live in positionLibraryCore.test.ts) and the
 * workspace preparation — the gate file it writes, when it rewrites, and what
 * it refuses. Real files in a temp tree; the user's real library is never
 * touched.
 */

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-positions-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const positionFile = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n正文：${name} 说明书。`;

const libraryWith = (dir: string, files: Record<string, string>): string => {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  return dir;
};

describe('scanPositionLibrary', () => {
  it('lists the library’s positions in file order and skips what is not one', async () => {
    const library = libraryWith(temp(), {
      'README.md': positionFile('readme', 'documentation is not a position'),
      'a-forwarder.md': positionFile('forwarder', '货代岗'),
      'b-video.md': positionFile('video-lab', '视频岗'),
      'note.txt': 'not markdown',
    });
    const positions = await scanPositionLibrary(library);
    expect(positions.map((p) => p.name)).toEqual(['forwarder', 'video-lab']);
  });

  it('answers an empty roster for a missing library, without throwing', async () => {
    await expect(scanPositionLibrary(join(temp(), 'no-such-library'))).resolves.toEqual([]);
  });

  it('picks up a changed library once its directory mtime moves', async () => {
    const library = libraryWith(temp(), { 'a.md': positionFile('forwarder', '货代岗') });
    expect((await scanPositionLibrary(library)).map((p) => p.name)).toEqual(['forwarder']);
    writeFileSync(join(library, 'b.md'), positionFile('video-lab', '视频岗'), 'utf8');
    // The directory mtime is the cache key; touch it forward so the change is visible.
    utimesSync(library, new Date(), new Date(Date.now() + 2000));
    expect((await scanPositionLibrary(library)).map((p) => p.name)).toEqual(['forwarder', 'video-lab']);
  });
});

describe('ensurePositionWorkspaceIn', () => {
  const setup = () => {
    const library = libraryWith(temp(), {
      'forwarder.md': positionFile('forwarder', '货代岗'),
      'video.md': positionFile('video-lab', '视频岗'),
    });
    const dataDir = temp();
    return { library, dataDir };
  };

  it('writes the gate file into the position’s own workspace folder', async () => {
    const { library, dataDir } = setup();
    const answer = await ensurePositionWorkspaceIn('forwarder', { libraryDir: library, dataDir });
    expect(answer.changed).toBe(true);
    expect(answer.workspace).toBe(join(dataDir, 'positions', 'forwarder'));
    const content = readFileSync(join(answer.workspace, 'AGENTS.override.md'), 'utf8');
    expect(content).toContain('# 岗位：forwarder');
    expect(content).toContain('- video-lab — 视频岗');
  });

  it('ships the team maintenance script next to the gate, seeding-capable', async () => {
    const { library, dataDir } = setup();
    const answer = await ensurePositionWorkspaceIn('forwarder', { libraryDir: library, dataDir });
    const script = readFileSync(join(answer.workspace, 'teams.cjs'), 'utf8');
    // The same script the supervisor gets: dispatch block injected, shared index resolved.
    expect(script).toContain('cmdAdd');
    expect(script).toContain("path.resolve(__dirname, '..', '_shared', 'TEAMS.md')");
    expect(script).toContain('<!-- mu-team-dispatch v');
    // Unchanged on the next ensure.
    await ensurePositionWorkspaceIn('forwarder', { libraryDir: library, dataDir });
    expect(readFileSync(join(answer.workspace, 'teams.cjs'), 'utf8')).toBe(script);
  });

  it('does not rewrite an unchanged gate file', async () => {
    const { library, dataDir } = setup();
    await ensurePositionWorkspaceIn('forwarder', { libraryDir: library, dataDir });
    await expect(ensurePositionWorkspaceIn('forwarder', { libraryDir: library, dataDir })).resolves.toMatchObject({
      changed: false,
    });
  });

  it('rewrites the gate file when the library changed it', async () => {
    const { library, dataDir } = setup();
    const first = await ensurePositionWorkspaceIn('forwarder', { libraryDir: library, dataDir });
    writeFileSync(join(library, 'forwarder.md'), positionFile('forwarder', '货代岗，改版'), 'utf8');
    utimesSync(library, new Date(), new Date(Date.now() + 2000));
    await expect(ensurePositionWorkspaceIn('forwarder', { libraryDir: library, dataDir })).resolves.toMatchObject({
      workspace: first.workspace,
      changed: true,
    });
    expect(readFileSync(join(first.workspace, 'AGENTS.override.md'), 'utf8')).toContain('货代岗，改版');
  });

  it('refuses a name the library does not have — no workspace, no file', async () => {
    const { library, dataDir } = setup();
    await expect(ensurePositionWorkspaceIn('ghost', { libraryDir: library, dataDir })).rejects.toThrow(
      'position not in library: ghost'
    );
  });

  it('keeps the workspace folder safe for a position name with filesystem-hostile characters', async () => {
    const library = libraryWith(temp(), { 'odd.md': positionFile('video lab:pro', '视频岗') });
    const dataDir = temp();
    const answer = await ensurePositionWorkspaceIn('video lab:pro', { libraryDir: library, dataDir });
    expect(answer.workspace).toBe(join(dataDir, 'positions', 'video-lab-pro'));
  });

  it('seeds the shared user portrait skeleton on first ensure and never touches it afterwards', async () => {
    const { library, dataDir } = setup();
    expect(await ensureUserPortraitIn(dataDir)).toBe(true);
    const skeleton = readFileSync(userPortraitFileOf(dataDir), 'utf8');
    expect(skeleton).toContain('# 用户画像');
    // The content is the user's: a filled portrait survives every later ensure.
    writeFileSync(userPortraitFileOf(dataDir), '# 用户画像\n\n- 称呼：老林\n', 'utf8');
    expect(await ensureUserPortraitIn(dataDir)).toBe(false);
    expect(readFileSync(userPortraitFileOf(dataDir), 'utf8')).toBe('# 用户画像\n\n- 称呼：老林\n');
    expect(await readUserPortraitIn(dataDir)).toBe('# 用户画像\n\n- 称呼：老林\n');
  });

  it('embeds the user portrait in the gate once it exists, and rewrites the gate when the portrait changes', async () => {
    const { library, dataDir } = setup();
    const first = await ensurePositionWorkspaceIn('forwarder', { libraryDir: library, dataDir });
    // The ensure seeded the skeleton, so the gate already carries it.
    const seeded = readFileSync(join(first.workspace, 'AGENTS.override.md'), 'utf8');
    expect(seeded).toContain('## 用户画像');
    writeFileSync(userPortraitFileOf(dataDir), '# 用户画像\n\n- 称呼：老林\n', 'utf8');
    await expect(ensurePositionWorkspaceIn('forwarder', { libraryDir: library, dataDir })).resolves.toMatchObject({
      changed: true,
    });
    expect(readFileSync(join(first.workspace, 'AGENTS.override.md'), 'utf8')).toContain('- 称呼：老林');
  });
});

describe('safeFolderName', () => {
  it('keeps ordinary names as they are and folds everything else to dashes', () => {
    expect(safeFolderName('forwarder')).toBe('forwarder');
    expect(safeFolderName('mu-dev')).toBe('mu-dev');
    expect(safeFolderName('a/b\\c:d')).toBe('a-b-c-d');
  });

  it('refuses a name that sanitizes to a folder-traversal segment: `..` escapes the positions root', () => {
    expect(() => safeFolderName('..')).toThrow();
    expect(() => safeFolderName('.')).toThrow();
    // inner dots are ordinary folder-name characters, and a space folds to a dash
    expect(safeFolderName('a..b')).toBe('a..b');
    expect(safeFolderName('. .')).toBe('.-.');
  });
});
