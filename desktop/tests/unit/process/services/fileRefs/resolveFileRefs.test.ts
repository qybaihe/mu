import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileRefKind, findByName, resolveFileRefs } from '@/process/services/fileRefs/resolveFileRefs';
import { canSymlink } from '../nativeHost/symlinks.ts';

/**
 * What a reply's references name (process/services/fileRefs/resolveFileRefs.ts): absolute and `~/` paths as they are,
 * the rest under the conversation's folder, and a bare name not there looked for below it, within bounds, counting
 * only when one file has it. Only regular files count.
 */

const linking = canSymlink();
const posix = process.platform !== 'win32';

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-file-refs-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const write = (path: string, content = 'x'): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
};

const options = (home: string) => ({ home, platform: 'darwin' as const });

describe('a reference read where it points', () => {
  it('finds a file relative to the folder, absolute, under home, and with a line', async () => {
    const folder = temp();
    const home = temp();
    const image = write(join(folder, 'out', 'card.png'), 'png!');
    const notes = write(join(home, 'notes', 'today.md'), '# today\n');
    const source = write(join(folder, 'src', 'app.ts'));
    const answers = await resolveFileRefs(
      folder,
      ['out/card.png', './out/card.png', image, '~/notes/today.md', 'src/app.ts:12:3'],
      options(home)
    );
    expect(answers).toEqual([
      { state: 'found', path: image, kind: 'image', size: 4 },
      { state: 'found', path: image, kind: 'image', size: 4 },
      { state: 'found', path: image, kind: 'image', size: 4 },
      { state: 'found', path: notes, kind: 'file', size: 8 },
      { state: 'found', path: source, kind: 'file', size: 1 },
    ]);
  });

  it('answers missing for nothing, a folder, a bad reference, and a relative one without a folder', async () => {
    const folder = temp();
    mkdirSync(join(folder, 'out'));
    const absolute = write(join(folder, 'a.pdf'));
    const answers = await resolveFileRefs(
      folder,
      ['gone.png', 'out', 'out/', 42, 'a.png\nb.png', 'x'.repeat(2000)],
      options(temp())
    );
    expect(answers.map((answer) => answer.state)).toEqual([
      'missing',
      'missing',
      'missing',
      'missing',
      'missing',
      'missing',
    ]);
    // Without a folder only absolute and home paths are looked up.
    expect(await resolveFileRefs(undefined, ['a.pdf', absolute], options(temp()))).toEqual([
      { state: 'missing' },
      { state: 'found', path: absolute, kind: 'file', size: 1 },
    ]);
  });

  it.skipIf(!linking)('takes a link to a file anywhere as that file, and a broken link as nothing', async () => {
    const folder = temp();
    const elsewhere = write(join(temp(), 'outside.png'), 'outside');
    symlinkSync(elsewhere, join(folder, 'linked.png'));
    symlinkSync(join(folder, 'gone.png'), join(folder, 'broken.png'));
    expect(await resolveFileRefs(folder, ['linked.png', 'broken.png'], options(temp()))).toEqual([
      { state: 'found', path: join(folder, 'linked.png'), kind: 'image', size: 7 },
      { state: 'missing' },
    ]);
  });
});

describe('a bare name looked for below the folder', () => {
  it('counts one file of that name, at any depth up to four folders', async () => {
    const folder = temp();
    const shallow = write(join(folder, 'out', '07_角色与场景关系卡_铁匠老秦_雨夜钢铁厂.png'));
    const deep = write(join(folder, 'a', 'b', 'c', 'd', 'deep.png'));
    const answers = await resolveFileRefs(
      folder,
      ['07_角色与场景关系卡_铁匠老秦_雨夜钢铁厂.png', 'deep.png'],
      options(temp())
    );
    expect(answers).toEqual([
      { state: 'found', path: shallow, kind: 'image', size: 1 },
      { state: 'found', path: deep, kind: 'image', size: 1 },
    ]);
  });

  it('calls a name in two places ambiguous', async () => {
    const folder = temp();
    write(join(folder, 'v1', 'card.png'));
    write(join(folder, 'v2', 'card.png'));
    expect(await resolveFileRefs(folder, ['card.png'], options(temp()))).toEqual([{ state: 'ambiguous' }]);
  });

  it('does not go deeper than four folders', async () => {
    const folder = temp();
    write(join(folder, 'a', 'b', 'c', 'd', 'e', 'too-deep.png'));
    expect(await resolveFileRefs(folder, ['too-deep.png'], options(temp()))).toEqual([{ state: 'missing' }]);
  });

  it('does not enter dependencies, version control or other dot folders', async () => {
    const folder = temp();
    write(join(folder, 'node_modules', 'pkg', 'logo.png'));
    write(join(folder, '.git', 'logo.png'));
    write(join(folder, '.cache', 'thumb.png'));
    write(join(folder, '__pycache__', 'x.png'));
    expect(
      (await resolveFileRefs(folder, ['logo.png', 'thumb.png', 'x.png'], options(temp()))).map((a) => a.state)
    ).toEqual(['missing', 'missing', 'missing']);
  });

  it('stops after the entries it may read', async () => {
    const folder = temp();
    for (let index = 0; index < 20; index += 1) write(join(folder, 'a', `filler-${index}.txt`));
    write(join(folder, 'z', 'late.png'));
    expect(await resolveFileRefs(folder, ['late.png'], { ...options(temp()), entries: 10 })).toEqual([
      { state: 'missing' },
    ]);
    expect(await resolveFileRefs(folder, ['late.png'], { ...options(temp()), entries: 100 })).toEqual([
      { state: 'found', path: join(folder, 'z', 'late.png'), kind: 'image', size: 1 },
    ]);
  });

  it('looks only for bare names, and only under a folder', async () => {
    const folder = temp();
    write(join(folder, 'out', 'nested', 'card.png'));
    // `nested/card.png` is a path: it is read under the folder, never searched for.
    expect(await resolveFileRefs(folder, ['nested/card.png'], options(temp()))).toEqual([{ state: 'missing' }]);
    expect(await resolveFileRefs(undefined, ['card.png'], options(temp()))).toEqual([{ state: 'missing' }]);
  });

  it('matches a name however its accents are composed', async () => {
    const folder = temp();
    const decomposed = 'café.png';
    const path = write(join(folder, 'out', decomposed));
    const [answer] = await resolveFileRefs(folder, ['café.png'], options(temp()));
    expect(answer).toMatchObject({ state: 'found', kind: 'image' });
    expect(answer.state === 'found' && answer.path.normalize('NFC')).toBe(path.normalize('NFC'));
  });

  it.skipIf(!linking)('does not follow links to folders', async () => {
    const folder = temp();
    const outside = temp();
    write(join(outside, 'secret.png'));
    symlinkSync(outside, join(folder, 'linked'));
    expect(await findByName(folder, ['secret.png'])).toEqual(new Map());
  });
});

describe('what a found file is', () => {
  it('takes programs by their extension, so they are only shown in their folder', () => {
    for (const name of ['Run.command', 'build.sh', 'setup.exe', 'Tool.app', 'install.bat', 'train.py', 'a.jar'])
      expect(fileRefKind(`/x/${name}`, { mode: 0o644 }, 'darwin')).toBe('program');
    expect(fileRefKind('/x/a.png', { mode: 0o644 }, 'darwin')).toBe('image');
    expect(fileRefKind('/x/a.pdf', { mode: 0o644 }, 'darwin')).toBe('file');
  });

  it('takes a script Windows would run as a program there only', () => {
    expect(fileRefKind('/x/app.js', { mode: 0o644 }, 'win32')).toBe('program');
    expect(fileRefKind('/x/app.js', { mode: 0o644 }, 'darwin')).toBe('file');
  });

  it('takes an executable file as a program, unless it is a document', () => {
    expect(fileRefKind('/x/tool', { mode: 0o755 }, 'linux')).toBe('program');
    expect(fileRefKind('/x/notes.ts', { mode: 0o755 }, 'darwin')).toBe('program');
    expect(fileRefKind('/x/photo.png', { mode: 0o755 }, 'darwin')).toBe('image');
    expect(fileRefKind('/x/report.pdf', { mode: 0o755 }, 'darwin')).toBe('file');
    // Windows has no execute bit.
    expect(fileRefKind('/x/tool', { mode: 0o755 }, 'win32')).toBe('file');
  });

  it.skipIf(!posix)('reads the execute bit from the disk', async () => {
    const folder = temp();
    const tool = write(join(folder, 'tool'), '#!/bin/sh\n');
    chmodSync(tool, 0o755);
    expect(await resolveFileRefs(folder, ['./tool'], options(temp()))).toEqual([
      { state: 'found', path: tool, kind: 'program', size: 10 },
    ]);
  });
});
