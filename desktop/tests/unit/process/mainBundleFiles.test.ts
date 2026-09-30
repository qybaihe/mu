import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const processDir = join(__dirname, '..', '..', '..', 'packages', 'desktop', 'src', 'process');

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });

/**
 * In Electron 44's main process `require.main.filename` is the string "electron": its `dirname` is "." and a path built
 * from it is relative, which a utility process (it starts in the project's folder) or an MCP server cannot find. Files
 * of the main bundle are found from `__dirname`, the folder of the bundle file the code runs from.
 */
describe('the main process finds its own bundle files', () => {
  it('from __dirname, never from require.main', () => {
    const codeLines = (file: string) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line));
    const offenders = sources(processDir).filter((file) =>
      codeLines(file).some((line) => /\brequire\.main\b/.test(line))
    );
    expect(offenders).toEqual([]);
  });
});
