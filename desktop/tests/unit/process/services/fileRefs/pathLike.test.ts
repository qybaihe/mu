import { describe, expect, it } from 'vitest';
import {
  baseName,
  extensionOf,
  fileRefStrength,
  FILE_REF_MAX_LENGTH,
  isImagePath,
  withoutLineSuffix,
} from '@/common/chat/fileRefs/pathLike';

/**
 * Which inline code spans of a reply name a file (common/chat/fileRefs/pathLike.ts). Ordinary code must never read as
 * a path: a span that is not path-like is never looked up, so it can neither become a link nor be greyed out.
 */

describe('a span that names a file', () => {
  it.each([
    // The owner's reply: bare image names, the extension makes them files.
    ['07_角色与场景关系卡_铁匠老秦_雨夜钢铁厂.png', 'strong'],
    ['IMG_2041.JPG', 'strong'],
    ['report.pdf', 'strong'],
    ['notes.md', 'strong'],
    ['data.csv', 'strong'],
    ['out/07.png', 'strong'],
    ['src/app.ts', 'strong'],
    ['src/app.ts:12', 'strong'],
    ['src/app.ts:12:7', 'strong'],
    ['app/[id]/page.tsx', 'strong'],
    ['/Users/me/Desktop/a.pdf', 'strong'],
    ['/Users/me/My Docs/a.pdf', 'strong'],
    ['~/notes/today.md', 'strong'],
    ['./build.sh', 'strong'],
    ['../shared/types.ts', 'strong'],
    ['C:\\Users\\me\\a.png', 'strong'],
    ['C:/Users/me/a.png', 'strong'],
    ['@scope/pkg/index.js', 'strong'],
    // May be code: a link when found, plain when not.
    ['index.ts', 'weak'],
    ['package.json', 'weak'],
    ['console.log', 'weak'],
    ['Button.tsx', 'weak'],
    ['My Report.pdf', 'weak'],
    ['photo (1).png', 'weak'],
    ['/api/users', 'weak'],
    ['/help', 'weak'],
    ['~/Downloads', 'weak'],
    ['./configure', 'weak'],
  ])('%s is %s', (span, strength) => {
    expect(fileRefStrength(span)).toBe(strength);
  });

  it('trims the span', () => {
    expect(fileRefStrength('  out/a.png  ')).toBe('strong');
  });
});

describe('ordinary code is never a path', () => {
  it.each([
    'foo.bar',
    'a/b',
    'src/utils',
    'npm run build',
    'x.length',
    'console.log()',
    'arr.map(x => x)',
    'foo.bar.baz()',
    'useState(0)',
    'example.com',
    'usemu.dev',
    'https://example.com/a.png',
    'http://localhost:3000/a.js',
    'mailto:me@example.com',
    'vscode://file/a.ts',
    '//cdn.example.com/a.js',
    '\\\\server\\share\\a.png',
    'exec.Command',
    'fmt.Println',
    'React.FC',
    'a && b.txt',
    'cat a.txt | grep x',
    'ls -la a.txt',
    'open report.pdf',
    'python3 train.py',
    'git commit -m "x"',
    'rm -rf build/',
    '$HOME/a.txt',
    '*.png',
    '{a,b}.json',
    '.png',
    '.env',
    '_.zip',
    'v1.2.3',
    '192.168.1.1',
    '"a.png"',
    "'a.png'",
    'KEY=value.json',
    '#include <stdio.h>',
    'std::fs::read',
    'user@host:~/a.txt',
    '100%.png',
    'a,b.csv',
    'npm i react@18',
    'Makefile',
    'README',
    '',
    '   ',
    'a.png\nb.png',
    `${'a'.repeat(FILE_REF_MAX_LENGTH)}.png`,
  ])('%j', (span) => {
    expect(fileRefStrength(span)).toBeNull();
  });
});

describe('path pieces', () => {
  it('takes a line and a column off', () => {
    expect(withoutLineSuffix('src/a.ts:12')).toBe('src/a.ts');
    expect(withoutLineSuffix('src/a.ts:12:7')).toBe('src/a.ts');
    expect(withoutLineSuffix('src/a.ts')).toBe('src/a.ts');
  });

  it('names the last part and its extension, either separator', () => {
    expect(baseName('a/b/c.png')).toBe('c.png');
    expect(baseName('C:\\a\\c.png')).toBe('c.png');
    expect(extensionOf('a/b/C.PNG')).toBe('png');
    expect(extensionOf('a/.env')).toBe('');
    expect(extensionOf('a/b')).toBe('');
  });

  it('knows the images the preview shows, in any case', () => {
    expect(isImagePath('/a/b.png')).toBe(true);
    expect(isImagePath('/a/b.JPEG')).toBe(true);
    expect(isImagePath('/a/b.svg')).toBe(true);
    // Chromium decodes neither: these open in the system's app.
    expect(isImagePath('/a/b.tiff')).toBe(false);
    expect(isImagePath('/a/b.heic')).toBe(false);
    expect(isImagePath('/a/b.pdf')).toBe(false);
  });
});
