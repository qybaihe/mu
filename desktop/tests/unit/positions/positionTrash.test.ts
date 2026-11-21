/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  purgeDueTrashedPositionsIn,
  restoreTrashedPositionIn,
  scanPositionLibrary,
  trashPositionIn,
} from '@process/services/team/positions';
import {
  POSITION_DELETE_GRACE_MS,
  TRASH_MANIFEST_NAME,
  buildTrashManifest,
  isTrashPurgeDue,
  parseTrashManifest,
  trashDaysLeftOf,
  type TrashedPosition,
} from '@/common/chat/team/positions/positionTrashCore';

/**
 * The position delete quarantine (common/chat/team/positions/
 * positionTrashCore.ts and its IO in positionService): the manifest's shape,
 * the move-in / move-back / purge lifecycle against real files in a temp
 * library, and the roster scan's blindness to the trash folder. The user's
 * real library is never touched.
 */

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-position-trash-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const positionFile = (name: string, displayName?: string): string => {
  const fields = [`name: ${name}`];
  if (displayName !== undefined) fields.push(`display_name: ${displayName}`);
  fields.push(`description: ${name} 岗`);
  return `---\n${fields.join('\n')}\n---\n\n正文。`;
};

const libraryWith = (dir: string, files: Record<string, string>): string => {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  return dir;
};

const entry = (overrides: Partial<TrashedPosition> = {}): TrashedPosition => ({
  name: 'forwarder',
  displayName: '货代',
  file: 'forwarder.md',
  trashFile: 'forwarder.md',
  deletedAt: 1_000,
  ...overrides,
});

describe('parseTrashManifest / buildTrashManifest', () => {
  it('round-trips entries, newest delete first', () => {
    const text = buildTrashManifest([
      entry({ deletedAt: 2 }),
      entry({ name: 'planner', displayName: '规划', file: 'planner.md', trashFile: 'planner-3.md', deletedAt: 9 }),
    ]);
    const parsed = parseTrashManifest(text);
    expect(parsed.map((item) => [item.name, item.deletedAt])).toEqual([
      ['planner', 9],
      ['forwarder', 2],
    ]);
  });

  it('tolerates anything that is not a well-shaped entry: prose, missing fields, a bare object', () => {
    expect(parseTrashManifest('not json')).toEqual([]);
    expect(parseTrashManifest('{"a":1}')).toEqual([]);
    expect(
      parseTrashManifest('[{"name":"x"},{"name":"x","file":"x.md","trashFile":"x.md","deletedAt":"soon"}]')
    ).toEqual([]);
  });

  it('drops rows whose file or trashFile is not a bare file name — a hand-edited manifest must not steer the restore or the purge out of their folders', () => {
    const good = JSON.stringify([{ name: 'x', file: 'x.md', trashFile: 'x.md', deletedAt: 5 }]);
    const rows = (over: Record<string, string>) => [{ ...JSON.parse(good)[0], ...over }];
    // Every separator-bearing or dot-folder shape reads as malformed, on both fields.
    expect(parseTrashManifest(JSON.stringify(rows({ file: '../agents/forwarder.md' })))).toEqual([]);
    expect(parseTrashManifest(JSON.stringify(rows({ trashFile: '..\\evil.md' })))).toEqual([]);
    expect(parseTrashManifest(JSON.stringify(rows({ file: 'sub/x.md' })))).toEqual([]);
    expect(parseTrashManifest(JSON.stringify(rows({ trashFile: '..' })))).toEqual([]);
    expect(parseTrashManifest(JSON.stringify(rows({ file: '.' })))).toEqual([]);
    // The well-shaped row beside them survives.
    expect(
      parseTrashManifest(`[${good.slice(1, -1)},${JSON.stringify(rows({ trashFile: '../evil.md' })[0])}]`)
    ).toHaveLength(1);
  });

  it('a missing displayName falls back to the name; the grace helpers count down to the purge', () => {
    const parsed = parseTrashManifest(JSON.stringify([{ name: 'x', file: 'x.md', trashFile: 'x.md', deletedAt: 5 }]));
    expect(parsed[0]?.displayName).toBe('x');
    expect(isTrashPurgeDue(entry({ deletedAt: 1 }), 1 + POSITION_DELETE_GRACE_MS)).toBe(true);
    expect(isTrashPurgeDue(entry({ deletedAt: 1 }), POSITION_DELETE_GRACE_MS)).toBe(false);
    expect(trashDaysLeftOf(0, 0)).toBe(7);
    // A clock from before the stamp (a slow render tick) must not read 8.
    expect(trashDaysLeftOf(0, -10_000)).toBe(7);
    expect(trashDaysLeftOf(0, 8 * 86_400_000)).toBe(0);
  });
});

describe('trashPositionIn / restoreTrashedPositionIn / purge', () => {
  it('moves the file into the trash and the roster loses the position at once', async () => {
    const library = libraryWith(temp(), {
      'forwarder.md': positionFile('forwarder', '货代\n'),
      'video.md': positionFile('video-lab'),
    });
    const entries = await trashPositionIn({ libraryDir: library }, { name: 'forwarder' }, () => 2_000);
    expect(existsSync(join(library, 'forwarder.md'))).toBe(false);
    expect(existsSync(join(library, '.trash', 'forwarder.md'))).toBe(true);
    expect(entries).toEqual([entry({ deletedAt: 2_000 })]);
    expect((await scanPositionLibrary(library)).map((p) => p.name)).toEqual(['video-lab']);
  });

  it('throws for a position the library does not hold', async () => {
    const library = libraryWith(temp(), { 'video.md': positionFile('video-lab') });
    await expect(trashPositionIn({ libraryDir: library }, { name: 'ghost' })).rejects.toThrow(/No such position/);
  });

  it('restores by origin file name: the file moves back and the roster picks it up', async () => {
    const library = libraryWith(temp(), { 'forwarder.md': positionFile('forwarder', '货代\n') });
    await trashPositionIn({ libraryDir: library }, { name: 'forwarder' }, () => 2_000);
    const remaining = await restoreTrashedPositionIn({ libraryDir: library }, { file: 'forwarder.md' });
    expect(remaining).toEqual([]);
    expect(existsSync(join(library, 'forwarder.md'))).toBe(true);
    expect((await scanPositionLibrary(library)).map((p) => p.name)).toEqual(['forwarder']);
  });

  it('refuses a restore whose origin name is taken again, and one nobody ever deleted', async () => {
    const library = libraryWith(temp(), { 'forwarder.md': positionFile('forwarder') });
    await trashPositionIn({ libraryDir: library }, { name: 'forwarder' }, () => 2_000);
    writeFileSync(join(library, 'forwarder.md'), positionFile('forwarder', '新版\n'), 'utf8');
    await expect(restoreTrashedPositionIn({ libraryDir: library }, { file: 'forwarder.md' })).rejects.toThrow(
      /exists in the library again/
    );
    await expect(restoreTrashedPositionIn({ libraryDir: library }, { file: 'never.md' })).rejects.toThrow(
      /No such position in the trash/
    );
  });

  it('a re-created and re-deleted file moves in under a stamped name; both entries restore by origin file', async () => {
    const library = libraryWith(temp(), { 'forwarder.md': positionFile('forwarder') });
    await trashPositionIn({ libraryDir: library }, { name: 'forwarder' }, () => 2_000);
    writeFileSync(join(library, 'forwarder.md'), positionFile('forwarder', '重生\n'), 'utf8');
    const entries = await trashPositionIn({ libraryDir: library }, { name: 'forwarder' }, () => 9_000);
    expect(entries.map((item) => item.trashFile).toSorted()).toEqual(['forwarder-9000.md', 'forwarder.md']);
    // The newest delete of that origin file is the one a restore brings
    // back: the stamped file leaves, the older entry keeps its own grace.
    const rest = await restoreTrashedPositionIn({ libraryDir: library }, { file: 'forwarder.md' });
    expect(rest.map((item) => item.trashFile)).toEqual(['forwarder.md']);
    expect(existsSync(join(library, '.trash', 'forwarder-9000.md'))).toBe(false);
    expect(existsSync(join(library, '.trash', 'forwarder.md'))).toBe(true);
  });

  it('purges only what is past its grace: the file goes for real, the restorable entries stay', async () => {
    const library = libraryWith(temp(), {
      'old.md': positionFile('old-timer'),
      'new.md': positionFile('newcomer'),
    });
    const t0 = 1_800_000_000_000;
    await trashPositionIn({ libraryDir: library }, { name: 'old-timer' }, () => t0);
    await trashPositionIn({ libraryDir: library }, { name: 'newcomer' }, () => t0 + 6 * 86_400_000);
    const remaining = await purgeDueTrashedPositionsIn({ libraryDir: library }, () => t0 + 8 * 86_400_000);
    expect(remaining.map((item) => item.name)).toEqual(['newcomer']);
    expect(existsSync(join(library, '.trash', 'old.md'))).toBe(false);
    expect(existsSync(join(library, '.trash', 'new.md'))).toBe(true);
    expect(
      parseTrashManifest(readFileSync(join(library, '.trash', TRASH_MANIFEST_NAME), 'utf8')).map((item) => item.name)
    ).toEqual(['newcomer']);
  });

  it('the roster scan never sees the trash folder, whatever sits in it', async () => {
    const library = libraryWith(temp(), { 'forwarder.md': positionFile('forwarder') });
    await trashPositionIn({ libraryDir: library }, { name: 'forwarder' }, () => 2_000);
    // Even a hand-dropped .md file inside the trash folder is not a position:
    // dot entries never list.
    writeFileSync(join(library, '.trash', 'stray.md'), positionFile('stray'), 'utf8');
    expect((await scanPositionLibrary(library)).map((p) => p.name)).toEqual([]);
  });
});
